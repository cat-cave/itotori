#!/usr/bin/env node
// CATALOG-072 regression suite. Guards the catalog-replay DB-backed gate's
// no-DATABASE_URL behavior: it must FAIL (non-zero), emit a machine-readable
// skipped artifact naming the catalog replay/idempotency suites, and never let
// a skip masquerade as persisted replay coverage. (The DB-present success path
// is exercised by `just catalog-replay-db-strict` against a real Postgres.)
//
// Also covers --results verify-only mode: only status "passed" counts, and a
// truncated shared result set is a hard failure.
import assert from "node:assert/strict";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gatePath = path.join(repoRoot, "scripts/catalog-replay-db-gate.mjs");
const skipArtifactPath = path.join(repoRoot, ".tmp/itotori-db/catalog-replay-skipped.json");
const proofArtifactPath = path.join(repoRoot, ".tmp/itotori-db/catalog-replay-proof.json");
const generalSkipMarkerPath = path.join(repoRoot, ".tmp/itotori-db/no-database-skipped.json");

const CATALOG_SUITES = [
  "catalog-crawler-repository.test.ts",
  "catalog-recorded-importers.test.ts",
  "catalog-dlsite-demand.test.ts",
  "catalog-replay-validation-artifact.test.ts",
];
const SUITE = CATALOG_SUITES[0];

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
    `a skipped catalog replay run must be a hard failure\n${result.stderr}`,
  );
  assert.ok(
    result.stdout.includes("NOT REPLAY COVERAGE"),
    "skip must be prominent and unmistakable for coverage",
  );
  const markerLine = result.stdout
    .split("\n")
    .find((line) => line.startsWith("CATALOG_REPLAY_DB_SKIP "));
  assert.ok(markerLine, "expected a one-line CATALOG_REPLAY_DB_SKIP marker on stdout");
  const marker = JSON.parse(markerLine.slice("CATALOG_REPLAY_DB_SKIP ".length));
  assert.equal(marker.status, "skipped");
  assert.equal(marker.replayCovered, false);
  assert.equal(marker.contract, "CATALOG-065");
  assert.equal(marker.node, "CATALOG-072");
  assert.ok(Array.isArray(marker.skippedSuites) && marker.skippedSuites.length > 0);
  assert.equal(marker.skippedSuiteCount, marker.skippedSuites.length);
});

test("no-DATABASE_URL run writes a machine-readable skipped artifact and no proof", async () => {
  await rm(skipArtifactPath, { force: true });
  await rm(proofArtifactPath, { force: true });
  runGateWithoutDb();

  const artifact = JSON.parse(await readFile(skipArtifactPath, "utf8"));
  assert.equal(artifact.status, "skipped");
  assert.equal(artifact.replayCovered, false);
  assert.equal(artifact.coverage, "none");
  assert.equal(artifact.contract, "CATALOG-065");
  assert.deepEqual([...artifact.skippedSuites].sort(), [
    "catalog-crawler-repository.test.ts",
    "catalog-dlsite-demand.test.ts",
    "catalog-recorded-importers.test.ts",
    "catalog-replay-validation-artifact.test.ts",
  ]);
  assert.ok(
    typeof artifact.remediationCommand === "string" && artifact.remediationCommand.length > 0,
  );

  // A skip must NEVER leave a success proof behind.
  await assert.rejects(readFile(proofArtifactPath, "utf8"), /ENOENT/u);
});

// --- --results verify-only mode tests ---

