// ITOTORI-026 — Benchmark harness integration public surface.

export {
  BENCHMARK_HARNESS_RUN_MANIFEST_SCHEMA_VERSION,
  BENCHMARK_HARNESS_STAGE_ORDER,
  BenchmarkHarnessStageConfigurationError,
  assertBenchmarkHarnessRunManifest,
  runBenchmarkHarnessCommand,
  type BenchmarkHarnessArtifactWriter,
  type BenchmarkHarnessCommandArgs,
  type BenchmarkHarnessCostSummary,
  type BenchmarkHarnessCostTotalBySystem,
  type BenchmarkHarnessNamedArtifact,
  type BenchmarkHarnessRunManifest,
  type BenchmarkHarnessStage,
  type BenchmarkHarnessStageContext,
  type BenchmarkHarnessStageFailure,
  type BenchmarkHarnessStageId,
  type BenchmarkHarnessStageOutput,
  type BenchmarkHarnessStageRecord,
} from "./run-command.js";

export {
  DEFAULT_PUBLIC_BENCHMARK_SEEDS_FIXTURE_PATH,
  DEFAULT_PUBLIC_BENCHMARK_SETS_FIXTURE_PATH,
  DEFAULT_PUBLIC_BENCHMARK_STAGES_FIXTURE_PATH,
  DEFAULT_PUBLIC_BENCHMARK_RUN_ID,
  DEFAULT_PUBLIC_BENCHMARK_GENERATED_AT,
  BenchmarkHarnessMissingCompositionError,
  benchmarkSetReadModelFromSeedsFixture,
  benchmarkSetSelectionInputFromSetsFixture,
  buildPublicBenchmarkHarnessStages,
  type PublicBenchmarkHarnessFixtureInputs,
} from "./public-fixture.js";

export {
  loadBenchmarkStagesFixture,
  type BenchmarkStagesPublicFixture,
} from "../benchmark-stages/index.js";
