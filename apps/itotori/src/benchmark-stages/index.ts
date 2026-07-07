// ITOTORI-090/091/092 — Real benchmark stage implementations.
//
// These are the genuine stage implementations the ITOTORI-026 benchmark harness
// COMPOSES (it owns no scoring/routing/rendering of its own):
//   - raw-mtl-baseline      (ITOTORI-090)
//   - deterministic-qa      (ITOTORI-090)
//   - qa-agent-evaluation   (ITOTORI-091)
//   - cost-quality-report   (ITOTORI-092)

export { deterministicUuid7, sha256Hex, sha256HashString } from "./ids.js";

export {
  RawMtlBaselineError,
  runRawMtlBaselineStage,
  type RawMtlBaselineInput,
  type RawMtlBaselineResult,
  type RawMtlBaselineSystemOutput,
  type RawMtlCorpusUnit,
  type RawMtlRecordedSystem,
} from "./raw-mtl-baseline.js";

export {
  DeterministicQaError,
  runDeterministicQaStage,
  type DeterministicQaInput,
  type DeterministicQaResult,
} from "./deterministic-qa.js";

export {
  DEFAULT_METRIC_CONFIG,
  DeterministicMetricSuiteError,
  runDeterministicMetricSuite,
  glossaryConsistency,
  namedEntityConsistency,
  wrapCompliance,
  untranslatedResidue,
  speakerAttribution,
  choiceBranchCorrectness,
  voiceStyleFingerprint,
  backTranslationTripwire,
  BACK_TRANSLATION_CHECK_NAME,
  type BackTranslationTripwire,
  type CanonTerm,
  type DeterministicMetricConfig,
  type DeterministicMetricSuiteInput,
  type DeterministicMetricSuiteResult,
  type MetricScore,
  type MetricSystemInput,
  type MetricUnit,
  type ScoredMetricOutcome,
  type TripwireOutcome,
} from "./deterministic-metrics/index.js";

export {
  QaAgentEvaluationError,
  evaluateQaAgents,
  type QaAgentCalibrationSummary,
  type QaAgentEvaluationInput,
  type QaAgentEvaluationResult,
  type QaAgentRecordedFinding,
  type QaAgentRecordedRun,
} from "./qa-agent-evaluation.js";

export {
  assembleBenchmarkReport,
  renderBenchmarkReports,
  type BenchmarkReportRenderInput,
  type RenderedBenchmarkReports,
  type RenderedCostReport,
  type RenderedProviderReport,
  type RenderedQaAccuracyReport,
  type RenderedQualityReport,
} from "./report-renderer.js";

export {
  BenchmarkStagesFixtureError,
  loadBenchmarkStagesFixture,
  type BenchmarkStagesPublicFixture,
  type BenchmarkStagesReportMeta,
} from "./public-fixture-input.js";

export {
  BLIND_METRIC_SYSTEM_KIND,
  CONTESTANT_KINDS,
  CORPUS_INPUT_CONTESTANT_KINDS,
  ContestantBlindingError,
  ContestantHarnessError,
  GENERATIVE_CONTESTANT_KINDS,
  ITOTORI_ABLATION_KINDS,
  RAW_MTL_BASELINE_MAX_PRICE_USD,
  assertContestantBundleBlind,
  deanonymizeCandidate,
  deanonymizeSystem,
  makeRawMtlBaselineRunner,
  runContestantHarness,
  type AnonymizedContestantBundle,
  type AssertContestantBundleBlindOptions,
  type ContestantCandidateProvenance,
  type ContestantCorpusUnit,
  type ContestantDeanonymizationKey,
  type ContestantHarnessInput,
  type ContestantHarnessResult,
  type ContestantKind,
  type ContestantSystemProvenance,
  type CorpusContestantUnitOutput,
  type CorpusInputContestantKind,
  type GeneratedContestantOutput,
  type GenerativeContestantKind,
  type GenerativeContestantRunner,
  type RawMtlBaselineRunnerOptions,
} from "./contestant-harness.js";

export {
  CostLatencyDimensionsError,
  computeCostLatencyDimensions,
  type ContestantAggregateCostLatency,
  type ContestantUnitCostLatency,
  type CostLatencyDimensions,
} from "./cost-latency-dims.js";

