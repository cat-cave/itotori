// Rerun-only-implicated scoping.
//
// After a correction lands, the pipeline must NOT re-run wholesale. Only the
// review/repair lanes actually implicated by the change re-run, and only over
// the units the change touched. The implicated set is read off the defect
// bundle itself: every defect carries the review lanes and deterministic gates it
// implicates, so the rerun scope for a set of changed units is the union of those
// implications restricted to the changed units. A lane a change did not implicate
// never re-runs; a unit a change did not touch is never re-reviewed.

import type { DefectBundle } from "../contracts/index.js";
import type { DeterministicGate } from "../gates/contract-types.js";
import type { ReviewLane } from "./types.js";

/** The scoped rerun after a correction — exactly the implicated lanes/gates over
 * exactly the changed units. Empty when nothing was implicated. */
export interface RerunScope {
  readonly unitIds: readonly string[];
  readonly lanes: readonly ReviewLane[];
  readonly gates: readonly DeterministicGate[];
}

function sortedUnique<T>(values: Iterable<T>): readonly T[] {
  return [...new Set(values)].sort((left, right) => (String(left) < String(right) ? -1 : 1));
}

/**
 * Compute the rerun scope implicated by a correction. Restricting the bundle to
 * the changed units, collect the review lanes and deterministic gates those
 * units' defects implicate. The result re-runs ONLY those lanes/gates over ONLY
 * those units — never the whole pipeline, never an unimplicated lane.
 */
export function implicatedRerun(
  bundle: DefectBundle,
  changedUnitIds: readonly string[],
): RerunScope {
  const changed = new Set(changedUnitIds);
  const lanes = new Set<ReviewLane>();
  const gates = new Set<DeterministicGate>();
  const units = new Set<string>();

  for (const defect of bundle.defects) {
    if (!changed.has(defect.unitId)) continue;
    units.add(defect.unitId);
    for (const lane of defect.implicatedReviewLanes) lanes.add(lane);
    // A reviewer defect names its own raising lane; re-run that lane too.
    if (defect.origin === "reviewer") lanes.add(defect.reviewLane);
    for (const gate of defect.implicatedGates) gates.add(gate);
  }

  return {
    unitIds: sortedUnique(units),
    lanes: sortedUnique(lanes),
    gates: sortedUnique(gates),
  };
}
