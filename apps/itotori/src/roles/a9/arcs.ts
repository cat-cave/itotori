// The whole character-by-route arc pass.
//
// A9 fans out over the deterministic character-by-route intersection and emits
// ONE cited character-route-arc per pair — none skipped. The pair set is the
// decoded occurrence/route intersection EXACTLY: it is computed from the decode,
// not the model, so a minor character with a single route-visible occurrence is
// always covered. For each pair A9 reads the route-scoped evidence through the
// local tools, builds the decoded occurrence-unit window, dispatches the arc
// draft, and assembles a validated route-scoped object whose state shifts carry
// decode-stamped play-order ranges and resolving citations.

import type { ReadModel } from "../../read-tools/index.js";
import type { WikiObject } from "../../contracts/index.js";

import { assembleCharacterRouteArc } from "./assemble.js";
import { verifyA8CharacterBackground } from "./background.js";
import { characterIndex, readCharacterRouteEvidence } from "./characters.js";
import { characterRouteIntersection, routeOccurrenceWindow } from "./intersection.js";
import {
  A9RoleError,
  type A9Context,
  type A9BackgroundResolver,
  type A9ModelCaller,
  type CharacterRoutePair,
} from "./types.js";

/** One pair's result: the grounded, route-scoped arc object. */
export interface A9ArcResult {
  readonly characterId: string;
  readonly routeId: string;
  readonly arc: WikiObject;
}

/** The whole pass over the intersection. */
export interface A9RosterResult {
  readonly arcs: readonly A9ArcResult[];
  /** Every (character, route) pair the pass covered — the full intersection. */
  readonly coveredPairs: readonly CharacterRoutePair[];
}

/**
 * Emit one cited character-route-arc for every pair in the deterministic
 * character-by-route intersection. Throws {@link A9RoleError} if the character
 * index is empty (a game with no decoded characters cannot be arced) or if
 * coverage does not equal the intersection (a silently skipped pair). The pair
 * set is decode-derived, so no model output can add or drop a pair.
 */
export async function routeArcRoster(
  model: ReadModel,
  context: A9Context,
  modelCaller: A9ModelCaller,
  backgroundFor: A9BackgroundResolver,
): Promise<A9RosterResult> {
  if (characterIndex(model).length === 0) {
    throw new A9RoleError("empty-character-index", "the snapshot carries no decoded characters");
  }
  const pairs = characterRouteIntersection(model);
  const byId = new Map(
    characterIndex(model).map((character) => [character.characterId, character]),
  );

  const arcs: A9ArcResult[] = [];
  for (const pair of pairs) {
    const character = byId.get(pair.characterId)!;
    const evidence = readCharacterRouteEvidence(model, context, character, pair.routeId);
    const background = verifyA8CharacterBackground(
      model,
      pair.characterId,
      backgroundFor(pair.characterId),
    );
    const windowUnitIds = routeOccurrenceWindow(model, evidence.sceneIds, pair.routeId).map(
      (unit) => unit.factId,
    );
    const draft = await modelCaller({
      evidence,
      background,
      windowUnitIds,
      sourceLanguage: model.sourceLanguage,
    });
    const arc = assembleCharacterRouteArc(model, context, character, evidence, background, draft);
    arcs.push({ characterId: pair.characterId, routeId: pair.routeId, arc });
  }

  if (arcs.length !== pairs.length) {
    throw new A9RoleError(
      "coverage-gap",
      `emitted ${arcs.length} arcs for ${pairs.length} intersection pairs`,
    );
  }
  return { arcs, coveredPairs: pairs };
}
