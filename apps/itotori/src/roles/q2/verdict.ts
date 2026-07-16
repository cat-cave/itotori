// Interpret the Voice Reviewer's verdict and route it.
//
// The verdict is the production ReviewVerdict (strict PASS / FAIL /
// CANNOT_ASSESS carrying severity, exact span, category, cited evidence, and a
// repair constraint). This module layers the reviewer-shape validator on top of
// that structural schema and adds the voice-lane guarantees the schema cannot:
//   - the reviewer-shape validator (the shared "a CANNOT_ASSESS is not a pass"
//     law) runs over a faithful projection of the verdict;
//   - a FAIL must name a VOICE category — register or character-voice; a
//     meaning/terminology/continuity/engine category is another lane's finding
//     and is rejected as an invalid verdict;
//   - a FAIL must CITE both the applicable BIBLE RULE at the decode-derived
//     position AND the accepted TARGET HISTORY it violated; a failure missing
//     either citation is INVALID — the lane never fails a line it cannot ground;
//   - every cited evidence id must RESOLVE and be VISIBLE in its context;
//   - only a clean PASS may finalize. A FAIL routes to a voice repair, a
//     CANNOT_ASSESS escalates for more evidence, and neither ever finalizes.

import { ReviewVerdictSchema, type ReviewVerdict } from "../../contracts/index.js";
import { specialistFor, type ValidationIssue } from "../../roster/index.js";
import { applicableBibleRules, historyAtPosition, type Q2ReviewInput } from "./inputs.js";

const Q2_ROLE = "Q2" as const;

/** The production categories that are genuinely about VOICE: the speaker's
 * register and character voice. A FAIL outside this set is another lane's
 * finding, not a voice verdict. */
export const Q2_VOICE_CATEGORIES: readonly ReviewVerdict["category"][] = [
  "register",
  "character-voice",
];

/** Resolve one cited evidence id: does it exist, and is it visible where cited. */
export type EvidenceResolution = { readonly resolved: boolean; readonly visible: boolean };
export type EvidenceResolver = (evidenceId: string) => EvidenceResolution;

/** Which grounding a FAIL actually cited: an applicable bible rule at the position
 * (from the verdict's bible basis) and the accepted history it violated (from the
 * verdict's evidence). A `null` on either side means the FAIL cited none. */
export type VoiceCitationResolution = {
  readonly citedBibleRuleId: string | null;
  readonly citedHistoryId: string | null;
};
export type VoiceCitationResolver = (verdict: ReviewVerdict) => VoiceCitationResolution;

/** The default citation resolver, built from the input and the DECODE-DERIVED
 * position. A cited bible rule counts only if it is applicable AT the position;
 * a cited history line counts only if it is the accepted history at the position.
 * Deterministic over the input — no model text decides applicability. */
export function positionGroundedCitationResolver(input: Q2ReviewInput): VoiceCitationResolver {
  const applicableRuleIds = new Set(applicableBibleRules(input).map((rule) => rule.ruleId));
  const positionHistoryIds = new Set(historyAtPosition(input).map((line) => line.historyId));
  return (verdict) => {
    const citedBibleRuleId =
      verdict.basis.kind === "wiki-first"
        ? (verdict.basis.bibleRenderingIds.find((id) => applicableRuleIds.has(id)) ?? null)
        : null;
    const citedHistoryId = verdict.evidenceIds.find((id) => positionHistoryIds.has(id)) ?? null;
    return { citedBibleRuleId, citedHistoryId };
  };
}

/** Where the verdict routes. Only `finalize` accepts the unit. */
export type Q2Disposition = "finalize" | "repair" | "escalate" | "invalid";

export interface Q2Interpretation {
  readonly disposition: Q2Disposition;
  readonly verdict: ReviewVerdict;
  readonly issues: readonly ValidationIssue[];
  /** The applicable bible rule the FAIL cited, and the accepted history it
   * violated — both resolved against the decode-derived position. Null on a
   * PASS/CANNOT_ASSESS, and null-bearing on an ungrounded (invalid) FAIL. */
  readonly citation: VoiceCitationResolution | null;
}

/** Project the production verdict into the reviewer-shape output so the shared
 * reviewer validator can judge it (the "CANNOT_ASSESS never passes" law). */
function reviewerShapeProjection(verdict: ReviewVerdict): unknown {
  const base = {
    unitId: verdict.unitId,
    category: "voice" as const,
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

/** The FAIL grounding guarantee: a voice FAIL is INVALID unless it cites BOTH the
 * applicable bible rule at the position AND the accepted history it violated. */
function citationIssues(citation: VoiceCitationResolution): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (citation.citedBibleRuleId === null) {
    issues.push({
      path: "basis.bibleRenderingIds",
      message:
        "a voice FAIL must cite the applicable bible rule at the position; none cited — the failure is invalid",
    });
  }
  if (citation.citedHistoryId === null) {
    issues.push({
      path: "evidenceIds",
      message:
        "a voice FAIL must cite the target history it violated at the position; none cited — the failure is invalid",
    });
  }
  return issues;
}

/** Interpret and route a voice verdict. A FAIL that leaves the voice rubric, or
 * that cannot ground itself in the applicable bible rule and violated history, is
 * `invalid` and never finalizes; only a clean PASS finalizes. */
export function interpretQ2Verdict(
  rawVerdict: unknown,
  resolveEvidence: EvidenceResolver,
  resolveCitation: VoiceCitationResolver,
): Q2Interpretation {
  const parsed = ReviewVerdictSchema.safeParse(rawVerdict);
  if (!parsed.success) {
    throw new Error("voice reviewer output is not a schema-valid review verdict");
  }
  const verdict = parsed.data;
  if (verdict.roleId !== Q2_ROLE || verdict.rubric !== "voice") {
    throw new Error("verdict is not a Q2 voice verdict");
  }

  const issues: ValidationIssue[] = [];
  // The shared reviewer law: a CANNOT_ASSESS can never masquerade as a pass.
  issues.push(...specialistFor(Q2_ROLE).validate(reviewerShapeProjection(verdict)));
  // Visible evidence: every citation must resolve and be visible.
  issues.push(...evidenceIssues(verdict, resolveEvidence));

  let citation: VoiceCitationResolution | null = null;
  if (verdict.verdict === "FAIL") {
    // Voice-only rubric: a FAIL must name a voice category.
    if (!Q2_VOICE_CATEGORIES.includes(verdict.category)) {
      issues.push({
        path: "category",
        message: `FAIL category ${verdict.category} is outside the voice rubric`,
      });
    }
    // The grounding guarantee: cite the applicable bible rule + violated history.
    citation = resolveCitation(verdict);
    issues.push(...citationIssues(citation));
  }

  if (issues.length > 0) return { disposition: "invalid", verdict, issues, citation };
  if (verdict.verdict === "PASS") return { disposition: "finalize", verdict, issues, citation };
  if (verdict.verdict === "FAIL") return { disposition: "repair", verdict, issues, citation };
  return { disposition: "escalate", verdict, issues, citation };
}

/** The one place acceptance is decided. Only a clean PASS may finalize; a repair,
 * an escalate, and an invalid verdict never do. */
export function canFinalize(interpretation: Q2Interpretation): boolean {
  return interpretation.disposition === "finalize";
}
