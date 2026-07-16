// The Voice Reviewer role module: a self-contained casting of the reviewer shape
// that judges ONLY voice and register CONTINUITY against the localized granular
// voice bible and the speaker's accepted target history at the exact DECODE-
// DERIVED counterpart/route/play position. Meaning and every engine/render fault
// are other lanes' rubrics; a FAIL is invalid unless it cites the applicable
// bible rule and the accepted history it violated; a CANNOT_ASSESS never passes.
// Self-contained on purpose — it consumes the roster read-only and shares no
// barrel a sibling reviewer would also edit.
export {
  VOICE_POSITION_DERIVATION,
  AcceptedTargetLineSchema,
  Q2PositionError,
  Q2ReviewInputSchema,
  Q2SampleKindSchema,
  VoiceBibleRuleSchema,
  VoicePositionSchema,
  VoiceRuleScopeSchema,
  applicableBibleRules,
  assertPositionDecodeDerived,
  historyAtPosition,
  parseQ2ReviewInput,
  type AcceptedTargetLine,
  type Q2ReviewInput,
  type Q2SampleKind,
  type VoiceBibleRule,
  type VoicePosition,
  type VoiceRuleScope,
} from "./inputs.js";
export {
  Q2_PROMPT_VERSION,
  assembleQ2Messages,
  q2SystemPrompt,
  q2UserPrompt,
  type Q2Messages,
} from "./prompt.js";
export {
  Q2RouteError,
  Q2RubricScopeError,
  assertCertifiedReviewerRoute,
  assertVoiceOnlyToolGrant,
  buildQ2CallSpec,
  q2VoiceToolGrant,
  type Q2DispatchRefs,
} from "./request.js";
export {
  Q2_VOICE_CATEGORIES,
  canFinalize,
  interpretQ2Verdict,
  positionGroundedCitationResolver,
  type EvidenceResolution,
  type EvidenceResolver,
  type Q2Disposition,
  type Q2Interpretation,
  type VoiceCitationResolution,
  type VoiceCitationResolver,
} from "./verdict.js";
export {
  runQ2Review,
  type Q2Dispatch,
  type Q2DispatchFailure,
  type Q2Reviewed,
  type Q2RunDeps,
  type Q2RunOutcome,
} from "./reviewer.js";
