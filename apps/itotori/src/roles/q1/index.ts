// The Meaning Reviewer role module: a self-contained casting of the reviewer
// shape that judges MEANING preservation only, blinded to author identity, and
// finalizes nothing a CANNOT_ASSESS or a defect touches. Self-contained on
// purpose — it consumes the roster read-only and shares no barrel a sibling
// reviewer would also edit.
export {
  FORBIDDEN_BLINDING_KEYS,
  Q1BlindingError,
  Q1ReviewInputSchema,
  Q1SourceFactSchema,
  Q1LocalizedBibleEntrySchema,
  Q1NeighborWindowSchema,
  Q1BackTranslationSignalSchema,
  assertBlinded,
  parseQ1ReviewInput,
  type Q1ReviewInput,
  type Q1SourceFact,
  type Q1LocalizedBibleEntry,
  type Q1NeighborWindow,
  type Q1BackTranslationSignal,
} from "./inputs.js";
export {
  Q1ReadContextError,
  q1ReadCaller,
  readQ1ReviewInput,
  type Q1ReadContext,
} from "./context.js";
export {
  Q1_PROMPT_VERSION,
  assembleQ1Messages,
  q1SystemPrompt,
  q1UserPrompt,
  type Q1Messages,
} from "./prompt.js";
export {
  Q1RubricScopeError,
  assertMeaningOnlyToolGrant,
  buildQ1CallSpec,
  q1MeaningToolGrant,
  type Q1DispatchRefs,
} from "./request.js";
export {
  Q1_MEANING_CATEGORIES,
  canFinalize,
  interpretQ1Verdict,
  type EvidenceResolution,
  type EvidenceResolver,
  type Q1Disposition,
  type Q1Interpretation,
} from "./verdict.js";
export {
  Q1ArtifactError,
  assembleQ1ReviewArtifact,
  type Q1ArtifactContext,
  type Q1ReviewArtifact,
} from "./artifact.js";
export {
  runQ1Review,
  type Q1Dispatch,
  type Q1DispatchFailure,
  type Q1Reviewed,
  type Q1RunDeps,
  type Q1RunOutcome,
} from "./reviewer.js";
