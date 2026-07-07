// itotori-strong-caliber-readiness-gate — the CONTINUE-vs-STRONG-CALIBER-DONE
// verdict that folds every benchmark + regression + QA + human-anchor signal
// into ONE actionable confidence call, for ANY project run.
//
// This node owns NO scoring of its own. It CONSUMES the signals the benchmark
// facility + backlog + QA-agent + human-anchor stages already produced and
// emits a documented verdict the way `composeAlphaReadiness` does for alpha:
//
//   - benchmark contestants + confidence
//       (`ContestantRanking` from §9 `rankContestants` /
//        `BenchmarkFacilityResult.ranking` — the system-under-test's standing)
//   - humanAnchor        (§8 `PanelHumanCalibrationReport` + `DeanonymizedHumanScore[]`)
//   - regression signal  (§10.3 `BenchmarkImprovementBacklog.perDimensionRegression`)
//   - QA score           (the QA-agent calibration — seeded F1 is the primary accuracy)
//   - human-anchor ratings (the §8 de-anonymized ratings backing the anchor)
//   - (optional) the §9 meta-validity run-gating verdict (`MetaValidityReport`)
//
// The verdict is deterministic + evidence-backed: every gate names the exact
// signal values that drove its pass/fail, and `failedGateIds` tells the director
// precisely what to fix before another pass is worth running. The decision maps
// 1:1 to the studio's `confidence` state — `keep_iterating` (CONTINUE) vs
// `strong_caliber` (STRONG_CALIBER_DONE).
//
// The HUMAN ANCHOR is the primary kill on overfitting (per the benchmark
// design): it is the one signal fully OUTSIDE the LLM/pipeline loop (§8), so a
// self-favorable benchmark cannot rig it. `self-score >= humanAnchor` is the
// single gate most directly responsible for separating honest strong-caliber
// work from panel-flattering noise; a regression on a prior-strength dimension
// or a thin QA pass can veto it regardless.

import type {
  ContestantRanking,
  MetaValidityCheckName,
  MetaValidityReport,
} from "./meta-validity-harness.js";
import type { BacklogRegressionRef } from "./actionable-backlog.js";
import type {
  DeanonymizedHumanScore,
  PanelHumanCalibrationReport,
} from "./human-calibration-anchor.js";

export class StrongCaliberReadinessGateError extends Error {
  constructor(detail: string) {
    super(`strong-caliber-readiness-gate refused: ${detail}`);
    this.name = "StrongCaliberReadinessGateError";
  }
}

// ---------------------------------------------------------------------------
// Thresholds (documented, recorded on every verdict for reproducibility).
// ---------------------------------------------------------------------------

/**
 * The gates' numeric floors. The exact values are Trevor's per the §12 "open
 * decisions"; the defaults here are REASONED start-strict points — recorded on
 * every verdict so a run is reproducible and the floors are auditable.
 *
 * Why each signal + threshold:
 *
 *   - `selfScoreVsHumanAnchorFloor` (default 0): the PRIMARY overfitting kill.
 *     The system-under-test's mean judge score (0–4 rubric — the SAME scale the
 *     §8 humans rate on) must meet or beat the human anchor's mean judge score
 *     BY at least this margin. The human anchor is fully outside the LLM loop
 *     (§8), so this is the one comparison a self-favorable benchmark cannot rig.
 *     A floor of 0 means "at least as good as the humans on the shared rubric";
 *     raise it to demand a margin (e.g. 0.5 = must beat the humans by half a
 *     rubric point).
 *
 *   - `minHumanRatings` (default 1): the human-anchor quorum. The §8 anchor is
 *     only meaningful with at least this many de-anonymized human ratings
 *     backing it. Default 1 reflects Trevor as the sole rater (the §8 anchor is
 *     his external call); raise it when additional raters come online.
 *
 *   - `maxRegressions` (default 0): the regression veto. The number of
 *     per-dimension signals that REGRESSED vs the prior run (§10.3
 *     `direction === "regressed"`) must not exceed this. Default 0 = any
 *     regression forces another pass — a strong-caliber claim must not come at
 *     the cost of a prior-strength dimension.
 *
 *   - `minQaF1` (default 0.7): the QA-agent seeded-F1 floor. The QA-agent's
 *     ability to recover seeded defects (precision + recall → F1) is the
 *     sharpest read on whether the localization actually passes real QA. 0.7 is
 *     a conventional "solid" F1; a null QA signal (QA not run) fails this gate.
 *
 *   - `minPanelHumanPearson` (default 0.6): the §9.3 calibration floor. When a
 *     panel↔human calibration report is supplied, the overall Pearson must meet
 *     this to confirm the panel tracks human judgment (the §8 anchor's purpose).
 *     0.6 is a conventional "strong" positive correlation.
 *
 *   - `requireMetaValidityValid` (default true): when a §9 `MetaValidityReport`
 *     is supplied, its run-gating `valid` verdict must hold (sensitivity +
 *     robustness + calibration). A benchmark that fails its OWN self-checks
 *     cannot certify strong caliber.
 */
