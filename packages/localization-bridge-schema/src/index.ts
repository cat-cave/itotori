export type Uuid7 = string;
export type Bcp47Locale = string;

export type TextSurface = "dialogue" | "system";
export type ProtectedSpanKind = "placeholder";
export type PreserveMode = "exact";
export type PatchWriteMode = "replace";
export type RuntimeFidelityTier = "trace_only" | "layout_probe";

export type ProtectedSpan = {
  kind: ProtectedSpanKind;
  raw: string;
  start: number;
  end: number;
  preserveMode: PreserveMode;
};

export type BridgeUnit = {
  bridgeUnitId: Uuid7;
  sourceUnitKey: string;
  occurrenceId: string;
  sourceHash: string;
  sourceLocale: Bcp47Locale;
  sourceText: string;
  speaker?: string;
  textSurface: TextSurface;
  protectedSpans: ProtectedSpan[];
  patchRef: {
    assetId: string;
    writeMode: PatchWriteMode;
    sourceUnitKey: string;
  };
};

export type BridgeBundle = {
  schemaVersion: "0.1.0";
  bridgeId: Uuid7;
  sourceBundleHash: string;
  sourceLocale: Bcp47Locale;
  extractorName: "kaifuu-fixture";
  extractorVersion: string;
  units: BridgeUnit[];
};

export type PatchExportEntry = {
  entryId: Uuid7;
  bridgeUnitId: Uuid7;
  sourceUnitKey: string;
  sourceHash: string;
  targetText: string;
  protectedSpanMappings: Array<{ raw: string; targetStart: number; targetEnd: number }>;
};

export type PatchExport = {
  schemaVersion: "0.1.0";
  patchExportId: Uuid7;
  sourceBridgeId: Uuid7;
  sourceBundleHash: string;
  sourceLocale: Bcp47Locale;
  targetLocale: Bcp47Locale;
  entries: PatchExportEntry[];
};

export type PatchResult = {
  schemaVersion: "0.1.0";
  patchResultId: Uuid7;
  patchExportId?: Uuid7;
  status: "passed" | "failed";
  outputHash: string;
  failures: string[];
};

export type RuntimeTextEvent = {
  runtimeTextEventId: Uuid7;
  bridgeUnitId: Uuid7;
  text: string;
  frame: number;
};

export type FrameCapture = {
  frameCaptureId: Uuid7;
  bridgeUnitId: Uuid7;
  width: number;
  height: number;
  nonZeroPixels: number;
  artifactPath: string;
};

export type RuntimeVerificationReport = {
  schemaVersion: "0.1.0";
  runtimeReportId: Uuid7;
  adapterName: "utsushi-fixture";
  fidelityTier: RuntimeFidelityTier;
  status: "passed" | "failed";
  textEvents: RuntimeTextEvent[];
  frameCaptures: FrameCapture[];
  approximations: string[];
};

export const BRIDGE_SCHEMA_VERSION_V02 = "0.2.0" as const;

export const ASSET_KINDS = [
  "script",
  "image",
  "audio",
  "video",
  "ui_texture",
  "database",
  "metadata",
  "text",
] as const;
export type AssetKindV02 = (typeof ASSET_KINDS)[number];

export const SURFACE_KINDS = [
  "dialogue",
  "narration",
  "speaker_name",
  "choice_label",
  "ui_label",
  "tutorial_text",
  "database_entry",
  "song_title",
  "image_text",
  "metadata_text",
] as const;
export type SurfaceKindV02 = (typeof SURFACE_KINDS)[number];

export const SPAN_KINDS = ["control_markup", "variable_placeholder", "ruby_annotation"] as const;
export type SpanKindV02 = (typeof SPAN_KINDS)[number];

export const PRESERVE_MODES = ["exact", "map", "transform", "locale_policy"] as const;
export type PreserveModeV02 = (typeof PRESERVE_MODES)[number];

