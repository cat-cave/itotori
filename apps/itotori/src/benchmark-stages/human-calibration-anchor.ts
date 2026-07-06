// benchmark-human-calibration-anchors — the external human anchor + LLM-panel
// calibration (§8).
//
// Methodology §8 (docs/itotori-translation-benchmark-methodology.md): the ONE
// signal fully OUTSIDE the LLM/pipeline loop. Trevor (and any additional raters)
// rate PROVENANCE-ANONYMIZED contestant outputs on the SAME rubric (§2) as the
// blind judge panel (§4), through a capture mechanism that presents candidates
// BLIND and in randomized order. A calibration report then quantifies
// LLM-panel-vs-human agreement per dimension (correlation + where the panel
// systematically diverges — e.g. "panel too lenient on register"). This is what
// proves the panel tracks human judgment and BOUNDS its bias.
//
// What this module OWNS (per §8):
//   1. Blind human-rating CAPTURE. `buildHumanRatingBundles` presents each rater
//      the SAME blind bundles the judge panel scores, reusing the §4.2
//      anonymization posture (`blindUnitForJudge`): the human sees `candidate-a/
//      b/c…` handles + text ONLY, never a system identity, in a per-rater
//      randomized order. `HumanRatingRecord` is the typed capture shape (rater
//      id, unit, BLIND candidate handle, per-dimension 0–4 scores, optional
//      notes). `assertHumanRatingRecord` validates records against the rubric;
//      `assertHumanRatingRecordIsBlind` proves the human never referenced a
//      system identity.
//   2. The LOCKED anchor. `lockHumanRatingAnchor` validates + deep-freezes the
//      records into a `LockedHumanRatingAnchor` stamped with
//      `HUMAN_CALIBRATION_ANCHOR_POLICY` — the human ratings are an external
//      anchor used ONLY to calibrate/validate the PANEL, NEVER to tune Itotori.
//      The de-anonymization (blind handle → real contestant) happens ONLY on the
//      panel side (`deanonymizeHumanRatings`, from the panel-held blinding maps).
//   3. The CALIBRATION report. `buildPanelHumanCalibrationReport` compares the
//      §4 panel scores against the (de-anonymized) human ratings: per-dimension
//      agreement, SIGNED divergence (panel over/under-scores vs humans), and
//      Pearson correlation — plus the same overall. A panel that matches humans
//      → high agreement + ~0 divergence; a systematically-biased panel → the
//      report SURFACES the divergence (signed mean gap + flagged dimension).
//
// Nothing here makes a network call; the math is deterministic and reference-
// free. Human ratings feed the report ONLY — this module returns no artifact
// that is fed back into Itotori tuning (the §8 "locked anchor" invariant).

import {
  BENCHMARK_QUALITY_RUBRIC,
  BENCHMARK_RUBRIC_DIMENSION_IDS,
  type BenchmarkQualityRubric,
  type BenchmarkRubricDimensionId,
  type BenchmarkRubricScore,
} from "@itotori/localization-bridge-schema";
import {
  blindUnitForJudge,
  type BlindCandidate,
  type ContestantDimensionScore,
} from "./blind-judge-panel.js";
import type { DecodedGroundTruthContext, JudgeUnitInput } from "./decoded-context-feed.js";

export class HumanCalibrationAnchorError extends Error {
  constructor(detail: string) {
    super(`human-calibration-anchor refused: ${detail}`);
    this.name = "HumanCalibrationAnchorError";
  }
}

const DIMENSION_ID_SET: ReadonlySet<string> = new Set(BENCHMARK_RUBRIC_DIMENSION_IDS);
const BLIND_LABEL_RE = /^candidate-[a-z]+$/u;

/**
 * §8 anchor policy (the "locked anchor" invariant), stamped on the locked anchor
 * and the calibration report. The human ratings calibrate/validate the PANEL
 * only; they are NEVER used to tune Itotori (prompts, glossary, style, context).
 * They MAY be used to re-anchor/reweight a divergent judge (calibration of the
 * INSTRUMENT), logged as such — that is not Itotori tuning.
 */
export const HUMAN_CALIBRATION_ANCHOR_POLICY = {
  role: "external_calibration_anchor",
  fullyOutsideLlmPipelineLoop: true,
  usage: "calibrate_or_validate_panel_only",
  usedForItotoriTuning: false,
  methodologyRef: "docs/itotori-translation-benchmark-methodology.md#8-human-calibration-anchors",
} as const;

