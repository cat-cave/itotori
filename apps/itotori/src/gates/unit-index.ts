// Shared snapshot<->accepted-output join used by the per-unit gates.
//
// The canonical per-unit key is the ordered unit's namespaced FACT ID
// (`unit:…` / `choice:…`), which is stable within the snapshot. An accepted
// output binds to a unit by `subjectId === factId`. An accepted output whose
// subject is absent from the snapshot is a structural inconsistency the gates
// cannot evaluate — it fails loud (never a silent skip).

import type { OrderedUnitFact } from "../prepass/index.js";
import type { FactSnapshot } from "../prepass/index.js";

import { GateEvaluationError } from "./defect.js";
import type { AcceptedUnitOutput } from "./types.js";

export type UnitBinding = {
  fact: OrderedUnitFact;
  accepted: AcceptedUnitOutput;
};

/** Index a snapshot's ordered units by fact id (stable, deduped). */
export function indexUnitsByFactId(snapshot: FactSnapshot): ReadonlyMap<string, OrderedUnitFact> {
  const byId = new Map<string, OrderedUnitFact>();
  for (const unit of snapshot.orderedUnits) {
    byId.set(unit.factId, unit);
  }
  return byId;
}

/**
 * Bind every accepted output to its snapshot unit. Fails loud if an accepted
 * output names a subject absent from the snapshot, or if two accepted outputs
 * claim the same unit (an ambiguous head the gates must not silently resolve).
 */
export function bindAccepted(
  snapshot: FactSnapshot,
  accepted: readonly AcceptedUnitOutput[],
): ReadonlyMap<string, UnitBinding> {
  const byId = indexUnitsByFactId(snapshot);
  const bound = new Map<string, UnitBinding>();
  for (const output of accepted) {
    const fact = byId.get(output.subjectId);
    if (fact === undefined) {
      throw new GateEvaluationError(
        `accepted output ${output.outputId} names unit ${output.subjectId}, absent from snapshot ${snapshot.snapshotId}`,
      );
    }
    if (bound.has(output.subjectId)) {
      throw new GateEvaluationError(
        `two accepted outputs claim unit ${output.subjectId} in snapshot ${snapshot.snapshotId}`,
      );
    }
    bound.set(output.subjectId, { fact, accepted: output });
  }
  return bound;
}
