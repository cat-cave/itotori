#!/usr/bin/env node
// ITOTORI-135 regression suite. Guards the style-guide fixture-flow DB-backed
// gate's no-DATABASE_URL behavior: it must FAIL (non-zero), emit a
// machine-readable skipped artifact naming the ITOTORI-007 fixture-flow suite,
// and never let a skip masquerade as persisted fixture-flow coverage. (The
// DB-present success path is exercised by
// `just style-guide-fixture-flow-db-strict` against a real Postgres.)
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gatePath = path.join(repoRoot, "scripts/style-guide-fixture-flow-db-gate.mjs");
const skipArtifactPath = path.join(
  repoRoot,
  ".tmp/itotori-db/style-guide-fixture-flow-skipped.json",
);
const proofArtifactPath = path.join(
  repoRoot,
  ".tmp/itotori-db/style-guide-fixture-flow-proof.json",
);

function runGateWithoutDb() {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  return spawnSync(process.execPath, [gatePath], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
}

test("no-DATABASE_URL run fails loudly and never green-on-skip", async () => {
  await rm(skipArtifactPath, { force: true });
  await rm(proofArtifactPath, { force: true });
  const result = runGateWithoutDb();

  assert.equal(
    result.status,
    1,
    `a skipped style-guide fixture-flow run must be a hard failure\n${result.stderr}`,
  );
  assert.ok(
    result.stdout.includes("NOT PERSISTENCE COVERAGE"),
    "skip must be prominent and unmistakable for coverage",
  );
  const markerLine = result.stdout
    .split("\n")
    .find((line) => line.startsWith("STYLE_GUIDE_FIXTURE_FLOW_DB_SKIP "));
  assert.ok(markerLine, "expected a one-line STYLE_GUIDE_FIXTURE_FLOW_DB_SKIP marker on stdout");
  const marker = JSON.parse(markerLine.slice("STYLE_GUIDE_FIXTURE_FLOW_DB_SKIP ".length));
  assert.equal(marker.status, "skipped");
  assert.equal(marker.fixtureFlowCovered, false);
  assert.equal(marker.contract, "ITOTORI-007");
  assert.equal(marker.node, "ITOTORI-135");
  assert.ok(Array.isArray(marker.skippedSuites) && marker.skippedSuites.length > 0);
  assert.equal(marker.skippedSuiteCount, marker.skippedSuites.length);
});

test("no-DATABASE_URL run writes a machine-readable skipped artifact and no proof", async () => {
  await rm(skipArtifactPath, { force: true });
  await rm(proofArtifactPath, { force: true });
  runGateWithoutDb();

  const artifact = JSON.parse(await readFile(skipArtifactPath, "utf8"));
  assert.equal(artifact.status, "skipped");
  assert.equal(artifact.fixtureFlowCovered, false);
  assert.equal(artifact.coverage, "none");
  assert.equal(artifact.contract, "ITOTORI-007");
  assert.deepEqual([...artifact.skippedSuites].sort(), ["style-guide-fixture-flow.test.ts"]);
  assert.ok(
    typeof artifact.remediationCommand === "string" && artifact.remediationCommand.length > 0,
  );

  // A skip must NEVER leave a success proof behind.
  await assert.rejects(readFile(proofArtifactPath, "utf8"), /ENOENT/u);
});