/**
 * §8 — a dimension where the panel diverges from humans by at least this much
 * (in rubric points, |signed mean gap|) is flagged. Below it the panel is
 * treated as ALIGNED with the humans on that dimension. Half a rubric point is
 * the reasoned default (§12 meta-validity floors stay Trevor's; this is a
 * reporting threshold, not a run-gating one).
 */
export const PANEL_DIVERGENCE_ALERT_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// 1. Blind human-rating CAPTURE (§8 + §4.2 anonymization posture).
// ---------------------------------------------------------------------------

/**
 * One blind bundle presented to a human rater for one unit: the shared decoded
 * ground truth (§5), the rubric (§2), and the anonymized candidates in a
 * per-rater randomized order (§4.2). Carries NO system identity — the human sees
 * `candidate-a/b/c…` handles + text ONLY. Structurally the SAME blind bundle the
 * judge panel scores (built by the same `blindUnitForJudge`).
 */
export type HumanRatingBundle = {
  raterId: string;
  unitId: string;
  decodedContext: DecodedGroundTruthContext;
  rubric: BenchmarkQualityRubric;
  candidates: BlindCandidate[];
};

/**
 * The panel-SIDE de-anonymization for one (rater, unit): `blindLabel → real
 * contestant id`. Held only on the panel side, never shown to the human — the
 * exact mirror of the judge-panel blinding posture (§4.2).
 */
export type HumanRatingBlinding = {
  raterId: string;
  unitId: string;
  deanonymize: Map<string, string>;
};

export type BuildHumanRatingBundlesInput = {
  /** §5 feed — the SAME per-unit blind bundles the judge panel consumes. */
  feed: JudgeUnitInput[];
  /** The human raters (Trevor + any additional raters, §8). */
  raterIds: string[];
  /** Deterministic seed for the §4.2 order randomization. */
  panelSeed: string;
  /** §2 rubric artifact. Defaults to the frozen `BENCHMARK_QUALITY_RUBRIC`. */
  rubric?: BenchmarkQualityRubric;
};

export type BuildHumanRatingBundlesResult = {
  /** What the humans SEE — blind, randomized, no system identity. */
  bundles: HumanRatingBundle[];
  /** The panel-only blind→real maps, used later to de-anonymize the ratings. */
  blindings: HumanRatingBlinding[];
};

/**
 * Build the blind rating bundles for every (rater, unit), reusing the judge
 * panel's §4.2 anonymization (`blindUnitForJudge`) so humans and judges score
 * the SAME blind bundles under the SAME posture. Each rater gets an independent,
 * deterministic randomized order (seeded on the rater id). Returns the
 * human-facing bundles plus the panel-only de-anonymization maps.
 */
export function buildHumanRatingBundles(
  input: BuildHumanRatingBundlesInput,
): BuildHumanRatingBundlesResult {
  const rubric = input.rubric ?? BENCHMARK_QUALITY_RUBRIC;
  if (input.feed.length === 0) {
    throw new HumanCalibrationAnchorError("no units in the rating feed");
  }
  if (input.raterIds.length === 0) {
    throw new HumanCalibrationAnchorError("no raters supplied");
  }
  const seenRaters = new Set<string>();
  for (const raterId of input.raterIds) {
    if (raterId.trim().length === 0) {
      throw new HumanCalibrationAnchorError("empty rater id");
    }
    if (seenRaters.has(raterId)) {
      throw new HumanCalibrationAnchorError(`duplicate rater id '${raterId}'`);
    }
    seenRaters.add(raterId);
  }

  const bundles: HumanRatingBundle[] = [];
  const blindings: HumanRatingBlinding[] = [];
  for (const raterId of input.raterIds) {
    for (const unit of input.feed) {
      // Reuse the §4.2 judge blinding, seeded on the rater id so each rater gets
      // an independent yet deterministic randomized order.
      const blinded = blindUnitForJudge(unit, rubric, raterId, input.panelSeed);
      bundles.push({
        raterId,
        unitId: unit.unitId,
        decodedContext: blinded.input.decodedContext,
        rubric,
        candidates: blinded.input.candidates,
      });
      blindings.push({ raterId, unitId: unit.unitId, deanonymize: blinded.deanonymize });
    }
  }
  return { bundles, blindings };
}

// ---------------------------------------------------------------------------
// The typed capture record (what a human fills in, seeing BLIND handles only).
// ---------------------------------------------------------------------------

