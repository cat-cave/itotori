import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const CASE_NAME = /\[(case::[^\]]+)\]$/u;
const CASE_RESULT_MEDIA_TYPE = "application/vnd.itotori.behavior-case-result+json";
const PASS = "PASSED";
const REASON = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const RESULT_KEYS = [
  "assertionCount",
  "behavior",
  "caseId",
  "cell",
  "observationCount",
  "reasonCodes",
  "status",
  "subject",
];
const lexical = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredRecord(value, label) {
  if (!isRecord(value)) throw new Error(`cucumber-message-${label}-invalid`);
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`cucumber-message-${label}-missing`);
  }
  return value;
}

function addUnique(map, key, value, label) {
  if (map.has(key)) throw new Error(`cucumber-message-duplicate-${label}:${key}`);
  map.set(key, value);
}

function sameSet(actual, expected, label) {
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new Error(`${label}-mismatch: expected ${expected.length}, received ${actual.length}`);
  }
}

function exactKeys(value, keys, label) {
  sameSet(Object.keys(value).toSorted(lexical), keys, `${label}-keys`);
}

function normalizeExpectedCases(expectedCases) {
  if (!Array.isArray(expectedCases) || expectedCases.length === 0) {
    throw new Error("cucumber-message-expected-cases-missing");
  }
  const cases = new Map();
  for (const [index, raw] of expectedCases.entries()) {
    const item = requiredRecord(raw, `expected-case-${index + 1}`);
    const id = requiredString(item.id, `expected-case-${index + 1}-id`);
    const requiredAssertionCount = item.requiredAssertionCount;
    if (!Number.isInteger(requiredAssertionCount) || requiredAssertionCount <= 0) {
      throw new Error(`cucumber-message-expected-assertion-count-invalid:${id}`);
    }
    addUnique(
      cases,
      id,
      {
        id,
        behavior: requiredString(item.behavior, `${id}-behavior`),
        subject: requiredString(item.subject, `${id}-subject`),
        cell: requiredString(item.cell, `${id}-cell`),
        requiredAssertionCount,
      },
      "expected-case",
    );
  }
  return cases;
}

function parseCaseResultAttachment(attachment) {
  if (attachment.contentEncoding !== "IDENTITY") {
    throw new Error("cucumber-message-case-result-attachment-encoding-invalid");
  }
  let parsed;
  try {
    parsed = JSON.parse(requiredString(attachment.body, "case-result-attachment-body"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("cucumber-message-case-result-attachment-json-invalid");
    }
    throw error;
  }
  const wrapper = requiredRecord(parsed, "case-result-attachment");
  exactKeys(wrapper, ["result", "schema"], "case-result-attachment");
  if (wrapper.schema !== "itotori.behavior-case-result.v1") {
    throw new Error("cucumber-message-case-result-schema-invalid");
  }
  const result = requiredRecord(wrapper.result, "case-result");
  exactKeys(result, RESULT_KEYS, "case-result");
  const assertionCount = result.assertionCount;
  const observationCount = result.observationCount;
  if (!Number.isInteger(assertionCount) || assertionCount < 0) {
    throw new Error("cucumber-message-case-result-assertion-count-invalid");
  }
  if (!Number.isInteger(observationCount) || observationCount < 0) {
    throw new Error("cucumber-message-case-result-observation-count-invalid");
  }
  if (!Array.isArray(result.reasonCodes)) {
    throw new Error("cucumber-message-case-result-reasons-invalid");
  }
  const reasonCodes = result.reasonCodes.map((reason) => {
    if (typeof reason !== "string" || !REASON.test(reason)) {
      throw new Error("cucumber-message-case-result-reason-invalid");
    }
    return reason;
  });
  sameSet(reasonCodes, [...new Set(reasonCodes)].toSorted(lexical), "case-result-reasons");
  if (result.status !== "pass" && result.status !== "fail") {
    throw new Error("cucumber-message-case-result-status-invalid");
  }
  return {
    caseId: requiredString(result.caseId, "case-result-id"),
    behavior: requiredString(result.behavior, "case-result-behavior"),
    subject: requiredString(result.subject, "case-result-subject"),
    cell: requiredString(result.cell, "case-result-cell"),
    status: result.status,
    assertionCount,
    observationCount,
    reasonCodes,
  };
}

function parseEnvelopes(bytes) {
  if (bytes.length === 0) throw new Error("cucumber-message-zero-bytes");
  return bytes
    .toString("utf8")
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`cucumber-message-invalid-json:${index + 1}`);
      }
    });
}

