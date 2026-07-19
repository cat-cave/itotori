// A4 Continuity and Lore Reconciler — the domain types for route-arc reasoning.
//
// A4 is the `analyst` casting that ADOPTS the final progressive story-so-far as
// the route spine and reasons over the deterministic route/scene topology to
// emit route-arc, callback, foreshadow, and relationship-delta claims. It never
// reconstructs topology: the play order and the dispatch order are decode facts
// the module trusts, and every continuity link a model proposes is settled
// against those facts. A model may propose meaning; it may never re-derive when
// a scene plays, invent a graph edge, or reverse the chronology a decode fixed.

import type {
  ContextScopeValue,
  RouteScope,
  RunModeValue,
  WikiObject,
} from "../../contracts/index.js";

/** The A4 role id — the sole role this module configures. */
export const A4_ROLE_ID = "A4" as const;

/** The single kind A4 authors: the per-route arc reconciliation. */
export const A4_ROUTE_ARC_KIND = "route-arc" as const;

/** Each distinct way A4 refuses to proceed. Every code is a loud failure, never
 * a silent degradation: the proof suite falsifies each guarantee independently. */
export type A4FailureCode =
  | "spine-not-story-so-far"
  | "spine-topology-mismatch"
  | "spine-final-scene-mismatch"
  | "spine-without-evidence"
  | "origin-not-before-callback"
  | "dispatch-failed";

/** A loud, typed A4 failure. */
export class A4RoleError extends Error {
  constructor(
    readonly code: A4FailureCode,
    detail: string,
  ) {
    super(`A4 ${code}: ${detail}`);
    this.name = "A4RoleError";
  }
}

/** The run-scoped constants the module stamps into every emitted object: how the
 * run is dispositioned and which route(s) the analyst is permitted to read. */
export interface A4Context {
  readonly runMode: RunModeValue;
  readonly contextScope: ContextScopeValue;
  readonly routeVisibility: RouteScope;
  readonly localeBranchId: string | null;
}

/** The route spine A4 ADOPTS — the final progressive story-so-far object plus
 * the scenes it covers, both carried verbatim from the upstream scene fold. A4
 * does NOT reconstruct this: it validates the adopted coverage against the
 * deterministic dispatch order and reasons over it, never re-deriving topology. */
export interface A4RouteSpine {
  /** The final `story-so-far` WikiObject the scene fold threaded to the end. */
  readonly finalStorySoFar: WikiObject;
  /** Every scene the spine covers, in deterministic play order (the full route). */
  readonly coveredSceneIds: readonly number[];
}

/** One continuity link the MODEL proposes: a source-language description plus
 * the two endpoint unit ids it pairs (an origin and a later reference). Either
 * endpoint may be `null` when the model can only see one side — a PARTIAL edge
 * the module keeps EXPLICIT and never completes by inventing the missing id. */
export interface A4LinkDraft {
  readonly description: string;
  readonly originEvidenceId: string | null;
  readonly destinationEvidenceId: string | null;
  readonly confidence?: "low" | "medium" | "high";
  /** The model's (ignored) asserted reveal position — the module derives the
   * reveal order from deterministic play order, never from this field. */
  readonly assertedRevealOrder?: number;
}

/** One relationship delta the MODEL proposes between two characters: the before
 * / after states plus the two endpoint unit ids that bound the change. The
 * timeline is NOT trusted from the model — `assertedFromPlayOrder` /
 * `assertedToPlayOrder` model the re-timing a naive model might emit, and the
 * module stamps the chronology from the cited endpoints' decoded play order. */
export interface A4DeltaDraft {
  readonly counterpartId: string;
  readonly before: string;
  readonly after: string;
  readonly fromEvidenceId: string;
  readonly toEvidenceId: string;
  readonly confidence?: "low" | "medium" | "high";
  /** The model's (ignored) re-timing of the change's start. */
  readonly assertedFromPlayOrder?: number;
  /** The model's (ignored) re-timing of the change's end. */
  readonly assertedToPlayOrder?: number;
}

/** The model's UNTRUSTED proposal for one route's arc. The arc summary and link
 * descriptions are the model's reasoning; every endpoint id is re-resolved and
 * every timeline re-stamped against the decode before an object is accepted. */
export interface A4ArcDraft {
  readonly arcSummary: string;
  readonly callbacks: readonly A4LinkDraft[];
  readonly foreshadows: readonly A4LinkDraft[];
  readonly relationshipDeltas: readonly A4DeltaDraft[];
}

/** The deterministic manifest the model boundary reasons over for one route: the
 * adopted spine, the route scope it inherits, and the source language. */
export interface A4ReconcileRequest {
  readonly spine: A4RouteSpine;
  readonly routeScope: RouteScope;
  readonly sourceLanguage: string;
}

/** The model-calling boundary. In production this dispatches deepseek-v4-flash
 * through the sole ZDR dispatch boundary; in offline proofs a recorded responder
 * returns a fixed arc so the reconciliation is deterministic. */
export type A4ModelCaller = (request: A4ReconcileRequest) => Promise<A4ArcDraft>;

/** Why a proposed continuity edge could NOT be emitted as a paired arc link. It
 * is surfaced here EXPLICITLY — never fabricated into a resolved pair. */
export type A4EdgeGap = "missing-endpoint" | "unresolvable-endpoint";

/** One proposed edge the module declined to resolve, kept explicit so downstream
 * sees an honest unknown rather than an invented pair. A `null` endpoint is a
 * side the model never supplied; the module does not fill it in. */
export interface A4UnresolvedEdge {
  readonly linkKind: "callback" | "foreshadow";
  readonly description: string;
  readonly originEvidenceId: string | null;
  readonly destinationEvidenceId: string | null;
  readonly gap: A4EdgeGap;
}
