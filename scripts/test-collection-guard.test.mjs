import assert from "node:assert/strict";
import test from "node:test";

import {
  applyExplicitDbOwnership,
  applyExplicitLiveEvidenceOwnership,
  checkCollection,
} from "./test-collection-guard.mjs";

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

test("a public omission is accepted only with an explicit named live-evidence owner", () => {
  const file = "apps/itotori/test/live-evidence/private-proof.test.ts";
  const assigned = applyExplicitLiveEvidenceOwnership({
    onDisk: [file],
    publicCollected: new Set(),
    suites: [{ file, framework: "vitest", runner: "real-bytes" }],
    fileExists: () => true,
  });

  assert.deepEqual(checkCollection([file], assigned).missing, []);
});

test("an excluded live-evidence test without a named owner fails collection", () => {
  assert.throws(
    () =>
      applyExplicitLiveEvidenceOwnership({
        onDisk: ["apps/itotori/test/live-evidence/orphan.test.ts"],
        publicCollected: new Set(),
        suites: [],
        fileExists: () => true,
      }),
    /no named owner/u,
  );
});

test("a named live-evidence suite cannot also leak into public Vitest collection", () => {
  const file = "apps/itotori/test/live-evidence/private-proof.test.ts";
  assert.throws(
    () =>
      applyExplicitLiveEvidenceOwnership({
        onDisk: [file],
        publicCollected: new Set([file]),
        suites: [{ file, framework: "vitest", runner: "real-bytes" }],
        fileExists: () => true,
      }),
    /must exclude named live evidence/u,
  );
});

test("a DB-owned app suite has an explicit non-public owner", () => {
  const file = "apps/itotori/test/live-postgres.test.ts";
  const assigned = applyExplicitDbOwnership({
    publicCollected: new Set(),
    proofs: [{ proof: "live-postgres", test: file }],
    fileExists: () => true,
  });

  assert.deepEqual(checkCollection([file], assigned).missing, []);
});

test("a DB-owned suite leaking into public Vitest collection fails", () => {
  const file = "apps/itotori/test/live-postgres.test.ts";
  assert.throws(
    () =>
      applyExplicitDbOwnership({
        publicCollected: new Set([file]),
        proofs: [{ proof: "live-postgres", test: file }],
        fileExists: () => true,
      }),
    /must exclude DB-owned suite/u,
  );
});
