import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPECTED_IGNORED_PRIVATE_CORPUS,
  buildNextestPartitionReceipt,
  summarizeNextestListReport,
} from "./nextest-partition-receipt.mjs";

function testCase(ignored, status, reason) {
  return {
    ignored,
    "filter-match": reason === undefined ? { status } : { status, reason },
  };
}

function listReport({ selected = 2, partitionNonselected = 3, ignored = 169 } = {}) {
  const testcases = {};
  for (let index = 0; index < selected; index += 1) {
    testcases[`selected-${index}`] = testCase(false, "matches");
  }
  for (let index = 0; index < partitionNonselected; index += 1) {
    testcases[`partition-${index}`] = testCase(false, "mismatch", "partition");
  }
  for (let index = 0; index < ignored; index += 1) {
    testcases[`private-${index}`] = testCase(true, "mismatch", "ignored");
  }
  return {
    "test-count": selected + partitionNonselected + ignored,
    "rust-suites": { suite: { testcases } },
  };
}

function summary(executed, skipped) {
  return `\u001b[32mSummary [  0.01s] ${executed} tests run: ${executed} passed, ${skipped} skipped\u001b[0m\n`;
}

test("builds a zero-CI-skip receipt while keeping partition and corpus exclusions visible", () => {
  const receipt = buildNextestPartitionReceipt({
    lane: "tier1-rust-1of3",
    listReport: listReport(),
    runReport: `${summary(1, 0)}${summary(2, 172)}`,
  });

  assert.deepEqual(receipt, {
    lane: "tier1-rust-1of3",
    executed: 2,
    ciSkipped: 0,
    partitionNonselected: 3,
    ignoredPrivateCorpus: EXPECTED_IGNORED_PRIVATE_CORPUS,
    rawNextestSkipped: 172,
    listed: 174,
  });
});

test("rejects an expanded ignored private-corpus inventory", () => {
  assert.throws(
    () => summarizeNextestListReport(listReport({ ignored: 170 })),
    /expected 169, found 170/u,
  );
});

test("rejects a filter mismatch outside the partition ownership state", () => {
  const report = listReport();
  report["rust-suites"].suite.testcases["partition-0"] = testCase(
    false,
    "mismatch",
    "default-filter",
  );
  assert.throws(
    () => summarizeNextestListReport(report),
    /unsupported selection state: ignored=false status=mismatch reason=default-filter/u,
  );
});

test("rejects a nextest run that executes a different count than the listed partition", () => {
  assert.throws(
    () =>
      buildNextestPartitionReceipt({
        lane: "tier1-rust-2of3",
        listReport: listReport(),
        runReport: summary(1, 172),
      }),
    /listed 2 selected tests, run reported 1/u,
  );
});

test("rejects unaccounted raw nextest skips", () => {
  assert.throws(
    () =>
      buildNextestPartitionReceipt({
        lane: "tier1-rust-3of3",
        listReport: listReport(),
        runReport: summary(2, 171),
      }),
    /expected 172 partition-or-private-corpus exclusions, run reported 171/u,
  );
});

test("rejects an ignored testcase that nextest reports as selected", () => {
  const report = listReport();
  report["rust-suites"].suite.testcases["private-0"] = testCase(true, "matches");
  assert.throws(
    () => summarizeNextestListReport(report),
    /unsupported selection state: ignored=true status=matches reason=undefined/u,
  );
});
