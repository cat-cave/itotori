// Deterministic localization + evidence gates — the single authoritative home.
//
// Each gate is a PURE function of (immutable fact snapshot, accepted output)
// returning typed pass/defect facts, zero model calls. Facts DOMINATE reviewer
// findings (see ./join.ts); back-translation and voice are SIGNALS, never
// verdicts (see ./signals.ts). This module imports no retired execution,
// orchestration, or benchmark-stage code — it is a genuine rehome onto the snapshot inputs,
// not a wrapper over the old loop.

export { buildDefect, gateForCategory, GateEvaluationError, stableDigest } from "./defect.js";
export type { DeterministicDefectCategory, DefectSeverity, DefectDraft } from "./defect.js";

export { cardinalityOrderHashGate, reachableUnitFactIdsInOrder } from "./cardinality.js";
export { protectedSpansGate, requiredExactSpanRaws } from "./protected-spans.js";
export { encodingGate } from "./encoding.js";
export { byteBoxGate } from "./byte-box.js";
export { markupControlsGate } from "./markup-controls.js";
export {
  LocalizationTargetPolicyError,
  firstNonSjisCodePoint,
  listLocalizationTargetPolicies,
  realliveSjisPolicy,
  registerLocalizationTargetPolicy,
  resolveLocalizationTargetPolicy,
  resolveTargetPolicyForAdapter,
  sjisByteLength,
  siglusUtf16Policy,
  utf8JsonPolicy,
  REALLIVE_SJIS_ADAPTER_ID,
  REALLIVE_SJIS_POLICY_ID,
  SIGLUS_UTF16_ADAPTER_ID,
  SIGLUS_UTF16_POLICY_ID,
  UTF8_JSON_ADAPTER_ID,
  UTF8_JSON_POLICY_ID,
} from "./policy/index.js";
export type {
  EncodingViolation,
  LocalizationTargetPolicy,
  LocalizationTargetPolicyId,
  PolicyBoxLimits,
  RuntimeEvidenceChannel,
  TargetCodec,
} from "./policy/index.js";
export { glossaryExactGate } from "./glossary-exact.js";
export {
  evidenceScopeGate,
  requiresEvidenceCorpus,
  assertEvidenceCorpusPresent,
} from "./evidence-scope.js";
export { patchCoverageGate } from "./patch-coverage.js";
export { renderOcrGate } from "./render-ocr.js";
export { countOccurrences, missingRequiredOccurrences } from "./occurrences.js";

export { backTranslationSignals, voiceFingerprintSignals } from "./signals.js";
export type { Signal } from "./signals.js";

export { joinDefects } from "./join.js";
export type { JoinInput } from "./join.js";

export { evaluateDeterministicGates, evaluateAndJoin } from "./evaluate.js";
export type { DeterministicGateReport } from "./evaluate.js";

export { bindAccepted, indexUnitsByFactId } from "./unit-index.js";
export type { UnitBinding } from "./unit-index.js";

export type {
  AcceptedUnitOutput,
  BoxLimit,
  BoxLimitPolicy,
  DeterministicGateInput,
  GlossaryApprovedForm,
  WorkScope,
} from "./types.js";
