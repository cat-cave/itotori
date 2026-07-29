import { BRIDGE_SCHEMA_VERSION_V02, Bcp47Locale, Uuid7 } from "./bridge-core-types.js";
import {
  BenchmarkRunStatusV02,
  LOCALIZATION_QUALITY_TAXONOMY_ID,
  LOCALIZATION_QUALITY_TAXONOMY_VERSION,
  LocalizationAdjudicationStateV02,
  LocalizationQualityCategoryV02,
  LocalizationQualitySeverityV02,
  LocalizationRootCauseV02,
  QualityDetectorKindV02,
} from "./schema-enums.js";
import {
  BenchmarkArtifactRefV02,
  BenchmarkCommandLineV02,
  BenchmarkComparedSystemV02,
  BenchmarkCostLedgerV02,
  BenchmarkInputRefV02,
  BenchmarkProviderRunV02,
  BenchmarkToolVersionV02,
  EvidenceRecordV02,
  ProvenanceRecordV02,
  TriageSubjectRefV02,
} from "./localization-triage-types.js";

export function computeBenchmarkCostLedgerV02(
  providerRuns: readonly BenchmarkProviderRunV02[],
  localeBranchId?: Uuid7,
): BenchmarkCostLedgerV02 {
  let reportTotalMicrosUsd = 0;
  let includesUnknownCost = false;
  const totals = new Map<string, number>();
  for (const run of providerRuns) {
    if (run.cost.costKind === "unknown") {
      includesUnknownCost = true;
      continue;
    }
    const amount = run.cost.amountMicrosUsd ?? 0;
    reportTotalMicrosUsd += amount;
    totals.set(run.systemId, (totals.get(run.systemId) ?? 0) + amount);
  }
  return {
    currency: "USD",
    reportTotalMicrosUsd,
    totalsBySystem: [...totals.entries()].map(([systemId, totalMicrosUsd]) => ({
      systemId,
      totalMicrosUsd,
    })),
    includesUnknownCost,
    ...(localeBranchId !== undefined ? { localeBranchId } : {}),
  };
}

export type BenchmarkFindingRecordV02 = {
  findingId: Uuid7;
  systemId: string;
  taxonomyId: typeof LOCALIZATION_QUALITY_TAXONOMY_ID;
  taxonomyVersion: typeof LOCALIZATION_QUALITY_TAXONOMY_VERSION;
  detectorKind: QualityDetectorKindV02;
  category: LocalizationQualityCategoryV02;
  qualitySubcategory?: string;
  qualitySeverity: LocalizationQualitySeverityV02;
  rootCause: LocalizationRootCauseV02;
  adjudicationState: LocalizationAdjudicationStateV02;
  affectedRefs: TriageSubjectRefV02[];
  evidence: EvidenceRecordV02[];
  provenance: ProvenanceRecordV02[];
  /**
   * when the recording harness determined the finding could not
   * be scored against the seeded-defect oracle at all (e.g. the QA agent's
   * evidence was incomplete / off-target), the LLM QA evaluation stage
   * (`evaluateQaAgents` / `buildLlmQaFinding`) STAMPS this on the persisted
   * finding so downstream calibration (`summarizeQaAgents`) can EXCLUDE the
   * finding from the false-positive count — matching the in-memory harness
   * behavior (`recorded.unscorable !== true` → counted as FP).
   *
   * `true` means the finding is intentionally excluded from FP counting;
   * `false` / absent means it IS eligible for FP counting on un-seeded units.
   */
  unscorable?: boolean;
  seededDefectId?: string;
  reviewerRationale?: string;
};

export type BenchmarkCountBucketV02<Bucket extends string = string> = {
  bucket: Bucket;
  count: number;
};

export type BenchmarkPenaltySummaryV02 = {
  penaltyTotal: number;
  penaltyPerThousandSourceChars: number;
  penaltyPerHundredSourceUnits: number;
};

export type BenchmarkSeededDefectOracleV02 = {
  seededDefectId: string;
  fixtureOrCorpusRefId: string;
  seedKind: string;
  targetLocale: Bcp47Locale;
  affectedRefs: TriageSubjectRefV02[];
  category: LocalizationQualityCategoryV02;
  qualitySubcategory?: string;
  qualitySeverity: LocalizationQualitySeverityV02;
  expectedRootCause: LocalizationRootCauseV02;
  expectedDetectorKinds: QualityDetectorKindV02[];
  matchedFindingIds: Uuid7[];
  publicContent: boolean;
};

export type DeterministicQaResultV02 = {
  deterministicQaRunId: Uuid7;
  evaluatedSystemId: string;
  checkName: string;
  checkVersion: string;
  startedAt: string;
  completedAt?: string;
  ruleCount: number;
  passedRuleCount: number;
  failedRuleCount: number;
  findingIds: Uuid7[];
  artifactRefs: BenchmarkArtifactRefV02[];
};

