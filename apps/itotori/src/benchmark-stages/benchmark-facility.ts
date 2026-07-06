// benchmark-facility — the scoring-aggregation JOIN + the end-to-end driver.
//
// Methodology §4.2 + §6.1 (docs/itotori-translation-benchmark-methodology.md).
// The benchmark facility fans a source corpus out into FIVE blind contestants
// (contestant-harness §6), scores them along two INDEPENDENT streams that live in
// DIFFERENT id spaces by construction of the blinding —
//
//   - the §4 blind judge panel scores PER-UNIT anonymized candidate handles
//     (`ContestantCandidate.contestantId` — a per-(unit, kind) opaque handle, so a
//     judge cannot correlate "handle X wins everywhere" across units, §4.2);
//   - the §3 deterministic metric suite scores PER-SYSTEM handles
//     (`MetricSystemInput.systemId` — one opaque handle per contestant kind).
//
// Downstream, §10 `buildActionableBacklog` groups judge scores by `contestantId`
// and metric scores by `systemId` and needs ONE `systemUnderTestId` that matches
// BOTH tables; §9 `rankContestants` / `computeContestantRanking` likewise need a
// single consistent per-system identity. The two blind id spaces never intersect,
// so on REAL harness output the judge ladder for the system under test is empty —
// the facility does not compose until the streams are RECONCILED.
//
// §4.2 / §6.1 say the join happens at SCORING AGGREGATION — AFTER scoring, using
// the PRIVATE de-anonymization key, NOT during judging. The judge still receives a
// blind bundle (provenance-anonymized handles); only here, once every score is in,
// do we un-blind BOTH streams' opaque handles back to the real `contestantKind`
// via `deanonymizeCandidate` / `deanonymizeSystem`. That is the legitimate
// un-blinding the methodology permits, and it is the sole thing that makes the
// backlog + ranking + meta-validity operate on a consistent identity.
//
// This module owns nothing itself: it is pure plumbing over the real stages.

import type {
  BenchmarkFindingRecordV02,
  BenchmarkQualityRubric,
} from "@itotori/localization-bridge-schema";
import {
  buildActionableBacklog,
  type ActionableBacklogInput,
  type BacklogSignalScore,
  type BacklogUnitScope,
  type BenchmarkImprovementBacklog,
} from "./actionable-backlog.js";
import {
  blindJudgeFindingId,
  runBlindJudgePanel,
  type BlindJudgeAdapter,
  type BlindJudgePanelResult,
  type ContestantDimensionScore,
} from "./blind-judge-panel.js";
import {
  CONTESTANT_KINDS,
  deanonymizeCandidate,
  deanonymizeSystem,
  runContestantHarness,
  type ContestantDeanonymizationKey,
  type ContestantHarnessInput,
  type ContestantHarnessResult,
  type ContestantKind,
} from "./contestant-harness.js";
import { computeCostLatencyDimensions, type CostLatencyDimensions } from "./cost-latency-dims.js";
import {
  buildDecodedContextFeed,
  type DecodedContextUnitRef,
  type JudgeUnitInput,
} from "./decoded-context-feed.js";
import {
  runDeterministicMetricSuite,
  type CanonTerm,
  type DeterministicMetricConfig,
  type DeterministicMetricSuiteResult,
  type MetricScore,
} from "./deterministic-metrics/index.js";
import { populateBackTranslations, type BackTranslator } from "./back-translate-live.js";
import type { ProviderRunRecord } from "../providers/index.js";
import type { DeanonymizedHumanScore } from "./human-calibration-anchor.js";
import {
  rankContestants,
  runMetaValidityHarness,
  type ContestantRanking,
  type MetaValidityContestant,
  type MetaValidityContestantOutput,
  type MetaValidityCorpusUnit,
  type MetaValidityReport,
  type MetaValidityScenario,
  type MetaValidityThresholds,
  type RobustnessSwap,
  type SabotageConfig,
} from "./meta-validity-harness.js";
import type { NarrativeStructure } from "../agents/structure-informed-context/index.js";

export class BenchmarkFacilityError extends Error {
  constructor(detail: string) {
    super(`benchmark-facility refused: ${detail}`);
    this.name = "BenchmarkFacilityError";
  }
}

// ---------------------------------------------------------------------------
// The scoring-aggregation adapter (§4.2 / §6.1 — the join AFTER scoring).
// ---------------------------------------------------------------------------

