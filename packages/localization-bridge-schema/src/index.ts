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

export const RUNTIME_FIDELITY_TIERS_V02 = [
  "trace_only",
  "layout_probe",
  "replay_review",
  "reference_fidelity",
] as const;
export type RuntimeFidelityTierV02 = (typeof RUNTIME_FIDELITY_TIERS_V02)[number];

export const RUNTIME_EVIDENCE_TIERS_V02 = ["E0", "E1", "E2", "E3", "E4"] as const;
export type RuntimeEvidenceTierV02 = (typeof RUNTIME_EVIDENCE_TIERS_V02)[number];

export const RUNTIME_ARTIFACT_KINDS_V02 = [
  "trace_log",
  "screenshot",
  "recording",
  "capture_metadata",
  "reference_comparison",
  "runtime_report",
] as const;
export type RuntimeArtifactKindV02 = (typeof RUNTIME_ARTIFACT_KINDS_V02)[number];

export const RUNTIME_TRACE_EVENT_KINDS_V02 = [
  "scene_entered",
  "text_observed",
  "branch_point_reached",
  "capture_requested",
] as const;
export type RuntimeTraceEventKindV02 = (typeof RUNTIME_TRACE_EVENT_KINDS_V02)[number];

export const RUNTIME_APPROXIMATION_TIERS_V02 = [
  "none",
  "deterministic_fixture",
  "layout_probe",
  "engine_partial",
  "reference_matched",
] as const;
export type RuntimeApproximationTierV02 = (typeof RUNTIME_APPROXIMATION_TIERS_V02)[number];

export const RUNTIME_VALIDATION_FINDING_KINDS_V02 = [
  "missing_trace",
  "missing_capture",
  "text_mismatch",
  "artifact_unreadable",
  "unsupported_runtime_feature",
  "schema_violation",
] as const;
export type RuntimeValidationFindingKindV02 = (typeof RUNTIME_VALIDATION_FINDING_KINDS_V02)[number];

export const RUNTIME_REFERENCE_COMPARISON_KINDS_V02 = [
  "reference_runtime",
  "conformance_fixture",
] as const;
export type RuntimeReferenceComparisonKindV02 =
  (typeof RUNTIME_REFERENCE_COMPARISON_KINDS_V02)[number];

export const RUNTIME_REFERENCE_COMPARISON_STATUSES_V02 = ["passed", "failed"] as const;
export type RuntimeReferenceComparisonStatusV02 =
  (typeof RUNTIME_REFERENCE_COMPARISON_STATUSES_V02)[number];

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

export const TRIAGE_SEVERITIES = ["P0", "P1", "P2", "P3"] as const;
export type TriageSeverityV02 = (typeof TRIAGE_SEVERITIES)[number];

export const LOCALIZATION_QUALITY_CATEGORIES = [
  "accuracy",
  "terminology",
  "style",
  "tone_register",
  "locale_convention",
  "protected_content",
  "layout",
  "technical_integrity",
] as const;
export type LocalizationQualityCategoryV02 = (typeof LOCALIZATION_QUALITY_CATEGORIES)[number];

export const TRIAGE_EVENT_KINDS = [
  "task_requested",
  "task_started",
  "model_output_recorded",
  "qa_finding_reported",
  "patch_result_recorded",
  "triage_decision_recorded",
  "repair_requested",
  "finding_superseded",
] as const;
export type TriageEventKindV02 = (typeof TRIAGE_EVENT_KINDS)[number];

export const TRIAGE_TASK_KINDS = [
  "extract",
  "draft_translation",
  "deterministic_qa",
  "llm_qa",
  "patch",
  "runtime_verify",
  "human_review",
  "repair",
] as const;
export type TriageTaskKindV02 = (typeof TRIAGE_TASK_KINDS)[number];

export const FINDING_KINDS = [
  "source_annotation_issue",
  "style_guide_violation",
  "model_output_issue",
  "patching_issue",
  "runtime_issue",
  "policy_issue",
  "protected_span_issue",
] as const;
export type FindingKindV02 = (typeof FINDING_KINDS)[number];

export const PROVENANCE_KINDS = [
  "source_annotation",
  "style_guide",
  "model_output",
  "patching_cause",
  "runtime_evidence",
  "human_review",
  "deterministic_check",
] as const;
export type ProvenanceKindV02 = (typeof PROVENANCE_KINDS)[number];

export const EVIDENCE_KINDS = [
  "text_excerpt",
  "json_pointer",
  "artifact",
  "trace",
  "screenshot_region",
  "diff",
  "validator_message",
] as const;
export type EvidenceKindV02 = (typeof EVIDENCE_KINDS)[number];

export const TRIAGE_SUBJECT_KINDS = [
  "bridge_unit",
  "bridge_span",
  "asset",
  "source_revision",
  "locale_branch",
  "style_guide_rule",
  "model_output",
  "patch_export",
  "patch_result",
  "runtime_report",
  "artifact",
  "finding",
  "task",
] as const;
export type TriageSubjectKindV02 = (typeof TRIAGE_SUBJECT_KINDS)[number];

export const CAUSAL_LINK_KINDS = [
  "caused_by",
  "derived_from",
  "supersedes",
  "blocks",
  "unblocks",
] as const;
export type CausalLinkKindV02 = (typeof CAUSAL_LINK_KINDS)[number];

export const CAUSAL_TARGET_KINDS = ["event", "task", "finding"] as const;
export type CausalTargetKindV02 = (typeof CAUSAL_TARGET_KINDS)[number];

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

export const HASH_ALGORITHMS = ["sha256"] as const;
export type HashAlgorithmV02 = (typeof HASH_ALGORITHMS)[number];

export const HASH_NORMALIZATIONS = ["utf8-nfc-lf-json-stable-v1", "bytes"] as const;
export type HashNormalizationV02 = (typeof HASH_NORMALIZATIONS)[number];

export const HASH_SCOPES = [
  "source_profile",
  "source_bundle",
  "source_asset",
  "source_unit",
  "patch_export",
  "delta_package",
] as const;
export type HashScopeV02 = (typeof HASH_SCOPES)[number];

export const PATCH_RESULT_STATUSES_V02 = ["passed", "failed", "incompatible_source"] as const;
export type PatchResultStatusV02 = (typeof PATCH_RESULT_STATUSES_V02)[number];

export const PATCH_COMPATIBILITY_STATUSES_V02 = ["compatible", "incompatible"] as const;
export type PatchCompatibilityStatusV02 = (typeof PATCH_COMPATIBILITY_STATUSES_V02)[number];

export const PATCH_INCOMPATIBILITY_REASONS_V02 = [
  "source_hash_mismatch",
  "missing_source_unit",
  "duplicate_source_unit_key",
] as const;
export type PatchIncompatibilityReasonV02 = (typeof PATCH_INCOMPATIBILITY_REASONS_V02)[number];

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

export type TriageActorV02 = {
  actorKind: "human" | "agent" | "tool" | "system";
  actorId?: Uuid7;
  displayName?: string;
};

export type TriageSubjectRefV02 = {
  subjectKind: TriageSubjectKindV02;
  subjectId: Uuid7;
  label?: string;
};

export type TriageArtifactRefV02 = {
  artifactId: Uuid7;
  artifactKind: string;
  uri?: string;
  hash?: string;
};

export type SourceAnnotationProvenanceV02 = {
  provenanceId: Uuid7;
  provenanceKind: "source_annotation";
  bridgeUnitId: Uuid7;
  spanId?: Uuid7;
  sourceAssetRef?: AssetRefV02;
  sourceLocation?: SourceLocationV02;
  annotationText?: string;
  observedAt?: string;
};

export type StyleGuideProvenanceV02 = {
  provenanceId: Uuid7;
  provenanceKind: "style_guide";
  styleGuideId: Uuid7;
  styleGuideVersionId: Uuid7;
  ruleId: string;
  rulePath?: string;
  excerptHash?: string;
};

export type ModelOutputProvenanceV02 = {
  provenanceId: Uuid7;
  provenanceKind: "model_output";
  modelOutputId: Uuid7;
  taskId?: Uuid7;
  provider: string;
  model: string;
  outputHash: string;
  promptHash?: string;
  artifactRef?: TriageArtifactRefV02;
};

export type PatchingCauseProvenanceV02 = {
  provenanceId: Uuid7;
  provenanceKind: "patching_cause";
  patchResultId?: Uuid7;
  patchExportId?: Uuid7;
  bridgeUnitId?: Uuid7;
  assetRef?: AssetRefV02;
  writeMode?: PatchWriteModeV02;
  failureCode?: string;
  failureDetail?: string;
};

export type RuntimeEvidenceProvenanceV02 = {
  provenanceId: Uuid7;
  provenanceKind: "runtime_evidence";
  runtimeReportId: Uuid7;
  bridgeUnitId?: Uuid7;
  artifactRef?: TriageArtifactRefV02;
  evidenceTier?: RuntimeEvidenceTierV02;
};

export type HumanReviewProvenanceV02 = {
  provenanceId: Uuid7;
  provenanceKind: "human_review";
  reviewerId?: Uuid7;
  reviewSessionId?: Uuid7;
  noteHash: string;
};

export type DeterministicCheckProvenanceV02 = {
  provenanceId: Uuid7;
  provenanceKind: "deterministic_check";
  checkId: Uuid7;
  checkName: string;
  checkVersion: string;
  artifactRef?: TriageArtifactRefV02;
};

