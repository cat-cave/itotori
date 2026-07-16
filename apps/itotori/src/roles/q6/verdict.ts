// Interpret the Adjudicator's dual-order verdicts and route them.
//
// Each ordered presentation yields a production ReviewVerdict (strict PASS /
// FAIL / CANNOT_ASSESS). This module:
//   - validates each order's verdict against the schema + shared reviewer law;
//   - requires every citation to RESOLVE to the supplied contest evidence;
//   - derives the winning side from which position's evidence was cited (so
//     same-model self-bias is MEASURED, not hidden);
//   - compares A/B vs B/A: agreement yields one BINDING verdict; a flip or
//     CANNOT_ASSESS yields a typed HUMAN-ESCALATION artifact;
//   - records the order-debias measurement on every outcome path.
//
// Only a binding PASS may finalize. Escalation, order-flip, and invalid never do.

import { z } from "zod";
import {
  IdentifierSchema,
  ReviewVerdictSchema,
  Sha256Schema,
  ShortTextSchema,
  type ReviewVerdict,
} from "../../contracts/index.js";
import { specialistFor, type ValidationIssue } from "../../roster/index.js";
import { sideOwningEvidence, type Q6PositionLabel, type Q6ReviewInput } from "./inputs.js";
import type { Q6PresentationOrder } from "./prompt.js";

const Q6_ROLE = "Q6" as const;

/** Categories a FAIL adjudication may name. `subjective-conflict` is the home
 * category; the model may also preserve a meaning/voice/term category that the
 * winning position already asserted, but never an engine/render category. */
export const Q6_ADJUDICATION_CATEGORIES: readonly ReviewVerdict["category"][] = [
  "subjective-conflict",
  "mistranslation",
  "omission",
  "addition",
  "referent",
  "register",
  "character-voice",
  "term-sense",
  "new-coinage",
  "callback",
  "foreshadow",
  "relationship",
  "route-arc",
];

export type EvidenceResolution = { readonly resolved: boolean; readonly visible: boolean };
export type EvidenceResolver = (evidenceId: string) => EvidenceResolution;

/** Build an evidence resolver over the contest's real cited evidence. */
export function contestEvidenceResolver(input: Q6ReviewInput): EvidenceResolver {
  const visible = new Set(
    input.positions.flatMap((position) => position.evidence.map((item) => item.evidenceId)),
  );
  return (evidenceId) =>
    visible.has(evidenceId)
      ? { resolved: true, visible: true }
      : { resolved: false, visible: false };
}

/** Order-debias measurement: A/B vs B/A agreement and which side won each way.
 * Self-bias is observable here — never suppressed. */
export const Q6OrderDebiasSchema = z
  .object({
    abWinner: z.enum(["A", "B"]).nullable(),
    baWinner: z.enum(["A", "B"]).nullable(),
    ordersAgree: z.boolean(),
    /** The side that binds when orders agree; null on flip / cannot-assess. */
    bindingSide: z.enum(["A", "B"]).nullable(),
    abVerdict: z.enum(["PASS", "FAIL", "CANNOT_ASSESS", "invalid", "missing"]),
    baVerdict: z.enum(["PASS", "FAIL", "CANNOT_ASSESS", "invalid", "missing"]),
  })
  .strict();

export type Q6OrderDebias = z.infer<typeof Q6OrderDebiasSchema>;

/** Typed human-escalation artifact when Q6 cannot emit a stable binding. */
export const Q6_HUMAN_ESCALATION_SCHEMA_VERSION = "itotori.q6.human-escalation.v1" as const;

export const Q6HumanEscalationSchema = z
  .object({
    schemaVersion: z.literal(Q6_HUMAN_ESCALATION_SCHEMA_VERSION),
    unitId: IdentifierSchema,
    localizationSnapshotId: Sha256Schema,
    reason: z.enum([
      "order-flip",
      "cannot-assess",
      "invalid-order-verdict",
      "mixed-side-citations",
      "dispatch-failure",
    ]),
    orderDebias: Q6OrderDebiasSchema,
    evidenceIds: z.array(IdentifierSchema).max(1_024),
    note: ShortTextSchema,
  })
  .strict();

