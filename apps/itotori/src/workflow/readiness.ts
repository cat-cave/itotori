// Wiki + bible readiness — the first gate, before any line is drafted.
//
// The driver will not draft a unit until the source wiki and the localized bible
// are ready FOR THAT UNIT. Readiness is resolved through the bible port (which
// composes the ground-truth resolver: a missing required entry is a block, never
// an ad-hoc fallback). A blocked unit raises `WorkflowReadinessError` naming the
// missing entries; drafting never proceeds for a scene with a blocked unit.

import type { BibleReadinessPort } from "./ports.js";
import type { UnitBibleBinding } from "../localized-wiki/ground-truth/index.js";
import { WorkflowReadinessError, type WorkflowScene } from "./types.js";

/** The resolved bible bindings for a ready scene — the rendering ids each unit's
 * draft must cite, keyed by unit id. */
export interface SceneReadiness {
  readonly bibleRenderingIdsByUnit: ReadonlyMap<string, readonly string[]>;
  /** The real resolver's bindings. Optional legacy/fake ports remain usable for
   * workflow-only tests, but the composed production port always supplies one. */
  readonly bibleBindingsByUnit: ReadonlyMap<string, UnitBibleBinding>;
}

/**
 * Resolve readiness for every unit in a scene BEFORE the scene is drafted. The
 * first unit whose required bible entries are not installed blocks the whole
 * scene with a `WorkflowReadinessError` — the driver cannot draft a line without
 * its grounded bible. On success it returns the rendering ids each unit cites.
 */
export async function resolveSceneReadiness(
  scene: WorkflowScene,
  port: BibleReadinessPort,
): Promise<SceneReadiness> {
  const bibleRenderingIdsByUnit = new Map<string, readonly string[]>();
  const bibleBindingsByUnit = new Map<string, UnitBibleBinding>();
  for (const unit of scene.units) {
    const readiness = await port.resolve(unit.unitId);
    if (!readiness.ready) {
      throw new WorkflowReadinessError(unit.unitId, readiness.missing);
    }
    bibleRenderingIdsByUnit.set(unit.unitId, readiness.bibleRenderingIds);
    if (readiness.bibleBinding !== undefined) {
      bibleBindingsByUnit.set(unit.unitId, readiness.bibleBinding);
    }
  }
  return { bibleRenderingIdsByUnit, bibleBindingsByUnit };
}