export const POLICY_ACTIONS = ["localize", "romanize", "do_not_translate"] as const;
export type PolicyActionV02 = (typeof POLICY_ACTIONS)[number];

export const POLICY_RECORD_KINDS = ["romanized_term", "non_translated_term"] as const;
export type PolicyRecordKindV02 = (typeof POLICY_RECORD_KINDS)[number];

export const POLICY_SCOPES = SURFACE_KINDS;
export type PolicyScopeV02 = SurfaceKindV02;

export const PATCH_WRITE_MODES = [
  "replace",
  "insert",
  "update_region",
  "replace_asset",
  "metadata",
] as const;
export type PatchWriteModeV02 = (typeof PATCH_WRITE_MODES)[number];

export const SOURCE_REVISION_KINDS = [
  "content_hash",
  "source_control",
  "build",
  "manual_snapshot",
] as const;
export type SourceRevisionKindV02 = (typeof SOURCE_REVISION_KINDS)[number];

export const RUNTIME_EXPECTATION_KINDS = [
  "trace_text",
  "layout_probe",
  "screenshot_region",
  "metadata_only",
] as const;
export type RuntimeExpectationKindV02 = (typeof RUNTIME_EXPECTATION_KINDS)[number];

export const SPEAKER_KNOWLEDGE_STATES = [
  "known",
  "parser_unknown",
  "reader_unknown",
  "not_applicable",
] as const;
export type SpeakerKnowledgeStateV02 = (typeof SPEAKER_KNOWLEDGE_STATES)[number];

export const UI_AREAS = [
  "dialogue_window",
  "menu",
  "hud",
  "settings",
  "save_load",
  "battle",
  "status",
  "system",
] as const;
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

export type SourceRevisionV02 = {
  revisionId: Uuid7;
  revisionKind: SourceRevisionKindV02;
  value: string;
  createdAt?: string;
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
  sceneId?: Uuid7;
  sceneKey?: string;
  branchId?: Uuid7;
  branchKey?: string;
  position?: string;
};

