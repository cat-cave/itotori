#!/usr/bin/env node
// ITOTORI-121: guards the DB-backed test skip-visibility contract so a missing-
// DATABASE_URL run can never masquerade as DB validation. Covers (a) the
// @itotori/db runner's prominent + machine-readable fast-local skip, (b) its
// non-zero require-database failure, and (c) the reusable honesty gate that
// fails when a skip marker is present.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runnerPath = path.join(repoRoot, "packages/itotori-db/scripts/run-tests.mjs");
const assertPath = path.join(repoRoot, "scripts/assert-db-tests-not-skipped.mjs");
const skipReportPath = path.join(repoRoot, ".tmp/itotori-db/no-database-skipped.json");

function runNode(scriptPath, args, env) {
  const baseEnv = { ...process.env };
  delete baseEnv.DATABASE_URL;
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    env: { ...baseEnv, ...env },
    encoding: "utf8",
  });
}

test("fast-local skip emits a prominent, machine-readable skipped status", async () => {
  await rm(skipReportPath, { force: true });
  const result = runNode(runnerPath, []);
  assert.equal(result.status, 0, `expected fast-local skip to exit 0\n${result.stderr}`);

  const markerLine = result.stdout
    .split("\n")
    .find((line) => line.startsWith("ITOTORI_DB_TEST_SKIP "));
  assert.ok(markerLine, "expected a one-line ITOTORI_DB_TEST_SKIP marker on stdout");
  const marker = JSON.parse(markerLine.slice("ITOTORI_DB_TEST_SKIP ".length));

  assert.equal(marker.status, "skipped");
  assert.equal(marker.package, "@itotori/db");
  assert.equal(marker.requiredEnv, "DATABASE_URL");
  assert.ok(Number.isInteger(marker.skippedSuiteCount) && marker.skippedSuiteCount > 0);
  assert.equal(marker.skippedSuiteCount, marker.skippedSuites.length);
  assert.ok(typeof marker.remediationCommand === "string" && marker.remediationCommand.length > 0);
  assert.ok(result.stdout.includes("did NOT validate the DB layer"), "skip must be prominent");
});

test("require-database mode fails (non-zero) when DATABASE_URL is unset", () => {
  const result = runNode(runnerPath, ["--require-database"]);
  assert.equal(result.status, 1, "require-database skip must be a hard failure");
  assert.ok(
    result.stderr.includes("require DATABASE_URL"),
    `expected a clear required-DB message\n${result.stderr}`,
  );
});

test("honesty gate fails when a skip marker is present and passes when absent", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "itotori-i121-"));
  try {
    // Absent marker -> pass. Run the assert against a clean repo state.
    await rm(skipReportPath, { force: true });
    const ok = runNode(assertPath, []);
    assert.equal(ok.status, 0, `expected no-marker to pass\n${ok.stderr}`);

    // Present marker -> fail (non-zero) with the DB-layer-not-validated banner.
    await mkdir(path.dirname(skipReportPath), { recursive: true });
    await writeFile(
      skipReportPath,
      `${JSON.stringify({
        status: "skipped",
        package: "@itotori/db",
        requiredEnv: "DATABASE_URL",
        skippedSuiteCount: 7,
        reason: "DATABASE_URL unset",
      })}\n`,
    );
    const failed = runNode(assertPath, []);
    assert.equal(failed.status, 1, "expected present-marker to fail");
    assert.ok(failed.stderr.includes("DB LAYER NOT VALIDATED"));
  } finally {
    await rm(skipReportPath, { force: true });
    await rm(workDir, { recursive: true, force: true });
  }
});