export type ProvenanceRecordV02 =
  | SourceAnnotationProvenanceV02
  | StyleGuideProvenanceV02
  | ModelOutputProvenanceV02
  | PatchingCauseProvenanceV02
  | RuntimeEvidenceProvenanceV02
  | HumanReviewProvenanceV02
  | DeterministicCheckProvenanceV02;

export type EvidenceRecordV02 = {
  evidenceId: Uuid7;
  evidenceKind: EvidenceKindV02;
  summary: string;
  subjectRef?: TriageSubjectRefV02;
  artifactRef?: TriageArtifactRefV02;
  sourceLocation?: SourceLocationV02;
  expectedValue?: string;
  observedValue?: string;
  provenanceIds: Uuid7[];
};

export type CausalLinkV02 = {
  causalLinkId: Uuid7;
  linkKind: CausalLinkKindV02;
  targetKind: CausalTargetKindV02;
  targetId: Uuid7;
  rationale?: string;
};

export type TriageEventV02 = {
  eventId: Uuid7;
  eventKind: TriageEventKindV02;
  occurredAt: string;
  actor: TriageActorV02;
  taskId?: Uuid7;
  findingId?: Uuid7;
  subjectRefs: TriageSubjectRefV02[];
  provenance: ProvenanceRecordV02[];
  causalLinks: CausalLinkV02[];
  payload?: Record<string, unknown>;
};

export type TriageTaskV02 = {
  taskId: Uuid7;
  taskKind: TriageTaskKindV02;
  createdAt: string;
  summary: string;
  createdByEventId?: Uuid7;
  inputRefs: TriageSubjectRefV02[];
  provenance: ProvenanceRecordV02[];
  causalLinks: CausalLinkV02[];
};

export type FindingRecordV02 = {
  findingId: Uuid7;
  findingKind: FindingKindV02;
  severity: TriageSeverityV02;
  qualityCategory?: LocalizationQualityCategoryV02;
  title: string;
  description: string;
  impact: string;
  createdAt: string;
  reportedByTaskId?: Uuid7;
  firstSeenEventId?: Uuid7;
  affectedRefs: TriageSubjectRefV02[];
  evidence: EvidenceRecordV02[];
  provenance: ProvenanceRecordV02[];
  causalLinks: CausalLinkV02[];
};

export type TriageBundleV02 = {
  schemaVersion: typeof BRIDGE_SCHEMA_VERSION_V02;
  triageBundleId: Uuid7;
  projectId?: Uuid7;
  sourceBridgeId?: Uuid7;
  localeBranchId?: Uuid7;
  events: TriageEventV02[];
  tasks: TriageTaskV02[];
  findings: FindingRecordV02[];
};

type TriageBundleReferenceIndexV02 = {
  eventIds: ReadonlySet<Uuid7>;
  taskIds: ReadonlySet<Uuid7>;
  findingIds: ReadonlySet<Uuid7>;
  provenanceIds: ReadonlySet<Uuid7>;
};

export type BridgeBundleV02 = {
  schemaVersion: typeof BRIDGE_SCHEMA_VERSION_V02;
  bridgeId: Uuid7;
  sourceGame: SourceGameRevisionV02;
  sourceBundleHash: string;
  sourceBundleRevision: SourceRevisionV02;
  sourceLocale: Bcp47Locale;
  hashStrategy: HashStrategyV02;
  extractor: {
    name: string;
    version: string;
  };
  assets: BridgeAssetV02[];
  units: LocalizationUnitV02[];
  policyRecords: PolicyRecordV02[];
};

export type PatchExportEntryV02 = {
  entryId: Uuid7;
  bridgeUnitId: Uuid7;
  sourceUnitKey: string;
  sourceHash: string;
  sourceRevision: SourceRevisionV02;
  targetText: string;
  protectedSpanMappings: Array<{ raw: string; targetStart: number; targetEnd: number }>;
};

export type PatchExportV02 = {
  schemaVersion: typeof BRIDGE_SCHEMA_VERSION_V02;
  patchExportId: Uuid7;
  sourceBridgeId: Uuid7;
  sourceGame: SourceGameRevisionV02;
  sourceBundleHash: string;
  sourceBundleRevision: SourceRevisionV02;
  sourceLocale: Bcp47Locale;
  targetLocale: Bcp47Locale;
  hashStrategy: HashStrategyV02;
  patchExportHash?: string;
  generatedAt?: string;
  entries: PatchExportEntryV02[];
};

export type UnitSourceCompatibilityV02 = {
  entryId: Uuid7;
  bridgeUnitId: Uuid7;
  sourceUnitKey: string;
  status: PatchCompatibilityStatusV02;
  expectedSourceHash: string;
  actualSourceHash?: string;
  reason?: PatchIncompatibilityReasonV02;
};

export type PatchSourceCompatibilityReportV02 = {
  schemaVersion: typeof BRIDGE_SCHEMA_VERSION_V02;
  patchExportId: Uuid7;
  sourceBridgeId: Uuid7;
  status: PatchCompatibilityStatusV02;
  expectedSourceBundleHash: string;
  actualSourceBundleHash: string;
  sourceBundleHashMatches: boolean;
  compatibleUnits: UnitSourceCompatibilityV02[];
  incompatibleUnits: UnitSourceCompatibilityV02[];
};

export type PatchResultV02 = {
  schemaVersion: typeof BRIDGE_SCHEMA_VERSION_V02;
  patchResultId: Uuid7;
  patchExportId: Uuid7;
  status: PatchResultStatusV02;
  outputHash?: string;
  failures: string[];
  sourceCompatibility?: PatchSourceCompatibilityReportV02;
};

export type RuntimeEvidenceReportV02 = {
  schemaVersion: typeof BRIDGE_SCHEMA_VERSION_V02;
  runtimeReportId: Uuid7;
  sourceBridgeId?: Uuid7;
  sourceBundleHash?: string;
  sourceLocale?: Bcp47Locale;
  targetLocale?: Bcp47Locale;
  adapterName: string;
  adapterVersion: string;
  fidelityTier: RuntimeFidelityTierV02;
  evidenceTier: RuntimeEvidenceTierV02;
  status: "passed" | "failed";
  createdAt: string;
  traceEvents: RuntimeTraceEventV02[];
  branchEvents: RuntimeBranchPointEventV02[];
  captures: RuntimeCaptureV02[];
  recordings: RuntimeRecordingV02[];
  approximations: RuntimeApproximationV02[];
  validationFindings: RuntimeValidationFindingV02[];
  referenceComparisons?: RuntimeReferenceComparisonV02[];
  limitations: string[];
};

export type DeltaPackageMetadataV02 = {
  schemaVersion: typeof BRIDGE_SCHEMA_VERSION_V02;
  deltaPackageId: Uuid7;
  sourceBridgeId: Uuid7;
  sourceGame: SourceGameRevisionV02;
  sourceBundleHash: string;
  sourceBundleRevision: SourceRevisionV02;
  generatedPatchExportId: Uuid7;
  generatedPatchExportHash: string;
  targetLocale: Bcp47Locale;
  hashStrategy: HashStrategyV02;
  createdAt?: string;
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
  assertSourceGameRevisionV02(bundle.sourceGame, "BridgeBundleV02.sourceGame");
  assertHashStringV02(bundle.sourceBundleHash, "BridgeBundleV02.sourceBundleHash");
  assertSourceRevisionV02(bundle.sourceBundleRevision, "BridgeBundleV02.sourceBundleRevision");
  assertRevisionHashMatchesV02(
    bundle.sourceBundleRevision,
    bundle.sourceBundleHash,
    "BridgeBundleV02.sourceBundleRevision",
  );
  assertString(bundle.sourceLocale, "BridgeBundleV02.sourceLocale");
  assertHashStrategyV02(bundle.hashStrategy, "BridgeBundleV02.hashStrategy");
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
    assertPatchRefMatchesUnitV02(unit, label);
  }

  const policyRecords = asArray(bundle.policyRecords, "BridgeBundleV02.policyRecords");
  for (const [index, record] of policyRecords.entries()) {
    assertPolicyRecordV02(record, `BridgeBundleV02.policyRecords[${index}]`);
  }
}

export function assertTriageBundleV02(value: unknown): asserts value is TriageBundleV02 {
  assertNoConfidenceFields(value, "TriageBundleV02");
  const bundle = asRecord(value, "TriageBundleV02");
  assertEqual(bundle.schemaVersion, BRIDGE_SCHEMA_VERSION_V02, "TriageBundleV02.schemaVersion");
  assertUuid7(bundle.triageBundleId, "TriageBundleV02.triageBundleId");
  assertOptionalUuid7(bundle.projectId, "TriageBundleV02.projectId");
  assertOptionalUuid7(bundle.sourceBridgeId, "TriageBundleV02.sourceBridgeId");
  assertOptionalUuid7(bundle.localeBranchId, "TriageBundleV02.localeBranchId");

  const events = asArray(bundle.events, "TriageBundleV02.events");
  const triageEvents: TriageEventV02[] = [];
  const seenEventIds = new Set<Uuid7>();
  for (const [index, event] of events.entries()) {
    const label = `TriageBundleV02.events[${index}]`;
    assertTriageEventV02(event, label);
    if (seenEventIds.has(event.eventId)) {
      throw new Error(`${label}.eventId must be unique within TriageBundleV02.events`);
    }
    assertEventLinksReferToPriorEvents(event, label, seenEventIds);
    seenEventIds.add(event.eventId);
    triageEvents.push(event);
  }

  const tasks = asArray(bundle.tasks, "TriageBundleV02.tasks");
  const triageTasks: TriageTaskV02[] = [];
  const taskIds = new Set<Uuid7>();
  for (const [index, task] of tasks.entries()) {
    const label = `TriageBundleV02.tasks[${index}]`;
    assertTriageTaskV02(task, label);
    if (taskIds.has(task.taskId)) {
      throw new Error(`${label}.taskId must be unique within TriageBundleV02.tasks`);
    }
    taskIds.add(task.taskId);
    triageTasks.push(task);
  }

  const findings = asArray(bundle.findings, "TriageBundleV02.findings");
  const triageFindings: FindingRecordV02[] = [];
  const findingIds = new Set<Uuid7>();
  for (const [index, finding] of findings.entries()) {
    const label = `TriageBundleV02.findings[${index}]`;
    assertFindingRecordV02(finding, label);
    if (findingIds.has(finding.findingId)) {
      throw new Error(`${label}.findingId must be unique within TriageBundleV02.findings`);
    }
    findingIds.add(finding.findingId);
    triageFindings.push(finding);
  }

  const referenceIndex = buildTriageBundleReferenceIndexV02(
    triageEvents,
    triageTasks,
    triageFindings,
  );
  assertTriageBundleReferencesV02(triageEvents, triageTasks, triageFindings, referenceIndex);
}

