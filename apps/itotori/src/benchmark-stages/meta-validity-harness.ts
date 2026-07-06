// benchmark-meta-validity-harness (§9) — the benchmark validates ITSELF.
//
// Methodology §9 (docs/itotori-translation-benchmark-methodology.md). The honesty
// mechanism: a benchmark run earns the right to make claims only by passing its
// OWN tests. This harness runs the three §9 meta-validity checks over the SAME
// real subsystems a live run uses — the blind judge panel (§4, `runBlindJudgePanel`),
// the deterministic metric suite (§3, `runDeterministicMetricSuite`), and the
// human-calibration report (§8, `buildPanelHumanCalibrationReport`) — and emits a
// run-gating `MetaValidityReport` whose `valid` verdict names any failing check.
//
//   1. SENSITIVITY (sabotage). A deliberately-SABOTAGED Itotori output (seeded
//      defects per the taxonomy's `seededDefectKinds`) MUST rank BELOW the
//      fan-MTL contestant — AND the same instrument must NOT already rank the
//      CLEAN Itotori output below fan-MTL (else the "loss" is not caused by the
//      sabotage). The sabotage flows through the REAL scoring: the degraded text
//      is re-run through the actual judge panel + deterministic metric suite, so
//      the lower rank is EARNED by the worse text, not asserted by fiat. This is
//      the single most important guardrail against a self-favorable benchmark.
//   2. ROBUSTNESS (swap tests). The ranking VERDICT must be stable under a
//      judge-swap (a different judge subset/composition, still meeting the §4.1
//      family floor) and a contestant-order-swap (a different order seed — the
//      panel already randomizes order per judge). Instability is measured as the
//      fraction of contestant pairs whose relative order flips vs the baseline;
//      past the tolerance the run is not trustworthy and is flagged.
//   3. CALIBRATION (human correlation). The benchmark ranking must correlate with
//      the §8 human anchor (`buildPanelHumanCalibrationReport` Pearson). Below a
//      correlation floor the run is flagged uncalibrated.
//
// Run-gating: `valid` is true iff all three pass; `failedChecks` names the
// culprits. Thresholds (robustness tolerance, calibration floor) are configurable
// and RECORDED on the report — the exact numeric floors are a §12 open decision,
// so the defaults here are reasoned starting points, flagged as such.
//
// Nothing here makes a network call. The judges are injected `BlindJudgeAdapter`s
// (a deterministic FIXTURE judge drives the tests; the real ZDR multi-family
// panel plugs into the identical seam), and the metric suite is a pure function.

import { type BenchmarkQualityRubric } from "@itotori/localization-bridge-schema";
import type { NarrativeStructure } from "../agents/structure-informed-context/index.js";
import {
  runBlindJudgePanel,
  type BlindJudgeAdapter,
  type BlindJudgePanelResult,
  type ContestantDimensionScore,
} from "./blind-judge-panel.js";
import {
  buildDecodedContextFeed,
  type ContestantCandidate,
  type DecodedContextUnitRef,
} from "./decoded-context-feed.js";
import {
  runDeterministicMetricSuite,
  type BoxMetrics,
  type CanonTerm,
  type DeterministicMetricConfig,
  type DeterministicMetricSuiteResult,
  type MetricScore,
  type MetricSystemInput,
  type MetricUnit,
} from "./deterministic-metrics/index.js";
import {
  buildPanelHumanCalibrationReport,
  type DeanonymizedHumanScore,
  type PanelHumanCalibrationReport,
} from "./human-calibration-anchor.js";

export class MetaValidityHarnessError extends Error {
  constructor(detail: string) {
    super(`meta-validity-harness refused: ${detail}`);
    this.name = "MetaValidityHarnessError";
  }
}

/** The three §9 meta-validity checks. */
export type MetaValidityCheckName = "sensitivity" | "robustness" | "calibration";

// Fixed deterministic timestamps for the metric-suite run — the meta-validity
// harness re-runs the pure metric suite many times over synthetic contestants;
// the timestamps are cosmetic (they do not affect any score) so they are pinned
// to keep every run byte-reproducible. NOT a cost.
const META_VALIDITY_METRIC_STARTED_AT = "1970-01-01T00:00:00.000Z";
const META_VALIDITY_METRIC_COMPLETED_AT = "1970-01-01T00:00:00.000Z";

