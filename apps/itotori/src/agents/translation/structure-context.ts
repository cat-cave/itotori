import {
  reduceNarrativeStructure,
  type CharacterOccurrence,
  type NarrativeRouteEdge,
  type NarrativeStructure,
  type NarrativeStructureVersion,
  type SceneStructure,
} from "../../structure/index.js";

export type StructuredTranslationContext = {
  schemaVersion: NarrativeStructureVersion;
  scene: SceneStructure;
  incomingEdges: NarrativeRouteEdge[];
  outgoingEdges: NarrativeRouteEdge[];
  characters: CharacterOccurrence[];
  artifactRefs: string[];
};

export class StructuredTranslationSceneNotFoundError extends Error {
  constructor(sceneId: number) {
    super(`decoded structure has no scene ${sceneId}`);
    this.name = "StructuredTranslationSceneNotFoundError";
  }
}

/** Select one scene's already-reduced facts for prompt assembly. */
export function buildStructuredTranslationContext(
  structure: NarrativeStructure,
  sceneId: number,
): StructuredTranslationContext {
  const reductions = reduceNarrativeStructure(structure);
  const scene = reductions.scenes.find((candidate) => candidate.sceneId === sceneId);
  if (scene === undefined) throw new StructuredTranslationSceneNotFoundError(sceneId);
  const incomingEdges = reductions.routeGraph.edges.filter((edge) => edge.toSceneId === sceneId);
  const outgoingEdges = reductions.routeGraph.edges.filter((edge) => edge.fromSceneId === sceneId);
  const characters = reductions.characters.filter((character) =>
    scene.characterIds.includes(character.characterId),
  );
  return {
    schemaVersion: structure.schemaVersion,
    scene,
    incomingEdges,
    outgoingEdges,
    characters,
    artifactRefs: [
      `structure:scene:${scene.sceneId}`,
      "structure:route-graph",
      ...characters.map((character) => `structure:character:${character.characterId}`),
    ],
  };
}
