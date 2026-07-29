import assert from "node:assert/strict";
import test from "node:test";

import { checkCollection } from "./test-collection-guard.mjs";

test("fails when a test file exists without a collecting project", () => {
  const result = checkCollection(
    ["packages/example/test/collected.test.ts", "packages/example/orphan.test.ts"],
    new Set(["packages/example/test/collected.test.ts"]),
  );

  assert.deepEqual(result.missing, ["packages/example/orphan.test.ts"]);
});

test("passes after every on-disk test file has a collection receipt", () => {
  const files = ["packages/example/test/collected.test.ts", "packages/example/orphan.test.ts"];
  const result = checkCollection(files, new Set(files));

  assert.deepEqual(result.missing, []);
  assert.equal(result.onDiskCount, 2);
  assert.equal(result.collectedCount, 2);
});
