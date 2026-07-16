// Risk routing + stratified review selection.
//
// Review is STRATIFIED, not uniform. Each drafted unit is classified into a risk
// stratum from decode-derived + deterministic-gate signals, and the strata drive
// which lanes judge which units:
//   - a HIGH-RISK unit (a gate defect, a drafted uncertainty, or a first
//     appearance) gets FULL applicable lane coverage;
//   - a REPRESENTATIVE-CLEAN unit is deterministically SAMPLED — only a stable
//     fraction enters the meaning lane, and the rest are trusted.
// Lane applicability is decode-shaped (voice needs a speaker, continuity needs a
// route), so a lane never judges a unit it structurally cannot. The whole
// selection is a pure function of the drafts + gate defects — same inputs, same
// routing.

import type { Defect } from "../contracts/index.js";
import { stableDigest } from "../gates/index.js";
import type { DraftedScene } from "./types.js";
import { REVIEW_LANE_VALUES, type ReviewLane } from "./types.js";

/** A unit's risk stratum — the two strata a stratified review distinguishes. */
export type RiskStratum = "high-risk" | "representative-clean";

/** The pre-draft review lanes, in canonical order. Q5 is the downstream on-screen
 * lane and Q6 is the adjudicator — neither is stratum-selected here. */
export const PRE_DRAFT_LANES: readonly ReviewLane[] = Object.freeze(
  REVIEW_LANE_VALUES.filter(
    (lane) => lane === "Q1" || lane === "Q2" || lane === "Q3" || lane === "Q4",
  ),
);

/** 1 in N representative-clean units is sampled into review — the stratified
 * fraction. High-risk units are never sampled out. */
export const CLEAN_SAMPLE_EVERY_NTH = 4;

/** A unit's stratum plus the lanes selected to review it. */
export interface UnitReviewSelection {
  readonly unitId: string;
  readonly stratum: RiskStratum;
  readonly lanes: readonly ReviewLane[];
}

/** The whole scene's stratified review plan: the per-unit selection plus the
 * inverted lane → unit-ids map the driver dispatches on. */
export interface ReviewPlan {
  readonly selections: readonly UnitReviewSelection[];
  readonly unitsByLane: ReadonlyMap<ReviewLane, readonly string[]>;
}

/** Classify one unit's risk stratum. A gate defect, a drafted uncertainty, or a
 * first appearance makes it high-risk; otherwise it is representative-clean. */
export function classifyStratum(input: {
  readonly firstAppearance: boolean;
  readonly hasGateDefect: boolean;
  readonly uncertain: boolean;
}): RiskStratum {
  return input.firstAppearance || input.hasGateDefect || input.uncertain
    ? "high-risk"
    : "representative-clean";
}

/** True iff a representative-clean unit is in the deterministic review sample —
 * a stable, decode-independent 1-in-N draw keyed on the unit id. */
export function cleanUnitSampled(unitId: string): boolean {
  const digest = stableDigest("review-sample", unitId);
  // Take a byte of the stable digest modulo N — deterministic and uniform.
  const bucket = Number.parseInt(digest.slice(0, 8), 16) % CLEAN_SAMPLE_EVERY_NTH;
  return bucket === 0;
}

/** The applicable lanes for a unit at its stratum. High-risk → every lane the
 * unit's shape supports; sampled clean → the meaning lane only; unsampled clean →
 * none. */
function lanesForUnit(input: {
  readonly stratum: RiskStratum;
  readonly sampled: boolean;
  readonly hasSpeaker: boolean;
  readonly hasRoute: boolean;
}): readonly ReviewLane[] {
  if (input.stratum === "representative-clean") {
    return input.sampled ? ["Q1"] : [];
  }
  const lanes: ReviewLane[] = ["Q1"];
  if (input.hasSpeaker) lanes.push("Q2");
  // Terminology (Q3) audits sense on every high-risk line after the exact gate.
  lanes.push("Q3");
  if (input.hasRoute) lanes.push("Q4");
  return lanes;
}

/**
 * Build the stratified review plan for a drafted scene. Deterministic: the
 * strata, the sample draw, and the lane applicability are all pure functions of
 * the drafts + gate defects, so the same scene always routes identically.
 */
export function planStratifiedReview(
  scene: DraftedScene,
  gateDefects: readonly Defect[],
  units: ReadonlyMap<
    string,
    {
      readonly speakerId: string | null;
      readonly routeId: string | null;
      readonly firstAppearance: boolean;
    }
  >,
): ReviewPlan {
  const defectUnitIds = new Set(gateDefects.map((defect) => defect.unitId));
  const selections: UnitReviewSelection[] = [];
  const unitsByLane = new Map<ReviewLane, string[]>();

  for (const drafted of scene.units) {
    const identity = units.get(drafted.unitId);
    const uncertain = !drafted.draft.uncertainty.includes("none");
    const stratum = classifyStratum({
      firstAppearance: identity?.firstAppearance ?? false,
      hasGateDefect: defectUnitIds.has(drafted.unitId),
      uncertain,
    });
    const sampled = stratum === "high-risk" ? true : cleanUnitSampled(drafted.unitId);
    const lanes = lanesForUnit({
      stratum,
      sampled,
      hasSpeaker: identity?.speakerId != null,
      hasRoute: identity?.routeId != null,
    });
    selections.push({ unitId: drafted.unitId, stratum, lanes });
    for (const lane of lanes) {
      const bucket = unitsByLane.get(lane) ?? [];
      bucket.push(drafted.unitId);
      unitsByLane.set(lane, bucket);
    }
  }

  return { selections, unitsByLane };
}
