// Establishing-scene resolution + route reachability for A8 relationships.
//
// A relationship is only admissible when the same-game scene it cites as its
// establishing evidence is REAL, REACHABLE, and route-compatible with the
// relationship's declared scope. This module reads the local route-graph tool
// to derive one reachability record per scene: its citeable evidence id, whether
// the reader can actually reach it (the BFS reachability the decode fixed), and
// the route scope its units live under. It then validates a
// relationship's scope against that topology — a fabricated scene, an unreachable
// scene, an out-of-route scene, or a scope naming a route no reachable scene
// carries is rejected loud, never silently accepted.

import {
  decodeGetRouteGraph,
  routeScopeVisible,
  type ReadModel,
  type ReadToolCaller,
} from "../../read-tools/index.js";
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

const MAX_ROWS = 100_000;
const MAX_BYTES = 8_388_608;

type RouteNode = Extract<
  ReturnType<typeof decodeGetRouteGraph>["facts"][number],
  { value: { kind: "route-node" } }
>;

/** Read every visible route-graph scene through the strict local tool surface. */
function routeNodes(model: ReadModel, caller: ReadToolCaller): readonly RouteNode[] {
  const nodes: RouteNode[] = [];
  let cursor: string | undefined;
  do {
    const result = decodeGetRouteGraph(model, caller, {
      maxRows: MAX_ROWS,
      maxBytes: MAX_BYTES,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const fact of result.facts) {
      if (fact.value.kind === "route-node") nodes.push(fact as RouteNode);
    }
    cursor = result.page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return nodes;
}

/** Build the per-scene reachability index from local story evidence. */
export function buildSceneReachabilityIndex(
  model: ReadModel,
  caller: ReadToolCaller,
): SceneReachabilityIndex {
  const index = new Map<string, SceneReachability>();
  for (const scene of routeNodes(model, caller)) {
    const evidenceId = sceneEvidenceId(scene.value.sceneId);
    index.set(evidenceId, {
      evidenceId,
      sceneId: scene.value.sceneId,
      reachable: scene.value.reachable,
      routeScope: scene.value.routeScopes[0]!,
    });
  }
  return index;
}

/** The set of routes the reader can actually reach, derived from reachable
 * route-graph scenes. A scope naming a route absent here is unreachable. */
export function reachableRoutes(sceneIndex: SceneReachabilityIndex): ReadonlySet<string> {
  const routes = new Set<string>();
  for (const scene of sceneIndex.values()) {
    if (!scene.reachable) continue;
    const scope = scene.routeScope;
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
  if (relationship.establishingSceneIds.length === 0) {
    throw new A8RoleError(
      "missing-establishing-scene",
      `relationship ${where} cites no establishing same-game scene`,
    );
  }
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
