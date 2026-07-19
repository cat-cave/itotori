// Interpret the Build-LQA Reviewer's verdict and route it.
//
// The verdict is the production ReviewVerdict (strict PASS / FAIL /
// CANNOT_ASSESS carrying severity, exact span, category, cited evidence, and a
// repair constraint). This module layers the reviewer-shape validator on top of
// that structural schema and adds the build-LQA-lane guarantees the schema
// cannot:
//   - a blocking render/OCR fault PRE-EMPTS the judgement. Detected
//     deterministically off the frame — no model consulted — such a fault routes
//     to the deterministic build gates and is NEVER charged to translation
//     quality, whatever the model returned;
//   - on a clean frame, the reviewer-shape validator (the shared "a
//     CANNOT_ASSESS is not a pass" law) runs over a faithful projection;
//   - a FAIL must name the ON-SCREEN translation-quality category — an
//     engine/render category is out of this lane and is an invalid verdict;
//   - every verdict must cite and resolve the on-screen FRAME plus the EXPECTED
//     ACCEPTED TARGET; a citation can never be a vague or unresolvable claim;
//   - only a clean PASS on a clean frame may finalize.

import { ReviewVerdictSchema, type ReviewVerdict } from "../../contracts/index.js";
import { specialistFor, type ValidationIssue } from "../../roster/index.js";
import { deterministicFaults, type RoutedFault } from "./faults.js";
import { Q5RenderFrameSchema, type Q5RenderFrame } from "./inputs.js";

const Q5_ROLE = "Q5" as const;

/** The production categories that are genuinely about ON-SCREEN translation
 * quality. A FAIL outside this set is another lane's finding — most often a
 * render/build fault masquerading as a defect — and is not a valid verdict. */
export const Q5_ONSCREEN_CATEGORIES: readonly ReviewVerdict["category"][] = ["onscreen-language"];

/** Resolve one cited evidence id: does it exist, and is it visible where it was
 * cited from. Both must hold for the citation to count as visible evidence. */
export type EvidenceResolution = { readonly resolved: boolean; readonly visible: boolean };
export type EvidenceResolver = (evidenceId: string) => EvidenceResolution;

/** Where the verdict routes. `finalize` accepts the unit; `deterministic-gate`
 * hands a build fault to the gates that own it (never a translation defect). */
export type Q5Disposition = "finalize" | "repair" | "escalate" | "deterministic-gate" | "invalid";

export interface Q5Interpretation {
  readonly disposition: Q5Disposition;
  /** The model verdict, or `null` when a deterministic frame fault pre-empted the
   * model entirely — the fault routes to its gate off the frame alone, so no
   * model output is parsed or consulted on that path. */
  readonly verdict: ReviewVerdict | null;
  readonly issues: readonly ValidationIssue[];
  /** The render/OCR faults routed to deterministic gates. Non-empty exactly when
   * the disposition is `deterministic-gate`; such faults are never Q5 defects. */
  readonly routedFaults: readonly RoutedFault[];
}

/** Project the production verdict into the reviewer-shape output so the shared
 * reviewer validator can judge it. The projection preserves the fields the
 * validator inspects: the verdict, its severity, whether it localises a defect,
 * whether it constrains a repair, and — for CANNOT_ASSESS — that it requests
 * evidence rather than silently passing. */
