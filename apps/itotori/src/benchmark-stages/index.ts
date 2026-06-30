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
