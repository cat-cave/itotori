// Output-scope projection for the workflow.
//
// The source Wiki and localized bible still see the complete game. This pure
// projection is applied only after run policy resolves, immediately before P1
// drafting, so a bounded output tier cannot narrow context or a roster but also
// cannot accidentally draft/finalize an excluded decoded surface.

import { outputScopeIncludesSurface, type OutputScope } from "../run-policy/index.js";
import type { WorkflowScene } from "./types.js";

/** The scenes/units this output tier may write, plus the visibly recorded units
 * it deliberately excluded. Empty scenes are omitted because they have no P1
 * work; their context was still available before this projection. */
export interface OutputScopeProjection {
  readonly scenes: readonly WorkflowScene[];
  readonly excludedUnitIds: readonly string[];
}

/** Bound workflow writes to the independently selected output scope. The input
 * scenes are never mutated and their original order is retained. */
export function projectOutputScope(
  scenes: readonly WorkflowScene[],
  outputScope: OutputScope,
): OutputScopeProjection {
  const excludedUnitIds: string[] = [];
  const scopedScenes = scenes.flatMap((scene) => {
    const units = scene.units.filter((unit) => {
      // Legacy deterministic fixtures predate output tiers; their units are
      // dialogue. Production projection always supplies the decode surface.
      const included = outputScopeIncludesSurface(outputScope, unit.surfaceKind ?? "dialogue");
      if (!included) excludedUnitIds.push(unit.unitId);
      return included;
    });
    return units.length === 0 ? [] : [{ ...scene, units }];
  });
  return { scenes: scopedScenes, excludedUnitIds };
}