export type Q6HumanEscalation = z.infer<typeof Q6HumanEscalationSchema>;

/** Where a completed dual-order adjudication routes. */
export type Q6Disposition = "finalize" | "repair" | "escalate" | "invalid";

/** One order's interpreted judgement (before the A/B vs B/A fold). */
export interface Q6OrderJudgement {
  readonly order: Q6PresentationOrder;
  readonly verdict: ReviewVerdict | null;
  readonly winner: Q6PositionLabel | null;
  readonly issues: readonly ValidationIssue[];
  readonly valid: boolean;
}

/** The folded dual-order outcome: one binding verdict OR a human-escalation. */
export interface Q6Interpretation {
  readonly disposition: Q6Disposition;
  /** Binding production verdict when orders agree; null on escalation. */
  readonly verdict: ReviewVerdict | null;
  readonly escalation: Q6HumanEscalation | null;
  readonly orderDebias: Q6OrderDebias;
  readonly issues: readonly ValidationIssue[];
  readonly orderJudgements: readonly Q6OrderJudgement[];
}

/** Project the production verdict into the reviewer-shape so the shared
 * "CANNOT_ASSESS never passes" law can judge it. */
function reviewerShapeProjection(verdict: ReviewVerdict): unknown {
  const base = {
    unitId: verdict.unitId,
    category: "adjudication" as const,
    span: null,
    evidenceIds: verdict.evidenceIds,
  };
  if (verdict.verdict === "PASS") {
    return {
      snapshotId: verdict.localizationSnapshotId,
      verdicts: [
        {
          ...base,
          verdict: "PASS",
          severity: "none",
          repairConstraint: null,
          evidenceRequest: null,
        },
      ],
    };
  }
  if (verdict.verdict === "FAIL") {
    return {
      snapshotId: verdict.localizationSnapshotId,
      verdicts: [
        {
          ...base,
          verdict: "FAIL",
          severity: verdict.severity,
          repairConstraint: verdict.repairConstraint,
          evidenceRequest: null,
        },
      ],
    };
  }
  return {
    snapshotId: verdict.localizationSnapshotId,
    verdicts: [
      {
        ...base,
        verdict: "CANNOT_ASSESS",
        severity: "none",
        repairConstraint: null,
        evidenceRequest: verdict.requestedEvidence.at(0) ?? null,
      },
    ],
  };
}

function evidenceIssues(
  verdict: ReviewVerdict,
  resolve: EvidenceResolver,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  verdict.evidenceIds.forEach((evidenceId, index) => {
    const resolution = resolve(evidenceId);
    if (!resolution.resolved) {
      issues.push({
        path: `evidenceIds[${index}]`,
        message: `cited evidence ${evidenceId} does not resolve`,
      });
    } else if (!resolution.visible) {
      issues.push({
        path: `evidenceIds[${index}]`,
        message: `cited evidence ${evidenceId} is not visible in its context`,
      });
    }
  });
  return issues;
}

/** Derive the winning side from cited evidence: all citations must map to one
 * position. Mixed or empty citations yield null (unmeasurable / invalid). */
export function winningSideFromCitations(
  input: Q6ReviewInput,
  evidenceIds: readonly string[],
): Q6PositionLabel | null {
  if (evidenceIds.length === 0) return null;
  const sides = new Set<Q6PositionLabel>();
  for (const evidenceId of evidenceIds) {
    const side = sideOwningEvidence(input, evidenceId);
    if (side === null) return null;
    sides.add(side);
  }
  if (sides.size !== 1) return null;
  return [...sides][0] ?? null;
}

