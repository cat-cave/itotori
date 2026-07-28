import {
  AssetKindV02,
  Bcp47Locale,
  PolicyActionV02,
  PreserveModeV02,
  RuntimeApproximationTierV02,
  RuntimeArtifactKindV02,
  RuntimeEvidenceTierV02,
  RuntimeReferenceComparisonKindV02,
  RuntimeReferenceComparisonStatusV02,
  RuntimeTraceEventKindV02,
  RuntimeValidationFindingKindV02,
  SpanKindV02,
  TriageSeverityV02,
  Uuid7,
} from "./schema-domain-01.js";
import {
  HashAlgorithmV02,
  HashNormalizationV02,
  HashScopeV02,
  PatchWriteModeV02,
  RuntimeExpectationKindV02,
  SourceRevisionKindV02,
  UI_AREAS,
} from "./schema-domain-02.js";

export type UiAreaV02 = (typeof UI_AREAS)[number];

export const DATABASE_KINDS = [
  "item",
  "skill",
  "quest",
  "location",
  "achievement",
  "character_bio",
  "bestiary",
  "codex",
  "encyclopedia",
] as const;
export type DatabaseKindV02 = (typeof DATABASE_KINDS)[number];

export const METADATA_SCOPES = [
  "package",
  "platform",
  "save_data",
  "credits",
  "config",
  "achievement",
] as const;
export type MetadataScopeV02 = (typeof METADATA_SCOPES)[number];

export const METADATA_VISIBILITIES = ["runtime", "package", "platform", "internal"] as const;
export type MetadataVisibilityV02 = (typeof METADATA_VISIBILITIES)[number];

export const SPEAKER_NAME_DISPLAY_CONTEXTS = [
  "name_plate",
  "backlog",
  "chat",
  "battle_callout",
] as const;
export type SpeakerNameDisplayContextV02 = (typeof SPEAKER_NAME_DISPLAY_CONTEXTS)[number];

export const IMAGE_REPLACEMENT_MODES = [
  "redraw_region",
  "overlay_text",
  "replace_asset",
  "metadata_only",
] as const;
export type ImageReplacementModeV02 = (typeof IMAGE_REPLACEMENT_MODES)[number];

export type HashRuleV02<Scope extends HashScopeV02 = HashScopeV02> = {
  scope: Scope;
  algorithm: HashAlgorithmV02;
  normalization: HashNormalizationV02;
  fields?: string[];
};

export type HashStrategyV02 = {
  sourceProfile: HashRuleV02<"source_profile">;
  sourceBundle: HashRuleV02<"source_bundle">;
  sourceAsset: HashRuleV02<"source_asset">;
  sourceUnit: HashRuleV02<"source_unit">;
  patchExport: HashRuleV02<"patch_export">;
  deltaPackage: HashRuleV02<"delta_package">;
};

export type SourceRevisionV02 = {
  revisionId: Uuid7;
  revisionKind: SourceRevisionKindV02;
  value: string;
  createdAt?: string;
};

export type SourceGameRevisionV02 = {
  gameId: string;
  gameVersion: string;
  sourceProfileId: string;
  sourceProfileRevision: SourceRevisionV02;
};

export type AssetRefV02 = {
  assetId: Uuid7;
  assetKey?: string;
};

export type BridgeAssetV02 = {
  assetId: Uuid7;
  assetKey: string;
  assetKind: AssetKindV02;
  sourceHash: string;
  sourceRevision: SourceRevisionV02;
  path?: string;
};

export type ByteRangeV02 = {
  startByte: number;
  endByte: number;
};

export type PixelRegionV02 = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SourceLocationV02 = {
  containerKey?: string;
  entryPath?: string[];
  range?: ByteRangeV02;
  region?: PixelRegionV02;
};

export type RouteContextV02 = {
  routeId?: Uuid7;
  routeKey?: string;
  /**
   * Producer-declared scene coordinate. This is intentionally an opaque
   * non-empty string rather than a generated database UUID: runtime and
   * structure exporters address decoded source scenes with their native
   * coordinate (for example a Scene.pck directory id).
   */
  sceneId?: string;
  sceneKey?: string;
  branchId?: Uuid7;
  branchKey?: string;
  position?: string;
};

