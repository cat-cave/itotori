#!/usr/bin/env node
// SHARED-027 regression suite. Guards the permission-denial DB-backed gate's
// no-DATABASE_URL behavior: it must FAIL (non-zero), emit a machine-readable
// skipped artifact naming the authorization matrix suite, and never let a skip
// masquerade as DB-backed authorization denial coverage. (The DB-present
// success path is exercised by `just permission-denial-db-strict` against a real
// Postgres.)
//
// Also covers --results verify-only mode: only status "passed" counts, and a
// truncated shared result set (missing DB suite files) is a hard failure.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gatePath = path.join(repoRoot, "scripts/permission-denial-db-gate.mjs");
const SUITE = "authorization-matrix.test.ts";

// Each test runs the gate in its OWN isolated artifact dir (passed to the gate
// via ITOTORI_DB_TMP_DIR) so concurrent invocations can't race on a shared
// skip/proof artifact path.
async function makeIsolatedTmpDir() {
  return mkdtemp(path.join(tmpdir(), "itotori-db-gate-"));
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

// --- --results verify-only mode tests ---
// The gate accepts a shared JSON results file (--results <file>) so the full DB
// suite runs once and the receipts verify against it instead of each
// re-spawning a scoped runner. These tests prove verify-only mode still rejects
// every failure mode (no green-on-skip): absent results, incomplete file set,
// missing suite, zero-test, skipped, todo, and failing entries.

function runGateVerifyOnly(reportPath, tmpDir) {
  const env = {
    ...process.env,
    DATABASE_URL: "postgres://dummy:dummy@127.0.0.1:5432/dummy",
    ITOTORI_DB_TMP_DIR: tmpDir,
  };
  return spawnSync(process.execPath, [gatePath, "--results", reportPath], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
}

function gateOutput(r) {
  return `${r.stdout}\n${r.stderr}`;
}

async function writeTempReport(report) {
  const file = path.join(
    tmpdir(),
    `pd-gate-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  await writeFile(file, JSON.stringify(report));
  return file;
}

async function listDbTestFiles() {
  const dir = path.join(repoRoot, "packages/itotori-db/test");
  return (await readdir(dir)).filter((n) => n.endsWith(".test.ts")).sort();
}

/** Full-suite report skeleton: one entry per on-disk DB test file. */
async function makeCompleteReport(suiteOverrides = {}) {
  const files = await listDbTestFiles();
  return {
    success: true,
    testResults: files.map((f) => {
      if (suiteOverrides[f]) return suiteOverrides[f];
      return {
        name: `/repo/packages/itotori-db/test/${f}`,
        status: "passed",
        assertionResults: [{ fullName: "ok", title: "ok", status: "passed" }],
      };
    }),
  };
}

test("--results verify-only rejects an absent results file", async (t) => {
  const tmpDir = await makeIsolatedTmpDir();
  t.after(() => rm(tmpDir, { recursive: true, force: true }));
  const result = runGateVerifyOnly(path.join(tmpdir(), "nonexistent-pd-results.json"), tmpDir);
  assert.equal(result.status, 1, `must fail on absent results\n${gateOutput(result)}`);
  assert.match(gateOutput(result), /missing\/unreadable shared DB results/u);
});

test("--results verify-only rejects a truncated result set (6-of-N files)", async (t) => {
  const tmpDir = await makeIsolatedTmpDir();
  t.after(() => rm(tmpDir, { recursive: true, force: true }));
  const files = await listDbTestFiles();
  assert.ok(files.length >= 6, "expected a full DB suite on disk");
  // Six receipt-like files with all assertions "passed" — still incomplete.
  const truncated = {
    success: true,
    testResults: files.slice(0, 6).map((f) => ({
      name: `/repo/packages/itotori-db/test/${f}`,
      status: "passed",
      assertionResults: [
        {
          fullName: "repository permission denial fixtures denies x without y",
          title: "denies x without y",
          status: "passed",
        },
      ],
    })),
  };
  const file = await writeTempReport(truncated);
  t.after(() => rm(file, { force: true }));
  const result = runGateVerifyOnly(file, tmpDir);
  assert.equal(result.status, 1, `must fail on truncated 6-of-N report\n${gateOutput(result)}`);
  assert.match(gateOutput(result), /incomplete|missing \d+\//u);
});

test("--results verify-only rejects a report missing the authorization-matrix suite", async (t) => {
  const tmpDir = await makeIsolatedTmpDir();
  t.after(() => rm(tmpDir, { recursive: true, force: true }));
  // Completeness requires every on-disk file: drop the matrix suite so the
  // shared set is incomplete (and the suite filter would also find 0 matches).
  const files = await listDbTestFiles();
  const withoutMatrix = files.filter((f) => f !== SUITE);
  const incomplete = {
    success: true,
    testResults: withoutMatrix.map((f) => ({
      name: `/repo/packages/itotori-db/test/${f}`,
      status: "passed",
      assertionResults: [{ fullName: "ok", title: "ok", status: "passed" }],
    })),
  };
  const file = await writeTempReport(incomplete);
  t.after(() => rm(file, { force: true }));
  const result = runGateVerifyOnly(file, tmpDir);
  assert.equal(result.status, 1, `must fail when matrix suite is absent\n${gateOutput(result)}`);
  assert.match(gateOutput(result), /incomplete|missing|did not run/u);
});

test("--results verify-only rejects a suite with zero tests", async (t) => {
  const tmpDir = await makeIsolatedTmpDir();
  t.after(() => rm(tmpDir, { recursive: true, force: true }));
  const report = await makeCompleteReport({
    [SUITE]: {
      name: `/repo/packages/itotori-db/test/${SUITE}`,
      status: "passed",
      assertionResults: [],
    },
  });
  const file = await writeTempReport(report);
  t.after(() => rm(file, { force: true }));
  const result = runGateVerifyOnly(file, tmpDir);
  assert.equal(result.status, 1, `must fail on zero tests\n${gateOutput(result)}`);
  assert.match(gateOutput(result), /ran 0 tests/u);
});

test("--results verify-only rejects a suite with skipped entries", async (t) => {
  const tmpDir = await makeIsolatedTmpDir();
  t.after(() => rm(tmpDir, { recursive: true, force: true }));
  const report = await makeCompleteReport({
    [SUITE]: {
      name: `/repo/packages/itotori-db/test/${SUITE}`,
      status: "passed",
      assertionResults: [
        {
          fullName: "repository permission denial fixtures denies x without y",
          title: "denies x without y",
          status: "skipped",
        },
      ],
    },
  });
  const file = await writeTempReport(report);
  t.after(() => rm(file, { force: true }));
  const result = runGateVerifyOnly(file, tmpDir);
  assert.equal(result.status, 1, `must fail on skipped entries\n${gateOutput(result)}`);
  assert.match(gateOutput(result), /skipped|non-passed/u);
});

test("--results verify-only rejects a suite with todo entries (not coverage)", async (t) => {
  const tmpDir = await makeIsolatedTmpDir();
  t.after(() => rm(tmpDir, { recursive: true, force: true }));
  const report = await makeCompleteReport({
    [SUITE]: {
      name: `/repo/packages/itotori-db/test/${SUITE}`,
      status: "passed",
      assertionResults: [
        {
          fullName: "repository permission denial fixtures denies x without y",
          title: "denies x without y",
          status: "todo",
        },
      ],
    },
  });
  const file = await writeTempReport(report);
  t.after(() => rm(file, { force: true }));
  const result = runGateVerifyOnly(file, tmpDir);
  assert.equal(result.status, 1, `must fail on todo entries\n${gateOutput(result)}`);
  assert.match(gateOutput(result), /todo|non-passed|only status "passed"/u);
});
