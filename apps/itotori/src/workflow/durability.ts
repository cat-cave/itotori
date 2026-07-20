// Durability — restart-queries-missing, coherence-only serialization, and the
// physical-attempt lineage.
//
// Three guarantees live here:
//   1. On restart the driver QUERIES which artifacts are absent and produces
//      ONLY those — it never re-runs completed work. `missingStageUnits` asks the
//      store's per-unit head (a `null` head is the "must produce" signal).
//   2. It serializes ONLY coherence-dependent threads: units in one scene share
//      the author thread and form a serial chain; distinct scenes are independent
//      and run in parallel. `coherenceSchedule` states that partition.
//   3. Every physical attempt is counted in the lineage — the memo store records
//      one attempt per producer call (including a counted transient retry). The
//      driver drives every model step through `store.runMemoizedStep`, so a
//      restart hit is skipped and no retry is silent.

import type { UnitStage, WorkflowScene } from "./types.js";
import type { WorkflowArtifactStore } from "./ports.js";

/** Query which of the given units still lack a finalized head at a stage — the
 * restart seam. Returns the absent unit ids in input order; a present head means
 * the unit is already done and is omitted, so the driver produces only the gap. */
export async function missingStageUnits(
  store: WorkflowArtifactStore,
  unitIds: readonly string[],
  stage: UnitStage,
): Promise<readonly string[]> {
  const heads = await Promise.all(
    unitIds.map(async (unitId) => ({ unitId, head: await store.readUnitHead(unitId, stage) })),
  );
  return heads.flatMap(({ unitId, head }) => (head === null ? [unitId] : []));
}

/** The coherence partition of a run's work: one serial chain per scene (its
 * ordered units), and the scenes themselves as independent parallel work. */
export interface CoherenceSchedule {
  /** Ordered unit-id chains — each MUST run serially to keep the author thread
   * coherent. */
  readonly serialChains: readonly (readonly string[])[];
  /** The independent scene ids that may run in parallel. */
  readonly parallelScenes: readonly string[];
}

/**
 * Partition a run's scenes into coherence-dependent serial chains (a scene's
 * units) and independent parallel work (distinct scenes). This is the schedule
 * the driver honours: serialize exactly the coherence-dependent threads, and
 * keep everything else parallel.
 */
export function coherenceSchedule(scenes: readonly WorkflowScene[]): CoherenceSchedule {
  return {
    serialChains: scenes.map((scene) => scene.units.map((unit) => unit.unitId)),
    parallelScenes: scenes.map((scene) => scene.sceneId),
  };
}
