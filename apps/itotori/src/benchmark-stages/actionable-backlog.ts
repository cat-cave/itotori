// benchmark-actionable-backlog-output (§10) — the diagnostic deliverable.
//
// Methodology §10 (docs/itotori-translation-benchmark-methodology.md): a
// benchmark run's PRIMARY artifact is a RANKED IMPROVEMENT BACKLOG, not a score.
// This module CONSUMES the two upstream finding streams already produced on the
// benchmark:
//
//   - §3 deterministic metric suite  (`runDeterministicMetricSuite`)   — the
//     bias-independent metric findings + comparable-across-contestant scores.
//     These findings already carry a real `rootCause` (they are adjudicated by
//     construction — a deterministic rule KNOWS its cause).
//   - §4 blind judge panel           (`runBlindJudgePanel`)            — the
//     subjective per-(unit, contestant, dimension) 0–4 scores WITH §4.3 cited
//     reasoning, and the `llm_qa` findings they compose into. Those judge
//     findings are honestly emitted with `rootCause: unknown_unadjudicated`
//     (§4 scores QUALITY; root-cause attribution is THIS node's job).
//
// It turns those into (§10.1) per-failure-mode findings — each tied to a CAUSE
// (adjudicated from the itotori-lqa-1 rootCause vocabulary) and a FIX-CANDIDATE,
// with cited evidence — ranked by the §10.2 priority ladder (trailing fan-MTL →
// top; trailing pro → backlog; beating fan-MTL / matching pro → regression
// protection), emitted as routable DAG findings/nodes (§10.3) and accompanied by
// per-dimension regression telemetry vs the prior run (§10.3).
//
// The whole run is a PURE function of its input: same input → byte-identical
// backlog. No model, provider, clock, randomness, or cost handling (cost stays
// single-source in the report ledger; this node never touches it).

import {
  BENCHMARK_QUALITY_RUBRIC,
  benchmarkRubricTaxonomyTargetForDimension,
  type BenchmarkFindingRecordV02,
  type BenchmarkRubricDimensionId,
  type LocalizationQualityCategoryV02,
  type LocalizationQualitySeverityV02,
  type LocalizationRootCauseV02,
} from "@itotori/localization-bridge-schema";
import type { ContestantDimensionScore } from "./blind-judge-panel.js";
import { blindJudgeFindingId } from "./blind-judge-panel.js";
import type { MetricScore } from "./deterministic-metrics/types.js";
import { deterministicUuid7 } from "./ids.js";

export class ActionableBacklogError extends Error {
  constructor(detail: string) {
    super(`actionable-backlog refused: ${detail}`);
    this.name = "ActionableBacklogError";
  }
}

// A tiny tolerance so floating comparisons of near-equal contestant scores do
// not spuriously flip a ladder tier.
const SCORE_EPSILON = 1e-9;

const SEVERITY_WEIGHT: Record<LocalizationQualitySeverityV02, number> = {
  critical: 25,
  major: 5,
  minor: 1,
  neutral: 0,
};

// ---------------------------------------------------------------------------
// §10.2 priority ladder.
// ---------------------------------------------------------------------------

/** §10.2 ladder rungs, in priority order (index 0 = highest priority). */
export const BACKLOG_RANK_TIERS = [
  "top_priority", // trailing even fan-MTL — a genuine blind spot.
  "improvement_backlog", // trailing pro (but beating fan-MTL) — catch-up work.
  "regression_protection", // beating fan-MTL / matching pro — lock it in.
] as const;
export type BacklogRankTier = (typeof BACKLOG_RANK_TIERS)[number];

const RANK_ORDER: Record<BacklogRankTier, number> = {
  top_priority: 0,
  improvement_backlog: 1,
  regression_protection: 2,
};

/** Which upstream stream a failure mode was decomposed from. */
export type BacklogSignalSource = "blind_judge_panel" | "deterministic_metric";

// ---------------------------------------------------------------------------
// §10.1 cause adjudication + fix-candidate maps.
// ---------------------------------------------------------------------------

// A judge finding is emitted `unknown_unadjudicated` (§4). §10 ADJUDICATES it
// into an itotori-lqa-1 rootCause from the finding's quality CATEGORY — the one
// piece of vocabulary a blind judge does assign. (Reasoned call: category, not
// rubric-dimension, is the adjudication key because a judge finding carries its
// category verbatim while `accuracy` maps to two dimensions — adequacy and
// callbacks — so a dimension key would be ambiguous. Both the item cause and the
// adjudicated finding cause use THIS map, so they never disagree. Flagged.)
const CATEGORY_TO_CAUSE: Record<LocalizationQualityCategoryV02, LocalizationRootCauseV02> = {
  accuracy: "prompt_or_context_pack_error",
  terminology: "glossary_policy_gap",
  style: "style_guide_gap",
  tone_register: "style_guide_gap",
  locale_convention: "style_guide_gap",
  protected_content: "prompt_or_context_pack_error",
  layout: "runtime_environment_or_i18n_limit",
  technical_integrity: "prompt_or_context_pack_error",
};

