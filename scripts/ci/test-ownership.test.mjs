// @itotori-meta-check
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DB_OWNED_LANE,
  discoverTestOwnership,
  laneOwnershipFailures,
  removedOwnershipClaims,
} from "./test-ownership.mjs";

function withFixture(run) {
  const root = mkdtempSync(join(tmpdir(), "itotori-test-ownership-"));
  try {
    return run(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function writeOwnedTest(root, name, declaration) {
  const directory = join(root, "apps", "itotori", "test");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, name), "describe('owned marker', () => {});\n");
  writeFileSync(
    join(directory, `${name}.ownership.json`),
    `${JSON.stringify(declaration, null, 2)}\n`,
  );
}

function declaration(lanes = [DB_OWNED_LANE]) {
  return {
    schema: "itotori.test-ownership.v1",
    lanes,
    dbProof: { id: "fixture-proof", title: "fixture proof", marker: "owned marker" },
  };
}

test("discovers a sidecar beside its test and derives the test path", () => {
  withFixture((root) => {
    writeOwnedTest(root, "fixture.test.ts", declaration());
    const entries = discoverTestOwnership(root);
    assert.deepEqual(
      entries.map(({ test }) => test),
      ["apps/itotori/test/fixture.test.ts"],
    );
    assert.deepEqual(laneOwnershipFailures(entries), []);
  });
});

test("a test owned by no lane fails the route guard", () => {
  withFixture((root) => {
    writeOwnedTest(root, "unowned.test.ts", declaration([]));
    const failures = laneOwnershipFailures(discoverTestOwnership(root));
    assert.deepEqual(failures, ["apps/itotori/test/unowned.test.ts: owned by no lane"]);
  });
});

test("a test owned by two lanes fails the route guard", () => {
  withFixture((root) => {
    writeOwnedTest(root, "double-owned.test.ts", declaration([DB_OWNED_LANE, "ci-tier0-meta"]));
    const failures = laneOwnershipFailures(discoverTestOwnership(root));
    assert.deepEqual(failures, [
      "apps/itotori/test/double-owned.test.ts: owned by multiple lanes (ci-tier1-db, ci-tier0-meta)",
    ]);
  });
});

test("a DB proof cannot claim a non-DB lane", () => {
  withFixture((root) => {
    writeOwnedTest(root, "wrong-lane.test.ts", declaration(["ci-tier0-meta"]));
    assert.deepEqual(laneOwnershipFailures(discoverTestOwnership(root)), [
      "apps/itotori/test/wrong-lane.test.ts: DB proof must be owned by ci-tier1-db",
      "apps/itotori/test/wrong-lane.test.ts: direct recipe lane ci-tier0-meta needs recipeToken",
    ]);
  });
});

test("a DB-owned lane requires its adjacent DB proof metadata", () => {
  withFixture((root) => {
    writeOwnedTest(root, "unwired-live-db.test.ts", {
      schema: "itotori.test-ownership.v1",
      lanes: [DB_OWNED_LANE],
    });
    assert.deepEqual(laneOwnershipFailures(discoverTestOwnership(root)), [
      "apps/itotori/test/unwired-live-db.test.ts: DB-owned lane needs dbProof",
    ]);
  });
});

test("a deleted baseline declaration is a derived-ratchet failure", () => {
  const baseline = [
    {
      test: "apps/itotori/test/previous.test.ts",
      lanes: [DB_OWNED_LANE],
      coverage: { id: "previous-category" },
      dbProof: { id: "previous-proof" },
    },
  ];
  assert.deepEqual(removedOwnershipClaims([], baseline), [
    'previously declared public category "previous-category" is missing',
    'previously declared DB-owned proof "previous-proof" is missing',
  ]);
});
