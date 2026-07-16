// Enumerate the deterministic character index and read each character's
// whole-game evidence through the strict read-tool surface.
//
// The character SET is the fact snapshot's character index EXACTLY — a projection
// of the decode, never a model attribution. For each character A7 reads the
// occurrence fact through `decode_get_character_occurrences` and takes the label,
// the occurrence fact id, and the whole-game unit ids from that INDEX-DERIVED
// result. A character with no citeable unit is a loud failure, never a bio built
// on air.

import {
  decodeGetCharacterOccurrences,
  type ReadModel,
  type ReadToolCaller,
} from "../../read-tools/index.js";
import type { CharacterOccurrenceFact } from "../../prepass/index.js";

import { A7RoleError, A7_ROLE_ID, type A7Context, type CharacterEvidence } from "./types.js";

const MAX_ROWS = 1_000;
const MAX_BYTES = 8_388_608;

/** The A7 caller identity for the local read tools. */
export function a7Caller(context: A7Context): ReadToolCaller {
  return {
    roleId: A7_ROLE_ID,
    routeVisibility: context.routeVisibility,
    localeBranchId: context.localeBranchId,
  };
}

/** The deterministic character index: the fact snapshot's characters, exactly.
 * The bios A7 emits are one-per-entry over precisely this set — none skipped. */
export function characterIndex(model: ReadModel): readonly CharacterOccurrenceFact[] {
  return model.factSnapshot.characters;
}

/**
 * Read one character's whole-game evidence, or throw. The occurrence fact is read
 * through the tool surface so the label, fact id, and unit ids are exactly the
 * snapshot's projection. A character whose profile binds no unit cannot be given
 * a cited bio, so it fails loud (`no-evidence`) rather than yielding a bio with
 * nothing to cite.
 */
export function readCharacterEvidence(
  model: ReadModel,
  context: A7Context,
  character: CharacterOccurrenceFact,
): CharacterEvidence {
  const result = decodeGetCharacterOccurrences(model, a7Caller(context), {
    characterId: character.characterId,
    maxRows: MAX_ROWS,
    maxBytes: MAX_BYTES,
  });
  const fact = result.facts[0];
  if (!fact || fact.value.characterId !== character.characterId) {
    throw new A7RoleError(
      "unknown-character",
      `character ${character.characterId} has no occurrence fact in this snapshot`,
    );
  }
  const notableUnitIds = fact.value.unitIds;
  if (notableUnitIds.length === 0) {
    throw new A7RoleError(
      "no-evidence",
      `character ${character.characterId} speaks in no citeable unit; a bio would have nothing to cite`,
    );
  }
  return {
    characterId: character.characterId,
    decodedLabel: fact.value.decodedLabel,
    occurrenceFactId: fact.factId,
    notableUnitIds: [...notableUnitIds],
    scope: { kind: "global" },
  };
}