// A cause → the concrete fix-candidate lever §10.1 names (glossary enforcement /
// style-guide+context tuning / draft-prompt length constraint / ...).
const CAUSE_TO_FIX: Record<LocalizationRootCauseV02, string> = {
  glossary_policy_gap: "glossary enforcement (declare/enforce the canon target form)",
  style_guide_gap: "style-guide + context tuning (register/voice/locale guidance)",
  prompt_or_context_pack_error: "context-pack + draft-prompt tuning (enrich decoded context)",
  runtime_environment_or_i18n_limit: "length constraint in the draft prompt (fit the box)",
  model_draft_error: "draft-prompt tuning / stronger draft model",
  source_annotation_gap: "decode / speaker-annotation fix upstream",
  source_content_defect: "source-content correction upstream",
  human_edit_error: "reviewer-guidance tuning",
  deterministic_qa_rule_error: "deterministic-metric rule correction",
  patch_application_error: "patchback fix",
  benchmark_seed: "seeded-defect control (no product fix — sabotage anchor)",
  unknown_unadjudicated: "triage (unadjudicated)",
};

function fixCandidateFor(cause: LocalizationRootCauseV02): string {
  return CAUSE_TO_FIX[cause] ?? "triage";
}

// ---------------------------------------------------------------------------
// Metric check → rubric-dimension / long-range metadata.
// ---------------------------------------------------------------------------

type MetricMeta = { dimension: string; title: string; longRange: boolean };

// Maps each §3 metric check to the rubric dimension (or itotori-lqa-1 category
// label when §2 has no matching dimension, e.g. terminology) and whether it is
// an ACROSS-the-work (long-range) dimension — long-range failure modes bucket by
// speaker rather than scene.
const METRIC_META: Record<string, MetricMeta> = {
  "glossary-consistency": {
    dimension: "terminology",
    title: "Glossary / terminology consistency",
    longRange: false,
  },
  "named-entity-consistency": {
    dimension: "terminology",
    title: "Named-entity consistency",
    longRange: true,
  },
  "wrap-compliance": {
    dimension: "textbox_fit_wordwrap",
    title: "Text-box fit / word-wrap",
    longRange: false,
  },
  "speaker-attribution": {
    dimension: "speaker_attribution",
    title: "Speaker attribution",
    longRange: false,
  },
  "choice-branch-correctness": {
    dimension: "choice_branch_correctness",
    title: "Choice / branch correctness",
    longRange: false,
  },
  "untranslated-residue": {
    dimension: "adequacy",
    title: "Untranslated residue",
    longRange: false,
  },
  "voice-style-fingerprint": {
    dimension: "character_voice_consistency",
    title: "Character-voice style fingerprint",
    longRange: true,
  },
};

function metricMetaFor(checkName: string, fallbackCategory: string): MetricMeta {
  return (
    METRIC_META[checkName] ?? { dimension: fallbackCategory, title: checkName, longRange: false }
  );
}

// ---------------------------------------------------------------------------
// Public shapes.
// ---------------------------------------------------------------------------

/** Per-unit scene/speaker scope used to bucket failure modes (§10.1 scope). */
export type BacklogUnitScope = {
  unitId: string;
  label?: string;
  sceneId?: string;
  speakerId?: string;
};

/** One cited piece of evidence backing a failure mode (§4.3 citation). */
export type BacklogEvidenceCitation = {
  unitId: string;
  label: string;
  /** The judge's cited source span, or the metric's observed value locus. */
  sourceSpan: string;
  /** The decoded ground-truth context the judge used, or the metric's expected value. */
  decodedContextUsed: string;
  /** The judge rationale (§4.3) or the deterministic metric rationale. */
  rationale: string;
  /** The judge id (judge signal only). */
  judgeId?: string;
  /** The routable finding id this citation is drawn from. */
  findingId: string;
};

/** Where a failure mode lives (§10.1 scope): scenes/route/speaker/N lines. */
export type BacklogScope = {
  scopeKind: "scene" | "speaker" | "corpus_wide";
  scopeId: string;
  unitCount: number;
  unitIds: string[];
  description: string;
};

