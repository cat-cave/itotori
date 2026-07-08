#!/usr/bin/env node
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const packageRoot = path.join(repoRoot, "packages/itotori-db");
const testDir = path.join(packageRoot, "test");
// Machine-readable skip marker. Consumers (agents/CI/honesty gate) parse this
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

runRequiredCommand(
  process.execPath,
  ["--test", path.join(packageRoot, "scripts/verify-permission-constraints.test.mjs")],
  "permission verifier regression tests",
);

runRequiredCommand(
  process.execPath,
  ["--test", path.join(packageRoot, "scripts/verify-event-queue-index-alignment.test.mjs")],
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

if (!process.env[requiredEnv]) {
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
      "just db-up && just db-migrate && DATABASE_URL=postgres://itotori:itotori@127.0.0.1:55433/itotori pnpm --filter @itotori/db test:db",
    strictCommand: "just test-db-strict",
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
    "to validate DB:   just test-db-strict",
  ]);
  emitSkipMarker(skipReport);
  process.exit(0);
}

await rm(skipReportPath, { force: true });

const child = spawn("vitest", ["run", "--dir", "test", ...vitestArgs], {
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

// Enumerate DB-backed repository test suites so the skip report can carry an
// honest skipped-suite count instead of a vague "tests skipped". A suite is
// DB-backed when it drives the isolated migrated Postgres context or reads
// DATABASE_URL directly.
async function discoverDatabaseBackedSuites() {
  let entries;
  try {
    entries = await readdir(testDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const suites = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".test.ts")) {
      continue;
    }
    let source;
    try {
      source = await readFile(path.join(testDir, entry.name), "utf8");
    } catch {
      continue;
    }
    if (
      source.includes("db-test-context") ||
      source.includes("isolatedMigratedContext") ||
      source.includes("process.env.DATABASE_URL")
    ) {
      suites.push(entry.name);
    }
  }
  return suites.sort();
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
