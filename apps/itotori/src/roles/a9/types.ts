// A9 Character-in-Route Arc Analyst — the domain types.
//
// A9 is the `analyst` casting that fans out over EVERY deterministic character-
// by-route intersection and authors ONE source-language `character-route-arc`
// object per intersection pair. Each arc carries the character's STATE SHIFTS
// within that route; every shift's from/to play-order range and every membership
// fact is DECODE-derived — the model proposes prose and cites which units bound a
// shift, and the module stamps the chronology from those units' decoded play
// order. The pair set the module fans out over is the decoded occurrence/route
// intersection EXACTLY: a minor character is never silently skipped, and a pair
// the decode does not carry can never be authored. A9 consumes the deterministic
// fact snapshot through the LOCAL read-tool surface only; it holds no web-egress
// grant, imports nothing from the legacy agents tree, and owns a private barrel a
// sibling role never edits.

import type { ContextScopeValue, RouteScope, RunModeValue } from "../../contracts/index.js";

/** The A9 role id — the sole role this module configures. */
export const A9_ROLE_ID = "A9" as const;

/** The single WikiObject kind A9 authors. */
export const A9_CHARACTER_ROUTE_ARC_KIND = "character-route-arc" as const;

/** Each distinct way A9 refuses to proceed. Every code is a loud failure, never
 * a silent degradation: the proof suite falsifies each guarantee independently. */
export type A9FailureCode =
  | "empty-character-index"
  | "unknown-character"
  | "no-evidence"
  | "pair-not-in-intersection"
  | "empty-shift-window"
  | "unknown-shift-evidence"
  | "reversed-shift"
  | "degenerate-shift"
  | "coverage-gap"
  | "route-not-certified"
  | "dispatch-failed";

/** A loud, typed A9 failure. */
export class A9RoleError extends Error {
  constructor(
    readonly code: A9FailureCode,
    detail: string,
  ) {
    super(`A9 ${code}: ${detail}`);
    this.name = "A9RoleError";
  }
}

/** The run-scoped constants the module stamps into every emitted object. */
export interface A9Context {
  readonly runMode: RunModeValue;
  readonly contextScope: ContextScopeValue;
  readonly routeVisibility: RouteScope;
  readonly localeBranchId: string | null;
}

/** One (character, route) pair of the deterministic intersection. Both fields are
 * decode-derived — never a model attribution: the character is an index entry and
 * the route is a scope some occurrence unit carries. */
export interface CharacterRoutePair {
  readonly characterId: string;
  readonly routeId: string;
}

/** The deterministic, route-scoped evidence for one intersection pair, read
 * through the strict tool surface. `occurrenceFactId` and `sceneIds` are INDEX-
 * DERIVED — the model never supplies them — and the route is a concrete decoded
 * route the character occurs on. */
export interface CharacterRouteEvidence {
  readonly characterId: string;
  /** The decoded, reveal-safe label — a same-game fact, never a model claim. */
  readonly decodedLabel: string;
  /** The character-occurrence evidence fact id, citeable as route presence. */
  readonly occurrenceFactId: string;
  /** The scenes the character occurs in (decode play-order topology). */
  readonly sceneIds: readonly number[];
  /** The concrete route this arc is scoped to. */
  readonly routeId: string;
  /** The route scope every claim on this arc is stamped with. */
  readonly scope: RouteScope;
}

/** One state shift the MODEL proposes: a source-language before/after description
 * and the two occurrence-unit evidence ids that BOUND the change. The timeline is
 * NOT trusted from the model — `assertedFromPlayOrder` / `assertedToPlayOrder`
 * model the re-timing a naive model might emit, and the module stamps the
 * chronology from the cited units' decoded play order. */
export interface A9ShiftDraft {
  readonly stateBefore: string;
  readonly stateAfter: string;
  readonly fromEvidenceId: string;
  readonly toEvidenceId: string;
  readonly confidence?: "low" | "medium" | "high";
  /** The model's (ignored) re-timing of the shift's start. */
  readonly assertedFromPlayOrder?: number;
  /** The model's (ignored) re-timing of the shift's end. */
  readonly assertedToPlayOrder?: number;
}

/** The model's UNTRUSTED proposal for one character-route arc. The shift prose is
 * the model's reasoning; every bounding unit is re-resolved against the decode
 * occurrence window and every play-order range re-stamped before acceptance. */
export interface A9ArcDraft {
  readonly shifts: readonly A9ShiftDraft[];
}

/** The deterministic manifest the model boundary reasons over for one pair: the
 * route-scoped evidence, the ordered occurrence-unit window it may cite, and the
 * source language. */
export interface A9ArcRequest {
  readonly evidence: CharacterRouteEvidence;
  /** The occurrence-unit evidence ids the model may cite as shift endpoints, in
   * decoded play order. Real, route-visible units only — never a model list. */
  readonly windowUnitIds: readonly string[];
  readonly sourceLanguage: string;
}

/** The model-calling boundary. In production this dispatches deepseek-v4-flash
 * through the sole ZDR dispatch boundary; in offline proofs a recorded responder
 * returns a fixed arc so the assembly is deterministic. */
export type A9ModelCaller = (request: A9ArcRequest) => Promise<A9ArcDraft>;
