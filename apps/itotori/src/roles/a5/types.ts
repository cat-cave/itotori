// A5 Granular Voice Director — the domain types.
//
// A5 is the `analyst` casting that authors ONE source-language `voice-profile`
// object for every character in the deterministic index. A profile is addressable
// by CHARACTER (its base register), by COUNTERPART/relationship (how the character
// addresses a real counterpart), by ROUTE (each rule's route scope), and by an
// ARC-POSITION RANGE (a register shift over a decoded play-order window). The
// model proposes the prose — base register, address forms, register deltas, arc
// notes — and cites which decoded occurrence units back each rule; the module
// re-resolves every counterpart, every cited unit, and every play-order range
// against the decode, so nothing the addressing turns on is trusted from the
// model. A5 consumes the fact snapshot through the LOCAL read-tool surface only;
// it holds no web-egress grant, imports nothing from the legacy agents tree, and
// owns a private barrel a sibling role never edits.

import type { ContextScopeValue, RouteScope, RunModeValue } from "../../contracts/index.js";

/** The A5 role id — the sole role this module configures. */
export const A5_ROLE_ID = "A5" as const;

/** The single WikiObject kind A5 authors. */
export const A5_VOICE_PROFILE_KIND = "voice-profile" as const;

/** Each distinct way A5 refuses to proceed. Every code is a loud failure, never
 * a silent degradation: the proof suite falsifies each guarantee independently. */
export type A5FailureCode =
  | "empty-character-index"
  | "unknown-character"
  | "no-evidence"
  | "degenerate-base"
  | "unknown-counterpart"
  | "self-counterpart"
  | "degenerate-counterpart"
  | "unknown-voice-evidence"
  | "reversed-arc"
  | "degenerate-arc"
  | "coverage-gap"
  | "route-not-certified"
  | "dispatch-failed";

/** A loud, typed A5 failure. */
export class A5RoleError extends Error {
  constructor(
    readonly code: A5FailureCode,
    detail: string,
  ) {
    super(`A5 ${code}: ${detail}`);
    this.name = "A5RoleError";
  }
}

/** The run-scoped constants the module stamps into every emitted object. */
export interface A5Context {
  readonly runMode: RunModeValue;
  readonly contextScope: ContextScopeValue;
  readonly routeVisibility: RouteScope;
  readonly localeBranchId: string | null;
}

/** The deterministic, whole-game evidence for one character, read through the
 * strict tool surface. `occurrenceFactId` is INDEX-DERIVED — the model never
 * supplies a fact id — and a cited id outside the snapshot fails validation. */
export interface CharacterVoiceEvidence {
  readonly characterId: string;
  /** The decoded, reveal-safe label — a same-game fact, never a model claim. */
  readonly decodedLabel: string;
  /** The character-occurrence evidence fact id, citeable as whole-game presence. */
  readonly occurrenceFactId: string;
  /** The scenes the character occurs in (decode play-order topology). */
  readonly sceneIds: readonly string[];
  /** The whole-game scope the base register claim is stamped with (global). */
  readonly scope: RouteScope;
}

/** Optional model confidence for one rule; the module defaults it when absent. */
export type A5Confidence = "low" | "medium" | "high";

/** The base register the MODEL proposes for a character: the least-specific
 * (per-character) slice every dialogue unit falls back to. */
export interface A5BaseDraft {
  readonly pronoun: string;
  readonly register: string;
  readonly tics: readonly string[];
  readonly confidence?: A5Confidence;
}

/** One per-counterpart rule the MODEL proposes: how the character addresses a REAL
 * counterpart, under a route scope, cited by one decoded occurrence unit. The
 * counterpart id and the cited unit are re-resolved against the decode. */
export interface A5CounterpartDraft {
  readonly counterpartId: string;
  readonly addressForm: string;
  readonly registerDelta: string;
  readonly scope: RouteScope;
  readonly evidenceId: string;
  readonly confidence?: A5Confidence;
}

/** One per-arc-position rule the MODEL proposes: a register SHIFT over a play-
 * order window bounded by two decoded occurrence units, under a route scope. The
 * play-order range is NOT trusted from the model — `assertedFromPlayOrder` /
 * `assertedToPlayOrder` model the re-timing a naive model might emit, and the
 * module stamps the range from the cited units' decoded play order. */
export interface A5ArcPositionDraft {
  readonly scope: RouteScope;
  readonly register: string;
  readonly note: string;
  readonly fromEvidenceId: string;
  readonly toEvidenceId: string;
  readonly confidence?: A5Confidence;
  /** The model's (ignored) re-timing of the shift's start. */
  readonly assertedFromPlayOrder?: number;
  /** The model's (ignored) re-timing of the shift's end. */
  readonly assertedToPlayOrder?: number;
}

/** The model's UNTRUSTED proposal for one character's voice profile. */
export interface A5VoiceDraft {
  readonly base: A5BaseDraft;
  readonly counterparts: readonly A5CounterpartDraft[];
  readonly arcPositions: readonly A5ArcPositionDraft[];
}

/** The deterministic manifest the model boundary reasons over for one character:
 * the whole-game evidence, the real counterpart id set it may address, the routes
 * the character occurs on, its ordered occurrence-unit window, and the source
 * language. Only real, decode-derived ids ever enter this manifest. */
export interface A5VoiceRequest {
  readonly evidence: CharacterVoiceEvidence;
  readonly counterpartIds: readonly string[];
  readonly routeIds: readonly string[];
  /** The character's occurrence-unit ids, in decoded play order — the ONLY units
   * a counterpart or arc rule may cite. */
  readonly occurrenceUnitIds: readonly string[];
  readonly sourceLanguage: string;
}

/** The model-calling boundary. In production this dispatches deepseek-v4-flash
 * through the sole ZDR dispatch boundary; in offline proofs a recorded responder
 * returns a fixed draft so the assembly is deterministic. */
export type A5ModelCaller = (request: A5VoiceRequest) => Promise<A5VoiceDraft>;
