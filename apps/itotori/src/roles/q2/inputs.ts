// The input the Voice Reviewer is allowed to see, and the decode-derived
// position everything it judges is keyed to.
//
// The Voice Reviewer judges ONE thing: whether the candidate keeps the speaker's
// VOICE and REGISTER CONTINUOUS with the localized granular voice BIBLE and the
// speaker's ACCEPTED TARGET HISTORY at the EXACT counterpart/route/play position.
// Meaning and every engine/render fault are OTHER lanes' rubrics.
//
// The POSITION is the spine of the lane and it is DETERMINISTIC: the counterpart
// being addressed, the route in play, and the decoded play order are all
// DECODE-DERIVED facts, never model claims — `derivation` is pinned to `decode`
// so a fabricated position cannot even parse. Which bible rules apply, and which
// accepted history the candidate must stay continuous with, are COMPUTED from
// that position — the model never gets to choose either. That is what keeps the
// judgement anchored to where the line actually occurs.

import { z } from "zod";
import {
  IdentifierSchema,
  NonEmptyTextSchema,
  NonNegativeIntegerSchema,
  Sha256Schema,
} from "../../contracts/index.js";

/** The provenance the position MUST carry: it is a decode fact, not a model
 * claim. Pinned as a literal so a non-decode position fails to parse. */
export const VOICE_POSITION_DERIVATION = "decode" as const;

/** The deterministic, decode-derived position of the unit under review: which
 * counterpart the speaker addresses (null = base register / no addressee), which
 * route is in play, and the decoded play order. Nothing here is model-supplied. */
export const VoicePositionSchema = z
  .object({
    derivation: z.literal(VOICE_POSITION_DERIVATION),
    counterpartId: IdentifierSchema.nullable(),
    routeId: IdentifierSchema,
    playOrder: NonNegativeIntegerSchema,
  })
  .strict();

/** The addressing axis a localized voice-bible rule is scoped to — mirroring the
 * granular voice profile: a per-character base register, a per-counterpart
 * address form, a per-route register, or a register shift over a play-order arc. */
export const VoiceRuleScopeSchema = z.enum(["character", "counterpart", "route", "arc"]);

/** One localized voice-bible rule (the A5 voice profile rendered into the target
 * language), addressable at a position. `register` is the localized prose the
 * candidate must stay continuous with; the scope fields say WHERE it applies. */
export const VoiceBibleRuleSchema = z
  .object({
    ruleId: IdentifierSchema,
    scope: VoiceRuleScopeSchema,
    counterpartId: IdentifierSchema.nullable(),
    routeId: IdentifierSchema.nullable(),
    fromPlayOrder: NonNegativeIntegerSchema.nullable(),
    toPlayOrder: NonNegativeIntegerSchema.nullable(),
    register: NonEmptyTextSchema,
  })
  .strict();

/** One accepted target line in the speaker's history — a line already accepted at
 * a decoded counterpart/route/play position. The candidate's voice is judged
 * CONTINUOUS with the applicable ones; a FAIL cites the one it violated. */
export const AcceptedTargetLineSchema = z
  .object({
    historyId: IdentifierSchema,
    unitId: IdentifierSchema,
    counterpartId: IdentifierSchema.nullable(),
    routeId: IdentifierSchema,
    playOrder: NonNegativeIntegerSchema,
    text: NonEmptyTextSchema,
  })
  .strict();

/** Which reviewable slice this unit is. First appearances, register shifts, and
 * stratified samples are ALL reviewable — the selection is decode-driven and the
 * lane processes each the same way. */
export const Q2SampleKindSchema = z.enum([
  "first-appearance",
  "register-shift",
  "stratified-sample",
]);

/** The complete voice-continuity review input for one unit. */
export const Q2ReviewInputSchema = z
  .object({
    unitId: IdentifierSchema,
    localizationSnapshotId: Sha256Schema,
    speakerId: IdentifierSchema,
    candidateTarget: NonEmptyTextSchema,
    position: VoicePositionSchema,
    sampleKind: Q2SampleKindSchema,
    bibleRules: z.array(VoiceBibleRuleSchema).max(1_024),
    acceptedHistory: z.array(AcceptedTargetLineSchema).max(4_096),
  })
  .strict();

export type VoicePosition = z.infer<typeof VoicePositionSchema>;
export type VoiceRuleScope = z.infer<typeof VoiceRuleScopeSchema>;
export type VoiceBibleRule = z.infer<typeof VoiceBibleRuleSchema>;
export type AcceptedTargetLine = z.infer<typeof AcceptedTargetLineSchema>;
export type Q2SampleKind = z.infer<typeof Q2SampleKindSchema>;
export type Q2ReviewInput = z.infer<typeof Q2ReviewInputSchema>;

/** Thrown when a position that is not decode-derived reaches the lane. The
 * position is a deterministic fact; the reviewer never invents or trusts one. */
export class Q2PositionError extends Error {
  constructor(detail: string) {
    super(`voice reviewer position must be decode-derived: ${detail}`);
    this.name = "Q2PositionError";
  }
}

/** Prove the position is a decode fact before anything is keyed to it. The schema
 * literal already refuses a non-decode position; this is the explicit last gate
 * the prompt and request run so the guarantee is visible at the call boundary. */
export function assertPositionDecodeDerived(input: Q2ReviewInput): void {
  if (input.position.derivation !== VOICE_POSITION_DERIVATION) {
    throw new Q2PositionError("position carries no decode provenance");
  }
}

/** The bible rules that APPLY at the decode-derived position. Applicability is
 * computed from the position, never from the model: a character rule always
 * applies; a counterpart rule only when it names this counterpart; a route rule
 * only on this route; an arc rule only when the play order falls in its window. */
export function applicableBibleRules(input: Q2ReviewInput): readonly VoiceBibleRule[] {
  const { counterpartId, routeId, playOrder } = input.position;
  return input.bibleRules.filter((rule) => {
    switch (rule.scope) {
      case "character":
        return true;
      case "counterpart":
        return counterpartId !== null && rule.counterpartId === counterpartId;
      case "route":
        return rule.routeId === routeId;
      case "arc":
        return (
          rule.fromPlayOrder !== null &&
          rule.toPlayOrder !== null &&
          playOrder >= rule.fromPlayOrder &&
          playOrder <= rule.toPlayOrder
        );
      default:
        return false;
    }
  });
}

/** The accepted history the candidate must stay CONTINUOUS with at this position:
 * strictly-prior lines that either establish the base register (no counterpart,
 * any route) or share this counterpart on this route. Computed from the decode-
 * derived position — a future line, or a different counterpart/route, is not it. */
export function historyAtPosition(input: Q2ReviewInput): readonly AcceptedTargetLine[] {
  const { counterpartId, routeId, playOrder } = input.position;
  return input.acceptedHistory.filter((line) => {
    if (line.playOrder >= playOrder) return false;
    if (line.counterpartId === null) return true;
    return line.routeId === routeId && line.counterpartId === counterpartId;
  });
}

/** Parse the voice-continuity review shape. A malformed or non-decode position is
 * rejected structurally; the returned input is safe to key the lane to. */
export function parseQ2ReviewInput(raw: unknown): Q2ReviewInput {
  return Q2ReviewInputSchema.parse(raw);
}
