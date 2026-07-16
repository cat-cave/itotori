// Establishing-scene resolution + route reachability for A8 relationships.
//
// A relationship is only admissible when the same-game scene it cites as its
// establishing evidence is REAL, REACHABLE, and route-compatible with the
// relationship's declared scope. This module derives, from the immutable
// snapshot alone, one reachability record per scene: its citeable evidence id,
// whether the reader can actually reach it (the BFS reachability the decode
// fixed), and the route scope its units live under. It then validates a
// relationship's scope against that topology — a fabricated scene, an unreachable
// scene, an out-of-route scene, or a scope naming a route no reachable scene
// carries is rejected loud, never silently accepted.

import { routeScopeVisible, type ReadModel } from "../../read-tools/index.js";
import type { RouteScope } from "../../contracts/index.js";

import { A8RoleError, type A8RelationshipDraft } from "./types.js";
import { sceneEvidenceId } from "./ids.js";

/** One scene's reachability facts, addressed by its citeable evidence id. */
export interface SceneReachability {
  readonly evidenceId: string;
  readonly sceneId: string;
  readonly reachable: boolean;
  /** The route scope the scene's units live under (global when any unit is
   * global or the scene binds no route). */
  readonly routeScope: RouteScope;
}

export type SceneReachabilityIndex = ReadonlyMap<string, SceneReachability>;

/** The route scope a scene lives under, folded over its units: a scene with any
 * global unit (or no route-bearing unit) is global — it is reachable on every
 * route; otherwise it is the sorted union of the routes its units carry. */
function sceneRouteScope(routeIds: ReadonlySet<string>, sawGlobal: boolean): RouteScope {
  if (sawGlobal || routeIds.size === 0) return { kind: "global" };
  const sorted = [...routeIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted.length === 1
    ? { kind: "route", routeId: sorted[0]! }
    : { kind: "route-set", routeIds: sorted };
}

/** Build the per-scene reachability index from the snapshot: scene reachability
 * from the route topology, and scene route scope folded from its units. */
export function buildSceneReachabilityIndex(model: ReadModel): SceneReachabilityIndex {
  const routeIdsByScene = new Map<number, Set<string>>();
  const globalByScene = new Map<number, boolean>();
  for (const unit of model.factSnapshot.orderedUnits) {
    const scope = unit.routeScope;
    if (scope.kind === "global") {
      globalByScene.set(unit.sceneId, true);
      continue;
    }
    const ids = routeIdsByScene.get(unit.sceneId) ?? new Set<string>();
    const routes = scope.kind === "route" ? [scope.routeId] : scope.routeIds;
    for (const routeId of routes) ids.add(routeId);
    routeIdsByScene.set(unit.sceneId, ids);
  }
  const index = new Map<string, SceneReachability>();
  for (const scene of model.factSnapshot.scenes) {
    const evidenceId = sceneEvidenceId(scene.sceneId);
    index.set(evidenceId, {
      evidenceId,
      sceneId: String(scene.sceneId),
      reachable: scene.reachable,
      routeScope: sceneRouteScope(
        routeIdsByScene.get(scene.sceneId) ?? new Set<string>(),
        globalByScene.get(scene.sceneId) ?? false,
      ),
    });
  }
  return index;
}

/** The set of routes the reader can actually reach — every route id carried by a
 * unit whose owning scene is reachable. A scope naming a route absent here is
 * unreachable. */
export function reachableRoutes(model: ReadModel): ReadonlySet<string> {
  const reachableScenes = new Set(
    model.factSnapshot.scenes.filter((scene) => scene.reachable).map((scene) => scene.sceneId),
  );
  const routes = new Set<string>();
  for (const unit of model.factSnapshot.orderedUnits) {
    if (!reachableScenes.has(unit.sceneId)) continue;
    const scope = unit.routeScope;
    if (scope.kind === "route") routes.add(scope.routeId);
    else if (scope.kind === "route-set") for (const id of scope.routeIds) routes.add(id);
  }
  return routes;
}

/** The route ids a relationship scope names (empty for global). */
function scopeRoutes(scope: RouteScope): readonly string[] {
  if (scope.kind === "route") return [scope.routeId];
  if (scope.kind === "route-set") return scope.routeIds;
  return [];
}

/**
 * Validate one relationship's establishing scenes and scope against the snapshot
 * topology, returning the resolved establishing evidence ids in cited order.
 * Enforced in order so the strongest structural denial wins:
 *   1. every cited establishing scene must be a REAL scene (else fabricated);
 *   2. it must be REACHABLE (an unreachable scene establishes nothing);
 *   3. it must be route-compatible with the scope (a route-scoped relationship
 *      must be established ON that route);
 *   4. every route the scope names must be a REACHABLE route.
 */
export function resolveRelationshipScope(
  characterId: string,
  relationship: A8RelationshipDraft,
  sceneIndex: SceneReachabilityIndex,
  routes: ReadonlySet<string>,
): readonly string[] {
  const where = `${characterId}->${relationship.counterpartId}`;
  const resolved: string[] = [];
  for (const cited of relationship.establishingSceneIds) {
    const scene = sceneIndex.get(cited);
    if (!scene) {
      throw new A8RoleError(
        "unknown-establishing-scene",
        `relationship ${where} cites scene ${cited} that does not exist in this snapshot`,
      );
    }
    if (!scene.reachable) {
      throw new A8RoleError(
        "unreachable-scene",
        `relationship ${where} cites unreachable scene ${cited}`,
      );
    }
    if (!routeScopeVisible(scene.routeScope, relationship.scope)) {
      throw new A8RoleError(
        "out-of-route-scene",
        `relationship ${where} establishing scene ${cited} is not on the relationship's route scope`,
      );
    }
    resolved.push(scene.evidenceId);
  }
  for (const routeId of scopeRoutes(relationship.scope)) {
    if (!routes.has(routeId)) {
      throw new A8RoleError(
        "unreachable-scope",
        `relationship ${where} is scoped to unreachable route ${routeId}`,
      );
    }
  }
  return resolved;
}
