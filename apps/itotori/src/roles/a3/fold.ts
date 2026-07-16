// The serial progressive story-so-far fold.
//
// A3 walks the scenes in DETERMINISTIC play order (`sceneDispatchOrder`) and
// folds forward: each step reads the COMPLETE scene, hands the model the prior
// accepted story-so-far, and emits a cited scene-summary plus an updated
// story-so-far. The fold is strictly serial — step N consumes step N-1's story —
// and the FINAL story-so-far runs through the last dispatched scene, covering the
// full route history. Counts and speakers on every result come from the index.

import type { ReadModel } from "../../read-tools/index.js";
import type { RouteScope, WikiObject } from "../../contracts/index.js";
import type { SceneFactCard } from "../../prepass/index.js";

import { assembleSceneSummary, assembleStorySoFar } from "./assemble.js";
import { readCompleteScene } from "./scene.js";
import { A3RoleError, type A3Context, type A3ModelCaller, type StorySoFarState } from "./types.js";

/** One folded scene: its cited summary, the story-so-far through it, and the
 * INDEX-DERIVED facts (counts, speakers) downstream roles consume. */
export interface A3SceneResult {
  readonly sceneId: number;
  readonly sceneSummary: WikiObject;
  readonly storySoFar: WikiObject;
  /** The deterministic scene fact card — the sole source of counts. */
  readonly factCard: SceneFactCard;
  /** The decoded speaker labels present in the scene (never a model attribution). */
  readonly speakerLabels: readonly string[];
  readonly characterIds: readonly string[];
}

/** The whole progressive fold over a route's dispatch order. */
export interface A3RouteResult {
  readonly scenes: readonly A3SceneResult[];
  /** The story-so-far through the last dispatched scene — the route spine. */
  readonly finalStorySoFar: WikiObject;
  /** Every scene the final story-so-far covers, in play order (the full route). */
  readonly coveredSceneIds: readonly number[];
}

/** Merge two route scopes into the narrowest scope that contains both. */
function mergeScopes(left: RouteScope, right: RouteScope): RouteScope {
  if (left.kind === "global" || right.kind === "global") return { kind: "global" };
  const ids = new Set<string>();
  for (const scope of [left, right]) {
    if (scope.kind === "route") ids.add(scope.routeId);
    else for (const id of scope.routeIds) ids.add(id);
  }
  const sorted = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (sorted.length === 1) return { kind: "route", routeId: sorted[0]! };
  return { kind: "route-set", routeIds: sorted };
}

/**
 * Fold every scene on the route in play order into cited scene-summary and
 * story-so-far WikiObjects. Throws {@link A3RoleError} if the route has no
 * dispatch order. The returned final story-so-far covers the full route history.
 */
export async function foldRoute(
  model: ReadModel,
  context: A3Context,
  modelCaller: A3ModelCaller,
): Promise<A3RouteResult> {
  const order = model.factSnapshot.routeTopology.sceneDispatchOrder;
  if (order.length === 0) {
    throw new A3RoleError("empty-dispatch-order", "the route has no dispatched scenes");
  }
  const scenes: A3SceneResult[] = [];
  let prior: StorySoFarState | null = null;
  let cumulativeScope: RouteScope | null = null;

  for (const sceneId of order) {
    const scene = readCompleteScene(model, context, sceneId);
    const narrative = await modelCaller({
      scene,
      priorStory: prior,
      sourceLanguage: model.sourceLanguage,
    });
    cumulativeScope =
      cumulativeScope === null ? scene.scope : mergeScopes(cumulativeScope, scene.scope);
    const sceneSummary = assembleSceneSummary(model, context, scene, narrative);
    const storySoFar = assembleStorySoFar(model, context, scene, cumulativeScope, narrative, prior);
    scenes.push({
      sceneId,
      sceneSummary,
      storySoFar,
      factCard: scene.factCard,
      speakerLabels: scene.speakerLabels,
      characterIds: scene.characterIds,
    });
    prior = {
      throughSceneId: sceneId,
      summary: narrative.storySummary,
      openThreads: narrative.storyOpenThreads,
    };
  }

  return {
    scenes,
    finalStorySoFar: scenes[scenes.length - 1]!.storySoFar,
    coveredSceneIds: [...order],
  };
}
