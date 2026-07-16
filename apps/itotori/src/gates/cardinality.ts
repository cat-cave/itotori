// Gate: unit totality / order / source-hash (`cardinality-order-hash`).
//
// Over the accepted outputs and the expected in-scope unit set, this proves:
//   * every accepted output binds a unit in the expected scope (no stray /
//     duplicate output) — `unit-cardinality`;
//   * the expected ordering agrees with the snapshot's decoded play order —
//     `unit-order`; and
//   * each accepted output's source hash equals the snapshot unit's committed
//     source hash — `source-hash`.
// MISSING coverage (an expected unit with no accepted output) is owned by the
// patch-coverage gate, so the two never double-count the same unit.

import type { Defect } from "../contracts/index.js";
import type { FactSnapshot } from "../prepass/index.js";

import { buildDefect } from "./defect.js";
import { bindAccepted, indexUnitsByFactId } from "./unit-index.js";
import type { AcceptedUnitOutput } from "./types.js";

/** Default expected scope: every reachable unit, in decoded play order. */
export function reachableUnitFactIdsInOrder(snapshot: FactSnapshot): readonly string[] {
  const reachable = new Set(snapshot.routeTopology.reachableUnitKeys);
  return snapshot.orderedUnits
    .filter((unit) => reachable.has(unit.sourceUnitKey))
    .map((unit) => unit.factId);
}

export function cardinalityOrderHashGate(
  snapshot: FactSnapshot,
  accepted: readonly AcceptedUnitOutput[],
  expectedOrderedFactIds: readonly string[] = reachableUnitFactIdsInOrder(snapshot),
): Defect[] {
  const bound = bindAccepted(snapshot, accepted); // fails loud on unknown / duplicate subject
  const byFactId = indexUnitsByFactId(snapshot);
  const expected = new Set(expectedOrderedFactIds);
  const defects: Defect[] = [];

  // Order: the expected ordering must be a strictly-increasing play-order walk.
  let previousPlayOrder = -1;
  for (const factId of expectedOrderedFactIds) {
    const unit = byFactId.get(factId);
    if (unit === undefined) {
      // An expected id absent from the snapshot cannot be play-ordered.
      defects.push(
        buildDefect({
          unitId: factId,
          category: "unit-order",
          detail: `expected unit ${factId} is not present in snapshot ${snapshot.snapshotId}`,
          basisFactIds: [snapshot.snapshotId],
        }),
      );
      continue;
    }
    if (unit.playReveal.playOrderIndex <= previousPlayOrder) {
      defects.push(
        buildDefect({
          unitId: unit.factId,
          category: "unit-order",
          detail: `expected order places ${unit.factId} (play order ${unit.playReveal.playOrderIndex}) at or before the previous unit (${previousPlayOrder})`,
          basisFactIds: [unit.factId],
        }),
      );
    }
    previousPlayOrder = unit.playReveal.playOrderIndex;
  }

  // Cardinality + source-hash over every accepted output.
  for (const { fact, accepted: output } of bound.values()) {
    if (!expected.has(fact.factId)) {
      defects.push(
        buildDefect({
          unitId: fact.factId,
          category: "unit-cardinality",
          detail: `accepted output ${output.outputId} binds ${fact.factId}, which is outside the expected work scope`,
          basisFactIds: [fact.factId],
        }),
      );
    }
    if (output.sourceHash !== fact.sourceHash) {
      defects.push(
        buildDefect({
          unitId: fact.factId,
          category: "source-hash",
          detail: `accepted source hash ${output.sourceHash} does not equal snapshot source hash ${fact.sourceHash}`,
          basisFactIds: [fact.factId],
        }),
      );
    }
  }

  return defects;
}