export type ScoringAggregationInput = {
  /** The PRIVATE de-anonymization key from `runContestantHarness` (the only join path). */
  deanonymizationKey: ContestantDeanonymizationKey;
  /** §4 judge scores keyed by the PER-UNIT candidate handle (`contestantId`). */
  judgeScores: readonly ContestantDimensionScore[];
  /** §4 `llm_qa` findings — `systemId` + `findingId` keyed on the per-unit handle. */
  judgeFindings: readonly BenchmarkFindingRecordV02[];
  /** §3 metric scores keyed by the PER-SYSTEM handle (`systemId`). */
  metricScores: readonly MetricScore[];
  /** §3 `deterministic_qa` findings keyed by the per-system handle (`systemId`). */
  metricFindings: readonly BenchmarkFindingRecordV02[];
};

/**
 * Both scored streams reconciled to the real `contestantKind`. Judge scores +
 * findings and metric scores + findings now share ONE identity, so §10 backlog
 * and §9 ranking can select a single `systemUnderTestId`.
 */
export type AggregatedScoring = {
  /** Judge scores with `contestantId` un-blinded to the real `contestantKind`. */
  judgeScores: ContestantDimensionScore[];
  /** Judge findings re-keyed: `systemId` + `findingId` on the real kind. */
  judgeFindings: BenchmarkFindingRecordV02[];
  /** Metric scores with `systemId` un-blinded to the real `contestantKind`. */
  metricScores: MetricScore[];
  /** Metric findings with `systemId` un-blinded to the real `contestantKind`. */
  metricFindings: BenchmarkFindingRecordV02[];
  /** Every real contestant kind present in the key (the ranking population). */
  contestantKinds: ContestantKind[];
};

/**
 * The scoring-aggregation JOIN. Un-blinds BOTH scored streams back to the real
 * `contestantKind` via the private de-anonymization key (§4.2 / §6.1):
 *
 *   - judge scores: `contestantId` (per-unit candidate handle) →
 *     `deanonymizeCandidate(key, …).contestantKind`;
 *   - judge findings: `systemId` → the kind, and `findingId` re-derived through
 *     the exported {@link blindJudgeFindingId} so it matches what §10 re-derives
 *     from the un-blinded score (the id scheme is single-sourced, never re-hashed
 *     by hand here);
 *   - metric scores + findings: `systemId` (per-system handle) →
 *     `deanonymizeSystem(key, …)`.
 *
 * This is the ONLY place the two blind id spaces are reconciled. It happens
 * strictly AFTER scoring — the judge never saw a real identity — so the blinding
 * the panel enforced stays intact; this is the legitimate un-blinding at
 * aggregation the methodology mandates.
 */
export function aggregateScoring(input: ScoringAggregationInput): AggregatedScoring {
  const key = input.deanonymizationKey;

  // Build the judge finding-id remap from the SCORES (they carry judgeId +
  // dimensionId, which a finding record does not expose): every emitted judge
  // finding corresponds to a retained sub-4 cited score, so this covers them all.
  const judgeFindingIdRemap = new Map<string, string>();
  for (const row of input.judgeScores) {
    const kind = deanonymizeCandidate(key, row.contestantId).contestantKind;
    const oldId = blindJudgeFindingId(row.judgeId, row.contestantId, row.unitId, row.dimensionId);
    const newId = blindJudgeFindingId(row.judgeId, kind, row.unitId, row.dimensionId);
    judgeFindingIdRemap.set(oldId, newId);
  }

  const judgeScores: ContestantDimensionScore[] = input.judgeScores.map((row) => ({
    ...row,
    contestantId: deanonymizeCandidate(key, row.contestantId).contestantKind,
  }));

  const judgeFindings: BenchmarkFindingRecordV02[] = input.judgeFindings.map((finding) => {
    const newId = judgeFindingIdRemap.get(finding.findingId);
    if (newId === undefined) {
      throw new BenchmarkFacilityError(
        `judge finding '${finding.findingId}' has no corresponding retained score to un-blind through`,
      );
    }
    return {
      ...finding,
      findingId: newId,
      systemId: deanonymizeCandidate(key, finding.systemId).contestantKind,
    };
  });

  const metricScores: MetricScore[] = input.metricScores.map((row) => ({
    ...row,
    systemId: deanonymizeSystem(key, row.systemId),
  }));

  const metricFindings: BenchmarkFindingRecordV02[] = input.metricFindings.map((finding) => ({
    ...finding,
    systemId: deanonymizeSystem(key, finding.systemId),
  }));

  const contestantKinds = key.systems.map((system) => system.contestantKind);

  return { judgeScores, judgeFindings, metricScores, metricFindings, contestantKinds };
}

