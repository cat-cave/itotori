// The Cultural Adaptation Analyst — the model-calling analyst role, end to end.
//
// runAdaptationAnalyst runs across the COMPLETE deterministically-flagged
// candidate set — exactly the units the pre-pass flagged, never an unflagged line
// — and for each flagged unit composes the prompt, assembles the strict CallSpec,
// dispatches it through the sole ZDR boundary (route-bound in every mode), and
// returns a CITED, SOURCE-LANGUAGE adaptation note whose communicative function
// and bounded options the model authored but whose flagged markers are copied
// verbatim from the byte-derived decode. It records the actually-served (model,
// provider) pair (the model is certified deepseek-v4-flash; the provider is
// recorded telemetry, never a pinned input). A note for an unflagged unit, a
// replacement translation, a target-language object, a note that maps to the
// wrong unit, or any unprovable claim is a HARD failure — never a silent pass.

import { WikiObjectSchema, type CallResult, type CallSpec } from "../../contracts/index.js";
import type { ReadModel } from "../../read-tools/index.js";
import { deepSeekV4FlashProfile, servedModelIsCertified } from "../../llm/role-model-profiles.js";
import { validateWikiObjectClaims } from "../../wiki/claim-validation.js";

import {
  assertFlagByteDerived,
  assertNoteIsFunctionAndOptions,
  assertNoteMapsToFlaggedUnit,
  flagEvidence,
  flaggedAdaptationCandidates,
  type AdaptationNoteObject,
  type FlaggedAdaptationCandidate,
} from "./candidates.js";
import { readAdaptationContext, type AdaptationReadContext } from "./context.js";
import { dispatchAdaptationAnalyst, type AdaptationModelPort } from "./dispatch.js";
import {
  assembleAdaptationCallSpec,
  composeAdaptationPrompt,
  type AdaptationPromptStore,
  type AdaptationRequest,
} from "./spec.js";

export class AdaptationAnalystError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdaptationAnalystError";
  }
}

export interface AdaptationAnalystDeps {
  readonly model: AdaptationModelPort;
  readonly storePrompt: AdaptationPromptStore;
  /** The immutable read model: the flagged set is derived from its decoded
   * bundle, and every note's claims are re-proven against its fact snapshot. */
  readonly readModel: ReadModel;
}

/** One authored note plus the byte-derived flag it maps to and the served pair. */
export interface AdaptationNoteResult {
  readonly note: AdaptationNoteObject;
  readonly spec: CallSpec;
  readonly served: CallResult["served"];
  /** The typed RB-025 pages read before this note was authored. */
  readonly context: AdaptationReadContext;
  readonly evidence: ReturnType<typeof flagEvidence>;
}

/** The whole-run result: one note per flagged unit and the exact flagged set the
 * run covered, so a consumer can confirm no unflagged line was processed. */
export interface AdaptationAnalystResult {
  readonly notes: readonly AdaptationNoteResult[];
  readonly flaggedUnitFactIds: readonly string[];
}

/**
 * Run the analyst for ONE flagged candidate. Emits a cited source-language
 * adaptation note or throws a loud error: a non-success result, a wrong served
 * model, a non-adaptation-note terminal, a target-language / replacement object,
 * a note mapping to the wrong unit, or any unprovable claim is a hard failure.
 */
export async function runAdaptationNote(
  request: AdaptationRequest,
  candidate: FlaggedAdaptationCandidate,
  deps: AdaptationAnalystDeps,
): Promise<AdaptationNoteResult> {
  // The flag itself must be byte-derived — a marker the bytes never carried, or a
  // wordplay flag with no ruby span, is refused before a call is spent.
  assertFlagByteDerived(candidate, deps.readModel);
  // The deterministic pre-pass selects the subject; the role then obtains its
  // authoring context through RB-025's typed, visibility-checked read tools.
  const context = readAdaptationContext(deps.readModel, candidate);

  const prompt = composeAdaptationPrompt(request, candidate, context);
  const systemRef = await deps.storePrompt(prompt.system, "system");
  const userRef = await deps.storePrompt(prompt.user, "user");
  const spec = assembleAdaptationCallSpec(request, candidate, { systemRef, userRef });

  const result = await dispatchAdaptationAnalyst(spec, deps.model);
  if (result.status !== "success") {
    throw new AdaptationAnalystError(
      `adaptation dispatch did not succeed: ${result.status}/${result.failureKind}`,
    );
  }
  // Unknown served metadata is explicitly accepted while the upstream TanStack
  // event surface is incomplete. A reported pair must still match the profile.
  if (
    result.served.status === "confirmed" &&
    !servedModelIsCertified(result.served.model, deepSeekV4FlashProfile.model)
  ) {
    throw new AdaptationAnalystError(
      `adaptation analyst was served ${result.served.model}, not ${deepSeekV4FlashProfile.model}`,
    );
  }

  const parsed = WikiObjectSchema.safeParse(result.value);
  if (!parsed.success || parsed.data.kind !== "adaptation-note") {
    throw new AdaptationAnalystError("terminal output is not an adaptation-note WikiObject");
  }
  const note = parsed.data;

  // A note is an analysis, not a rendering: source language, function + bounded
  // options, and mapped to exactly the flagged unit.
  assertNoteIsFunctionAndOptions(note, request.sourceLanguage);
  assertNoteMapsToFlaggedUnit(note, candidate);
  // Provenance identifiers are SYSTEM-stamped in the wiki-build runner before the
  // object is accepted (the model cannot reliably author the snapshot hash).

  // Claim validation: every claim must re-prove against the immutable snapshot. A
  // note citing a unit that does not exist throws here — never shipped.
  validateWikiObjectClaims(note, deps.readModel);

  return {
    note,
    spec,
    served: result.served,
    context,
    evidence: flagEvidence(candidate),
  };
}

/**
 * Run the analyst across the COMPLETE flagged candidate set. The set is the
 * pre-pass's deterministic flag over the read model's decoded bundle — exactly
 * the flagged units, in stable order. An unflagged line is never in the set and
 * so is never processed: there is no per-line fan-out. Returns one note per
 * flagged unit plus the exact flagged set the run covered.
 */
export async function runAdaptationAnalyst(
  request: AdaptationRequest,
  deps: AdaptationAnalystDeps,
): Promise<AdaptationAnalystResult> {
  const candidates = flaggedAdaptationCandidates(deps.readModel);
  const notes: AdaptationNoteResult[] = [];
  for (const candidate of candidates) {
    notes.push(await runAdaptationNote(request, candidate, deps));
  }
  return {
    notes,
    flaggedUnitFactIds: candidates.map((candidate) => candidate.unitFactId),
  };
}
