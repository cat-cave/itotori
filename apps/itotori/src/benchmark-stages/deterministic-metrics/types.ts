// benchmark-deterministic-metric-suite (§3) — shared metric types.
//
// The deterministic metric layer is the bias-independent, judgment-free anchor
// of the translation benchmark (methodology §1.1 / §3). Each metric is a PURE
// function of its inputs — no model, no provider, no clock, no randomness — so
// re-running over the same input is byte-identical, and every metric is
// comparable across the MTL / fan-MTL / official / Itotori contestants.

import type {
  BenchmarkFindingRecordV02,
  BenchmarkSystemKindV02,
} from "@itotori/localization-bridge-schema";

/** A canon term or name with its declared target form. */
export type CanonTerm = {
  /** Source-language surface form (decoded JP). */
  sourceTerm: string;
  /** Declared target form the contestant is expected to render it as. */
  targetForm: string;
};

/** Engine text-box metrics for a unit (the Utsushi word-wrap capability contract). */
export type BoxMetrics = {
  /** Maximum columns (monospace cells) per rendered line. */
  columns: number;
  /** Maximum wrapped lines the box can present without truncation. */
  maxLines: number;
};

/** One ordered choice option and the branch it routes the player to. */
export type ChoiceOption = {
  /** Decoded goto / branch target id (structural, not stylistic). */
  branchTarget: string;
};

/** Choice-unit ground truth (decoded) vs the contestant's rendered options. */
export type ChoiceUnit = {
  /** Decoded ordered branch targets (Kaifuu choice→goto graph). */
  expectedOptions: ChoiceOption[];
  /** The contestant's ordered options after translation. */
  actualOptions: ChoiceOption[];
};

/**
 * A benchmark unit as seen by the deterministic metric layer: the decoded
 * ground truth (source, speaker, choice graph, box metrics) plus the
 * contestant's rendered output. Optional fields gate which metrics evaluate
 * the unit (a unit with no `boxMetrics` is skipped by wrap-compliance, etc.).
 */
export type MetricUnit = {
  /** UUID7 bridge-unit id. */
  unitId: string;
  /** Human-readable locator, e.g. `script/prologue#line-001`. */
  label: string;
  /** Decoded source text (ground truth, JP). */
  sourceText: string;
  /** The contestant's rendered target text. */
  targetText: string;
  /** Protected spans excluded from residue scanning (verbatim substrings). */
  protectedSpans?: string[];
  /** Decoded speaker (Kaifuu ground truth). */
  decodedSpeaker?: string;
  /** The speaker the contestant attributed the line to. */
  attributedSpeaker?: string;
  /** Scene id, used to bucket voice-fingerprint variance across scenes. */
  sceneId?: string;
  /** Speaker id, used to group units for the voice-style fingerprint. */
  speakerId?: string;
  /** Decoded engine text-box metrics for wrap-compliance. */
  boxMetrics?: BoxMetrics;
  /** Choice ground truth + rendered options, for choice/branch correctness. */
  choice?: ChoiceUnit;
  /**
   * INJECTED machine back-translation of `targetText` back to the source
   * language. Supplied by the caller (real ZDR MT round-trip lives OUTSIDE
   * this layer); the tripwire logic over it is deterministic. Absent → the
   * unit is skipped by the back-translation tripwire.
   */
  backTranslation?: string;
};

/** One contestant system's units, comparable side-by-side with the others. */
export type MetricSystemInput = {
  systemId: string;
  systemKind: BenchmarkSystemKindV02;
  units: MetricUnit[];
};

/** Tunable thresholds; every default is recorded so runs stay reproducible. */
export type DeterministicMetricConfig = {
  /**
   * Voice-drift threshold: a speaker whose worst per-feature coefficient of
   * variation across scenes exceeds this is flagged as drifting. Default 0.5.
   */
  voiceDriftThreshold: number;
  /**
   * Back-translation tripwire floor: a unit whose back-translation↔source
   * character-bigram Dice similarity falls BELOW this trips the gross-meaning-
   * loss tripwire. Default 0.3. This is a tripwire bound, NOT a quality score.
   */
  backTranslationTripwireFloor: number;
};

export const DEFAULT_METRIC_CONFIG: DeterministicMetricConfig = {
  voiceDriftThreshold: 0.5,
  backTranslationTripwireFloor: 0.3,
};

/**
 * A reproducible, bias-independent metric score for one (system, metric).
 * `score` is normalized 0..1, higher-is-better, comparable across contestants.
 * `detail` carries metric-specific reproducible numbers (worst overrun, mean
 * similarity, per-feature variance, …). Back-translation deliberately does NOT
 * produce one of these — it is a tripwire, not a score (see TripwireOutcome).
 */
export type MetricScore = {
  systemId: string;
  metricId: string;
  checkName: string;
  score: number;
  ruleCount: number;
  passedRuleCount: number;
  failedRuleCount: number;
  detail: Record<string, number>;
};

/** A scored metric's raw outcome over one system, before suite assembly. */
export type ScoredMetricOutcome = {
  metricId: string;
  checkName: string;
  checkVersion: string;
  ruleCount: number;
  passedRuleCount: number;
  failedRuleCount: number;
  score: number;
  detail: Record<string, number>;
  findings: BenchmarkFindingRecordV02[];
};

/** One back-translation tripwire signal for a unit (gross meaning loss). */
export type BackTranslationTripwire = {
  systemId: string;
  unitId: string;
  label: string;
  /** Deterministic source↔back-translation character-bigram Dice similarity. */
  similarity: number;
  /** The floor the similarity was compared against. */
  threshold: number;
  /** True when similarity < threshold (gross meaning loss suspected). */
  tripped: boolean;
};

/**
 * The back-translation tripwire outcome. Note the ABSENCE of a `score` field:
 * per methodology §3 back-translation is a cheap gross-meaning-loss TRIPWIRE,
 * NOT a ranking score (routing through one MT model would launder that model's
 * opinion), so it never feeds a contestant score.
 */
export type TripwireOutcome = {
  checkName: string;
  checkVersion: string;
  ruleCount: number;
  passedRuleCount: number;
  failedRuleCount: number;
  tripwires: BackTranslationTripwire[];
  findings: BenchmarkFindingRecordV02[];
};
