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
  /** Characters for which this run has a real portrait source. A7 cannot
   * fabricate a media hash, so an absent source is deliberately not sharded. */
  readonly portraitCharacterIds: readonly string[];
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
  /** Complete global A3 fold, with its per-scene summary and cumulative story scopes. */
  readonly scenes: readonly {
    readonly sceneId: number;
    readonly sceneScope: RouteScope;
    readonly storyScope: RouteScope;
  }[];
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

function mergeScopes(left: RouteScope, right: RouteScope): RouteScope {
  if (left.kind === "global" || right.kind === "global") return { kind: "global" };
  const ids = new Set<string>();
  for (const scope of [left, right]) {
    if (scope.kind === "route") ids.add(scope.routeId);
    else for (const id of scope.routeIds) ids.add(id);
  }
  const routeIds = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return routeIds.length === 1
    ? { kind: "route", routeId: routeIds[0]! }
    : { kind: "route-set", routeIds };
}

function sceneScopes(snapshot: FactSnapshot): WorkSource["scenes"] {
  const byScene = new Map<number, RouteScope>();
  for (const unit of snapshot.orderedUnits) {
    const scope = toRouteScope(unit.routeScope);
    const previous = byScene.get(unit.sceneId);
    byScene.set(unit.sceneId, previous === undefined ? scope : mergeScopes(previous, scope));
  }
  let storyScope: RouteScope | undefined;
  // A dispatched scene with no ordered units — a title / menu / branch-only /
  // system scene (47 of Sweetie's dispatched scenes) — carries nothing for the
  // analysts to author, so skip it rather than fail. The story-so-far spine
  // folds only through scenes that actually have content.
  return snapshot.routeTopology.sceneDispatchOrder.flatMap((sceneId) => {
    const sceneScope = byScene.get(sceneId);
    if (sceneScope === undefined) return [];
    storyScope = storyScope === undefined ? sceneScope : mergeScopes(storyScope, sceneScope);
    return [{ sceneId, sceneScope, storyScope }];
  });
}

/** Derive the enumerable work source from a fact snapshot. */
export function deriveWorkSource(
  snapshot: FactSnapshot,
  options: {
    /** A6/A10 derive authorable units through their real read-model functions. */
    readonly readModel?: ReadModel;
    /** A7's external render/patch-report portrait sources, keyed by character. */
    readonly portraitCharacterIds?: readonly string[];
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
  const portraitCharacters = new Set(options.portraitCharacterIds ?? []);
  return {
    gameId: snapshot.source.bridgeId,
    routes: deriveRoutes(snapshot),
    characterIds,
    portraitCharacterIds: characterIds.filter((characterId) => portraitCharacters.has(characterId)),
    characterRoutePairs,
    termKeys,
    adaptationUnits,
    unknownSpeakerUnits,
    scenes: sceneScopes(snapshot),
  };
}