/** RGB dialogue-text colour resolved from a `#NAMAE` row's `#COLOR_TABLE`
 * index. Each channel is an 8-bit value (`0..=255`); the producer omits the
 * field rather than clamp an out-of-range Gameexe row, so a present triple is
 * always a real palette colour. */
export type SpeakerTextColorV02 = [number, number, number];

/** Whether the reader is shown the speaker's real name (`revealed`) or a
 * censored box mask (`concealed`). Derived from the matched `#NAMAE` row's
 * display-key-vs-box-shown fields, never fabricated. */
export type SpeakerRevealStateV02 = "revealed" | "concealed";

export type SpeakerContextV02 =
  | {
      knowledgeState: "known";
      speakerId: Uuid7;
      displayName: string;
      canonicalNameRef?: string;
      /** Always `"revealed"` for a `known` speaker (box shows the real name). */
      revealState?: "revealed";
      textColor?: SpeakerTextColorV02;
    }
  | {
      knowledgeState: "parser_unknown";
      rawSpeakerText?: string;
      evidence?: string;
    }
  | {
      knowledgeState: "reader_unknown";
      speakerId: Uuid7;
      displayName: string;
      readerLabel: string;
      canonicalNameRef?: string;
      /** Always `"concealed"` for a `reader_unknown` speaker (box shows a mask). */
      revealState?: "concealed";
      textColor?: SpeakerTextColorV02;
    }
  | {
      knowledgeState: "not_applicable";
    };

export type LocalizationPolicyV02 = {
  policyAction: PolicyActionV02;
  targetLocale?: Bcp47Locale;
  localeBranchId?: Uuid7;
  targetText?: string;
  romanizationSystem?: string;
  policyReason?: string;
};

export type BridgeSpanV02 = {
  spanId: Uuid7;
  spanKind: SpanKindV02;
  raw: string;
  startByte: number;
  endByte: number;
  preserveMode: PreserveModeV02;
  parsedName?: string;
  outOfBand?: boolean;
  arguments?: string[];
  variableName?: string;
  formatHint?: string;
  exampleValues?: string[];
  baseStartByte?: number;
  baseEndByte?: number;
  annotationStartByte?: number;
  annotationEndByte?: number;
  annotationText?: string;
  annotationLocale?: Bcp47Locale;
  displayMode?: string;
  policy?: LocalizationPolicyV02;
};

export type ChoiceContextV02 = {
  choiceGroupId: Uuid7;
  choiceId: Uuid7;
  optionIndex: number;
  routeTargetRef?: string;
};

export type UiContextV02 = {
  uiArea: UiAreaV02;
  controlRef?: string;
  layoutConstraint?: string;
};

export type TutorialContextV02 = {
  tutorialStepRef: string;
  inputActionRefs?: string[];
  platformCondition?: string;
};

export type DatabaseContextV02 = {
  databaseKind: DatabaseKindV02;
  entryId: string;
  fieldKey: string;
  sortKey?: string;
};

export type SongContextV02 = {
  audioAssetRef?: AssetRefV02;
  trackId?: string;
  titleField: string;
  creditRefs?: string[];
};

export type ImageTextContextV02 = {
  region: PixelRegionV02;
  ocrText?: string;
  editable: boolean;
  replacementMode: ImageReplacementModeV02;
};

export type MetadataContextV02 = {
  metadataScope: MetadataScopeV02;
  fieldKey: string;
  visibility: MetadataVisibilityV02;
};

export type SpeakerNameContextV02 = {
  displayContext: SpeakerNameDisplayContextV02;
  canonicalNameRef?: string;
};

export type SurfaceContextV02 = {
  route?: RouteContextV02;
  choice?: ChoiceContextV02;
  ui?: UiContextV02;
  tutorial?: TutorialContextV02;
  database?: DatabaseContextV02;
  song?: SongContextV02;
  imageText?: ImageTextContextV02;
  metadata?: MetadataContextV02;
  speakerName?: SpeakerNameContextV02;
};