// ---------------------------------------------------------------------------
// The ranking primitive — the shared verdict every §9 check reasons about.
// ---------------------------------------------------------------------------

/** One contestant's aggregate standing, combining the §4 judge + §3 metric signals. */
export type ContestantRankEntry = {
  contestantId: string;
  /** Mean §4 judge score (0–4) across every retained (unit, dimension, judge). */
  judgeMean: number | null;
  /** Mean §3 deterministic metric score (0–1, higher-is-better) across metrics. */
  metricMean: number | null;
  /** Combined 0–1 standing: the mean of the available normalized signals. */
  aggregateScore: number;
  /** 0 = best. Ties broken by contestant id (stable, deterministic). */
  rank: number;
};

/** A full ranking of the contestants, best → worst. */
export type ContestantRanking = {
  entries: ContestantRankEntry[];
  /** Contestant ids best → worst — the compact "verdict" the swap tests compare. */
  order: string[];
};

/**
 * Rank contestants by combining the REAL §4 judge scores and §3 metric scores.
 * The judge mean (0–4) is normalized to 0–1 and averaged with the metric mean
 * (already 0–1) — each contestant's aggregate is the mean of whichever signals it
 * has. Higher is better; ranks are 0-based with a deterministic id tie-break.
 *
 * This is a pure function of already-computed scores: the judge/metric scoring
 * (the parts that can be biased) happens UPSTREAM in the real subsystems, so the
 * ranking is a faithful read-out of them, never a re-scoring.
 */
export function rankContestants(input: {
  judgeScores: readonly ContestantDimensionScore[];
  metricScores: readonly MetricScore[];
  contestantIds: readonly string[];
}): ContestantRanking {
  if (input.contestantIds.length === 0) {
    throw new MetaValidityHarnessError("no contestants to rank");
  }
  const judgeSum = new Map<string, { sum: number; n: number }>();
  for (const row of input.judgeScores) {
    const cur = judgeSum.get(row.contestantId) ?? { sum: 0, n: 0 };
    cur.sum += row.score;
    cur.n += 1;
    judgeSum.set(row.contestantId, cur);
  }
  const metricSum = new Map<string, { sum: number; n: number }>();
  for (const row of input.metricScores) {
    const cur = metricSum.get(row.systemId) ?? { sum: 0, n: 0 };
    cur.sum += row.score;
    cur.n += 1;
    metricSum.set(row.systemId, cur);
  }

  const entries: ContestantRankEntry[] = input.contestantIds.map((contestantId) => {
    const judge = judgeSum.get(contestantId);
    const metric = metricSum.get(contestantId);
    const judgeMean = judge !== undefined && judge.n > 0 ? judge.sum / judge.n : null;
    const metricMean = metric !== undefined && metric.n > 0 ? metric.sum / metric.n : null;
    const signals: number[] = [];
    if (judgeMean !== null) {
      signals.push(judgeMean / 4);
    }
    if (metricMean !== null) {
      signals.push(metricMean);
    }
    if (signals.length === 0) {
      throw new MetaValidityHarnessError(
        `contestant '${contestantId}' has neither a judge nor a metric signal to rank on`,
      );
    }
    const aggregateScore = signals.reduce((a, b) => a + b, 0) / signals.length;
    return {
      contestantId,
      judgeMean: judgeMean === null ? null : round(judgeMean),
      metricMean: metricMean === null ? null : round(metricMean),
      aggregateScore: round(aggregateScore),
      rank: 0,
    };
  });

  entries.sort((a, b) =>
    b.aggregateScore !== a.aggregateScore
      ? b.aggregateScore - a.aggregateScore
      : a.contestantId < b.contestantId
        ? -1
        : a.contestantId > b.contestantId
          ? 1
          : 0,
  );
  entries.forEach((entry, index) => {
    entry.rank = index;
  });
  return { entries, order: entries.map((e) => e.contestantId) };
}

// ---------------------------------------------------------------------------
// The scenario → ranking engine (drives the REAL panel + metric suite).
// ---------------------------------------------------------------------------

/** One benchmark source unit + its decoded ground truth (metric/judge inputs). */
export type MetaValidityCorpusUnit = {
  unitId: string;
  label: string;
  /** Decoded source text (ground truth, JP). */
  sourceText: string;
  /** Decoded engine text-box metrics (enables the §3 wrap-compliance metric). */
  boxMetrics?: BoxMetrics;
  /** Protected spans excluded from §3 residue scanning. */
  protectedSpans?: string[];
};

