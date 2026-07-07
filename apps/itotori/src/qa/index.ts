// ITOTORI-021 — Scored-finding workflow + regrade public surface.

export {
  aggregateScoredFindings,
  deriveBridgeUnitScore,
  PER_UNIT_MAX_SEVERITY_WEIGHT,
  ScoredFindingUnitOutOfScopeError,
  ScoredFindingWorkflow,
  SEVERITY_WEIGHTS,
  severityWeight,
  type ScoredFindingsReport,
  type ScoredFindingWorkflowOptions,
  type ScoredQaPerAgentResult,
  type ScoredQaWorkflowInput,
  type ScoredQaWorkflowResult,
} from "./scored-finding-workflow.js";

export {
  QaFreshJudgeIndependenceError,
  REGRADE_DEFAULT_THRESHOLD,
  runFreshJudgeRegrade,
  type FindingConfidence,
  type FindingConfidenceEntry,
  type FindingConfidenceReason,
  type RegradeLoopOptions,
  type RegradeLoopResult,
  type RegradedFindingsReport,
} from "./regrade-loop.js";

export {
  CALIBRATION_FIXTURE_FRESH_JUDGE_MODEL_PROFILE,
  CALIBRATION_FIXTURES,
  calibrationFixtureWorkflowInput,
  KNOWN_GOOD_FIXTURE,
  REGRADE_TRIGGER_FIXTURE,
  SEMANTIC_DRIFT_FIXTURE,
  STYLE_VIOLATION_FIXTURE,
  TERMINOLOGY_MISS_FIXTURE,
  TONE_SHIFT_FIXTURE,
  type CalibrationFixture,
} from "./calibration-fixtures.js";

export {
  detectTranslatorNoteFindings,
  findTranslatorNoteMatches,
  TRANSLATOR_NOTE_FINDING_CATEGORY,
  TRANSLATOR_NOTE_FINDING_SEVERITY,
  TRANSLATOR_NOTE_PATTERNS,
  TRANSLATOR_NOTE_RULE_ID,
  type TranslatorNoteCheckUnit,
  type TranslatorNoteMatch,
} from "./translator-note-check.js";
