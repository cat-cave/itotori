// A10 Hindsight Speaker Resolver — the self-contained role module.
//
// The `analyst` casting that examines EVERY genuinely-unknown-speaker unit
// (`parser-unknown` or `reader-unknown`) against whole-game hindsight and emits
// ONE cited, PROVISIONAL speaker-hypothesis per unit, dispatching deepseek-v4-flash
// through the sole ZDR boundary. It consumes the decoded unit set, character
// index, and route graph READ-ONLY; imports nothing from the legacy agents tree;
// and owns a private barrel a sibling role never edits. A10 REFUSES known
// speakers, is STRUCTURALLY unable to write the decoded speaker fact (it can only
// author a candidate hypothesis), and a later decode resolution INVALIDATES its
// hypothesis rather than merging into it.

export {
  A10RoleError,
  A10_ROLE_ID,
  A10_SPEAKER_HYPOTHESIS_KIND,
  type A10Context,
  type A10FailureCode,
  type A10HypothesisDraft,
  type A10HypothesisRequest,
  type A10ModelCaller,
  type DecodeResolution,
  type HypothesisInvalidation,
  type UnknownSpeakerStatus,
  type UnknownSpeakerUnit,
} from "./types.js";
export { hypothesisClaimId, hypothesisObjectId } from "./ids.js";
export {
  a10Caller,
  classifySpeaker,
  hindsightCandidateIds,
  hindsightRevealSceneIds,
  readAllUnitFacts,
  readUnknownSpeakerUnits,
  toUnknownSpeakerUnit,
  verifyCandidateCharacter,
  verifyRevealScene,
} from "./units.js";
export { assembleSpeakerHypothesis } from "./assemble.js";
export { invalidateOnDecodeResolution } from "./invalidate.js";
export {
  assertA10CertifiedRoute,
  buildA10CallSpec,
  dispatchA10,
  dispatchingA10Caller,
} from "./dispatch.js";
export { resolveSpeakers, type A10HypothesisResult, type A10ResolveResult } from "./resolve.js";
