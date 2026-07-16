// A9 Character-in-Route Arc Analyst — the self-contained role module.
//
// The `analyst` casting that fans out over EVERY deterministic character-by-route
// intersection and authors ONE cited source-language character-route-arc per
// pair, dispatching deepseek-v4-flash through the sole ZDR boundary. The pair set
// EQUALS the decoded occurrence/route intersection exactly — a minor character is
// never silently skipped, a fabricated pair is never authored — and every arc is
// route-scoped, carrying state shifts whose from/to play-order ranges are stamped
// from the decode, not the model, with resolving citations. It consumes the fact
// snapshot through the LOCAL read tools only — it holds no web-egress grant — and
// binds every caller-supplied pair to the deterministic intersection before use.
// It imports nothing from the legacy agents tree and owns a private barrel a
// sibling role never edits.

export {
  A9RoleError,
  A9_CHARACTER_ROUTE_ARC_KIND,
  A9_ROLE_ID,
  type A9ArcDraft,
  type A9ArcRequest,
  type A9Context,
  type A9FailureCode,
  type A9ModelCaller,
  type A9ShiftDraft,
  type CharacterRouteEvidence,
  type CharacterRoutePair,
} from "./types.js";
export { presenceClaimId, routeArcObjectId, shiftClaimId } from "./ids.js";
export {
  characterRouteIntersection,
  characterRoutes,
  pairInIntersection,
  routeOccurrenceWindow,
  routeUniverse,
  visibleOnRoute,
} from "./intersection.js";
export { a9Caller, characterIndex, readCharacterRouteEvidence } from "./characters.js";
export { assembleCharacterRouteArc } from "./assemble.js";
export {
  assertCertifiedRoute,
  buildA9CallSpec,
  dispatchA9,
  dispatchingA9Caller,
} from "./dispatch.js";
export { routeArcRoster, type A9ArcResult, type A9RosterResult } from "./arcs.js";
