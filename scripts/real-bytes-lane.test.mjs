import assert from "node:assert/strict";
import test from "node:test";

import { selectProofs } from "./real-bytes-lane.mjs";

test("manifest engines select their own proof suites", () => {
  const proofs = selectProofs([
    { engine: "reallive", ordinal: 1, variant: "encrypted", path: "primary" },
    { engine: "siglus", ordinal: 1, variant: "encrypted", path: "secondary" },
  ]);

  assert.deepEqual(
    proofs.map(({ name, args }) => [name, args?.[2]]),
    [
      ["reallive", "kaifuu-reallive"],
      ["siglus", "kaifuu-siglus"],
    ],
  );
});

test("an engine without a proof is named as declared but unproven", () => {
  assert.deepEqual(
    selectProofs([{ engine: "unproven", ordinal: 1, variant: "plain", path: "." }]),
    [
      {
        name: "unproven",
        outcome: "failed",
        reason: "declared but unproven engine unproven",
      },
    ],
  );
});
