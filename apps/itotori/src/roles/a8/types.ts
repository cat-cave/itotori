// A8 Relationships and Background Analyst — the domain types.
//
// A8 is the `analyst` casting that authors ONE source-language character-
// background object for every character in the deterministic index. Each
// background carries relationships to REAL counterpart characters, and every
// relationship is scoped (global / route / route-set) and cites an ESTABLISHING
// same-game scene — a real scene where the relationship is established, whose
// route reachability validates the relationship's scope. A8 consumes the
// upstream character biography plus story evidence through the LOCAL read-tool
// surface only; it holds no web-egress grant. Everything the model MAY reason
// over is carried as an untrusted draft; everything the decode already fixed —
// the character set, the occurrence fact id, the scene topology and its
// reachability — is an index-derived fact the module stamps itself.

import type {
  ContextScopeValue,
  RouteScope,
  RunModeValue,
  WikiObject,
} from "../../contracts/index.js";

/** The A8 role id — the sole role this module configures. */
export const A8_ROLE_ID = "A8" as const;

/** The single WikiObject kind A8 authors. */
export const A8_CHARACTER_BACKGROUND_KIND = "character-background" as const;

/** The bio kind A8 consumes as a verified upstream input. */
export const CONSUMED_BIO_KIND = "character-bio" as const;

/** Each distinct way A8 refuses to proceed. Every code is a loud failure, never
 * a silent degradation: the proof suite falsifies each guarantee independently. */
export type A8FailureCode =
  | "empty-character-index"
  | "unknown-character"
  | "no-evidence"
  | "unverified-bio"
  | "unknown-counterpart"
  | "unknown-establishing-scene"
  | "missing-establishing-scene"
  | "unreachable-scene"
  | "out-of-route-scene"
  | "unreachable-scope"
  | "degenerate-background"
  | "coverage-gap"
  | "route-not-certified"
  | "dispatch-failed";

/** A loud, typed A8 failure. */
export class A8RoleError extends Error {
  constructor(
    readonly code: A8FailureCode,
    detail: string,
  ) {
    super(`A8 ${code}: ${detail}`);
    this.name = "A8RoleError";
  }
}

/** The run-scoped constants the module stamps into every emitted object. */
export interface A8Context {
  readonly runMode: RunModeValue;
  readonly contextScope: ContextScopeValue;
  readonly routeVisibility: RouteScope;
  readonly localeBranchId: string | null;
}

/** The deterministic, whole-game evidence for one character, read through the
 * strict tool surface. `occurrenceFactId` is INDEX-DERIVED — the model never
 * supplies a fact id — and a cited id outside the snapshot fails validation. */
export interface CharacterEvidence {
  readonly characterId: string;
  /** The decoded, reveal-safe label — a same-game fact, never a model claim. */
  readonly decodedLabel: string;
  /** The character-occurrence evidence fact id, citeable as whole-game presence. */
  readonly occurrenceFactId: string;
  /** The route scope the whole-game background is stamped with (global). */
  readonly scope: RouteScope;
}

/** One relationship the MODEL proposes: a source-language description of the tie
 * to a counterpart character, the claim-level scope it holds under, and the
 * establishing-scene evidence ids the model cites. The module resolves every
 * counterpart and every scene against the snapshot — the model supplies no hash,
 * no reachability, and no route membership. */
export interface A8RelationshipDraft {
  readonly counterpartId: string;
  readonly relationship: string;
  readonly confidence: "low" | "medium" | "high";
  readonly scope: RouteScope;
  readonly establishingSceneIds: readonly string[];
}

/** The model's UNTRUSTED proposal for one character background. The background
 * prose and relationship descriptions are the model's reasoning; every
 * counterpart, scene, and scope is re-derived from the decode before an object
 * is accepted. */
export interface A8BackgroundDraft {
  readonly background: string;
  readonly relationships: readonly A8RelationshipDraft[];
}

/** The deterministic manifest the model boundary reasons over for one character:
 * the whole-game evidence, the VERIFIED upstream bio it consumes, the real
 * counterpart id set it may relate to, and the source language. */
export interface A8BackgroundRequest {
  readonly character: CharacterEvidence;
  /** The upstream character-bio object, already provenance-verified. */
  readonly bio: WikiObject;
  /** The real character ids the model may name as counterparts. */
  readonly counterpartIds: readonly string[];
  readonly sourceLanguage: string;
}

/** The model-calling boundary. In production this dispatches deepseek-v4-flash
 * through the sole ZDR dispatch boundary; in offline proofs a recorded responder
 * returns a fixed draft so the assembly is deterministic. */
export type A8ModelCaller = (request: A8BackgroundRequest) => Promise<A8BackgroundDraft>;
