// A4 Continuity and Lore Reconciler — the self-contained role module.
//
// The `analyst` casting that ADOPTS the final progressive story-so-far as the
// route spine and reconciles continuity over the deterministic topology,
// dispatching deepseek-v4-flash through the sole ZDR boundary. It emits route-
// arc, callback, foreshadow, and relationship-delta claims with paired
// resolvable endpoints and a deterministic reveal order; origins precede
// callbacks, decode facts settle contradicting timelines, and unknown edges stay
// explicit. It consumes the roster, the read-tool fact snapshot, and claim
// validation READ-ONLY, imports nothing from the legacy agents tree, and owns a
// private barrel a sibling role never edits.

export {
  A4RoleError,
  A4_ROLE_ID,
  A4_ROUTE_ARC_KIND,
  type A4ArcDraft,
  type A4Context,
  type A4DeltaDraft,
  type A4EdgeGap,
  type A4FailureCode,
  type A4LinkDraft,
  type A4ModelCaller,
  type A4ReconcileRequest,
  type A4RouteSpine,
  type A4UnresolvedEdge,
} from "./types.js";
export { adoptSpine, routeIdOf, ROUTE_ARC_KIND, type AdoptedSpine } from "./spine.js";
export {
  assembleRouteArc,
  revealOrderFor,
  type ResolvedArc,
  type ResolvedDelta,
  type ResolvedLink,
  type RouteArcSpineDependency,
} from "./assemble.js";
export { reconcileRoute, type A4RouteResult } from "./reconcile.js";
export { buildA4CallSpec, dispatchA4, dispatchingA4Caller } from "./dispatch.js";
