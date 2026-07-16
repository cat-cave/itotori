// The deterministic work source — the enumerable units of analyst work.
//
// Everything the analyst roster fans out over is DERIVED mechanically from the
// fact snapshot: the routes (distinct route ids across the decoded units), the
// scenes of each route in play order, the characters, the character pairs, the
// ambiguous terms, and the translatable units. Nothing here is inferred by a
// model — a route a unit never belongs to is never enumerated, and a game with
// no route tags collapses to a single whole-game route so the fold still runs.

import type { FactRouteScope, FactSnapshot } from "../prepass/index.js";
import type { RouteScope } from "../contracts/index.js";

/** One route: its id, the scope objects on it carry, and its scenes in play
 * order (the serial A3 fold walks these). */
export interface RouteWork {
  readonly routeId: string;
  readonly scope: RouteScope;
  readonly sceneIds: readonly number[];
}

/** The implicit route id used when the decode carries no route tags at all. */
export const WHOLE_GAME_ROUTE_ID = "whole-game" as const;

/** The enumerable work the analyst roster fans out over. */
export interface WorkSource {
  readonly gameId: string;
  readonly routes: readonly RouteWork[];
  readonly characterIds: readonly string[];
  readonly pairs: readonly (readonly [string, string])[];
  readonly termKeys: readonly string[];
  readonly units: readonly { readonly unitId: string; readonly scope: RouteScope }[];
}

function toRouteScope(scope: FactRouteScope): RouteScope {
  if (scope.kind === "route") return { kind: "route", routeId: scope.routeId };
  if (scope.kind === "route-set") {
    const routeIds = [...new Set(scope.routeIds)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return { kind: "route-set", routeIds };
  }
  return { kind: "global" };
}

/** Distinct route ids present on a fact route scope. */
function routeIdsOf(scope: FactRouteScope): readonly string[] {
  if (scope.kind === "route") return [scope.routeId];
  if (scope.kind === "route-set") return scope.routeIds;
  return [];
}

function deriveRoutes(snapshot: FactSnapshot): RouteWork[] {
  const dispatchOrder = snapshot.routeTopology.sceneDispatchOrder;
  const scenesByRoute = new Map<string, Set<number>>();
  for (const unit of snapshot.orderedUnits) {
    for (const routeId of routeIdsOf(unit.routeScope)) {
      if (!scenesByRoute.has(routeId)) scenesByRoute.set(routeId, new Set());
      scenesByRoute.get(routeId)!.add(unit.sceneId);
    }
  }
  if (scenesByRoute.size === 0) {
    // No route tags: the whole game is one route covering the dispatch order.
    return [
      { routeId: WHOLE_GAME_ROUTE_ID, scope: { kind: "global" }, sceneIds: [...dispatchOrder] },
    ];
  }
  const routeIds = [...scenesByRoute.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return routeIds.map((routeId) => ({
    routeId,
    scope: { kind: "route", routeId },
    sceneIds: dispatchOrder.filter((sceneId) => scenesByRoute.get(routeId)!.has(sceneId)),
  }));
}

/** Derive the enumerable work source from a fact snapshot. */
export function deriveWorkSource(snapshot: FactSnapshot): WorkSource {
  const characterIds = [...snapshot.characters]
    .map((c) => c.characterId)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const pairs: (readonly [string, string])[] = [];
  for (let i = 0; i < characterIds.length; i += 1) {
    for (let j = i + 1; j < characterIds.length; j += 1) {
      pairs.push([characterIds[i]!, characterIds[j]!]);
    }
  }
  const termKeys = [...snapshot.terminology]
    .map((t) => t.termKey)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const units = snapshot.orderedUnits.map((unit) => ({
    unitId: unit.factId,
    scope: toRouteScope(unit.routeScope),
  }));
  return {
    gameId: snapshot.source.bridgeId,
    routes: deriveRoutes(snapshot),
    characterIds,
    pairs,
    termKeys,
    units,
  };
}
