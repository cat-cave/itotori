// The deterministic character-by-route intersection — the pair set A9 fans out
// over, and the per-pair occurrence-unit window shifts are cited from.
//
// Nothing here is a model output. The route universe is the set of routes some
// ordered unit is scoped to. A scene's route membership is folded from its units
// (a scene with any global unit — or no route-bearing unit — plays on EVERY
// route; otherwise it plays on exactly the routes its units carry). A character
// occurs on route R exactly when one of its occurrence scenes plays on R, so the
// pair set is the literal intersection of the character's occurrence scenes with
// the route's scenes — a minor character with a single route-visible occurrence
// is present, never skipped. The per-pair window is the character's occurrence
// units that are route-visible, in decoded play order, and it is the ONLY set a
// shift may be bounded by.

import type { ReadModel } from "../../read-tools/index.js";
import type {
  CharacterOccurrenceFact,
  FactRouteScope,
  OrderedUnitFact,
} from "../../prepass/index.js";

import type { CharacterRoutePair } from "./types.js";

function byCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The route ids a unit scope carries (empty for a global unit). */
function scopeRouteIds(scope: FactRouteScope): readonly string[] {
  if (scope.kind === "route") return [scope.routeId];
  if (scope.kind === "route-set") return scope.routeIds;
  return [];
}

/** True when a fact under `scope` is visible while playing route `routeId`: a
 * global fact plays on every route; a route/route-set fact plays on the routes it
 * names. */
export function visibleOnRoute(scope: FactRouteScope, routeId: string): boolean {
  if (scope.kind === "global") return true;
  return scopeRouteIds(scope).includes(routeId);
}

/** The decoded route universe: every route id any ordered unit is scoped to,
 * sorted. Global-only games carry no routes and thus no character-route arcs. */
export function routeUniverse(model: Pick<ReadModel, "factSnapshot">): readonly string[] {
  const ids = new Set<string>();
  for (const unit of model.factSnapshot.orderedUnits) {
    for (const routeId of scopeRouteIds(unit.routeScope)) ids.add(routeId);
  }
  return [...ids].sort(byCodeUnits);
}

/** One scene's folded route membership. */
interface SceneRoutes {
  /** The scene plays on every route (a global unit, or no route-bearing unit). */
  readonly global: boolean;
  /** The concrete routes the scene's units name (empty when global). */
  readonly routeIds: ReadonlySet<string>;
}

/** Fold each scene's units into its route membership: any global unit (or a scene
 * with no route-bearing unit at all) makes the scene global; otherwise it is the
 * union of the routes its units carry. */
function sceneRoutesIndex(units: readonly OrderedUnitFact[]): ReadonlyMap<string, SceneRoutes> {
  const routeIdsByScene = new Map<string, Set<string>>();
  const globalByScene = new Map<string, boolean>();
  const seenScene = new Set<string>();
  for (const unit of units) {
    seenScene.add(unit.sceneId);
    if (unit.routeScope.kind === "global") {
      globalByScene.set(unit.sceneId, true);
      continue;
    }
    const ids = routeIdsByScene.get(unit.sceneId) ?? new Set<string>();
    for (const routeId of scopeRouteIds(unit.routeScope)) ids.add(routeId);
    routeIdsByScene.set(unit.sceneId, ids);
  }
  const index = new Map<string, SceneRoutes>();
  for (const sceneId of seenScene) {
    const routeIds = routeIdsByScene.get(sceneId) ?? new Set<string>();
    const global = (globalByScene.get(sceneId) ?? false) || routeIds.size === 0;
    index.set(sceneId, { global, routeIds });
  }
  return index;
}

/** The routes one character occurs on: the union, over its occurrence scenes, of
 * each scene's route membership. A character in a global (common-route) scene is
 * present on every route in the universe. Sorted, decode-derived. */
export function characterRoutes(
  character: CharacterOccurrenceFact,
  scenes: ReadonlyMap<string, SceneRoutes>,
  universe: readonly string[],
): readonly string[] {
  const routes = new Set<string>();
  for (const sceneId of character.sceneIds) {
    const membership = scenes.get(sceneId);
    if (!membership) continue;
    if (membership.global) {
      for (const routeId of universe) routes.add(routeId);
    } else {
      for (const routeId of membership.routeIds) routes.add(routeId);
    }
  }
  return [...routes].sort(byCodeUnits);
}

/** The deterministic character-by-route intersection: one pair for every route a
 * character occurs on, in character-index order then sorted-route order. This is
 * the EXACT set A9 must cover — no pair added, no minor character dropped. */
export function characterRouteIntersection(
  model: Pick<ReadModel, "factSnapshot">,
): readonly CharacterRoutePair[] {
  const universe = routeUniverse(model);
  const scenes = sceneRoutesIndex(model.factSnapshot.orderedUnits);
  const pairs: CharacterRoutePair[] = [];
  for (const character of model.factSnapshot.characters) {
    for (const routeId of characterRoutes(character, scenes, universe)) {
      pairs.push({ characterId: character.characterId, routeId });
    }
  }
  return pairs;
}

/** True when `routeId` is one of the routes `character` occurs on — the guard a
 * fabricated pair fails. */
export function pairInIntersection(
  model: ReadModel,
  character: CharacterOccurrenceFact,
  routeId: string,
): boolean {
  const universe = routeUniverse(model);
  const scenes = sceneRoutesIndex(model.factSnapshot.orderedUnits);
  return characterRoutes(character, scenes, universe).includes(routeId);
}

/** The per-pair occurrence-unit window: the character's occurrence units that are
 * visible on the route, in decoded play order. The ONLY units a shift on this arc
 * may be bounded by; empty only when the pair is not a real intersection. */
export function routeOccurrenceWindow(
  model: ReadModel,
  sceneIds: readonly string[],
  routeId: string,
): readonly OrderedUnitFact[] {
  const occurrenceScenes = new Set(sceneIds);
  return model.factSnapshot.orderedUnits
    .filter(
      (unit) => occurrenceScenes.has(unit.sceneId) && visibleOnRoute(unit.routeScope, routeId),
    )
    .slice()
    .sort((a, b) => a.playReveal.playOrderIndex - b.playReveal.playOrderIndex);
}
