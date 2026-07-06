#!/usr/bin/env node
// ITOTORI-135: DB-backed local gate for the ITOTORI-007 style-guide
// fixture-flow persistence suite. That suite drives the recorded conversational
// style-guide flow through the REAL @itotori/db repositories (versions,
// artifacts, event outbox) against a migrated Postgres. It is DB-classified:
// without a reachable Postgres the @itotori/db runner SKIPS it, and a skipped
// suite is NOT persistence coverage. This gate makes "the style-guide
// fixture-flow persisted for real" PROVABLE rather than confusable with a
// green-on-skip local run:
//
//   * No DATABASE_URL  -> write a machine-readable skipped artifact and FAIL
//     (non-zero). A skip can never masquerade as persisted fixture-flow
//     verification.
//   * DATABASE_URL set -> run ONLY the style-guide fixture-flow suite against
//     the (disposable) database, then ASSERT it actually executed persistence
//     tests (per-suite assertion count > 0, zero skipped, zero failed). A
//     zero-test / skipped outcome is a hard failure, and a deterministic proof
//     artifact records the per-suite test counts.
//
// Public-fixture-only: the suite reads fixtures/itotori-style-guide/... — no
// private providers, no real bytes. Run against a disposable Postgres (see
// `just db-up` / `just db-migrate`):
//   just style-guide-fixture-flow-db-strict
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredEnv = "DATABASE_URL";
const packageName = "@itotori/db";
const contractId = "ITOTORI-007";
const gateId = "style-guide-fixture-flow-db-strict";
const node = "ITOTORI-135";

// The ITOTORI-007 style-guide fixture-flow persistence suite. It drives the
// recorded conversational style-guide flow (public fixture) through the real
// project + style-guide repositories and asserts persisted versions, the
// suggestion artifact, and the affected-work invalidation outbox.
const fixtureFlowSuites = ["style-guide-fixture-flow.test.ts"];

const tmpDir = path.join(repoRoot, ".tmp/itotori-db");
const skipArtifactPath = path.join(tmpDir, "style-guide-fixture-flow-skipped.json");
const proofArtifactPath = path.join(tmpDir, "style-guide-fixture-flow-proof.json");
const resultsPath = path.join(tmpDir, "style-guide-fixture-flow-results.json");
const generalSkipMarkerPath = path.join(tmpDir, "no-database-skipped.json");

const remediationCommand =
  'just db-up && just db-migrate && DATABASE_URL="$(node scripts/itotori-db-compose-env.mjs --print-database-url)" just style-guide-fixture-flow-db-strict';

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
    fixtureFlowCovered: false,
    skippedSuites: fixtureFlowSuites,
    skippedSuiteCount: fixtureFlowSuites.length,
    remediationCommand,
    timestamp: new Date().toISOString(),
  };
  await writeFile(skipArtifactPath, `${JSON.stringify(skipArtifact, null, 2)}\n`);
  printBanner([
    `${gateId}: STYLE-GUIDE FIXTURE-FLOW DB TESTS SKIPPED — NOT PERSISTENCE COVERAGE`,
    `required env:     ${requiredEnv} (unset)`,
    `skipped suites:   ${fixtureFlowSuites.length} (${fixtureFlowSuites.join(", ")})`,
    `contract:         ${contractId} style-guide fixture-flow persistence`,
    "this run proved ZERO persisted fixture-flow coverage",
    `skip artifact:    ${path.relative(repoRoot, skipArtifactPath)}`,
    `remediation:      ${remediationCommand}`,
  ]);
  // Single-line, grep-able, machine-readable marker on stdout.
  console.log(`STYLE_GUIDE_FIXTURE_FLOW_DB_SKIP ${JSON.stringify(skipArtifact)}`);
  // A skip is NOT coverage: fail loudly so it can never be read as a pass.
  process.exit(1);
}

// DATABASE_URL present: run ONLY the style-guide fixture-flow suite against the
// DB. Reuse the @itotori/db runner in --require-database mode so its own honesty
// guard (and the permission verifier) still apply, but scope vitest to the
// fixture-flow file and emit a JSON report we can assert on.
const suiteFilters = fixtureFlowSuites.map((name) => name.replace(/\.test\.ts$/u, ""));
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
    `${gateId}: FAILED — @itotori/db reported a no-DATABASE_URL skip; fixture flow did NOT run.`,
  );
  process.exit(1);
}

if (run.status !== 0) {
  console.error(
    `${gateId}: FAILED — style-guide fixture-flow DB test run exited ${run.status ?? "null"}.`,
  );
  process.exit(run.status ?? 1);
}

// Parse the machine-readable vitest report and PROVE the fixture-flow suite
// actually executed tests. Zero tests, a missing suite, a skipped test, or any
// failure is a hard error — skipped != covered.
const report = await readJsonIfPresent(resultsPath);
if (!report || !Array.isArray(report.testResults)) {
  console.error(`${gateId}: FAILED — missing/unreadable vitest report at ${resultsPath}.`);
  process.exit(1);
}

const perSuite = [];
const problems = [];
for (const suite of fixtureFlowSuites) {
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
    `${gateId}: STYLE-GUIDE FIXTURE-FLOW DB COVERAGE NOT PROVEN`,
    ...problems.map((p) => `- ${p}`),
    "a skipped / zero-test outcome is NOT persistence coverage",
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
  fixtureFlowCovered: true,
  totalTests,
  suites: perSuite,
  timestamp: new Date().toISOString(),
};
await writeFile(proofArtifactPath, `${JSON.stringify(proof, null, 2)}\n`);

printBanner([
  `${gateId}: STYLE-GUIDE FIXTURE-FLOW DB COVERAGE PROVEN`,
  `contract:         ${contractId} style-guide fixture-flow persistence`,
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