export function assertPatchExport(value: unknown): asserts value is PatchExport {
  const patch = asRecord(value, "PatchExport");
  assertEqual(patch.schemaVersion, "0.1.0", "PatchExport.schemaVersion");
  assertString(patch.patchExportId, "PatchExport.patchExportId");
  assertString(patch.sourceBridgeId, "PatchExport.sourceBridgeId");
  assertString(patch.targetLocale, "PatchExport.targetLocale");
  assertArray(patch.entries, "PatchExport.entries");
}

export function assertPatchExportV02(value: unknown): asserts value is PatchExportV02 {
  const patch = asRecord(value, "PatchExportV02");
  assertEqual(patch.schemaVersion, BRIDGE_SCHEMA_VERSION_V02, "PatchExportV02.schemaVersion");
  assertUuid7(patch.patchExportId, "PatchExportV02.patchExportId");
  assertUuid7(patch.sourceBridgeId, "PatchExportV02.sourceBridgeId");
  assertSourceGameRevisionV02(patch.sourceGame, "PatchExportV02.sourceGame");
  assertHashStringV02(patch.sourceBundleHash, "PatchExportV02.sourceBundleHash");
  assertSourceRevisionV02(patch.sourceBundleRevision, "PatchExportV02.sourceBundleRevision");
  assertRevisionHashMatchesV02(
    patch.sourceBundleRevision,
    patch.sourceBundleHash,
    "PatchExportV02.sourceBundleRevision",
  );
  assertString(patch.sourceLocale, "PatchExportV02.sourceLocale");
  assertString(patch.targetLocale, "PatchExportV02.targetLocale");
  assertHashStrategyV02(patch.hashStrategy, "PatchExportV02.hashStrategy");
  assertOptionalHashStringV02(patch.patchExportHash, "PatchExportV02.patchExportHash");
  assertOptionalString(patch.generatedAt, "PatchExportV02.generatedAt");
  const entries = asArray(patch.entries, "PatchExportV02.entries");
  const entryKeys = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const label = `PatchExportV02.entries[${index}]`;
    assertPatchExportEntryV02(entry, label);
    const entryKey = `${entry.bridgeUnitId}\0${entry.sourceUnitKey}`;
    if (entryKeys.has(entryKey)) {
      throw new Error(`${label} must be unique by bridgeUnitId and sourceUnitKey`);
    }
    entryKeys.add(entryKey);
  }
}

export function assertPatchResultV02(value: unknown): asserts value is PatchResultV02 {
  const result = asRecord(value, "PatchResultV02");
  assertEqual(result.schemaVersion, BRIDGE_SCHEMA_VERSION_V02, "PatchResultV02.schemaVersion");
  assertUuid7(result.patchResultId, "PatchResultV02.patchResultId");
  assertUuid7(result.patchExportId, "PatchResultV02.patchExportId");
  assertEnum(result.status, PATCH_RESULT_STATUSES_V02, "PatchResultV02.status");
  assertOptionalHashStringV02(result.outputHash, "PatchResultV02.outputHash");
  assertStringArray(result.failures, "PatchResultV02.failures");
  if (result.sourceCompatibility !== undefined) {
    assertPatchSourceCompatibilityReportV02(
      result.sourceCompatibility,
      "PatchResultV02.sourceCompatibility",
    );
    if (result.sourceCompatibility.patchExportId !== result.patchExportId) {
      throw new Error(
        "PatchResultV02.sourceCompatibility.patchExportId must match PatchResultV02.patchExportId",
      );
    }
    if (
      result.sourceCompatibility.status === "incompatible" &&
      result.status !== "incompatible_source"
    ) {
      throw new Error(
        "PatchResultV02.status must be incompatible_source when sourceCompatibility.status is incompatible",
      );
    }
  }
  if (result.status === "incompatible_source" && result.sourceCompatibility === undefined) {
    throw new Error("PatchResultV02.sourceCompatibility is required for incompatible_source");
  }
  if (
    result.status === "incompatible_source" &&
    result.sourceCompatibility?.status !== "incompatible"
  ) {
    throw new Error(
      "PatchResultV02.sourceCompatibility.status must be incompatible for incompatible_source",
    );
  }
}

export function assertDeltaPackageMetadataV02(
  value: unknown,
): asserts value is DeltaPackageMetadataV02 {
  const metadata = asRecord(value, "DeltaPackageMetadataV02");
  assertEqual(
    metadata.schemaVersion,
    BRIDGE_SCHEMA_VERSION_V02,
    "DeltaPackageMetadataV02.schemaVersion",
  );
  assertUuid7(metadata.deltaPackageId, "DeltaPackageMetadataV02.deltaPackageId");
  assertUuid7(metadata.sourceBridgeId, "DeltaPackageMetadataV02.sourceBridgeId");
  assertSourceGameRevisionV02(metadata.sourceGame, "DeltaPackageMetadataV02.sourceGame");
  assertHashStringV02(metadata.sourceBundleHash, "DeltaPackageMetadataV02.sourceBundleHash");
  assertSourceRevisionV02(
    metadata.sourceBundleRevision,
    "DeltaPackageMetadataV02.sourceBundleRevision",
  );
  assertRevisionHashMatchesV02(
    metadata.sourceBundleRevision,
    metadata.sourceBundleHash,
    "DeltaPackageMetadataV02.sourceBundleRevision",
  );
  assertUuid7(metadata.generatedPatchExportId, "DeltaPackageMetadataV02.generatedPatchExportId");
  assertHashStringV02(
    metadata.generatedPatchExportHash,
    "DeltaPackageMetadataV02.generatedPatchExportHash",
  );
  assertString(metadata.targetLocale, "DeltaPackageMetadataV02.targetLocale");
  assertHashStrategyV02(metadata.hashStrategy, "DeltaPackageMetadataV02.hashStrategy");
  assertOptionalString(metadata.createdAt, "DeltaPackageMetadataV02.createdAt");
}

