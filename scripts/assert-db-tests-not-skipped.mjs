#!/usr/bin/env node
// ITOTORI-121 honesty gate. FAILS (non-zero) when the @itotori/db repository
// test runner recorded a no-DATABASE_URL skip marker, so "I validated the DB
// layer" can only be asserted when the DB-backed tests actually ran. A missing
// marker means no skip was recorded (the tests ran, or were never invoked in
// skip mode); this script is meant to run immediately AFTER the DB test lane.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skipReportPath = path.join(repoRoot, ".tmp/itotori-db/no-database-skipped.json");

let raw;
try {
  raw = await readFile(skipReportPath, "utf8");
} catch (error) {
  if (error && error.code === "ENOENT") {
    console.log("db-tests-not-skipped: OK (no skip marker present)");
    process.exit(0);
  }
  throw error;
}

let report;
try {
  report = JSON.parse(raw);
} catch {
  console.error(`db-tests-not-skipped: FAILED — unreadable skip marker at ${skipReportPath}`);
  process.exit(1);
}

console.error("=".repeat(72));
console.error("  DB-BACKED REPOSITORY TESTS WERE SKIPPED — DB LAYER NOT VALIDATED");
console.error(`  package:         ${report.package ?? "@itotori/db"}`);
console.error(`  required env:    ${report.requiredEnv ?? "DATABASE_URL"}`);
console.error(`  skipped suites:  ${report.skippedSuiteCount ?? "unknown"}`);
console.error(`  reason:          ${report.reason ?? "unknown"}`);
console.error(`  remediation:     ${report.remediationCommand ?? "set DATABASE_URL and rerun"}`);
console.error(`  marker:          ${path.relative(repoRoot, skipReportPath)}`);
console.error("=".repeat(72));
process.exit(1);
