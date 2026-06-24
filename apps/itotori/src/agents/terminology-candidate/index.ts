export {
  buildConflictIndex,
  generateTerminologyCandidates,
  generateTerminologyCandidatesBatch,
  type GenerateTerminologyCandidatesOptions,
} from "./agent.js";
export {
  buildPrompt,
  canonicalizeUnits,
  PROMPT_TEMPLATE_VERSION_V1,
  promptHash,
  type RenderedPrompt,
} from "./prompt-template.js";
export {
  candidateToSaveInput,
  persistTerminologyCandidate,
  recordToCandidate,
} from "./persistence.js";
export {
  markStaleTerminologyCandidatesForRevision,
  type TerminologyCandidateConflict,
  type TerminologyCandidateDrift,
  type TerminologyCandidateStalenessScanInput,
  type TerminologyCandidateStalenessScanResult,
} from "./staleness.js";
export {
  resolveTerminologyCandidateProvider,
  runCheckTerminologyCandidatesCli,
  runGenerateTerminologyCandidatesCli,
  type CheckTerminologyCandidatesCliInput,
  type GenerateTerminologyCandidatesCliInput,
  type GenerateTerminologyCandidatesCliResult,
  type TerminologyCandidateCliDependencies,
} from "./cli.js";
export {
  ExistingGlossaryConflictError,
  TERMINOLOGY_CANDIDATE_KINDS,
  TerminologyCandidateEmptyInputError,
  TerminologyCandidateInvalidKindError,
  TerminologyCandidateLocaleMismatchError,
  TerminologyCandidateNotInUnitsError,
  TerminologyCandidateParseError,
  TerminologyCandidateUncitedError,
  TerminologyCandidateUnknownCitationError,
  type BridgeUnitForTerminology,
  type CandidateKind,
  type ExistingGlossaryEntry,
  type PriorCandidateRef,
  type ProviderEmittedPack,
  type TerminologyCandidate,
  type TerminologyCandidateInput,
  type TerminologyCandidateInvalidatedReason,
  type TerminologyCandidateModelProfile,
  type TerminologyCandidateOutput,
  type TerminologyCandidateStatus,
} from "./shapes.js";
