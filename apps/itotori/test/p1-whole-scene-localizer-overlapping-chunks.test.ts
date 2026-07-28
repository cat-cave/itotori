import { describe, expect, it } from "vitest";
import type { DraftBatch } from "../src/contracts/index.js";
import {
  assembleFinalizedDrafts,
  assertExactAgainstSource,
  buildLocalizerCall,
  localizeScene,
  MAX_P1_CORE_UNITS_PER_REQUEST,
  normalizeScene,
  planSceneLocalization,
  FinalizeError,
} from "../src/roles/p1/index.js";
import { specialistFor } from "../src/roster/index.js";
import {
  BASE,
  BIBLE,
  CTX,
  LOC,
  SCHEMA,
  chunkBatch,
  draftBatchResponse,
  pad,
  recordedRuntime,
  unitFact,
  wholeSceneBatch,
  type Captured,
} from "./p1-whole-scene-localizer-test-support.js";

describe("P1 whole-scene localizer — overlapping-chunk mode", () => {
  const units = [0, 1, 2, 3, 4, 5].map((index) =>
    unitFact(index, { skeleton: pad(`c${index}`, 10) }),
  );
  const sceneId = "6010";

  it("chunks only when the measured limit requires it and cores partition the scene exactly", () => {
    const scene = normalizeScene(units);
    const plan = planSceneLocalization(scene, { budgetBytes: 40, overlapUnits: 1 });
    expect(plan.mode).toBe("overlapping-chunks");
    const chunks = plan.segments.filter((s) => s.mode === "overlapping-chunk");
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    // The cores COVER every unit exactly once, in play order (a partition).
    const cores = chunks.flatMap((s) => (s.mode === "overlapping-chunk" ? s.coreUnitIds : []));
    expect(cores).toEqual(units.map((u) => u.value.unitId));
    // Cores are pairwise DISJOINT (no unit appears in two cores).
    expect(new Set(cores).size).toBe(cores.length);
    // Overlap regions are context only — never part of any core.
    for (const s of chunks) {
      if (s.mode !== "overlapping-chunk") continue;
      const coreSet = new Set(s.coreUnitIds);
      expect(s.overlapUnitIds.some((id) => coreSet.has(id))).toBe(false);
      // Every dispatched prompt window stays within the measured budget.
      const promptBytes = s.promptUnitIds.reduce(
        (sum, id) =>
          sum + Buffer.byteLength(scene.units.find((u) => u.unitId === id)!.sourceSkeleton, "utf8"),
        0,
      );
      expect(promptBytes).toBeLessThanOrEqual(40);
    }
  });

  it("bounds short-unit scenes by recovery-unit count, not source bytes alone", () => {
    expect(MAX_P1_CORE_UNITS_PER_REQUEST).toBe(24);
    const shortUnits = Array.from({ length: 49 }, (_, index) =>
      unitFact(index, { skeleton: `s${index}` }),
    );
    const plan = planSceneLocalization(normalizeScene(shortUnits), {
      budgetBytes: 100_000,
      overlapUnits: 1,
    });
    const chunks = plan.segments.filter((segment) => segment.mode === "overlapping-chunk");

    expect(plan.mode).toBe("overlapping-chunks");
    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.coreUnitIds.length <= 24)).toBe(true);
    expect(chunks.flatMap((chunk) => chunk.coreUnitIds)).toEqual(
      shortUnits.map((unit) => unit.value.unitId),
    );
  });

  it("finalizes ONLY non-overlap cores and continues the thread with prior accepted target", async () => {
    const scene = normalizeScene(units);
    const plan = planSceneLocalization(scene, { budgetBytes: 40, overlapUnits: 1 });
    const chunkSegs = plan.segments.filter((s) => s.mode === "overlapping-chunk");
    const responses = chunkSegs.map((s) =>
      s.mode === "overlapping-chunk"
        ? draftBatchResponse(
            chunkBatch(sceneId, units, s.coreUnitIds, s.overlapUnitIds, s.chunkIndex, s.chunkCount),
          )
        : draftBatchResponse(wholeSceneBatch(sceneId, units)),
    );
    const captured: Captured[] = [];
    const result = await localizeScene(
      { ...BASE, units, bibleRenderingIds: BIBLE, budgetBytes: 40, overlapUnits: 1 },
      recordedRuntime(responses, captured),
    );

    expect(result.mode).toBe("overlapping-chunks");
    // Exactly one finalized draft per source unit — no double-finalize across the
    // overlapping chunks — in source order, with matching hashes.
    expect(result.finalizedDrafts.map((d) => d.unitId)).toEqual(units.map((u) => u.value.unitId));
    expect(new Set(result.finalizedDrafts.map((d) => d.unitId)).size).toBe(units.length);
    expect(() => assertExactAgainstSource(scene.units, result.finalizedDrafts)).not.toThrow();

    // THREAD CONTINUATION: chunk 1's dispatched call carries chunk 0's accepted
    // target forward as an assistant author-thread turn.
    const chunk1 = chunkSegs[1]!;
    const prior = new Map<string, string>();
    for (const id of chunkSegs[0]!.mode === "overlapping-chunk" ? chunkSegs[0]!.coreUnitIds : []) {
      prior.set(id, `EN>${units.find((u) => u.value.unitId === id)!.value.sourceSkeleton}`);
    }
    const call = buildLocalizerCall({
      specialist: specialistFor("P1"),
      segment: chunk1,
      unitsById: new Map(scene.units.map((u) => [u.unitId, u])),
      bibleRenderingIds: BIBLE,
      priorAcceptedTarget: prior,
      contextSnapshotId: CTX,
      localizationSnapshotId: LOC,
      runMode: "test-dev",
      contextScope: "whole-game",
      schemaHash: SCHEMA,
    });
    const threadMessages = call.spec.messages.filter(
      (m) => m.kind === "text" && m.role === "assistant",
    );
    expect(threadMessages).toHaveLength(1);
    const threadRef =
      threadMessages[0]!.kind === "text" ? threadMessages[0]!.contentEncrypted.storageRef : "";
    const threadText = call.payloads.get(threadRef)!;
    const leadingOverlap =
      chunk1.mode === "overlapping-chunk"
        ? chunk1.overlapUnitIds.filter((id) => prior.has(id))
        : [];
    expect(leadingOverlap.length).toBeGreaterThan(0);
    for (const id of leadingOverlap) {
      expect(threadText).toContain(
        `EN>${units.find((u) => u.value.unitId === id)!.value.sourceSkeleton}`,
      );
    }
  });

  it("rejects a batch that would finalize an overlap (context) unit — no double-finalize", () => {
    const scene = normalizeScene(units);
    const plan = planSceneLocalization(scene, { budgetBytes: 40, overlapUnits: 1 });
    const segs = plan.segments;
    const forged = segs.map((s, index) => {
      if (s.mode !== "overlapping-chunk") return wholeSceneBatch(sceneId, units);
      // Chunk 0 illegally emits a draft for a trailing OVERLAP unit as if it were core.
      const coreIds = index === 0 ? [...s.coreUnitIds, s.overlapUnitIds[0]!] : s.coreUnitIds;
      return chunkBatch(sceneId, units, coreIds, s.overlapUnitIds, s.chunkIndex, s.chunkCount);
    });
    // The forged chunk-0 batch is itself invalid (core/overlap not disjoint) — build
    // it directly to exercise the finalize guard on a well-formed-but-wrong batch.
    const guarded = segs.map((s) =>
      s.mode === "overlapping-chunk"
        ? chunkBatch(sceneId, units, s.coreUnitIds, s.overlapUnitIds, s.chunkIndex, s.chunkCount)
        : wholeSceneBatch(sceneId, units),
    );
    // Move a core unit's draft into an earlier chunk's drafts → double-finalize.
    const clash = guarded.map((b) => ({ ...b }) as DraftBatch);
    (clash[0]!.drafts as unknown[]).push(clash[1]!.drafts[0]!);
    expect(() => assembleFinalizedDrafts(plan.segments, clash)).toThrow(FinalizeError);
    void forged;
  });
});
