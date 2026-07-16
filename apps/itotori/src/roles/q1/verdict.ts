// Interpret the Meaning Reviewer's verdict and route it.
//
// The verdict is the production ReviewVerdict (strict PASS / FAIL /
// CANNOT_ASSESS carrying severity, exact span, category, cited evidence, and a
// repair constraint). This module layers the reviewer-shape validator on top of
// that structural schema and adds the meaning-lane guarantees the schema cannot:
//   - the reviewer-shape validator (the shared "a CANNOT_ASSESS is not a pass"
//     law) runs over a faithful projection of the verdict;
//   - a FAIL must name a MEANING category — an engine/render/voice category is
//     out of this lane and is rejected as an invalid verdict;
//   - every cited evidence id must RESOLVE and be VISIBLE in its context; an
//     unresolvable citation is a fabrication and invalidates the verdict;
//   - only a PASS may finalize. A CANNOT_ASSESS routes to more-evidence /
//     escalation and a FAIL routes to repair — neither ever finalizes.

import { ReviewVerdictSchema, type ReviewVerdict } from "../../contracts/index.js";
import { specialistFor, type ValidationIssue } from "../../roster/index.js";

const Q1_ROLE = "Q1" as const;

/** The production categories that are genuinely about MEANING. A FAIL outside
 * this set is another lane's finding and is not a valid meaning verdict. */
export const Q1_MEANING_CATEGORIES: readonly ReviewVerdict["category"][] = [
  "mistranslation",
  "omission",
  "addition",
  "referent",
  "register",
];

/** Resolve one cited evidence id: does it exist, and is it visible where it was
 * cited from. Both must hold for the citation to count as visible evidence. */
export type EvidenceResolution = { readonly resolved: boolean; readonly visible: boolean };
export type EvidenceResolver = (evidenceId: string) => EvidenceResolution;

/** Where the verdict routes. Only `finalize` accepts the unit. */
export type Q1Disposition = "finalize" | "repair" | "escalate" | "invalid";

export interface Q1Interpretation {
  readonly disposition: Q1Disposition;
  readonly verdict: ReviewVerdict;
  readonly issues: readonly ValidationIssue[];
}

/** Project the production verdict into the reviewer-shape output so the shared
 * reviewer validator can judge it. The projection preserves the fields the
 * validator inspects: the verdict, its severity, whether it localises a defect,
 * whether it constrains a repair, and — for CANNOT_ASSESS — that it requests
 * evidence rather than silently passing. */
function reviewerShapeProjection(verdict: ReviewVerdict): unknown {
  const base = {
    unitId: verdict.unitId,
    category: "meaning" as const,
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
        evidenceRequest: firstRequestedEvidence(verdict.requestedEvidence),
      },
    ],
  };
}

function firstRequestedEvidence(requested: readonly string[]): string | null {
  return requested.at(0) ?? null;
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

/** Interpret and route a meaning verdict. A verdict that fails any guarantee is
 * `invalid` and — like CANNOT_ASSESS and FAIL — never finalizes. */
export function interpretQ1Verdict(
  rawVerdict: unknown,
  resolve: EvidenceResolver,
): Q1Interpretation {
  const parsed = ReviewVerdictSchema.safeParse(rawVerdict);
  if (!parsed.success) {
    throw new Error("meaning reviewer output is not a schema-valid review verdict");
  }
  const verdict = parsed.data;
  if (verdict.roleId !== Q1_ROLE || verdict.rubric !== "meaning") {
    throw new Error("verdict is not a Q1 meaning verdict");
  }

  const issues: ValidationIssue[] = [];
  // The shared reviewer law: a CANNOT_ASSESS can never masquerade as a pass.
  issues.push(...specialistFor(Q1_ROLE).validate(reviewerShapeProjection(verdict)));
  // Meaning-only rubric: a FAIL must name a meaning category.
  if (verdict.verdict === "FAIL" && !Q1_MEANING_CATEGORIES.includes(verdict.category)) {
    issues.push({
      path: "category",
      message: `FAIL category ${verdict.category} is outside the meaning rubric`,
    });
  }
  // Visible evidence: every citation must resolve and be visible.
  issues.push(...evidenceIssues(verdict, resolve));

  if (issues.length > 0) return { disposition: "invalid", verdict, issues };
  if (verdict.verdict === "PASS") return { disposition: "finalize", verdict, issues };
  if (verdict.verdict === "FAIL") return { disposition: "repair", verdict, issues };
  return { disposition: "escalate", verdict, issues };
}

/** The one place acceptance is decided. Only a clean PASS may finalize; a
 * CANNOT_ASSESS (escalate) and a FAIL (repair) and an invalid verdict never do. */
export function canFinalize(interpretation: Q1Interpretation): boolean {
  return interpretation.disposition === "finalize";
}