export function readCucumberExecution(path, expectedCases) {
  const expected = normalizeExpectedCases(expectedCases);
  const bytes = readFileSync(path);
  const envelopes = parseEnvelopes(bytes);
  const metadata = envelopes.filter(({ meta }) => meta !== undefined);
  if (metadata.length !== 1) throw new Error("cucumber-message-meta-count-mismatch");
  const meta = metadata[0].meta;
  if (meta?.implementation?.name !== "cucumber-js" || meta?.implementation?.version !== "13.2.0") {
    throw new Error("cucumber-message-runner-version-mismatch");
  }
  if (envelopes.filter(({ testRunStarted }) => testRunStarted !== undefined).length !== 1) {
    throw new Error("cucumber-message-run-start-count-mismatch");
  }
  if (envelopes.filter(({ testRunFinished }) => testRunFinished !== undefined).length !== 1) {
    throw new Error("cucumber-message-run-finish-count-mismatch");
  }

  const pickles = new Map();
  const casePickles = new Map();
  const testCases = new Map();
  const starts = new Map();
  const stepResults = new Map();
  const finishes = new Set();
  const attachments = new Map();
  for (const envelope of envelopes) {
    if (envelope.pickle !== undefined) {
      const pickle = requiredRecord(envelope.pickle, "pickle");
      const pickleId = requiredString(pickle.id, "pickle-id");
      const caseId = CASE_NAME.exec(requiredString(pickle.name, "pickle-name"))?.[1];
      if (caseId === undefined) throw new Error(`cucumber-message-case-name-invalid:${pickleId}`);
      if (!Array.isArray(pickle.steps))
        throw new Error(`cucumber-message-pickle-steps-invalid:${caseId}`);
      const steps = new Map();
      for (const step of pickle.steps) {
        const item = requiredRecord(step, "pickle-step");
        addUnique(
          steps,
          requiredString(item.id, "pickle-step-id"),
          requiredString(item.type, "pickle-step-type"),
          "pickle-step",
        );
      }
      addUnique(pickles, pickleId, { caseId, steps }, "pickle");
      addUnique(casePickles, caseId, pickleId, "case");
    }
    if (envelope.testCase !== undefined) {
      const testCase = requiredRecord(envelope.testCase, "test-case");
      const id = requiredString(testCase.id, "test-case-id");
      if (!Array.isArray(testCase.testSteps)) {
        throw new Error(`cucumber-message-test-case-steps-invalid:${id}`);
      }
      const steps = new Map();
      testCase.testSteps.forEach((step, index) => {
        const item = requiredRecord(step, "test-case-step");
        const testStepId = requiredString(item.id, "test-case-step-id");
        const pickleStepId = typeof item.pickleStepId === "string" ? item.pickleStepId : null;
        const hookId = typeof item.hookId === "string" ? item.hookId : null;
        if ((pickleStepId === null) === (hookId === null)) {
          throw new Error(`cucumber-message-test-case-step-binding-invalid:${testStepId}`);
        }
        addUnique(steps, testStepId, { pickleStepId, hookId, index }, "test-case-step");
      });
      addUnique(
        testCases,
        id,
        { pickleId: requiredString(testCase.pickleId, "test-case-pickle-id"), steps },
        "test-case",
      );
    }
    if (envelope.testCaseStarted !== undefined) {
      const started = requiredRecord(envelope.testCaseStarted, "start");
      if (started.attempt !== 0) throw new Error("cucumber-message-retry-is-not-allowed");
      const startId = requiredString(started.id, "start-id");
      addUnique(
        starts,
        startId,
        requiredString(started.testCaseId, "started-test-case-id"),
        "start",
      );
      stepResults.set(startId, new Map());
    }
    if (envelope.testStepFinished !== undefined) {
      const finished = requiredRecord(envelope.testStepFinished, "step-finished");
      const startId = requiredString(finished.testCaseStartedId, "step-start-id");
      const results = stepResults.get(startId);
      if (results === undefined) throw new Error(`cucumber-message-step-before-start:${startId}`);
      addUnique(
        results,
        requiredString(finished.testStepId, "finished-test-step-id"),
        requiredString(finished.testStepResult?.status, "step-status"),
        "step-result",
      );
    }
    if (envelope.attachment?.mediaType === CASE_RESULT_MEDIA_TYPE) {
      const attachment = requiredRecord(envelope.attachment, "attachment");
      const startId = requiredString(attachment.testCaseStartedId, "attachment-start-id");
      addUnique(
        attachments,
        startId,
        {
          testStepId: requiredString(attachment.testStepId, "attachment-test-step-id"),
          result: parseCaseResultAttachment(attachment),
        },
        "case-result-attachment",
      );
    }
    if (envelope.testCaseFinished !== undefined) {
      const finished = requiredRecord(envelope.testCaseFinished, "finish");
      if (finished.willBeRetried !== false) {
        throw new Error("cucumber-message-finished-case-will-retry");
      }
      const startId = requiredString(finished.testCaseStartedId, "finish-start-id");
      if (finishes.has(startId)) throw new Error(`cucumber-message-duplicate-finish:${startId}`);
      finishes.add(startId);
    }
  }

  sameSet(
    [...casePickles.keys()].toSorted(lexical),
    [...expected.keys()].toSorted(lexical),
    "collected-case-set",
  );
  if (testCases.size !== expected.size)
    throw new Error("cucumber-message-test-case-count-mismatch");
  if (starts.size !== expected.size) throw new Error("cucumber-message-start-count-mismatch");
  if (finishes.size !== starts.size) throw new Error("cucumber-message-finish-count-mismatch");
  if (attachments.size !== starts.size)
    throw new Error("cucumber-message-attachment-count-mismatch");

  const caseResults = [];
  const caseStatuses = new Map();
  for (const [startId, testCaseId] of starts) {
    if (!finishes.has(startId)) throw new Error(`cucumber-message-missing-finish:${startId}`);
    const testCase = testCases.get(testCaseId);
    if (testCase === undefined) throw new Error(`cucumber-message-unbound-start:${startId}`);
    const pickle = pickles.get(testCase.pickleId);
    if (pickle === undefined) throw new Error(`cucumber-message-unbound-test-case:${testCaseId}`);
    const selected = expected.get(pickle.caseId);
    if (selected === undefined)
      throw new Error(`cucumber-message-unexpected-case:${pickle.caseId}`);
    const results = stepResults.get(startId);
    if (results === undefined) throw new Error(`cucumber-message-results-missing:${pickle.caseId}`);
    sameSet(
      [...results.keys()].toSorted(lexical),
      [...testCase.steps.keys()].toSorted(lexical),
      `${pickle.caseId}-test-step-result-set`,
    );
    const mappedPickleSteps = [];
    let totalOutcomeCount = 0;
    let passedOutcomeCount = 0;
    for (const [testStepId, step] of testCase.steps) {
      if (step.pickleStepId === null) continue;
      mappedPickleSteps.push(step.pickleStepId);
      const type = pickle.steps.get(step.pickleStepId);
      if (type === undefined) throw new Error(`cucumber-message-unbound-pickle-step:${testStepId}`);
      if (type === "Outcome") {
        totalOutcomeCount += 1;
        if (results.get(testStepId) === PASS) passedOutcomeCount += 1;
      }
    }
    sameSet(
      mappedPickleSteps.toSorted(lexical),
      [...pickle.steps.keys()].toSorted(lexical),
      `${pickle.caseId}-pickle-step-set`,
    );
    if (totalOutcomeCount !== selected.requiredAssertionCount) {
      throw new Error(`cucumber-message-required-assertion-count-mismatch:${pickle.caseId}`);
    }
    const attached = attachments.get(startId);
    if (attached === undefined)
      throw new Error(`cucumber-message-case-result-missing:${pickle.caseId}`);
    const attachmentStep = testCase.steps.get(attached.testStepId);
    const lastPickleIndex = Math.max(
      ...[...testCase.steps.values()]
        .filter(({ pickleStepId }) => pickleStepId !== null)
        .map(({ index }) => index),
    );
    if (
      attachmentStep === undefined ||
      attachmentStep.hookId === null ||
      attachmentStep.index <= lastPickleIndex
    ) {
      throw new Error(`cucumber-message-case-result-not-from-after-hook:${pickle.caseId}`);
    }
    const status = [...results.values()].every((value) => value === PASS) ? "pass" : "fail";
    const result = attached.result;
    for (const key of ["caseId", "behavior", "subject", "cell"]) {
      const expectedValue = key === "caseId" ? selected.id : selected[key];
      if (result[key] !== expectedValue) {
        throw new Error(`cucumber-message-case-result-${key}-mismatch:${pickle.caseId}`);
      }
    }
    if (result.status !== status) {
      throw new Error(`cucumber-message-case-result-status-mismatch:${pickle.caseId}`);
    }
    if (result.assertionCount !== passedOutcomeCount) {
      throw new Error(`cucumber-message-passed-outcome-count-mismatch:${pickle.caseId}`);
    }
    if (status === "pass") {
      if (
        result.assertionCount !== selected.requiredAssertionCount ||
        result.observationCount === 0
      ) {
        throw new Error(`cucumber-message-passing-case-evidence-incomplete:${pickle.caseId}`);
      }
      if (result.reasonCodes.length !== 0) {
        throw new Error(`cucumber-message-passing-case-has-reason:${pickle.caseId}`);
      }
    } else if (result.reasonCodes.length === 0) {
      throw new Error(`cucumber-message-failing-case-reason-missing:${pickle.caseId}`);
    }
    addUnique(caseStatuses, selected.id, status, "execution");
    caseResults.push(result);
  }
  const normalizedResults = caseResults.toSorted((left, right) =>
    lexical(left.caseId, right.caseId),
  );
  sameSet(
    normalizedResults.map(({ caseId }) => caseId),
    [...expected.keys()].toSorted(lexical),
    "selected-executed-case-set",
  );
  return {
    messageDigest: digest(bytes),
    executedCaseIds: normalizedResults.map(({ caseId }) => caseId),
    caseStatuses,
    caseResults: normalizedResults,
    runner: { package: "@cucumber/cucumber", version: "13.2.0" },
  };
}
