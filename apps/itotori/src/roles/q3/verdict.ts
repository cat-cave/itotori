// Interpret the Terminology Auditor's verdict and route it.
//
// The verdict is the production ReviewVerdict (strict PASS / FAIL /
// CANNOT_ASSESS carrying severity, exact span, category, cited evidence, and a
// repair constraint). This module layers the reviewer-shape validator on top of
// that structural schema and adds the terminology-lane guarantees the schema
// cannot:
//   - the reviewer-shape validator (the shared "a CANNOT_ASSESS is not a pass"
//     law) runs over a faithful projection of the verdict;
//   - a FAIL must name a TERMINOLOGY category — sense of an approved form or a
//     new coinage; a meaning/voice/engine category is another lane's finding;
//   - every cited evidence id must RESOLVE and be VISIBLE; a fabricated citation
//     invalidates the verdict;
//   - a verdict that CONTRADICTS an already-approved glossary form is REJECTED:
//     it routes back to the ruling lane and never overwrites the approved form;
//   - only a clean PASS may finalize. A FAIL refers a cited source candidate to
//     the ruling lane, a CANNOT_ASSESS escalates, and neither ever finalizes.

import { ReviewVerdictSchema, type ReviewVerdict } from "../../contracts/index.js";
import { specialistFor, type ValidationIssue } from "../../roster/index.js";
import { assertExactGateCleared, type Q3ApprovedTerm, type Q3ReviewInput } from "./inputs.js";

const Q3_ROLE = "Q3" as const;

/** The production categories that are genuinely about TERMINOLOGY: the contextual
 * sense/register of an approved form, and a genuinely new ambiguous coinage. A
 * FAIL outside this set is another lane's finding, not a terminology verdict. */
export const Q3_TERMINOLOGY_CATEGORIES: readonly ReviewVerdict["category"][] = [
  "term-sense",
  "register",
  "new-coinage",
];

/** Resolve one cited evidence id: does it exist, and is it visible where cited. */
export type EvidenceResolution = { readonly resolved: boolean; readonly visible: boolean };
export type EvidenceResolver = (evidenceId: string) => EvidenceResolution;

/** Whether a verdict would contradict an already-approved glossary form, and the
 * approved term it collides with. A contradiction is rejected, not approved. */
export type ContradictionResolution = {
  readonly contradictsApprovedForm: boolean;
  readonly approvedTermId: string | null;
};
export type ContradictionResolver = (verdict: ReviewVerdict) => ContradictionResolution;

/** A cited SOURCE candidate the auditor refers back to the ruling lane. It carries
 * NO target form — the auditor never invents or approves one. */
export type Q3Referral =
  | {
      readonly kind: "approved-form-context";
      readonly termId: string;
      readonly sourceForm: string;
      readonly citedEvidenceIds: readonly string[];
    }
  | {
      readonly kind: "ambiguous-source-coinage";
      readonly candidateId: string;
      readonly sourceForm: string;
      readonly citedEvidenceIds: readonly string[];
    };

/** Where the verdict routes. Only `finalize` accepts the unit. */
export type Q3Disposition = "finalize" | "refer" | "escalate" | "invalid" | "reject-contradiction";

export interface Q3Interpretation {
  readonly disposition: Q3Disposition;
  readonly verdict: ReviewVerdict;
  readonly issues: readonly ValidationIssue[];
  readonly referral: Q3Referral | null;
}

/** The default contradiction resolver: a NEW-COINAGE claim for a form the glossary
 * has ALREADY approved is contradictory — the term is ruled, and a competing
 * coinage would fork its approved form. Deterministic over the input's approved
 * terms; no model text is trusted for the collision. */
export function approvedFormContradictionResolver(input: Q3ReviewInput): ContradictionResolver {
  return (verdict) => {
    if (verdict.verdict !== "FAIL" || verdict.category !== "new-coinage") {
      return { contradictsApprovedForm: false, approvedTermId: null };
    }
    const flagged = verdict.span.text;
    const collision = input.approvedTerms.find(
      (term) => term.sourceForm === flagged || term.approvedTargetForm === flagged,
    );
    return collision
      ? { contradictsApprovedForm: true, approvedTermId: collision.termId }
      : { contradictsApprovedForm: false, approvedTermId: null };
  };
}

/** Project the production verdict into the reviewer-shape output so the shared
 * reviewer validator can judge it (the "CANNOT_ASSESS never passes" law). */
