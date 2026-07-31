import assert from "node:assert/strict";
import test from "node:test";

import { parseBehaviorGateArgs, requireCompleteBehaviorMatrix } from "./behavior-gate-mode.mjs";

test("full-matrix mode stays red until every applicable cell passes", () => {
  assert.throws(
    () =>
      requireCompleteBehaviorMatrix({
        summary: { applicableCellCount: 687, passingCellCount: 2 },
      }),
    /full-matrix-incomplete:2\/687/u,
  );
});

test("full-matrix mode accepts exactly 687 passing applicable cells", () => {
  const report = { summary: { applicableCellCount: 687, passingCellCount: 687 } };
  assert.equal(requireCompleteBehaviorMatrix(report), report);
});

test("behavior gate modes default to fail-closed acceptance and parse explicit modes", () => {
  assert.deepEqual(parseBehaviorGateArgs([]), {
    mode: "accepted",
    artifactRoot: "behavior-proof",
  });
  assert.deepEqual(parseBehaviorGateArgs(["--local-candidate", "proof"]), {
    mode: "local",
    artifactRoot: "proof",
  });
  assert.deepEqual(parseBehaviorGateArgs(["--full-matrix"]), {
    mode: "full-matrix",
    artifactRoot: "behavior-proof",
  });
  assert.throws(() => parseBehaviorGateArgs(["--unknown"]), /usage:/u);
});
