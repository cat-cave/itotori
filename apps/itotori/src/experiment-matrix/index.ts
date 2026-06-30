// ITOTORI-099 — Experiment matrix runner public surface.

export {
  EXPERIMENT_MATRIX_CONFIG_SCHEMA_VERSION,
  ExperimentMatrixConfigError,
  assertExperimentMatrixConfig,
  experimentInvocationCount,
  type ExperimentMatrixBounds,
  type ExperimentMatrixCell,
  type ExperimentMatrixConfig,
  type ExperimentModelProviderPair,
  type ExperimentPromptPreset,
} from "./config.js";

export {
  EXPERIMENT_INVOCATION_ARTIFACT_SCHEMA_VERSION,
  EXPERIMENT_MATRIX_RUN_MANIFEST_SCHEMA_VERSION,
  ExperimentFixtureMissingError,
  ExperimentMatrixRunFailedError,
  assertExperimentRunSucceeded,
  experimentLedgerId,
  experimentRunId,
  runExperimentMatrix,
  type ExperimentArtifactRedaction,
  type ExperimentCostSummary,
  type ExperimentFixtureContent,
  type ExperimentFixtureResolver,
  type ExperimentInvocationArtifact,
  type ExperimentMatrixRunInput,
  type ExperimentMatrixRunManifest,
  type ExperimentProviderResolver,
  type ExperimentRunFinding,
  type ExperimentRunFindingKind,
} from "./runner.js";
