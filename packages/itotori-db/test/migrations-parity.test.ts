import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { migrations } from "../src/migrations.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "migrations");

describe("migrations registration parity", () => {
  it("every .sql file under migrations/ is registered in migrations.ts", () => {
    const onDisk = readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const registered = migrations.map((m) => m.file).sort();
    expect(onDisk).toEqual(registered);
  });

  it("every entry in migrations.ts points at a file that exists", () => {
    const onDisk = new Set(readdirSync(migrationsDir));
    const missing = migrations.filter((m) => !onDisk.has(m.file));
    expect(missing).toEqual([]);
  });

  it("every entry's id matches the filename without .sql", () => {
    const mismatched = migrations.filter(
      (m) => `${m.id}.sql` !== m.file,
    );
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
