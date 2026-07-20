// P1 Whole-Scene Localizer — agentic role types.
//
// P1 reads its complete source scene and localized-bible entries through the
// RB-025 local tools, then realizes one whole scene or measured overlapping
// chunks. The model's terminal object is only an untrusted draft carrier: this
// role re-stamps all deterministic source facts, citations, dependencies, and
// provenance before exposing a provisional translation WikiObject.

import type {
  ContextScopeValue,
  LocalizedRendering,
  RouteScope,
  RunModeValue,
  UnitFact,
  WikiObject,
} from "../../contracts/index.js";
import type { GlossaryFactValue } from "../../contracts/context.js";

import type { LocalizationSegment, SkeletonUnit } from "./plan.js";

export const P1_ROLE_ID = "P1" as const;
export const P1_TRANSLATION_KIND = "translation" as const;

export type P1FailureCode =
  | "unknown-scene"
  | "empty-scene"
  | "incomplete-scene"
  | "incomplete-bible"
  | "missing-bible-entry"
  | "dispatch-failed"
  | "unexpected-output";

export class P1RoleError extends Error {
  constructor(
    readonly code: P1FailureCode,
    detail: string,
  ) {
    super(`P1 ${code}: ${detail}`);
    this.name = "P1RoleError";
  }
}

/** Run-scoped trust and visibility envelope applied to every P1 object. */
export interface P1Context {
  readonly runMode: RunModeValue;
  readonly contextScope: ContextScopeValue;
  readonly routeVisibility: RouteScope;
  readonly localeBranchId: string;
}

/** The caller identifies the scene and the accepted localized-bible subjects it
 * needs. P1 resolves the entries itself through `outputs_get_accepted`; it never
 * accepts caller-supplied target-language prose as a substitute. */
export interface P1SceneInput {
  readonly sceneId: string;
  readonly bibleSubjectIds: readonly string[];
  readonly budgetBytes: number;
  readonly overlapUnits: number;
}

/** Deterministic context P1 read through RB-025 before it can call a model. */
export interface P1ReadScene {
  readonly sceneId: string;
  readonly units: readonly UnitFact[];
  readonly normalizedUnits: readonly SkeletonUnit[];
  readonly scope: RouteScope;
  readonly bibleEntries: readonly LocalizedRendering[];
  readonly glossaryEntries: readonly GlossaryFactValue[];
  /** Earlier accepted dialogue, keyed by source unit fact id. */
  readonly priorAcceptedTarget: ReadonlyMap<string, string>;
}

/** One planned segment exactly as P1 presents it to the model. All structural
 * fields are from the read model or planner, never terminal-model output. */
export interface P1SegmentRequest {
  readonly scene: P1ReadScene;
  readonly segment: LocalizationSegment;
  readonly unitsById: ReadonlyMap<string, SkeletonUnit>;
  readonly priorAcceptedTarget: ReadonlyMap<string, string>;
}

/** The P1 model boundary. The object is untrusted: P1 consumes only its draft
 * batch body and proves it against source facts before producing its own object. */
export type P1ModelCaller = (request: P1SegmentRequest) => Promise<WikiObject>;
