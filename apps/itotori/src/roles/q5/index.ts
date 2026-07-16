// The Build-LQA Reviewer role module: a self-contained casting of the reviewer
// shape that judges RESIDUAL TRANSLATION QUALITY ON SCREEN only, observing the
// English target through the render/OCR frame channel (never the Shift-JIS
// -gated decoded channel), and routing every render/build fault to the
// deterministic gates that own it. Self-contained on purpose — it consumes the
// roster read-only and shares no barrel a sibling reviewer would also edit.
export {
  FORBIDDEN_DECODED_OBSERVATION_KEYS,
  Q5_RENDER_FAULT_KINDS,
  Q5DecodedObservationError,
  Q5FrameNotObservedError,
  Q5RenderFaultKindSchema,
  Q5RenderFrameSchema,
  Q5RenderObservationSchema,
  Q5ReviewInputSchema,
  assertFrameObserved,
  parseQ5ReviewInput,
  q5FrameFromRenderResult,
  type Q5RenderFaultKind,
  type Q5RenderFrame,
  type Q5RenderObservation,
  type Q5ReviewInput,
} from "./inputs.js";
export {
  deterministicFaults,
  frameHasBlockingFault,
  gateForFaultKind,
  type DeterministicGate,
  type RoutedFault,
} from "./faults.js";
export {
  Q5_PROMPT_VERSION,
  assembleQ5Messages,
  q5SystemPrompt,
  q5UserPrompt,
  type Q5Messages,
} from "./prompt.js";
export {
  Q5RubricScopeError,
  assertBuildLqaOnlyToolGrant,
  buildQ5CallSpec,
  q5BuildLqaToolGrant,
  type Q5DispatchRefs,
} from "./request.js";
export {
  Q5_ONSCREEN_CATEGORIES,
  canFinalize,
  interpretQ5Verdict,
  type EvidenceResolution,
  type EvidenceResolver,
  type Q5Disposition,
  type Q5Interpretation,
} from "./verdict.js";
export {
  runQ5Review,
  type Q5Dispatch,
  type Q5DispatchFailure,
  type Q5Reviewed,
  type Q5RunDeps,
  type Q5RunOutcome,
} from "./reviewer.js";
