#!/usr/bin/env node
// @itotori-meta-check
// CI guard: migration ordinal uniqueness.
//
// LIMIT (stated explicitly — this is the whole point of the guard):
//   Exactly one migration SQL file may claim each ordinal prefix.
//   The ordinal is the token before the first `_` in the filename:
//     - legacy sequential: four decimal digits (`0121`)
//     - stamp (preferred for new work): 14-digit UTC `YYYYMMDDHHmmss` +
//       4 lowercase hex entropy (`20260805143022a3f1`)
//   Two files sharing an ordinal (e.g. `0122_a.sql` and `0122_b.sql`) is a
//   hard failure. Git cannot catch this: different basenames merge cleanly.
//
// Additional checks:
//   - Every `*.sql` filename must match the legacy or stamp pattern.
//   - Filenames must be unique (filesystem already enforces this).
//
// Exit codes: 0 = clean; 1 = violation.
// Wired into `just ci tier0-meta` (test then run) so a silent ordinal
// collision blocks the merge rather than landing as advisory noise.

import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
export const DEFAULT_MIGRATIONS_DIR = join(repoRoot, "packages", "itotori-db", "migrations");

/** Legacy: NNNN_slug.sql */
export const LEGACY_FILENAME = /^(?<ordinal>\d{4})_(?<slug>[a-z][a-z0-9_]*)\.sql$/u;
/** Stamp: YYYYMMDDHHmmssxxxx_slug.sql */
export const STAMP_FILENAME = /^(?<ordinal>\d{14}[0-9a-f]{4})_(?<slug>[a-z][a-z0-9_]*)\.sql$/u;

/**
 * @param {string} file
 * @returns {{ file: string, ordinal: string, slug: string } | { file: string, error: string }}
 */
export function parseMigrationFile(file) {
  const legacy = LEGACY_FILENAME.exec(file);
  if (legacy?.groups?.ordinal !== undefined && legacy.groups.slug !== undefined) {
    return { file, ordinal: legacy.groups.ordinal, slug: legacy.groups.slug };
  }
  const stamp = STAMP_FILENAME.exec(file);
  if (stamp?.groups?.ordinal !== undefined && stamp.groups.slug !== undefined) {
    return { file, ordinal: stamp.groups.ordinal, slug: stamp.groups.slug };
  }
  return {
    file,
    error:
      "invalid filename: expected NNNN_slug.sql (legacy) or YYYYMMDDHHmmssxxxx_slug.sql (stamp)",
  };
}

/**
 * Evaluate a directory of migration SQL files for ordinal uniqueness and
 * filename shape. Pure: does not touch the filesystem beyond the provided list
 * when `files` is passed.
 *
 * @param {{ files?: string[], migrationsDir?: string }} [options]
 */
export function evaluateMigrationOrdinals(options = {}) {
  const migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const files =
    options.files ??
    readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort();

  /** @type {string[]} */
  const invalid = [];
  /** @type {Map<string, string[]>} */
  const byOrdinal = new Map();

  for (const file of files) {
    const parsed = parseMigrationFile(file);
    if ("error" in parsed) {
      invalid.push(`${file}: ${parsed.error}`);
      continue;
    }
    const bucket = byOrdinal.get(parsed.ordinal);
    if (bucket === undefined) byOrdinal.set(parsed.ordinal, [file]);
    else bucket.push(file);
  }

  const duplicates = [...byOrdinal.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([ordinal, names]) => ({ ordinal, files: names.slice().sort() }))
    .sort((a, b) => (a.ordinal < b.ordinal ? -1 : a.ordinal > b.ordinal ? 1 : 0));

  const ok = invalid.length === 0 && duplicates.length === 0;
  return {
    ok,
    migrationsDir,
    fileCount: files.length,
    invalid,
    duplicates,
    limit:
      "exactly one migration SQL file per ordinal prefix (legacy NNNN or stamp YYYYMMDDHHmmssxxxx)",
  };
}

/**
 * @param {ReturnType<typeof evaluateMigrationOrdinals>} result
 */
export function formatMigrationOrdinalReport(result) {
  const lines = [
    `migration ordinal guard: ${result.fileCount} file(s) under ${result.migrationsDir}`,
    `limit: ${result.limit}`,
  ];
  if (result.ok) {
    lines.push("ok: all ordinal prefixes are unique and filenames match the accepted shapes");
    return lines.join("\n");
  }
  if (result.invalid.length > 0) {
    lines.push("invalid filenames:");
    for (const row of result.invalid) lines.push(`  - ${row}`);
  }
  if (result.duplicates.length > 0) {
    lines.push("duplicate ordinal prefixes:");
    for (const row of result.duplicates) {
      lines.push(`  - ordinal ${row.ordinal}: ${row.files.join(", ")}`);
    }
  }
  return lines.join("\n");
}

function main(argv) {
  const args = argv.slice(2);
  let migrationsDir = DEFAULT_MIGRATIONS_DIR;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--migrations-dir") {
      const value = args[i + 1];
      if (value === undefined) {
        process.stderr.write("migration-ordinal-guard: --migrations-dir requires a path\n");
        process.exit(2);
      }
      migrationsDir = resolve(value);
      i += 1;
    } else {
      process.stderr.write(`migration-ordinal-guard: unknown argument ${args[i]}\n`);
      process.exit(2);
    }
  }

  const result = evaluateMigrationOrdinals({ migrationsDir });
  const report = formatMigrationOrdinalReport(result);
  if (result.ok) {
    process.stdout.write(`${report}\n`);
    process.exit(0);
  }
  process.stderr.write(`${report}\n`);
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv);
}
