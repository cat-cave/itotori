// Cultural Adaptation Analyst — the self-contained role module.
//
// The `analyst` casting that runs across the deterministically flagged culture,
// wordplay, dialect, and honorific units — exactly the pre-pass's flagged set,
// never an unflagged line — and dispatches deepseek-v4-flash through the sole ZDR
// boundary, route-bound in EVERY run mode. It emits cited SOURCE-language
// adaptation notes describing communicative function and bounded options, never a
// replacement translation, each mapped to a real unit whose citations re-prove
// against the immutable snapshot. It consumes the roster, the read-tool read
// model, and claim validation READ-ONLY, imports nothing from the legacy agents
// tree, and owns a private barrel a sibling role never edits.

export {
  AdaptationEvidenceError,
  assertFlagByteDerived,
  assertNoteIsFunctionAndOptions,
  assertNoteMapsToFlaggedUnit,
  flagEvidence,
  flaggedAdaptationCandidates,
  isFlaggedUnit,
  type AdaptationCategory,
  type AdaptationFactSnapshot,
  type AdaptationFailure,
  type AdaptationNoteObject,
  type FlaggedAdaptationCandidate,
} from "./candidates.js";
export {
  adaptationTerminalSchemaHash,
  assembleAdaptationCallSpec,
  candidateAnchor,
  composeAdaptationPrompt,
  inlineAdaptationPromptStore,
  type AdaptationPromptStore,
  type AdaptationRequest,
} from "./spec.js";
export {
  AdaptationRouteError,
  assertCertifiedRouteEveryMode,
  dispatchAdaptationAnalyst,
  dispatchingAdaptationModel,
  recordedAdaptationModel,
  recordedAdaptationModelByAnchor,
  type AdaptationModelPort,
} from "./dispatch.js";
export {
  AdaptationAnalystError,
  runAdaptationAnalyst,
  runAdaptationNote,
  type AdaptationAnalystDeps,
  type AdaptationAnalystResult,
  type AdaptationNoteResult,
} from "./run.js";
