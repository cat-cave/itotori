export const NARRATIVE_STRUCTURE_V1 = "utsushi.narrative-structure.v1" as const;
export const NARRATIVE_STRUCTURE_V2 = "utsushi.narrative-structure.v2" as const;

export const SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS = [
  NARRATIVE_STRUCTURE_V1,
  NARRATIVE_STRUCTURE_V2,
] as const;

export type NarrativeStructureVersion = (typeof SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS)[number];
export type SelectionControlSignal = "button-object" | "text-window" | "none";

export type NarrativeMessage = {
  order: number;
  speaker: string | null;
  /** Null when this export version has no canonical speaker identity. */
  characterId?: string | null;
  text: string;
  textSurface: string | null;
};

export type NarrativeChoice = {
  optionIndex: number;
  label: string;
  /** v1's observed branch target. */
  branchEntryScene: number | null;
  /** v2's authoritative branch target. */
  branchTargetSceneId?: number | null;
  branchMessages: NarrativeMessage[];
};

export type NarrativeScene = {
  sceneId: number;
  selectionControl: SelectionControlSignal;
  nextScene: number | null;
  dispatchFanoutScenes?: number[];
  messages: NarrativeMessage[];
  choices: NarrativeChoice[];
};

export type NarrativeStructure = {
  schemaVersion: NarrativeStructureVersion;
  entryScene: number;
  sceneDispatchOrder: number[];
  scenes: NarrativeScene[];
};

export type SceneStructure = {
  sceneId: number;
  messageCount: number;
  characterIds: string[];
  choiceCount: number;
  dispatchTargetSceneIds: number[];
  choiceTargetSceneIds: number[];
};

export type NarrativeRouteEdge = {
  fromSceneId: number;
  toSceneId: number;
  kind: "dispatch" | "choice";
  choiceIndex?: number;
};

export type RouteGraph = {
  entryScene: number;
  sceneDispatchOrder: number[];
  edges: NarrativeRouteEdge[];
};

export type CharacterOccurrence = {
  characterId: string;
  sceneIds: number[];
  linesByScene: Array<{ sceneId: number; lineCount: number }>;
  totalLines: number;
  firstSceneId: number;
  lastSceneId: number;
};

export type NarrativeStructureReductions = {
  scenes: SceneStructure[];
  routeGraph: RouteGraph;
  characters: CharacterOccurrence[];
};

export class NarrativeStructureParseError extends Error {
  constructor(detail: string) {
    super(`narrative structure invalid: ${detail}`);
    this.name = "NarrativeStructureParseError";
  }
}

export class NarrativeStructureVersionError extends Error {
  constructor(detail: string) {
    super(`narrative structure version negotiation failed: ${detail}`);
    this.name = "NarrativeStructureVersionError";
  }
}
