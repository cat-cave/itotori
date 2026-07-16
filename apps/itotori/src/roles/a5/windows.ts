// The deterministic occurrence topology A5 addresses over — nothing here is a
// model output.
//
// A character's occurrence window is the set of ordered units in its occurrence
// scenes, in decoded play order; it is the ONLY set a counterpart or arc rule may
// cite. A unit is visible under a rule's route scope exactly when a global unit
// plays on every route and a route/route-set unit plays on the routes it names.
// The route universe a character occurs on is folded from its occurrence scenes:
// a global (common-route) scene places the character on every decoded route.

import type { ReadModel } from "../../read-tools/index.js";
import type { FactRouteScope, OrderedUnitFact } from "../../prepass/index.js";
import type { RouteScope } from "../../contracts/index.js";

function byCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The route ids a unit scope carries (empty for a global unit). */
function scopeRouteIds(scope: FactRouteScope): readonly string[] {
  if (scope.kind === "route") return [scope.routeId];
  if (scope.kind === "route-set") return scope.routeIds;
  return [];
}

/** True when a unit under `scope` is visible while playing route `routeId`: a
 * global unit plays on every route; a route/route-set unit plays on the routes it
 * names. */
export function unitVisibleOnRoute(scope: FactRouteScope, routeId: string): boolean {
  if (scope.kind === "global") return true;
  return scopeRouteIds(scope).includes(routeId);
}

/** True when a unit is visible under a RULE's route scope: a global rule accepts
 * every unit; a route/route-set rule accepts a unit visible on any named route. */
export function unitVisibleUnderScope(unitScope: FactRouteScope, ruleScope: RouteScope): boolean {
  if (ruleScope.kind === "global") return true;
  const routeIds = ruleScope.kind === "route" ? [ruleScope.routeId] : ruleScope.routeIds;
  return routeIds.some((routeId) => unitVisibleOnRoute(unitScope, routeId));
}

/** The decoded route universe: every route id any ordered unit is scoped to,
 * sorted. A global-only game carries no routes. */
export function routeUniverse(model: ReadModel): readonly string[] {
  const ids = new Set<string>();
  for (const unit of model.factSnapshot.orderedUnits) {
    for (const routeId of scopeRouteIds(unit.routeScope)) ids.add(routeId);
  }
  return [...ids].sort(byCodeUnits);
}

/** The character's occurrence-unit window: the ordered units in its occurrence
 * scenes, in decoded play order. The ONLY units the profile may cite. */
export function occurrenceWindow(
  model: ReadModel,
  sceneIds: readonly number[],
): readonly OrderedUnitFact[] {
  const scenes = new Set(sceneIds);
  return model.factSnapshot.orderedUnits
    .filter((unit) => scenes.has(unit.sceneId))
    .slice()
    .sort((a, b) => a.playReveal.playOrderIndex - b.playReveal.playOrderIndex);
}

/** The routes a character occurs on: the decoded universe filtered to routes at
 * least one occurrence unit is visible on (a character in a global scene occurs on
 * every route). Sorted, decode-derived. */
export function characterRouteIds(
  model: ReadModel,
  window: readonly OrderedUnitFact[],
): readonly string[] {
  const universe = routeUniverse(model);
  return universe.filter((routeId) =>
    window.some((unit) => unitVisibleOnRoute(unit.routeScope, routeId)),
  );
}