export type QaAgentMetricsV02 = {
  seededRecall: number;
  seededPrecision: number;
  f1: number;
  categoryAccuracy: number;
  qualitySeverityAccuracy: number;
  rootCauseAccuracy: number;
  criticalRecall: number;
  unscorableRate: number;
  humanConfirmedPrecision?: number;
  findingsEmitted: number;
  scorableFindings: number;
  adjudicatedFindings: number;
};

export type QaAgentEvaluationV02 = {
  qaAgentEvaluationId: Uuid7;
  qaAgentId: string;
  qaAgentVersion: string;
  evaluatedSystemId: string;
  providerRunIds: Uuid7[];
  findingIds: Uuid7[];
  metrics: QaAgentMetricsV02;
  limitations: string[];
};

export type HumanEvaluationResultV02 = {
  humanEvaluationId: Uuid7;
  reviewSessionId: Uuid7;
  evaluatedSystemIds: string[];
  reviewerCount: number;
  sampleUnitCount: number;
  sampleSourceCharacterCount: number;
  blindReview: boolean;
  adjudicatedFindingIds: Uuid7[];
  reviewerAgreementNotes?: string;
};

export type BenchmarkReportV02 = {
  schemaVersion: typeof BRIDGE_SCHEMA_VERSION_V02;
  benchmarkRunId: Uuid7;
  taxonomyId: typeof LOCALIZATION_QUALITY_TAXONOMY_ID;
  taxonomyVersion: typeof LOCALIZATION_QUALITY_TAXONOMY_VERSION;
  createdAt: string;
  benchmarkName: string;
  status: BenchmarkRunStatusV02;
  fixtureOrCorpusRefs: BenchmarkInputRefV02[];
  sourceLocale: Bcp47Locale;
  targetLocale: Bcp47Locale;
  // the locale branch this benchmark run belongs to. A target
  // locale is not enough: two branches can share a target locale (e.g. two
  // competing en-US drafts) and their benchmark + cost state must never be
  // conflated. Optional on the cross-app wire (mirroring the other v0.2
  // locale-branch carriers); itotori's recording boundary requires it so a
  // recorded benchmark never falls back to project-level scope.
  localeBranchId?: Uuid7;
  engineProfile: string;
  gitCommit: string;
  bridgeSchemaVersion: typeof BRIDGE_SCHEMA_VERSION_V02;
  deterministicSeed?: string;
  toolVersions: BenchmarkToolVersionV02[];
  commandLines: BenchmarkCommandLineV02[];
  systemsCompared: BenchmarkComparedSystemV02[];
  providerModelCostRecords: BenchmarkProviderRunV02[];
  costLedger: BenchmarkCostLedgerV02;
  seededDefectOracle: BenchmarkSeededDefectOracleV02[];
  findingRecords: BenchmarkFindingRecordV02[];
  countsByQualitySeverity: BenchmarkCountBucketV02<LocalizationQualitySeverityV02>[];
  countsByCategory: BenchmarkCountBucketV02<LocalizationQualityCategoryV02>[];
  countsByRootCause: BenchmarkCountBucketV02<LocalizationRootCauseV02>[];
  countsByDetectorKind: BenchmarkCountBucketV02<QualityDetectorKindV02>[];
  countsByAdjudicationState: BenchmarkCountBucketV02<LocalizationAdjudicationStateV02>[];
  penaltySummary: BenchmarkPenaltySummaryV02;
  deterministicQaResults: DeterministicQaResultV02[];
  qaAgentEvaluations: QaAgentEvaluationV02[];
  humanEvaluationResults: HumanEvaluationResultV02[];
  knownBlindSpots: string[];
};

// ---------------------------------------------------------------------------
// Benchmark quality rubric (`benchmark-quality-rubric` node)
//
// The machine-consumable form of the translation-benchmark quality rubric
// documented in `docs/itotori-translation-benchmark-methodology.md` §2. This
// is the human-scored VIEW of the `itotori-lqa-1` taxonomy, NOT a rival
// vocabulary: every rubric dimension maps onto an itotori-lqa-1 category and
// every rubric score maps onto an MQM severity, so external quality scores,
// deterministic findings, and review findings share one vocabulary.
//
// Conformance rule (§2): this artifact MIRRORS §2 exactly — dimensions (§2.2),
// the 0–4 anchored scale (§2.1), and the scale→MQM-severity mapping (§2.1). It
// adds no dimension and invents no scale. Two dimensions that §2.2 lists but
// does NOT tag to a taxonomy category (`wordplay_puns_songs`,
// `speaker_attribution`) carry a `taxonomyMappingSource: "reasoned_default"`
// marker so the fill-in is auditable and never mistaken for a §2 directive.
// ---------------------------------------------------------------------------

export const BENCHMARK_QUALITY_RUBRIC_ID = "itotori-benchmark-quality-rubric-1" as const;
export const BENCHMARK_QUALITY_RUBRIC_VERSION = "itotori.benchmark-quality-rubric.v1" as const;