export function evaluatePatchExportCompatibilityV02(
  patchExport: unknown,
  bridgeBundle: unknown,
): PatchSourceCompatibilityReportV02 {
  assertPatchExportV02(patchExport);
  assertBridgeBundleV02(bridgeBundle);

  const unitsByKey = new Map<string, LocalizationUnitV02>();
  const duplicateKeys = new Set<string>();
  for (const unit of bridgeBundle.units) {
    if (unitsByKey.has(unit.sourceUnitKey)) {
      duplicateKeys.add(unit.sourceUnitKey);
      continue;
    }
    unitsByKey.set(unit.sourceUnitKey, unit);
  }

  const compatibleUnits: UnitSourceCompatibilityV02[] = [];
  const incompatibleUnits: UnitSourceCompatibilityV02[] = [];

  for (const entry of patchExport.entries) {
    const base: Omit<UnitSourceCompatibilityV02, "status"> = {
      entryId: entry.entryId,
      bridgeUnitId: entry.bridgeUnitId,
      sourceUnitKey: entry.sourceUnitKey,
      expectedSourceHash: entry.sourceHash,
    };
    if (duplicateKeys.has(entry.sourceUnitKey)) {
      incompatibleUnits.push({
        ...base,
        status: "incompatible",
        reason: "duplicate_source_unit_key",
      });
      continue;
    }

    const currentUnit = unitsByKey.get(entry.sourceUnitKey);
    if (currentUnit === undefined) {
      incompatibleUnits.push({
        ...base,
        status: "incompatible",
        reason: "missing_source_unit",
      });
      continue;
    }

    if (currentUnit.sourceHash !== entry.sourceHash) {
      incompatibleUnits.push({
        ...base,
        status: "incompatible",
        actualSourceHash: currentUnit.sourceHash,
        reason: "source_hash_mismatch",
      });
      continue;
    }

    compatibleUnits.push({
      ...base,
      status: "compatible",
      actualSourceHash: currentUnit.sourceHash,
    });
  }

  return {
    schemaVersion: BRIDGE_SCHEMA_VERSION_V02,
    patchExportId: patchExport.patchExportId,
    sourceBridgeId: patchExport.sourceBridgeId,
    status: incompatibleUnits.length === 0 ? "compatible" : "incompatible",
    expectedSourceBundleHash: patchExport.sourceBundleHash,
    actualSourceBundleHash: bridgeBundle.sourceBundleHash,
    sourceBundleHashMatches: patchExport.sourceBundleHash === bridgeBundle.sourceBundleHash,
    compatibleUnits,
    incompatibleUnits,
  };
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

export function assertRuntimeEvidenceReportV02(
  value: unknown,
): asserts value is RuntimeEvidenceReportV02 {
  const report = asRecord(value, "RuntimeEvidenceReportV02");
  assertEqual(
    report.schemaVersion,
    BRIDGE_SCHEMA_VERSION_V02,
    "RuntimeEvidenceReportV02.schemaVersion",
  );
  assertUuid7(report.runtimeReportId, "RuntimeEvidenceReportV02.runtimeReportId");
  assertOptionalUuid7(report.sourceBridgeId, "RuntimeEvidenceReportV02.sourceBridgeId");
  assertOptionalHashStringV02(report.sourceBundleHash, "RuntimeEvidenceReportV02.sourceBundleHash");
  assertOptionalString(report.sourceLocale, "RuntimeEvidenceReportV02.sourceLocale");
  assertOptionalString(report.targetLocale, "RuntimeEvidenceReportV02.targetLocale");
  assertString(report.adapterName, "RuntimeEvidenceReportV02.adapterName");
  assertString(report.adapterVersion, "RuntimeEvidenceReportV02.adapterVersion");
  assertEnum(
    report.fidelityTier,
    RUNTIME_FIDELITY_TIERS_V02,
    "RuntimeEvidenceReportV02.fidelityTier",
  );
  assertEnum(
    report.evidenceTier,
    RUNTIME_EVIDENCE_TIERS_V02,
    "RuntimeEvidenceReportV02.evidenceTier",
  );
  assertRuntimeEvidenceTierWithinFidelityV02(
    report.evidenceTier,
    report.fidelityTier,
    "RuntimeEvidenceReportV02",
  );
  assertEnum(report.status, ["passed", "failed"] as const, "RuntimeEvidenceReportV02.status");
  assertString(report.createdAt, "RuntimeEvidenceReportV02.createdAt");

  const traceEvents = asArray(report.traceEvents, "RuntimeEvidenceReportV02.traceEvents");
  for (const [index, event] of traceEvents.entries()) {
    assertRuntimeTraceEventV02(event, `RuntimeEvidenceReportV02.traceEvents[${index}]`);
  }

  const branchEvents = asArray(report.branchEvents, "RuntimeEvidenceReportV02.branchEvents");
  for (const [index, event] of branchEvents.entries()) {
    assertRuntimeBranchPointEventV02(event, `RuntimeEvidenceReportV02.branchEvents[${index}]`);
  }

  const captures = asArray(report.captures, "RuntimeEvidenceReportV02.captures");
  for (const [index, capture] of captures.entries()) {
    assertRuntimeCaptureV02(capture, `RuntimeEvidenceReportV02.captures[${index}]`);
  }

  const recordings = asArray(report.recordings, "RuntimeEvidenceReportV02.recordings");
  for (const [index, recording] of recordings.entries()) {
    assertRuntimeRecordingV02(recording, `RuntimeEvidenceReportV02.recordings[${index}]`);
  }

  const approximations = asArray(report.approximations, "RuntimeEvidenceReportV02.approximations");
  for (const [index, approximation] of approximations.entries()) {
    assertRuntimeApproximationV02(
      approximation,
      `RuntimeEvidenceReportV02.approximations[${index}]`,
    );
  }

  const validationFindings = asArray(
    report.validationFindings,
    "RuntimeEvidenceReportV02.validationFindings",
  );
  for (const [index, finding] of validationFindings.entries()) {
    assertRuntimeValidationFindingV02(
      finding,
      `RuntimeEvidenceReportV02.validationFindings[${index}]`,
    );
  }

  const referenceComparisons =
    report.referenceComparisons === undefined
      ? []
      : asArray(report.referenceComparisons, "RuntimeEvidenceReportV02.referenceComparisons");
  for (const [index, comparison] of referenceComparisons.entries()) {
    assertRuntimeReferenceComparisonV02(
      comparison,
      `RuntimeEvidenceReportV02.referenceComparisons[${index}]`,
    );
  }
  const validatedReferenceComparisons = referenceComparisons as RuntimeReferenceComparisonV02[];

  assertStringArray(report.limitations, "RuntimeEvidenceReportV02.limitations");
  if (traceEvents.length === 0 && captures.length === 0 && recordings.length === 0) {
    throw new Error("RuntimeEvidenceReportV02 must contain trace, capture, or recording evidence");
  }
  if (captures.length > 0) {
    assertMinimumRuntimeEvidenceTierV02(
      report.evidenceTier,
      "E2",
      "RuntimeEvidenceReportV02.evidenceTier",
    );
  }
  if (recordings.length > 0) {
    assertMinimumRuntimeEvidenceTierV02(
      report.evidenceTier,
      "E3",
      "RuntimeEvidenceReportV02.evidenceTier",
    );
  }
  if (report.fidelityTier !== "reference_fidelity" && approximations.length === 0) {
    throw new Error(
      "RuntimeEvidenceReportV02.approximations must document non-reference runtime limits",
    );
  }
  if (
    (report.fidelityTier === "reference_fidelity" || report.evidenceTier === "E4") &&
    !validatedReferenceComparisons.some((comparison) => comparison.status === "passed")
  ) {
    throw new Error(
      "RuntimeEvidenceReportV02.referenceComparisons must include passed reference-runtime or conformance comparison evidence for E4/reference_fidelity claims",
    );
  }
  if (report.status === "failed" && validationFindings.length === 0) {
    throw new Error(
      "RuntimeEvidenceReportV02.validationFindings must explain failed runtime evidence",
    );
  }
}

export function assertRuntimeReport(
  value: unknown,
): asserts value is RuntimeVerificationReport | RuntimeEvidenceReportV02 {
  const report = asRecord(value, "RuntimeReport");
  if (report.schemaVersion === BRIDGE_SCHEMA_VERSION_V02) {
    assertRuntimeEvidenceReportV02(report);
    return;
  }
  assertRuntimeVerificationReport(report);
}

export function isUuid7(value: unknown): value is Uuid7 {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}

function assertRuntimeTraceEventV02(
  value: unknown,
  label: string,
): asserts value is RuntimeTraceEventV02 {
  const event = asRecord(value, label);
  assertUuid7(event.traceEventId, `${label}.traceEventId`);
  assertEnum(event.eventKind, RUNTIME_TRACE_EVENT_KINDS_V02, `${label}.eventKind`);
  assertRuntimeBridgeUnitRefV02(event.bridgeUnitRef, `${label}.bridgeUnitRef`);
  assertNonNegativeInteger(event.frame, `${label}.frame`);
  assertOptionalString(event.traceKey, `${label}.traceKey`);
  assertOptionalString(event.observedText, `${label}.observedText`);
  if (event.artifactRef !== undefined) {
    assertRuntimeArtifactRefV02(event.artifactRef, `${label}.artifactRef`);
  }
}

function assertRuntimeBranchPointEventV02(
  value: unknown,
  label: string,
): asserts value is RuntimeBranchPointEventV02 {
  const event = asRecord(value, label);
  assertUuid7(event.branchEventId, `${label}.branchEventId`);
  assertRuntimeBridgeUnitRefV02(event.bridgeUnitRef, `${label}.bridgeUnitRef`);
  assertNonNegativeInteger(event.frame, `${label}.frame`);
  assertOptionalString(event.branchPointKey, `${label}.branchPointKey`);
  assertOptionalString(event.promptText, `${label}.promptText`);
  const options = asArray(event.options, `${label}.options`);
  if (options.length === 0) {
    throw new Error(`${label}.options must contain at least one branch option`);
  }
  const optionIds = new Set<Uuid7>();
  for (const [index, option] of options.entries()) {
    const optionLabel = `${label}.options[${index}]`;
    assertRuntimeBranchOptionV02(option, optionLabel);
    if (optionIds.has(option.optionId)) {
      throw new Error(`${optionLabel}.optionId must be unique within ${label}.options`);
    }
    optionIds.add(option.optionId);
  }
  assertOptionalUuid7(event.selectedOptionId, `${label}.selectedOptionId`);
  if (event.selectedOptionId !== undefined && !optionIds.has(event.selectedOptionId)) {
    throw new Error(`${label}.selectedOptionId must reference an option in ${label}.options`);
  }
}

function assertRuntimeBranchOptionV02(
  value: unknown,
  label: string,
): asserts value is RuntimeBranchOptionV02 {
  const option = asRecord(value, label);
  assertUuid7(option.optionId, `${label}.optionId`);
  assertOptionalString(option.label, `${label}.label`);
  if (option.labelBridgeUnitRef !== undefined) {
    assertRuntimeBridgeUnitRefV02(option.labelBridgeUnitRef, `${label}.labelBridgeUnitRef`);
  }
  assertOptionalString(option.targetRouteKey, `${label}.targetRouteKey`);
  if (option.targetBridgeUnitRef !== undefined) {
    assertRuntimeBridgeUnitRefV02(option.targetBridgeUnitRef, `${label}.targetBridgeUnitRef`);
  }
}

function assertRuntimeCaptureV02(
  value: unknown,
  label: string,
): asserts value is RuntimeCaptureV02 {
  const capture = asRecord(value, label);
  assertUuid7(capture.captureId, `${label}.captureId`);
  assertRuntimeBridgeUnitRefV02(capture.bridgeUnitRef, `${label}.bridgeUnitRef`);
  assertEnum(capture.evidenceTier, RUNTIME_EVIDENCE_TIERS_V02, `${label}.evidenceTier`);
  assertMinimumRuntimeEvidenceTierV02(capture.evidenceTier, "E2", `${label}.evidenceTier`);
  assertNonNegativeInteger(capture.frame, `${label}.frame`);
  assertPositiveInteger(capture.width, `${label}.width`);
  assertPositiveInteger(capture.height, `${label}.height`);
  if (capture.nonZeroPixels !== undefined) {
    assertNonNegativeInteger(capture.nonZeroPixels, `${label}.nonZeroPixels`);
  }
  if (capture.region !== undefined) {
    assertPixelRegionV02(capture.region, `${label}.region`);
  }
  assertRuntimeArtifactRefV02(capture.artifactRef, `${label}.artifactRef`, "screenshot");
}

function assertRuntimeRecordingV02(
  value: unknown,
  label: string,
): asserts value is RuntimeRecordingV02 {
  const recording = asRecord(value, label);
  assertUuid7(recording.recordingId, `${label}.recordingId`);
  assertRuntimeBridgeUnitRefV02(recording.bridgeUnitRef, `${label}.bridgeUnitRef`);
  assertEnum(recording.evidenceTier, RUNTIME_EVIDENCE_TIERS_V02, `${label}.evidenceTier`);
  assertMinimumRuntimeEvidenceTierV02(recording.evidenceTier, "E3", `${label}.evidenceTier`);
  assertNonNegativeInteger(recording.startedAtFrame, `${label}.startedAtFrame`);
  assertPositiveInteger(recording.frameCount, `${label}.frameCount`);
  assertPositiveInteger(recording.width, `${label}.width`);
  assertPositiveInteger(recording.height, `${label}.height`);
  assertString(recording.encoding, `${label}.encoding`);
  assertRuntimeArtifactRefV02(recording.artifactRef, `${label}.artifactRef`, "recording");
}

function assertRuntimeApproximationV02(
  value: unknown,
  label: string,
): asserts value is RuntimeApproximationV02 {
  const approximation = asRecord(value, label);
  assertUuid7(approximation.approximationId, `${label}.approximationId`);
  assertEnum(
    approximation.approximationTier,
    RUNTIME_APPROXIMATION_TIERS_V02,
    `${label}.approximationTier`,
  );
  assertString(approximation.scope, `${label}.scope`);
  assertString(approximation.description, `${label}.description`);
  const refs = asArray(approximation.affectedBridgeUnitRefs, `${label}.affectedBridgeUnitRefs`);
  if (refs.length === 0) {
    throw new Error(`${label}.affectedBridgeUnitRefs must contain at least one bridge unit ref`);
  }
  for (const [index, ref] of refs.entries()) {
    assertRuntimeBridgeUnitRefV02(ref, `${label}.affectedBridgeUnitRefs[${index}]`);
  }
  assertEnum(
    approximation.evidenceTierCeiling,
    RUNTIME_EVIDENCE_TIERS_V02,
    `${label}.evidenceTierCeiling`,
  );
}

function assertRuntimeValidationFindingV02(
  value: unknown,
  label: string,
): asserts value is RuntimeValidationFindingV02 {
  const finding = asRecord(value, label);
  assertUuid7(finding.findingId, `${label}.findingId`);
  assertEnum(finding.findingKind, RUNTIME_VALIDATION_FINDING_KINDS_V02, `${label}.findingKind`);
  assertEnum(finding.severity, TRIAGE_SEVERITIES, `${label}.severity`);
  if (finding.bridgeUnitRef !== undefined) {
    assertRuntimeBridgeUnitRefV02(finding.bridgeUnitRef, `${label}.bridgeUnitRef`);
  }
  if (finding.artifactRef !== undefined) {
    assertRuntimeArtifactRefV02(finding.artifactRef, `${label}.artifactRef`);
  }
  assertString(finding.message, `${label}.message`);
  assertEnum(finding.evidenceTier, RUNTIME_EVIDENCE_TIERS_V02, `${label}.evidenceTier`);
}

function assertRuntimeReferenceComparisonV02(
  value: unknown,
  label: string,
): asserts value is RuntimeReferenceComparisonV02 {
  const comparison = asRecord(value, label);
  assertUuid7(comparison.comparisonId, `${label}.comparisonId`);
  assertEnum(
    comparison.comparisonKind,
    RUNTIME_REFERENCE_COMPARISON_KINDS_V02,
    `${label}.comparisonKind`,
  );
  assertEnum(comparison.status, RUNTIME_REFERENCE_COMPARISON_STATUSES_V02, `${label}.status`);
  assertString(comparison.scope, `${label}.scope`);
  const refs = asArray(comparison.coveredBridgeUnitRefs, `${label}.coveredBridgeUnitRefs`);
  if (refs.length === 0) {
    throw new Error(`${label}.coveredBridgeUnitRefs must contain at least one bridge unit ref`);
  }
  for (const [index, ref] of refs.entries()) {
    assertRuntimeBridgeUnitRefV02(ref, `${label}.coveredBridgeUnitRefs[${index}]`);
  }
  assertRuntimeArtifactRefV02(
    comparison.artifactRef,
    `${label}.artifactRef`,
    "reference_comparison",
  );
}

function assertRuntimeBridgeUnitRefV02(
  value: unknown,
  label: string,
): asserts value is RuntimeBridgeUnitRefV02 {
  const ref = asRecord(value, label);
  assertString(ref.bridgeUnitId, `${label}.bridgeUnitId`);
  assertOptionalString(ref.sourceUnitKey, `${label}.sourceUnitKey`);
}

function assertRuntimeArtifactRefV02(
  value: unknown,
  label: string,
  expectedKind?: RuntimeArtifactKindV02,
): asserts value is RuntimeArtifactRefV02 {
  const ref = asRecord(value, label);
  assertUuid7(ref.artifactId, `${label}.artifactId`);
  assertEnum(ref.artifactKind, RUNTIME_ARTIFACT_KINDS_V02, `${label}.artifactKind`);
  if (expectedKind !== undefined && ref.artifactKind !== expectedKind) {
    throw new Error(`${label}.artifactKind must be ${expectedKind}`);
  }
  assertPortableArtifactUriV02(ref.uri, `${label}.uri`);
  assertOptionalHashStringV02(ref.hash, `${label}.hash`);
  assertOptionalString(ref.mediaType, `${label}.mediaType`);
  if (ref.byteSize !== undefined) {
    assertPositiveInteger(ref.byteSize, `${label}.byteSize`);
  }
}

function assertRuntimeEvidenceTierWithinFidelityV02(
  evidenceTier: RuntimeEvidenceTierV02,
  fidelityTier: RuntimeFidelityTierV02,
  label: string,
): void {
  const ceilingByFidelity: Record<RuntimeFidelityTierV02, RuntimeEvidenceTierV02> = {
    trace_only: "E1",
    layout_probe: "E2",
    replay_review: "E3",
    reference_fidelity: "E4",
  };
  assertMaximumRuntimeEvidenceTierV02(
    evidenceTier,
    ceilingByFidelity[fidelityTier],
    `${label}.evidenceTier`,
  );
}

function assertMinimumRuntimeEvidenceTierV02(
  actual: RuntimeEvidenceTierV02,
  minimum: RuntimeEvidenceTierV02,
  label: string,
): void {
  if (runtimeEvidenceTierRankV02(actual) < runtimeEvidenceTierRankV02(minimum)) {
    throw new Error(`${label} must be at least ${minimum}`);
  }
}

function assertMaximumRuntimeEvidenceTierV02(
  actual: RuntimeEvidenceTierV02,
  maximum: RuntimeEvidenceTierV02,
  label: string,
): void {
  if (runtimeEvidenceTierRankV02(actual) > runtimeEvidenceTierRankV02(maximum)) {
    throw new Error(`${label} must not exceed ${maximum} for the declared fidelityTier`);
  }
}

function runtimeEvidenceTierRankV02(tier: RuntimeEvidenceTierV02): number {
  return RUNTIME_EVIDENCE_TIERS_V02.indexOf(tier);
}

function assertPortableArtifactUriV02(value: unknown, label: string): asserts value is string {
  assertString(value, label);
  if (value.startsWith("data:")) {
    throw new Error(`${label} must reference an artifact, not embed artifact bytes`);
  }
  if (value.startsWith("file:") || value.startsWith("/")) {
    throw new Error(`${label} must be portable and must not be an absolute local path`);
  }
  if (/^[A-Za-z]:[\\/]/.test(value) || value.includes("\\")) {
    throw new Error(`${label} must use portable forward-slash artifact paths`);
  }
}

function assertBridgeAssetV02(value: unknown, label: string): asserts value is BridgeAssetV02 {
  const asset = asRecord(value, label);
  assertUuid7(asset.assetId, `${label}.assetId`);
  assertString(asset.assetKey, `${label}.assetKey`);
  assertEnum(asset.assetKind, ASSET_KINDS, `${label}.assetKind`);
  assertHashStringV02(asset.sourceHash, `${label}.sourceHash`);
  assertSourceRevisionV02(asset.sourceRevision, `${label}.sourceRevision`);
  assertRevisionHashMatchesV02(asset.sourceRevision, asset.sourceHash, `${label}.sourceRevision`);
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
  assertHashStringV02(unit.sourceHash, `${label}.sourceHash`);
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

function assertHashStrategyV02(value: unknown, label: string): asserts value is HashStrategyV02 {
  const strategy = asRecord(value, label);
  const sourceProfile = strategy.sourceProfile;
  const sourceBundle = strategy.sourceBundle;
  const sourceAsset = strategy.sourceAsset;
  const sourceUnit = strategy.sourceUnit;
  const patchExport = strategy.patchExport;
  const deltaPackage = strategy.deltaPackage;
  assertHashRuleV02(sourceProfile, `${label}.sourceProfile`, "source_profile");
  assertHashRuleV02(sourceBundle, `${label}.sourceBundle`, "source_bundle");
  assertHashRuleV02(sourceAsset, `${label}.sourceAsset`, "source_asset");
  assertHashRuleV02(sourceUnit, `${label}.sourceUnit`, "source_unit");
  assertHashRuleV02(patchExport, `${label}.patchExport`, "patch_export");
  assertHashRuleV02(deltaPackage, `${label}.deltaPackage`, "delta_package");
  assertHashRuleNormalizationV02(sourceProfile, `${label}.sourceProfile`, [
    "utf8-nfc-lf-json-stable-v1",
  ]);
  assertHashRuleNormalizationV02(sourceBundle, `${label}.sourceBundle`, [
    "utf8-nfc-lf-json-stable-v1",
  ]);
  assertHashRuleNormalizationV02(sourceAsset, `${label}.sourceAsset`, ["bytes"]);
  assertHashRuleNormalizationV02(sourceUnit, `${label}.sourceUnit`, ["utf8-nfc-lf-json-stable-v1"]);
  assertHashRuleNormalizationV02(patchExport, `${label}.patchExport`, [
    "utf8-nfc-lf-json-stable-v1",
  ]);
  assertHashRuleNormalizationV02(deltaPackage, `${label}.deltaPackage`, [
    "utf8-nfc-lf-json-stable-v1",
  ]);
  assertRequiredHashRuleFieldsV02(sourceUnit, `${label}.sourceUnit`);
}

function assertHashRuleV02<Scope extends HashScopeV02>(
  value: unknown,
  label: string,
  scope: Scope,
): asserts value is HashRuleV02<Scope> {
  const rule = asRecord(value, label);
  assertEqual(rule.scope, scope, `${label}.scope`);
  assertEnum(rule.algorithm, HASH_ALGORITHMS, `${label}.algorithm`);
  assertEnum(rule.normalization, HASH_NORMALIZATIONS, `${label}.normalization`);
  if (rule.fields !== undefined) {
    assertStringArray(rule.fields, `${label}.fields`);
  }
}

function assertHashRuleNormalizationV02(
  rule: HashRuleV02,
  label: string,
  allowedNormalizations: readonly HashNormalizationV02[],
): void {
  if (!allowedNormalizations.includes(rule.normalization)) {
    throw new Error(`${label}.normalization must be ${allowedNormalizations.join(" or ")}`);
  }
}

function assertRequiredHashRuleFieldsV02(rule: HashRuleV02, label: string): void {
  if (rule.fields === undefined || rule.fields.length === 0) {
    throw new Error(`${label}.fields must not be empty`);
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
  if (revision.revisionKind === "content_hash") {
    assertHashStringV02(revision.value, `${label}.value`);
  }
  assertOptionalString(revision.createdAt, `${label}.createdAt`);
}

function assertSourceGameRevisionV02(
  value: unknown,
  label: string,
): asserts value is SourceGameRevisionV02 {
  const sourceGame = asRecord(value, label);
  assertString(sourceGame.gameId, `${label}.gameId`);
  assertString(sourceGame.gameVersion, `${label}.gameVersion`);
  assertString(sourceGame.sourceProfileId, `${label}.sourceProfileId`);
  assertSourceRevisionV02(sourceGame.sourceProfileRevision, `${label}.sourceProfileRevision`);
}

function assertRevisionHashMatchesV02(
  revision: SourceRevisionV02,
  hash: string,
  label: string,
): void {
  if (revision.revisionKind === "content_hash" && revision.value !== hash) {
    throw new Error(`${label}.value must equal the matching content hash`);
  }
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

function assertPatchRefMatchesUnitV02(unit: LocalizationUnitV02, label: string): void {
  if (unit.patchRef.sourceUnitKey !== unit.sourceUnitKey) {
    throw new Error(`${label}.patchRef.sourceUnitKey must match ${label}.sourceUnitKey`);
  }
  if (unit.patchRef.sourceRevision.revisionId !== unit.sourceRevision.revisionId) {
    throw new Error(`${label}.patchRef.sourceRevision.revisionId must match unit sourceRevision`);
  }
  if (unit.patchRef.sourceRevision.value !== unit.sourceRevision.value) {
    throw new Error(`${label}.patchRef.sourceRevision.value must match unit sourceRevision`);
  }
}

function assertPatchExportEntryV02(
  value: unknown,
  label: string,
): asserts value is PatchExportEntryV02 {
  const entry = asRecord(value, label);
  assertUuid7(entry.entryId, `${label}.entryId`);
  assertUuid7(entry.bridgeUnitId, `${label}.bridgeUnitId`);
  assertString(entry.sourceUnitKey, `${label}.sourceUnitKey`);
  assertHashStringV02(entry.sourceHash, `${label}.sourceHash`);
  assertSourceRevisionV02(entry.sourceRevision, `${label}.sourceRevision`);
  assertString(entry.targetText, `${label}.targetText`);
  const mappings = asArray(entry.protectedSpanMappings, `${label}.protectedSpanMappings`);
  for (const [index, mapping] of mappings.entries()) {
    assertProtectedSpanMappingV02(mapping, `${label}.protectedSpanMappings[${index}]`);
  }
}

function assertProtectedSpanMappingV02(value: unknown, label: string): void {
  const mapping = asRecord(value, label);
  assertString(mapping.raw, `${label}.raw`);
  assertNonNegativeInteger(mapping.targetStart, `${label}.targetStart`);
  assertNonNegativeInteger(mapping.targetEnd, `${label}.targetEnd`);
  if ((mapping.targetEnd as number) <= mapping.targetStart) {
    throw new Error(`${label}.targetEnd must be greater than ${label}.targetStart`);
  }
}

function assertPatchSourceCompatibilityReportV02(
  value: unknown,
  label: string,
): asserts value is PatchSourceCompatibilityReportV02 {
  const report = asRecord(value, label);
  assertEqual(report.schemaVersion, BRIDGE_SCHEMA_VERSION_V02, `${label}.schemaVersion`);
  assertUuid7(report.patchExportId, `${label}.patchExportId`);
  assertUuid7(report.sourceBridgeId, `${label}.sourceBridgeId`);
  assertEnum(report.status, PATCH_COMPATIBILITY_STATUSES_V02, `${label}.status`);
  assertHashStringV02(report.expectedSourceBundleHash, `${label}.expectedSourceBundleHash`);
  assertHashStringV02(report.actualSourceBundleHash, `${label}.actualSourceBundleHash`);
  assertBoolean(report.sourceBundleHashMatches, `${label}.sourceBundleHashMatches`);
  if (
    report.sourceBundleHashMatches !==
    (report.expectedSourceBundleHash === report.actualSourceBundleHash)
  ) {
    throw new Error(`${label}.sourceBundleHashMatches must match source bundle hashes`);
  }
  const compatibleUnits = asArray(report.compatibleUnits, `${label}.compatibleUnits`);
  for (const [index, unit] of compatibleUnits.entries()) {
    const unitLabel = `${label}.compatibleUnits[${index}]`;
    assertUnitSourceCompatibilityV02(unit, unitLabel);
    if (unit.status !== "compatible") {
      throw new Error(`${unitLabel}.status must be compatible`);
    }
  }
  const incompatibleUnits = asArray(report.incompatibleUnits, `${label}.incompatibleUnits`);
  for (const [index, unit] of incompatibleUnits.entries()) {
    const unitLabel = `${label}.incompatibleUnits[${index}]`;
    assertUnitSourceCompatibilityV02(unit, unitLabel);
    if (unit.status !== "incompatible") {
      throw new Error(`${unitLabel}.status must be incompatible`);
    }
  }
  if (report.status === "compatible" && incompatibleUnits.length > 0) {
    throw new Error(`${label}.status cannot be compatible with incompatibleUnits`);
  }
  if (report.status === "incompatible" && incompatibleUnits.length === 0) {
    throw new Error(`${label}.status cannot be incompatible with empty incompatibleUnits`);
  }
}

function assertUnitSourceCompatibilityV02(
  value: unknown,
  label: string,
): asserts value is UnitSourceCompatibilityV02 {
  const unit = asRecord(value, label);
  assertUuid7(unit.entryId, `${label}.entryId`);
  assertUuid7(unit.bridgeUnitId, `${label}.bridgeUnitId`);
  assertString(unit.sourceUnitKey, `${label}.sourceUnitKey`);
  assertEnum(unit.status, PATCH_COMPATIBILITY_STATUSES_V02, `${label}.status`);
  assertHashStringV02(unit.expectedSourceHash, `${label}.expectedSourceHash`);
  assertOptionalHashStringV02(unit.actualSourceHash, `${label}.actualSourceHash`);
  if (unit.reason !== undefined) {
    assertEnum(unit.reason, PATCH_INCOMPATIBILITY_REASONS_V02, `${label}.reason`);
  }
  if (unit.status === "incompatible" && unit.reason === undefined) {
    throw new Error(`${label}.reason is required for incompatible units`);
  }
  if (unit.status === "compatible" && unit.reason !== undefined) {
    throw new Error(`${label}.reason is only valid for incompatible units`);
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

function assertTriageEventV02(value: unknown, label: string): asserts value is TriageEventV02 {
  assertNoMutableEventBucketFields(value, label);
  const event = asRecord(value, label);
  assertUuid7(event.eventId, `${label}.eventId`);
  assertEnum(event.eventKind, TRIAGE_EVENT_KINDS, `${label}.eventKind`);
  assertString(event.occurredAt, `${label}.occurredAt`);
  assertTriageActorV02(event.actor, `${label}.actor`);
  assertOptionalUuid7(event.taskId, `${label}.taskId`);
  assertOptionalUuid7(event.findingId, `${label}.findingId`);
  assertTriageSubjectRefsV02(event.subjectRefs, `${label}.subjectRefs`);
  assertProvenanceArrayV02(event.provenance, `${label}.provenance`);
  assertCausalLinksV02(event.causalLinks, `${label}.causalLinks`);
  if (event.payload !== undefined) {
    asRecord(event.payload, `${label}.payload`);
  }
}

function assertTriageTaskV02(value: unknown, label: string): asserts value is TriageTaskV02 {
  const task = asRecord(value, label);
  assertUuid7(task.taskId, `${label}.taskId`);
  assertEnum(task.taskKind, TRIAGE_TASK_KINDS, `${label}.taskKind`);
  assertString(task.createdAt, `${label}.createdAt`);
  assertString(task.summary, `${label}.summary`);
  assertOptionalUuid7(task.createdByEventId, `${label}.createdByEventId`);
  assertTriageSubjectRefsV02(task.inputRefs, `${label}.inputRefs`);
  assertProvenanceArrayV02(task.provenance, `${label}.provenance`);
  assertCausalLinksV02(task.causalLinks, `${label}.causalLinks`);
}

function assertFindingRecordV02(value: unknown, label: string): asserts value is FindingRecordV02 {
  const finding = asRecord(value, label);
  assertUuid7(finding.findingId, `${label}.findingId`);
  assertEnum(finding.findingKind, FINDING_KINDS, `${label}.findingKind`);
  assertEnum(finding.severity, TRIAGE_SEVERITIES, `${label}.severity`);
  if (finding.qualityCategory !== undefined) {
    assertEnum(
      finding.qualityCategory,
      LOCALIZATION_QUALITY_CATEGORIES,
      `${label}.qualityCategory`,
    );
  }
  assertString(finding.title, `${label}.title`);
  assertString(finding.description, `${label}.description`);
  assertString(finding.impact, `${label}.impact`);
  assertString(finding.createdAt, `${label}.createdAt`);
  assertOptionalUuid7(finding.reportedByTaskId, `${label}.reportedByTaskId`);
  assertOptionalUuid7(finding.firstSeenEventId, `${label}.firstSeenEventId`);
  assertTriageSubjectRefsV02(finding.affectedRefs, `${label}.affectedRefs`);
  assertEvidenceArrayV02(finding.evidence, `${label}.evidence`);
  assertProvenanceArrayV02(finding.provenance, `${label}.provenance`);
  assertCausalLinksV02(finding.causalLinks, `${label}.causalLinks`);
}

function assertTriageActorV02(value: unknown, label: string): asserts value is TriageActorV02 {
  const actor = asRecord(value, label);
  assertEnum(actor.actorKind, ["human", "agent", "tool", "system"] as const, `${label}.actorKind`);
  assertOptionalUuid7(actor.actorId, `${label}.actorId`);
  assertOptionalString(actor.displayName, `${label}.displayName`);
}

function assertTriageSubjectRefsV02(
  value: unknown,
  label: string,
): asserts value is TriageSubjectRefV02[] {
  const refs = asArray(value, label);
  for (const [index, ref] of refs.entries()) {
    assertTriageSubjectRefV02(ref, `${label}[${index}]`);
  }
}

function assertTriageSubjectRefV02(
  value: unknown,
  label: string,
): asserts value is TriageSubjectRefV02 {
  const ref = asRecord(value, label);
  assertEnum(ref.subjectKind, TRIAGE_SUBJECT_KINDS, `${label}.subjectKind`);
  assertUuid7(ref.subjectId, `${label}.subjectId`);
  assertOptionalString(ref.label, `${label}.label`);
}

function assertArtifactRefV02(
  value: unknown,
  label: string,
): asserts value is TriageArtifactRefV02 {
  const ref = asRecord(value, label);
  assertUuid7(ref.artifactId, `${label}.artifactId`);
  assertString(ref.artifactKind, `${label}.artifactKind`);
  assertOptionalString(ref.uri, `${label}.uri`);
  assertOptionalString(ref.hash, `${label}.hash`);
}

function assertEvidenceArrayV02(
  value: unknown,
  label: string,
): asserts value is EvidenceRecordV02[] {
  const evidence = asArray(value, label);
  if (evidence.length === 0) {
    throw new Error(`${label} must contain at least one evidence record`);
  }
  for (const [index, record] of evidence.entries()) {
    assertEvidenceRecordV02(record, `${label}[${index}]`);
  }
}

function assertEvidenceRecordV02(
  value: unknown,
  label: string,
): asserts value is EvidenceRecordV02 {
  const evidence = asRecord(value, label);
  assertUuid7(evidence.evidenceId, `${label}.evidenceId`);
  assertEnum(evidence.evidenceKind, EVIDENCE_KINDS, `${label}.evidenceKind`);
  assertString(evidence.summary, `${label}.summary`);
  if (evidence.subjectRef !== undefined) {
    assertTriageSubjectRefV02(evidence.subjectRef, `${label}.subjectRef`);
  }
  if (evidence.artifactRef !== undefined) {
    assertArtifactRefV02(evidence.artifactRef, `${label}.artifactRef`);
  }
  if (evidence.sourceLocation !== undefined) {
    assertSourceLocationV02(evidence.sourceLocation, `${label}.sourceLocation`);
  }
  assertOptionalString(evidence.expectedValue, `${label}.expectedValue`);
  assertOptionalString(evidence.observedValue, `${label}.observedValue`);
  assertUuid7Array(evidence.provenanceIds, `${label}.provenanceIds`);
}

function assertProvenanceArrayV02(
  value: unknown,
  label: string,
): asserts value is ProvenanceRecordV02[] {
  const provenance = asArray(value, label);
  if (provenance.length === 0) {
    throw new Error(`${label} must contain at least one provenance record`);
  }
  for (const [index, record] of provenance.entries()) {
    assertProvenanceRecordV02(record, `${label}[${index}]`);
  }
}

function assertProvenanceRecordV02(
  value: unknown,
  label: string,
): asserts value is ProvenanceRecordV02 {
  const provenance = asRecord(value, label);
  assertUuid7(provenance.provenanceId, `${label}.provenanceId`);
  assertEnum(provenance.provenanceKind, PROVENANCE_KINDS, `${label}.provenanceKind`);
  switch (provenance.provenanceKind) {
    case "source_annotation":
      assertUuid7(provenance.bridgeUnitId, `${label}.bridgeUnitId`);
      assertOptionalUuid7(provenance.spanId, `${label}.spanId`);
      if (provenance.sourceAssetRef !== undefined) {
        assertAssetRefV02(provenance.sourceAssetRef, `${label}.sourceAssetRef`);
      }
      if (provenance.sourceLocation !== undefined) {
        assertSourceLocationV02(provenance.sourceLocation, `${label}.sourceLocation`);
      }
      assertOptionalString(provenance.annotationText, `${label}.annotationText`);
      assertOptionalString(provenance.observedAt, `${label}.observedAt`);
      break;
    case "style_guide":
      assertUuid7(provenance.styleGuideId, `${label}.styleGuideId`);
      assertUuid7(provenance.styleGuideVersionId, `${label}.styleGuideVersionId`);
      assertString(provenance.ruleId, `${label}.ruleId`);
      assertOptionalString(provenance.rulePath, `${label}.rulePath`);
      assertOptionalString(provenance.excerptHash, `${label}.excerptHash`);
      break;
    case "model_output":
      assertUuid7(provenance.modelOutputId, `${label}.modelOutputId`);
      assertOptionalUuid7(provenance.taskId, `${label}.taskId`);
      assertString(provenance.provider, `${label}.provider`);
      assertString(provenance.model, `${label}.model`);
      assertString(provenance.outputHash, `${label}.outputHash`);
      assertOptionalString(provenance.promptHash, `${label}.promptHash`);
      if (provenance.artifactRef !== undefined) {
        assertArtifactRefV02(provenance.artifactRef, `${label}.artifactRef`);
      }
      break;
    case "patching_cause":
      assertOptionalUuid7(provenance.patchResultId, `${label}.patchResultId`);
      assertOptionalUuid7(provenance.patchExportId, `${label}.patchExportId`);
      assertOptionalUuid7(provenance.bridgeUnitId, `${label}.bridgeUnitId`);
      if (provenance.assetRef !== undefined) {
        assertAssetRefV02(provenance.assetRef, `${label}.assetRef`);
      }
      if (provenance.writeMode !== undefined) {
        assertEnum(provenance.writeMode, PATCH_WRITE_MODES, `${label}.writeMode`);
      }
      assertOptionalString(provenance.failureCode, `${label}.failureCode`);
      assertOptionalString(provenance.failureDetail, `${label}.failureDetail`);
      if (provenance.patchResultId === undefined && provenance.patchExportId === undefined) {
        throw new Error(`${label} must include patchResultId or patchExportId`);
      }
      break;
    case "runtime_evidence":
      assertUuid7(provenance.runtimeReportId, `${label}.runtimeReportId`);
      assertOptionalUuid7(provenance.bridgeUnitId, `${label}.bridgeUnitId`);
      if (provenance.artifactRef !== undefined) {
        assertArtifactRefV02(provenance.artifactRef, `${label}.artifactRef`);
      }
      if (provenance.evidenceTier !== undefined) {
        assertEnum(provenance.evidenceTier, RUNTIME_EVIDENCE_TIERS_V02, `${label}.evidenceTier`);
      }
      break;
    case "human_review":
      assertOptionalUuid7(provenance.reviewerId, `${label}.reviewerId`);
      assertOptionalUuid7(provenance.reviewSessionId, `${label}.reviewSessionId`);
      assertString(provenance.noteHash, `${label}.noteHash`);
      break;
    case "deterministic_check":
      assertUuid7(provenance.checkId, `${label}.checkId`);
      assertString(provenance.checkName, `${label}.checkName`);
      assertString(provenance.checkVersion, `${label}.checkVersion`);
      if (provenance.artifactRef !== undefined) {
        assertArtifactRefV02(provenance.artifactRef, `${label}.artifactRef`);
      }
      break;
  }
}

function assertCausalLinksV02(value: unknown, label: string): asserts value is CausalLinkV02[] {
  const links = asArray(value, label);
  for (const [index, link] of links.entries()) {
    assertCausalLinkV02(link, `${label}[${index}]`);
  }
}

function assertCausalLinkV02(value: unknown, label: string): asserts value is CausalLinkV02 {
  const link = asRecord(value, label);
  assertUuid7(link.causalLinkId, `${label}.causalLinkId`);
  assertEnum(link.linkKind, CAUSAL_LINK_KINDS, `${label}.linkKind`);
  assertEnum(link.targetKind, CAUSAL_TARGET_KINDS, `${label}.targetKind`);
  assertUuid7(link.targetId, `${label}.targetId`);
  assertOptionalString(link.rationale, `${label}.rationale`);
}

function assertEventLinksReferToPriorEvents(
  event: TriageEventV02,
  label: string,
  seenEventIds: ReadonlySet<Uuid7>,
): void {
  for (const [index, link] of event.causalLinks.entries()) {
    if (link.targetKind === "event" && !seenEventIds.has(link.targetId)) {
      throw new Error(`${label}.causalLinks[${index}].targetId must reference a prior event`);
    }
  }
}

function buildTriageBundleReferenceIndexV02(
  events: readonly TriageEventV02[],
  tasks: readonly TriageTaskV02[],
  findings: readonly FindingRecordV02[],
): TriageBundleReferenceIndexV02 {
  const provenanceIds = new Set<Uuid7>();
  for (const event of events) {
    addProvenanceIdsV02(event.provenance, provenanceIds);
  }
  for (const task of tasks) {
    addProvenanceIdsV02(task.provenance, provenanceIds);
  }
  for (const finding of findings) {
    addProvenanceIdsV02(finding.provenance, provenanceIds);
  }

  return {
    eventIds: new Set(events.map((event) => event.eventId)),
    taskIds: new Set(tasks.map((task) => task.taskId)),
    findingIds: new Set(findings.map((finding) => finding.findingId)),
    provenanceIds,
  };
}

function addProvenanceIdsV02(
  provenanceRecords: readonly ProvenanceRecordV02[],
  provenanceIds: Set<Uuid7>,
): void {
  for (const provenance of provenanceRecords) {
    provenanceIds.add(provenance.provenanceId);
  }
}

function assertTriageBundleReferencesV02(
  events: readonly TriageEventV02[],
  tasks: readonly TriageTaskV02[],
  findings: readonly FindingRecordV02[],
  referenceIndex: TriageBundleReferenceIndexV02,
): void {
  for (const [index, event] of events.entries()) {
    const label = `TriageBundleV02.events[${index}]`;
    assertOptionalKnownReferenceV02(event.taskId, `${label}.taskId`, "task", referenceIndex);
    assertOptionalKnownReferenceV02(
      event.findingId,
      `${label}.findingId`,
      "finding",
      referenceIndex,
    );
    assertCausalLinkTargetsExistV02(event.causalLinks, `${label}.causalLinks`, referenceIndex);
  }

  for (const [index, task] of tasks.entries()) {
    const label = `TriageBundleV02.tasks[${index}]`;
    assertOptionalKnownReferenceV02(
      task.createdByEventId,
      `${label}.createdByEventId`,
      "event",
      referenceIndex,
    );
    assertCausalLinkTargetsExistV02(task.causalLinks, `${label}.causalLinks`, referenceIndex);
  }

  for (const [index, finding] of findings.entries()) {
    const label = `TriageBundleV02.findings[${index}]`;
    assertOptionalKnownReferenceV02(
      finding.reportedByTaskId,
      `${label}.reportedByTaskId`,
      "task",
      referenceIndex,
    );
    assertOptionalKnownReferenceV02(
      finding.firstSeenEventId,
      `${label}.firstSeenEventId`,
      "event",
      referenceIndex,
    );
    assertCausalLinkTargetsExistV02(finding.causalLinks, `${label}.causalLinks`, referenceIndex);
    assertFindingEvidenceProvenanceV02(finding, label, referenceIndex);
  }
}

function assertOptionalKnownReferenceV02(
  id: Uuid7 | undefined,
  label: string,
  targetKind: CausalTargetKindV02,
  referenceIndex: TriageBundleReferenceIndexV02,
): void {
  if (id !== undefined) {
    assertKnownTriageReferenceV02(id, label, targetKind, referenceIndex);
  }
}

function assertCausalLinkTargetsExistV02(
  causalLinks: readonly CausalLinkV02[],
  label: string,
  referenceIndex: TriageBundleReferenceIndexV02,
): void {
  for (const [index, link] of causalLinks.entries()) {
    assertKnownTriageReferenceV02(
      link.targetId,
      `${label}[${index}].targetId`,
      link.targetKind,
      referenceIndex,
    );
  }
}

function assertKnownTriageReferenceV02(
  id: Uuid7,
  label: string,
  targetKind: CausalTargetKindV02,
  referenceIndex: TriageBundleReferenceIndexV02,
): void {
  const targetIds = triageReferenceIdsForKindV02(targetKind, referenceIndex);
  if (!targetIds.has(id)) {
    throw new Error(`${label} must reference an existing triage ${targetKind}`);
  }
}

function triageReferenceIdsForKindV02(
  targetKind: CausalTargetKindV02,
  referenceIndex: TriageBundleReferenceIndexV02,
): ReadonlySet<Uuid7> {
  switch (targetKind) {
    case "event":
      return referenceIndex.eventIds;
    case "task":
      return referenceIndex.taskIds;
    case "finding":
      return referenceIndex.findingIds;
  }
}

function assertFindingEvidenceProvenanceV02(
  finding: FindingRecordV02,
  label: string,
  referenceIndex: TriageBundleReferenceIndexV02,
): void {
  const findingProvenanceIds = new Set(finding.provenance.map((record) => record.provenanceId));
  for (const [evidenceIndex, evidence] of finding.evidence.entries()) {
    const evidenceLabel = `${label}.evidence[${evidenceIndex}]`;
    if (evidence.provenanceIds.length === 0) {
      throw new Error(`${evidenceLabel}.provenanceIds must contain at least one provenance id`);
    }
    for (const [provenanceIndex, provenanceId] of evidence.provenanceIds.entries()) {
      const provenanceLabel = `${evidenceLabel}.provenanceIds[${provenanceIndex}]`;
      if (!referenceIndex.provenanceIds.has(provenanceId)) {
        throw new Error(`${provenanceLabel} must reference provenance in TriageBundleV02`);
      }
      if (!findingProvenanceIds.has(provenanceId)) {
        throw new Error(`${provenanceLabel} must reference provenance on the same finding`);
      }
    }
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

function assertHashStringV02(value: unknown, label: string): asserts value is string {
  assertString(value, label);
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a canonical sha256 hash string`);
  }
}

function assertOptionalString(value: unknown, label: string): asserts value is string | undefined {
  if (value !== undefined) {
    assertString(value, label);
  }
}

function assertOptionalHashStringV02(
  value: unknown,
  label: string,
): asserts value is string | undefined {
  if (value !== undefined) {
    assertHashStringV02(value, label);
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

function assertUuid7Array(value: unknown, label: string): asserts value is Uuid7[] {
  const array = asArray(value, label);
  for (const [index, item] of array.entries()) {
    assertUuid7(item, `${label}[${index}]`);
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

function assertNoConfidenceFields(value: unknown, label: string): void {
  if (typeof value !== "object" || value === null) {
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertNoConfidenceFields(item, `${label}[${index}]`);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key.toLowerCase().includes("confidence")) {
      throw new Error(`${label}.${key} is not allowed; record evidence instead of confidence`);
    }
    assertNoConfidenceFields(child, `${label}.${key}`);
  }
}

function assertNoMutableEventBucketFields(value: unknown, label: string): void {
  const mutableKeys = new Set(["status", "currentStatus", "updatedAt", "deletedAt"]);
  if (typeof value !== "object" || value === null) {
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertNoMutableEventBucketFields(item, `${label}[${index}]`);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (mutableKeys.has(key)) {
      throw new Error(`${label}.${key} is not allowed on append-only events`);
    }
    assertNoMutableEventBucketFields(child, `${label}.${key}`);
  }
}