/** One contestant's rendered target for a corpus unit. */
export type MetaValidityContestantOutput = { unitId: string; targetText: string };

/** One contestant (real, de-anonymized id) + its per-unit rendered outputs. */
export type MetaValidityContestant = {
  contestantId: string;
  outputs: MetaValidityContestantOutput[];
};

/**
 * A complete meta-validity scenario: the corpus, the contestants' outputs, and
 * the decoded structure/refs + glossary the real §3/§4 subsystems consume. The
 * §9 checks build rankings from this by running the ACTUAL panel + metric suite.
 */
export type MetaValidityScenario = {
  corpus: MetaValidityCorpusUnit[];
  contestants: MetaValidityContestant[];
  /** The deterministic decoded structure feeding the §5 judge context. */
  structure: NarrativeStructure;
  /** Per-unit locators binding corpus units to decoded messages. */
  unitRefs: DecodedContextUnitRef[];
  /** §3 corpus glossary (canon term → target form). */
  glossary: CanonTerm[];
  /** §3 corpus canon-name list. */
  canonNames: CanonTerm[];
  /** Optional §3 threshold overrides (recorded for reproducibility). */
  metricConfig?: Partial<DeterministicMetricConfig>;
};

export type RankingRunInput = {
  scenario: MetaValidityScenario;
  judges: BlindJudgeAdapter[];
  panelSeed: string;
  rubric?: BenchmarkQualityRubric;
  minModelFamilies?: number;
};

export type RankingRun = {
  ranking: ContestantRanking;
  panel: BlindJudgePanelResult;
  metric: DeterministicMetricSuiteResult;
};

/**
 * Compute a contestant ranking by running the REAL subsystems: build the §5
 * decoded-context feed + anonymized candidates from the scenario, score them
 * through the §4 blind judge panel, score the same outputs through the §3
 * deterministic metric suite, then combine via {@link rankContestants}. Every
 * signal the ranking reads is produced by the genuine scoring path — this is
 * what makes the §9 sabotage test non-tautological.
 */
export async function computeContestantRanking(input: RankingRunInput): Promise<RankingRun> {
  const { scenario } = input;
  if (scenario.corpus.length === 0) {
    throw new MetaValidityHarnessError("scenario has no corpus units");
  }
  if (scenario.contestants.length === 0) {
    throw new MetaValidityHarnessError("scenario has no contestants");
  }

  const corpusById = new Map<string, MetaValidityCorpusUnit>();
  for (const unit of scenario.corpus) {
    if (corpusById.has(unit.unitId)) {
      throw new MetaValidityHarnessError(`duplicate corpus unit '${unit.unitId}'`);
    }
    corpusById.set(unit.unitId, unit);
  }

  const contestantIds: string[] = [];
  const candidates: ContestantCandidate[] = [];
  const systems: MetricSystemInput[] = [];
  const seenContestants = new Set<string>();
  for (const contestant of scenario.contestants) {
    if (seenContestants.has(contestant.contestantId)) {
      throw new MetaValidityHarnessError(`duplicate contestant '${contestant.contestantId}'`);
    }
    seenContestants.add(contestant.contestantId);
    contestantIds.push(contestant.contestantId);

    const outputByUnit = new Map<string, string>();
    for (const output of contestant.outputs) {
      if (!corpusById.has(output.unitId)) {
        throw new MetaValidityHarnessError(
          `contestant '${contestant.contestantId}' references unknown unit '${output.unitId}'`,
        );
      }
      if (outputByUnit.has(output.unitId)) {
        throw new MetaValidityHarnessError(
          `contestant '${contestant.contestantId}' has duplicate output for unit '${output.unitId}'`,
        );
      }
      outputByUnit.set(output.unitId, output.targetText);
    }

    const units: MetricUnit[] = [];
    for (const unit of scenario.corpus) {
      const targetText = outputByUnit.get(unit.unitId);
      if (targetText === undefined) {
        throw new MetaValidityHarnessError(
          `contestant '${contestant.contestantId}' is missing output for unit '${unit.unitId}'`,
        );
      }
      candidates.push({
        contestantId: contestant.contestantId,
        unitId: unit.unitId,
        candidateText: targetText,
      });
      const metricUnit: MetricUnit = {
        unitId: unit.unitId,
        label: unit.label,
        sourceText: unit.sourceText,
        targetText,
      };
      if (unit.boxMetrics !== undefined) {
        metricUnit.boxMetrics = unit.boxMetrics;
      }
      if (unit.protectedSpans !== undefined) {
        metricUnit.protectedSpans = unit.protectedSpans;
      }
      units.push(metricUnit);
    }
    // systemId == contestantId: the metric-suite `systemId` and the judge-panel
    // `contestantId` are the SAME real identity here, so the two signals join
    // honestly. (Blinding/anonymization is the contestant-harness's job on the
    // live path; a meta-validity assertion is necessarily about de-anonymized
    // identities — you can only claim "sabotaged ranks below fan-MTL" if you
    // know which is which.)
    systems.push({ systemId: contestant.contestantId, systemKind: "deterministic_fixture", units });
  }

  const feed = buildDecodedContextFeed({
    structure: scenario.structure,
    unitRefs: scenario.unitRefs,
    candidates,
  });
  const panel = await runBlindJudgePanel({
    feed,
    judges: input.judges,
    panelSeed: input.panelSeed,
    ...(input.rubric !== undefined ? { rubric: input.rubric } : {}),
    ...(input.minModelFamilies !== undefined ? { minModelFamilies: input.minModelFamilies } : {}),
  });
  const metric = runDeterministicMetricSuite({
    systems,
    glossary: scenario.glossary,
    canonNames: scenario.canonNames,
    ...(scenario.metricConfig !== undefined ? { config: scenario.metricConfig } : {}),
    startedAt: META_VALIDITY_METRIC_STARTED_AT,
    completedAt: META_VALIDITY_METRIC_COMPLETED_AT,
  });
  const ranking = rankContestants({
    judgeScores: panel.contestantDimensionScores,
    metricScores: metric.scores,
    contestantIds,
  });
  return { ranking, panel, metric };
}

