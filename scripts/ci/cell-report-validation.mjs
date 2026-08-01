import { readFileSync } from "node:fs";

import Ajv from "ajv";

import { laneFragmentKey } from "./behavior-proof-fragments.mjs";

const APPLICABLE_CELLS = 687;
const schemaUrl = new URL("../../suite/behavior/schemas/cell-report.schema.json", import.meta.url);
const schema = JSON.parse(readFileSync(schemaUrl, "utf8"));
const ajv = new Ajv({ allErrors: true, strict: true });
const validateSchema = ajv.compile(schema);
const lexical = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function fail(message) {
  throw new Error(`cell report: ${message}`);
}

const sameStrings = (left, right) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.keys(value)
    .toSorted(lexical)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(",")}}`;
}

function assertSortedUnique(values, label) {
  if (!sameStrings(values, values.toSorted(lexical))) fail(`${label} is not lexically sorted`);
  if (new Set(values).size !== values.length) fail(`${label} contains duplicates`);
}

export function assertValidCellReport(report) {
  if (!validateSchema(report)) {
    fail(`schema validation failed: ${ajv.errorsText(validateSchema.errors)}`);
  }
  assertSortedUnique(
    report.cells.map(({ cell }) => cell),
    "cells",
  );
  assertSortedUnique(
    report.notApplicablePairs.map(({ behavior, subject }) => `${behavior}\0${subject}`),
    "notApplicablePairs",
  );
  const fragmentKeys = report.laneFragments.map((item) => laneFragmentKey(item));
  if (new Set(fragmentKeys).size !== fragmentKeys.length) {
    fail("laneFragments contains duplicate fragments");
  }
  const fragmentsByLane = new Map();
  for (const fragment of report.laneFragments) {
    if (fragment.shard > fragment.shardCount) fail(`${laneFragmentKey(fragment)} shard is invalid`);
    const group = fragmentsByLane.get(fragment.lane) ?? [];
    if (group.some(({ shardCount }) => shardCount !== fragment.shardCount)) {
      fail(`${fragment.lane} has inconsistent shard counts`);
    }
    group.push(fragment);
    fragmentsByLane.set(fragment.lane, group);
  }
  for (const cell of report.cells) {
    if (cell.cell !== `cell::${cell.behavior}::${cell.subject}`) {
      fail(`${cell.cell} identity mismatch`);
    }
    const expectedDigests = cell.receivedLanes
      .flatMap((lane) => {
        const group = fragmentsByLane.get(lane) ?? [];
        const shardCount = group[0]?.shardCount ?? 0;
        if (
          group.length !== shardCount ||
          Array.from({ length: shardCount }, (_, index) => index + 1).some(
            (shard) => !group.some((fragment) => fragment.shard === shard),
          )
        ) {
          fail(`${cell.cell} reports incomplete received lane ${lane}`);
        }
        return group.map(({ messageDigest }) => messageDigest);
      })
      .toSorted(lexical);
    if (!sameStrings(cell.messageFragmentDigests, expectedDigests)) {
      fail(`${cell.cell} message fragment digests mismatch received lanes`);
    }
    if (cell.status === "pass") {
      if (cell.requiredLanes.length === 0) fail(`${cell.cell} has no classified lane`);
      if (!sameStrings(cell.requiredCaseIds, cell.executedCaseIds)) {
        fail(`${cell.cell} case mismatch`);
      }
      if (!sameStrings(cell.requiredCaseIds, cell.assertedCaseIds)) {
        fail(`${cell.cell} assertion mismatch`);
      }
      if (!sameStrings(cell.requiredLanes, cell.receivedLanes)) fail(`${cell.cell} lane mismatch`);
      if (!sameStrings(cell.requiredProfiles, cell.executedProfiles)) {
        fail(`${cell.cell} profile mismatch`);
      }
    }
  }
  for (const pair of report.notApplicablePairs) {
    if (pair.classificationDigest !== report.classificationDigest) fail("N/A digest mismatch");
  }
  const passing = report.cells.filter(({ status }) => status === "pass").length;
  const passBasisPoints = Math.floor((passing * 10_000) / APPLICABLE_CELLS);
  const expected = {
    applicableCellCount: APPLICABLE_CELLS,
    passingCellCount: passing,
    failingCellCount: APPLICABLE_CELLS - passing,
    notApplicablePairCount: 96,
    passBasisPoints,
    displayPercent: (passBasisPoints / 100).toFixed(2),
  };
  if (canonicalJson(report.summary) !== canonicalJson(expected)) {
    fail("summary arithmetic mismatch");
  }
}