/** Interpret one order's raw model output against the contest evidence. */
export function interpretQ6OrderVerdict(
  rawVerdict: unknown,
  order: Q6PresentationOrder,
  input: Q6ReviewInput,
  resolve: EvidenceResolver,
): Q6OrderJudgement {
  const parsed = ReviewVerdictSchema.safeParse(rawVerdict);
  if (!parsed.success) {
    return {
      order,
      verdict: null,
      winner: null,
      issues: [
        { path: "output", message: "adjudicator output is not a schema-valid review verdict" },
      ],
      valid: false,
    };
  }
  const verdict = parsed.data;
  if (verdict.roleId !== Q6_ROLE || verdict.rubric !== "adjudication") {
    return {
      order,
      verdict,
      winner: null,
      issues: [{ path: "roleId", message: "verdict is not a Q6 adjudication verdict" }],
      valid: false,
    };
  }
  if (verdict.unitId !== input.unitId) {
    return {
      order,
      verdict,
      winner: null,
      issues: [{ path: "unitId", message: "verdict unit does not match the contested unit" }],
      valid: false,
    };
  }

  const issues: ValidationIssue[] = [];
  issues.push(...specialistFor(Q6_ROLE).validate(reviewerShapeProjection(verdict)));
  if (verdict.verdict === "FAIL" && !Q6_ADJUDICATION_CATEGORIES.includes(verdict.category)) {
    issues.push({
      path: "category",
      message: `FAIL category ${verdict.category} is outside the adjudication rubric`,
    });
  }
  issues.push(...evidenceIssues(verdict, resolve));

  // CANNOT_ASSESS is a valid order result (routes to escalation) but has no side.
  if (verdict.verdict === "CANNOT_ASSESS") {
    return {
      order,
      verdict,
      winner: null,
      issues,
      valid: issues.length === 0,
    };
  }

  const winner = winningSideFromCitations(input, verdict.evidenceIds);
  if (winner === null) {
    issues.push({
      path: "evidenceIds",
      message:
        "decisive adjudication must cite evidence from exactly one contested position so the winning side is measurable",
    });
  }

  return {
    order,
    verdict,
    winner,
    issues,
    valid: issues.length === 0,
  };
}

function verdictKind(judgement: Q6OrderJudgement | undefined): Q6OrderDebias["abVerdict"] {
  if (!judgement) return "missing";
  if (!judgement.valid || judgement.verdict === null) return "invalid";
  return judgement.verdict.verdict;
}

function sameBindingContent(left: ReviewVerdict, right: ReviewVerdict): boolean {
  if (left.verdict !== right.verdict) return false;
  if (left.verdict === "PASS" && right.verdict === "PASS") return true;
  if (left.verdict === "CANNOT_ASSESS" && right.verdict === "CANNOT_ASSESS") return true;
  if (left.verdict === "FAIL" && right.verdict === "FAIL") {
    return (
      left.severity === right.severity &&
      left.category === right.category &&
      left.span.text === right.span.text
    );
  }
  return false;
}

/** Fold the two ordered judgements into one binding verdict or a typed human
 * escalation, and always record the order-debias / self-bias measurement. */
