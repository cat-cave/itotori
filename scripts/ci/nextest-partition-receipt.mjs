#!/usr/bin/env node
// Reconcile a partitioned nextest run with its complete selection inventory.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Private-byte targets are feature-gated, not ignored. A listed ignored test
// is therefore always a regression.
export const EXPECTED_IGNORED_PRIVATE_CORPUS = 0;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function countFromText(value, label) {
  const count = Number(value.replaceAll(",", ""));
  if (!Number.isSafeInteger(count) || count < 0)
    throw new Error(`${label} is not a non-negative integer`);
  return count;
}

function testCasesFromList(report) {
  const listed = requireRecord(report, "nextest list report");
  const declaredCount = listed["test-count"];
  if (!Number.isSafeInteger(declaredCount) || declaredCount < 0) {
    throw new Error("nextest list report test-count must be a non-negative integer");
  }
  const suites = requireRecord(listed["rust-suites"], "nextest list report rust-suites");
  const testCases = [];
  for (const [suiteName, suite] of Object.entries(suites)) {
    const suiteRecord = requireRecord(suite, `nextest suite ${suiteName}`);
    const cases = requireRecord(suiteRecord.testcases, `nextest suite ${suiteName} testcases`);
    for (const [caseName, testCase] of Object.entries(cases)) {
      testCases.push({ name: `${suiteName}::${caseName}`, value: testCase });
    }
  }
  return { declaredCount, testCases };
}

export function classifyNextestTestCase(testCase, label) {
  const entry = requireRecord(testCase, `nextest testcase ${label}`);
  if (typeof entry.ignored !== "boolean") {
    throw new Error(`nextest testcase ${label} ignored must be a boolean`);
  }
  const filterMatch = requireRecord(
    entry["filter-match"],
    `nextest testcase ${label} filter-match`,
  );
  const status = requireString(filterMatch.status, `nextest testcase ${label} filter-match status`);
  const reason = filterMatch.reason;

  if (!entry.ignored && status === "matches") return "selected";
  if (!entry.ignored && status === "mismatch" && reason === "partition") {
    return "partitionNonselected";
  }
  if (entry.ignored && status === "mismatch" && reason === "ignored") {
    return "ignoredPrivateCorpus";
  }

  const renderedReason = typeof reason === "string" ? reason : JSON.stringify(reason);
  throw new Error(
    `nextest testcase ${label} has unsupported selection state: ` +
      `ignored=${entry.ignored} status=${status} reason=${renderedReason}`,
  );
}

export function summarizeNextestListReport(report) {
  const { declaredCount, testCases } = testCasesFromList(report);
  const counts = {
    selected: 0,
    partitionNonselected: 0,
    ignoredPrivateCorpus: 0,
  };
  for (const testCase of testCases) {
    counts[classifyNextestTestCase(testCase.value, testCase.name)] += 1;
  }
  const observed = counts.selected + counts.partitionNonselected + counts.ignoredPrivateCorpus;
  if (observed !== declaredCount) {
    throw new Error(
      `nextest list test-count mismatch: declared ${declaredCount}, observed ${observed} testcases`,
    );
  }
  if (counts.selected === 0) throw new Error("nextest partition selected no runnable tests");
  if (counts.ignoredPrivateCorpus !== EXPECTED_IGNORED_PRIVATE_CORPUS) {
    throw new Error(
      "nextest ignored-test inventory mismatch: " +
      `expected ${EXPECTED_IGNORED_PRIVATE_CORPUS}, found ${counts.ignoredPrivateCorpus}`,
    );
  }
  return { listed: declaredCount, ...counts };
}

function stripAnsi(text) {
  return text.replace(/\u001B(?:\][\s\S]*?(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~])/gu, "");
}

export function parseLastNextestSummary(runReport) {
  if (typeof runReport !== "string") throw new Error("nextest run report must be text");
  const summaries = [
    ...stripAnsi(runReport).matchAll(
      /Summary\s+\[[^\]\r\n]*\]\s+([0-9][0-9,]*)\s+tests?\s+run:\s*[^\r\n]*?\b([0-9][0-9,]*)\s+skipped\b/gu,
    ),
  ];
  const summary = summaries.at(-1);
  if (summary === undefined) throw new Error("nextest run report has no parseable Summary line");
  return {
    executed: countFromText(summary[1], "nextest Summary executed count"),
    rawNextestSkipped: countFromText(summary[2], "nextest Summary skipped count"),
  };
}

export function buildNextestPartitionReceipt({ lane, listReport, runReport }) {
  if (typeof lane !== "string" || lane.trim() === "")
    throw new Error("lane must be a non-empty string");
  const listed = summarizeNextestListReport(listReport);
  const run = parseLastNextestSummary(runReport);
  if (run.executed !== listed.selected) {
    throw new Error(
      `nextest execution mismatch: listed ${listed.selected} selected tests, run reported ${run.executed}`,
    );
  }
  const expectedRawSkipped = listed.partitionNonselected + listed.ignoredPrivateCorpus;
  if (run.rawNextestSkipped !== expectedRawSkipped) {
    throw new Error(
      "nextest skipped mismatch: " +
        `expected ${expectedRawSkipped} partition-or-private-corpus exclusions, ` +
        `run reported ${run.rawNextestSkipped}`,
    );
  }
  return {
    lane,
    executed: run.executed,
    ciSkipped: 0,
    partitionNonselected: listed.partitionNonselected,
    ignoredPrivateCorpus: listed.ignoredPrivateCorpus,
    rawNextestSkipped: run.rawNextestSkipped,
    listed: listed.listed,
  };
}

export function parseReceiptArguments(argv) {
  const options = { lane: null, listReport: null, runReport: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[++index];
    if (value === undefined) throw new Error(`${argument} requires a value`);
    if (argument === "--lane") options.lane = value;
    else if (argument === "--list-report") options.listReport = value;
    else if (argument === "--run-report") options.runReport = value;
    else throw new Error(`unknown argument ${argument}`);
  }
  if (options.lane === null || options.listReport === null || options.runReport === null) {
    throw new Error(
      "usage: nextest-partition-receipt --lane <name> --list-report <path> --run-report <path>",
    );
  }
  return options;
}

function invokedAsMain() {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}

if (invokedAsMain()) {
  try {
    const options = parseReceiptArguments(process.argv.slice(2));
    const receipt = buildNextestPartitionReceipt({
      lane: options.lane,
      listReport: JSON.parse(readFileSync(options.listReport, "utf8")),
      runReport: readFileSync(options.runReport, "utf8"),
    });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (error) {
    process.stderr.write(
      `nextest partition receipt: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
