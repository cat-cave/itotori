// The whole-roster character background pass.
//
// A8 walks the deterministic character index and emits ONE cited character-
// background per entry — none skipped. For each character it BINDS the caller-
// supplied upstream bio to its authoritative artifact before use, reads the
// whole-game evidence through the local tools, dispatches the background draft,
// and assembles a validated object whose relationships carry real counterparts,
// establishing scenes, and route-reachable scope. The character SET is the
// index's exactly, so coverage equals the decoded characters.

import type { ReadModel } from "../../read-tools/index.js";
import type { WikiObject } from "../../contracts/index.js";

import { assembleCharacterBackground } from "./assemble.js";
import { characterIndex, counterpartIds, readCharacterEvidence } from "./characters.js";
import { verifyBioProvenance } from "./provenance.js";
import { A8RoleError, type A8Context, type A8ModelCaller } from "./types.js";

/** Supplies the upstream character-bio object for one character. The pass binds
 * whatever it returns to its authoritative artifact before consuming it. */
export type A8BioProvider = (characterId: string) => WikiObject;

/** One character's result: the grounded background object. */
export interface A8BackgroundResult {
  readonly characterId: string;
  readonly background: WikiObject;
}

/** The whole pass over the character index. */
export interface A8RosterResult {
  readonly backgrounds: readonly A8BackgroundResult[];
  /** Every character the pass covered, in index order (the full index). */
  readonly coveredCharacterIds: readonly string[];
}

/**
 * Emit one cited character-background for every character in the deterministic
 * index. Throws {@link A8RoleError} if the index is empty (a game with no decoded
 * characters cannot be backgrounded) or if coverage does not equal the index. The
 * upstream bio for each character is provenance-verified BEFORE the model is
 * asked to reason over it, so a fabricated input never reaches a dispatch.
 */
export async function backgroundRoster(
  model: ReadModel,
  context: A8Context,
  modelCaller: A8ModelCaller,
  bios: A8BioProvider,
): Promise<A8RosterResult> {
  const index = characterIndex(model);
  if (index.length === 0) {
    throw new A8RoleError("empty-character-index", "the snapshot carries no decoded characters");
  }
  const counterparts = counterpartIds(model);

  const backgrounds: A8BackgroundResult[] = [];
  for (const character of index) {
    const evidence = readCharacterEvidence(model, context, character);
    const bio = verifyBioProvenance(model, evidence.characterId, bios(evidence.characterId));
    const request = {
      character: evidence,
      bio,
      counterpartIds: counterparts,
      sourceLanguage: model.sourceLanguage,
    };
    const draft = await modelCaller(request);
    const background = assembleCharacterBackground(model, context, evidence, request, draft);
    backgrounds.push({ characterId: evidence.characterId, background });
  }

  const coveredCharacterIds = index.map((character) => character.characterId);
  if (backgrounds.length !== index.length) {
    throw new A8RoleError(
      "coverage-gap",
      `emitted ${backgrounds.length} backgrounds for ${index.length} indexed characters`,
    );
  }
  return { backgrounds, coveredCharacterIds };
}
