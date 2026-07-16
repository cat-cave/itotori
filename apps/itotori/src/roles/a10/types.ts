// A10 Hindsight Speaker Resolver — the domain types for speaker HYPOTHESES.
//
// A10 is the `analyst` casting that examines the genuinely-unknown-speaker units
// the decode could not attribute — every unit whose reveal-safe speaker truth is
// `parser-unknown` or `reader-unknown` — against whole-game hindsight, and emits
// ONE cited speaker-HYPOTHESIS WikiObject per such unit. It NEVER touches a unit
// whose speaker the decode already fixed (a `known` speaker is refused), and it
// is STRUCTURALLY UNABLE to write the decoded speaker fact: the only object it
// can emit is a provisional `speaker-hypothesis` carrying a CANDIDATE character
// id and a confidence — there is no field, and no code path, by which A10 could
// assert the authoritative decoded speaker (that truth lives on the immutable
// decode fact, which A10 has no write path to).
//
// Everything the MODEL proposes — the candidate character, the confidence, the
// reveal scene, the rationale — is carried as an untrusted draft. Everything the
// decode already fixed — which units are unknown, the reveal-safe label, the
// unit's route scope, the citeable evidence ids — is index-derived and stamped by
// the module itself.

import type {
  ContextScopeValue,
  RouteScope,
  RunModeValue,
  SpeakerTruth,
} from "../../contracts/index.js";

/** The A10 role id — the sole role this module configures. */
export const A10_ROLE_ID = "A10" as const;

/** The single WikiObject kind A10 authors. A10 emits ONLY this kind: a
 * provisional hypothesis, never a decoded speaker fact. */
export const A10_SPEAKER_HYPOTHESIS_KIND = "speaker-hypothesis" as const;

/** Each distinct way A10 refuses to proceed. Every code is a loud failure, never
 * a silent degradation: the proof suite falsifies each guarantee independently. */
export type A10FailureCode =
  | "known-speaker" // asked to hypothesize a unit the decode already resolved
  | "no-speaker" // the unit carries no speaker context (narration/choice)
  | "unknown-candidate" // the model proposed a character absent from the index
  | "unknown-reveal-scene" // the model proposed a reveal scene absent from the graph
  | "resolution-mismatch" // a decode resolution targets a different unit
  | "unresolved-decode" // a claimed decode resolution is not a genuine known speaker
  | "coverage-gap" // fewer hypotheses than genuinely-unknown units
  | "dispatch-failed";

/** A loud, typed A10 failure. */
export class A10RoleError extends Error {
  constructor(
    readonly code: A10FailureCode,
    detail: string,
  ) {
    super(`A10 ${code}: ${detail}`);
    this.name = "A10RoleError";
  }
}

/** The run-scoped constants the module stamps into every emitted object. */
export interface A10Context {
  readonly runMode: RunModeValue;
  readonly contextScope: ContextScopeValue;
  readonly routeVisibility: RouteScope;
  readonly localeBranchId: string | null;
}

/** The two reveal-safe speaker truths A10 is allowed to hypothesize over. A
 * `known` speaker is never one of these — it is refused. */
export type UnknownSpeakerStatus = "parser-unknown" | "reader-unknown";

/** The deterministic, index-derived evidence for one genuinely-unknown-speaker
 * unit — read through the strict tool surface, never caller-supplied. The unit
 * id, scene, play order, reveal-safe label, and route scope are the snapshot's
 * projection; the model supplies none of them. */
export interface UnknownSpeakerUnit {
  readonly unitId: string;
  readonly sceneId: string;
  readonly playOrderIndex: number;
  readonly speakerStatus: UnknownSpeakerStatus;
  /** The reveal-safe label the decode carries for the concealed speaker. */
  readonly revealSafeLabel: string;
  /** The unit's route scope — the scope the hypothesis is stamped with. */
  readonly scope: RouteScope;
}

/** The MODEL's UNTRUSTED proposal for one unit's speaker. The candidate id, the
 * reveal scene id, and the rationale are the model's reasoning; the module
 * re-resolves the candidate and the reveal scene against the snapshot before an
 * object is assembled, so a fabricated id can never reach a hypothesis. */
export interface A10HypothesisDraft {
  readonly candidateCharacterId: string;
  readonly confidence: "low" | "medium" | "high";
  readonly revealSceneId: string;
  /** The source-language reasoning statement backing the hypothesis. */
  readonly rationale: string;
}

/** The deterministic manifest the model boundary reasons over for one unit: the
 * unknown-speaker unit, the source language, and the whole-game hindsight the
 * model may choose a candidate and a reveal scene from. The candidate/reveal
 * pools are the decode's — the model selects within them, never invents. */
export interface A10HypothesisRequest {
  readonly unit: UnknownSpeakerUnit;
  readonly sourceLanguage: string;
  readonly candidateCharacterIds: readonly string[];
  readonly revealSceneIds: readonly string[];
}

/** The model-calling boundary. In production this dispatches deepseek-v4-flash
 * through the sole ZDR dispatch boundary; in offline proofs a recorded responder
 * returns a fixed draft so assembly is deterministic. */
export type A10ModelCaller = (request: A10HypothesisRequest) => Promise<A10HypothesisDraft>;

/** A later decode resolution for a unit A10 hypothesized: the decode has now
 * fixed the speaker as a `known` truth. This is the authoritative fact that
 * INVALIDATES the earlier hypothesis. */
export interface DecodeResolution {
  readonly unitId: string;
  readonly resolvedSpeaker: Extract<SpeakerTruth, { status: "known" }>;
}

/** The outcome of a decode resolution meeting a hypothesis: the hypothesis is
 * INVALIDATED, never merged. `decodedCharacterId` is the decode's authoritative
 * attribution; `hypothesizedCandidateId` is the discarded candidate. Even when
 * they match, the hypothesis is discarded — the decoded fact stands alone. */
export interface HypothesisInvalidation {
  readonly outcome: "invalidated";
  readonly unitId: string;
  readonly invalidatedObjectId: string;
  readonly invalidatedObjectVersion: number;
  readonly decodedCharacterId: string;
  readonly hypothesizedCandidateId: string;
  /** Diagnostic only — a matching candidate is recorded, never folded into the
   * decoded fact. The outcome is `invalidated` regardless. */
  readonly candidateMatchedDecode: boolean;
}