export type StrongCaliberReadinessThresholds = {
  selfScoreVsHumanAnchorFloor: number;
  minHumanRatings: number;
  maxRegressions: number;
  minQaF1: number;
  minPanelHumanPearson: number;
  requireMetaValidityValid: boolean;
};

export const DEFAULT_STRONG_CALIBER_THRESHOLDS: StrongCaliberReadinessThresholds = {
  selfScoreVsHumanAnchorFloor: 0,
  minHumanRatings: 1,
  maxRegressions: 0,
  minQaF1: 0.7,
  minPanelHumanPearson: 0.6,
  requireMetaValidityValid: true,
};

/**
 * §12 open-decision provenance, stamped on every verdict so the start-strict
 * defaults are explicit and auditable (mirrors `META_VALIDITY_THRESHOLD_PROVENANCE`).
 */
export const STRONG_CALIBER_THRESHOLD_PROVENANCE = {
  section12OpenDecision: true,
  rationale: "reasoned start-strict defaults; exact floors are Trevor's per §12.5",
  methodologyRef: "docs/itotori-translation-benchmark-methodology.md#12-open-decisions",
} as const;

// The human-anchor + judge rubric share a 0–4 scale; the self-vs-human
// comparison uses a small tolerance so near-equal scores do not spuriously flip
// the primary gate (mirrors `SCORE_EPSILON` in actionable-backlog).
const SELF_SCORE_EPSILON = 1e-9;

// ---------------------------------------------------------------------------
// The QA signal — a project-agnostic QA-accuracy read.
// ---------------------------------------------------------------------------

/**
 * The QA signal the gate consumes. The `f1` (seeded-defect precision × recall)
 * is the PRIMARY QA-accuracy score; `null` means "QA not run". The supporting
 * fields surface on the verdict evidence so a reviewer sees the full QA shape
 * (they do NOT add gates of their own — `f1` is the gate).
 *
 * This is intentionally a thin, generic shape (not the full
 * `QaAgentMetricsV02`) so the gate stays project-/game-agnostic: any caller
 * that can produce an F1 + a finding count can drive it.
 */
export type StrongCaliberReadinessQaSignal = {
  /** Primary QA-accuracy score (seeded-defect F1), range 0..1; null = QA not run. */
  f1: number | null;
  /** Seeded-defect recall (0..1) — surfaced on the verdict, not gated on its own. */
  seededRecall?: number | null;
  /** Seeded-defect precision (0..1) — surfaced on the verdict, not gated on its own. */
  seededPrecision?: number | null;
  /** Total QA findings emitted — a count that contextualizes the F1. */
  findingsEmitted?: number;
};

// ---------------------------------------------------------------------------
// The input.
// ---------------------------------------------------------------------------

/**
 * The signals the readiness gate folds into a verdict. Every field is a
 * real artifact the upstream benchmark stages already produced — the gate owns
 * no scoring of its own.
 *
 * All signals are OPTIONAL except the benchmark ranking + the system-under-test
 * id: a missing signal fails the gate that needs it (and the verdict's evidence
 * records `null`), so the gate degrades honestly rather than silently passing.
 */
