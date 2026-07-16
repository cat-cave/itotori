// The whole-game hindsight speaker-resolution pass.
//
// A10 examines EVERY unit through the strict read surface. A unit whose speaker
// the decode already fixed is REFUSED (never hypothesized); a unit with no
// speaker is skipped; every genuinely `parser-unknown` or `reader-unknown` unit
// gets ONE cited speaker-hypothesis. For each unknown unit the model proposes a
// candidate + reveal scene from the whole-game hindsight pools; the module
// re-resolves both against the snapshot, then assembles and re-proves the
// hypothesis. A coverage guard asserts exactly one hypothesis per unknown unit —
// none dropped, none duplicated.

import type { ReadModel } from "../../read-tools/index.js";
import type { WikiObject } from "../../contracts/index.js";

import { assembleSpeakerHypothesis } from "./assemble.js";
import {
  hindsightCandidateIds,
  hindsightRevealSceneIds,
  readUnknownSpeakerUnits,
  verifyCandidateCharacter,
  verifyRevealScene,
} from "./units.js";
import { A10RoleError, type A10Context, type A10ModelCaller } from "./types.js";

/** One unit's hypothesis result: the unknown unit and its provisional hypothesis. */
export interface A10HypothesisResult {
  readonly unitId: string;
  readonly hypothesis: WikiObject;
}

/** The whole pass over the unknown-speaker units. */
export interface A10ResolveResult {
  readonly hypotheses: readonly A10HypothesisResult[];
  /** Every genuinely-unknown unit the pass hypothesized, in play order. */
  readonly hypothesizedUnitIds: readonly string[];
}

/**
 * Emit one cited speaker-hypothesis for every genuinely-unknown-speaker unit in
 * the snapshot. Throws {@link A10RoleError} `coverage-gap` if the emitted count
 * does not equal the unknown-unit count (a defensive guard — the loop covers each
 * unknown unit). Known speakers are refused by construction: they never enter the
 * unknown-unit set.
 */
export async function resolveSpeakers(
  model: ReadModel,
  context: A10Context,
  modelCaller: A10ModelCaller,
): Promise<A10ResolveResult> {
  const unknownUnits = readUnknownSpeakerUnits(model, context);
  const candidateCharacterIds = hindsightCandidateIds(model);
  const revealSceneIds = hindsightRevealSceneIds(model, context);

  const hypotheses: A10HypothesisResult[] = [];
  for (const unit of unknownUnits) {
    const draft = await modelCaller({
      unit,
      sourceLanguage: model.sourceLanguage,
      candidateCharacterIds,
      revealSceneIds,
    });
    const candidateOccurrenceFactId = verifyCandidateCharacter(
      model,
      context,
      draft.candidateCharacterId,
    );
    const revealNodeFactId = verifyRevealScene(model, context, draft.revealSceneId);
    const hypothesis = assembleSpeakerHypothesis(
      model,
      context,
      unit,
      draft,
      candidateOccurrenceFactId,
      revealNodeFactId,
    );
    hypotheses.push({ unitId: unit.unitId, hypothesis });
  }

  if (hypotheses.length !== unknownUnits.length) {
    throw new A10RoleError(
      "coverage-gap",
      `emitted ${hypotheses.length} hypotheses for ${unknownUnits.length} unknown-speaker units`,
    );
  }
  return { hypotheses, hypothesizedUnitIds: unknownUnits.map((unit) => unit.unitId) };
}
