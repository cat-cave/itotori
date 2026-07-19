// Terminology Analyst — self-contained role module.
//
// It CONSUMES the shared roster, the whole-game deterministic term/alias/
// occurrence/conflict index, and the shared claim-validation gate read-only, and
// imports nothing from any sibling role. It reasons ONLY over the ambiguous
// candidates the index flags and emits a cited SOURCE-language term ruling whose
// enumeration stays byte-derived — no ad hoc target form. This barrel is the
// analyst's own surface, not the shared roster barrel.

export {
  TermEnumerationError,
  ambiguousTermCandidates,
  assertAmbiguousCandidateByteDerived,
  assertByteDerivedTermEnumeration,
  assertOccurrenceCitationsByteDerived,
  isAmbiguousCandidate,
  occurrenceUnitFactIds,
  type AmbiguousTermCandidate,
  type TermEnumerationFailure,
  type TermRulingObject,
} from "./candidates.js";
export {
  TermOccurrenceEvidenceError,
  readTermOccurrenceEvidence,
  type CiteableTermOccurrence,
  type TermOccurrenceEvidence,
} from "./evidence.js";
export {
  assembleTermAnalystCallSpec,
  composeTermAnalystPrompt,
  inlineTermPromptStore,
  termAnalystTerminalSchemaHash,
  type TermAnalystRequest,
  type TermPromptStore,
} from "./spec.js";
export {
  TermAnalystError,
  runTermAnalyst,
  type TermAnalystDeps,
  type TermAnalystResult,
  type TermRulingEnumeration,
} from "./run.js";
export {
  TermAnalystRouteError,
  assertTermAnalystCertifiedRoute,
  dispatchTermAnalyst,
  dispatchingTermAnalystModel,
  recordedTermAnalystModel,
  type TermAnalystModelPort,
} from "./dispatch.js";
