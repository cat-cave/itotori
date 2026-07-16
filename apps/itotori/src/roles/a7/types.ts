// A7 Character Biographer — the domain types for the whole-game character bios.
//
// A7 is the `analyst` casting that authors ONE source-language character bio for
// EVERY character the deterministic character index carries — none skipped. Each
// bio carries a portrait media reference and claims whose whole-game evidence is
// re-derived from the immutable snapshot, never trusted from the model. A7 is
// also the sole role the web-egress boundary permits, so its optional web claims
// are modeled here as a strictly separate channel that can never override an
// authoritative same-game fact.
//
// Everything the model MAY reason over is carried as an untrusted draft;
// everything the decode already fixed — the character set, the occurrence fact
// id, the whole-game unit ids a character speaks in, the label — is carried as
// an index-derived fact the module stamps itself.

import type { ContextScopeValue, RouteScope, RunModeValue } from "../../contracts/index.js";

/** The A7 role id — the sole role this module configures. */
export const A7_ROLE_ID = "A7" as const;

/** The single WikiObject kind A7 authors. */
export const A7_CHARACTER_BIO_KIND = "character-bio" as const;

/** Each distinct way A7 refuses to proceed. Every code is a loud failure, never
 * a silent degradation: the proof suite falsifies each guarantee independently. */
export type A7FailureCode =
  | "empty-character-index"
  | "unknown-character"
  | "no-evidence"
  | "degenerate-bio"
  | "coverage-gap"
  | "dispatch-failed";

/** A loud, typed A7 failure. */
export class A7RoleError extends Error {
  constructor(
    readonly code: A7FailureCode,
    detail: string,
  ) {
    super(`A7 ${code}: ${detail}`);
    this.name = "A7RoleError";
  }
}

/** The run-scoped constants the module stamps into every emitted object. */
export interface A7Context {
  readonly runMode: RunModeValue;
  readonly contextScope: ContextScopeValue;
  readonly routeVisibility: RouteScope;
  readonly localeBranchId: string | null;
}

/** The deterministic, whole-game evidence for one character, read through the
 * strict tool surface. `occurrenceFactId` and `notableUnitIds` are INDEX-DERIVED
 * — the model never supplies a fact id, a hash, or a play order, and a cited id
 * outside this set fails claim validation. */
export interface CharacterEvidence {
  readonly characterId: string;
  /** The decoded, reveal-safe label — a same-game fact, never a model claim. */
  readonly decodedLabel: string;
  /** The character-occurrence evidence fact id, citeable as whole-game presence. */
  readonly occurrenceFactId: string;
  /** Every unit id the character speaks in across the whole game. */
  readonly notableUnitIds: readonly string[];
  /** The route scope every emitted claim is stamped with (whole-game = global). */
  readonly scope: RouteScope;
}

/** One claim the MODEL proposes: a source-language statement plus the evidence
 * ids it cites. The module resolves each cited id against the snapshot evidence
 * index — the model never supplies a hash, subject, or play order. */
export interface A7ClaimDraft {
  readonly statement: string;
  readonly confidence: "low" | "medium" | "high";
  readonly evidenceIds: readonly string[];
}

/** The model's UNTRUSTED proposal for one character bio. The prose, traits, and
 * claim statements are the model's reasoning; the notable-moment ids are the
 * model's SELECTION over the whole-game unit set (the module intersects them
 * with the index, so a fabricated id can never reach a body field). */
export interface A7BioDraft {
  readonly storyRole: string;
  readonly definingTraits: readonly string[];
  readonly notableMomentEvidenceIds: readonly string[];
  readonly claims: readonly A7ClaimDraft[];
}

/** The deterministic manifest the model boundary reasons over for one character:
 * the whole-game evidence, the source language, and whether the operator has
 * opened the web-egress boundary for this run. */
export interface A7CharacterRequest {
  readonly character: CharacterEvidence;
  readonly sourceLanguage: string;
  readonly webEnabled: boolean;
}

/** The model-calling boundary. In production this dispatches deepseek-v4-flash
 * through the sole ZDR dispatch boundary; in offline proofs a recorded responder
 * returns a fixed draft so the assembly is deterministic. */
export type A7ModelCaller = (request: A7CharacterRequest) => Promise<A7BioDraft>;