// ---------------------------------------------------------------------------
// Reconstruct the DE-ANONYMIZED meta-validity scenario from a harness run.
// ---------------------------------------------------------------------------

/**
 * Rebuild the §9 de-anonymized `MetaValidityScenario` from a harness result: the
 * meta-validity harness (sabotage / robustness / calibration) reasons about REAL
 * contestant identities, so its scenario is the un-blinded view of the SAME
 * corpus + rendered outputs the blind bundle carried. Contestant ids are the real
 * `contestantKind`s, recovered from the private key.
 */
export function reconstructMetaValidityScenario(
  harness: ContestantHarnessResult,
  context: {
    corpus: MetaValidityCorpusUnit[];
    structure: NarrativeStructure;
    unitRefs: DecodedContextUnitRef[];
    glossary: CanonTerm[];
    canonNames: CanonTerm[];
    metricConfig?: Partial<DeterministicMetricConfig>;
  },
): MetaValidityScenario {
  const textByHandle = new Map(
    harness.anonymizedBundle.candidates.map((candidate) => [
      candidate.contestantId,
      candidate.candidateText,
    ]),
  );

  const outputsByKind = new Map<ContestantKind, MetaValidityContestantOutput[]>();
  for (const kind of CONTESTANT_KINDS) {
    outputsByKind.set(kind, []);
  }
  for (const row of harness.deanonymizationKey.candidates) {
    const targetText = textByHandle.get(row.candidateHandle);
    if (targetText === undefined) {
      throw new BenchmarkFacilityError(
        `candidate handle '${row.candidateHandle}' in the key has no text in the blind bundle`,
      );
    }
    outputsByKind.get(row.contestantKind)!.push({ unitId: row.unitId, targetText });
  }

  const contestants: MetaValidityContestant[] = CONTESTANT_KINDS.map((kind) => ({
    contestantId: kind,
    outputs: outputsByKind.get(kind)!,
  }));

  return {
    corpus: context.corpus,
    contestants,
    structure: context.structure,
    unitRefs: context.unitRefs,
    glossary: context.glossary,
    canonNames: context.canonNames,
    ...(context.metricConfig !== undefined ? { metricConfig: context.metricConfig } : {}),
  };
}

// ---------------------------------------------------------------------------
// The facility DRIVER — the whole composed benchmark, end to end.
// ---------------------------------------------------------------------------

/** Optional §9 meta-validity leg. Supplying it runs the full self-validation. */
export type BenchmarkFacilityMetaValidity = {
  /** The Itotori contestant kind whose sabotaged output must lose to fan-MTL. */
  itotoriKind: ContestantKind;
  /** The fan-MTL contestant kind the sabotaged Itotori must rank below. */
  fanMtlKind: ContestantKind;
  /** The seeded defects the §9.1 sensitivity check injects. */
  sabotage: SabotageConfig;
  /** §9.2 benign swaps (a judge-swap + an order-swap) the verdict must survive. */
  robustnessSwaps: RobustnessSwap[];
  /** §9.2 baseline panel/order (may equal the main panel/seed). */
  baseline: { judges: BlindJudgeAdapter[]; panelSeed: string };
  /** §9.3 de-anonymized human anchor scores (keyed by contestant KIND). */
  humanScores: DeanonymizedHumanScore[];
  /** Optional §9 threshold overrides (recorded on the report). */
  thresholds?: Partial<MetaValidityThresholds>;
};

