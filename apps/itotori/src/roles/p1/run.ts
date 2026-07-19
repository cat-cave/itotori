// Run P1 over one complete scene from the immutable read model.
//
// The planner decides whole-scene versus overlap from measured skeleton bytes;
// only each chunk's non-overlap core is accepted. The localizer's object is
// untrusted until its batch proves exact source order/hash/placeholders and exact
// wiki-first rendering basis. Every accepted core then extends the scene thread.

import {
  DraftBatchSchema,
  TranslationWikiObjectSchema,
  type Draft,
  type DraftBatch,
  type WikiObject,
} from "../../contracts/index.js";
import type { ReadModel } from "../../read-tools/index.js";

import { assembleP1TranslationObject } from "./assemble.js";
import {
  P1RoleError,
  type P1Context,
  type P1ModelCaller,
  type P1SceneInput,
  type P1SegmentRequest,
} from "./agent-types.js";
import {
  assembleFinalizedDrafts,
  assertExactAgainstSource,
  assertPlaceholdersPreserved,
  surfaceUncertainties,
  validateSegmentBatch,
  type UncertainUnit,
} from "./finalize.js";
import { planSceneLocalization, type LocalizationPlan } from "./plan.js";
import { readP1Scene } from "./read.js";

export interface P1SceneResult {
  readonly sceneId: string;
  readonly plan: LocalizationPlan;
  readonly batches: readonly DraftBatch[];
  readonly translationObjects: readonly WikiObject[];
  readonly finalizedDrafts: readonly Draft[];
  readonly uncertainUnits: readonly UncertainUnit[];
}

function expectedBibleRenderingIds(request: P1SegmentRequest): readonly string[] {
  return request.scene.bibleEntries.map((entry) => entry.renderingId);
}

function assertExactBibleBasis(batch: DraftBatch, request: P1SegmentRequest): void {
  const expected = expectedBibleRenderingIds(request);
  for (const draft of batch.drafts) {
    if (draft.basis.kind !== "wiki-first") {
      throw new P1RoleError(
        "unexpected-output",
        `draft ${draft.unitId} bypassed the localized bible`,
      );
    }
    const actual = draft.basis.bibleRenderingIds;
    if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
      throw new P1RoleError(
        "unexpected-output",
        `draft ${draft.unitId} does not cite the exact localized-bible entries`,
      );
    }
  }
}

/** Localize a complete scene from real tool reads. This is P1's agentic public
 * entrypoint: no source skeleton, bible prose, accepted target text, or scene
 * scope is accepted from the caller as a replacement for the read model. */
export async function runP1Scene(
  model: ReadModel,
  context: P1Context,
  input: P1SceneInput,
  modelCaller: P1ModelCaller,
): Promise<P1SceneResult> {
  if (!model.localization) {
    throw new P1RoleError("missing-bible-entry", "P1 requires a bound localization read model");
  }
  const scene = readP1Scene(model, context, input);
  const plan = planSceneLocalization(
    { sceneId: scene.sceneId, units: scene.normalizedUnits },
    { budgetBytes: input.budgetBytes, overlapUnits: input.overlapUnits },
  );
  const unitsById = new Map(scene.normalizedUnits.map((unit) => [unit.unitId, unit]));
  const thread = new Map(scene.priorAcceptedTarget);
  const batches: DraftBatch[] = [];
  const translationObjects: WikiObject[] = [];

  for (const segment of plan.segments) {
    const request: P1SegmentRequest = {
      scene,
      segment,
      unitsById,
      priorAcceptedTarget: thread,
    };
    const response = await modelCaller(request);
    const draftObject = TranslationWikiObjectSchema.parse(response);
    const batch = DraftBatchSchema.parse(draftObject.body.draftBatch);
    assertExactBibleBasis(batch, request);
    const finalizedCore = validateSegmentBatch(segment, batch, unitsById);
    const object = assembleP1TranslationObject(model, context, scene, segment, batch);
    batches.push(batch);
    translationObjects.push(object);
    for (const draft of finalizedCore) thread.set(draft.unitId, draft.targetSkeleton);
  }

  const finalizedDrafts = assembleFinalizedDrafts(plan.segments, batches);
  assertExactAgainstSource(scene.normalizedUnits, finalizedDrafts);
  assertPlaceholdersPreserved(scene.normalizedUnits, finalizedDrafts);
  return {
    sceneId: scene.sceneId,
    plan,
    batches,
    translationObjects,
    finalizedDrafts,
    uncertainUnits: surfaceUncertainties(finalizedDrafts),
  };
}
