import { describe, expect, it } from "vitest";
import {
  assertPlaceholdersPreserved,
  localizeScene,
  normalizeScene,
  FinalizeError,
} from "../src/roles/p1/index.js";
import type { DraftBatch } from "../src/contracts/index.js";
import {
  BASE,
  BIBLE,
  draftBatchResponse,
  installedBibleForUnits,
  recordedRuntime,
  unitFact,
  wholeSceneBatch,
  type Captured,
} from "./p1-whole-scene-localizer-test-support.js";

describe("P1 whole-scene localizer — whole-scene mode", () => {
  it("emits exact cardinality, order, and source hashes for a complete scene", async () => {
    const units = [0, 1, 2, 3].map((index) => unitFact(index));
    const batch = wholeSceneBatch("6010", units, { "unit:6010:2": ["term"] });
    const captured: Captured[] = [];
    const result = await localizeScene(
      {
        ...BASE,
        units,
        bibleRenderingIds: BIBLE,
        unitBible: installedBibleForUnits(units),
        budgetBytes: 10_000,
        overlapUnits: 1,
      },
      recordedRuntime([draftBatchResponse(batch)], captured),
    );

    expect(result.mode).toBe("whole-scene");
    expect(result.plan.segments).toHaveLength(1);
    // EXACT CARDINALITY: one finalized unit per source unit, no more, no fewer.
    expect(result.finalizedDrafts).toHaveLength(units.length);
    // EXACT ORDER + SOURCE HASH: finalized ids/hashes equal the source, in order.
    expect(result.finalizedDrafts.map((d) => d.unitId)).toEqual(units.map((u) => u.value.unitId));
    expect(result.finalizedDrafts.map((d) => d.sourceHash)).toEqual(
      units.map((u) => u.value.sourceHash),
    );
    // TYPED uncertainty surfaces (never a silent guess).
    expect(result.uncertainUnits).toEqual([{ unitId: "unit:6010:2", uncertainty: ["term"] }]);
    // dispatched through the sole ZDR boundary: no provider pin, exact model.
    expect(captured).toHaveLength(1);
    expect(captured[0]?.body).toMatchObject({
      model: "deepseek/deepseek-v4-flash",
      provider: {
        allow_fallbacks: true,
        zdr: true,
        data_collection: "deny",
        require_parameters: true,
      },
    });
    expect(captured[0]?.body).not.toHaveProperty("provider.only");
    expect(captured[0]?.body).not.toHaveProperty("provider.order");
    expect(result.results.every((r) => r.status === "success")).toBe(true);
  });

  it("preserves protected placeholders and rejects a dropped one", () => {
    const placeholders = [{ placeholderId: "ph:0", kind: "variable" as const, sourceText: "%d" }];
    const units = [unitFact(0, { skeleton: "hp {{ph:0}} left", placeholders })];
    const scene = normalizeScene(units);
    const good = wholeSceneBatch("6010", units);
    expect(() => assertPlaceholdersPreserved(scene.units, good.drafts)).not.toThrow();

    const dropped = {
      ...good,
      drafts: [{ ...good.drafts[0]!, targetSkeleton: "hp left" }],
    } as DraftBatch;
    expect(() => assertPlaceholdersPreserved(scene.units, dropped.drafts)).toThrow(FinalizeError);
  });
});
