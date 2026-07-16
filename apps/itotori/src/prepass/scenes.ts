// Scene fact cards + character occurrence facts, from decode reductions.
//
// The reductions (reduceScenes / reduceCharacterOccurrences) already count by
// canonical decode identity — never by a mutable display label. Here we attach
// reachability, the scene's dispatch play position, and the count of bound
// units per scene, and stamp stable namespaced fact ids.

import { namespacedFactId } from "@itotori/db";

import { reduceCharacterOccurrences, reduceScenes } from "../structure/reduce.js";
import type { NarrativeStructure } from "../structure/types.js";

import { stableSegment } from "./fact-id.js";
import type { CharacterOccurrenceFact, OrderedUnitFact, SceneFactCard } from "./types.js";

/** Build one fact card per scene, in ascending scene-id order. */
export function materializeSceneCards(
  structure: NarrativeStructure,
  orderedUnits: readonly OrderedUnitFact[],
  reachableSceneIds: readonly number[],
): SceneFactCard[] {
  const reachable = new Set(reachableSceneIds);
  const dispatchPosition = new Map<number, number>();
  structure.sceneDispatchOrder.forEach((sceneId, index) => {
    if (!dispatchPosition.has(sceneId)) dispatchPosition.set(sceneId, index);
  });
  const revealBySceneId = new Map<number, number | null>(
    structure.scenes.map((scene) => [scene.sceneId, scene.revealOrder ?? null]),
  );
  const unitCountBySceneId = new Map<number, number>();
  for (const unit of orderedUnits) {
    unitCountBySceneId.set(unit.sceneId, (unitCountBySceneId.get(unit.sceneId) ?? 0) + 1);
  }

  return reduceScenes(structure)
    .map((scene): SceneFactCard => {
      const dispatchIndex = dispatchPosition.get(scene.sceneId);
      return {
        factId: namespacedFactId("scene", stableSegment(String(scene.sceneId))),
        sceneId: scene.sceneId,
        playOrderIndex: dispatchIndex ?? null,
        revealOrder: revealBySceneId.get(scene.sceneId) ?? null,
        messageCount: scene.messageCount,
        choiceCount: scene.choiceCount,
        unitCount: unitCountBySceneId.get(scene.sceneId) ?? 0,
        characterIds: scene.characterIds,
        dispatchTargetSceneIds: scene.dispatchTargetSceneIds,
        choiceTargetSceneIds: scene.choiceTargetSceneIds,
        reachable: reachable.has(scene.sceneId),
      };
    })
    .sort((a, b) => a.sceneId - b.sceneId);
}

/** Build character occurrence/count facts, sorted by canonical character id. */
export function materializeCharacterOccurrences(
  structure: NarrativeStructure,
): CharacterOccurrenceFact[] {
  return reduceCharacterOccurrences(structure)
    .map(
      (occurrence): CharacterOccurrenceFact => ({
        factId: namespacedFactId("character", stableSegment(occurrence.characterId)),
        characterId: occurrence.characterId,
        totalLines: occurrence.totalLines,
        firstSceneId: occurrence.firstSceneId,
        lastSceneId: occurrence.lastSceneId,
        sceneIds: occurrence.sceneIds,
        linesByScene: occurrence.linesByScene,
      }),
    )
    .sort((a, b) => compareCodeUnits(a.characterId, b.characterId));
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