export type StrongCaliberReadinessGateInput = {
  /** The system whose strong-caliber readiness is being decided. */
  systemUnderTestId: string;
  /** §9 `ContestantRanking` (the contestants ladder incl. the system under test). */
  ranking: ContestantRanking;
  /**
   * §8 `PanelHumanCalibrationReport` (panel-vs-human). The PRIMARY overfitting
   * kill — the human anchor is fully outside the LLM loop. Null fails the
   * self-score-meets-human-anchor gate (no anchor to beat = not strong-caliber).
   */
  humanAnchor?: PanelHumanCalibrationReport | null;
  /**
   * The §8 de-anonymized human ratings backing the anchor (`deanonymizeHumanRatings`).
   * Counted for the human-anchor quorum gate. Empty/omitted fails the quorum.
   */
  humanRatings?: readonly DeanonymizedHumanScore[];
  /**
   * §10.3 regression telemetry vs the prior run
   * (`BenchmarkImprovementBacklog.perDimensionRegression`). A regressed
   * dimension count past `maxRegressions` forces CONTINUE.
   */
  regression?: {
    perDimensionRegression: readonly BacklogRegressionRef[];
  };
  /** The QA-accuracy signal (seeded-defect F1 is the gated value). */
  qa?: StrongCaliberReadinessQaSignal | null;
  /**
   * Optional §9 `MetaValidityReport`. When supplied (and
   * `requireMetaValidityValid` is true) its `valid` verdict must hold. A
   * benchmark that fails its own self-checks cannot certify strong caliber.
   */
  metaValidity?: Pick<MetaValidityReport, "valid" | "failedChecks"> | null;
  /** Optional threshold overrides (recorded on the verdict). */
  thresholds?: Partial<StrongCaliberReadinessThresholds>;
};

// ---------------------------------------------------------------------------
// The verdict.
// ---------------------------------------------------------------------------

/** The gate ids, in the order the gates evaluate. */
export type StrongCaliberReadinessGateId =
  | "self-score-meets-human-anchor"
  | "regressions-clean"
  | "qa-accuracy-threshold"
  | "human-anchor-quorum"
  | "panel-calibrated"
  | "meta-validity-valid";

/**
 * One pass/fail gate. `detail` states only facts drawn from the composed
 * signals (README-safe — no superlatives, no unverifiable claim), mirroring
 * `AlphaReadinessGate`.
 */
export type StrongCaliberReadinessGate = {
  readonly id: StrongCaliberReadinessGateId;
  readonly title: string;
  readonly status: "pass" | "fail";
  readonly detail: string;
};

export type StrongCaliberReadinessFindingKind = "gate_failed" | "no_human_anchor" | "qa_not_run";

/** A structured failure that stays VISIBLE in the verdict. */
export type StrongCaliberReadinessFinding = {
  readonly kind: StrongCaliberReadinessFindingKind;
  readonly gateId: StrongCaliberReadinessGateId | null;
  readonly message: string;
};

/**
 * The evidence the verdict rests on — every signal value the gates reasoned
 * over, surfaced so a reviewer can audit the call without re-running the
 * benchmark. `null` means the signal was absent (and the gate that needed it
 * failed accordingly).
 */
export type StrongCaliberReadinessEvidence = {
  /** System-under-test mean judge score on the shared 0–4 rubric. */
  readonly selfJudgeScore: number | null;
  /** System-under-test combined 0..1 aggregate (judge + metric) from the ranking. */
  readonly selfAggregateScore: number | null;
  /** The human anchor's mean judge score on the shared 0–4 rubric. */
  readonly humanAnchorScore: number | null;
  /** Whether self >= human anchor (the primary overfitting kill); null = no anchor. */
  readonly selfMeetsHumanAnchor: boolean | null;
  /** Count of per-dimension signals that REGRESSED vs the prior run. */
  readonly regressionCount: number;
  /** Total regression signals compared (contextualizes the count). */
  readonly regressionSignalCount: number;
  /** The QA-agent seeded-defect F1 (the gated QA-accuracy value). */
  readonly qaF1: number | null;
  /** Number of human ratings backing the anchor (the quorum). */
  readonly humanRatingCount: number;
  /** Overall panel↔human Pearson correlation; null = no calibration report. */
  readonly panelHumanPearson: number | null;
  /** The §9 meta-validity verdict; null = not supplied. */
  readonly metaValidityValid: boolean | null;
};

/**
 * The readiness verdict. The `decision` is the actionable call (CONTINUE =
 * iterate another pass; STRONG_CALIBER_DONE = stop) and `confidence` is the
 * 1:1 studio-facing read (`keep_iterating` vs `strong_caliber`). The gates +
 * evidence + findings name EXACTLY what drove it.
 */