/** The §10.2 ladder comparison that fixed a failure mode's rank. */
export type BacklogLadderComparison = {
  /** The scale the three scores share (judge 0–4 mean, or metric 0–1). */
  scale: "judge_mean_0_4" | "metric_0_1";
  systemUnderTestScore: number | null;
  fanMtlScore: number | null;
  professionalScore: number | null;
  /** null when the comparator was absent for this dimension/metric. */
  beatsFanMtl: boolean | null;
  beatsProfessional: boolean | null;
};

export type RegressionDirection = "new" | "improved" | "regressed" | "unchanged";

/** A per-dimension regression datum vs the prior run (§10.3 telemetry). */
export type BacklogRegressionRef = {
  signalSource: BacklogSignalSource;
  key: string;
  currentScore: number;
  priorScore: number | null;
  delta: number | null;
  direction: RegressionDirection;
  summary: string;
};

/** One current-run per-signal score — feed it as `priorRun` on the next run. */
export type BacklogSignalScore = {
  signalSource: BacklogSignalSource;
  key: string;
  label: string;
  /** Normalized higher-is-better 0..1 (judge mean/4, or metric score as-is). */
  score: number;
};

/** A single ranked failure mode (§10.1) — one routable DAG node. */
export type BacklogItem = {
  /** Deterministic id; doubles as the routable DAG node id. */
  backlogItemId: string;
  failureMode: string;
  /** §2 rubric dimension id, or the itotori-lqa-1 category when §2 has none. */
  dimension: string;
  signalSource: BacklogSignalSource;
  scope: BacklogScope;
  evidence: BacklogEvidenceCitation[];
  /** §10.1 adjudicated root cause (itotori-lqa-1 rootCause vocabulary). */
  cause: LocalizationRootCauseV02;
  /** True when THIS node adjudicated an unknown judge finding into `cause`. */
  causeAdjudicated: boolean;
  fixCandidate: string;
  rank: BacklogRankTier;
  ladder: BacklogLadderComparison;
  regressionRef: BacklogRegressionRef | null;
  /** The routable finding ids this failure mode aggregates. */
  findingIds: string[];
  worstSeverity: LocalizationQualitySeverityV02;
  /** Final rank position across the whole backlog (0 = top). */
  priorityOrder: number;
};

/** §10.3 DAG emission — the improvement backlog IS the artifact. */
export type BacklogDagEmission = {
  /** One routable node per ranked failure mode (in priority order). */
  nodes: Array<{
    nodeId: string;
    title: string;
    rank: BacklogRankTier;
    priorityOrder: number;
    dimension: string;
    cause: LocalizationRootCauseV02;
    fixCandidate: string;
    findingIds: string[];
    scope: BacklogScope;
  }>;
  /** The finding records the ranked nodes reference (adjudicated, routable). */
  findings: BenchmarkFindingRecordV02[];
};

export type BenchmarkImprovementBacklog = {
  systemUnderTestId: string;
  fanMtlSystemId: string | null;
  professionalSystemId: string | null;
  /** Ranked failure modes (§10.1 + §10.2). */
  items: BacklogItem[];
  countsByRank: Record<BacklogRankTier, number>;
  /** §10.3 per-dimension regression telemetry vs the prior run. */
  perDimensionRegression: Array<BacklogRegressionRef & { label: string }>;
  /** This run's per-signal scores — persist + pass as next run's `priorRun`. */
  perSignalScores: BacklogSignalScore[];
  /** §10.3 routable DAG findings/nodes. */
  dag: BacklogDagEmission;
  /**
   * All findings adjudicated for report composition: every judge finding with a
   * real `rootCause` (+ `adjudicationState: confirmed`) plus every deterministic
   * metric finding verbatim. Compose into `BenchmarkReportV02.findingRecords`
   * via the report-renderer (the judge-panel node deferred that to §10).
   */
  adjudicatedFindings: BenchmarkFindingRecordV02[];
};

export type ActionableBacklogInput = {
  /** The system whose failures the backlog is built FOR (e.g. itotori_context_on). */
  systemUnderTestId: string;
  /** The fan-edited-MTL contestant id (the §10.2 top-priority comparator). */
  fanMtlSystemId?: string;
  /** The official/professional contestant id (the §10.2 backlog comparator). */
  professionalSystemId?: string;
  /** §4 retained per-(unit, contestant, dimension) judge scores (all contestants). */
  judgeScores: ContestantDimensionScore[];
  /** §4 `llm_qa` findings (all contestants) — adjudicated here. */
  judgeFindings: BenchmarkFindingRecordV02[];
  /** §3 comparable-across-contestant metric scores (all contestants). */
  metricScores: MetricScore[];
  /** §3 deterministic-metric findings (all contestants) — already adjudicated. */
  metricFindings: BenchmarkFindingRecordV02[];
  /** Per-unit scene/speaker scope used to bucket failure modes. */
  unitScopes: BacklogUnitScope[];
  /** The prior run's `perSignalScores` (for §10.3 regression telemetry). */
  priorRun?: { perSignalScores: BacklogSignalScore[] };
};

