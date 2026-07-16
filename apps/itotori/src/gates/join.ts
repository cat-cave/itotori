// Facts-dominate join — assemble a DefectBundle from deterministic defects and
// reviewer verdicts.
//
// Two invariants make facts dominate findings:
//   1. Every deterministic defect stands. A reviewer PASS can never remove it —
//      the bundle always contains the full deterministic set.
//   2. A reviewer FAIL that contradicts an established fact is SUPPRESSED. When
//      a deterministic gate evaluated a unit and produced NO defect for it, that
//      gate's fact PASSED; a reviewer FAIL in the category that gate owns
//      (terminology ← glossary-exact) cannot override the fact and is recorded
//      in `factDominance` instead of becoming a defect.
// Signals (back-translation, voice) are not accepted here at all — they can
// never enter a bundle or decide a release.

import type { Defect, DefectBundle, ReviewVerdict } from "../contracts/index.js";

import type { DeterministicGate, ReviewerDefectCategory } from "./contract-types.js";
import { stableDigest } from "./defect.js";

/** Reviewer categories whose truth a deterministic gate already settles. A
 * reviewer FAIL in one of these is dominated by the gate's PASS-fact. */
const REVIEWER_CATEGORY_DOMINATING_GATE: Partial<
  Record<ReviewerDefectCategory, DeterministicGate>
> = {
  terminology: "glossary-exact",
};

const RUBRIC_TO_CATEGORY: Readonly<Record<ReviewVerdict["rubric"], ReviewerDefectCategory>> = {
  meaning: "meaning",
  voice: "voice",
  terminology: "terminology",
  continuity: "continuity",
  "build-lqa": "build-lqa",
  adjudication: "continuity",
};

export type JoinInput = {
  localizationSnapshotId: string;
  draftBatchId: string;
  deterministic: readonly Defect[];
  reviews?: readonly ReviewVerdict[];
  /** The deterministic gates that actually ran — a gate must have run for its
   * PASS to dominate a reviewer finding. */
  evaluatedGates: readonly DeterministicGate[];
};

function reviewerDefect(verdict: ReviewVerdict & { verdict: "FAIL" }): Defect {
  const category = RUBRIC_TO_CATEGORY[verdict.rubric];
  return {
    origin: "reviewer",
    defectId: `defect:review:${stableDigest(verdict.reviewId, verdict.unitId).slice(0, 24)}`,
    unitId: verdict.unitId,
    severity: verdict.severity,
    span: verdict.span,
    evidenceIds: [...verdict.evidenceIds],
    basisFactIds: [...verdict.evidenceIds],
    repairConstraint: verdict.repairConstraint,
    implicatedGates: [],
    implicatedReviewLanes: [verdict.roleId],
    category,
    reviewId: verdict.reviewId,
    reviewLane: verdict.roleId,
  };
}

export function joinDefects(input: JoinInput): DefectBundle {
  const reviews = input.reviews ?? [];
  const evaluated = new Set(input.evaluatedGates);

  // Units with a fired deterministic defect, keyed by gate, so we can tell a
  // gate PASS (evaluated, no defect for the unit) from a gate FAIL.
  const firedByGate = new Map<DeterministicGate, Set<string>>();
  for (const defect of input.deterministic) {
    if (defect.origin !== "deterministic") {
      continue;
    }
    const set = firedByGate.get(defect.gate) ?? new Set<string>();
    set.add(defect.unitId);
    firedByGate.set(defect.gate, set);
  }

  const defects: Defect[] = [...input.deterministic];
  const factDominance: DefectBundle["factDominance"] = [];

  for (const verdict of reviews) {
    if (verdict.verdict !== "FAIL") {
      continue; // PASS / CANNOT_ASSESS never become defects
    }
    const category = RUBRIC_TO_CATEGORY[verdict.rubric];
    const dominatingGate = REVIEWER_CATEGORY_DOMINATING_GATE[category];
    if (
      dominatingGate !== undefined &&
      evaluated.has(dominatingGate) &&
      !(firedByGate.get(dominatingGate)?.has(verdict.unitId) ?? false)
    ) {
      // The gate ran and did NOT fire for this unit — the fact passed and
      // dominates the contrary reviewer finding.
      factDominance.push({
        winningFactId: verdict.unitId,
        suppressedReviewId: verdict.reviewId,
        category,
        reason: `${dominatingGate} gate passed for ${verdict.unitId}; a deterministic fact overrides the reviewer ${category} finding`,
      });
      continue;
    }
    defects.push(reviewerDefect(verdict));
  }

  return {
    schemaVersion: "itotori.defect-bundle.v1",
    bundleId: `bundle:${stableDigest(input.localizationSnapshotId, input.draftBatchId, defects.length).slice(0, 24)}`,
    localizationSnapshotId: input.localizationSnapshotId,
    draftBatchId: input.draftBatchId,
    defects,
    factDominance,
    resolution: defects.length === 0 ? "none" : "repair",
  };
}
