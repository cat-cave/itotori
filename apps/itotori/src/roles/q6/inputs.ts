// The blinded, bounded-trigger input the Adjudicator is allowed to see.
//
// Q6 runs ONLY for one genuine subjective / high-impact contest AFTER the
// deterministic facts and factual reviewers have settled factual issues. Its
// whole input is the unit under contest, two BLINDED contested positions (each
// a verdict + the real cited evidence that supports it), and the trigger that
// proves the contest is in scope. Author / model / provider identity of either
// position is forbidden — the adjudicator judges the claims, not who made them.
//
// The schema is `.strict()` so an unexpected key is rejected structurally, and
// `assertBlinded` deep-scans for identity keys at any depth. The bounded trigger
// (`contestEligible`) is checked separately so a non-subjective or low-impact
// contest never reaches a model call.

import { z } from "zod";
import {
  IdentifierSchema,
  NonEmptyTextSchema,
  Sha256Schema,
  ShortTextSchema,
  SourceSpanSchema,
} from "../../contracts/index.js";

/** Impact levels the orchestrator may declare. Only `high` is in Q6's scope. */
export const Q6_IMPACT_LEVELS = ["high", "low", "none"] as const;
export const Q6ImpactSchema = z.enum(Q6_IMPACT_LEVELS);
export type Q6Impact = z.infer<typeof Q6ImpactSchema>;

/** Stable blinded labels for the two contested positions. These are presentation
 * labels only — they do not encode which reviewer or model produced the claim. */
export const Q6_POSITION_LABELS = ["A", "B"] as const;
export const Q6PositionLabelSchema = z.enum(Q6_POSITION_LABELS);
export type Q6PositionLabel = z.infer<typeof Q6PositionLabelSchema>;

/** One piece of real cited evidence attached to a contested position. The
 * adjudicator must be able to ground a citation against these texts. */
export const Q6EvidenceItemSchema = z
  .object({
    evidenceId: IdentifierSchema,
    text: NonEmptyTextSchema,
  })
  .strict();

/** One blinded contested position: the claim, its verdict shape, and the real
 * evidence it cites. No author, model, provider, or role identity is present. */
export const Q6ContestedPositionSchema = z
  .object({
    label: Q6PositionLabelSchema,
    /** Free-text claim the position asserts about the unit (not an identity). */
    claimSummary: NonEmptyTextSchema,
    verdict: z.enum(["PASS", "FAIL", "CANNOT_ASSESS"]),
    severity: z.enum(["none", "minor", "major", "critical"]),
    category: ShortTextSchema.nullable(),
    span: SourceSpanSchema.nullable(),
    evidence: z.array(Q6EvidenceItemSchema).min(1).max(1_024),
    repairConstraint: ShortTextSchema.nullable(),
  })
  .strict();

/** The bounded trigger: Q6 fires only for a genuine subjective conflict of high
 * impact after facts have settled. Anything else is out of scope. */
export const Q6ContestTriggerSchema = z
  .object({
    /** True only when the residual disagreement is genuinely subjective. */
    subjectiveConflict: z.boolean(),
    impact: Q6ImpactSchema,
    /** True when deterministic facts + factual reviewers have already settled
     * factual issues; Q6 never re-litigates settled facts. */
    factsSettled: z.boolean(),
  })
  .strict();

/** The complete adjudication input for one contested unit. */
export const Q6ReviewInputSchema = z
  .object({
    unitId: IdentifierSchema,
    localizationSnapshotId: Sha256Schema,
    bibleRenderingIds: z.array(IdentifierSchema).max(1_024),
    trigger: Q6ContestTriggerSchema,
    /** Exactly two positions, labelled A and B, with distinct labels. */
    positions: z.array(Q6ContestedPositionSchema).length(2),
  })
  .strict()
  .superRefine((value, context) => {
    const labels = value.positions.map((position) => position.label);
    if (new Set(labels).size !== 2) {
      context.addIssue({
        code: "custom",
        path: ["positions"],
        message: "contested positions must carry distinct A/B labels",
      });
    }
  });