// ---------------------------------------------------------------------------
// The builder.
// ---------------------------------------------------------------------------

/** Build the §10 ranked improvement backlog for the system under test. */
export function buildActionableBacklog(input: ActionableBacklogInput): BenchmarkImprovementBacklog {
  if (input.systemUnderTestId.length === 0) {
    throw new ActionableBacklogError("systemUnderTestId is required");
  }
  const fanMtlSystemId = input.fanMtlSystemId ?? null;
  const professionalSystemId = input.professionalSystemId ?? null;

  const scopeByUnit = new Map<string, BacklogUnitScope>();
  for (const scope of input.unitScopes) {
    scopeByUnit.set(scope.unitId, scope);
  }

  // §10.2 comparison tables — mean judge score per (system, dimension) and
  // metric score per (system, check). Built over ALL contestants.
  const judgeTable = buildJudgeMeanTable(input.judgeScores);
  const metricTable = buildMetricTable(input.metricScores);

  // §10.3 telemetry — this run's per-signal scores (system under test only).
  const perSignalScores = buildPerSignalScores(input.systemUnderTestId, judgeTable, metricTable);
  const priorByKey = new Map<string, number>();
  for (const prior of input.priorRun?.perSignalScores ?? []) {
    priorByKey.set(signalKey(prior.signalSource, prior.key), prior.score);
  }
  const regressionByKey = new Map<string, BacklogRegressionRef>();
  const perDimensionRegression: Array<BacklogRegressionRef & { label: string }> = [];
  for (const signal of perSignalScores) {
    const ref = computeRegression(signal, priorByKey);
    regressionByKey.set(signalKey(signal.signalSource, signal.key), ref);
    perDimensionRegression.push({ ...ref, label: signal.label });
  }

  // Adjudicate ALL judge findings (any contestant) for report composition.
  const adjudicatedJudgeFindings = input.judgeFindings.map(adjudicateJudgeFinding);
  const adjudicatedById = new Map<string, BenchmarkFindingRecordV02>();
  for (const finding of adjudicatedJudgeFindings) {
    adjudicatedById.set(finding.findingId, finding);
  }
  for (const finding of input.metricFindings) {
    // Deterministic metric findings arrive already adjudicated — kept verbatim.
    adjudicatedById.set(finding.findingId, finding);
  }

  const items: BacklogItem[] = [
    ...decomposeJudgeItems({
      systemUnderTestId: input.systemUnderTestId,
      fanMtlSystemId,
      professionalSystemId,
      judgeScores: input.judgeScores,
      scopeByUnit,
      judgeTable,
      regressionByKey,
    }),
    ...decomposeMetricItems({
      systemUnderTestId: input.systemUnderTestId,
      fanMtlSystemId,
      professionalSystemId,
      metricFindings: input.metricFindings,
      metricTable,
      scopeByUnit,
      regressionByKey,
    }),
  ];

  // §10.2 rank: tier first, then impact (severity, breadth), then a stable key.
  items.sort(compareBacklogItems);
  items.forEach((item, index) => {
    item.priorityOrder = index;
  });

  const countsByRank: Record<BacklogRankTier, number> = {
    top_priority: 0,
    improvement_backlog: 0,
    regression_protection: 0,
  };
  for (const item of items) {
    countsByRank[item.rank] += 1;
  }

  // §10.3 DAG emission — the routable nodes + the findings they reference.
  const referencedFindingIds = new Set<string>();
  for (const item of items) {
    for (const id of item.findingIds) {
      referencedFindingIds.add(id);
    }
  }
  const dagFindings: BenchmarkFindingRecordV02[] = [];
  for (const id of referencedFindingIds) {
    const finding = adjudicatedById.get(id);
    if (finding !== undefined) {
      dagFindings.push(finding);
    }
  }
  dagFindings.sort((a, b) => (a.findingId < b.findingId ? -1 : a.findingId > b.findingId ? 1 : 0));

  const dag: BacklogDagEmission = {
    nodes: items.map((item) => ({
      nodeId: item.backlogItemId,
      title: item.failureMode,
      rank: item.rank,
      priorityOrder: item.priorityOrder,
      dimension: item.dimension,
      cause: item.cause,
      fixCandidate: item.fixCandidate,
      findingIds: item.findingIds,
      scope: item.scope,
    })),
    findings: dagFindings,
  };

  const adjudicatedFindings = [...adjudicatedById.values()].sort((a, b) =>
    a.findingId < b.findingId ? -1 : a.findingId > b.findingId ? 1 : 0,
  );

  return {
    systemUnderTestId: input.systemUnderTestId,
    fanMtlSystemId,
    professionalSystemId,
    items,
    countsByRank,
    perDimensionRegression,
    perSignalScores,
    dag,
    adjudicatedFindings,
  };
}

