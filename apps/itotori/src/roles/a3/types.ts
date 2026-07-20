// A3 Scene Analyst — the domain types for the progressive story-so-far fold.
//
// A3 is the `analyst` casting that reads one COMPLETE scene and folds the prior
// accepted story-so-far forward into a cited scene-summary and an updated
// story-so-far, both in the SOURCE LANGUAGE. Everything a model MAY reason over
// is carried here as untrusted narrative; everything the decode already fixed —
// message/choice counts, the speaker set, the scene id, play order — is carried
// as an INDEX-DERIVED fact the module stamps itself. The model never re-counts a
// line and never re-attributes a speaker: those come from the deterministic fact
// snapshot, and a citation that leaves the visible snapshot is rejected.

import type {
  ContextScopeValue,
  RouteScope,
  RunModeValue,
  UnitFact,
} from "../../contracts/index.js";
import type { SceneFactCard } from "../../prepass/index.js";

/** The A3 role id — the sole role this module configures. */
export const A3_ROLE_ID = "A3" as const;

/** The kinds A3 authors: a per-scene summary and the running story-so-far. */
export const A3_SCENE_SUMMARY_KIND = "scene-summary" as const;
export const A3_STORY_SO_FAR_KIND = "story-so-far" as const;

/** Each distinct way A3 refuses to proceed. Every code is a loud failure, never
 * a silent degradation: the proof suite falsifies each guarantee independently. */
export type A3FailureCode =
  | "unknown-scene"
  | "empty-scene"
  | "incomplete-scene"
  | "fragment-scene"
  | "empty-dispatch-order"
  | "dispatch-failed";

/** A loud, typed A3 failure. */
export class A3RoleError extends Error {
  constructor(
    readonly code: A3FailureCode,
    detail: string,
  ) {
    super(`A3 ${code}: ${detail}`);
    this.name = "A3RoleError";
  }
}

/** The run-scoped constants the module stamps into every emitted object: how the
 * run is dispositioned and which route(s) the analyst is permitted to read. */
export interface A3Context {
  readonly runMode: RunModeValue;
  readonly contextScope: ContextScopeValue;
  readonly routeVisibility: RouteScope;
  readonly localeBranchId: string | null;
}

/** One COMPLETE scene, read through the read-tools and proven complete against
 * the deterministic scene fact card. `units` is the full ordered stream (never a
 * planner fragment); `factCard`, `speakerLabels`, and `characterIds` are all
 * INDEX-DERIVED and are the only source of counts/speakers the module trusts. */
export interface CompleteScene {
  readonly sceneId: string;
  readonly units: readonly UnitFact[];
  readonly factCard: SceneFactCard;
  readonly scope: RouteScope;
  /** Distinct reveal-safe speaker labels present in the scene, from the decoded
   * speaker projection — never a model attribution. */
  readonly speakerLabels: readonly string[];
  /** Canonical decode character ids present in the scene (from the fact card). */
  readonly characterIds: readonly string[];
}

/** One scene unit paired with the SHORT, copy-reliable citation label the model
 * cites it by. */
export interface CiteableSceneUnit {
  /** The short label the prompt shows and the model must echo (`u1`, `u2`, …). */
  readonly label: string;
  /** The real snapshot fact id the label binds back to. */
  readonly factId: string;
  /** The decoded unit, for the prompt's per-line rendering. */
  readonly unit: UnitFact;
}

/** Assign each unit of a complete scene a short, scene-local label (`u1`, `u2`,
 * …) the flash model can copy verbatim — never the large GLOBAL play-order index
 * it routinely mis-transcribes. Both the prompt render and the fold's
 * label→fact-id map derive from THIS function, so they can never disagree and a
 * label the model echoes always resolves. */
export function citeableSceneUnits(scene: CompleteScene): readonly CiteableSceneUnit[] {
  return scene.units.map((unit, index) => ({ label: `u${index + 1}`, factId: unit.factId, unit }));
}

/** The story-so-far body the fold threads forward (source-language prose plus
 * the deterministic scene id it runs through). */
export interface StorySoFarState {
  readonly throughSceneId: string;
  readonly summary: string;
  readonly openThreads: readonly string[];
}

/** One claim the MODEL proposes: a source-language statement plus the bracketed
 * play-order labels it cites. The module resolves each label through the current
 * scene's units to a real fact id, then resolves it against the snapshot evidence
 * index — the model never supplies a hash, subject, or play order, and a label
 * outside the current scene makes the whole object fail claim validation. */
export interface A3ClaimDraft {
  readonly statement: string;
  readonly kind: "beat" | "subtext" | "story-so-far";
  readonly confidence: "low" | "medium" | "high";
  readonly evidenceUnitIds: readonly string[];
}

/** The model's UNTRUSTED proposal for one folded scene. The narrative prose and
 * claim statements are the model's reasoning; `assertedMessageCount` and
 * `assertedSpeakerLabels` model the re-count / re-attribution a naive model
 * might emit — the module structurally ignores them and uses the index instead. */
export interface A3SceneNarrative {
  readonly beat: string;
  readonly subtext: string;
  readonly sceneOpenThreads: readonly string[];
  readonly sceneClaims: readonly A3ClaimDraft[];
  readonly storySummary: string;
  readonly storyOpenThreads: readonly string[];
  readonly storyClaims: readonly A3ClaimDraft[];
  /** The model's (ignored) re-count of the scene's messages. */
  readonly assertedMessageCount?: number;
  /** The model's (ignored) re-attribution of the scene's speakers. */
  readonly assertedSpeakerLabels?: readonly string[];
}

/** The deterministic manifest the model boundary reasons over for one scene: the
 * complete scene, the prior accepted story-so-far (null for the route's first
 * scene), and the source language. */
export interface A3SceneRequest {
  readonly scene: CompleteScene;
  readonly priorStory: StorySoFarState | null;
  readonly sourceLanguage: string;
}

/** The model-calling boundary. In production this dispatches deepseek-v4-flash
 * through the sole ZDR dispatch boundary; in offline proofs a recorded responder
 * returns a fixed narrative so the fold is deterministic. */
export type A3ModelCaller = (request: A3SceneRequest) => Promise<A3SceneNarrative>;
