// @itotori-meta-check
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  LEGACY_ORDINAL_PATTERN,
  STAMP_ORDINAL_PATTERN,
  parseMigrationFilename,
} from "../src/migration-identity.js";
import { migrations } from "../src/migrations.js";
import { ItotoriProjectRunRepository } from "../src/repositories/project-run-repository.js";
import {
  authAccounts,
  catalogWorks,
  localizationPatchVersions,
  projectRuns,
  terminologyTerms,
} from "../src/schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "migrations");

describe("migrations registration parity", () => {
  it("discovers every on-disk SQL file in lexicographic apply order", () => {
    const onDisk = readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const registered = migrations.map((m) => m.file);
    expect(registered).toEqual(onDisk);
    expect([
      getTableName(catalogWorks),
      getTableName(projectRuns),
      getTableName(terminologyTerms),
      getTableName(authAccounts),
      getTableName(localizationPatchVersions),
    ]).toEqual([
      "itotori_catalog_works",
      "itotori_project_runs",
      "itotori_terminology_terms",
      "itotori_auth_accounts",
      "itotori_localization_patch_versions",
    ]);
    expect(Object.getOwnPropertyNames(ItotoriProjectRunRepository.prototype)).toEqual(
      expect.arrayContaining(["createRun", "loadLiveReadModel", "listDashboardRuns"]),
    );
  });

  it("every entry's id matches the filename without .sql", () => {
    const mismatched = migrations.filter((m) => `${m.id}.sql` !== m.file);
    expect(mismatched).toEqual([]);
  });

  it("every filename parses as legacy sequential or stamp ordinal", () => {
    for (const migration of migrations) {
      const parsed = parseMigrationFilename(migration.file);
      expect(parsed, `migration ${migration.file} must parse`).not.toBeNull();
      expect(parsed!.ordinal).toBe(migration.ordinal);
      const ok =
        LEGACY_ORDINAL_PATTERN.test(migration.ordinal) ||
        STAMP_ORDINAL_PATTERN.test(migration.ordinal);
      expect(ok, `ordinal ${migration.ordinal} must be legacy NNNN or stamp`).toBe(true);
    }
  });

  it("ordinal prefixes are unique (exactly one file per ordinal)", () => {
    const byOrdinal = new Map<string, string[]>();
    for (const migration of migrations) {
      const bucket = byOrdinal.get(migration.ordinal) ?? [];
      bucket.push(migration.file);
      byOrdinal.set(migration.ordinal, bucket);
    }
    const duplicates = [...byOrdinal.entries()].filter(([, files]) => files.length > 1);
    expect(duplicates).toEqual([]);
  });

  it("apply order is strictly lexicographic on migration id", () => {
    for (let i = 1; i < migrations.length; i++) {
      expect(
        migrations[i]!.id > migrations[i - 1]!.id,
        `migration ${migrations[i]!.id} must sort after ${migrations[i - 1]!.id}`,
      ).toBe(true);
    }
  });
});
