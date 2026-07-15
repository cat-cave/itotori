import type {
  CharacterOccurrence,
  NarrativeChoice,
  NarrativeRouteEdge,
  NarrativeScene,
  NarrativeStructure,
  NarrativeStructureReductions,
  RouteGraph,
  SceneStructure,
} from "./types.js";

function uniqueInOrder<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function branchTarget(choice: NarrativeChoice): number | null {
  return choice.branchTargetSceneId ?? choice.branchEntryScene ?? null;
}

function dispatchTargets(scene: NarrativeScene): number[] {
  return uniqueInOrder([
    ...(scene.nextScene === null ? [] : [scene.nextScene]),
    ...(scene.dispatchFanoutScenes ?? []),
  ]);
}

/** Reduce each scene to decode facts; display labels never become identities. */
export function reduceScenes(structure: NarrativeStructure): SceneStructure[] {
  return structure.scenes.map((scene) => ({
    sceneId: scene.sceneId,
    messageCount: scene.messages.length,
    characterIds: uniqueInOrder(
      scene.messages.flatMap((message) =>
        message.characterId === null || message.characterId === undefined
          ? []
          : [message.characterId],
      ),
    ),
    choiceCount: scene.choices.length,
    dispatchTargetSceneIds: dispatchTargets(scene),
    choiceTargetSceneIds: uniqueInOrder(
      scene.choices.flatMap((choice) => {
        const target = branchTarget(choice);
        return target === null ? [] : [target];
      }),
    ),
  }));
}

/** Build only observed scene-to-scene edges; no synthetic choice nodes exist. */
export function reduceRouteGraph(structure: NarrativeStructure): RouteGraph {
  const edges: NarrativeRouteEdge[] = [];
  const seen = new Set<string>();
  const add = (edge: NarrativeRouteEdge): void => {
    const key = `${edge.kind}:${edge.fromSceneId}:${edge.toSceneId}:${edge.choiceIndex ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      edges.push(edge);
    }
  };
  for (const scene of structure.scenes) {
    for (const target of dispatchTargets(scene)) {
      add({ fromSceneId: scene.sceneId, toSceneId: target, kind: "dispatch" });
    }
    for (const choice of scene.choices) {
      const target = branchTarget(choice);
      if (target !== null) {
        add({
          fromSceneId: scene.sceneId,
          toSceneId: target,
          kind: "choice",
          choiceIndex: choice.optionIndex,
        });
      }
    }
  }
  return {
    entryScene: structure.entryScene,
    sceneDispatchOrder: [...structure.sceneDispatchOrder],
    edges,
  };
}

function orderedScenes(structure: NarrativeStructure): NarrativeScene[] {
  const byId = new Map(structure.scenes.map((scene) => [scene.sceneId, scene]));
  const ordered = structure.sceneDispatchOrder.flatMap((sceneId) => {
    const scene = byId.get(sceneId);
    return scene === undefined ? [] : [scene];
  });
  for (const scene of structure.scenes) {
    if (!structure.sceneDispatchOrder.includes(scene.sceneId)) ordered.push(scene);
  }
  return ordered;
}

/** Count occurrences by canonical character ID, never by a mutable label. */
export function reduceCharacterOccurrences(structure: NarrativeStructure): CharacterOccurrence[] {
  const characterOrder: string[] = [];
  const counts = new Map<string, Map<number, number>>();
  const scenes = orderedScenes(structure);
  for (const scene of scenes) {
    for (const message of scene.messages) {
      const characterId = message.characterId;
      if (characterId === null || characterId === undefined) continue;
      let byScene = counts.get(characterId);
      if (byScene === undefined) {
        byScene = new Map();
        counts.set(characterId, byScene);
        characterOrder.push(characterId);
      }
      byScene.set(scene.sceneId, (byScene.get(scene.sceneId) ?? 0) + 1);
    }
  }
  return characterOrder.map((characterId) => {
    const byScene = counts.get(characterId)!;
    const linesByScene = scenes.flatMap((scene) => {
      const lineCount = byScene.get(scene.sceneId);
      return lineCount === undefined ? [] : [{ sceneId: scene.sceneId, lineCount }];
    });
    const sceneIds = linesByScene.map((line) => line.sceneId);
    return {
      characterId,
      sceneIds,
      linesByScene,
      totalLines: linesByScene.reduce((total, line) => total + line.lineCount, 0),
      firstSceneId: sceneIds[0]!,
      lastSceneId: sceneIds.at(-1)!,
    };
  });
}

export function reduceNarrativeStructure(
  structure: NarrativeStructure,
): NarrativeStructureReductions {
  return {
    scenes: reduceScenes(structure),
    routeGraph: reduceRouteGraph(structure),
    characters: reduceCharacterOccurrences(structure),
  };
}