// ---------------------------------------------------------------------------
// The sabotage injector (§9.1 — seeded defects the sensitivity test degrades with).
// ---------------------------------------------------------------------------

/**
 * The seeded-defect kinds the sabotage injector can apply, drawn from the
 * localization taxonomy's `seededDefectKinds` (docs/localization-quality-
 * taxonomy.json). Each degrades the translation in a way the REAL scoring
 * detects: `untranslated_residue` / `omission` / `layout_overflow` trip the §3
 * deterministic metrics, while all of them worsen the §4 judge's read of the text.
 */
export const SABOTAGE_DEFECT_KINDS = [
  "meaning_shift",
  "omission",
  "voice_drift",
  "layout_overflow",
  "untranslated_residue",
  "placeholder_dropped",
] as const;
export type SabotageDefectKind = (typeof SABOTAGE_DEFECT_KINDS)[number];

/**
 * A stable marker a `voice_drift` / `meaning_shift` sabotage stamps into the
 * text. Exported so a judge/test can recognize the degradation deterministically
 * — a real ZDR judge would instead read the broken register/proposition directly.
 */
export const SABOTAGE_REGISTER_MARKER = "[[FORMAL-DIRECTIVE]]";
export const SABOTAGE_MEANING_MARKER = "[[NEGATED]]";

/** Injected source-script residue for `untranslated_residue` (trips the §3 metric). */
const DEFAULT_RESIDUE_MARKER = "（未翻訳）";

export type SabotageConfig = {
  /** Which seeded defects to inject. At least one is required. */
  kinds: SabotageDefectKind[];
  /** The source-script residue string for `untranslated_residue`. */
  residueMarker?: string;
};

/**
 * Deterministically degrade one translated line by injecting the configured
 * seeded defects. Pure and order-stable so a sabotaged run is reproducible.
 * The output is genuinely worse text — it is re-scored by the real panel +
 * metric suite, so the sensitivity test's "ranks below fan-MTL" is EARNED.
 */
