// Benchmark §9 sensitivity — metric-caught (judge-independent) path.
//
// See methodology §9 sensitivity honesty: residue/overflow sabotage is caught
// by real deterministic metrics; meaning/voice sabotage depends on the LLM judge.

export {
  BenchmarkSensitivityError,
  DEFAULT_RESIDUE_MARKER,
  SABOTAGE_DEFECT_KINDS,
  SABOTAGE_MEANING_MARKER,
  SABOTAGE_REGISTER_MARKER,
  sabotageTranslation,
  type SabotageConfig,
  type SabotageDefectKind,
} from "./sabotage.js";

export {
  JUDGE_DEPENDENT_SABOTAGE_KINDS,
  METRIC_CAUGHT_SABOTAGE_KINDS,
  countResidualSourceScript,
  overflowsBox,
  runMetricCaughtSensitivityCheck,
  wrapLines,
  wrapOverrun,
  type BoxMetrics,
  type MetricCaughtObservation,
  type MetricCaughtSensitivityResult,
  type MetricCaughtUnit,
  type WrapFit,
} from "./metric-caught.js";