export type BenchmarkFacilityInput = {
  /** §6 contestant collection input (corpus + runners + salt). */
  contestant: ContestantHarnessInput;
  /** The deterministic decoded structure feeding the §5 judge context. */
  structure: NarrativeStructure;
  /** Per-unit locators binding corpus units to decoded messages (§5). */
  unitRefs: DecodedContextUnitRef[];
  /** The §4 judge panel (fixture judges in tests; ZDR adapters live). */
  judges: BlindJudgeAdapter[];
  /** §4.2 order-randomization seed. */
  panelSeed: string;
  /** §3 corpus glossary (canon term → target form). */
  glossary: CanonTerm[];
  /** §3 corpus canon-name list. */
  canonNames: CanonTerm[];
  /** The contestant KIND the §10 backlog is built FOR (e.g. `itotori_context_on`). */
  systemUnderTestKind: ContestantKind;
  /** The fan-MTL comparator kind (§10.2 top-priority ladder). */
  fanMtlKind?: ContestantKind;
  /** The official/professional comparator kind (§10.2 backlog ladder). */
  professionalKind?: ContestantKind;
  /** Per-unit scene/speaker scope used to bucket failure modes (§10.1). */
  unitScopes: BacklogUnitScope[];
  /** The prior run's per-signal scores (§10.3 regression telemetry). */
  priorRun?: { perSignalScores: BacklogSignalScore[] };
  /** Optional §3 threshold overrides. */
  metricConfig?: Partial<DeterministicMetricConfig>;
  /** Cosmetic §3 metric-run timestamps (do not affect any score). */
  metricStartedAt?: string;
  metricCompletedAt?: string;
  /** Optional §2 rubric override (defaults to the frozen rubric). */
  rubric?: BenchmarkQualityRubric;
  /** §4.1 model-family floor override. */
  minModelFamilies?: number;
  /** Optional §9 meta-validity self-validation leg. */
  metaValidity?: BenchmarkFacilityMetaValidity;
  /**
   * Optional §3 back-translation TRIPWIRE producer. When supplied, the real ZDR
   * MT round-trip (a `ZdrBackTranslator` on the live path) back-translates every
   * unit's target text to the source language and populates `unit.backTranslation`
   * BEFORE the deterministic suite runs, so the gross-meaning-loss tripwire fires
   * on the live path. When absent, the metric inputs pass through unchanged (a
   * fixture may inject `backTranslation` directly on the units, or the tripwire is
   * simply skipped for units without it). Its real `usage.cost` per call surfaces
   * on {@link BenchmarkFacilityResult.backTranslationRuns}; cost is never
   * approximated.
   */
  backTranslator?: BackTranslator;
};

/** The composed benchmark result — every stage joined on a consistent identity. */
export type BenchmarkFacilityResult = {
  /** §6 raw contestant-harness result (blind bundle + private key + cost ledger). */
  harness: ContestantHarnessResult;
  /** §5 the blind judge feed (per-unit opaque candidate handles). */
  feed: JudgeUnitInput[];
  /** §4 blind judge panel result (scored on blind per-unit handles). */
  panel: BlindJudgePanelResult;
  /** §3 deterministic metric suite result (scored on blind per-system handles). */
  metric: DeterministicMetricSuiteResult;
  /** §4.2 / §6.1 the two streams reconciled to the real `contestantKind`. */
  aggregated: AggregatedScoring;
  /** §10 the ranked improvement backlog for the system under test kind. */
  backlog: BenchmarkImprovementBacklog;
  /** §9 the combined judge+metric ranking (the meta-validity ranking primitive). */
  ranking: ContestantRanking;
  /** §11.1 cost + latency dimensions (single-sourced from the harness ledger). */
  costLatency: CostLatencyDimensions;
  /** The de-anonymized §9 scenario (rebuilt from the harness for meta-validity). */
  metaValidityScenario: MetaValidityScenario;
  /** §9 the meta-validity report — present only when the meta-validity leg ran. */
  metaValidity: MetaValidityReport | null;
  /**
   * §3 the REAL provider runs from the back-translation round-trip (one per
   * back-translated unit, each carrying the authoritative `usage.cost`). Empty
   * when no back-translator was supplied. Never approximated.
   */
  backTranslationRuns: ProviderRunRecord[];
};

/**
 * Drive the whole benchmark facility end-to-end on REAL harness output:
 *
 *   runContestantHarness → buildDecodedContextFeed →
 *     (runBlindJudgePanel + runDeterministicMetricSuite) →
 *       aggregateScoring (de-anon BOTH streams to contestantKind) →
 *         buildActionableBacklog + rankContestants + computeCostLatencyDimensions
 *         (+ runMetaValidityHarness when the meta-validity leg is supplied).
 *
 * The judge + metric streams are scored BLIND in different id spaces and only
 * reconciled at aggregation, so the backlog + ranking operate on the real
 * `contestantKind` — the composition the hand-built single-id fixtures bypassed.
 */
