// Interpret the Continuity Reviewer's verdict and route it.
//
// The verdict is the production ReviewVerdict (strict PASS / FAIL /
// CANNOT_ASSESS carrying severity, span, category, cited evidence, and a repair
// constraint). This module layers the reviewer-shape validator on top of that
// structural schema and adds the continuity-lane guarantees the schema cannot:
//   - the reviewer-shape validator (the shared "a CANNOT_ASSESS is not a pass"
//     law) runs over a faithful projection of the verdict;
//   - a FAIL must name a CONTINUITY category — a meaning/voice/engine category is
//     out of this lane and is rejected as an invalid verdict;
//   - a contradiction cites BOTH endpoint ids: the unit under review (USE) plus
//     at least one accepted origin in `evidenceIds`. EACH must resolve to a REAL
//     ordered unit in the deterministic ledger (a phantom endpoint is a
//     fabrication), and each must lie ON the route the review is bound to (a
//     claim that crosses route scope is rejected — deterministic, not
//     model-asserted);
//   - a FAIL is a contradiction between an ORIGIN and the USE unit under review:
//     the origin must play BEFORE the use in the decode play order (an origin
//     that does not precede the use is not a valid finding). Precedence is read
//     from the ledger, never from anything the model asserted;
//   - only a PASS may finalize. A CANNOT_ASSESS escalates and a FAIL routes to
//     repair — neither ever finalizes.

import { ReviewVerdictSchema, type ReviewVerdict, type RouteScope } from "../../contracts/index.js";
import { specialistFor, type ValidationIssue } from "../../roster/index.js";
import {
  endpointVisibleOnReviewScope,
  originPrecedesUse,
  type ContinuityLedger,
} from "./ledger.js";

const Q4_ROLE = "Q4" as const;

/** The production categories that are genuinely about CONTINUITY. A FAIL outside
 * this set is another lane's finding and is not a valid continuity verdict. */
export const Q4_CONTINUITY_CATEGORIES: readonly ReviewVerdict["category"][] = [
  "callback",
  "foreshadow",
  "relationship",
  "route-arc",
];

/** Where the verdict routes. Only `finalize` accepts the unit. */
export type Q4Disposition = "finalize" | "repair" | "escalate" | "invalid";

export interface Q4Interpretation {
  readonly disposition: Q4Disposition;
  readonly verdict: ReviewVerdict;
  readonly issues: readonly ValidationIssue[];
}

/** The deterministic facts the interpretation proves the finding against: the
 * unit under review, the route the review is bound to, and the ledger that
 * resolves every cited endpoint to its decode play order + route scope. */
export interface Q4ContinuityFacts {
  readonly useUnitId: string;
  readonly reviewScope: RouteScope;
  /** The accepted target translations supplied to this review as candidate
   * origins. A FAIL may cite only one of these as its prior endpoint. */
  readonly acceptedOriginUnitIds: readonly string[];
  readonly ledger: ContinuityLedger;
}

/** Project the production verdict into the reviewer-shape output so the shared
 * reviewer validator can judge it (the "a CANNOT_ASSESS never passes" law). */
