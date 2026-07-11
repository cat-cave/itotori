#!/usr/bin/env node
// SHARED-027 regression suite. Guards the permission-denial DB-backed gate's
// no-DATABASE_URL behavior: it must FAIL (non-zero), emit a machine-readable
// skipped artifact naming the authorization matrix suite, and never let a skip
// masquerade as DB-backed authorization denial coverage. (The DB-present
// success path is exercised by `just permission-denial-db-strict` against a real
// Postgres.)
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gatePath = path.join(repoRoot, "scripts/permission-denial-db-gate.mjs");

// Each test runs the gate in its OWN isolated artifact dir (passed to the gate
// via ITOTORI_DB_TMP_DIR) so concurrent invocations can't race on a shared
// skip/proof artifact path.
async function makeIsolatedTmpDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "itotori-db-gate-"));
  return dir;
}

function runGateWithoutDb(tmpDir) {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  env.ITOTORI_DB_TMP_DIR = tmpDir;
  return spawnSync(process.execPath, [gatePath], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
}

test("no-DATABASE_URL run fails loudly and never green-on-skip", async (t) => {
  const tmpDir = await makeIsolatedTmpDir();
  t.after(() => rm(tmpDir, { recursive: true, force: true }));
  const skipArtifactPath = path.join(tmpDir, "permission-denial-skipped.json");
  const result = runGateWithoutDb(tmpDir);

  assert.equal(
    result.status,
    1,
    `a skipped permission-denial run must be a hard failure\n${result.stderr}`,
  );
  assert.ok(
    result.stdout.includes("NOT AUTHORIZATION COVERAGE"),
    "skip must be prominent and unmistakable for coverage",
  );
  const markerLine = result.stdout
    .split("\n")
    .find((line) => line.startsWith("PERMISSION_DENIAL_DB_SKIP "));
  assert.ok(markerLine, "expected a one-line PERMISSION_DENIAL_DB_SKIP marker on stdout");
  const marker = JSON.parse(markerLine.slice("PERMISSION_DENIAL_DB_SKIP ".length));
  assert.equal(marker.status, "skipped");
  assert.equal(marker.permissionDenialCovered, false);
  assert.equal(marker.node, "SHARED-027");
  assert.ok(Number.isInteger(marker.expectedMatrixEntries) && marker.expectedMatrixEntries > 0);
  assert.deepEqual(marker.skippedSuites, ["authorization-matrix.test.ts"]);
  assert.equal(marker.skippedSuiteCount, marker.skippedSuites.length);
  // The isolated skip artifact must exist and match the marker.
  const artifact = JSON.parse(await readFile(skipArtifactPath, "utf8"));
  assert.equal(artifact.status, "skipped");
});

test("no-DATABASE_URL run writes a machine-readable skipped artifact and no proof", async (t) => {
  const tmpDir = await makeIsolatedTmpDir();
  t.after(() => rm(tmpDir, { recursive: true, force: true }));
  const skipArtifactPath = path.join(tmpDir, "permission-denial-skipped.json");
  const proofArtifactPath = path.join(tmpDir, "permission-denial-proof.json");
  runGateWithoutDb(tmpDir);

  const artifact = JSON.parse(await readFile(skipArtifactPath, "utf8"));
  assert.equal(artifact.status, "skipped");
  assert.equal(artifact.permissionDenialCovered, false);
  assert.equal(artifact.coverage, "none");
  assert.equal(artifact.node, "SHARED-027");
  assert.ok(Number.isInteger(artifact.expectedMatrixEntries) && artifact.expectedMatrixEntries > 0);
  assert.deepEqual(artifact.skippedSuites, ["authorization-matrix.test.ts"]);
  assert.ok(
    typeof artifact.remediationCommand === "string" && artifact.remediationCommand.length > 0,
  );

  // A skip must NEVER leave a success proof behind.
  await assert.rejects(readFile(proofArtifactPath, "utf8"), /ENOENT/u);
});
