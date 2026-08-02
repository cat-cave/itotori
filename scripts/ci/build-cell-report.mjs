import { createHash } from "node:crypto";

import { assertValidCellReport } from "./cell-report-validation.mjs";
import {
  normalizePlanLaneFragments,
  normalizeReportLaneFragments,
  receivedFragmentEvidence,
} from "./behavior-proof-fragments.mjs";
import { behaviorCells } from "./behavior-cell-registry.mjs";

export { assertValidCellReport } from "./cell-report-validation.mjs";
export const REPORT_SCHEMA = "itotori.behavior-cell-report.v1";
export const OWNED_CELLS = Object.freeze(behaviorCells.map(({ cell }) => cell));

const EXPECTED_COUNTS = Object.freeze({
  behaviors: 47,
  canonicalEngines: 47,
  authoredCases: 570,
  selectedCases: 3_400,
  applicableCells: 687,
  nonApplicablePairs: 96,
});
const DIGEST = /^[0-9a-f]{64}$/u;
const BEHAVIOR = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const SUBJECT = /^(?:all|[a-z0-9]+(?:[.-][a-z0-9]+)*)$/u;
const CASE_ID = /^case::[A-Za-z0-9._:-]+$/u;
const LANE = /^[a-z0-9][a-z0-9-]*$/u;
const REASON = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SKIP_STATUSES = new Set(["skipped", "pending", "undefined", "ambiguous"]);
const DEFAULT_ARTIFACTS = Object.freeze({
  cellReport: "behavior-proof/cell-report.json",
  cellJunit: "behavior-proof/cell-report.junit.xml",
  mutations: "behavior-proof/mutations.json",
  summary: "behavior-proof/summary.txt",
});

const lexical = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
function fail(message) {
  throw new Error(`cell report: ${message}`);
}
function assertRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}
function assertText(value, label, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) fail(`${label} is invalid`);
  return value;
}
function assertInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) fail(`${label} must be a nonnegative integer`);
  return value;
}
function sortedStrings(value, label, pattern) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const seen = new Set();
  const result = value.map((item, index) => {
    const text = assertText(item, `${label}[${index}]`, pattern);
    if (seen.has(text)) fail(`${label} contains duplicate ${text}`);
    seen.add(text);
    return text;
  });
  return result.toSorted(lexical);
}
const sameStrings = (left, right) =>
  left.length === right.length && left.every((value, index) => value === right[index]);