function runGateVerifyOnly(reportPath) {
  const env = { ...process.env, DATABASE_URL: "postgres://dummy:dummy@127.0.0.1:5432/dummy" };
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
    `cr-gate-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  await writeFile(file, JSON.stringify(report));
  return file;
}

async function listDbTestFiles() {
  const dir = path.join(repoRoot, "packages/itotori-db/test");
  return (await readdir(dir)).filter((n) => n.endsWith(".test.ts")).sort();
}

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

test("--results verify-only rejects an absent results file", async () => {
  await rm(generalSkipMarkerPath, { force: true });
  const result = runGateVerifyOnly(path.join(tmpdir(), "nonexistent-cr-results.json"));
  assert.equal(result.status, 1, `must fail on absent results\n${gateOutput(result)}`);
  assert.match(gateOutput(result), /missing\/unreadable shared DB results/u);
});

test("--results verify-only rejects a truncated result set (6-of-N files)", async () => {
  await rm(generalSkipMarkerPath, { force: true });
  const files = await listDbTestFiles();
  assert.ok(files.length >= 6, "expected a full DB suite on disk");
  const truncated = {
    success: true,
    testResults: files.slice(0, 6).map((f) => ({
      name: `/repo/packages/itotori-db/test/${f}`,
      status: "passed",
      assertionResults: [{ fullName: "replay test", title: "replay", status: "passed" }],
    })),
  };
  const file = await writeTempReport(truncated);
  const result = runGateVerifyOnly(file);
  assert.equal(result.status, 1, `must fail on truncated 6-of-N report\n${gateOutput(result)}`);
  assert.match(gateOutput(result), /incomplete|missing \d+\//u);
  await rm(file, { force: true });
});

test("--results verify-only rejects a report missing the catalog replay suites", async () => {
  await rm(generalSkipMarkerPath, { force: true });
  const files = await listDbTestFiles();
  const withoutCatalog = files.filter((f) => !CATALOG_SUITES.includes(f));
  const incomplete = {
    success: true,
    testResults: withoutCatalog.map((f) => ({
      name: `/repo/packages/itotori-db/test/${f}`,
      status: "passed",
      assertionResults: [{ fullName: "ok", title: "ok", status: "passed" }],
    })),
  };
  const file = await writeTempReport(incomplete);
  const result = runGateVerifyOnly(file);
  assert.equal(result.status, 1, `must fail when suites are absent\n${gateOutput(result)}`);
  assert.match(gateOutput(result), /incomplete|missing|did not run/u);
  await rm(file, { force: true });
});

test("--results verify-only rejects a suite with zero tests", async () => {
  await rm(generalSkipMarkerPath, { force: true });
  const report = await makeCompleteReport({
    [SUITE]: {
      name: `/repo/packages/itotori-db/test/${SUITE}`,
      status: "passed",
      assertionResults: [],
    },
  });
  const file = await writeTempReport(report);
  const result = runGateVerifyOnly(file);
  assert.equal(result.status, 1, `must fail on zero tests\n${gateOutput(result)}`);
  assert.match(gateOutput(result), /ran 0 tests/u);
  await rm(file, { force: true });
});

test("--results verify-only rejects a suite with skipped entries", async () => {
  await rm(generalSkipMarkerPath, { force: true });
  const overrides = Object.fromEntries(
    CATALOG_SUITES.map((s) => [
      s,
      {
        name: `/repo/packages/itotori-db/test/${s}`,
        status: "passed",
        assertionResults: [{ fullName: "replay test", title: "replay", status: "skipped" }],
      },
    ]),
  );
  const report = await makeCompleteReport(overrides);
  const file = await writeTempReport(report);
  const result = runGateVerifyOnly(file);
  assert.equal(result.status, 1, `must fail on skipped entries\n${gateOutput(result)}`);
  assert.match(gateOutput(result), /skipped|non-passed/u);
  await rm(file, { force: true });
});

test("--results verify-only rejects a suite with todo entries (not coverage)", async () => {
  await rm(generalSkipMarkerPath, { force: true });
  const overrides = Object.fromEntries(
    CATALOG_SUITES.map((s) => [
      s,
      {
        name: `/repo/packages/itotori-db/test/${s}`,
        status: "passed",
        assertionResults: [{ fullName: "replay test", title: "replay", status: "todo" }],
      },
    ]),
  );
  const report = await makeCompleteReport(overrides);
  const file = await writeTempReport(report);
  const result = runGateVerifyOnly(file);
  assert.equal(result.status, 1, `must fail on todo entries\n${gateOutput(result)}`);
  assert.match(gateOutput(result), /todo|non-passed|only status "passed"/u);
  await rm(file, { force: true });
});
