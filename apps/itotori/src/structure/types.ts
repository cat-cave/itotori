export const NARRATIVE_STRUCTURE_V1 = "utsushi.narrative-structure.v1" as const;
export const NARRATIVE_STRUCTURE_V2 = "utsushi.narrative-structure.v2" as const;

export const SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS = [
  NARRATIVE_STRUCTURE_V1,
  NARRATIVE_STRUCTURE_V2,
] as const;

export type NarrativeStructureVersion = (typeof SUPPORTED_NARRATIVE_STRUCTURE_VERSIONS)[number];
/**
 * Provider-owned, stable scene identity.  Consumers may compare or serialize
 * it, but must never infer an engine's numeric archive address from it.
 */
export type NarrativeSceneId = string;
/** Opaque, provider-owned evidence carried beside the common narrative graph. */
export type NarrativeEngineEvidence = Record<string, unknown>;
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
  engineEvidence?: NarrativeEngineEvidence | undefined;
  bridgeRef?: NarrativeBridgeRef | null;
  linkageStatus?: "bridge_linked" | "runtime_only";
  runtimeOnlyReason?: string;
  routeMembership?: string[];
};

export type NarrativeChoice = {
  optionIndex: number;
  label: string;
  /** v1's observed branch target. */
  branchEntryScene: NarrativeSceneId | null;
  /** v2's authoritative branch target. */
  branchTargetSceneId?: NarrativeSceneId | null;
  choiceId?: string;
  choiceGroupId?: string;
  edgeId?: string;
  edgeResolution?: EdgeResolution;
  unresolvedEdgeDiagnostic?: string | null;
  bridgeRef?: NarrativeBridgeRef | null;
  /** Generic asset identity for a bridge-linked choice. Provider-specific
   * coordinates live in `engineEvidence`, never in the common graph. */
  sourceAsset?: SourceAssetRef;
  engineEvidence?: NarrativeEngineEvidence | undefined;
  /** `runtime_only` marks a displayed runtime prompt option that has NO static
   * BridgeUnit (a system/flow menu such as "continue playing / save for later")
   * — it is not part of the translatable script and the join skips it, exactly
   * as it skips a runtime-only message. `bridge_linked` (or absent) is a
   * translatable choice that must bind to a bridge unit. */
  linkageStatus?: "bridge_linked" | "runtime_only";
  runtimeOnlyReason?: string;
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
  engineEvidence?: NarrativeEngineEvidence | undefined;
  choiceId: string | null;
  playOrder: number | null;
  revealOrder: RevealOrder | null;
  observedLineIds: string[];
  routeMembership: string[];
};

export type NarrativeScene = {
  sceneId: NarrativeSceneId;
  selectionControl: SelectionControlSignal;
  nextScene: NarrativeSceneId | null;
  dispatchFanoutScenes?: NarrativeSceneId[];
  messages: NarrativeMessage[];
  choices: NarrativeChoice[];
  sceneRef?: string;
  units?: NarrativeUnit[];
  playOrder?: number;
  revealOrder?: number | null;
  observationMode?: "entry_reached" | "cold_seeded";
  predecessors?: NarrativeSceneId[];
  successors?: NarrativeSceneId[];
  reachable?: boolean;
  routeMembership?: string[];
};

export type NarrativeEdge = {
  edgeId: string;
  kind: "dispatch" | "choice";
  fromSceneId: NarrativeSceneId;
  toSceneId: NarrativeSceneId | null;
  resolution: EdgeResolution;
  diagnostic: string | null;
  choiceId: string | null;
  optionIndex: number | null;
};

export type NarrativeRoute = {
  routeId: string;
  entrySceneId: NarrativeSceneId;
  viaEdgeId: string | null;
  sceneIds: NarrativeSceneId[];
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
  /** Registered provider id that produced this common graph. */
  engine: string;
  entryScene: NarrativeSceneId;
  sceneDispatchOrder: NarrativeSceneId[];
  scenes: NarrativeScene[];
  /** Provider-owned evidence; the common graph does not interpret its shape. */
  engineEvidence?: NarrativeEngineEvidence | undefined;
  bridgeId?: string | undefined;
  sourceBundleHash?: string | undefined;
  coverage?: NarrativeCoverage | undefined;
  routes?: NarrativeRoute[] | undefined;
  edges?: NarrativeEdge[] | undefined;
};

export type SceneStructure = {
  sceneId: NarrativeSceneId;
  messageCount: number;
  characterIds: string[];
  choiceCount: number;
  dispatchTargetSceneIds: NarrativeSceneId[];
  choiceTargetSceneIds: NarrativeSceneId[];
};

export type NarrativeRouteEdge = {
  fromSceneId: NarrativeSceneId;
  toSceneId: NarrativeSceneId;
  kind: "dispatch" | "choice";
  choiceIndex?: number;
};

export type RouteGraph = {
  entryScene: NarrativeSceneId;
  sceneDispatchOrder: NarrativeSceneId[];
  edges: NarrativeRouteEdge[];
};

export type CharacterOccurrence = {
  characterId: string;
  sceneIds: NarrativeSceneId[];
  linesByScene: Array<{ sceneId: NarrativeSceneId; lineCount: number }>;
  totalLines: number;
  firstSceneId: NarrativeSceneId;
  lastSceneId: NarrativeSceneId;
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