export type RuntimeExpectationV02 = {
  expectationKind: RuntimeExpectationKindV02;
  region?: PixelRegionV02;
  traceKey?: string;
};

export type RuntimeBridgeUnitRefV02 = {
  bridgeUnitId: string;
  sourceUnitKey?: string;
};

export type RuntimeArtifactRefV02 = {
  artifactId: Uuid7;
  artifactKind: RuntimeArtifactKindV02;
  uri: string;
  hash?: string;
  mediaType?: string;
  byteSize?: number;
};

export type RuntimeTraceEventV02 = {
  traceEventId: Uuid7;
  eventKind: RuntimeTraceEventKindV02;
  bridgeUnitRef: RuntimeBridgeUnitRefV02;
  frame: number;
  traceKey?: string;
  observedText?: string;
  artifactRef?: RuntimeArtifactRefV02;
};

export type RuntimeBranchOptionV02 = {
  optionId: Uuid7;
  label?: string;
  labelBridgeUnitRef?: RuntimeBridgeUnitRefV02;
  targetRouteKey?: string;
  targetBridgeUnitRef?: RuntimeBridgeUnitRefV02;
};

export type RuntimeBranchPointEventV02 = {
  branchEventId: Uuid7;
  bridgeUnitRef: RuntimeBridgeUnitRefV02;
  frame: number;
  branchPointKey?: string;
  promptText?: string;
  options: RuntimeBranchOptionV02[];
  selectedOptionId?: Uuid7;
};

export type RuntimeCaptureV02 = {
  captureId: Uuid7;
  bridgeUnitRef: RuntimeBridgeUnitRefV02;
  evidenceTier: RuntimeEvidenceTierV02;
  frame: number;
  width: number;
  height: number;
  nonZeroPixels?: number;
  region?: PixelRegionV02;
  artifactRef: RuntimeArtifactRefV02 & { artifactKind: "screenshot" };
};

export type RuntimeRecordingV02 = {
  recordingId: Uuid7;
  bridgeUnitRef: RuntimeBridgeUnitRefV02;
  evidenceTier: RuntimeEvidenceTierV02;
  startedAtFrame: number;
  frameCount: number;
  width: number;
  height: number;
  encoding: string;
  artifactRef: RuntimeArtifactRefV02 & { artifactKind: "recording" };
};

export type RuntimeApproximationV02 = {
  approximationId: Uuid7;
  approximationTier: RuntimeApproximationTierV02;
  scope: string;
  description: string;
  affectedBridgeUnitRefs: RuntimeBridgeUnitRefV02[];
  evidenceTierCeiling: RuntimeEvidenceTierV02;
};

export type RuntimeValidationFindingV02 = {
  findingId: Uuid7;
  findingKind: RuntimeValidationFindingKindV02;
  severity: TriageSeverityV02;
  bridgeUnitRef?: RuntimeBridgeUnitRefV02;
  artifactRef?: RuntimeArtifactRefV02;
  message: string;
  evidenceTier: RuntimeEvidenceTierV02;
};

export type RuntimeReferenceComparisonV02 = {
  comparisonId: Uuid7;
  comparisonKind: RuntimeReferenceComparisonKindV02;
  status: RuntimeReferenceComparisonStatusV02;
  scope: string;
  coveredBridgeUnitRefs: RuntimeBridgeUnitRefV02[];
  artifactRef: RuntimeArtifactRefV02 & { artifactKind: "reference_comparison" };
};

export type PatchRefV02 = {
  assetId: Uuid7;
  writeMode: PatchWriteModeV02;
  sourceUnitKey: string;
  sourceRevision: SourceRevisionV02;
  constraints?: string[];
};

export type AssetPolicyPatchRefV02 = {
  assetId: Uuid7;
  writeMode: PatchWriteModeV02;
  sourceUnitKey?: string;
  sourceRevision: SourceRevisionV02;
  constraints?: string[];
};