/** One dimension's 0–4 human rating, with optional free-text notes. */
export type HumanDimensionRating = {
  dimensionId: BenchmarkRubricDimensionId;
  score: BenchmarkRubricScore;
  notes?: string;
};

/**
 * One human's rating of ONE anonymized candidate for one unit. Keyed by the
 * BLIND handle (`candidate-a/b/…`) — NEVER a system identity (§8/§4.2). The
 * per-dimension scores are on the same 0–4 rubric scale (§2.1) the judge panel
 * uses, so the two are directly comparable.
 */
export type HumanRatingRecord = {
  raterId: string;
  unitId: string;
  /** The BLIND candidate handle the human saw — must be `candidate-[a-z]+`. */
  blindLabel: string;
  dimensions: HumanDimensionRating[];
  /** Optional overall note for this candidate. */
  notes?: string;
};

/**
 * Validate ONE human rating record against the rubric (§2): rater/unit present,
 * a BLIND handle (no system identity), non-empty distinct rubric dimensions, and
 * every score an integer on the 0–4 scale. Throws on any violation.
 */
export function assertHumanRatingRecord(record: HumanRatingRecord): void {
  if (record.raterId.trim().length === 0) {
    throw new HumanCalibrationAnchorError("rating record has an empty rater id");
  }
  if (record.unitId.trim().length === 0) {
    throw new HumanCalibrationAnchorError(
      `rating record (rater '${record.raterId}') has an empty unit id`,
    );
  }
  if (!BLIND_LABEL_RE.test(record.blindLabel)) {
    throw new HumanCalibrationAnchorError(
      `rating record (rater '${record.raterId}', unit '${record.unitId}') carries a non-blind candidate handle '${record.blindLabel}' — humans rate BLIND handles only (§8/§4.2)`,
    );
  }
  if (record.dimensions.length === 0) {
    throw new HumanCalibrationAnchorError(
      `rating record (rater '${record.raterId}', unit '${record.unitId}', '${record.blindLabel}') scores no dimension`,
    );
  }
  const seen = new Set<string>();
  for (const dim of record.dimensions) {
    if (!DIMENSION_ID_SET.has(dim.dimensionId)) {
      throw new HumanCalibrationAnchorError(
        `rating record scores unknown rubric dimension '${dim.dimensionId}'`,
      );
    }
    if (seen.has(dim.dimensionId)) {
      throw new HumanCalibrationAnchorError(
        `rating record (rater '${record.raterId}', unit '${record.unitId}', '${record.blindLabel}') scores dimension '${dim.dimensionId}' twice`,
      );
    }
    seen.add(dim.dimensionId);
    if (!Number.isInteger(dim.score) || dim.score < 0 || dim.score > 4) {
      throw new HumanCalibrationAnchorError(
        `rating record scores dimension '${dim.dimensionId}' as ${dim.score}; the rubric scale is an integer 0–4 (§2.1)`,
      );
    }
  }
}

/**
 * §8/§4.2 blindness guard: a human rating record must reference NO real system
 * identity — not in the blind handle, and not smuggled into any note. Mirrors
 * the judge-side `assertBlindJudgeInputHasNoProvenance`. Throws on any leak.
 */