// ---------------------------------------------------------------------------
// §10.2 comparison tables.
// ---------------------------------------------------------------------------

type ScoreTable = Map<string, Map<string, number>>; // key -> systemId -> score

function buildJudgeMeanTable(scores: ContestantDimensionScore[]): ScoreTable {
  const sums = new Map<string, Map<string, { sum: number; count: number }>>();
  for (const row of scores) {
    const bySystem = sums.get(row.dimensionId) ?? new Map();
    const agg = bySystem.get(row.contestantId) ?? { sum: 0, count: 0 };
    agg.sum += row.score;
    agg.count += 1;
    bySystem.set(row.contestantId, agg);
    sums.set(row.dimensionId, bySystem);
  }
  const table: ScoreTable = new Map();
  for (const [dimensionId, bySystem] of sums) {
    const means = new Map<string, number>();
    for (const [systemId, agg] of bySystem) {
      means.set(systemId, agg.count === 0 ? 0 : agg.sum / agg.count);
    }
    table.set(dimensionId, means);
  }
  return table;
}

function buildMetricTable(scores: MetricScore[]): ScoreTable {
  const table: ScoreTable = new Map();
  for (const row of scores) {
    const bySystem = table.get(row.checkName) ?? new Map<string, number>();
    bySystem.set(row.systemId, row.score);
    table.set(row.checkName, bySystem);
  }
  return table;
}

function ladderFor(
  table: ScoreTable,
  key: string,
  scale: BacklogLadderComparison["scale"],
  systemUnderTestId: string,
  fanMtlSystemId: string | null,
  professionalSystemId: string | null,
): { ladder: BacklogLadderComparison; rank: BacklogRankTier } {
  const bySystem = table.get(key);
  const under = bySystem?.get(systemUnderTestId) ?? null;
  const fan = fanMtlSystemId === null ? null : (bySystem?.get(fanMtlSystemId) ?? null);
  const pro = professionalSystemId === null ? null : (bySystem?.get(professionalSystemId) ?? null);

  const beatsFanMtl = under === null || fan === null ? null : under >= fan - SCORE_EPSILON;
  const beatsProfessional = under === null || pro === null ? null : under >= pro - SCORE_EPSILON;

  const rank = rankTier(under, fan, pro);
  return {
    ladder: {
      scale,
      systemUnderTestScore: under,
      fanMtlScore: fan,
      professionalScore: pro,
      beatsFanMtl,
      beatsProfessional,
    },
    rank,
  };
}

/**
 * §10.2 ladder (higher score = better contestant):
 *   - trailing even fan-MTL          → top_priority (a blind spot)
 *   - beating fan-MTL but below pro   → improvement_backlog (catch-up)
 *   - beating fan-MTL / matching pro  → regression_protection (lock it in)
 * When a comparator is absent we degrade gracefully: with neither comparator a
 * known-defective failure mode defaults to improvement_backlog (work to do),
 * never regression_protection (which asserts we meet the comparators).
 */
function rankTier(under: number | null, fan: number | null, pro: number | null): BacklogRankTier {
  if (under !== null && fan !== null && under < fan - SCORE_EPSILON) {
    return "top_priority";
  }
  if (under !== null && pro !== null && under < pro - SCORE_EPSILON) {
    return "improvement_backlog";
  }
  if (fan !== null || pro !== null) {
    // We meet/beat every comparator that exists → protect against regressions.
    return "regression_protection";
  }
  return "improvement_backlog";
}

// ---------------------------------------------------------------------------
// §10.1 judge-derived failure modes.
// ---------------------------------------------------------------------------

