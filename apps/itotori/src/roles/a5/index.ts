// A5 Granular Voice Director — the self-contained role module.
//
// The `analyst` casting that authors ONE cited source-language voice profile for
// EVERY character in the deterministic index, dispatching deepseek-v4-flash through
// the sole ZDR boundary. A profile is addressable by CHARACTER (its base register),
// COUNTERPART/relationship, ROUTE, and ARC-POSITION RANGE, carrying register,
// forms, modulation, register shifts, confidence, and citations. For ANY real
// dialogue unit the deterministic lookup resolves the applicable slice — MOST
// SPECIFIC WINS — and the per-character base can never overwrite a more-specific
// route/counterpart/arc rule (specificity: character < route < counterpart/arc-
// range). It consumes the fact snapshot through the LOCAL read tools only — it
// holds no web-egress grant — imports nothing from the legacy agents tree, and owns
// a private barrel a sibling role never edits.

export {
  A5RoleError,
  A5_ROLE_ID,
  A5_VOICE_PROFILE_KIND,
  type A5ArcPositionDraft,
  type A5BaseDraft,
  type A5Confidence,
  type A5Context,
  type A5CounterpartDraft,
  type A5FailureCode,
  type A5ModelCaller,
  type A5VoiceDraft,
  type A5VoiceRequest,
  type CharacterVoiceEvidence,
} from "./types.js";
export {
  arcPositionClaimId,
  baseRegisterClaimId,
  counterpartClaimId,
  voiceProfileObjectId,
} from "./ids.js";
export {
  a5Caller,
  characterIndex,
  counterpartIds,
  readCharacterVoiceEvidence,
} from "./characters.js";
export {
  characterRouteIds,
  occurrenceWindow,
  routeUniverse,
  unitVisibleOnRoute,
  unitVisibleUnderScope,
} from "./windows.js";
export { assembleVoiceProfile } from "./assemble.js";
export {
  SPECIFICITY_ORDER,
  addressForUnit,
  compileVoiceProfile,
  resolveVoice,
  voiceSpecificity,
  type CompiledBase,
  type CompiledVoiceProfile,
  type ResolvedVoice,
  type VoiceLookupAddress,
  type VoiceSpecificityDescriptor,
  type VoiceTier,
} from "./lookup.js";
export {
  assertCertifiedRoute,
  buildA5CallSpec,
  dispatchA5,
  dispatchingA5Caller,
} from "./dispatch.js";
export { voiceProfileRoster, type A5RosterResult, type A5VoiceResult } from "./profiles.js";
