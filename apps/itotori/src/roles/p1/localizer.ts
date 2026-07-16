// The P1 Whole-Scene Localizer — the translation role.
//
// It consumes the exact source skeletons of a COMPLETE scene plus its localized-
// bible rendering ids, plans a whole-scene or overlapping-chunk realization from
// the measured context limit, and drives each segment through the SOLE ZDR
// dispatch boundary as deepseek-v4-flash. Serial within the scene thread: each
// finalized core's accepted target is folded forward so the next chunk continues
// the author thread. Every returned batch is tied back to the plan and to the
// source; the four guarantees (non-overlap-core finalize, exact cardinality/
// order/hashes, preserved placeholders, typed uncertainty) are enforced here.
// A dispatch failure is a loud typed error, never a fabricated draft.

import {
  DraftBatchSchema,
  type CallResult,
  type Draft,
  type DraftBatch,
  type UnitFact,
} from "../../contracts/index.js";
import { specialistFor, type Specialist } from "../../roster/index.js";
import {
  buildLocalizerCall,
  dispatchLocalizerCall,
  type LocalizerCall,
  type LocalizerRuntimeBase,
} from "./call.js";
import {
  assembleFinalizedDrafts,
  assertExactAgainstSource,
  assertPlaceholdersPreserved,
  surfaceUncertainties,
  validateSegmentBatch,
  type UncertainUnit,
} from "./finalize.js";
import {
  normalizeScene,
  planSceneLocalization,
  type LocalizationPlan,
  type SkeletonUnit,
} from "./plan.js";

/** A prior accepted target line from the trusted accepted-output store, carried
 * forward so the author thread keeps voice continuity across the scene. */
export interface PriorAcceptedTarget {
  readonly unitId: string;
  readonly targetSkeleton: string;
}

export interface LocalizeSceneInput {
  /** The complete scene's decode unit facts (source skeletons). */
  readonly units: readonly UnitFact[];
  /** Localized-bible rendering ids the drafts must cite (wiki-first basis). */
  readonly bibleRenderingIds: readonly string[];
  /** Accepted target of earlier scenes/batches (from the accepted-output store),
   * continuing the thread. Trusted substrate — a plain typed value. */
  readonly priorAcceptedTarget?: readonly PriorAcceptedTarget[];
  readonly contextSnapshotId: `sha256:${string}`;
  readonly localizationSnapshotId: `sha256:${string}`;
  readonly schemaHash: `sha256:${string}`;
  readonly budgetBytes: number;
  readonly overlapUnits: number;
  readonly runMode: "production" | "pilot" | "test-dev";
  readonly contextScope: "whole-game" | "external-augmented" | `narrowed:${string}`;
  readonly specialist?: Specialist;
}

export interface SceneLocalization {
  readonly sceneId: string;
  readonly mode: LocalizationPlan["mode"];
  readonly plan: LocalizationPlan;
  readonly batches: readonly DraftBatch[];
  /** Exactly the scene's units, in play order — the finalized translation. */
  readonly finalizedDrafts: readonly Draft[];
  readonly uncertainUnits: readonly UncertainUnit[];
  readonly results: readonly CallResult[];
}

export class LocalizeError extends Error {
  constructor(
    readonly code: "dispatch-failure",
    detail: string,
  ) {
    super(`p1 localize ${code}: ${detail}`);
    this.name = "LocalizeError";
  }
}

function requireBatch(result: CallResult): DraftBatch {
  if (result.status !== "success") {
    throw new LocalizeError("dispatch-failure", `segment dispatch failed: ${result.failureKind}`);
  }
  return DraftBatchSchema.parse(result.value);
}

/** Localize one complete scene end-to-end through the sole ZDR boundary. */
export async function localizeScene(
  input: LocalizeSceneInput,
  runtime: LocalizerRuntimeBase,
): Promise<SceneLocalization> {
  const specialist = input.specialist ?? specialistFor("P1");
  const scene = normalizeScene(input.units);
  const plan = planSceneLocalization(scene, {
    budgetBytes: input.budgetBytes,
    overlapUnits: input.overlapUnits,
  });
  const unitsById = new Map<string, SkeletonUnit>(scene.units.map((unit) => [unit.unitId, unit]));

  // The running author thread: prior accepted target (trusted store) plus every
  // finalized core (each validated against the plan and source before folding).
  const threadTarget = new Map<string, string>();
  for (const line of input.priorAcceptedTarget ?? []) {
    threadTarget.set(line.unitId, line.targetSkeleton);
  }

  const batches: DraftBatch[] = [];
  const results: CallResult[] = [];
  for (const segment of plan.segments) {
    const call: LocalizerCall = buildLocalizerCall({
      specialist,
      segment,
      unitsById,
      bibleRenderingIds: input.bibleRenderingIds,
      priorAcceptedTarget: threadTarget,
      contextSnapshotId: input.contextSnapshotId,
      localizationSnapshotId: input.localizationSnapshotId,
      runMode: input.runMode,
      contextScope: input.contextScope,
      schemaHash: input.schemaHash,
    });
    const result = await dispatchLocalizerCall(call, runtime);
    results.push(result);
    const batch = requireBatch(result);
    // VALIDATE against the plan segment + verified source BEFORE folding into the
    // thread — an invalid batch fails the run without tainting a later dispatch.
    const validated = validateSegmentBatch(segment, batch, unitsById);
    batches.push(batch);
    // Fold only the validated plan-core drafts forward so the next chunk's
    // overlap continues from real accepted target.
    for (const draft of validated) threadTarget.set(draft.unitId, draft.targetSkeleton);
  }

  const finalizedDrafts = assembleFinalizedDrafts(plan.segments, batches);
  assertExactAgainstSource(scene.units, finalizedDrafts);
  assertPlaceholdersPreserved(scene.units, finalizedDrafts);

  return {
    sceneId: scene.sceneId,
    mode: plan.mode,
    plan,
    batches,
    finalizedDrafts,
    uncertainUnits: surfaceUncertainties(finalizedDrafts),
    results,
  };
}