export function assertHumanRatingRecordIsBlind(
  record: HumanRatingRecord,
  realContestantIds: readonly string[],
): void {
  if (!BLIND_LABEL_RE.test(record.blindLabel)) {
    throw new HumanCalibrationAnchorError(
      `rating record carries a non-blind candidate handle '${record.blindLabel}'`,
    );
  }
  const serialized = JSON.stringify({
    blindLabel: record.blindLabel,
    notes: record.notes ?? "",
    dimensionNotes: record.dimensions.map((d) => d.notes ?? ""),
  });
  for (const contestantId of realContestantIds) {
    if (contestantId.length > 0 && serialized.includes(contestantId)) {
      throw new HumanCalibrationAnchorError(
        `rating record (rater '${record.raterId}', unit '${record.unitId}') leaks system identity '${contestantId}' — humans rate BLIND (§8/§4.2)`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 2. The LOCKED external anchor (§8).
// ---------------------------------------------------------------------------

/**
 * The human ratings as a LOCKED external anchor (§8): validated, deep-frozen,
 * and stamped with `HUMAN_CALIBRATION_ANCHOR_POLICY`. This is what the
 * calibration path consumes — the `locked: true` + frozen records make it
 * type- and runtime-explicit that the ratings are an EXTERNAL anchor used to
 * calibrate/validate the panel, never a tuning input.
 */
export type LockedHumanRatingAnchor = {
  readonly policy: typeof HUMAN_CALIBRATION_ANCHOR_POLICY;
  readonly locked: true;
  readonly records: readonly HumanRatingRecord[];
};

export type LockHumanRatingAnchorOptions = {
  /**
   * When supplied, every record is additionally proven BLIND against these real
   * contestant ids (`assertHumanRatingRecordIsBlind`).
   */
  realContestantIds?: readonly string[];
};

/**
 * Validate every record (§2 rubric-aligned, and — when `realContestantIds` is
 * given — BLIND) and freeze them into a `LockedHumanRatingAnchor`. Deep-frozen
 * so the anchor cannot be mutated after locking (§8 "locked anchor").
 */
export function lockHumanRatingAnchor(
  records: readonly HumanRatingRecord[],
  options: LockHumanRatingAnchorOptions = {},
): LockedHumanRatingAnchor {
  if (records.length === 0) {
    throw new HumanCalibrationAnchorError("cannot lock an empty human-rating anchor");
  }
  for (const record of records) {
    assertHumanRatingRecord(record);
    if (options.realContestantIds !== undefined) {
      assertHumanRatingRecordIsBlind(record, options.realContestantIds);
    }
  }
  const anchor: LockedHumanRatingAnchor = {
    policy: HUMAN_CALIBRATION_ANCHOR_POLICY,
    locked: true,
    records: deepFreeze(
      records.map((r) => ({ ...r, dimensions: r.dimensions.map((d) => ({ ...d })) })),
    ),
  };
  return deepFreeze(anchor);
}

// ---------------------------------------------------------------------------
// De-anonymization (PANEL SIDE ONLY — the human never sees this).
// ---------------------------------------------------------------------------

/** One de-anonymized human score: blind handle resolved to the real contestant. */
export type DeanonymizedHumanScore = {
  raterId: string;
  unitId: string;
  /** The real contestant id (resolved on the panel side from the blind handle). */
  contestantId: string;
  dimensionId: BenchmarkRubricDimensionId;
  score: BenchmarkRubricScore;
  notes: string | null;
};

/**
 * Resolve each locked human rating's BLIND handle back to its real contestant id
 * using the panel-held `HumanRatingBlinding` maps. This is the ONLY place blind
 * handles meet system identities, and it happens on the PANEL side — exactly as
 * the judge panel de-anonymizes after scoring. Throws if a record references a
 * (rater, unit) or blind handle with no blinding.
 */
export function deanonymizeHumanRatings(
  anchor: LockedHumanRatingAnchor,
  blindings: readonly HumanRatingBlinding[],
): DeanonymizedHumanScore[] {
  const byKey = new Map<string, Map<string, string>>();
  for (const blinding of blindings) {
    byKey.set(blindingKey(blinding.raterId, blinding.unitId), blinding.deanonymize);
  }
  const out: DeanonymizedHumanScore[] = [];
  for (const record of anchor.records) {
    const deanon = byKey.get(blindingKey(record.raterId, record.unitId));
    if (deanon === undefined) {
      throw new HumanCalibrationAnchorError(
        `no blinding for rater '${record.raterId}' unit '${record.unitId}' — cannot de-anonymize`,
      );
    }
    const contestantId = deanon.get(record.blindLabel);
    if (contestantId === undefined) {
      throw new HumanCalibrationAnchorError(
        `blind handle '${record.blindLabel}' (rater '${record.raterId}', unit '${record.unitId}') is not in the blinding map`,
      );
    }
    for (const dim of record.dimensions) {
      out.push({
        raterId: record.raterId,
        unitId: record.unitId,
        contestantId,
        dimensionId: dim.dimensionId,
        score: dim.score,
        notes: dim.notes ?? null,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. The CALIBRATION report — LLM panel vs human anchor (§8).
// ---------------------------------------------------------------------------

/** Which way the panel diverges from humans on a dimension (§8). */
export type PanelDivergenceDirection = "panel_over_scores" | "panel_under_scores" | "aligned";

/** Per-dimension panel-vs-human calibration (§8). */
export type DimensionCalibration = {
  dimensionId: BenchmarkRubricDimensionId;
  /** (unit, contestant) items BOTH the panel and the humans scored on this dim. */
  itemsCompared: number;
  /** Mean panel score over the compared items. */
  panelMean: number;
  /** Mean human score over the compared items. */
  humanMean: number;
  /** Mean |panel − human| over items (0 = identical, 4 = maximal). */
  meanAbsDiff: number;
  /** `1 − meanAbsDiff/4` — bounded [0,1]. */
  normalizedAgreement: number;
  /** Mean SIGNED (panel − human); + = panel over-scores (too lenient), − = under-scores. */
  signedMeanDiff: number;
  /** Which way (and whether) the panel diverges, per `PANEL_DIVERGENCE_ALERT_THRESHOLD`. */
  divergence: PanelDivergenceDirection;
  /** Pearson correlation of panel vs human item means; null when < 2 items or no variance. */
  pearson: number | null;
};

export type PanelHumanCalibrationReport = {
  /** §8 locked-anchor policy — the ratings calibrate the PANEL only, never Itotori. */
  anchorPolicy: typeof HUMAN_CALIBRATION_ANCHOR_POLICY;
  /** The raters whose ratings back this report. */
  raters: string[];
  /** The judge ids whose scores this report calibrated against the humans. */
  judgeIds: string[];
  /** Per-dimension calibration (only dimensions with ≥1 compared item). */
  byDimension: DimensionCalibration[];
  /** Dimensions where the panel diverges (|signedMeanDiff| ≥ threshold), worst first. */
  divergentDimensions: Array<{
    dimensionId: BenchmarkRubricDimensionId;
    signedMeanDiff: number;
    divergence: PanelDivergenceDirection;
  }>;
  /** The same calibration rolled up across all (item, dimension) pairs. */
  overall: {
    itemsCompared: number;
    meanAbsDiff: number | null;
    normalizedAgreement: number | null;
    signedMeanDiff: number | null;
    pearson: number | null;
  };
};

export type BuildPanelHumanCalibrationReportInput = {
  /** The §4 panel scores (`BlindJudgePanelResult.contestantDimensionScores`). */
  panelScores: readonly ContestantDimensionScore[];
  /** The de-anonymized human anchor scores (`deanonymizeHumanRatings`). */
  humanScores: readonly DeanonymizedHumanScore[];
};

/**
 * Compare the §4 LLM judge panel against the §8 human anchor. For each dimension,
 * over the (unit, contestant) items BOTH scored: panel mean vs human mean,
 * agreement (1 − mean|Δ|/4), SIGNED divergence (panel over/under-scores humans),
 * and Pearson correlation — plus the same rolled up overall. A panel that tracks
 * humans → high agreement, ~0 signed divergence; a systematically-biased panel →
 * a large signed gap that surfaces as a flagged `divergentDimensions` entry.
 *
 * The human scores are consumed READ-ONLY as an external anchor (§8); this
 * report is the ONLY consumer, and it is used to calibrate/validate the PANEL,
 * never to tune Itotori.
 */
export function buildPanelHumanCalibrationReport(
  input: BuildPanelHumanCalibrationReportInput,
): PanelHumanCalibrationReport {
  if (input.panelScores.length === 0) {
    throw new HumanCalibrationAnchorError("no panel scores to calibrate");
  }
  if (input.humanScores.length === 0) {
    throw new HumanCalibrationAnchorError("no human anchor scores to calibrate against");
  }

  // Aggregate to per-item MEANS (mean over judges / mean over raters) keyed by
  // (unit, contestant, dimension) so panel and human are compared like-for-like.
  const panelItem = meanByItem(
    input.panelScores.map((s) => ({
      key: itemKey(s.unitId, s.contestantId, s.dimensionId),
      dimensionId: s.dimensionId,
      score: s.score,
    })),
  );
  const humanItem = meanByItem(
    input.humanScores.map((s) => ({
      key: itemKey(s.unitId, s.contestantId, s.dimensionId),
      dimensionId: s.dimensionId,
      score: s.score,
    })),
  );

  // Shared items → per-dimension paired (panel, human) means.
  const byDimensionPairs = new Map<
    BenchmarkRubricDimensionId,
    Array<{ panel: number; human: number }>
  >();
  const overallPanel: number[] = [];
  const overallHuman: number[] = [];
  for (const [key, panel] of panelItem) {
    const human = humanItem.get(key);
    if (human === undefined) {
      continue;
    }
    const pairs = byDimensionPairs.get(panel.dimensionId) ?? [];
    pairs.push({ panel: panel.mean, human: human.mean });
    byDimensionPairs.set(panel.dimensionId, pairs);
    overallPanel.push(panel.mean);
    overallHuman.push(human.mean);
  }

  const byDimension: DimensionCalibration[] = [];
  for (const dimensionId of BENCHMARK_RUBRIC_DIMENSION_IDS) {
    const pairs = byDimensionPairs.get(dimensionId);
    if (pairs === undefined || pairs.length === 0) {
      continue;
    }
    const panelArr = pairs.map((p) => p.panel);
    const humanArr = pairs.map((p) => p.human);
    const diffs = pairs.map((p) => p.panel - p.human);
    const meanAbsDiff = mean(diffs.map((d) => Math.abs(d)));
    const signedMeanDiff = mean(diffs);
    byDimension.push({
      dimensionId,
      itemsCompared: pairs.length,
      panelMean: round(mean(panelArr)),
      humanMean: round(mean(humanArr)),
      meanAbsDiff: round(meanAbsDiff),
      normalizedAgreement: round(1 - meanAbsDiff / 4),
      signedMeanDiff: round(signedMeanDiff),
      divergence: divergenceOf(signedMeanDiff),
      pearson: nullableRound(pearson(panelArr, humanArr)),
    });
  }

  const divergentDimensions = byDimension
    .filter((d) => d.divergence !== "aligned")
    .map((d) => ({
      dimensionId: d.dimensionId,
      signedMeanDiff: d.signedMeanDiff,
      divergence: d.divergence,
    }))
    .sort((a, b) => Math.abs(b.signedMeanDiff) - Math.abs(a.signedMeanDiff));

  const overallDiffs = overallPanel.map((p, i) => p - overallHuman[i]!);
  const overall = {
    itemsCompared: overallPanel.length,
    meanAbsDiff:
      overallDiffs.length === 0 ? null : round(mean(overallDiffs.map((d) => Math.abs(d)))),
    normalizedAgreement:
      overallDiffs.length === 0 ? null : round(1 - mean(overallDiffs.map((d) => Math.abs(d))) / 4),
    signedMeanDiff: overallDiffs.length === 0 ? null : round(mean(overallDiffs)),
    pearson: nullableRound(pearson(overallPanel, overallHuman)),
  };

  return {
    anchorPolicy: HUMAN_CALIBRATION_ANCHOR_POLICY,
    raters: [...new Set(input.humanScores.map((s) => s.raterId))].sort(),
    judgeIds: [...new Set(input.panelScores.map((s) => s.judgeId))].sort(),
    byDimension,
    divergentDimensions,
    overall,
  };
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function blindingKey(raterId: string, unitId: string): string {
  return `${raterId} ${unitId}`;
}

function itemKey(unitId: string, contestantId: string, dimensionId: string): string {
  return `${unitId} ${contestantId} ${dimensionId}`;
}

function meanByItem(
  rows: ReadonlyArray<{ key: string; dimensionId: BenchmarkRubricDimensionId; score: number }>,
): Map<string, { dimensionId: BenchmarkRubricDimensionId; mean: number }> {
  const acc = new Map<
    string,
    { dimensionId: BenchmarkRubricDimensionId; sum: number; n: number }
  >();
  for (const row of rows) {
    const cur = acc.get(row.key) ?? { dimensionId: row.dimensionId, sum: 0, n: 0 };
    cur.sum += row.score;
    cur.n += 1;
    acc.set(row.key, cur);
  }
  const out = new Map<string, { dimensionId: BenchmarkRubricDimensionId; mean: number }>();
  for (const [key, v] of acc) {
    out.set(key, { dimensionId: v.dimensionId, mean: v.sum / v.n });
  }
  return out;
}

function divergenceOf(signedMeanDiff: number): PanelDivergenceDirection {
  if (signedMeanDiff >= PANEL_DIVERGENCE_ALERT_THRESHOLD) {
    return "panel_over_scores";
  }
  if (signedMeanDiff <= -PANEL_DIVERGENCE_ALERT_THRESHOLD) {
    return "panel_under_scores";
  }
  return "aligned";
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Pearson product-moment correlation of two equal-length series. Returns null
 * when there are fewer than 2 points or either series has zero variance (a
 * correlation is undefined there — a constant series carries no linear signal).
 */
function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  const n = xs.length;
  if (n < 2 || ys.length !== n) {
    return null;
  }
  const mx = mean(xs);
  const my = mean(ys);
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx === 0 || vy === 0) {
    return null;
  }
  return cov / Math.sqrt(vx * vy);
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function nullableRound(value: number | null): number | null {
  return value === null ? null : round(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