export function foldQ6OrderJudgements(
  input: Q6ReviewInput,
  judgements: readonly Q6OrderJudgement[],
): Q6Interpretation {
  const ab = judgements.find((item) => item.order === "A-then-B");
  const ba = judgements.find((item) => item.order === "B-then-A");
  const issues = [...(ab?.issues ?? []), ...(ba?.issues ?? [])];

  const orderDebias: Q6OrderDebias = Q6OrderDebiasSchema.parse({
    abWinner: ab?.winner ?? null,
    baWinner: ba?.winner ?? null,
    ordersAgree: false,
    bindingSide: null,
    abVerdict: verdictKind(ab),
    baVerdict: verdictKind(ba),
  });

  const escalate = (
    reason: Q6HumanEscalation["reason"],
    note: string,
    disposition: Q6Disposition = "escalate",
  ): Q6Interpretation => {
    const evidenceIds = input.positions.flatMap((position) =>
      position.evidence.map((item) => item.evidenceId),
    );
    const escalation = Q6HumanEscalationSchema.parse({
      schemaVersion: Q6_HUMAN_ESCALATION_SCHEMA_VERSION,
      unitId: input.unitId,
      localizationSnapshotId: input.localizationSnapshotId,
      reason,
      orderDebias,
      evidenceIds,
      note,
    });
    return {
      disposition,
      verdict: null,
      escalation,
      orderDebias,
      issues,
      orderJudgements: judgements,
    };
  };

  if (!ab || !ba) {
    return escalate("invalid-order-verdict", "both presentation orders are required");
  }
  // Prefer the specific mixed-side reason when citations do not pin one position —
  // that failure mode is about measurable self-bias, not a generic schema miss.
  const mixedSideIssue = issues.some((issue) =>
    /exactly one contested position/u.test(issue.message),
  );
  if (!ab.valid || !ba.valid || ab.verdict === null || ba.verdict === null) {
    return escalate(
      mixedSideIssue ? "mixed-side-citations" : "invalid-order-verdict",
      mixedSideIssue
        ? "winning side was not measurable from exclusive position citations"
        : "one or both order judgements failed schema or evidence checks",
      "invalid",
    );
  }
  if (ab.verdict.verdict === "CANNOT_ASSESS" || ba.verdict.verdict === "CANNOT_ASSESS") {
    return escalate("cannot-assess", "at least one ordered presentation could not adjudicate");
  }
  if (ab.winner === null || ba.winner === null) {
    return escalate(
      "mixed-side-citations",
      "winning side was not measurable from exclusive position citations",
      "invalid",
    );
  }

  // Self-bias measurement: do the two orders pick the same side AND the same
  // binding content? Agreement → bind; flip → human escalation (flip is a signal).
  const sidesAgree = ab.winner === ba.winner;
  const contentAgrees = sameBindingContent(ab.verdict, ba.verdict);
  const ordersAgree = sidesAgree && contentAgrees;
  const measured: Q6OrderDebias = Q6OrderDebiasSchema.parse({
    ...orderDebias,
    ordersAgree,
    bindingSide: ordersAgree ? ab.winner : null,
  });

  if (!ordersAgree) {
    const escalation = Q6HumanEscalationSchema.parse({
      schemaVersion: Q6_HUMAN_ESCALATION_SCHEMA_VERSION,
      unitId: input.unitId,
      localizationSnapshotId: input.localizationSnapshotId,
      reason: "order-flip",
      orderDebias: measured,
      evidenceIds: input.positions.flatMap((position) =>
        position.evidence.map((item) => item.evidenceId),
      ),
      note: `order flip or content disagreement: A-then-B sided with ${ab.winner}, B-then-A sided with ${ba.winner}`,
    });
    return {
      disposition: "escalate",
      verdict: null,
      escalation,
      orderDebias: measured,
      issues,
      orderJudgements: judgements,
    };
  }

  // Stable binding: use the A-then-B verdict as the canonical binding record;
  // B-then-A agreed. Mark provisional? Spec says mark provisional/escalatable
  // where uncertain — a clean dual-order agreement is the binding path.
  const binding = ab.verdict;
  if (binding.verdict === "PASS") {
    return {
      disposition: "finalize",
      verdict: binding,
      escalation: null,
      orderDebias: measured,
      issues,
      orderJudgements: judgements,
    };
  }
  return {
    disposition: "repair",
    verdict: binding,
    escalation: null,
    orderDebias: measured,
    issues,
    orderJudgements: judgements,
  };
}

/** Interpret a single raw verdict (test helper / one-order path). Prefer
 * `foldQ6OrderJudgements` for the production dual-order fold. */
export function interpretQ6Verdict(
  rawVerdict: unknown,
  input: Q6ReviewInput,
  resolve: EvidenceResolver,
): Q6Interpretation {
  const judgement = interpretQ6OrderVerdict(rawVerdict, "A-then-B", input, resolve);
  // A lone order is never sufficient for a binding adjudication.
  return foldQ6OrderJudgements(input, [
    judgement,
    {
      order: "B-then-A",
      verdict: null,
      winner: null,
      issues: [{ path: "order", message: "B-then-A presentation was not run" }],
      valid: false,
    },
  ]);
}

/** The one place acceptance is decided. Only a clean dual-order PASS finalizes. */
export function canFinalize(interpretation: Q6Interpretation): boolean {
  return interpretation.disposition === "finalize";
}
