// Exact route/choice topology + reachability, from the decoded scene graph.
//
// Edges come from the authoritative decode (reduceRouteGraph): observed
// scene-to-scene dispatch and choice transitions, never re-inferred from prose.
// Reachability is a plain BFS from the entry scene over those edges — the set
// of scenes (and thus units) the reader can actually reach under some
// route/choice path. A scene that no edge leads to is reported as unreachable
// rather than silently assumed live.

import { reduceRouteGraph } from "../structure/reduce.js";
import type { NarrativeStructure } from "../structure/types.js";

import type { NarrativePosition } from "./positions.js";
import type { RouteEdgeFact, RouteTopologyFact } from "./types.js";

function compareEdges(a: RouteEdgeFact, b: RouteEdgeFact): number {
  if (a.fromSceneId !== b.fromSceneId) return a.fromSceneId.localeCompare(b.fromSceneId);
  if (a.toSceneId !== b.toSceneId) return a.toSceneId.localeCompare(b.toSceneId);
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  return (a.choiceIndex ?? -1) - (b.choiceIndex ?? -1);
}

/**
 * Materialize the route topology + reachability facts. `reachableSceneIds` is
 * the BFS closure of the entry scene over decoded edges; `reachableUnitKeys`
 * are the source-unit keys whose owning scene is reachable, in stable order.
 */
export function materializeRouteTopology(
  structure: NarrativeStructure,
  positions: ReadonlyMap<string, NarrativePosition>,
): RouteTopologyFact {
  const routeGraph = reduceRouteGraph(structure);
  const edges: RouteEdgeFact[] = routeGraph.edges
    .map((edge) => ({
      fromSceneId: edge.fromSceneId,
      toSceneId: edge.toSceneId,
      kind: edge.kind,
      choiceIndex: edge.choiceIndex ?? null,
    }))
    .sort(compareEdges);

  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = outgoing.get(edge.fromSceneId) ?? [];
    targets.push(edge.toSceneId);
    outgoing.set(edge.fromSceneId, targets);
  }

  const reachable = new Set<string>();
  const queue: string[] = [structure.entryScene];
  reachable.add(structure.entryScene);
  while (queue.length > 0) {
    const sceneId = queue.shift()!;
    for (const target of outgoing.get(sceneId) ?? []) {
      if (!reachable.has(target)) {
        reachable.add(target);
        queue.push(target);
      }
    }
  }

  const allSceneIds = [...new Set(structure.scenes.map((scene) => scene.sceneId))].sort((a, b) =>
    a.localeCompare(b),
  );
  const reachableSceneIds = allSceneIds.filter((sceneId) => reachable.has(sceneId));
  const unreachableSceneIds = allSceneIds.filter((sceneId) => !reachable.has(sceneId));

  const reachableUnitKeys = [...positions.values()]
    .filter((position) => reachable.has(position.sceneId))
    .map((position) => position.sourceUnitKey)
    .sort(compareCodeUnits);

  return {
    entryScene: structure.entryScene,
    sceneDispatchOrder: [...routeGraph.sceneDispatchOrder],
    edges,
    reachableSceneIds,
    unreachableSceneIds,
    reachableUnitKeys,
  };
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
