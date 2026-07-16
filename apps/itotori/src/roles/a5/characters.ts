// Enumerate the deterministic character index and read each character's whole-
// game voice evidence through the strict read-tool surface.
//
// The character SET is the fact snapshot's character index EXACTLY — a projection
// of the decode, never a model attribution. For each character A5 reads the
// occurrence fact through `decode_get_character_occurrences` and takes the label
// and the occurrence fact id from that INDEX-DERIVED result. A character with no
// citeable occurrence is a loud failure, never a profile built on air.

import {
  decodeGetCharacterOccurrences,
  type ReadModel,
  type ReadToolCaller,
} from "../../read-tools/index.js";
import type { CharacterOccurrenceFact } from "../../prepass/index.js";

import { A5RoleError, A5_ROLE_ID, type A5Context, type CharacterVoiceEvidence } from "./types.js";

const MAX_ROWS = 1_000;
const MAX_BYTES = 8_388_608;

/** The A5 caller identity for the local read tools. */
export function a5Caller(context: A5Context): ReadToolCaller {
  return {
    roleId: A5_ROLE_ID,
    routeVisibility: context.routeVisibility,
    localeBranchId: context.localeBranchId,
  };
}

/** The deterministic character index: the fact snapshot's characters, exactly.
 * The profiles A5 emits are one-per-entry over precisely this set. */
export function characterIndex(model: ReadModel): readonly CharacterOccurrenceFact[] {
  return model.factSnapshot.characters;
}

/** The real counterpart id universe a rule may address — the decoded character
 * set, exactly. An address to any id outside this set is rejected. */
export function counterpartIds(model: ReadModel): readonly string[] {
  return model.factSnapshot.characters.map((character) => character.characterId);
}

/**
 * Read one character's whole-game voice evidence, or throw. The occurrence fact
 * is read through the tool surface so the label and fact id are exactly the
 * snapshot's projection; the scene topology is taken from the decode fact. A
 * character absent from the snapshot fails loud (`unknown-character`); one whose
 * occurrence binds no line fails loud (`no-evidence`) rather than yielding a
 * profile with nothing to cite.
 */
export function readCharacterVoiceEvidence(
  model: ReadModel,
  context: A5Context,
  character: CharacterOccurrenceFact,
): CharacterVoiceEvidence {
  const result = decodeGetCharacterOccurrences(model, a5Caller(context), {
    characterId: character.characterId,
    maxRows: MAX_ROWS,
    maxBytes: MAX_BYTES,
  });
  const fact = result.facts[0];
  if (!fact || fact.value.characterId !== character.characterId) {
    throw new A5RoleError(
      "unknown-character",
      `character ${character.characterId} has no occurrence fact in this snapshot`,
    );
  }
  if (fact.value.totalLines === 0) {
    throw new A5RoleError(
      "no-evidence",
      `character ${character.characterId} speaks no line; a voice profile would have nothing to cite`,
    );
  }
  return {
    characterId: character.characterId,
    decodedLabel: fact.value.decodedLabel,
    occurrenceFactId: fact.factId,
    sceneIds: character.sceneIds,
    scope: { kind: "global" },
  };
}
