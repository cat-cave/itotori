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
  FixtureJudge,
  fixtureJudgeProviderRun,
  type FixtureJudgeOptions,
  type FixtureJudgeScoreFn,
} from "./blind-judge-fixture.js";

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