export async function runBenchmarkFacility(
  input: BenchmarkFacilityInput,
): Promise<BenchmarkFacilityResult> {
  const harness = await runContestantHarness(input.contestant);

  const feed = buildDecodedContextFeed({
    structure: input.structure,
    unitRefs: input.unitRefs,
    candidates: harness.anonymizedBundle.candidates,
  });

  const panel = await runBlindJudgePanel({
    feed,
    judges: input.judges,
    panelSeed: input.panelSeed,
    ...(input.rubric !== undefined ? { rubric: input.rubric } : {}),
    ...(input.minModelFamilies !== undefined ? { minModelFamilies: input.minModelFamilies } : {}),
  });

  // §3 back-translation TRIPWIRE input: on the live path a `ZdrBackTranslator`
  // fills `unit.backTranslation` via a REAL ZDR MT round-trip before the
  // deterministic suite runs; absent, the inputs pass through unchanged.
  let metricInputs = harness.anonymizedBundle.metricInputs;
  let backTranslationRuns: ProviderRunRecord[] = [];
  if (input.backTranslator !== undefined) {
    const populated = await populateBackTranslations(metricInputs, input.backTranslator);
    metricInputs = populated.systems;
    backTranslationRuns = populated.runs;
  }

  const metric = runDeterministicMetricSuite({
    systems: metricInputs,
    glossary: input.glossary,
    canonNames: input.canonNames,
    ...(input.metricConfig !== undefined ? { config: input.metricConfig } : {}),
    startedAt: input.metricStartedAt ?? "1970-01-01T00:00:00.000Z",
    completedAt: input.metricCompletedAt ?? "1970-01-01T00:00:00.000Z",
  });

  // The JOIN: un-blind both scored streams to the real contestantKind (§4.2/§6.1).
  const aggregated = aggregateScoring({
    deanonymizationKey: harness.deanonymizationKey,
    judgeScores: panel.contestantDimensionScores,
    judgeFindings: panel.findings,
    metricScores: metric.scores,
    metricFindings: metric.findings,
  });

  const backlogInput: ActionableBacklogInput = {
    systemUnderTestId: input.systemUnderTestKind,
    ...(input.fanMtlKind !== undefined ? { fanMtlSystemId: input.fanMtlKind } : {}),
    ...(input.professionalKind !== undefined
      ? { professionalSystemId: input.professionalKind }
      : {}),
    judgeScores: aggregated.judgeScores,
    judgeFindings: aggregated.judgeFindings,
    metricScores: aggregated.metricScores,
    metricFindings: aggregated.metricFindings,
    unitScopes: input.unitScopes,
    ...(input.priorRun !== undefined ? { priorRun: input.priorRun } : {}),
  };
  const backlog = buildActionableBacklog(backlogInput);

  const ranking = rankContestants({
    judgeScores: aggregated.judgeScores,
    metricScores: aggregated.metricScores,
    contestantIds: aggregated.contestantKinds,
  });

  const costLatency = computeCostLatencyDimensions(harness);

  const corpus: MetaValidityCorpusUnit[] = input.contestant.corpus.map((unit) => {
    const boxMetrics = input.contestant.boxMetricsByUnit?.[unit.unitId];
    return {
      unitId: unit.unitId,
      label: unit.label,
      sourceText: unit.sourceText,
      ...(boxMetrics !== undefined ? { boxMetrics } : {}),
    };
  });
  const metaValidityScenario = reconstructMetaValidityScenario(harness, {
    corpus,
    structure: input.structure,
    unitRefs: input.unitRefs,
    glossary: input.glossary,
    canonNames: input.canonNames,
    ...(input.metricConfig !== undefined ? { metricConfig: input.metricConfig } : {}),
  });

  let metaValidity: MetaValidityReport | null = null;
  if (input.metaValidity !== undefined) {
    const mv = input.metaValidity;
    metaValidity = await runMetaValidityHarness({
      sensitivity: {
        scenario: metaValidityScenario,
        itotoriContestantId: mv.itotoriKind,
        fanMtlContestantId: mv.fanMtlKind,
        sabotage: mv.sabotage,
        judges: input.judges,
        panelSeed: input.panelSeed,
        ...(input.rubric !== undefined ? { rubric: input.rubric } : {}),
        ...(input.minModelFamilies !== undefined
          ? { minModelFamilies: input.minModelFamilies }
          : {}),
      },
      robustness: {
        scenario: metaValidityScenario,
        baseline: mv.baseline,
        swaps: mv.robustnessSwaps,
        ...(input.rubric !== undefined ? { rubric: input.rubric } : {}),
        ...(input.minModelFamilies !== undefined
          ? { minModelFamilies: input.minModelFamilies }
          : {}),
      },
      calibration: {
        panelScores: aggregated.judgeScores,
        humanScores: mv.humanScores,
      },
      ...(mv.thresholds !== undefined ? { thresholds: mv.thresholds } : {}),
    });
  }

  return {
    harness,
    feed,
    panel,
    metric,
    aggregated,
    backlog,
    ranking,
    costLatency,
    metaValidityScenario,
    metaValidity,
    backTranslationRuns,
  };
}
