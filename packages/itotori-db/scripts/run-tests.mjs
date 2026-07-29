#!/usr/bin/env node
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

import { databaseRunnerNodeTestFiles } from "./test-file-manifest.mjs";
import { listDbTestFiles } from "../../../scripts/db-results-verify.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const packageRoot = path.join(repoRoot, "packages/itotori-db");
// Machine-readable skip marker. Consumers (automation/CI/honesty gate) parse this
// file to distinguish an intentional no-DATABASE_URL skip from a real DB run.
const skipReportPath = path.join(repoRoot, ".tmp/itotori-db/no-database-skipped.json");
const packageName = "@itotori/db";
const requiredEnv = "DATABASE_URL";
const dbTestCommand = "pnpm --filter @itotori/db test";
// One-line grep-able marker prefix emitted to stdout on skip.
const skipMarkerPrefix = "ITOTORI_DB_TEST_SKIP";
const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const requireDatabase = rawArgs.includes("--require-database");
const vitestArgs = rawArgs.filter((arg) => arg !== "--require-database");

if (!process.env[requiredEnv]) {
  await handleMissingDatabase();
}

runRequiredCommand(
  process.execPath,
  ["--test", path.join(packageRoot, databaseRunnerNodeTestFiles[0])],
  "permission verifier regression tests",
);

runRequiredCommand(
  process.execPath,
  ["--test", path.join(packageRoot, databaseRunnerNodeTestFiles[1])],
  "event queue index alignment regression tests",
);

runRequiredCommand(
  process.execPath,
  [path.join(packageRoot, "scripts/verify-permission-constraints.mjs")],
  "permission verifier",
);

runRequiredCommand(
  process.execPath,
  [path.join(packageRoot, "scripts/verify-event-queue-index-alignment.mjs")],
  "event queue index alignment verifier",
);

async function handleMissingDatabase() {
  const skippedSuites = await discoverDatabaseBackedSuites();
  const skipReport = {
    status: "skipped",
    package: packageName,
    reason: `${requiredEnv} unset`,
    requiredEnv,
    checkedEnv: [requiredEnv],
    skippedSuiteCount: skippedSuites.length,
    skippedSuites,
    command: dbTestCommand,
    remediationCommand:
      "just dev db-up && just dev db-migrate && DATABASE_URL=postgres://itotori:itotori@127.0.0.1:55433/itotori pnpm --filter @itotori/db test:db",
    strictCommand: "just test db",
    timestamp: new Date().toISOString(),
  };

  if (requireDatabase) {
    // Honesty gate: DB-backed repository tests were REQUIRED but DATABASE_URL is
    // absent, so this run did NOT validate the DB layer. Fail loudly (non-zero).
    printBanner([
      `${packageName}: DB-BACKED REPOSITORY TESTS REQUIRED BUT SKIPPED`,
      `required env:     ${requiredEnv} (unset)`,
      `skipped suites:   ${skippedSuites.length}`,
      "this run did NOT validate the DB layer",
      `remediation:      ${skipReport.remediationCommand}`,
    ]);
    emitSkipMarker(skipReport);
    console.error(`${packageName} db tests require ${requiredEnv} for this verification path`);
    process.exit(1);
  }

  // Intentional fast-local skip: keep it working, but make it PROMINENT and
  // machine-readable so nobody mistakes it for DB validation.
  await mkdir(path.dirname(skipReportPath), { recursive: true });
  await writeFile(skipReportPath, `${JSON.stringify(skipReport, null, 2)}\n`);
  printBanner([
    `${packageName}: DB-BACKED REPOSITORY TESTS SKIPPED (fast-local)`,
    `reason:           ${requiredEnv} unset`,
    `skipped suites:   ${skippedSuites.length}`,
    "this run did NOT validate the DB layer",
    `skip report:      ${path.relative(repoRoot, skipReportPath)}`,
    "to validate DB:   just test db",
  ]);
  emitSkipMarker(skipReport);
  process.exit(0);
}

await rm(skipReportPath, { force: true });

const suiteFilters = vitestArgs.filter((arg) => !arg.startsWith("-"));
const suiteArguments =
  suiteFilters.length > 0
    ? vitestArgs
    : (await listDbTestFiles(repoRoot)).map((file) => path.join("test", file));

const child = spawn("vitest", ["run", ...suiteArguments], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

function runRequiredCommand(command, args, label) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
  });

  if (result.error) {
    console.error(`${label} failed to start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

// The DB runner skips every DB-suite file when DATABASE_URL is absent. Report
// that complete set rather than trying to infer which suites touch Postgres.
async function discoverDatabaseBackedSuites() {
  return listDbTestFiles(repoRoot);
}

function emitSkipMarker(skipReport) {
  // Single-line, grep-able, machine-readable marker on stdout.
  console.log(`${skipMarkerPrefix} ${JSON.stringify(skipReport)}`);
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
