import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { permissionValues } from "../src/authorization.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "migrations");
const targetMigration = "0054_style_guide_version_changed_outbox_payload_contract.sql";

const annotationPattern = /@permission-gate\s+([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)/giu;

const knownPermissionValues = new Set<string>(Object.values(permissionValues));

function readMigration(name: string): string {
  return readFileSync(join(migrationsDir, name), "utf8");
}

function extractPermissionAnnotations(sql: string): { permission: string; index: number }[] {
  const matches: { permission: string; index: number }[] = [];
  for (const match of sql.matchAll(annotationPattern)) {
    const permission = match[1];
    if (permission === undefined) continue;
    matches.push({ permission: permission.toLowerCase(), index: match.index ?? -1 });
  }
  return matches;
}

describe("migration 0054 permission annotation", () => {
  it("does not name the non-existent draft.read permission in any @permission-gate annotation", () => {
    const sql = readMigration(targetMigration);
    const annotations = extractPermissionAnnotations(sql);
    const draftReadAnnotations = annotations.filter(
      ({ permission }) => permission === "draft.read",
    );
    expect(draftReadAnnotations).toEqual([]);
  });

  it("names only real permissions from permissionValues in its @permission-gate annotations", () => {
    const sql = readMigration(targetMigration);
    const annotations = extractPermissionAnnotations(sql);
    expect(annotations.length).toBeGreaterThan(0);
    for (const { permission } of annotations) {
      expect(
        knownPermissionValues.has(permission),
        `migration ${targetMigration} references unknown permission "${permission}" in @permission-gate annotation; allowed permissions are ${[...knownPermissionValues].join(", ")}`,
      ).toBe(true);
    }
  });
});
