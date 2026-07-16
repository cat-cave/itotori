// Gate: work-scope reachability + patch coverage (`patch-coverage`).
//
// The scoped work is complete only when every reachable in-scope unit has an
// accepted target. This gate proves: (a) every in-scope unit is reachable from
// the entry scene per the snapshot route topology (an unreachable unit cannot
// be patched into a played line), and (b) every in-scope unit has exactly one
// accepted output. Both are grounded on snapshot facts; an in-scope id absent
// from the snapshot fails loud.

import type { Defect } from "../contracts/index.js";
import type { FactSnapshot } from "../prepass/index.js";

import { reachableUnitFactIdsInOrder } from "./cardinality.js";
import { buildDefect, GateEvaluationError } from "./defect.js";
import { bindAccepted, indexUnitsByFactId } from "./unit-index.js";
import type { AcceptedUnitOutput, WorkScope } from "./types.js";

export function patchCoverageGate(
  snapshot: FactSnapshot,
  accepted: readonly AcceptedUnitOutput[],
  workScope?: WorkScope,
): Defect[] {
  const bound = bindAccepted(snapshot, accepted);
  const byFactId = indexUnitsByFactId(snapshot);
  const reachableKeys = new Set(snapshot.routeTopology.reachableUnitKeys);
  const inScope = workScope?.inScopeUnitFactIds ?? reachableUnitFactIdsInOrder(snapshot);

  const defects: Defect[] = [];
  for (const factId of inScope) {
    const unit = byFactId.get(factId);
    if (unit === undefined) {
      throw new GateEvaluationError(
        `in-scope unit ${factId} is absent from snapshot ${snapshot.snapshotId}`,
      );
    }
    if (!reachableKeys.has(unit.sourceUnitKey)) {
      defects.push(
        buildDefect({
          unitId: unit.factId,
          category: "patch-coverage",
          detail: `in-scope unit ${unit.factId} is not reachable from entry scene ${snapshot.routeTopology.entryScene}`,
          basisFactIds: [unit.factId],
        }),
      );
      continue;
    }
    if (!bound.has(factId)) {
      defects.push(
        buildDefect({
          unitId: unit.factId,
          category: "patch-coverage",
          detail: `reachable in-scope unit ${unit.factId} has no accepted target`,
          basisFactIds: [unit.factId],
        }),
      );
    }
  }
  return defects;
}