function decomposeJudgeItems(args: {
  systemUnderTestId: string;
  fanMtlSystemId: string | null;
  professionalSystemId: string | null;
  judgeScores: ContestantDimensionScore[];
  scopeByUnit: Map<string, BacklogUnitScope>;
  judgeTable: ScoreTable;
  regressionByKey: Map<string, BacklogRegressionRef>;
}): BacklogItem[] {
  // Only the system under test's DEFECTS (sub-4 cited scores) become failure
  // modes; the retained 4s only inform the ladder mean table.
  const defects = args.judgeScores.filter(
    (row) => row.contestantId === args.systemUnderTestId && row.score < 4 && row.citation !== null,
  );

  const groups = new Map<
    string,
    {
      dimensionId: BenchmarkRubricDimensionId;
      scopeKind: BacklogScope["scopeKind"];
      scopeId: string;
      rows: ContestantDimensionScore[];
    }
  >();
  for (const row of defects) {
    const longRange = isLongRangeDimension(row.dimensionId);
    const scope = unitScopeKey(args.scopeByUnit.get(row.unitId), longRange);
    const groupKey = `${row.dimensionId}|${scope.kind}:${scope.id}`;
    let group = groups.get(groupKey);
    if (group === undefined) {
      group = {
        dimensionId: row.dimensionId,
        scopeKind: scope.kind,
        scopeId: scope.id,
        rows: [],
      };
      groups.set(groupKey, group);
    }
    group.rows.push(row);
  }

  const items: BacklogItem[] = [];
  for (const group of groups.values()) {
    const unitIds = uniqueStable(group.rows.map((r) => r.unitId));
    const scopeDescription = describeScope(group.scopeKind, group.scopeId, unitIds.length);
    const category = benchmarkRubricTaxonomyTargetForDimension(group.dimensionId).category;
    const cause = CATEGORY_TO_CAUSE[category];

    const evidence: BacklogEvidenceCitation[] = group.rows.map((row) => {
      const citation = row.citation;
      const scope = args.scopeByUnit.get(row.unitId);
      return {
        unitId: row.unitId,
        label: scope?.label ?? row.unitId,
        sourceSpan: citation?.sourceSpan ?? "",
        decodedContextUsed: citation?.decodedContextUsed ?? "",
        rationale: citation?.rationale ?? "",
        judgeId: row.judgeId,
        findingId: blindJudgeFindingId(row.judgeId, row.contestantId, row.unitId, row.dimensionId),
      };
    });

    const worstSeverity = worstSeverityForScores(group.rows.map((r) => r.score));
    const { ladder, rank } = ladderFor(
      args.judgeTable,
      group.dimensionId,
      "judge_mean_0_4",
      args.systemUnderTestId,
      args.fanMtlSystemId,
      args.professionalSystemId,
    );

    items.push({
      backlogItemId: deterministicUuid7(
        "backlog-item",
        args.systemUnderTestId,
        "blind_judge_panel",
        group.dimensionId,
        group.scopeKind,
        group.scopeId,
      ),
      failureMode: `${dimensionTitle(group.dimensionId)} defects (${scopeDescription})`,
      dimension: group.dimensionId,
      signalSource: "blind_judge_panel",
      scope: {
        scopeKind: group.scopeKind,
        scopeId: group.scopeId,
        unitCount: unitIds.length,
        unitIds,
        description: scopeDescription,
      },
      evidence,
      cause,
      causeAdjudicated: true,
      fixCandidate: fixCandidateFor(cause),
      rank,
      ladder,
      regressionRef:
        args.regressionByKey.get(signalKey("blind_judge_panel", group.dimensionId)) ?? null,
      findingIds: uniqueStable(evidence.map((e) => e.findingId)),
      worstSeverity,
      priorityOrder: 0,
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// §10.1 metric-derived failure modes.
// ---------------------------------------------------------------------------

function decomposeMetricItems(args: {
  systemUnderTestId: string;
  fanMtlSystemId: string | null;
  professionalSystemId: string | null;
  metricFindings: BenchmarkFindingRecordV02[];
  metricTable: ScoreTable;
  scopeByUnit: Map<string, BacklogUnitScope>;
  regressionByKey: Map<string, BacklogRegressionRef>;
}): BacklogItem[] {
  const mine = args.metricFindings.filter((f) => f.systemId === args.systemUnderTestId);

  const groups = new Map<
    string,
    {
      checkName: string;
      meta: MetricMeta;
      scopeKind: BacklogScope["scopeKind"];
      scopeId: string;
      findings: BenchmarkFindingRecordV02[];
    }
  >();
  for (const finding of mine) {
    const checkName = deterministicCheckName(finding) ?? finding.category;
    const meta = metricMetaFor(checkName, finding.category);
    const unitId = finding.affectedRefs[0]?.subjectId ?? finding.findingId;
    const scope = unitScopeKey(args.scopeByUnit.get(unitId), meta.longRange);
    const groupKey = `${checkName}|${scope.kind}:${scope.id}`;
    let group = groups.get(groupKey);
    if (group === undefined) {
      group = {
        checkName,
        meta,
        scopeKind: scope.kind,
        scopeId: scope.id,
        findings: [],
      };
      groups.set(groupKey, group);
    }
    group.findings.push(finding);
  }

  const items: BacklogItem[] = [];
  for (const group of groups.values()) {
    const unitIds = uniqueStable(
      group.findings.map((f) => f.affectedRefs[0]?.subjectId ?? f.findingId),
    );
    const scopeDescription = describeScope(group.scopeKind, group.scopeId, unitIds.length);
    // Deterministic metric findings carry a real, already-adjudicated rootCause.
    const cause = group.findings[0]?.rootCause ?? "deterministic_qa_rule_error";

    const evidence: BacklogEvidenceCitation[] = group.findings.map((finding) => {
      const ev = finding.evidence[0];
      const unitId = finding.affectedRefs[0]?.subjectId ?? finding.findingId;
      return {
        unitId,
        label: finding.affectedRefs[0]?.label ?? unitId,
        sourceSpan: ev?.observedValue ?? ev?.summary ?? "",
        decodedContextUsed: ev?.expectedValue ?? "",
        rationale: finding.reviewerRationale ?? ev?.summary ?? "",
        findingId: finding.findingId,
      };
    });

    const worstSeverity = worstSeverityForSeverities(group.findings.map((f) => f.qualitySeverity));
    const { ladder, rank } = ladderFor(
      args.metricTable,
      group.checkName,
      "metric_0_1",
      args.systemUnderTestId,
      args.fanMtlSystemId,
      args.professionalSystemId,
    );

    items.push({
      backlogItemId: deterministicUuid7(
        "backlog-item",
        args.systemUnderTestId,
        "deterministic_metric",
        group.checkName,
        group.scopeKind,
        group.scopeId,
      ),
      failureMode: `${group.meta.title} violations (${scopeDescription})`,
      dimension: group.meta.dimension,
      signalSource: "deterministic_metric",
      scope: {
        scopeKind: group.scopeKind,
        scopeId: group.scopeId,
        unitCount: unitIds.length,
        unitIds,
        description: scopeDescription,
      },
      evidence,
      cause,
      causeAdjudicated: false,
      fixCandidate: fixCandidateFor(cause),
      rank,
      ladder,
      regressionRef:
        args.regressionByKey.get(signalKey("deterministic_metric", group.checkName)) ?? null,
      findingIds: uniqueStable(group.findings.map((f) => f.findingId)),
      worstSeverity,
      priorityOrder: 0,
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Adjudication.
// ---------------------------------------------------------------------------

/** §10.1 — turn an `unknown_unadjudicated` judge finding into a caused, confirmed one. */
function adjudicateJudgeFinding(finding: BenchmarkFindingRecordV02): BenchmarkFindingRecordV02 {
  if (finding.rootCause !== "unknown_unadjudicated") {
    return finding;
  }
  const cause = CATEGORY_TO_CAUSE[finding.category];
  return {
    ...finding,
    rootCause: cause,
    adjudicationState: "confirmed",
    reviewerRationale:
      `§10 adjudication (category '${finding.category}' → cause '${cause}', fix: ${fixCandidateFor(
        cause,
      )}). ${finding.reviewerRationale ?? ""}`.trim(),
  };
}

// ---------------------------------------------------------------------------
// §10.3 regression telemetry.
// ---------------------------------------------------------------------------

function buildPerSignalScores(
  systemUnderTestId: string,
  judgeTable: ScoreTable,
  metricTable: ScoreTable,
): BacklogSignalScore[] {
  const out: BacklogSignalScore[] = [];
  for (const [dimensionId, bySystem] of judgeTable) {
    const mean = bySystem.get(systemUnderTestId);
    if (mean === undefined) {
      continue;
    }
    out.push({
      signalSource: "blind_judge_panel",
      key: dimensionId,
      label: dimensionTitle(dimensionId as BenchmarkRubricDimensionId),
      score: mean / 4, // normalize 0–4 → 0..1
    });
  }
  for (const [checkName, bySystem] of metricTable) {
    const score = bySystem.get(systemUnderTestId);
    if (score === undefined) {
      continue;
    }
    out.push({
      signalSource: "deterministic_metric",
      key: checkName,
      label: metricMetaFor(checkName, checkName).title,
      score,
    });
  }
  out.sort((a, b) => {
    if (a.signalSource !== b.signalSource) {
      return a.signalSource < b.signalSource ? -1 : 1;
    }
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return out;
}

function computeRegression(
  signal: BacklogSignalScore,
  priorByKey: Map<string, number>,
): BacklogRegressionRef {
  const prior = priorByKey.get(signalKey(signal.signalSource, signal.key));
  if (prior === undefined) {
    return {
      signalSource: signal.signalSource,
      key: signal.key,
      currentScore: signal.score,
      priorScore: null,
      delta: null,
      direction: "new",
      summary: `${signal.label}: ${fmt(signal.score)} (no prior run)`,
    };
  }
  const delta = signal.score - prior;
  const direction: RegressionDirection =
    delta > SCORE_EPSILON ? "improved" : delta < -SCORE_EPSILON ? "regressed" : "unchanged";
  return {
    signalSource: signal.signalSource,
    key: signal.key,
    currentScore: signal.score,
    priorScore: prior,
    delta,
    direction,
    summary: `${signal.label}: ${fmt(prior)} → ${fmt(signal.score)} (${direction} ${fmtDelta(delta)})`,
  };
}

// ---------------------------------------------------------------------------
// Ordering + small helpers.
// ---------------------------------------------------------------------------

function compareBacklogItems(a: BacklogItem, b: BacklogItem): number {
  const tier = RANK_ORDER[a.rank] - RANK_ORDER[b.rank];
  if (tier !== 0) {
    return tier;
  }
  const sev = SEVERITY_WEIGHT[b.worstSeverity] - SEVERITY_WEIGHT[a.worstSeverity];
  if (sev !== 0) {
    return sev;
  }
  const breadth = b.scope.unitCount - a.scope.unitCount;
  if (breadth !== 0) {
    return breadth;
  }
  if (a.dimension !== b.dimension) {
    return a.dimension < b.dimension ? -1 : 1;
  }
  return a.backlogItemId < b.backlogItemId ? -1 : a.backlogItemId > b.backlogItemId ? 1 : 0;
}

function isLongRangeDimension(dimensionId: BenchmarkRubricDimensionId): boolean {
  const dimension = BENCHMARK_QUALITY_RUBRIC.dimensions.find((d) => d.id === dimensionId);
  return dimension?.longRange ?? false;
}

function dimensionTitle(dimensionId: BenchmarkRubricDimensionId): string {
  const dimension = BENCHMARK_QUALITY_RUBRIC.dimensions.find((d) => d.id === dimensionId);
  return dimension?.title ?? dimensionId;
}

function unitScopeKey(
  scope: BacklogUnitScope | undefined,
  longRange: boolean,
): { kind: BacklogScope["scopeKind"]; id: string } {
  if (longRange) {
    if (scope?.speakerId !== undefined && scope.speakerId.length > 0) {
      return { kind: "speaker", id: scope.speakerId };
    }
    return { kind: "corpus_wide", id: "corpus" };
  }
  if (scope?.sceneId !== undefined && scope.sceneId.length > 0) {
    return { kind: "scene", id: scope.sceneId };
  }
  return { kind: "corpus_wide", id: "corpus" };
}

function describeScope(kind: BacklogScope["scopeKind"], id: string, unitCount: number): string {
  const lines = `${unitCount} line${unitCount === 1 ? "" : "s"}`;
  if (kind === "corpus_wide") {
    return `${lines} corpus-wide`;
  }
  return `${lines} in ${kind} ${id}`;
}

function worstSeverityForScores(scores: number[]): LocalizationQualitySeverityV02 {
  // Rubric 0–4 → severity: 0 critical, 1|2 major, 3 minor.
  let worst: LocalizationQualitySeverityV02 = "neutral";
  for (const score of scores) {
    const severity: LocalizationQualitySeverityV02 =
      score === 0 ? "critical" : score <= 2 ? "major" : "minor";
    worst = worseSeverity(worst, severity);
  }
  return worst;
}

function worstSeverityForSeverities(
  severities: LocalizationQualitySeverityV02[],
): LocalizationQualitySeverityV02 {
  let worst: LocalizationQualitySeverityV02 = "neutral";
  for (const severity of severities) {
    worst = worseSeverity(worst, severity);
  }
  return worst;
}

function worseSeverity(
  a: LocalizationQualitySeverityV02,
  b: LocalizationQualitySeverityV02,
): LocalizationQualitySeverityV02 {
  return SEVERITY_WEIGHT[b] > SEVERITY_WEIGHT[a] ? b : a;
}

/** The metric check name carried on a deterministic-metric finding's provenance. */
function deterministicCheckName(finding: BenchmarkFindingRecordV02): string | undefined {
  for (const record of finding.provenance) {
    if (record.provenanceKind === "deterministic_check") {
      return record.checkName;
    }
  }
  return undefined;
}

function signalKey(source: BacklogSignalSource, key: string): string {
  return `${source}::${key}`;
}

function uniqueStable(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

function fmt(value: number): string {
  return value.toFixed(3);
}

function fmtDelta(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(3)}`;
}
