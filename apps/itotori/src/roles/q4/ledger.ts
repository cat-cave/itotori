// The deterministic continuity ledger — the play-order + route-scope facts the
// Continuity Reviewer proves a finding AGAINST.
//
// Every fact here is materialized ENTIRELY from the immutable decode fact
// snapshot, never from a model output. That is the whole point: whether a
// callback's origin plays BEFORE the unit that uses it, and whether an endpoint
// is on the route the review is bound to, are DECODE-derived truths the model
// can neither assert nor override. A finding cites unit endpoints; the ledger is
// the only authority on where those units sit in play order and route scope.

import { type RouteScope } from "../../contracts/index.js";
import type { FactRouteScope, FactSnapshot } from "../../prepass/index.js";

/** One unit's deterministic continuity coordinates: where it plays and the route
 * scope it is visible under. Both are copied verbatim from the decode snapshot. */
export interface ContinuityFact {
  readonly unitId: string;
  readonly playOrderIndex: number;
  readonly routeScope: FactRouteScope;
}

/** The immutable ledger: resolve a cited unit id to its decode coordinates, or
 * `null` when the id names no real ordered unit (a phantom endpoint). */
export interface ContinuityLedger {
  readonly resolve: (unitId: string) => ContinuityFact | null;
  readonly size: number;
}

/** Build a ledger from an explicit fact set — the synthetic construction path.
 * A duplicate unit id is a materialization bug, not a silent last-wins. */
export function continuityLedgerFrom(facts: readonly ContinuityFact[]): ContinuityLedger {
  const byUnit = new Map<string, ContinuityFact>();
  for (const fact of facts) {
    if (byUnit.has(fact.unitId)) {
      throw new Error(`continuity ledger has a duplicate unit ${fact.unitId}`);
    }
    byUnit.set(fact.unitId, fact);
  }
  return { resolve: (unitId) => byUnit.get(unitId) ?? null, size: byUnit.size };
}

/** Build the ledger from a real decode fact snapshot: every ordered unit becomes
 * one continuity fact keyed by its snapshot fact id, carrying the decode play
 * order and route scope. Deterministic over the bytes — repeated builds over the
 * same snapshot are identical, so a recorded snapshot gives an offline proof. */
export function buildContinuityLedger(snapshot: FactSnapshot): ContinuityLedger {
  return continuityLedgerFrom(
    snapshot.orderedUnits.map((unit) => ({
      unitId: unit.factId,
      playOrderIndex: unit.playReveal.playOrderIndex,
      routeScope: unit.routeScope,
    })),
  );
}

/** The route ids a scope names (empty for a global scope). */
function routeIdsOf(scope: FactRouteScope | RouteScope): readonly string[] {
  if (scope.kind === "route") return [scope.routeId];
  if (scope.kind === "route-set") return scope.routeIds;
  return [];
}

/** True when a fact under `factScope` is visible while the review is bound to
 * `reviewScope`. A global fact plays on every route; a global review sees every
 * route; otherwise the two must share at least one concrete route. This is the
 * ONLY route-crossing rule: a route-scoped review can never reach an endpoint on
 * a route it does not carry. */
export function endpointVisibleOnReviewScope(
  factScope: FactRouteScope,
  reviewScope: RouteScope,
): boolean {
  if (factScope.kind === "global") return true;
  if (reviewScope.kind === "global") return true;
  const reviewRoutes = new Set(routeIdsOf(reviewScope));
  return routeIdsOf(factScope).some((routeId) => reviewRoutes.has(routeId));
}

/** True when `origin` plays strictly BEFORE `use` in the decode play order. This
 * is the origin-precedes-use proof, derived from the ledger alone — never from a
 * model-asserted ordering. A callback whose origin does not play first fails it. */
export function originPrecedesUse(origin: ContinuityFact, use: ContinuityFact): boolean {
  return origin.playOrderIndex < use.playOrderIndex;
}
