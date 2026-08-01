import assert from "node:assert/strict";
import test from "node:test";

import { assertNoCellRegression, assertReportsDoNotRegress } from "./behavior-cell-ratchet.mjs";

const baseline = {
  candidateCount: 2,
  baselineCount: 2,
  applicableCount: 687,
  baselineApplicableCount: 687,
};

test("cell-count ratchet rejects a regression", () => {
  assert.throws(
    () => assertNoCellRegression({ ...baseline, candidateCount: 1 }),
    /cell-count-regression:1\/2/u,
  );
});

test("cell-count ratchet accepts equal and increased counts", () => {
  assert.doesNotThrow(() => assertNoCellRegression(baseline));
  assert.doesNotThrow(() => assertNoCellRegression({ ...baseline, candidateCount: 3 }));
});

test("cell-count ratchet rejects applicable-count drift", () => {
  assert.throws(
    () => assertNoCellRegression({ ...baseline, applicableCount: 686 }),
    /applicable-count-drift:686\/687/u,
  );
});

test("cell-count ratchet rejects every malformed count with a distinct code", () => {
  for (const [field, code] of [
    ["candidateCount", "candidate-count-invalid"],
    ["baselineCount", "baseline-count-invalid"],
    ["applicableCount", "applicable-count-invalid"],
    ["baselineApplicableCount", "baseline-applicable-count-invalid"],
  ]) {
    assert.throws(
      () => assertNoCellRegression({ ...baseline, [field]: -1 }),
      new RegExp(code, "u"),
    );
    assert.throws(
      () => assertNoCellRegression({ ...baseline, [field]: 1.5 }),
      new RegExp(code, "u"),
    );
    assert.throws(
      () => assertNoCellRegression({ ...baseline, [field]: undefined }),
      new RegExp(code, "u"),
    );
  }
});

test("cell-count ratchet fails closed when the baseline report is absent", () => {
  assert.throws(
    () =>
      assertReportsDoNotRegress(
        { summary: { passingCellCount: 2, applicableCellCount: 687 } },
        undefined,
      ),
    /baseline-count-invalid/u,
  );
});
