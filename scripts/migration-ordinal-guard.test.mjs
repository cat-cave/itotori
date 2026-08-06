// @itotori-meta-check
// Regression suite for the migration ordinal uniqueness CI guard.
//
// Proves: duplicate ordinals fail, invalid shapes fail, unique legacy + stamp
// mixes pass, and the stated limit is present in the failure report.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateMigrationOrdinals,
  formatMigrationOrdinalReport,
  parseMigrationFile,
} from "./migration-ordinal-guard.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "migration-ordinal-guard.mjs");

test("parseMigrationFile accepts legacy and stamp shapes", () => {
  assert.deepEqual(parseMigrationFile("0121_llm_provider_budget_run_share.sql"), {
    file: "0121_llm_provider_budget_run_share.sql",
    ordinal: "0121",
    slug: "llm_provider_budget_run_share",
  });
  assert.deepEqual(parseMigrationFile("20260805143022a3f1_add_widget.sql"), {
    file: "20260805143022a3f1_add_widget.sql",
    ordinal: "20260805143022a3f1",
    slug: "add_widget",
  });
});

test("parseMigrationFile rejects invalid shapes", () => {
  assert.ok("error" in parseMigrationFile("0122_Fanout.sql"));
  assert.ok("error" in parseMigrationFile("122_too_short.sql"));
  assert.ok("error" in parseMigrationFile("20260805143022_missing_entropy.sql"));
  assert.ok("error" in parseMigrationFile("not_a_migration.sql"));
});

test("duplicate ordinal prefixes fail with the stated limit", () => {
  const result = evaluateMigrationOrdinals({
    files: ["0122_fanout_test_1.sql", "0122_fanout_test_2.sql", "0121_prior.sql"],
  });
  assert.equal(result.ok, false);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0].ordinal, "0122");
  assert.deepEqual(result.duplicates[0].files, [
    "0122_fanout_test_1.sql",
    "0122_fanout_test_2.sql",
  ]);
  const report = formatMigrationOrdinalReport(result);
  assert.match(report, /exactly one migration SQL file per ordinal prefix/u);
  assert.match(report, /0122_fanout_test_1\.sql/u);
  assert.match(report, /0122_fanout_test_2\.sql/u);
});

test("unique legacy and stamp ordinals pass", () => {
  const result = evaluateMigrationOrdinals({
    files: ["0121_prior.sql", "20260805143022a3f1_agent_a.sql", "20260805143022b4c2_agent_b.sql"],
  });
  assert.equal(result.ok, true);
  assert.equal(result.duplicates.length, 0);
  assert.equal(result.invalid.length, 0);
});

test("invalid filenames fail closed", () => {
  const result = evaluateMigrationOrdinals({
    files: ["0121_ok.sql", "bad-name.sql"],
  });
  assert.equal(result.ok, false);
  assert.equal(result.invalid.length, 1);
  assert.match(result.invalid[0], /bad-name\.sql/u);
});

test("CLI fails on a directory that reproduces the silent git-merge collision", () => {
  const dir = mkdtempSync(join(tmpdir(), "mig-ordinal-"));
  writeFileSync(join(dir, "0121_prior.sql"), "-- prior\n");
  writeFileSync(join(dir, "0122_fanout_test_1.sql"), "-- a\n");
  writeFileSync(join(dir, "0122_fanout_test_2.sql"), "-- b\n");

  let failed = false;
  let stderr = "";
  try {
    execFileSync(process.execPath, [scriptPath, "--migrations-dir", dir], {
      encoding: "utf8",
    });
  } catch (error) {
    failed = true;
    stderr = String(error.stderr ?? "");
  }
  assert.equal(failed, true);
  assert.match(stderr, /duplicate ordinal prefixes/u);
  assert.match(stderr, /0122/u);
});

test("CLI passes on the repository migrations directory", () => {
  const stdout = execFileSync(process.execPath, [scriptPath], { encoding: "utf8" });
  assert.match(stdout, /^migration ordinal guard:/u);
  assert.match(stdout, /\bok:/u);
});