export type Q6EvidenceItem = z.infer<typeof Q6EvidenceItemSchema>;
export type Q6ContestedPosition = z.infer<typeof Q6ContestedPositionSchema>;
export type Q6ContestTrigger = z.infer<typeof Q6ContestTriggerSchema>;
export type Q6ReviewInput = z.infer<typeof Q6ReviewInputSchema>;

/** Author / model / provider identity keys the adjudicator must never see. */
export const FORBIDDEN_BLINDING_KEYS: readonly string[] = [
  "author",
  "authorid",
  "authoredby",
  "drafter",
  "drafterid",
  "writer",
  "translator",
  "translatorid",
  "model",
  "modelid",
  "modelprofile",
  "provider",
  "providerid",
  "agent",
  "agentid",
  "reviewerid",
  "reviewerrole",
  "roleid",
  "servedby",
];

/** Thrown when an identity key reaches the blinded adjudicator. */
export class Q6BlindingError extends Error {
  constructor(readonly path: string) {
    super(`adjudicator is blinded: identity key at ${path} is not permitted`);
    this.name = "Q6BlindingError";
  }
}

/** Thrown when the contest is outside Q6's bounded trigger. */
export class Q6IneligibleContestError extends Error {
  constructor(detail: string) {
    super(`adjudicator refuses non-eligible contest: ${detail}`);
    this.name = "Q6IneligibleContestError";
  }
}

/** Deep-scan a raw payload and throw if any identity key is present. */
export function assertBlinded(raw: unknown, path = "$"): void {
  if (Array.isArray(raw)) {
    raw.forEach((item, index) => assertBlinded(item, `${path}[${index}]`));
    return;
  }
  if (raw === null || typeof raw !== "object") return;
  for (const [key, value] of Object.entries(raw)) {
    if (FORBIDDEN_BLINDING_KEYS.includes(key.toLowerCase())) {
      throw new Q6BlindingError(`${path}.${key}`);
    }
    assertBlinded(value, `${path}.${key}`);
  }
}

/** True when the contest is a genuine subjective high-impact conflict after
 * facts have settled — the only condition under which Q6 may fire. */
export function contestEligible(input: Q6ReviewInput): boolean {
  return (
    input.trigger.subjectiveConflict === true &&
    input.trigger.impact === "high" &&
    input.trigger.factsSettled === true
  );
}

/** Prove the bounded trigger holds. A non-subjective, low-impact, or pre-fact
 * contest is refused rather than adjudicated. */
export function assertContestEligible(input: Q6ReviewInput): void {
  if (!input.trigger.subjectiveConflict) {
    throw new Q6IneligibleContestError("conflict is not marked as subjective");
  }
  if (input.trigger.impact !== "high") {
    throw new Q6IneligibleContestError(
      `impact is ${input.trigger.impact}; only high-impact contests are adjudicated`,
    );
  }
  if (!input.trigger.factsSettled) {
    throw new Q6IneligibleContestError(
      "facts are not yet settled; factual lanes must finish first",
    );
  }
}

/** Position lookup by blinded label. */
export function positionByLabel(input: Q6ReviewInput, label: Q6PositionLabel): Q6ContestedPosition {
  const found = input.positions.find((position) => position.label === label);
  if (!found) throw new Error(`contested position ${label} is absent`);
  return found;
}

/** Every evidence id supplied with the contest, for citation resolution. */
export function allContestEvidenceIds(input: Q6ReviewInput): readonly string[] {
  return input.positions.flatMap((position) => position.evidence.map((item) => item.evidenceId));
}

/** Map an evidence id to the position that owns it, or null if unknown. */
export function sideOwningEvidence(
  input: Q6ReviewInput,
  evidenceId: string,
): Q6PositionLabel | null {
  for (const position of input.positions) {
    if (position.evidence.some((item) => item.evidenceId === evidenceId)) {
      return position.label;
    }
  }
  return null;
}

/** Parse-and-blind: validate shape AND prove nothing carries identity. */
export function parseQ6ReviewInput(raw: unknown): Q6ReviewInput {
  assertBlinded(raw);
  return Q6ReviewInputSchema.parse(raw);
}