export function sabotageTranslation(text: string, config: SabotageConfig): string {
  if (config.kinds.length === 0) {
    throw new MetaValidityHarnessError("sabotage requires at least one defect kind");
  }
  const residueMarker = config.residueMarker ?? DEFAULT_RESIDUE_MARKER;
  const kinds = new Set(config.kinds);
  let out = text;

  if (kinds.has("placeholder_dropped")) {
    // Strip protected placeholder spans (`[[…]]`, `{…}`, `%s`/`%d`) — a critical
    // protected-content defect.
    out = out
      .replace(/\[\[[^\]]*\]\]/g, "")
      .replace(/\{[^}]*\}/g, "")
      .replace(/%[sd]/g, "");
  }
  if (kinds.has("omission")) {
    // Drop the tail of the line — remove required source content.
    const words = out.split(/\s+/).filter((w) => w.length > 0);
    const keep = Math.max(1, Math.ceil(words.length * 0.4));
    out = words.slice(0, keep).join(" ");
  }
  if (kinds.has("meaning_shift")) {
    // Invert the proposition — a target that no longer means the source.
    out = `${SABOTAGE_MEANING_MARKER} On the contrary, ${out}`;
  }
  if (kinds.has("voice_drift")) {
    // Force a stiff, out-of-character formal register.
    out = `${SABOTAGE_REGISTER_MARKER} I hereby formally state: ${out}`;
  }
  if (kinds.has("untranslated_residue")) {
    // Leave residual untranslated source script (trips the §3 residue metric).
    out = `${out} ${residueMarker}`;
  }
  if (kinds.has("layout_overflow")) {
    // Blow past any reasonable text-box bound (trips §3 wrap-compliance when the
    // unit carries box metrics).
    out = `${out} ${out} ${out} ${out} ${out}`;
  }
  return out;
}

/** Apply the sabotage to every output of one contestant in a scenario. */
export function sabotageContestant(
  scenario: MetaValidityScenario,
  contestantId: string,
  config: SabotageConfig,
): MetaValidityScenario {
  const target = scenario.contestants.find((c) => c.contestantId === contestantId);
  if (target === undefined) {
    throw new MetaValidityHarnessError(`cannot sabotage unknown contestant '${contestantId}'`);
  }
  return {
    ...scenario,
    contestants: scenario.contestants.map((contestant) =>
      contestant.contestantId === contestantId
        ? {
            contestantId,
            outputs: contestant.outputs.map((output) => ({
              unitId: output.unitId,
              targetText: sabotageTranslation(output.targetText, config),
            })),
          }
        : contestant,
    ),
  };
}

// ---------------------------------------------------------------------------
// Check 1 — SENSITIVITY (sabotage → ranks below fan-MTL).
// ---------------------------------------------------------------------------

export type SensitivityCheckInput = {
  /** The CLEAN base scenario (includes the itotori + fan-MTL contestants). */
  scenario: MetaValidityScenario;
  /** The Itotori contestant to sabotage. */
  itotoriContestantId: string;
  /** The fan-MTL contestant the sabotaged output must rank below. */
  fanMtlContestantId: string;
  /** The seeded defects to inject. */
  sabotage: SabotageConfig;
  judges: BlindJudgeAdapter[];
  panelSeed: string;
  rubric?: BenchmarkQualityRubric;
  minModelFamilies?: number;
};

export type SensitivityCheckResult = {
  check: "sensitivity";
  /**
   * true iff the SABOTAGED Itotori ranks below fan-MTL AND the CLEAN Itotori does
   * NOT — i.e. the instrument's demotion is caused by the sabotage, not a
   * standing bias against Itotori.
   */
  passed: boolean;
  sabotageKinds: SabotageDefectKind[];
  /** Rank of the sabotaged Itotori (higher index = worse). */
  sabotagedItotoriRank: number;
  /** Rank of fan-MTL in the sabotaged run. */
  fanMtlRank: number;
  sabotagedItotoriRanksBelowFanMtl: boolean;
  /** Rank of the CLEAN Itotori (control). */
  controlItotoriRank: number;
  controlFanMtlRank: number;
  /** The control MUST be false — clean Itotori should not already lose to fan-MTL. */
  controlItotoriRanksBelowFanMtl: boolean;
  baseOrder: string[];
  sabotagedOrder: string[];
};

/**
 * §9.1 sensitivity: sabotage the Itotori contestant, re-score through the REAL
 * panel + metric suite, and assert the degraded Itotori ranks BELOW fan-MTL while
 * the clean Itotori does not. A benchmark that cannot show a degraded Itotori
 * losing where it deserves to is broken.
 */