function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.keys(value)
      .toSorted(lexical)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  fail("canonical digest input contains a non-JSON value");
}
export const canonicalDigest = (value) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
function normalizePlan(selectionPlan) {
  const plan = assertRecord(selectionPlan, "selectionPlan");
  assertText(plan.schema, "selectionPlan.schema", /^\S+$/u);
  const candidateTreeDigest = assertText(
    plan.candidateTreeDigest,
    "selectionPlan.candidateTreeDigest",
    DIGEST,
  );
  const classificationDigest = assertText(
    plan.classificationDigest,
    "selectionPlan.classificationDigest",
    DIGEST,
  );
  const counts = assertRecord(plan.counts, "selectionPlan.counts");
  for (const [name, expected] of Object.entries(EXPECTED_COUNTS)) {
    if (counts[name] !== expected) fail(`selectionPlan.counts.${name} must equal ${expected}`);
  }
  if (!Array.isArray(plan.cases) || plan.cases.length !== EXPECTED_COUNTS.selectedCases) {
    fail("selectionPlan.cases must contain exactly 3400 cases");
  }
  if (!Array.isArray(plan.cells) || plan.cells.length !== EXPECTED_COUNTS.applicableCells) {
    fail("selectionPlan.cells must contain exactly 687 cells");
  }
  if (
    !Array.isArray(plan.notApplicablePairs) ||
    plan.notApplicablePairs.length !== EXPECTED_COUNTS.nonApplicablePairs
  ) {
    fail("selectionPlan.notApplicablePairs must contain exactly 96 pairs");
  }
  const cases = new Map();
  for (const [index, raw] of plan.cases.entries()) {
    const item = assertRecord(raw, `selectionPlan.cases[${index}]`);
    const id = assertText(item.id, `selectionPlan.cases[${index}].id`, CASE_ID);
    if (cases.has(id)) fail(`duplicate selected case ${id}`);
    const behavior = assertText(item.behavior, `${id}.behavior`, BEHAVIOR);
    const subject = assertText(item.subject, `${id}.subject`, SUBJECT);
    const cell = assertText(item.cell, `${id}.cell`, /^cell::/u);
    const laneResolution = item.laneResolution;
    if (laneResolution !== "assigned" && laneResolution !== "unclassified") {
      fail(`${id}.laneResolution is invalid`);
    }
    const lane = item.lane === null ? null : assertText(item.lane, `${id}.lane`, LANE);
    if ((laneResolution === "assigned") !== (lane !== null)) {
      fail(`${id} lane disagrees with its resolution`);
    }
    const requiredAssertionCount = assertInteger(
      item.requiredAssertionCount,
      `${id}.requiredAssertionCount`,
    );
    if (requiredAssertionCount === 0) fail(`${id} must require an assertion`);
    if (cell !== `cell::${behavior}::${subject}`) fail(`${id} has mismatched cell identity`);
    cases.set(id, {
      id,
      behavior,
      subject,
      cell,
      lane,
      laneResolution,
      requiredAssertionCount,
    });
  }
  const cells = new Map();
  for (const [index, raw] of plan.cells.entries()) {
    const item = assertRecord(raw, `selectionPlan.cells[${index}]`);
    const behavior = assertText(item.behavior, `selectionPlan.cells[${index}].behavior`, BEHAVIOR);
    const subject = assertText(item.subject, `selectionPlan.cells[${index}].subject`, SUBJECT);
    const cell = assertText(item.cell, `selectionPlan.cells[${index}].cell`, /^cell::/u);
    if (cell !== `cell::${behavior}::${subject}`) fail(`${cell} has mismatched identity fields`);
    if (cells.has(cell)) fail(`duplicate applicable cell ${cell}`);
    const requiredCaseIds = sortedStrings(item.requiredCaseIds, `${cell}.requiredCaseIds`, CASE_ID);
    const requiredLanes = sortedStrings(item.requiredLanes, `${cell}.requiredLanes`, LANE);
    const requiredProfiles = sortedStrings(
      item.requiredProfiles,
      `${cell}.requiredProfiles`,
      /^.{1,200}$/u,
    );
    const laneResolution = item.laneResolution;
    const profileResolution = item.profileResolution;
    if (laneResolution !== "assigned" && laneResolution !== "unclassified") {
      fail(`${cell}.laneResolution is invalid`);
    }
    if (profileResolution !== "not-required" && profileResolution !== "unclassified") {
      fail(`${cell}.profileResolution is invalid`);
    }
    if (typeof item.profileRegistrationRequired !== "boolean") {
      fail(`${cell}.profileRegistrationRequired is invalid`);
    }
    if (requiredCaseIds.length === 0) fail(`${cell} must require at least one case`);
    if ((laneResolution === "assigned") !== requiredLanes.length > 0) {
      fail(`${cell} lanes disagree with their resolution`);
    }
    if ((profileResolution === "unclassified") !== item.profileRegistrationRequired) {
      fail(`${cell} profile resolution disagrees with classification`);
    }
    cells.set(cell, {
      cell,
      behavior,
      subject,
      requiredCaseIds,
      requiredLanes,
      requiredProfiles,
      laneResolution,
      profileResolution,
    });
  }
  for (const selectedCase of cases.values()) {
    if (!cells.has(selectedCase.cell)) fail(`${selectedCase.id} selects an unknown cell`);
  }
  for (const cell of cells.values()) {
    const selected = [...cases.values()]
      .filter((item) => item.cell === cell.cell)
      .map((item) => item.id)
      .toSorted(lexical);
    const lanes = [
      ...new Set(selected.map((id) => cases.get(id).lane).filter((lane) => lane !== null)),
    ].toSorted(lexical);
    if (!sameStrings(cell.requiredCaseIds, selected))
      fail(`${cell.cell} required cases mismatch plan`);
    if (!sameStrings(cell.requiredLanes, lanes)) fail(`${cell.cell} required lanes mismatch plan`);
  }
  const pairKeys = new Set();
  const pairs = plan.notApplicablePairs.map((raw, index) => {
    const item = assertRecord(raw, `selectionPlan.notApplicablePairs[${index}]`);
    const behavior = assertText(item.behavior, `notApplicablePairs[${index}].behavior`, BEHAVIOR);
    const subject = assertText(item.subject, `notApplicablePairs[${index}].subject`, SUBJECT);
    const key = `${behavior}\0${subject}`;
    if (pairKeys.has(key)) fail(`duplicate non-applicable pair ${behavior}/${subject}`);
    if (cells.has(`cell::${behavior}::${subject}`))
      fail(`${behavior}/${subject} is also applicable`);
    pairKeys.add(key);
    return { behavior, subject };
  });
  for (const owned of OWNED_CELLS) if (!cells.has(owned)) fail(`missing owned cell ${owned}`);
  const laneFragments = normalizePlanLaneFragments(plan);
  return { candidateTreeDigest, classificationDigest, cases, cells, pairs, laneFragments };
}
function normalizeCaseResults(rawResults, plan) {
  if (!Array.isArray(rawResults) || rawResults.length !== EXPECTED_COUNTS.selectedCases) {
    fail("caseResults must report exactly all 3400 selected cases");
  }
  const results = new Map();
  for (const [index, raw] of rawResults.entries()) {
    const item = assertRecord(raw, `caseResults[${index}]`);
    const caseId = assertText(item.caseId, `caseResults[${index}].caseId`, CASE_ID);
    if (results.has(caseId)) fail(`duplicate case result ${caseId}`);
    const selected = plan.cases.get(caseId);
    if (!selected) fail(`case result ${caseId} was not selected`);
    for (const name of ["behavior", "subject", "cell"]) {
      if (item[name] !== selected[name]) fail(`${caseId} has mismatched ${name}`);
    }
    if (SKIP_STATUSES.has(item.status)) fail(`${caseId} has forbidden ${item.status} status`);
    if (item.status !== "pass" && item.status !== "fail") fail(`${caseId} has invalid status`);
    const reasonCodes = sortedStrings(item.reasonCodes, `${caseId}.reasonCodes`, REASON);
    const assertionCount = assertInteger(item.assertionCount, `${caseId}.assertionCount`);
    const observationCount = assertInteger(item.observationCount, `${caseId}.observationCount`);
    if (
      assertionCount > selected.requiredAssertionCount ||
      (item.status === "pass" && assertionCount !== selected.requiredAssertionCount)
    ) {
      fail(`${caseId} assertion count disagrees with its Gherkin outcomes`);
    }
    if (
      !OWNED_CELLS.includes(selected.cell) &&
      !(
        item.status === "fail" &&
        assertionCount === 0 &&
        observationCount === 0 &&
        sameStrings(reasonCodes, ["missing-execution"])
      )
    ) {
      fail(`${caseId} outside owned cells must be an explicit missing-execution failure`);
    }
    results.set(caseId, {
      caseId,
      behavior: selected.behavior,
      subject: selected.subject,
      cell: selected.cell,
      status: item.status,
      assertionCount,
      observationCount,
      requiredAssertionCount: selected.requiredAssertionCount,
      reasonCodes,
    });
  }
  return results;
}
function normalizeMutations(rawMutations) {
  if (!Array.isArray(rawMutations)) fail("mutationResults must be an array");
  const mutations = new Map();
  for (const [index, raw] of rawMutations.entries()) {
    const item = assertRecord(raw, `mutationResults[${index}]`);
    const cell = assertText(item.cell, `mutationResults[${index}].cell`, /^cell::/u);
    if (!OWNED_CELLS.includes(cell)) fail(`mutation result targets unowned cell ${cell}`);
    if (mutations.has(cell)) fail(`duplicate mutation result for ${cell}`);
    const expectedId = `kill::${cell.slice("cell::".length)}`;
    if (item.mutationId !== expectedId) fail(`${cell} has mismatched mutation identity`);
    if (!["killed", "escaped", "invalid"].includes(item.outcome))
      fail(`${cell} has invalid outcome`);
    if (!["pass", "fail"].includes(item.baselineStatus))
      fail(`${cell} has invalid baseline status`);
    if (!["pass", "fail"].includes(item.mutantStatus)) fail(`${cell} has invalid mutant status`);
    if (
      (item.outcome === "killed" &&
        (item.baselineStatus !== "pass" || item.mutantStatus !== "fail")) ||
      (item.outcome === "escaped" &&
        (item.baselineStatus !== "pass" || item.mutantStatus !== "pass"))
    ) {
      fail(`${cell} mutation outcome disagrees with baseline/mutant statuses`);
    }
    mutations.set(cell, {
      mutationId: expectedId,
      cell,
      outcome: item.outcome,
      baselineStatus: item.baselineStatus,
      mutantStatus: item.mutantStatus,
      reasonCodes: sortedStrings(item.reasonCodes, `${cell}.mutationReasonCodes`, REASON),
    });
  }
  return mutations;
}
function ownedCellRecord(cell, results, fragments, plannedFragments, mutation, receiptValue) {
  const cellResults = cell.requiredCaseIds.flatMap((id) => {
    const result = results.get(id);
    return result ? [result] : [];
  });
  const executedCaseIds = cellResults
    .filter(({ reasonCodes }) => !reasonCodes.includes("missing-execution"))
    .map(({ caseId }) => caseId)
    .toSorted(lexical);
  const assertedCaseIds = cellResults
    .filter(
      ({ assertionCount, requiredAssertionCount }) => assertionCount === requiredAssertionCount,
    )
    .map(({ caseId }) => caseId)
    .toSorted(lexical);
  const { receivedLanes, messageFragmentDigests } = receivedFragmentEvidence(
    cell,
    fragments,
    plannedFragments,
  );
  const reasons = new Set();
  if (!sameStrings(executedCaseIds, cell.requiredCaseIds)) reasons.add("missing-execution");
  if (!sameStrings(assertedCaseIds, cell.requiredCaseIds)) reasons.add("zero-assertion");
  if (!sameStrings(receivedLanes, cell.requiredLanes)) reasons.add("missing-lane-fragment");
  if (cell.requiredProfiles.length > 0) reasons.add("missing-profile-execution");
  for (const result of cellResults) {
    if (result.status !== "pass") reasons.add("case-failed");
    if (result.observationCount === 0) reasons.add("zero-observation");
    for (const reason of result.reasonCodes) reasons.add(reason);
  }
  if (!mutation) reasons.add("missing-mutation");
  else if (mutation.outcome === "escaped") reasons.add("mutation-escaped");
  else if (mutation.outcome !== "killed") reasons.add("invalid-mutation");
  if (receiptValue === undefined) reasons.add("missing-verified-receipt");
  else if (typeof receiptValue !== "string" || !DIGEST.test(receiptValue)) {
    reasons.add("invalid-verified-receipt");
  }
  const reasonCodes = [...reasons].toSorted(lexical);
  const status = reasonCodes.length === 0 ? "pass" : "fail";
  return {
    cell: cell.cell,
    behavior: cell.behavior,
    subject: cell.subject,
    status,
    requiredCaseIds: cell.requiredCaseIds,
    executedCaseIds,
    assertedCaseIds,
    requiredLanes: cell.requiredLanes,
    receivedLanes,
    requiredProfiles: cell.requiredProfiles,
    executedProfiles: [],
    messageFragmentDigests,
    verifiedReceiptDigest: status === "pass" ? receiptValue : null,
    reasonCodes,
  };
}
function missingCellRecord(cell, fragments, plannedFragments) {
  const { receivedLanes, messageFragmentDigests } = receivedFragmentEvidence(
    cell,
    fragments,
    plannedFragments,
  );
  return {
    cell: cell.cell,
    behavior: cell.behavior,
    subject: cell.subject,
    status: "fail",
    requiredCaseIds: cell.requiredCaseIds,
    executedCaseIds: [],
    assertedCaseIds: [],
    requiredLanes: cell.requiredLanes,
    receivedLanes,
    requiredProfiles: cell.requiredProfiles,
    executedProfiles: [],
    messageFragmentDigests,
    verifiedReceiptDigest: null,
    reasonCodes: [
      "missing-execution",
      ...(cell.laneResolution === "unclassified" ? ["missing-lane-classification"] : []),
      ...(cell.profileResolution === "unclassified" ? ["missing-profile-classification"] : []),
    ].toSorted(lexical),
  };
}
export function buildCellReport(input) {
  const options = assertRecord(input, "input");
  const plan = normalizePlan(options.selectionPlan);
  const selectionPlanDigest = assertText(
    options.selectionPlanDigest,
    "selectionPlanDigest",
    DIGEST,
  );
  if (selectionPlanDigest !== canonicalDigest(options.selectionPlan)) {
    fail("selectionPlanDigest does not match the selection plan");
  }
  const candidateBuildDigest = assertText(
    options.candidateBuildDigest,
    "candidateBuildDigest",
    DIGEST,
  );
  const fragments = normalizeReportLaneFragments(options.laneFragments, plan.laneFragments);
  const results = normalizeCaseResults(options.caseResults, plan);
  const mutations = normalizeMutations(options.mutationResults);
  const receipts = assertRecord(options.verifiedReceiptDigests, "verifiedReceiptDigests");
  for (const key of Object.keys(receipts)) {
    if (!OWNED_CELLS.includes(key)) fail(`receipt digest targets unowned cell ${key}`);
  }
  const cells = [...plan.cells.values()]
    .toSorted((left, right) => lexical(left.cell, right.cell))
    .map((cell) =>
      OWNED_CELLS.includes(cell.cell)
        ? ownedCellRecord(
            cell,
            results,
            fragments,
            plan.laneFragments,
            mutations.get(cell.cell),
            receipts[cell.cell],
          )
        : missingCellRecord(cell, fragments, plan.laneFragments),
    );
  const notApplicablePairs = plan.pairs
    .toSorted((left, right) =>
      lexical(`${left.behavior}\0${left.subject}`, `${right.behavior}\0${right.subject}`),
    )
    .map(({ behavior, subject }) => ({
      behavior,
      subject,
      status: "not-applicable",
      classificationDigest: plan.classificationDigest,
      reason: "production-target-only",
    }));
  const passingCellCount = cells.filter(({ status }) => status === "pass").length;
  const passBasisPoints = Math.floor((passingCellCount * 10_000) / EXPECTED_COUNTS.applicableCells);
  const normalizedResults = [...results.values()].toSorted((left, right) =>
    lexical(left.caseId, right.caseId),
  );
  const normalizedMutations = [...mutations.values()].toSorted((left, right) =>
    lexical(left.cell, right.cell),
  );
  const report = {
    schema: REPORT_SCHEMA,
    candidateTreeDigest: plan.candidateTreeDigest,
    candidateBuildDigest,
    selectionPlanDigest,
    classificationDigest: plan.classificationDigest,
    runner: { package: "@cucumber/cucumber", version: "13.2.0" },
    laneFragments: fragments,
    caseResultsDigest: canonicalDigest(normalizedResults),
    mutationResultsDigest: canonicalDigest(normalizedMutations),
    artifacts: options.artifacts ?? { ...DEFAULT_ARTIFACTS },
    cells,
    notApplicablePairs,
    summary: {
      applicableCellCount: EXPECTED_COUNTS.applicableCells,
      passingCellCount,
      failingCellCount: EXPECTED_COUNTS.applicableCells - passingCellCount,
      notApplicablePairCount: EXPECTED_COUNTS.nonApplicablePairs,
      passBasisPoints,
      displayPercent: (passBasisPoints / 100).toFixed(2),
    },
  };
  assertValidCellReport(report);
  return report;
}
export function formatCellReportSummary(report) {
  assertValidCellReport(report);
  return `${report.summary.passingCellCount}/${report.summary.applicableCellCount} cells pass (${report.summary.displayPercent}%); ${report.summary.failingCellCount} fail; ${report.summary.notApplicablePairCount} pairs not applicable`;
}
export function renderCellJunit(report) {
  assertValidCellReport(report);
  const cases = report.cells.map((cell) => {
    const failure =
      cell.status === "fail" ? `<failure message="${cell.reasonCodes.join(",")}"/>` : "";
    return `<testcase name="${cell.cell}" classname="${cell.behavior}">${failure}<system-out>${cell.requiredCaseIds.join("\n")}</system-out></testcase>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="behavior-cells" tests="687" failures="${report.summary.failingCellCount}" skipped="0">${cases.join("")}</testsuite>\n`;
}
