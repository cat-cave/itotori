// The deterministic work source — the enumerable units of analyst work.
//
// Everything the analyst roster fans out over is DERIVED mechanically from the
// fact snapshot: the routes (distinct route ids across the decoded units), the
// scenes of each route in play order, the characters, the character pairs, the
// ambiguous terms, and the translatable units. Nothing here is inferred by a
// model — a route a unit never belongs to is never enumerated, and a game with
// no route tags collapses to a single whole-game route so the fold still runs.

import { ambiguousTermCandidates } from "../roles/a2/index.js";
import { flaggedAdaptationCandidates } from "../roles/a6/index.js";
import { characterRouteIntersection } from "../roles/a9/index.js";
import { readUnknownSpeakerUnits } from "../roles/a10/index.js";
import type { FactRouteScope, FactSnapshot } from "../prepass/index.js";
import type { RouteScope } from "../contracts/index.js";
import type { ReadModel } from "../read-tools/index.js";

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
  /** The exact decoded character/route intersections A9 can author. */
  readonly characterRoutePairs: readonly {
    readonly characterId: string;
    readonly routeId: string;
  }[];
  readonly termKeys: readonly string[];
  /** The exact pre-pass flagged A6 subjects. */
  readonly adaptationUnits: readonly { readonly unitId: string; readonly scope: RouteScope }[];
  /** The exact genuinely-unknown-speaker A10 subjects. */
  readonly unknownSpeakerUnits: readonly { readonly unitId: string; readonly scope: RouteScope }[];
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
  const globalScenes = new Set<number>();
  for (const unit of snapshot.orderedUnits) {
    const routeIds = routeIdsOf(unit.routeScope);
    if (routeIds.length === 0) {
      globalScenes.add(unit.sceneId);
      continue;
    }
    for (const routeId of routeIds) {
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
  const routes = routeIds.map((routeId) => ({
    routeId,
    scope: { kind: "route", routeId },
    sceneIds: dispatchOrder.filter((sceneId) => scenesByRoute.get(routeId)!.has(sceneId)),
  }));
  // Common-route scenes still need one serial story lane. Do not copy those
  // scenes into every branch: that would create duplicate scene objects and
  // rerun the same factual work. A route-set scene remains visible to each
  // concrete route named by its decoded scope; a global scene has this one
  // global lane.
  if (globalScenes.size > 0) {
    routes.unshift({
      routeId: WHOLE_GAME_ROUTE_ID,
      scope: { kind: "global" },
      sceneIds: dispatchOrder.filter((sceneId) => globalScenes.has(sceneId)),
    });
  }
  return routes;
}

/** Derive the enumerable work source from a fact snapshot. */
export function deriveWorkSource(
  snapshot: FactSnapshot,
  options: {
    /** A6/A10 derive authorable units through their real read-model functions. */
    readonly readModel?: ReadModel;
  } = {},
): WorkSource {
  const characterIds = [...snapshot.characters]
    .map((c) => c.characterId)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const termKeys = ambiguousTermCandidates(snapshot).map((candidate) => candidate.termKey);
  const readModel = options.readModel;
  const adaptationUnits =
    readModel === undefined
      ? []
      : flaggedAdaptationCandidates(readModel).map((candidate) => {
          if (!snapshot.orderedUnits.some((unit) => unit.factId === candidate.unitFactId)) {
            throw new Error(
              `A6 candidate ${candidate.unitFactId} is absent from the fact snapshot`,
            );
          }
          // A6's certified role validates its unit mapping and emits a
          // whole-game analysis note; it does not carry a route-scope input to
          // its model/assembly path, so global is the only scope it can author.
          return { unitId: candidate.unitFactId, scope: { kind: "global" as const } };
        });
  const unknownSpeakerUnits =
    readModel === undefined
      ? []
      : readUnknownSpeakerUnits(readModel, {
          runMode: "production",
          contextScope: "whole-game",
          routeVisibility: { kind: "global" },
          localeBranchId: null,
        }).map((unit) => ({ unitId: unit.unitId, scope: unit.scope }));
  const characterRoutePairs = characterRouteIntersection({ factSnapshot: snapshot });
  return {
    gameId: snapshot.source.bridgeId,
    routes: deriveRoutes(snapshot),
    characterIds,
    characterRoutePairs,
    termKeys,
    adaptationUnits,
    unknownSpeakerUnits,
  };
}
