// Enumerate the deterministic character index and read each pair's route-scoped
// evidence through the strict read-tool surface.
//
// The character SET is the fact snapshot's character index EXACTLY — a projection
// of the decode, never a model attribution. For each intersection pair A9 reads
// the occurrence fact through `decode_get_character_occurrences` and takes the
// label and the occurrence fact id from that INDEX-DERIVED result. A character
// with no citeable occurrence is a loud failure, never an arc built on air.

import {
  decodeGetCharacterOccurrences,
  type ReadModel,
  type ReadToolCaller,
} from "../../read-tools/index.js";
import type { CharacterOccurrenceFact } from "../../prepass/index.js";

import { A9RoleError, A9_ROLE_ID, type A9Context, type CharacterRouteEvidence } from "./types.js";

const MAX_ROWS = 1_000;
const MAX_BYTES = 8_388_608;

/** The A9 caller identity for the local read tools. */
export function a9Caller(context: A9Context): ReadToolCaller {
  return {
    roleId: A9_ROLE_ID,
    routeVisibility: context.routeVisibility,
    localeBranchId: context.localeBranchId,
  };
}

/** The deterministic character index: the fact snapshot's characters, exactly.
 * The arcs A9 emits are one-per-intersection-pair over precisely this set. */
export function characterIndex(model: ReadModel): readonly CharacterOccurrenceFact[] {
  return model.factSnapshot.characters;
}

/**
 * Read one intersection pair's route-scoped evidence, or throw. The occurrence
 * fact is read through the tool surface so the label and fact id are exactly the
 * snapshot's projection; the scene topology is taken from the decode fact. A
 * character absent from the snapshot fails loud (`unknown-character`); one whose
 * occurrence binds no line fails loud (`no-evidence`) rather than yielding an arc
 * with nothing to cite.
 */
export function readCharacterRouteEvidence(
  model: ReadModel,
  context: A9Context,
  character: CharacterOccurrenceFact,
  routeId: string,
): CharacterRouteEvidence {
  const result = decodeGetCharacterOccurrences(model, a9Caller(context), {
    characterId: character.characterId,
    maxRows: MAX_ROWS,
    maxBytes: MAX_BYTES,
  });
  const fact = result.facts[0];
  if (!fact || fact.value.characterId !== character.characterId) {
    throw new A9RoleError(
      "unknown-character",
      `character ${character.characterId} has no occurrence fact in this snapshot`,
    );
  }
  if (fact.value.totalLines === 0) {
    throw new A9RoleError(
      "no-evidence",
      `character ${character.characterId} speaks no line; a route arc would have nothing to cite`,
    );
  }
  return {
    characterId: character.characterId,
    decodedLabel: fact.value.decodedLabel,
    occurrenceFactId: fact.factId,
    sceneIds: character.sceneIds,
    routeId,
    scope: { kind: "route", routeId },
  };
}