function reviewerShapeProjection(verdict: ReviewVerdict): unknown {
  const base = {
    unitId: verdict.unitId,
    category: "continuity" as const,
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

/** Prove every cited endpoint is a REAL unit, ON the review's route, and — for a
 * contradiction (FAIL) — that the USE is cited alongside an accepted origin
 * which plays BEFORE it. All three facts are read from the deterministic ledger,
 * never from the model. */
function endpointIssues(
  verdict: ReviewVerdict,
  facts: Q4ContinuityFacts,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const use = facts.ledger.resolve(facts.useUnitId);
  if (use === null) {
    issues.push({
      path: "unitId",
      message: `unit under review ${facts.useUnitId} does not resolve`,
    });
  } else if (!endpointVisibleOnReviewScope(use.routeScope, facts.reviewScope)) {
    issues.push({
      path: "unitId",
      message: `unit under review ${facts.useUnitId} is outside the review route scope`,
    });
  }
  const endpointIds =
    verdict.verdict === "FAIL"
      ? [...new Set([facts.useUnitId, ...verdict.evidenceIds])]
      : [...new Set(verdict.evidenceIds)];
  endpointIds.forEach((endpointId) => {
    const endpoint = facts.ledger.resolve(endpointId);
    if (endpoint === null) {
      issues.push({
        path: endpointId === facts.useUnitId ? "unitId" : "evidenceIds",
        message: `cited endpoint ${endpointId} does not resolve to a real unit`,
      });
      return;
    }
    if (!endpointVisibleOnReviewScope(endpoint.routeScope, facts.reviewScope)) {
      issues.push({
        path: endpointId === facts.useUnitId ? "unitId" : "evidenceIds",
        message: `cited endpoint ${endpointId} crosses out of the review route scope`,
      });
    }
  });

  if (verdict.verdict !== "FAIL") return issues;

  if (!verdict.evidenceIds.includes(facts.useUnitId)) {
    issues.push({
      path: "evidenceIds",
      message: "a continuity contradiction must cite the use endpoint under review",
    });
  }
  const origins = [
    ...new Set(verdict.evidenceIds.filter((endpointId) => endpointId !== facts.useUnitId)),
  ];
  if (origins.length === 0) {
    issues.push({
      path: "evidenceIds",
      message: "a continuity contradiction must cite an origin endpoint as well as the use",
    });
  }
  for (const originId of origins) {
    if (!facts.acceptedOriginUnitIds.includes(originId)) {
      issues.push({
        path: "evidenceIds",
        message: `cited origin ${originId} is not an accepted origin translation supplied to Q4`,
      });
      continue;
    }
    const origin = facts.ledger.resolve(originId);
    if (origin !== null && use !== null && !originPrecedesUse(origin, use)) {
      issues.push({
        path: "evidenceIds",
        message: `cited origin ${originId} does not play before the unit under review`,
      });
    }
  }
  return issues;
}

/** Interpret and route a continuity verdict against the deterministic facts. A
 * verdict that fails any guarantee is `invalid` and — like CANNOT_ASSESS and
 * FAIL — never finalizes. */
export function interpretQ4Verdict(
  rawVerdict: unknown,
  facts: Q4ContinuityFacts,
): Q4Interpretation {
  const parsed = ReviewVerdictSchema.safeParse(rawVerdict);
  if (!parsed.success) {
    throw new Error("continuity reviewer output is not a schema-valid review verdict");
  }
  const verdict = parsed.data;
  if (verdict.roleId !== Q4_ROLE || verdict.rubric !== "continuity") {
    throw new Error("verdict is not a Q4 continuity verdict");
  }

  const issues: ValidationIssue[] = [];
  // The verdict must be about the unit the review was assembled for.
  if (verdict.unitId !== facts.useUnitId) {
    issues.push({ path: "unitId", message: "verdict is not for the unit under review" });
  }
  // The shared reviewer law: a CANNOT_ASSESS can never masquerade as a pass.
  issues.push(...specialistFor(Q4_ROLE).validate(reviewerShapeProjection(verdict)));
  // Continuity-only rubric: a FAIL must name a continuity category.
  if (verdict.verdict === "FAIL" && !Q4_CONTINUITY_CATEGORIES.includes(verdict.category)) {
    issues.push({
      path: "category",
      message: `FAIL category ${verdict.category} is outside the continuity rubric`,
    });
  }
  // Endpoints: real, in-route, and (for a contradiction) origin-before-use.
  issues.push(...endpointIssues(verdict, facts));

  if (issues.length > 0) return { disposition: "invalid", verdict, issues };
  if (verdict.verdict === "PASS") return { disposition: "finalize", verdict, issues };
  if (verdict.verdict === "FAIL") return { disposition: "repair", verdict, issues };
  return { disposition: "escalate", verdict, issues };
}

/** The one place acceptance is decided. Only a clean PASS may finalize; a
 * CANNOT_ASSESS (escalate), a FAIL (repair), and an invalid verdict never do. */
export function canFinalize(interpretation: Q4Interpretation): boolean {
  return interpretation.disposition === "finalize";
}
