// benchmark-deterministic-metric-suite (§3) — public surface.
//
// The bias-independent, reproducible metric layer of the translation benchmark
// (methodology §3). Each metric is a pure, unit-tested function comparable
// across the MTL / fan-MTL / official / Itotori contestants; back-translation
// is a gross-meaning-loss TRIPWIRE, not a ranking score.

export {
  DEFAULT_METRIC_CONFIG,
  type BackTranslationTripwire,
  type BoxMetrics,
  type CanonTerm,
  type ChoiceOption,
  type ChoiceUnit,
  type DeterministicMetricConfig,
  type MetricScore,
  type MetricSystemInput,
  type MetricUnit,
  type ScoredMetricOutcome,
  type TripwireOutcome,
} from "./types.js";

export {
  buildMetricFinding,
  TAXONOMY_ID,
  TAXONOMY_VERSION,
  type MetricViolation,
} from "./findings.js";

export { glossaryConsistency, namedEntityConsistency } from "./glossary-and-names.js";
export { wrapCompliance, untranslatedResidue } from "./layout-residue.js";
export { choiceBranchCorrectness, speakerAttribution } from "./structural.js";
export { voiceStyleFingerprint } from "./voice-fingerprint.js";
export {
  backTranslationTripwire,
  BACK_TRANSLATION_CHECK_NAME,
} from "./back-translation-tripwire.js";

export {
  runDeterministicMetricSuite,
  DeterministicMetricSuiteError,
  type DeterministicMetricSuiteInput,
  type DeterministicMetricSuiteResult,
} from "./suite.js";

export {
  characterBigramDice,
  coefficientOfVariation,
  countResidualSourceScript,
  styleFeatures,
  wrapLines,
  wrapOverrun,
  type StyleFeatures,
  type WrapFit,
} from "./text-utils.js";