export {
  DecodedContextFeedError,
  buildDecodedContextFeed,
  assertJudgeFeedGroundTruthOnly,
  contestantJudgeContexts,
  INTERPRETIVE_ARTIFACT_MARKERS,
  type ContestantCandidate,
  type DecodedBranchPosition,
  type DecodedContextFeedInput,
  type DecodedContextUnitRef,
  type DecodedGroundTruthContext,
  type DecodedScenePosition,
  type InterpretiveContextKey,
  type JudgeUnitInput,
  type _JudgeFeedIsGroundTruthOnly,
} from "./decoded-context-feed.js";

export {
  BLIND_JUDGE_MIN_MODEL_FAMILIES,
  BlindJudgePanelError,
  assertBlindJudgeInputHasNoProvenance,
  blindJudgeFindingId,
  blindLabelForIndex,
  blindUnitForJudge,
  interJudgeAgreementByDimension,
  runBlindJudgePanel,
  seededOrderPermutation,
  type BlindCandidate,
  type BlindJudgeAdapter,
  type BlindJudgePanelInput,
  type BlindJudgePanelResult,
  type BlindJudgeUnitInput,
  type BlindedUnitForJudge,
  type ContestantDimensionScore,
  type DimensionAgreement,
  type JudgeCandidateScoring,
  type JudgeCitation,
  type JudgeCostRecord,
  type JudgeDimensionScore,
  type JudgeUnitScoring,
  type UnscorableDrop,
} from "./blind-judge-panel.js";

export {
  ActionableBacklogError,
  BACKLOG_RANK_TIERS,
  buildActionableBacklog,
  type ActionableBacklogInput,
  type BacklogDagEmission,
  type BacklogEvidenceCitation,
  type BacklogItem,
  type BacklogLadderComparison,
  type BacklogRankTier,
  type BacklogRegressionRef,
  type BacklogScope,
  type BacklogSignalScore,
  type BacklogSignalSource,
  type BacklogUnitScope,
  type BenchmarkImprovementBacklog,
  type RegressionDirection,
} from "./actionable-backlog.js";

export {
  FixtureJudge,
  fixtureJudgeProviderRun,
  type FixtureJudgeOptions,
  type FixtureJudgeScoreFn,
} from "./blind-judge-fixture.js";

export {
  BenchmarkFacilityError,
  aggregateScoring,
  reconstructMetaValidityScenario,
  runBenchmarkFacility,
  type AggregatedScoring,
  type BenchmarkFacilityInput,
  type BenchmarkFacilityMetaValidity,
  type BenchmarkFacilityResult,
  type ScoringAggregationInput,
} from "./benchmark-facility.js";

export {
  REAL_RUN_BENCHMARK_SCHEMA_VERSION,
  RealRunBenchmarkAdapterError,
  InMemoryRealRunArtifactPort,
  makeSelfRunDraftRunner,
  runRealRunBenchmarkAdapter,
  type ComparatorTierRef,
  type RealRunArtifactPort,
  type RealRunBenchmarkAdapterInput,
  type RealRunBenchmarkReport,
  type RealRunGenerativeRunners,
  type RealRunHumanAnchor,
  type RealRunMetaValidityConfig,
  type RealRunReadinessGateConfig,
  type RealRunRef,
  type ResolvedComparatorTier,
  type ResolvedSelfRun,
} from "./benchmark-real-run-adapter.js";

export {
  ZdrJudgeError,
  ZdrModelJudge,
  parseJudgeScoringJson,
  type ZdrModelJudgeOptions,
} from "./blind-judge-zdr-adapter.js";

export {
  BLIND_JUDGE_LIVE_FLAG,
  BLIND_JUDGE_LIVE_MAX_PRICE_USD,
  BLIND_JUDGE_PANEL_ENV,
  parseBlindJudgePanelConfig,
  runBlindJudgePanelLiveSmoke,
  type BlindJudgeLiveConfig,
  type BlindJudgeLiveOptions,
  type BlindJudgeLiveResult,
} from "./blind-judge-live.js";

export {
  BACK_TRANSLATE_LIVE_FLAG,
  BACK_TRANSLATE_LIVE_MAX_PRICE_USD,
  BackTranslateError,
  ZdrBackTranslator,
  populateBackTranslations,
  runBackTranslateLiveSmoke,
  type BackTranslateLiveOptions,
  type BackTranslateLiveResult,
  type BackTranslateOutcome,
  type BackTranslateUnitInput,
  type BackTranslator,
  type PopulateBackTranslationsResult,
  type ZdrBackTranslatorOptions,
} from "./back-translate-live.js";

