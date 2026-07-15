export const NARRATIVE_STRUCTURE_V1 = "utsushi.narrative-structure.v1" as const;
export const NARRATIVE_STRUCTURE_V2 = "utsushi.narrative-structure.v2" as const;

export const SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS = [
  NARRATIVE_STRUCTURE_V1,
  NARRATIVE_STRUCTURE_V2,
] as const;

export type NarrativeStructureVersion = (typeof SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS)[number];
export type SelectionControlSignal = "button-object" | "text-window" | "none";
export type EdgeResolution = "resolved" | "unknown" | "unresolved";
export type RgbColor = [number, number, number];
export type RevealOrder = { sceneOrder: number; itemOrder: number };
export type SourceAssetRef = { assetId: string; assetKey: string };
export type NarrativeBridgeRef = {
  bridgeUnitId: string;
  sourceUnitKey: string;
  runtimeObjectId?: string;
};

export type NarrativeMessage = {
  order: number;
  speaker: string | null;
  /** Null when this export version has no canonical speaker identity. */
  characterId?: string | null;
  text: string;
  textSurface: string | null;
  playOrder?: number;
  revealOrder?: RevealOrder | null;
  lineId?: string;
  evidenceTier?: "E0" | "E1" | "E2" | "E3";
  color?: RgbColor | null;
  bridgeDeclaredColor?: RgbColor | null;
  sourceAsset?: SourceAssetRef;
  byteOffsetInScene?: number | null;
  byteLength?: number | null;
  rawByteHandle?: string | null;
  bodyShiftJisHex?: string | null;
  bridgeRef?: NarrativeBridgeRef | null;
  linkageStatus?: "bridge_linked" | "runtime_only";
  runtimeOnlyReason?: string;
  routeMembership?: string[];
};

export type NarrativeChoice = {
  optionIndex: number;
  label: string;
  /** v1's observed branch target. */
  branchEntryScene: number | null;
  /** v2's authoritative branch target. */
  branchTargetSceneId?: number | null;
  choiceId?: string;
  choiceGroupId?: string;
  edgeId?: string;
  edgeResolution?: EdgeResolution;
  unresolvedEdgeDiagnostic?: string | null;
  bridgeRef?: NarrativeBridgeRef | null;
  /** Authoritative source-asset + byte coordinates for a bridge-linked choice
   * option. Required whenever `bridgeRef` is present so the join can prove the
   * choice binding on asset + byte range + hash (a bridge-linked choice with
   * no coordinates is rejected, never bound blind). */
  sourceAsset?: SourceAssetRef;
  byteOffsetInScene?: number | null;
  byteLength?: number | null;
  branchMessages: NarrativeMessage[];
};

export type NarrativeUnit = {
  unitId: string;
  bridgeRef: NarrativeBridgeRef;
  surfaceKind: string;
  sourceText: string;
  characterId: string | null;
  evidenceTier: "E0" | "E1" | "E2" | "E3" | null;
  color: RgbColor | null;
  bridgeDeclaredColor?: RgbColor | null;
  sourceAsset: SourceAssetRef;
  byteOffsetInScene: number;
  byteLength: number;
  rawByteHandle: string;
  choiceId: string | null;
  playOrder: number | null;
  revealOrder: RevealOrder | null;
  observedLineIds: string[];
  routeMembership: string[];
};

export type NarrativeScene = {
  sceneId: number;
  selectionControl: SelectionControlSignal;
  nextScene: number | null;
  dispatchFanoutScenes?: number[];
  messages: NarrativeMessage[];
  choices: NarrativeChoice[];
  sceneRef?: string;
  units?: NarrativeUnit[];
  playOrder?: number;
  revealOrder?: number | null;
  observationMode?: "entry_reached" | "cold_seeded";
  predecessors?: number[];
  successors?: number[];
  reachable?: boolean;
  routeMembership?: string[];
};

export type NarrativeEdge = {
  edgeId: string;
  kind: "dispatch" | "choice";
  fromSceneId: number;
  toSceneId: number | null;
  resolution: EdgeResolution;
  diagnostic: string | null;
  choiceId: string | null;
  optionIndex: number | null;
};

export type NarrativeRoute = {
  routeId: string;
  entrySceneId: number;
  viaEdgeId: string | null;
  sceneIds: number[];
};

export type NarrativeCoverage = {
  archiveSceneCount: number;
  decodedSceneCount: number;
  loadedSceneCount: number;
  bridgeAssetCount: number;
  emittedSceneCount: number;
  archiveUnitCount: number;
  emittedUnitCount: number;
  observedUnitCount: number;
  archiveEdgeCount: number;
  emittedEdgeCount: number;
  unresolvedEdgeCount: number;
  truncationStatus: "complete";
  truncated: false;
  complete: true;
};

export type NarrativeStructure = {
  schemaVersion: NarrativeStructureVersion;
  entryScene: number;
  sceneDispatchOrder: number[];
  scenes: NarrativeScene[];
  bridgeId?: string | undefined;
  sourceBundleHash?: string | undefined;
  coverage?: NarrativeCoverage | undefined;
  routes?: NarrativeRoute[] | undefined;
  edges?: NarrativeEdge[] | undefined;
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