export async function runSensitivityCheck(
  input: SensitivityCheckInput,
): Promise<SensitivityCheckResult> {
  assertContestantPresent(input.scenario, input.itotoriContestantId, "itotori");
  assertContestantPresent(input.scenario, input.fanMtlContestantId, "fan-MTL");
  if (input.itotoriContestantId === input.fanMtlContestantId) {
    throw new MetaValidityHarnessError("itotori and fan-MTL contestants must differ");
  }

  const base = await computeContestantRanking({
    scenario: input.scenario,
    judges: input.judges,
    panelSeed: input.panelSeed,
    ...passThrough(input),
  });
  const sabotagedScenario = sabotageContestant(
    input.scenario,
    input.itotoriContestantId,
    input.sabotage,
  );
  const sabotaged = await computeContestantRanking({
    scenario: sabotagedScenario,
    judges: input.judges,
    panelSeed: input.panelSeed,
    ...passThrough(input),
  });

  const controlItotoriRank = rankOf(base.ranking, input.itotoriContestantId);
  const controlFanMtlRank = rankOf(base.ranking, input.fanMtlContestantId);
  const sabotagedItotoriRank = rankOf(sabotaged.ranking, input.itotoriContestantId);
  const fanMtlRank = rankOf(sabotaged.ranking, input.fanMtlContestantId);

  const controlItotoriRanksBelowFanMtl = controlItotoriRank > controlFanMtlRank;
  const sabotagedItotoriRanksBelowFanMtl = sabotagedItotoriRank > fanMtlRank;
  const passed = sabotagedItotoriRanksBelowFanMtl && !controlItotoriRanksBelowFanMtl;

  return {
    check: "sensitivity",
    passed,
    sabotageKinds: [...input.sabotage.kinds],
    sabotagedItotoriRank,
    fanMtlRank,
    sabotagedItotoriRanksBelowFanMtl,
    controlItotoriRank,
    controlFanMtlRank,
    controlItotoriRanksBelowFanMtl,
    baseOrder: base.ranking.order,
    sabotagedOrder: sabotaged.ranking.order,
  };
}

// ---------------------------------------------------------------------------
// Check 2 — ROBUSTNESS (judge-swap + order-swap → stable verdict).
// ---------------------------------------------------------------------------

/** A benign swap of the panel/order the verdict must survive. */
export type RobustnessSwap = {
  swapId: string;
  /** `judge` = a different judge subset/composition; `order` = a different seed. */
  swapKind: "judge" | "order";
  judges: BlindJudgeAdapter[];
  panelSeed: string;
};

export type RobustnessSwapResult = {
  swapId: string;
  swapKind: "judge" | "order";
  order: string[];
  /** Fraction of contestant pairs whose relative order flipped vs the baseline. */
  discordantPairFraction: number;
};

export type RobustnessCheckInput = {
  scenario: MetaValidityScenario;
  baseline: { judges: BlindJudgeAdapter[]; panelSeed: string };
  /** At least one judge-swap and one order-swap should be supplied. */
  swaps: RobustnessSwap[];
  /** Max tolerated instability (discordant-pair fraction). */
  maxInstability: number;
  rubric?: BenchmarkQualityRubric;
  minModelFamilies?: number;
};

export type RobustnessCheckResult = {
  check: "robustness";
  /** true iff every swap's instability is within tolerance. */
  passed: boolean;
  baselineOrder: string[];
  swaps: RobustnessSwapResult[];
  /** The worst instability observed across all swaps. */
  maxInstability: number;
  tolerance: number;
};

/**
 * §9.2 robustness: re-rank under each benign swap (judge-subset / order-seed) and
 * measure how far the verdict moved from the baseline. A ranking that flips under
 * a benign swap is not trustworthy; instability past `maxInstability` fails.
 */