export {
  FAN_CORRECTED_CALIBRATION_POLICY,
  FAN_CORRECTED_ENGINE,
  FanCorrectedCalibrationError,
  PANEL_PREFERENCE_TIE_THRESHOLD,
  adjudicationPreferredRole,
  assertFanCorrectedCase,
  assertPanelBlindToProvenance,
  buildFanCorrectedCalibration,
  fanCorrectedJudgeUnits,
  runFanCorrectedCalibration,
  swapProvenanceRoles,
  type BuildFanCorrectedCalibrationInput,
  type ContestedVerdict,
  type FanCorrectedCalibrationReport,
  type FanCorrectedCase,
  type FanCorrectedCaseCalibration,
  type FanCorrectedRenderingRole,
  type PanelCasePreference,
  type RunFanCorrectedCalibrationInput,
  type RunFanCorrectedCalibrationResult,
} from "./fan-corrected-calibration-cases.js";

export {
  DEFAULT_META_VALIDITY_THRESHOLDS,
  META_VALIDITY_THRESHOLD_PROVENANCE,
  MetaValidityHarnessError,
  SABOTAGE_DEFECT_KINDS,
  SABOTAGE_MEANING_MARKER,
  SABOTAGE_REGISTER_MARKER,
  computeContestantRanking,
  rankContestants,
  runCalibrationCheck,
  runMetaValidityHarness,
  runRobustnessCheck,
  runSensitivityCheck,
  sabotageContestant,
  sabotageTranslation,
  type CalibrationCheckInput,
  type CalibrationCheckResult,
  type ContestantRankEntry,
  type ContestantRanking,
  type MetaValidityCheckName,
  type MetaValidityContestant,
  type MetaValidityContestantOutput,
  type MetaValidityCorpusUnit,
  type MetaValidityHarnessInput,
  type MetaValidityReport,
  type MetaValidityScenario,
  type MetaValidityThresholds,
  type RankingRun,
  type RankingRunInput,
  type RobustnessCheckInput,
  type RobustnessCheckResult,
  type RobustnessSwap,
  type RobustnessSwapResult,
  type SabotageConfig,
  type SabotageDefectKind,
  type SensitivityCheckInput,
  type SensitivityCheckResult,
} from "./meta-validity-harness.js";

export {
  DEFAULT_STRONG_CALIBER_THRESHOLDS,
  STRONG_CALIBER_READINESS_SCHEMA_VERSION,
  STRONG_CALIBER_THRESHOLD_PROVENANCE,
  StrongCaliberReadinessGateError,
  decideStrongCaliberReadiness,
  type StrongCaliberReadinessEvidence,
  type StrongCaliberReadinessFinding,
  type StrongCaliberReadinessFindingKind,
  type StrongCaliberReadinessGate,
  type StrongCaliberReadinessGateId,
  type StrongCaliberReadinessGateInput,
  type StrongCaliberReadinessQaSignal,
  type StrongCaliberReadinessThresholds,
  type StrongCaliberReadinessVerdict,
} from "./strong-caliber-readiness-gate.js";

export {
  HUMAN_CALIBRATION_ANCHOR_POLICY,
  HumanCalibrationAnchorError,
  PANEL_DIVERGENCE_ALERT_THRESHOLD,
  assertHumanRatingRecord,
  assertHumanRatingRecordIsBlind,
  buildHumanRatingBundles,
  buildPanelHumanCalibrationReport,
  deanonymizeHumanRatings,
  lockHumanRatingAnchor,
  type BuildHumanRatingBundlesInput,
  type BuildHumanRatingBundlesResult,
  type BuildPanelHumanCalibrationReportInput,
  type DeanonymizedHumanScore,
  type DimensionCalibration,
  type HumanDimensionRating,
  type HumanRatingBlinding,
  type HumanRatingBundle,
  type HumanRatingRecord,
  type LockHumanRatingAnchorOptions,
  type LockedHumanRatingAnchor,
  type PanelDivergenceDirection,
  type PanelHumanCalibrationReport,
} from "./human-calibration-anchor.js";
