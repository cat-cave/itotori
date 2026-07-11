import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ENGINE_CAPABILITY_LEVELS,
  type EngineCapabilityMatrixDocument,
  assertEngineCapabilityMatrixDocument,
  rowExtractsOrPatches,
} from "../src/services/engine-capability-matrix.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const artifactPath = resolve(
  repoRoot,
  "apps/itotori/src/engine-capability/engine-capability-matrix.v0.1.json",
);

function loadCommitted(): EngineCapabilityMatrixDocument {
  const value: unknown = JSON.parse(readFileSync(artifactPath, "utf8"));
  assertEngineCapabilityMatrixDocument(value);
  return value;
}

describe("generated engine capability matrix (typed)", () => {
  const matrix = loadCommitted();

  it("conforms to the typed schema and declares six capability levels", () => {
    expect(matrix.capabilityLevels).toEqual([...ENGINE_CAPABILITY_LEVELS]);
    expect(matrix.rows.length).toBeGreaterThan(0);
  });

  it("mechanically distinguishes positive adapters from readiness-only profiles", () => {
    for (const row of matrix.rows) {
      if (row.evidencePosture === "positive_adapter") {
        // A positive adapter must actually extract or patch.
        expect(rowExtractsOrPatches(row)).toBe(true);
        // ...and that evidence must come from an adapter registry / claimed
        // support tuple, never a detector profile or detection summary.
        expect(
          row.evidence.some(
            (e) => e.kind === "adapter_registry" || e.category === "claimed_support_tuples",
          ),
        ).toBe(true);
      } else {
        // Readiness-only rows never claim patch support.
        expect(row.levels.patch.status).not.toBe("supported");
      }
    }
    const positives = matrix.rows.filter((r) => r.evidencePosture === "positive_adapter");
    expect(positives.map((r) => r.engineFamily)).toEqual(["synthetic_fixture"]);
  });

  it("excludes RenPy as a Japanese-opportunity driver", () => {
    expect(matrix.rows.some((r) => r.engineFamily === "renpy")).toBe(false);
    expect(matrix.exclusions.some((e) => e.engineFamily === "renpy")).toBe(true);
  });

  it("represents KiriKiri breadth via XP3 readiness, not plaintext-only support", () => {
    const kirikiri = matrix.rows.filter((r) => r.engineFamily === "kiri_kiri_xp3");
    expect(kirikiri.length).toBeGreaterThanOrEqual(3);
    for (const row of kirikiri) {
      expect(row.levels.extract.status).toBe("unsupported");
      expect(row.levels.patch.status).toBe("unsupported");
      expect(row.scenario).toMatch(/xp3-/);
    }
  });

  it("represents BGI as readiness evidence without parser or patch claims", () => {
    const bgi = matrix.rows.find((r) => r.engineFamily === "bgi_ethornell");
    expect(bgi).toBeDefined();
    expect(bgi?.evidencePosture).toBe("readiness_only");
    expect(bgi?.levels.extract.status).toBe("unsupported");
    expect(bgi?.levels.patch.status).toBe("unsupported");
  });

  it("surfaces the four required encrypted/known-key scenario rows", () => {
    const rowIds = new Set(matrix.rows.map((r) => r.rowId));
    for (const required of [
      "rpg-maker-mv-mz-encrypted-media",
      "siglus-known-key-scene-gameexe-smoke",
      "kirikiri-xp3-encrypted-crypt-smoke",
      "wolf-rpg-editor-encrypted-archive-smoke",
    ]) {
      expect(rowIds.has(required)).toBe(true);
    }
  });

  it("records the MV/MZ www/data text patchback as a demonstrated (readiness) capability", () => {
    // The localize-live `--engine rpg-maker-mv-mz` pipeline now dispatches to
    // `kaifuu patch --engine rpgmaker` (byte-surgical www/data patchback +
    // `.kaifuu` delta round-trip). The matrix reflects this as a validation-
    // artifact row: extract/patch = partial (demonstrated, not registry-exposed),
    // never promoted to a positive adapter or patch=supported.
    const row = matrix.rows.find((r) => r.rowId === "rpg-maker-mv-mz-data-text-patchback");
    expect(row).toBeDefined();
    expect(row?.engineFamily).toBe("rpg_maker_mv_mz");
    expect(row?.scenario).toBe("data-text-patchback");
    expect(row?.evidencePosture).toBe("readiness_only");
    expect(row?.levels.extract.status).toBe("partial");
    expect(row?.levels.patch.status).toBe("partial");
    // It is a SEPARATE surface from the encrypted-media row.
    const mvmzRows = matrix.rows.filter((r) => r.engineFamily === "rpg_maker_mv_mz");
    expect(mvmzRows.map((r) => r.scenario).sort()).toEqual([
      "data-text-patchback",
      "encrypted-media",
    ]);
  });

  it("rejects a hand-broken document", () => {
    const broken = structuredClone(matrix) as unknown as Record<string, unknown>;
    (broken.rows as EngineCapabilityMatrixDocument["rows"])[0].levels.identify.status =
      "totally-made-up" as never;
    expect(() => assertEngineCapabilityMatrixDocument(broken)).toThrow();
  });
});
