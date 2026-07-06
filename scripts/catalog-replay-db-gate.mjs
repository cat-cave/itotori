#!/usr/bin/env node
// CATALOG-072: DB-backed local gate for the catalog source-adapter REPLAY +
// IDEMPOTENCY repository tests (the CATALOG-065 idempotent fact-import
// contract). These suites are DB-classified: without a reachable Postgres the
// @itotori/db runner SKIPS them, and a skipped suite is NOT replay coverage.
// This gate makes "full replay coverage ran" PROVABLE rather than confusable
// with a green-on-skip local run:
//
//   * No DATABASE_URL  -> write a machine-readable skipped artifact and FAIL
//     (non-zero). A skip can never masquerade as persisted replay verification.
//   * DATABASE_URL set -> run ONLY the catalog replay/idempotency suites against
//     the (disposable) database, then ASSERT each named suite actually executed
//     replayed tests (per-suite assertion count > 0, zero skipped, zero failed).
//     A zero-test / skipped outcome is a hard failure, and a deterministic proof
//     artifact records the per-suite test counts.
//
// Run against a disposable Postgres (see `just db-up` / `just db-migrate`):
//   just catalog-replay-db-strict
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredEnv = "DATABASE_URL";
const packageName = "@itotori/db";
const contractId = "CATALOG-065";
const gateId = "catalog-replay-db-strict";
const node = "CATALOG-072";

// The catalog source-adapter replay + idempotency repository suites. Each
// exercises the CATALOG-065 crash-replay window (facts written, crash before
// commitStepImport, same fixture replays) and/or importer-rerun idempotency
// against the migrated Postgres schema via `db-test-context`.
const catalogReplaySuites = [
  "catalog-crawler-repository.test.ts",
  "catalog-recorded-importers.test.ts",
  "catalog-dlsite-demand.test.ts",
];

const tmpDir = path.join(repoRoot, ".tmp/itotori-db");
const skipArtifactPath = path.join(tmpDir, "catalog-replay-skipped.json");
const proofArtifactPath = path.join(tmpDir, "catalog-replay-proof.json");
const resultsPath = path.join(tmpDir, "catalog-replay-results.json");
const generalSkipMarkerPath = path.join(tmpDir, "no-database-skipped.json");

const remediationCommand =
  'just db-up && just db-migrate && DATABASE_URL="$(node scripts/itotori-db-compose-env.mjs --print-database-url)" just catalog-replay-db-strict';

await mkdir(tmpDir, { recursive: true });
// Start from a clean slate so a stale artifact never stands in for this run.
await rm(skipArtifactPath, { force: true });
await rm(proofArtifactPath, { force: true });
await rm(resultsPath, { force: true });

if (!process.env[requiredEnv]) {
  const skipArtifact = {
    status: "skipped",
    gate: gateId,
    node,
    contract: contractId,
    package: packageName,
    reason: `${requiredEnv} unset`,
    requiredEnv,
    coverage: "none",
    replayCovered: false,
    skippedSuites: catalogReplaySuites,
    skippedSuiteCount: catalogReplaySuites.length,
    remediationCommand,
    timestamp: new Date().toISOString(),
  };
  await writeFile(skipArtifactPath, `${JSON.stringify(skipArtifact, null, 2)}\n`);
  printBanner([
    `${gateId}: CATALOG REPLAY DB TESTS SKIPPED — NOT REPLAY COVERAGE`,
    `required env:     ${requiredEnv} (unset)`,
    `skipped suites:   ${catalogReplaySuites.length} (${catalogReplaySuites.join(", ")})`,
    `contract:         ${contractId} idempotent fact-import replay`,
    "this run proved ZERO persisted replay coverage",
    `skip artifact:    ${path.relative(repoRoot, skipArtifactPath)}`,
    `remediation:      ${remediationCommand}`,
  ]);
  // Single-line, grep-able, machine-readable marker on stdout.
  console.log(`CATALOG_REPLAY_DB_SKIP ${JSON.stringify(skipArtifact)}`);
  // A skip is NOT coverage: fail loudly so it can never be read as a pass.
  process.exit(1);
}

// DATABASE_URL present: run ONLY the catalog replay suites against the DB.
// Reuse the @itotori/db runner in --require-database mode so its own honesty
// guard (and the permission verifier) still apply, but scope vitest to the
// catalog replay/idempotency files and emit a JSON report we can assert on.
const suiteFilters = catalogReplaySuites.map((name) => name.replace(/\.test\.ts$/u, ""));
const runnerArgs = [
  "--filter",
  packageName,
  "exec",
  "node",
  "scripts/run-tests.mjs",
  "--require-database",
  ...suiteFilters,
  "--reporter=default",
  "--reporter=json",
  `--outputFile=${resultsPath}`,
];

