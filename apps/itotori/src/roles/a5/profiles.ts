// The whole voice-profile pass.
//
// A5 authors ONE cited voice profile for EVERY character in the deterministic
// index — none skipped. The character set is the decode's, so no model output can
// add or drop a character. For each character A5 reads the whole-game evidence
// through the local tools, builds the decoded occurrence window and the routes the
// character occurs on, dispatches the profile draft, and assembles a validated
// object addressable by character/counterpart/route/arc-range.

import type { ReadModel } from "../../read-tools/index.js";
import type { WikiObject } from "../../contracts/index.js";

import { assembleVoiceProfile } from "./assemble.js";
import { characterIndex, counterpartIds, readCharacterVoiceEvidence } from "./characters.js";
import { characterRouteIds, occurrenceWindow } from "./windows.js";
import { A5RoleError, type A5Context, type A5ModelCaller } from "./types.js";

/** One character's result: the grounded, addressable voice-profile object. */
export interface A5VoiceResult {
  readonly characterId: string;
  readonly profile: WikiObject;
}

/** The whole pass over the character index. */
export interface A5RosterResult {
  readonly profiles: readonly A5VoiceResult[];
  /** Every character id the pass covered — the full index. */
  readonly coveredCharacterIds: readonly string[];
}

/**
 * Emit one cited voice profile for every character in the deterministic index.
 * Throws {@link A5RoleError} if the character index is empty (a game with no
 * decoded characters cannot be voiced) or if coverage does not equal the index (a
 * silently skipped character). The character set is decode-derived, so no model
 * output can add or drop a profile.
 */
export async function voiceProfileRoster(
  model: ReadModel,
  context: A5Context,
  modelCaller: A5ModelCaller,
): Promise<A5RosterResult> {
  const characters = characterIndex(model);
  if (characters.length === 0) {
    throw new A5RoleError("empty-character-index", "the snapshot carries no decoded characters");
  }
  const counterparts = counterpartIds(model);

  const profiles: A5VoiceResult[] = [];
  for (const character of characters) {
    const evidence = readCharacterVoiceEvidence(model, context, character);
    const window = occurrenceWindow(model, evidence.sceneIds);
    const draft = await modelCaller({
      evidence,
      counterpartIds: counterparts,
      routeIds: characterRouteIds(model, window),
      occurrenceUnitIds: window.map((unit) => unit.factId),
      sourceLanguage: model.sourceLanguage,
    });
    const profile = assembleVoiceProfile(model, context, evidence, counterparts, draft);
    profiles.push({ characterId: character.characterId, profile });
  }

  if (profiles.length !== characters.length) {
    throw new A5RoleError(
      "coverage-gap",
      `emitted ${profiles.length} profiles for ${characters.length} characters`,
    );
  }
  return { profiles, coveredCharacterIds: characters.map((character) => character.characterId) };
}