export async function runRobustnessCheck(
  input: RobustnessCheckInput,
): Promise<RobustnessCheckResult> {
  if (input.swaps.length === 0) {
    throw new MetaValidityHarnessError("robustness needs at least one swap to test stability");
  }
  const passThroughOpts = passThrough(input);
  const baseline = await computeContestantRanking({
    scenario: input.scenario,
    judges: input.baseline.judges,
    panelSeed: input.baseline.panelSeed,
    ...passThroughOpts,
  });
  const baselineOrder = baseline.ranking.order;

  const swaps: RobustnessSwapResult[] = [];
  for (const swap of input.swaps) {
    const run = await computeContestantRanking({
      scenario: input.scenario,
      judges: swap.judges,
      panelSeed: swap.panelSeed,
      ...passThroughOpts,
    });
    swaps.push({
      swapId: swap.swapId,
      swapKind: swap.swapKind,
      order: run.ranking.order,
      discordantPairFraction: discordantPairFraction(baselineOrder, run.ranking.order),
    });
  }

  const maxInstability =
    swaps.length === 0 ? 0 : Math.max(...swaps.map((s) => s.discordantPairFraction));
  return {
    check: "robustness",
    passed: maxInstability <= input.maxInstability,
    baselineOrder,
    swaps,
    maxInstability: round(maxInstability),
    tolerance: input.maxInstability,
  };
}

// ---------------------------------------------------------------------------
// Check 3 — CALIBRATION (panel ranking correlates with human anchor).
// ---------------------------------------------------------------------------

export type CalibrationCheckInput = {
  /** The §4 panel scores (from a baseline ranking run). */
  panelScores: readonly ContestantDimensionScore[];
  /** The §8 de-anonymized human anchor scores. */
  humanScores: readonly DeanonymizedHumanScore[];
  /** Minimum acceptable Pearson correlation for "calibrated". */
  minPearson: number;
};

export type CalibrationCheckResult = {
  check: "calibration";
  /** true iff the overall panel-vs-human Pearson meets the floor. */
  passed: boolean;
  /** Overall panel↔human correlation (null → cannot establish calibration → fail). */
  pearson: number | null;
  minPearson: number;
  report: PanelHumanCalibrationReport;
};

/**
 * §9.3 calibration: build the §8 panel↔human calibration report and check the
 * overall Pearson correlation against the floor. A null correlation (no variance
 * / too few items) cannot establish calibration and therefore FAILS.
 */
export function runCalibrationCheck(input: CalibrationCheckInput): CalibrationCheckResult {
  const report = buildPanelHumanCalibrationReport({
    panelScores: input.panelScores,
    humanScores: input.humanScores,
  });
  const pearson = report.overall.pearson;
  const passed = pearson !== null && pearson >= input.minPearson;
  return { check: "calibration", passed, pearson, minPearson: input.minPearson, report };
}

// ---------------------------------------------------------------------------
// The run-gating orchestrator + report.
// ---------------------------------------------------------------------------

/**
 * §9 / §12 meta-validity thresholds. The EXACT numeric floors are a §12 open
 * decision (Trevor's call); these are reasoned "start strict, relax only with
 * evidence" defaults, RECORDED on every report so a run is reproducible and the
 * floors are auditable.
 */
export type MetaValidityThresholds = {
  /** §9.2 max tolerated ranking instability under a benign swap (0 = must not move). */
  robustnessMaxInstability: number;
  /** §9.3 min panel↔human Pearson correlation for "calibrated". */
  calibrationMinPearson: number;
};

export const DEFAULT_META_VALIDITY_THRESHOLDS: MetaValidityThresholds = {
  // §12 FLAG (reasoned default): the deterministic panel should not reorder the
  // key contestants under a benign judge/order swap at all — start strict at
  // "no more than a tenth of contestant pairs may flip", relax only with evidence.
  robustnessMaxInstability: 0.1,
  // §12 FLAG (reasoned default): require a strong positive panel↔human
  // correlation; 0.6 is a conventional "strong" floor, tightened as the human
  // anchor grows.
  calibrationMinPearson: 0.6,
};

/** Provenance note stamped on the report so the §12-flagged defaults are explicit. */
export const META_VALIDITY_THRESHOLD_PROVENANCE = {
  section12OpenDecision: true,
  rationale: "reasoned start-strict defaults; exact §9 floors are Trevor's per §12.5",
  methodologyRef: "docs/itotori-translation-benchmark-methodology.md#12-open-decisions",
} as const;

export type MetaValidityHarnessInput = {
  sensitivity: Omit<SensitivityCheckInput, "rubric" | "minModelFamilies"> & {
    rubric?: BenchmarkQualityRubric;
    minModelFamilies?: number;
  };
  robustness: Omit<RobustnessCheckInput, "maxInstability">;
  calibration: Omit<CalibrationCheckInput, "minPearson">;
  thresholds?: Partial<MetaValidityThresholds>;
};

