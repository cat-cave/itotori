// @itotori-meta-check
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { derivedCiRouting } from "./lane-routing.mjs";

function withFixture(run) {
  const root = mkdtempSync(join(tmpdir(), "itotori-lane-routing-"));
  try {
    return run(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function writeDbOwnership(root, lanes) {
  const directory = join(root, "apps", "itotori", "test");
  const name = "derived-route.test.ts";
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, name), "describe('route marker', () => {});\n");
  writeFileSync(
    join(directory, `${name}.ownership.json`),
    `${JSON.stringify(
      {
        schema: "itotori.test-ownership.v1",
        lanes,
        dbProof: { id: "route-proof", title: "route proof", marker: "route marker" },
      },
      null,
      2,
    )}\n`,
  );
}

test("the DB CI selector and route are derived from per-test ownership", () => {
  withFixture((root) => {
    writeDbOwnership(root, ["ci-tier1-db"]);
    const routing = derivedCiRouting(root);
    assert.ok(routing.lanes.includes("tier1-db"));
    assert.equal(routing.kindForLane("tier1-db"), "db-owned-app");
  });
  const command = readFileSync("scripts/developer-command.mjs", "utf8");
  assert.doesNotMatch(command, /if \(lane === "tier1-db"\)/u);
});

test("routing rejects declarations with zero or two owners", () => {
  for (const lanes of [[], ["ci-tier1-db", "ci-tier0-meta"]]) {
    withFixture((root) => {
      writeDbOwnership(root, lanes);
      assert.throws(() => derivedCiRouting(root), /test ownership routing failed/u);
    });
  }
});