export type StrongCaliberReadinessVerdict = {
  readonly schemaVersion: typeof STRONG_CALIBER_READINESS_SCHEMA_VERSION;
  readonly systemUnderTestId: string;
  readonly decision: "CONTINUE" | "STRONG_CALIBER_DONE";
  readonly confidence: "keep_iterating" | "strong_caliber";
  readonly thresholds: StrongCaliberReadinessThresholds;
  readonly thresholdProvenance: typeof STRONG_CALIBER_THRESHOLD_PROVENANCE;
  readonly gates: readonly StrongCaliberReadinessGate[];
  readonly failedGateIds: readonly StrongCaliberReadinessGateId[];
  readonly evidence: StrongCaliberReadinessEvidence;
  readonly findings: readonly StrongCaliberReadinessFinding[];
};

export const STRONG_CALIBER_READINESS_SCHEMA_VERSION =
  "itotori.strong_caliber_readiness.v0.1" as const;

// ---------------------------------------------------------------------------
// The gate.
// ---------------------------------------------------------------------------

/**
 * Fold every benchmark + regression + QA + human-anchor signal into ONE
 * documented CONTINUE-vs-STRONG-CALIBER-DONE verdict.
 *
 * STRONG_CALIBER_DONE iff EVERY gate passes; otherwise CONTINUE, with
 * `failedGateIds` + `findings` naming precisely what to fix. Deterministic: a
 * pure function of its inputs, no clock, no randomness, no model.
 *
 * The verdict always carries its full evidence (the signal values each gate
 * reasoned over), so a reviewer can audit the call without re-running the
 * benchmark. Project-/game-agnostic — no field references a specific work.
 */