function reviewerShapeProjection(verdict: ReviewVerdict): unknown {
  const base = {
    unitId: verdict.unitId,
    category: "visual" as const,
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

/** The Q5-specific evidence floor. A frame ID anchors what the player saw; the
 * accepted-output ID anchors what that frame was required to show. Both are
 * mandatory for PASS, FAIL, and CANNOT_ASSESS alike, so no outcome can be
 * detached from either the real patched-byte observation or its accepted target. */
function requiredEvidenceIssues(
  verdict: ReviewVerdict,
  frame: Q5RenderFrame,
): readonly ValidationIssue[] {
  const required = [
    { id: frame.frameId, label: "on-screen frame evidence" },
    { id: frame.expectedAcceptedOutputId, label: "expected accepted target" },
  ];
  return required.flatMap(({ id, label }) =>
    verdict.evidenceIds.includes(id)
      ? []
      : [
          {
            path: "evidenceIds",
            message: `verdict must cite ${label} ${id}`,
          },
        ],
  );
}

/** Interpret and route a build-LQA verdict against the frame it was formed over.
 *
 * A blocking render/OCR fault is decided DETERMINISTICALLY off the FRAME ALONE
 * and pre-empts the model's judgement entirely: the unit routes to the
 * deterministic gates BEFORE the model output is even parsed, so a glyph/charset/
 * overflow/layout/replay fault reaches its gate whether the model produced a
 * valid verdict, a garbage blob, or nothing — the fault is never charged to
 * translation quality, not laundered into a FAIL, not silently passed. Only on a
 * fault-clean frame is the model verdict parsed and judged; a verdict that fails
 * any guarantee is `invalid` and — like every non-PASS disposition — never
 * finalizes. */
export function interpretQ5Verdict(
  rawVerdict: unknown,
  frame: Q5RenderFrame,
  resolve: EvidenceResolver,
): Q5Interpretation {
  // Strictly parse the frame so a fault kind can only be one of the declared
  // render/OCR kinds — a runtime-forged kind can never yield an undefined gate.
  const observedFrame = Q5RenderFrameSchema.parse(frame);

  // Deterministic pre-emption FIRST, off the frame alone: a render/OCR fault is a
  // build fault the gates own. No model output is parsed or consulted on this
  // path, so the fault routes to its gate regardless of the model's validity.
  const routedFaults = deterministicFaults(observedFrame);
  if (routedFaults.length > 0) {
    return { disposition: "deterministic-gate", verdict: null, issues: [], routedFaults };
  }

  // Fault-clean frame: only now is the model verdict parsed and judged.
  const parsed = ReviewVerdictSchema.safeParse(rawVerdict);
  if (!parsed.success) {
    throw new Error("build-LQA reviewer output is not a schema-valid review verdict");
  }
  const verdict = parsed.data;
  if (verdict.roleId !== Q5_ROLE || verdict.rubric !== "build-lqa") {
    throw new Error("verdict is not a Q5 build-LQA verdict");
  }

  const issues: ValidationIssue[] = [];
  // The shared reviewer law: a CANNOT_ASSESS can never masquerade as a pass.
  issues.push(...specialistFor(Q5_ROLE).validate(reviewerShapeProjection(verdict)));
  // Build-LQA rubric: a FAIL must name the on-screen translation-quality category.
  if (verdict.verdict === "FAIL" && !Q5_ONSCREEN_CATEGORIES.includes(verdict.category)) {
    issues.push({
      path: "category",
      message: `FAIL category ${verdict.category} is outside the on-screen translation rubric`,
    });
  }
  // Every outcome must name both what the player saw and the accepted target it
  // is compared with; then every citation must resolve and be visible.
  issues.push(...requiredEvidenceIssues(verdict, observedFrame));
  issues.push(...evidenceIssues(verdict, resolve));

  if (issues.length > 0) return { disposition: "invalid", verdict, issues, routedFaults: [] };
  if (verdict.verdict === "PASS")
    return { disposition: "finalize", verdict, issues, routedFaults: [] };
  if (verdict.verdict === "FAIL")
    return { disposition: "repair", verdict, issues, routedFaults: [] };
  return { disposition: "escalate", verdict, issues, routedFaults: [] };
}

/** The one place acceptance is decided. Only a clean PASS on a clean frame may
 * finalize; repair, escalate, deterministic-gate, and invalid never do. */
export function canFinalize(interpretation: Q5Interpretation): boolean {
  return interpretation.disposition === "finalize";
}