function reviewerShapeProjection(verdict: ReviewVerdict): unknown {
  const base = {
    unitId: verdict.unitId,
    category: "terminology" as const,
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

/** The cited source candidate a FAIL refers back to the ruling lane — source form
 * and evidence only, never a target form. */
function approvedTermForTargetSpan(
  input: Q3ReviewInput,
  verdict: Extract<ReviewVerdict, { verdict: "FAIL" }>,
): Q3ApprovedTerm | undefined {
  if (verdict.span.surface !== "target") return undefined;
  return input.approvedTerms.find((term) => term.approvedTargetForm === verdict.span.text);
}

/** Validate the only two sources from which Q3 may produce a referral. Context
 * findings refer an already-approved term by its input-derived SOURCE form;
 * new coinages must be one of the exact, source-evidenced candidates supplied
 * to the reviewer. A model span can therefore never manufacture either kind. */
function referralFor(
  input: Q3ReviewInput,
  verdict: Extract<ReviewVerdict, { verdict: "FAIL" }>,
): { readonly referral: Q3Referral | null; readonly issues: readonly ValidationIssue[] } {
  if (verdict.category === "term-sense" || verdict.category === "register") {
    const term = approvedTermForTargetSpan(input, verdict);
    if (term === undefined) {
      return {
        referral: null,
        issues: [
          {
            path: "span",
            message:
              "a sense/register finding must identify an approved target form in a target span",
          },
        ],
      };
    }
    return {
      referral: {
        kind: "approved-form-context",
        termId: term.termId,
        sourceForm: term.sourceForm,
        citedEvidenceIds: verdict.evidenceIds,
      },
      issues: [],
    };
  }

  if (verdict.category === "new-coinage") {
    const candidate =
      verdict.span.surface === "source"
        ? input.ambiguousCoinages.find((entry) => entry.sourceForm === verdict.span.text)
        : undefined;
    if (candidate === undefined) {
      return {
        referral: null,
        issues: [
          {
            path: "span",
            message:
              "a new-coinage finding must identify a supplied ambiguous source candidate in a source span",
          },
        ],
      };
    }
    const citedEvidence = new Set(verdict.evidenceIds);
    if (!candidate.evidenceIds.every((evidenceId) => citedEvidence.has(evidenceId))) {
      return {
        referral: null,
        issues: [
          {
            path: "evidenceIds",
            message: "a new-coinage finding must cite every supplied source-candidate evidence id",
          },
        ],
      };
    }
    return {
      referral: {
        kind: "ambiguous-source-coinage",
        candidateId: candidate.candidateId,
        sourceForm: candidate.sourceForm,
        citedEvidenceIds: verdict.evidenceIds,
      },
      issues: [],
    };
  }

  return { referral: null, issues: [] };
}

function contradictionReferral(input: Q3ReviewInput, verdict: ReviewVerdict): Q3Referral | null {
  if (verdict.verdict !== "FAIL") return null;
  const term = input.approvedTerms.find(
    (approved) =>
      approved.sourceForm === verdict.span.text ||
      approved.approvedTargetForm === verdict.span.text,
  );
  return term === undefined
    ? null
    : {
        kind: "approved-form-context",
        termId: term.termId,
        sourceForm: term.sourceForm,
        citedEvidenceIds: verdict.evidenceIds,
      };
}

/** Interpret and route a terminology verdict. A contradiction of an approved form
 * is rejected and routed back; any other guarantee failure is `invalid`; only a
 * clean PASS finalizes. */
export function interpretQ3Verdict(
  rawVerdict: unknown,
  input: Q3ReviewInput,
  resolveEvidence: EvidenceResolver,
  resolveContradiction: ContradictionResolver = approvedFormContradictionResolver(input),
): Q3Interpretation {
  // Public interpretation is also downstream-only: callers cannot turn a gate
  // defect into a model verdict by bypassing the runner.
  assertExactGateCleared(input);
  const parsed = ReviewVerdictSchema.safeParse(rawVerdict);
  if (!parsed.success) {
    throw new Error("terminology auditor output is not a schema-valid review verdict");
  }
  const verdict = parsed.data;
  if (verdict.roleId !== Q3_ROLE || verdict.rubric !== "terminology") {
    throw new Error("verdict is not a Q3 terminology verdict");
  }

  const issues: ValidationIssue[] = [];
  // The shared reviewer law: a CANNOT_ASSESS can never masquerade as a pass.
  issues.push(...specialistFor(Q3_ROLE).validate(reviewerShapeProjection(verdict)));
  // Terminology-only rubric: a FAIL must name a terminology category.
  if (verdict.verdict === "FAIL" && !Q3_TERMINOLOGY_CATEGORIES.includes(verdict.category)) {
    issues.push({
      path: "category",
      message: `FAIL category ${verdict.category} is outside the terminology rubric`,
    });
  }
  const referral = verdict.verdict === "FAIL" ? referralFor(input, verdict) : null;
  if (referral !== null) issues.push(...referral.issues);
  // Visible evidence: every citation must resolve and be visible.
  issues.push(...evidenceIssues(verdict, resolveEvidence));

  // A contradiction of an approved glossary form is rejected outright: it routes
  // back to the ruling lane and never overwrites the approved form.
  const contradiction = resolveContradiction(verdict);
  if (contradiction.contradictsApprovedForm) {
    issues.push({
      path: "category",
      message:
        "verdict contradicts an already-approved glossary form; routed back to the ruling lane, never approved",
    });
    return {
      disposition: "reject-contradiction",
      verdict,
      issues,
      referral: contradictionReferral(input, verdict),
    };
  }

  if (issues.length > 0) return { disposition: "invalid", verdict, issues, referral: null };
  if (verdict.verdict === "PASS")
    return { disposition: "finalize", verdict, issues, referral: null };
  if (verdict.verdict === "FAIL") {
    return { disposition: "refer", verdict, issues, referral: referral?.referral ?? null };
  }
  return { disposition: "escalate", verdict, issues, referral: null };
}

/** The one place acceptance is decided. Only a clean PASS may finalize; a refer,
 * an escalate, an invalid, and a rejected contradiction never do. */
export function canFinalize(interpretation: Q3Interpretation): boolean {
  return interpretation.disposition === "finalize";
}