export function decideStrongCaliberReadiness(
  input: StrongCaliberReadinessGateInput,
): StrongCaliberReadinessVerdict {
  if (input.systemUnderTestId.trim().length === 0) {
    throw new StrongCaliberReadinessGateError("systemUnderTestId is required");
  }
  const sut = input.systemUnderTestId;

  const thresholds: StrongCaliberReadinessThresholds = {
    ...DEFAULT_STRONG_CALIBER_THRESHOLDS,
    ...input.thresholds,
  };

  const selfEntry = input.ranking.entries.find((e) => e.contestantId === sut) ?? null;
  if (selfEntry === null) {
    throw new StrongCaliberReadinessGateError(`system under test '${sut}' is not in the ranking`);
  }

  const humanAnchor = input.humanAnchor ?? null;
  const humanRatings = input.humanRatings ?? [];
  const regressionRefs = input.regression?.perDimensionRegression ?? [];
  const qa = input.qa ?? null;
  const metaValidity = input.metaValidity ?? null;

  // ── Signal reads ──────────────────────────────────────────────────────────
  // Self judge score (0–4) is the SAME scale the §8 humans rate on, so it is
  // the like-for-like comparison the primary overfitting-kill gate uses. The
  // aggregate (0..1) is surfaced as evidence (it folds in the metric signal).
  const selfJudgeScore = selfEntry.judgeMean;
  const selfAggregateScore = selfEntry.aggregateScore;
  const humanAnchorScore = humanAnchorMeanJudgeScore(humanAnchor);
  const selfMeetsHumanAnchor =
    selfJudgeScore !== null && humanAnchorScore !== null
      ? selfJudgeScore >=
        humanAnchorScore + thresholds.selfScoreVsHumanAnchorFloor - SELF_SCORE_EPSILON
      : null;

  const regressionCount = regressionRefs.filter((r) => r.direction === "regressed").length;
  const regressionSignalCount = regressionRefs.length;
  const qaF1 = qa?.f1 ?? null;
  const humanRatingCount = humanRatings.length;
  const panelHumanPearson = humanAnchor?.overall.pearson ?? null;
  const metaValidityValid = metaValidity?.valid ?? null;

  // ── Gate 1 (PRIMARY): self-score meets the human anchor. ──────────────────
  // The human anchor is fully outside the LLM loop (§8), so this is the one
  // comparison a self-favorable benchmark cannot rig. No anchor → the gate
  // fails (strong caliber cannot be certified without an external anchor).
  let selfVsHumanDetail: string;
  if (humanAnchorScore === null) {
    selfVsHumanDetail =
      "No human anchor supplied — the primary overfitting kill cannot run (the anchor is fully outside the LLM loop, §8).";
  } else if (selfJudgeScore === null) {
    selfVsHumanDetail = `System under test '${sut}' has no judge mean in the ranking; cannot compare to human anchor ${fmtScore(humanAnchorScore)}.`;
  } else if (selfMeetsHumanAnchor) {
    selfVsHumanDetail = `Self judge mean ${fmtScore(selfJudgeScore)} >= human anchor ${fmtScore(humanAnchorScore)} + margin floor ${thresholds.selfScoreVsHumanAnchorFloor}.`;
  } else {
    selfVsHumanDetail = `Self judge mean ${fmtScore(selfJudgeScore)} below human anchor ${fmtScore(humanAnchorScore)} + margin floor ${thresholds.selfScoreVsHumanAnchorFloor}.`;
  }
  const selfVsHumanGate: StrongCaliberReadinessGate = {
    id: "self-score-meets-human-anchor",
    title: "System-under-test judge score meets the human anchor",
    status: selfMeetsHumanAnchor === true ? "pass" : "fail",
    detail: selfVsHumanDetail,
  };

  // ── Gate 2: regressions clean. ────────────────────────────────────────────
  const regressionsClean = regressionCount <= thresholds.maxRegressions;
  const regressionGate: StrongCaliberReadinessGate = {
    id: "regressions-clean",
    title: "No per-dimension regressions vs the prior run",
    status: regressionsClean ? "pass" : "fail",
    detail: regressionsClean
      ? `${regressionCount} regressed signal(s) of ${regressionSignalCount} compared (max ${thresholds.maxRegressions}).`
      : `${regressionCount} regressed signal(s) of ${regressionSignalCount} compared exceeds max ${thresholds.maxRegressions} — a prior-strength dimension slipped.`,
  };

  // ── Gate 3: QA accuracy threshold. ────────────────────────────────────────
  const qaPasses = qaF1 !== null && qaF1 >= thresholds.minQaF1;
  const qaGate: StrongCaliberReadinessGate = {
    id: "qa-accuracy-threshold",
    title: "QA-agent seeded-defect F1 meets the floor",
    status: qaPasses ? "pass" : "fail",
    detail:
      qaF1 === null
        ? `No QA F1 supplied (QA not run); floor is ${thresholds.minQaF1}.`
        : qaPasses
          ? `QA F1 ${fmtScore(qaF1)} >= floor ${thresholds.minQaF1}.`
          : `QA F1 ${fmtScore(qaF1)} below floor ${thresholds.minQaF1}.`,
  };

  // ── Gate 4: human-anchor quorum. ──────────────────────────────────────────
  const quorumPasses = humanRatingCount >= thresholds.minHumanRatings;
  const quorumGate: StrongCaliberReadinessGate = {
    id: "human-anchor-quorum",
    title: "Human-anchor rating quorum met",
    status: quorumPasses ? "pass" : "fail",
    detail: quorumPasses
      ? `${humanRatingCount} human rating(s) back the anchor (min ${thresholds.minHumanRatings}).`
      : `${humanRatingCount} human rating(s) below the quorum of ${thresholds.minHumanRatings}.`,
  };

  // ── Gate 5: panel calibrated against humans. ──────────────────────────────
  // Only applies when a calibration report was supplied; absent → no pearson,
  // recorded as evidence `null`. We still PASS this gate when no calibration
  // report is supplied (it is an optional strengthening signal, not a hard
  // requirement the way the human-anchor quorum is), but surface the absence.
  const panelCalibrated =
    panelHumanPearson === null ? true : panelHumanPearson >= thresholds.minPanelHumanPearson;
  const panelGate: StrongCaliberReadinessGate = {
    id: "panel-calibrated",
    title: "Judge panel calibrated to the human anchor",
    status: panelCalibrated ? "pass" : "fail",
    detail:
      panelHumanPearson === null
        ? "No panel↔human calibration report supplied; gate skipped (the human-anchor quorum + self-score gates already back the anchor)."
        : panelCalibrated
          ? `Panel↔human Pearson ${fmtScore(panelHumanPearson)} >= floor ${thresholds.minPanelHumanPearson}.`
          : `Panel↔human Pearson ${fmtScore(panelHumanPearson)} below floor ${thresholds.minPanelHumanPearson} — the panel is not tracking humans.`,
  };

  // ── Gate 6: meta-validity valid (when supplied). ──────────────────────────
  // Only applies when a §9 MetaValidityReport is supplied. When
  // `requireMetaValidityValid` is true and a report is supplied, `valid` must
  // hold. An absent report is passed-through (the gate cannot run on nothing).
  const metaApplies = metaValidityValid !== null && thresholds.requireMetaValidityValid;
  const metaPasses = metaValidityValid === null ? true : metaValidityValid;
  const metaGate: StrongCaliberReadinessGate = {
    id: "meta-validity-valid",
    title: "§9 meta-validity self-check passed",
    status: !metaApplies || metaPasses ? "pass" : "fail",
    detail:
      metaValidityValid === null
        ? "No §9 meta-validity report supplied; gate skipped."
        : metaValidityValid
          ? "§9 sensitivity + robustness + calibration all passed."
          : `§9 meta-validity failed checks: ${metaValidity?.failedChecks.join(", ") ?? "(none named)"}.`,
  };

  const gates: StrongCaliberReadinessGate[] = [
    selfVsHumanGate,
    regressionGate,
    qaGate,
    quorumGate,
    panelGate,
    metaGate,
  ];

  const findings: StrongCaliberReadinessFinding[] = [];
  if (humanAnchorScore === null) {
    findings.push({
      kind: "no_human_anchor",
      gateId: "self-score-meets-human-anchor",
      message:
        "no §8 human anchor supplied — the primary overfitting kill cannot run; strong caliber cannot be certified without an external anchor",
    });
  }
  if (qaF1 === null) {
    findings.push({
      kind: "qa_not_run",
      gateId: "qa-accuracy-threshold",
      message: "no QA F1 supplied (QA-agent not run); the QA-accuracy gate cannot pass",
    });
  }
  for (const gate of gates) {
    if (gate.status === "fail") {
      findings.push({
        kind: "gate_failed",
        gateId: gate.id,
        message: `gate '${gate.id}' (${gate.title}) failed: ${gate.detail}`,
      });
    }
  }

  const failedGateIds = gates.filter((g) => g.status === "fail").map((g) => g.id);
  const decision: "CONTINUE" | "STRONG_CALIBER_DONE" =
    failedGateIds.length === 0 ? "STRONG_CALIBER_DONE" : "CONTINUE";

  const evidence: StrongCaliberReadinessEvidence = {
    selfJudgeScore: roundOrNull(selfJudgeScore),
    selfAggregateScore: roundOrNull(selfAggregateScore),
    humanAnchorScore: roundOrNull(humanAnchorScore),
    selfMeetsHumanAnchor,
    regressionCount,
    regressionSignalCount,
    qaF1: roundOrNull(qaF1),
    humanRatingCount,
    panelHumanPearson: roundOrNull(panelHumanPearson),
    metaValidityValid,
  };

  return {
    schemaVersion: STRONG_CALIBER_READINESS_SCHEMA_VERSION,
    systemUnderTestId: sut,
    decision,
    confidence: decision === "STRONG_CALIBER_DONE" ? "strong_caliber" : "keep_iterating",
    thresholds,
    thresholdProvenance: STRONG_CALIBER_THRESHOLD_PROVENANCE,
    gates,
    failedGateIds,
    evidence,
    findings,
  };
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/**
 * The human anchor's mean judge score on the shared 0–4 rubric — the mean of
 * the per-dimension `humanMean` values the §8 calibration report records.
 * Returns null when no report or no compared dimensions are supplied (the
 * self-vs-human gate cannot run then).
 */
function humanAnchorMeanJudgeScore(report: PanelHumanCalibrationReport | null): number | null {
  if (report === null) {
    return null;
  }
  const dims = report.byDimension;
  if (dims.length === 0) {
    return null;
  }
  let sum = 0;
  let n = 0;
  for (const dim of dims) {
    sum += dim.humanMean;
    n += 1;
  }
  return n === 0 ? null : sum / n;
}

function fmtScore(value: number): string {
  return value.toFixed(3);
}

function roundOrNull(value: number | null): number | null {
  return value === null ? null : Math.round(value * 1e6) / 1e6;
}