export type SpeakerContextV02 =
  | {
      knowledgeState: "known";
      speakerId: Uuid7;
      displayName: string;
      canonicalNameRef?: string;
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

export type PatchRefV02 = {
  assetId: Uuid7;
  writeMode: PatchWriteModeV02;
  sourceUnitKey: string;
  sourceRevision: SourceRevisionV02;
  constraints?: string[];
};

export type LocalizationUnitV02 = {
  bridgeUnitId: Uuid7;
  surfaceId: Uuid7;
  surfaceKind: SurfaceKindV02;
  sourceUnitKey: string;
  occurrenceId: string;
  sourceLocale: Bcp47Locale;
  sourceText: string;
  sourceHash: string;
  sourceRevision: SourceRevisionV02;
  sourceAssetRef: AssetRefV02;
  sourceLocation: SourceLocationV02;
  speaker?: SpeakerContextV02;
  context: SurfaceContextV02;
  policy?: LocalizationPolicyV02;
  spans: BridgeSpanV02[];
  patchRef: PatchRefV02;
  runtimeExpectation: RuntimeExpectationV02;
};

export type PolicyRecordV02 = {
  policyRecordId: Uuid7;
  policyRecordKind: PolicyRecordKindV02;
  policyAction: PolicyActionV02;
  termKey: string;
  sourceText: string;
  targetLocale?: Bcp47Locale;
  localeBranchId?: Uuid7;
  romanizationSystem?: string;
  preserveForm?: string;
  scope?: PolicyScopeV02;
  policyReason: string;
  reviewRequired?: boolean;
};

export type BridgeBundleV02 = {
  schemaVersion: typeof BRIDGE_SCHEMA_VERSION_V02;
  bridgeId: Uuid7;
  sourceBundleHash: string;
  sourceLocale: Bcp47Locale;
  extractor: {
    name: string;
    version: string;
  };
  assets: BridgeAssetV02[];
  units: LocalizationUnitV02[];
  policyRecords: PolicyRecordV02[];
};

export function assertBridgeBundle(value: unknown): asserts value is BridgeBundle {
  const bundle = asRecord(value, "BridgeBundle");
  assertEqual(bundle.schemaVersion, "0.1.0", "BridgeBundle.schemaVersion");
  assertString(bundle.bridgeId, "BridgeBundle.bridgeId");
  assertString(bundle.sourceBundleHash, "BridgeBundle.sourceBundleHash");
  assertString(bundle.sourceLocale, "BridgeBundle.sourceLocale");
  assertArray(bundle.units, "BridgeBundle.units");
}

export function assertBridgeBundleV02(value: unknown): asserts value is BridgeBundleV02 {
  const bundle = asRecord(value, "BridgeBundleV02");
  assertEqual(bundle.schemaVersion, BRIDGE_SCHEMA_VERSION_V02, "BridgeBundleV02.schemaVersion");
  assertUuid7(bundle.bridgeId, "BridgeBundleV02.bridgeId");
  assertString(bundle.sourceBundleHash, "BridgeBundleV02.sourceBundleHash");
  assertString(bundle.sourceLocale, "BridgeBundleV02.sourceLocale");
  assertExtractor(bundle.extractor, "BridgeBundleV02.extractor");

  const assets = asArray(bundle.assets, "BridgeBundleV02.assets");
  const assetIds = new Set<Uuid7>();
  for (const [index, asset] of assets.entries()) {
    const label = `BridgeBundleV02.assets[${index}]`;
    assertBridgeAssetV02(asset, label);
    if (assetIds.has(asset.assetId)) {
      throw new Error(`${label}.assetId must be unique within BridgeBundleV02.assets`);
    }
    assetIds.add(asset.assetId);
  }

  const units = asArray(bundle.units, "BridgeBundleV02.units");
  for (const [index, unit] of units.entries()) {
    const label = `BridgeBundleV02.units[${index}]`;
    assertLocalizationUnitV02(unit, label);
    assertLocalizationUnitAssetRefsExist(unit, label, assetIds);
  }

  const policyRecords = asArray(bundle.policyRecords, "BridgeBundleV02.policyRecords");
  for (const [index, record] of policyRecords.entries()) {
    assertPolicyRecordV02(record, `BridgeBundleV02.policyRecords[${index}]`);
  }
}

export function assertPatchExport(value: unknown): asserts value is PatchExport {
  const patch = asRecord(value, "PatchExport");
  assertEqual(patch.schemaVersion, "0.1.0", "PatchExport.schemaVersion");
  assertString(patch.patchExportId, "PatchExport.patchExportId");
  assertString(patch.sourceBridgeId, "PatchExport.sourceBridgeId");
  assertString(patch.targetLocale, "PatchExport.targetLocale");
  assertArray(patch.entries, "PatchExport.entries");
}

export function assertRuntimeVerificationReport(
  value: unknown,
): asserts value is RuntimeVerificationReport {
  const report = asRecord(value, "RuntimeVerificationReport");
  assertEqual(report.schemaVersion, "0.1.0", "RuntimeVerificationReport.schemaVersion");
  assertString(report.runtimeReportId, "RuntimeVerificationReport.runtimeReportId");
  assertArray(report.textEvents, "RuntimeVerificationReport.textEvents");
  assertArray(report.frameCaptures, "RuntimeVerificationReport.frameCaptures");
}

export function isUuid7(value: unknown): value is Uuid7 {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}

function assertBridgeAssetV02(value: unknown, label: string): asserts value is BridgeAssetV02 {
  const asset = asRecord(value, label);
  assertUuid7(asset.assetId, `${label}.assetId`);
  assertString(asset.assetKey, `${label}.assetKey`);
  assertEnum(asset.assetKind, ASSET_KINDS, `${label}.assetKind`);
  assertString(asset.sourceHash, `${label}.sourceHash`);
  assertSourceRevisionV02(asset.sourceRevision, `${label}.sourceRevision`);
  assertOptionalString(asset.path, `${label}.path`);
}

function assertLocalizationUnitV02(
  value: unknown,
  label: string,
): asserts value is LocalizationUnitV02 {
  const unit = asRecord(value, label);
  assertUuid7(unit.bridgeUnitId, `${label}.bridgeUnitId`);
  assertUuid7(unit.surfaceId, `${label}.surfaceId`);
  assertEnum(unit.surfaceKind, SURFACE_KINDS, `${label}.surfaceKind`);
  assertString(unit.sourceUnitKey, `${label}.sourceUnitKey`);
  assertString(unit.occurrenceId, `${label}.occurrenceId`);
  assertString(unit.sourceLocale, `${label}.sourceLocale`);
  assertString(unit.sourceText, `${label}.sourceText`);
  assertString(unit.sourceHash, `${label}.sourceHash`);
  assertSourceRevisionV02(unit.sourceRevision, `${label}.sourceRevision`);
  assertAssetRefV02(unit.sourceAssetRef, `${label}.sourceAssetRef`);
  assertSourceLocationV02(unit.sourceLocation, `${label}.sourceLocation`);
  if (unit.speaker !== undefined) {
    assertSpeakerContextV02(unit.speaker, `${label}.speaker`);
  }
  assertSurfaceContextV02(unit.context, `${label}.context`, unit.surfaceKind);
  if (unit.policy !== undefined) {
    assertLocalizationPolicyV02(unit.policy, `${label}.policy`);
  }
  const spans = asArray(unit.spans, `${label}.spans`);
  for (const [index, span] of spans.entries()) {
    assertBridgeSpanV02(span, `${label}.spans[${index}]`, unit.sourceText);
  }
  assertPatchRefV02(unit.patchRef, `${label}.patchRef`);
  assertRuntimeExpectationV02(unit.runtimeExpectation, `${label}.runtimeExpectation`);
}

function assertLocalizationUnitAssetRefsExist(
  unit: LocalizationUnitV02,
  label: string,
  assetIds: ReadonlySet<Uuid7>,
): void {
  assertKnownAssetIdV02(unit.sourceAssetRef.assetId, `${label}.sourceAssetRef.assetId`, assetIds);
  assertKnownAssetIdV02(unit.patchRef.assetId, `${label}.patchRef.assetId`, assetIds);

  const audioAssetRef = unit.context.song?.audioAssetRef;
  if (audioAssetRef !== undefined) {
    assertKnownAssetIdV02(
      audioAssetRef.assetId,
      `${label}.context.song.audioAssetRef.assetId`,
      assetIds,
    );
  }
}

function assertKnownAssetIdV02(assetId: Uuid7, label: string, assetIds: ReadonlySet<Uuid7>): void {
  if (!assetIds.has(assetId)) {
    throw new Error(`${label} must reference an asset in BridgeBundleV02.assets`);
  }
}

function assertSourceRevisionV02(
  value: unknown,
  label: string,
): asserts value is SourceRevisionV02 {
  const revision = asRecord(value, label);
  assertUuid7(revision.revisionId, `${label}.revisionId`);
  assertEnum(revision.revisionKind, SOURCE_REVISION_KINDS, `${label}.revisionKind`);
  assertString(revision.value, `${label}.value`);
  assertOptionalString(revision.createdAt, `${label}.createdAt`);
}

function assertAssetRefV02(value: unknown, label: string): asserts value is AssetRefV02 {
  const ref = asRecord(value, label);
  assertUuid7(ref.assetId, `${label}.assetId`);
  assertOptionalString(ref.assetKey, `${label}.assetKey`);
}

function assertSourceLocationV02(
  value: unknown,
  label: string,
): asserts value is SourceLocationV02 {
  const location = asRecord(value, label);
  assertOptionalString(location.containerKey, `${label}.containerKey`);
  if (location.entryPath !== undefined) {
    assertStringArray(location.entryPath, `${label}.entryPath`);
  }
  if (location.range !== undefined) {
    assertByteRangeV02(location.range, `${label}.range`);
  }
  if (location.region !== undefined) {
    assertPixelRegionV02(location.region, `${label}.region`);
  }
}

function assertSpeakerContextV02(
  value: unknown,
  label: string,
): asserts value is SpeakerContextV02 {
  const speaker = asRecord(value, label);
  assertEnum(speaker.knowledgeState, SPEAKER_KNOWLEDGE_STATES, `${label}.knowledgeState`);
  switch (speaker.knowledgeState) {
    case "known":
      assertUuid7(speaker.speakerId, `${label}.speakerId`);
      assertString(speaker.displayName, `${label}.displayName`);
      assertOptionalString(speaker.canonicalNameRef, `${label}.canonicalNameRef`);
      break;
    case "parser_unknown":
      assertOptionalString(speaker.rawSpeakerText, `${label}.rawSpeakerText`);
      assertOptionalString(speaker.evidence, `${label}.evidence`);
      break;
    case "reader_unknown":
      assertUuid7(speaker.speakerId, `${label}.speakerId`);
      assertString(speaker.displayName, `${label}.displayName`);
      assertString(speaker.readerLabel, `${label}.readerLabel`);
      assertOptionalString(speaker.canonicalNameRef, `${label}.canonicalNameRef`);
      break;
    case "not_applicable":
      break;
  }
}

function assertLocalizationPolicyV02(
  value: unknown,
  label: string,
): asserts value is LocalizationPolicyV02 {
  const policy = asRecord(value, label);
  assertEnum(policy.policyAction, POLICY_ACTIONS, `${label}.policyAction`);
  assertOptionalString(policy.targetLocale, `${label}.targetLocale`);
  assertOptionalUuid7(policy.localeBranchId, `${label}.localeBranchId`);
  assertOptionalString(policy.targetText, `${label}.targetText`);
  assertOptionalString(policy.romanizationSystem, `${label}.romanizationSystem`);
  assertOptionalString(policy.policyReason, `${label}.policyReason`);
  if (policy.targetLocale === undefined && policy.localeBranchId === undefined) {
    throw new Error(`${label} must include targetLocale or localeBranchId`);
  }
}

function assertBridgeSpanV02(
  value: unknown,
  label: string,
  sourceText: string,
): asserts value is BridgeSpanV02 {
  const span = asRecord(value, label);
  assertUuid7(span.spanId, `${label}.spanId`);
  assertEnum(span.spanKind, SPAN_KINDS, `${label}.spanKind`);
  assertString(span.raw, `${label}.raw`);
  const [startByte, endByte] = asByteRangeNumbers(span.startByte, span.endByte, label);
  assertEnum(span.preserveMode, PRESERVE_MODES, `${label}.preserveMode`);
  assertOptionalString(span.parsedName, `${label}.parsedName`);
  if (span.arguments !== undefined) {
    assertStringArray(span.arguments, `${label}.arguments`);
  }
  assertOptionalString(span.variableName, `${label}.variableName`);
  assertOptionalString(span.formatHint, `${label}.formatHint`);
  if (span.exampleValues !== undefined) {
    assertStringArray(span.exampleValues, `${label}.exampleValues`);
  }
  if (span.policy !== undefined) {
    assertLocalizationPolicyV02(span.policy, `${label}.policy`);
  }
  assertSpanRawMatchesSource(sourceText, span.raw, startByte, endByte, label);

  if (span.spanKind === "ruby_annotation") {
    asByteRangeNumbers(span.baseStartByte, span.baseEndByte, `${label}.base`);
    asByteRangeNumbers(span.annotationStartByte, span.annotationEndByte, `${label}.annotation`);
    assertString(span.annotationText, `${label}.annotationText`);
    assertOptionalString(span.annotationLocale, `${label}.annotationLocale`);
    assertOptionalString(span.displayMode, `${label}.displayMode`);
  }
}

function assertSurfaceContextV02(
  value: unknown,
  label: string,
  surfaceKind: SurfaceKindV02,
): asserts value is SurfaceContextV02 {
  const context = asRecord(value, label);
  if (context.route !== undefined) {
    assertRouteContextV02(context.route, `${label}.route`);
  }
  if (context.choice !== undefined) {
    assertChoiceContextV02(context.choice, `${label}.choice`);
  }
  if (context.ui !== undefined) {
    assertUiContextV02(context.ui, `${label}.ui`);
  }
  if (context.tutorial !== undefined) {
    assertTutorialContextV02(context.tutorial, `${label}.tutorial`);
  }
  if (context.database !== undefined) {
    assertDatabaseContextV02(context.database, `${label}.database`);
  }
  if (context.song !== undefined) {
    assertSongContextV02(context.song, `${label}.song`);
  }
  if (context.imageText !== undefined) {
    assertImageTextContextV02(context.imageText, `${label}.imageText`);
  }
  if (context.metadata !== undefined) {
    assertMetadataContextV02(context.metadata, `${label}.metadata`);
  }
  if (context.speakerName !== undefined) {
    assertSpeakerNameContextV02(context.speakerName, `${label}.speakerName`);
  }

  assertContextForSurfaceKind(context, surfaceKind, label);
}

function assertContextForSurfaceKind(
  context: Record<string, unknown>,
  surfaceKind: SurfaceKindV02,
  label: string,
): void {
  const requiredContexts: Partial<Record<SurfaceKindV02, keyof SurfaceContextV02>> = {
    choice_label: "choice",
    ui_label: "ui",
    tutorial_text: "tutorial",
    database_entry: "database",
    song_title: "song",
    image_text: "imageText",
    metadata_text: "metadata",
    speaker_name: "speakerName",
  };
  const requiredContext = requiredContexts[surfaceKind];
  if (requiredContext !== undefined && context[requiredContext] === undefined) {
    throw new Error(`${label}.${requiredContext} is required for ${surfaceKind}`);
  }
}

function assertRouteContextV02(value: unknown, label: string): asserts value is RouteContextV02 {
  const route = asRecord(value, label);
  assertOptionalUuid7(route.routeId, `${label}.routeId`);
  assertOptionalString(route.routeKey, `${label}.routeKey`);
  assertOptionalUuid7(route.sceneId, `${label}.sceneId`);
  assertOptionalString(route.sceneKey, `${label}.sceneKey`);
  assertOptionalUuid7(route.branchId, `${label}.branchId`);
  assertOptionalString(route.branchKey, `${label}.branchKey`);
  assertOptionalString(route.position, `${label}.position`);
}

function assertChoiceContextV02(value: unknown, label: string): asserts value is ChoiceContextV02 {
  const choice = asRecord(value, label);
  assertUuid7(choice.choiceGroupId, `${label}.choiceGroupId`);
  assertUuid7(choice.choiceId, `${label}.choiceId`);
  assertNonNegativeInteger(choice.optionIndex, `${label}.optionIndex`);
  assertOptionalString(choice.routeTargetRef, `${label}.routeTargetRef`);
}

function assertUiContextV02(value: unknown, label: string): asserts value is UiContextV02 {
  const ui = asRecord(value, label);
  assertEnum(ui.uiArea, UI_AREAS, `${label}.uiArea`);
  assertOptionalString(ui.controlRef, `${label}.controlRef`);
  assertOptionalString(ui.layoutConstraint, `${label}.layoutConstraint`);
}

function assertTutorialContextV02(
  value: unknown,
  label: string,
): asserts value is TutorialContextV02 {
  const tutorial = asRecord(value, label);
  assertString(tutorial.tutorialStepRef, `${label}.tutorialStepRef`);
  if (tutorial.inputActionRefs !== undefined) {
    assertStringArray(tutorial.inputActionRefs, `${label}.inputActionRefs`);
  }
  assertOptionalString(tutorial.platformCondition, `${label}.platformCondition`);
}

function assertDatabaseContextV02(
  value: unknown,
  label: string,
): asserts value is DatabaseContextV02 {
  const database = asRecord(value, label);
  assertEnum(database.databaseKind, DATABASE_KINDS, `${label}.databaseKind`);
  assertString(database.entryId, `${label}.entryId`);
  assertString(database.fieldKey, `${label}.fieldKey`);
  assertOptionalString(database.sortKey, `${label}.sortKey`);
}

function assertSongContextV02(value: unknown, label: string): asserts value is SongContextV02 {
  const song = asRecord(value, label);
  if (song.audioAssetRef !== undefined) {
    assertAssetRefV02(song.audioAssetRef, `${label}.audioAssetRef`);
  }
  assertOptionalString(song.trackId, `${label}.trackId`);
  assertString(song.titleField, `${label}.titleField`);
  if (song.creditRefs !== undefined) {
    assertStringArray(song.creditRefs, `${label}.creditRefs`);
  }
}

function assertImageTextContextV02(
  value: unknown,
  label: string,
): asserts value is ImageTextContextV02 {
  const imageText = asRecord(value, label);
  assertPixelRegionV02(imageText.region, `${label}.region`);
  assertOptionalString(imageText.ocrText, `${label}.ocrText`);
  assertBoolean(imageText.editable, `${label}.editable`);
  assertEnum(imageText.replacementMode, IMAGE_REPLACEMENT_MODES, `${label}.replacementMode`);
}

function assertMetadataContextV02(
  value: unknown,
  label: string,
): asserts value is MetadataContextV02 {
  const metadata = asRecord(value, label);
  assertEnum(metadata.metadataScope, METADATA_SCOPES, `${label}.metadataScope`);
  assertString(metadata.fieldKey, `${label}.fieldKey`);
  assertEnum(metadata.visibility, METADATA_VISIBILITIES, `${label}.visibility`);
}

function assertSpeakerNameContextV02(
  value: unknown,
  label: string,
): asserts value is SpeakerNameContextV02 {
  const speakerName = asRecord(value, label);
  assertEnum(speakerName.displayContext, SPEAKER_NAME_DISPLAY_CONTEXTS, `${label}.displayContext`);
  assertOptionalString(speakerName.canonicalNameRef, `${label}.canonicalNameRef`);
}

function assertRuntimeExpectationV02(
  value: unknown,
  label: string,
): asserts value is RuntimeExpectationV02 {
  const expectation = asRecord(value, label);
  assertEnum(expectation.expectationKind, RUNTIME_EXPECTATION_KINDS, `${label}.expectationKind`);
  if (expectation.region !== undefined) {
    assertPixelRegionV02(expectation.region, `${label}.region`);
  }
  assertOptionalString(expectation.traceKey, `${label}.traceKey`);
}

function assertPatchRefV02(value: unknown, label: string): asserts value is PatchRefV02 {
  const patchRef = asRecord(value, label);
  assertUuid7(patchRef.assetId, `${label}.assetId`);
  assertEnum(patchRef.writeMode, PATCH_WRITE_MODES, `${label}.writeMode`);
  assertString(patchRef.sourceUnitKey, `${label}.sourceUnitKey`);
  assertSourceRevisionV02(patchRef.sourceRevision, `${label}.sourceRevision`);
  if (patchRef.constraints !== undefined) {
    assertStringArray(patchRef.constraints, `${label}.constraints`);
  }
}

function assertPolicyRecordV02(value: unknown, label: string): asserts value is PolicyRecordV02 {
  const record = asRecord(value, label);
  assertUuid7(record.policyRecordId, `${label}.policyRecordId`);
  assertEnum(record.policyRecordKind, POLICY_RECORD_KINDS, `${label}.policyRecordKind`);
  assertEnum(record.policyAction, POLICY_ACTIONS, `${label}.policyAction`);
  assertString(record.termKey, `${label}.termKey`);
  assertString(record.sourceText, `${label}.sourceText`);
  assertOptionalString(record.targetLocale, `${label}.targetLocale`);
  assertOptionalUuid7(record.localeBranchId, `${label}.localeBranchId`);
  assertOptionalString(record.romanizationSystem, `${label}.romanizationSystem`);
  assertOptionalString(record.preserveForm, `${label}.preserveForm`);
  if (record.scope !== undefined) {
    assertEnum(record.scope, POLICY_SCOPES, `${label}.scope`);
  }
  assertString(record.policyReason, `${label}.policyReason`);
  if (record.reviewRequired !== undefined) {
    assertBoolean(record.reviewRequired, `${label}.reviewRequired`);
  }
  if (record.targetLocale === undefined && record.localeBranchId === undefined) {
    throw new Error(`${label} must include targetLocale or localeBranchId`);
  }
}

function assertExtractor(value: unknown, label: string): void {
  const extractor = asRecord(value, label);
  assertString(extractor.name, `${label}.name`);
  assertString(extractor.version, `${label}.version`);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertOptionalString(value: unknown, label: string): asserts value is string | undefined {
  if (value !== undefined) {
    assertString(value, label);
  }
}

function assertArray(value: unknown, label: string): void {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  const array = asArray(value, label);
  for (const [index, item] of array.entries()) {
    assertString(item, `${label}[${index}]`);
  }
}

function assertEqual(value: unknown, expected: string, label: string): void {
  if (value !== expected) {
    throw new Error(`${label} must be ${expected}`);
  }
}

function assertUuid7(value: unknown, label: string): asserts value is Uuid7 {
  if (!isUuid7(value)) {
    throw new Error(`${label} must be a UUID7 string`);
  }
}

function assertOptionalUuid7(value: unknown, label: string): asserts value is Uuid7 | undefined {
  if (value !== undefined) {
    assertUuid7(value, label);
  }
}

function assertEnum<T extends string>(
  value: unknown,
  allowedValues: readonly T[],
  label: string,
): asserts value is T {
  if (typeof value !== "string" || !allowedValues.includes(value as T)) {
    throw new Error(`${label} must be one of: ${allowedValues.join(", ")}`);
  }
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
}

function assertBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
}

function assertByteRangeV02(value: unknown, label: string): asserts value is ByteRangeV02 {
  const range = asRecord(value, label);
  asByteRangeNumbers(range.startByte, range.endByte, label);
}

function asByteRangeNumbers(startByte: unknown, endByte: unknown, label: string): [number, number] {
  assertNonNegativeInteger(startByte, `${label}.startByte`);
  assertNonNegativeInteger(endByte, `${label}.endByte`);
  if ((endByte as number) <= startByte) {
    throw new Error(`${label}.endByte must be greater than ${label}.startByte`);
  }
  return [startByte, endByte as number];
}

function assertPixelRegionV02(value: unknown, label: string): asserts value is PixelRegionV02 {
  const region = asRecord(value, label);
  assertNonNegativeInteger(region.x, `${label}.x`);
  assertNonNegativeInteger(region.y, `${label}.y`);
  assertPositiveInteger(region.width, `${label}.width`);
  assertPositiveInteger(region.height, `${label}.height`);
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function assertSpanRawMatchesSource(
  sourceText: string,
  raw: string,
  startByte: number,
  endByte: number,
  label: string,
): void {
  const sourceBytes = Buffer.from(sourceText, "utf8");
  if (endByte > sourceBytes.length) {
    throw new Error(`${label}.endByte must be within sourceText UTF-8 bytes`);
  }
  const spanText = sourceBytes.subarray(startByte, endByte).toString("utf8");
  if (spanText !== raw) {
    throw new Error(`${label}.raw must match sourceText byte range`);
  }
}