/** §2.1 — the 0–4 anchored scale. Every dimension is scored on this scale. */
export const BENCHMARK_RUBRIC_SCORES = [0, 1, 2, 3, 4] as const;
export type BenchmarkRubricScore = (typeof BENCHMARK_RUBRIC_SCORES)[number];

/** §2.1 — "score below 4 requires cited reasoning or it is unscorable". */
export const BENCHMARK_RUBRIC_CITATION_REQUIRED_BELOW_SCORE = 4 as const;

/**
 * §2.1 "Rough MQM-severity correspondence" as a machine-usable band. Four of
 * the five scores correspond to a single MQM severity (or to no defect); score
 * 1 is deliberately a BAND ("between major and critical") in §2, represented
 * faithfully here as a `between` band rather than being forced to a single
 * value. A discrete severity for finding emission is derived separately by
 * {@link benchmarkRubricQualitySeverityForScore}.
 */
export type BenchmarkRubricMqmBand =
  | { kind: "no_defect" }
  | { kind: "severity"; severity: LocalizationQualitySeverityV02 }
  | {
      kind: "between";
      lower: LocalizationQualitySeverityV02;
      upper: LocalizationQualitySeverityV02;
    };

export type BenchmarkRubricScaleAnchor = {
  score: BenchmarkRubricScore;
  /** §2.1 anchor prose (verbatim). */
  anchor: string;
  /** §2.1 "Rough MQM-severity correspondence" cell (verbatim). */
  mqmCorrespondence: string;
  /** Machine-usable form of `mqmCorrespondence`. */
  mqmBand: BenchmarkRubricMqmBand;
};

/** §2.2 dimension groupings. */
export const BENCHMARK_RUBRIC_DIMENSION_GROUPS = [
  "adequacy_accuracy",
  "fluency",
  "localization_craft",
  "technical",
] as const;
export type BenchmarkRubricDimensionGroup = (typeof BENCHMARK_RUBRIC_DIMENSION_GROUPS)[number];

/** §2.2 dimensions — the complete, closed set. Order mirrors §2.2. */
export const BENCHMARK_RUBRIC_DIMENSION_IDS = [
  "adequacy",
  "callbacks_foreshadowing",
  "fluency",
  "register_politeness",
  "character_voice_consistency",
  "honorifics",
  "wordplay_puns_songs",
  "cultural_adaptation",
  "textbox_fit_wordwrap",
  "speaker_attribution",
  "choice_branch_correctness",
] as const;
export type BenchmarkRubricDimensionId = (typeof BENCHMARK_RUBRIC_DIMENSION_IDS)[number];

/**
 * Whether a dimension's taxonomy mapping is stated by §2.2 (`section_2`) or is
 * a reasoned fill-in for a dimension §2.2 lists but does not tag
 * (`reasoned_default`). Only two dimensions use `reasoned_default`.
 */
export const BENCHMARK_RUBRIC_MAPPING_SOURCES = ["section_2", "reasoned_default"] as const;
export type BenchmarkRubricMappingSource = (typeof BENCHMARK_RUBRIC_MAPPING_SOURCES)[number];

export type BenchmarkRubricDimension = {
  id: BenchmarkRubricDimensionId;
  title: string;
  group: BenchmarkRubricDimensionGroup;
  /** §2.2 criterion — what the dimension evaluates and what it penalizes. */
  criterion: string;
  /** itotori-lqa-1 category a score below 4 converts into. */
  taxonomyCategory: LocalizationQualityCategoryV02;
  /** itotori-lqa-1 subcategory when §2.2 names one. */
  taxonomySubcategory?: string;
  /** §2.2 ACROSS-the-work dimension (character voice, callbacks). */
  longRange: boolean;
  /** §2.2 "scored only when ..." guard, when the dimension is conditional. */
  conditionalScoring?: string;
  /** §2.2 technical group ∩ §3 deterministic metric suite. */
  alsoDeterministic: boolean;
  taxonomyMappingSource: BenchmarkRubricMappingSource;
  notes?: string;
};

export type BenchmarkQualityRubric = {
  rubricId: typeof BENCHMARK_QUALITY_RUBRIC_ID;
  rubricVersion: typeof BENCHMARK_QUALITY_RUBRIC_VERSION;
  taxonomyId: typeof LOCALIZATION_QUALITY_TAXONOMY_ID;
  taxonomyVersion: typeof LOCALIZATION_QUALITY_TAXONOMY_VERSION;
  methodologyRef: string;
  /** §2.1 — judges must cite any score below this or it is dropped. */
  citationRequiredBelowScore: typeof BENCHMARK_RUBRIC_CITATION_REQUIRED_BELOW_SCORE;
  scale: BenchmarkRubricScaleAnchor[];
  dimensions: BenchmarkRubricDimension[];
  /**
   * §2.3 — dimension weighting is an OPEN DECISION (§12). Until decided the
   * rubric reports per-dimension vectors ONLY, never a single weighted total.
   */
  weighting: {
    policy: "per_dimension_vector_only";
    singleWeightedTotalReported: false;
    openDecisionRef: string;
  };
};
