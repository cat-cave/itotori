/**
 * Migration identity and discovery.
 *
 * Apply order is lexicographic on the full migration id (filename without
 * `.sql`). Two id shapes are accepted:
 *
 * - Legacy sequential: `NNNN_slug` (four decimal digits). Historical only;
 *   concurrent authors MUST NOT mint new sequential ordinals — they collide
 *   silently under git merge.
 * - Stamp: `YYYYMMDDHHmmssxxxx_slug` (14 decimal digits of UTC wall time plus
 *   4 lowercase hex entropy). Collision-free under concurrent authorship at
 *   the 40-agent fan-out scale; still lexicographically ordered by time.
 *
 * Limit (enforced by scripts/migration-ordinal-guard.mjs and by loaders here):
 * exactly one migration file per ordinal prefix. The prefix is the token before
 * the first `_` in the filename.
 */

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { migrationLegacyIds } from "./migration-legacy-ids.js";

/** Legacy sequential ordinal: four decimal digits. */
export const LEGACY_ORDINAL_PATTERN = /^\d{4}$/u;

/**
 * Stamp ordinal: UTC `YYYYMMDDHHmmss` (14 digits) + 4 lowercase hex entropy.
 * Entropy keeps same-second concurrent authors from colliding.
 */
export const STAMP_ORDINAL_PATTERN = /^\d{14}[0-9a-f]{4}$/u;

/** Full migration filename (with `.sql`). */
export const MIGRATION_FILENAME_PATTERN =
  /^(?<ordinal>(?:\d{4}|\d{14}[0-9a-f]{4}))_(?<slug>[a-z][a-z0-9_]*)\.sql$/u;

export type MigrationEntry = {
  readonly id: string;
  readonly file: string;
  readonly ordinal: string;
  readonly slug: string;
  readonly legacyIds?: readonly string[];
};

export type ParsedMigrationName = {
  readonly file: string;
  readonly id: string;
  readonly ordinal: string;
  readonly slug: string;
};

export function defaultMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "migrations");
}

export function parseMigrationFilename(file: string): ParsedMigrationName | null {
  const match = MIGRATION_FILENAME_PATTERN.exec(file);
  if (match === null || match.groups === undefined) return null;
  const { ordinal, slug } = match.groups;
  if (ordinal === undefined || slug === undefined) return null;
  return {
    file,
    id: `${ordinal}_${slug}`,
    ordinal,
    slug,
  };
}

/**
 * Discover migration entries from a directory.
 *
 * Apply order is the lexicographic sort of filenames (equivalently of ids).
 * Throws on invalid names or duplicate ordinal prefixes — the same limit the
 * tier-0 ordinal guard enforces.
 */
export function loadMigrationEntries(
  migrationsDir: string = defaultMigrationsDir(),
): MigrationEntry[] {
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  if (files.length === 0) {
    throw new Error(`no migration SQL files found in ${migrationsDir}`);
  }

  const byOrdinal = new Map<string, string[]>();
  const entries: MigrationEntry[] = [];

  for (const file of files) {
    const parsed = parseMigrationFilename(file);
    if (parsed === null) {
      throw new Error(
        `invalid migration filename ${file}: expected NNNN_slug.sql (legacy) or YYYYMMDDHHmmssxxxx_slug.sql (stamp)`,
      );
    }
    const existing = byOrdinal.get(parsed.ordinal);
    if (existing === undefined) {
      byOrdinal.set(parsed.ordinal, [file]);
    } else {
      existing.push(file);
    }

    const legacyIds = migrationLegacyIds[parsed.id];
    entries.push(
      legacyIds === undefined
        ? {
            id: parsed.id,
            file: parsed.file,
            ordinal: parsed.ordinal,
            slug: parsed.slug,
          }
        : {
            id: parsed.id,
            file: parsed.file,
            ordinal: parsed.ordinal,
            slug: parsed.slug,
            legacyIds,
          },
    );
  }

  const duplicates = [...byOrdinal.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([ordinal, names]) => `ordinal ${ordinal}: ${names.join(", ")}`)
    .sort();
  if (duplicates.length > 0) {
    throw new Error(
      [
        "duplicate migration ordinal prefixes (exactly one file per ordinal):",
        ...duplicates.map((line) => `  - ${line}`),
      ].join("\n"),
    );
  }

  return entries;
}

/**
 * Allocate a stamp ordinal: UTC wall time + 4 hex entropy.
 * Coordination-free: concurrent callers virtually never collide.
 */
export function allocateStampOrdinal(now: Date = new Date(), entropyHex: string): string {
  if (!/^[0-9a-f]{4}$/u.test(entropyHex)) {
    throw new Error(`stamp entropy must be 4 lowercase hex digits, got ${entropyHex}`);
  }
  const year = String(now.getUTCFullYear()).padStart(4, "0");
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const hour = String(now.getUTCHours()).padStart(2, "0");
  const minute = String(now.getUTCMinutes()).padStart(2, "0");
  const second = String(now.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}${hour}${minute}${second}${entropyHex}`;
}

export function migrationFilename(ordinal: string, slug: string): string {
  if (!LEGACY_ORDINAL_PATTERN.test(ordinal) && !STAMP_ORDINAL_PATTERN.test(ordinal)) {
    throw new Error(`invalid migration ordinal ${ordinal}`);
  }
  if (!/^[a-z][a-z0-9_]*$/u.test(slug)) {
    throw new Error(`invalid migration slug ${slug}: use lowercase [a-z][a-z0-9_]*`);
  }
  return `${ordinal}_${slug}.sql`;
}
