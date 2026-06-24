export {
  SpeakerLabelAgent,
  SpeakerLabelResponseValidationError,
  prepareSpeakerLabelForPatchExport,
  type PublicSpeakerIdentity,
  type PublicSpeakerLabel,
  type SpeakerLabelAgentOptions,
} from "./agent.js";
export {
  buildSpeakerLabelPrompt,
  canonicalizeUnits,
  speakerLabelPromptHash,
  type RenderedSpeakerLabelPrompt,
} from "./prompt-template.js";
export {
  HiddenIdentityLeakError,
  SPEAKER_LABEL_DEFAULT_STRUCTURED_OUTPUT_NAME,
  SPEAKER_LABEL_PROMPT_TEMPLATE_VERSION_V1,
  SpeakerLabelBelowConfidenceFloorError,
  SpeakerLabelEmptyInputError,
  SpeakerLabelHiddenMaskMismatchError,
  SpeakerLabelLocaleMismatchError,
  SpeakerLabelPartialResultError,
  SpeakerLabelProviderCapabilityError,
  SpeakerLabelUnknownCitationError,
  type CharacterBio,
  type SpeakerLabel,
  type SpeakerLabelBridgeUnit,
  type SpeakerLabelConfidence,
  type SpeakerLabelInvocationInput,
  type SpeakerLabelInvocationModelMetadata,
  type SpeakerLabelInvocationResult,
  type SpeakerLabelModelProfile,
} from "./shapes.js";