/**
 * The run-gating §9 report. `valid` is true iff ALL THREE checks passed; a run
 * that fails any check is INVALID and its verdicts must not be used. `failedChecks`
 * names the culprits and `thresholds` records the floors the run was judged by.
 */
export type MetaValidityReport = {
  valid: boolean;
  failedChecks: MetaValidityCheckName[];
  thresholds: MetaValidityThresholds;
  thresholdProvenance: typeof META_VALIDITY_THRESHOLD_PROVENANCE;
  sensitivity: SensitivityCheckResult;
  robustness: RobustnessCheckResult;
  calibration: CalibrationCheckResult;
};

/**
 * Run all three §9 meta-validity checks and assemble the run-gating report. The
 * benchmark earns the right to make claims only when `valid` is true; otherwise
 * `failedChecks` names which guardrail tripped and the run is not to be trusted.
 */
export async function runMetaValidityHarness(
  input: MetaValidityHarnessInput,
): Promise<MetaValidityReport> {
  const thresholds: MetaValidityThresholds = {
    ...DEFAULT_META_VALIDITY_THRESHOLDS,
    ...input.thresholds,
  };

  const sensitivity = await runSensitivityCheck(input.sensitivity);
  const robustness = await runRobustnessCheck({
    ...input.robustness,
    maxInstability: thresholds.robustnessMaxInstability,
  });
  const calibration = runCalibrationCheck({
    ...input.calibration,
    minPearson: thresholds.calibrationMinPearson,
  });

  const failedChecks: MetaValidityCheckName[] = [];
  if (!sensitivity.passed) {
    failedChecks.push("sensitivity");
  }
  if (!robustness.passed) {
    failedChecks.push("robustness");
  }
  if (!calibration.passed) {
    failedChecks.push("calibration");
  }

  return {
    valid: failedChecks.length === 0,
    failedChecks,
    thresholds,
    thresholdProvenance: META_VALIDITY_THRESHOLD_PROVENANCE,
    sensitivity,
    robustness,
    calibration,
  };
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function assertContestantPresent(
  scenario: MetaValidityScenario,
  contestantId: string,
  role: string,
): void {
  if (!scenario.contestants.some((c) => c.contestantId === contestantId)) {
    throw new MetaValidityHarnessError(
      `${role} contestant '${contestantId}' is not in the scenario`,
    );
  }
}

function passThrough(input: { rubric?: BenchmarkQualityRubric; minModelFamilies?: number }): {
  rubric?: BenchmarkQualityRubric;
  minModelFamilies?: number;
} {
  return {
    ...(input.rubric !== undefined ? { rubric: input.rubric } : {}),
    ...(input.minModelFamilies !== undefined ? { minModelFamilies: input.minModelFamilies } : {}),
  };
}

function rankOf(ranking: ContestantRanking, contestantId: string): number {
  const entry = ranking.entries.find((e) => e.contestantId === contestantId);
  if (entry === undefined) {
    throw new MetaValidityHarnessError(`contestant '${contestantId}' is not in the ranking`);
  }
  return entry.rank;
}

/**
 * Fraction of contestant PAIRS whose relative order disagrees between two
 * orderings (a normalized Kendall-tau distance). 0 = identical order, 1 = fully
 * reversed. Only pairs present in BOTH orderings are counted.
 */
function discordantPairFraction(a: readonly string[], b: readonly string[]): number {
  const rankA = indexMap(a);
  const rankB = indexMap(b);
  const shared = a.filter((id) => rankB.has(id));
  let pairs = 0;
  let discordant = 0;
  for (let i = 0; i < shared.length; i += 1) {
    for (let j = i + 1; j < shared.length; j += 1) {
      const x = shared[i]!;
      const y = shared[j]!;
      pairs += 1;
      const aOrder = rankA.get(x)! - rankA.get(y)!;
      const bOrder = rankB.get(x)! - rankB.get(y)!;
      if (Math.sign(aOrder) !== Math.sign(bOrder)) {
        discordant += 1;
      }
    }
  }
  return pairs === 0 ? 0 : discordant / pairs;
}

function indexMap(order: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  order.forEach((id, index) => map.set(id, index));
  return map;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