const run = spawnSync("pnpm", runnerArgs, {
  cwd: repoRoot,
  stdio: "inherit",
  env: process.env,
});

if (run.error) {
  console.error(`${gateId}: failed to launch DB test runner: ${run.error.message}`);
  process.exit(1);
}
if (run.signal) {
  process.kill(process.pid, run.signal);
}

// Defense in depth: the runner writes this marker if it SKIPPED for lack of a
// DB. In --require-database mode it also exits non-zero, but never trust a green
// exit while a skip marker exists.
const generalSkip = await readJsonIfPresent(generalSkipMarkerPath);
if (generalSkip) {
  console.error(
    `${gateId}: FAILED — @itotori/db reported a no-DATABASE_URL skip; catalog replay did NOT run.`,
  );
  process.exit(1);
}

if (run.status !== 0) {
  console.error(`${gateId}: FAILED — catalog replay DB test run exited ${run.status ?? "null"}.`);
  process.exit(run.status ?? 1);
}

// Parse the machine-readable vitest report and PROVE each catalog replay suite
// actually executed tests. Zero tests, a missing suite, a skipped test, or any
// failure is a hard error — skipped != covered.
const report = await readJsonIfPresent(resultsPath);
if (!report || !Array.isArray(report.testResults)) {
  console.error(`${gateId}: FAILED — missing/unreadable vitest report at ${resultsPath}.`);
  process.exit(1);
}

const perSuite = [];
const problems = [];
for (const suite of catalogReplaySuites) {
  const suiteResults = report.testResults.filter(
    (entry) =>
      typeof entry?.name === "string" && entry.name.replace(/\\/gu, "/").endsWith(`/test/${suite}`),
  );
  if (suiteResults.length === 0) {
    problems.push(`suite ${suite} did not run (0 files matched) — skipped != covered`);
    continue;
  }
  const assertions = suiteResults.flatMap((entry) =>
    Array.isArray(entry.assertionResults) ? entry.assertionResults : [],
  );
  const passed = assertions.filter((a) => a.status === "passed").length;
  const failed = assertions.filter((a) => a.status === "failed").length;
  const skipped = assertions.filter((a) => a.status === "skipped" || a.status === "pending").length;
  if (assertions.length === 0) {
    problems.push(`suite ${suite} ran 0 tests — skipped != covered`);
  }
  if (skipped > 0) {
    problems.push(`suite ${suite} has ${skipped} skipped test(s) — skipped != covered`);
  }
  if (failed > 0) {
    problems.push(`suite ${suite} has ${failed} failed test(s)`);
  }
  perSuite.push({ suite, tests: assertions.length, passed, failed, skipped });
}

if (problems.length > 0) {
  printBanner([
    `${gateId}: CATALOG REPLAY DB COVERAGE NOT PROVEN`,
    ...problems.map((p) => `- ${p}`),
    "a skipped / zero-test outcome is NOT replay coverage",
    `remediation:      ${remediationCommand}`,
  ]);
  process.exit(1);
}

const totalTests = perSuite.reduce((sum, s) => sum + s.tests, 0);
const proof = {
  status: "passed",
  gate: gateId,
  node,
  contract: contractId,
  package: packageName,
  requiredEnv,
  databaseBacked: true,
  replayCovered: true,
  totalTests,
  suites: perSuite,
  timestamp: new Date().toISOString(),
};
await writeFile(proofArtifactPath, `${JSON.stringify(proof, null, 2)}\n`);

printBanner([
  `${gateId}: CATALOG REPLAY DB COVERAGE PROVEN`,
  `contract:         ${contractId} idempotent fact-import replay`,
  `suites executed:  ${perSuite.length} against a real database`,
  ...perSuite.map((s) => `- ${s.suite}: ${s.tests} tests (all passed, 0 skipped)`),
  `total tests:      ${totalTests}`,
  `proof artifact:   ${path.relative(repoRoot, proofArtifactPath)}`,
]);
process.exit(0);

async function readJsonIfPresent(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function printBanner(lines) {
  const width = Math.max(64, ...lines.map((line) => line.length + 4));
  const rule = "=".repeat(width);
  console.log(rule);
  for (const line of lines) {
    console.log(`  ${line}`);
  }
  console.log(rule);
}
