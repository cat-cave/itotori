// UTSUSHI-011 — Runtime-evidence QA: tools + deterministic checks + agent
// prompt + triage integration. A QA agent inspects Utsushi runtime evidence
// ONLY through the tools here; every finding cites managed artifact refs
// (trace-only, screenshot-backed, or both); deterministic checks fire before
// the agent and catch unambiguous findings without a model.

export {
  InMemoryRuntimeEvidenceArtifactStore,
  type InMemoryRuntimeEvidenceArtifactStoreSeed,
  type RuntimeEvidenceArtifactStore,
} from "./artifact-store.js";
export {
  RUNTIME_EVIDENCE_BACKINGS,
  RUNTIME_EVIDENCE_CITATION_KINDS,
  RUNTIME_EVIDENCE_DETECTOR_KINDS,
  RUNTIME_EVIDENCE_EVIDENCE_TIER_VALUES,
  RUNTIME_EVIDENCE_FINDING_KINDS,
  RUNTIME_EVIDENCE_SEVERITIES,
  RuntimeEvidenceArtifactUnresolvedError,
  type ManagedArtifactRef,
  type RuntimeBranchExpectation,
  type RuntimeEvidenceBacking,
  type RuntimeEvidenceCitation,
  type RuntimeEvidenceCitationKind,
  type RuntimeEvidenceDetectorKind,
  type RuntimeEvidenceExpectations,
  type RuntimeEvidenceFinding,
  type RuntimeEvidenceFindingKind,
  type RuntimeEvidenceSeverity,
  type RuntimeUnitExpectation,
  type ScreenshotOcrArtifact,
  type ScreenshotOcrRegion,
} from "./shapes.js";
export {
  RUNTIME_EVIDENCE_TOOL_VERSION,
  collectOcrHints,
  detectLayout,
  detectMismatch,
  detectMissingText,
  detectWrongBranch,
  layoutTool,
  layoutToolImplementationHash,
  layoutToolInputSchema,
  layoutToolName,
  layoutToolOutputSchema,
  makeRuntimeEvidenceTools,
  mismatchTool,
  mismatchToolImplementationHash,
  mismatchToolInputSchema,
  mismatchToolName,
  mismatchToolOutputSchema,
  missingTextTool,
  missingTextToolImplementationHash,
  missingTextToolInputSchema,
  missingTextToolName,
  missingTextToolOutputSchema,
  ocrHintsTool,
  ocrHintsToolImplementationHash,
  ocrHintsToolInputSchema,
  ocrHintsToolName,
  ocrHintsToolOutputSchema,
  wrongBranchTool,
  wrongBranchToolImplementationHash,
  wrongBranchToolInputSchema,
  wrongBranchToolName,
  wrongBranchToolOutputSchema,
  type LayoutToolInput,
  type MismatchToolInput,
  type MissingTextToolInput,
  type OcrHintsToolInput,
  type RuntimeEvidenceToolOutput,
  type WrongBranchToolInput,
} from "./tools.js";
export {
  runRuntimeEvidenceDeterministicChecks,
  type RuntimeEvidenceDeterministicCheckInput,
  type RuntimeEvidenceDeterministicCheckResult,
} from "./deterministic-checks.js";
export {
  RUNTIME_EVIDENCE_QA_PROMPT_VERSION,
  RUNTIME_EVIDENCE_QA_TOOL_MANIFEST,
  buildRuntimeEvidenceQaPrompt,
  runtimeEvidenceQaPromptHash,
  type RenderedRuntimeEvidenceQaPrompt,
  type RuntimeEvidenceQaPromptInput,
} from "./prompt-template.js";
export {
  buildRuntimeEvidenceReviewerQueueItem,
  runtimeEvidenceFindingsToHumanFindings,
  runtimeEvidenceSourceItemRef,
  type RuntimeEvidenceReviewerQueueInput,
} from "./triage-integration.js";
export {
  RUNTIME_EVIDENCE_FIXTURE_IDS,
  makeRuntimeEvidenceFixtureStore,
  runtimeEvidenceFixtureExpectations,
  runtimeEvidenceFixtureOcrArtifacts,
  runtimeEvidenceFixtureReport,
  runtimeEvidenceFixtureReportRef,
} from "./fixtures.js";
