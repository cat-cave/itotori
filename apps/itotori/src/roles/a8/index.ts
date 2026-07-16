// A8 Relationships and Background Analyst — the self-contained role module.
//
// The `analyst` casting that authors ONE cited source-language character-
// background for EVERY character in the deterministic index, dispatching
// deepseek-v4-flash through the sole ZDR boundary. Each background relates the
// character to REAL counterparts with claim-level global/route/route-set scope,
// and every relationship cites an ESTABLISHING same-game scene whose route
// reachability validates the scope. It consumes the upstream bio and story
// evidence through the LOCAL read tools only — it holds no web-egress grant — and
// binds every caller-supplied input to its authoritative artifact before use. It
// imports nothing from the legacy agents tree and owns a private barrel a sibling
// role never edits.

export {
  A8RoleError,
  A8_CHARACTER_BACKGROUND_KIND,
  A8_ROLE_ID,
  CONSUMED_BIO_KIND,
  type A8BackgroundDraft,
  type A8BackgroundRequest,
  type A8Context,
  type A8FailureCode,
  type A8ModelCaller,
  type A8RelationshipDraft,
  type CharacterEvidence,
} from "./types.js";
export {
  backgroundObjectId,
  presenceClaimId,
  relationshipClaimId,
  sceneEvidenceId,
} from "./ids.js";
export { a8Caller, characterIndex, counterpartIds, readCharacterEvidence } from "./characters.js";
export { verifyBioProvenance } from "./provenance.js";
export {
  buildSceneReachabilityIndex,
  reachableRoutes,
  resolveRelationshipScope,
  type SceneReachability,
  type SceneReachabilityIndex,
} from "./scenes.js";
export { assembleCharacterBackground } from "./assemble.js";
export {
  assertCertifiedRoute,
  buildA8CallSpec,
  dispatchA8,
  dispatchingA8Caller,
} from "./dispatch.js";
export {
  backgroundRoster,
  type A8BackgroundResult,
  type A8BioProvider,
  type A8RosterResult,
} from "./background.js";
