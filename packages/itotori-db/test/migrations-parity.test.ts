// @itotori-meta-check
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";

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
  it("keeps migration registration and split public facades available", () => {
    const onDisk = readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const registered = migrations.map((m) => m.file).sort();
    expect(onDisk).toEqual(registered);
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

  it("every entry in migrations.ts points at a file that exists", () => {
    const onDisk = new Set(readdirSync(migrationsDir));
    const missing = migrations.filter((m) => !onDisk.has(m.file));
    expect(missing).toEqual([]);
  });

  it("every entry's id matches the filename without .sql", () => {
    const mismatched = migrations.filter((m) => `${m.id}.sql` !== m.file);
    expect(mismatched).toEqual([]);
  });

  it("ids are strictly increasing by numeric prefix", () => {
    const numericPrefixes = migrations.map((m) => {
      const match = /^(\d{4})_/.exec(m.id);
      expect(match, `migration id ${m.id} must start with NNNN_`).not.toBeNull();
      return Number.parseInt(match![1]!, 10);
    });
    for (let i = 1; i < numericPrefixes.length; i++) {
      expect(
        numericPrefixes[i]! > numericPrefixes[i - 1]!,
        `migration ${migrations[i]!.id} prefix must be greater than ${migrations[i - 1]!.id}`,
      ).toBe(true);
    }
  });
});
