// A7 Character Biographer — the self-contained role module.
//
// The `analyst` casting that authors ONE cited, portrait-bearing source-language
// bio for EVERY character in the deterministic index — none skipped — dispatching
// deepseek-v4-flash through the sole ZDR boundary. It consumes the character
// index, the read-tool fact surface, the media index, claim validation, and the
// web-egress boundary READ-ONLY, imports nothing from the legacy agents tree, and
// owns a private barrel a sibling role never edits. A7 is the sole role the
// web-egress boundary permits; its web claims are a separate, dominated channel.

export {
  A7RoleError,
  A7_CHARACTER_BIO_KIND,
  A7_ROLE_ID,
  type A7BioDraft,
  type A7CharacterRequest,
  type A7ClaimDraft,
  type A7Context,
  type A7FailureCode,
  type A7ModelCaller,
  type CharacterEvidence,
} from "./types.js";
export { bioObjectId, modelClaimId, portraitMediaId, presenceClaimId } from "./ids.js";
export { a7Caller, characterIndex, readCharacterEvidence } from "./characters.js";
export {
  buildCharacterPortrait,
  type A7PortraitProvider,
  type A7PortraitSource,
} from "./portrait.js";
export { assembleCharacterBio } from "./assemble.js";
export {
  A7_LOCAL_ONLY,
  a7WebEnabled,
  buildA7WebSearchTool,
  reconcileCharacterWeb,
  sameGameCharacterFacts,
  type A7WebContext,
} from "./web.js";
export { buildA7CallSpec, dispatchA7, dispatchingA7Caller } from "./dispatch.js";
export {
  biographRoster,
  type A7BiographOptions,
  type A7BioResult,
  type A7RosterResult,
} from "./biograph.js";
