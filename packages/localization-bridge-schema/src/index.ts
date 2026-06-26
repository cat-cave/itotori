import { createHash } from "node:crypto";

export * from "./style-guide-conversation.js";
export * from "./conformance.js";
export * from "./qa-finding.js";
export * from "./speaker-label.js";
export * from "./translation-draft.js";
export * from "./draft-artifact-bundle.js";
export * from "./patch-export-bundle.js";
export * from "./agentic-loop-bundle.js";
export * from "./pair-policy.v0.3.js";

export type Uuid7 = string;
export type Bcp47Locale = string;

export type TextSurface = "dialogue" | "system";
export type ProtectedSpanKind =
  | "placeholder"
  | "control_markup"
  | "variable_placeholder"
  | "ruby_annotation";
export type PreserveMode = "exact" | "map" | "transform" | "locale_policy";
export type PatchWriteMode = "replace";
export type RuntimeFidelityTier = "trace_only" | "layout_probe";

export type ProtectedSpan = {
  kind: ProtectedSpanKind;
  raw: string;
  start: number;
  end: number;
  preserveMode: PreserveMode;
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
  protectedSpanMappings: Array<{
    raw: string;
    sourceSpanId?: Uuid7;
    sourceStartByte?: number;
    sourceEndByte?: number;
    targetStart: number;
    targetEnd: number;
  }>;
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

/**
 * @deprecated Use `PatchResultV02`. v0.1 callers will be migrated under
 *   KAIFUU-010 §7 then removed once ALPHA-006 closes.
 */
export type PatchResultV01 = PatchResult;

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

export const RUNTIME_CAPABILITY_CLASSES_V02 = [
  "static_trace",
  "launch_capture",
  "instrumented_runtime",
  "partial_vm",
  "reference_vm",
] as const;
export type RuntimeCapabilityClassV02 = (typeof RUNTIME_CAPABILITY_CLASSES_V02)[number];

export const RUNTIME_PLAYBACK_FEATURES_V02 = [
  "static_trace",
  "launch",
  "text_trace",
  "branch_discovery",
  "frame_capture",
  "jump",
  "snapshot",
  "screenshot",
  "recording",
  "instrumentation_hooks",
  "vm_state_inspection",
  "reference_comparison",
] as const;
export type RuntimePlaybackFeatureV02 = (typeof RUNTIME_PLAYBACK_FEATURES_V02)[number];

export const RUNTIME_FEATURE_STATUSES_V02 = ["supported", "partial", "unsupported"] as const;
export type RuntimeFeatureStatusV02 = (typeof RUNTIME_FEATURE_STATUSES_V02)[number];

// KAIFUU-053: capability-leveled engine detector registry.
//
// The 4-rung ladder consumers gate against. Identifying that an adapter
// exists (`identify`) does NOT imply usability for inventory / extract /
// patch — the matrix uses a tagged-union status per rung and consumers
// must opt in to the rung they need.
//
// Mirrors `kaifuu_core::CapabilityLevel` /
// `kaifuu_core::CapabilityLevelStatus` /
// `kaifuu_core::AdapterCapabilityMatrix`.
export const CAPABILITY_LEVELS_V02 = ["identify", "inventory", "extract", "patch"] as const;
export type CapabilityLevelV02 = (typeof CAPABILITY_LEVELS_V02)[number];

export const CAPABILITY_LEVEL_STATUS_KINDS_V02 = ["supported", "partial", "unsupported"] as const;
export type CapabilityLevelStatusKindV02 = (typeof CAPABILITY_LEVEL_STATUS_KINDS_V02)[number];

export type CapabilityLevelStatusV02 =
  | { kind: "supported" }
  | { kind: "partial"; limitations: string[] }
  | { kind: "unsupported"; reason: string };

export type AdapterCapabilityMatrixV02 = {
  adapterId: string;
  identify: CapabilityLevelStatusV02;
  inventory: CapabilityLevelStatusV02;
  extract: CapabilityLevelStatusV02;
  patch: CapabilityLevelStatusV02;
};

/**
 * True iff the matrix declares `Supported` at `level`. Partial does NOT
 * count — that is the whole point of KAIFUU-053's strict gate.
 */
export function adapterMatrixSupports(
  matrix: AdapterCapabilityMatrixV02,
  level: CapabilityLevelV02,
): boolean {
  return matrix[level].kind === "supported";
}

/**
 * True iff every rung at or below `level` is `Supported`.
 */
export function adapterMatrixSupportsAtLeast(
  matrix: AdapterCapabilityMatrixV02,
  level: CapabilityLevelV02,
): boolean {
  const rank: Record<CapabilityLevelV02, number> = {
    identify: 0,
    inventory: 1,
    extract: 2,
    patch: 3,
  };
  const max = rank[level];
  return CAPABILITY_LEVELS_V02.filter((rung) => rank[rung] <= max).every(
    (rung) => matrix[rung].kind === "supported",
  );
}

export const OBSERVATION_HOOK_SCHEMA_VERSION = "0.1.0-alpha" as const;
export const OBSERVATION_HOOK_EVENT_KINDS = [
  "text",
  "choice",
  "branch",
  "scene",
  "frame",
  "error",
] as const;
export type ObservationHookEventKind = (typeof OBSERVATION_HOOK_EVENT_KINDS)[number];
export const OBSERVATION_REDACTION_STATUSES = ["not_required", "redacted"] as const;
export type ObservationRedactionStatus = (typeof OBSERVATION_REDACTION_STATUSES)[number];

export const RUNTIME_REQUESTED_OPERATIONS_V02 = [
  "trace",
  "branch_discovery",
  "capture",
  "smoke_validation",
] as const;
export type RuntimeRequestedOperationV02 = (typeof RUNTIME_REQUESTED_OPERATIONS_V02)[number];

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
  "font",
  "database",
  "metadata",
  "text",
] as const;
export type AssetKindV02 = (typeof ASSET_KINDS)[number];

export const ASSET_POLICY_SURFACE_KINDS = [
  "image_text",
  "ui_art",
  "song_title",
  "font",
  "credits",
  "video",
] as const;
export type AssetPolicySurfaceKindV02 = (typeof ASSET_POLICY_SURFACE_KINDS)[number];

export const ASSET_POLICY_TEXT_SOURCE_KINDS = [
  "metadata",
  "manual_transcription",
  "ocr_hint",
  "not_applicable",
] as const;
export type AssetPolicyTextSourceKindV02 = (typeof ASSET_POLICY_TEXT_SOURCE_KINDS)[number];

export const ASSET_POLICY_PATCH_MODES = [
  "metadata_only",
  "no_patch_required",
  "region_redraw_required",
  "asset_replacement_required",
  "font_substitution_required",
  "unsupported",
] as const;
export type AssetPolicyPatchModeV02 = (typeof ASSET_POLICY_PATCH_MODES)[number];

const TEXTLESS_ASSET_POLICY_SURFACE_KINDS: readonly AssetPolicySurfaceKindV02[] = [
  "ui_art",
  "font",
  "video",
];
const REGION_PATCH_ASSET_KINDS: readonly AssetKindV02[] = ["image", "video", "ui_texture"];

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

const LEGACY_PROTECTED_SPAN_KINDS = [
  "placeholder",
  "control_markup",
  "variable_placeholder",
  "ruby_annotation",
] as const;

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

export const LOCALIZATION_QUALITY_TAXONOMY_ID = "itotori-lqa-1" as const;
export const LOCALIZATION_QUALITY_TAXONOMY_VERSION = "itotori-quality-taxonomy-0.1.0" as const;

export const LOCALIZATION_QUALITY_SEVERITIES = ["critical", "major", "minor", "neutral"] as const;
export type LocalizationQualitySeverityV02 = (typeof LOCALIZATION_QUALITY_SEVERITIES)[number];

const LOCALIZATION_QUALITY_SEVERITY_WEIGHTS: Record<LocalizationQualitySeverityV02, number> = {
  critical: 25,
  major: 5,
  minor: 1,
  neutral: 0,
};

const BENCHMARK_NORMALIZED_PENALTY_TOLERANCE = 0.01;
const RFC3339_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export const LOCALIZATION_ROOT_CAUSES = [
  "source_content_defect",
  "source_annotation_gap",
  "style_guide_gap",
  "glossary_policy_gap",
  "prompt_or_context_pack_error",
  "model_draft_error",
  "human_edit_error",
  "deterministic_qa_rule_error",
  "patch_application_error",
  "runtime_environment_or_i18n_limit",
  "benchmark_seed",
  "unknown_unadjudicated",
] as const;
export type LocalizationRootCauseV02 = (typeof LOCALIZATION_ROOT_CAUSES)[number];

export const LOCALIZATION_ADJUDICATION_STATES = [
  "unreviewed",
  "confirmed",
  "rejected_false_positive",
  "duplicate",
  "needs_more_context",
  "intentional_or_accepted",
  "fixed_verified",
] as const;
export type LocalizationAdjudicationStateV02 = (typeof LOCALIZATION_ADJUDICATION_STATES)[number];

export const QUALITY_DETECTOR_KINDS = [
  "deterministic_qa",
  "llm_qa",
  "human_review",
  "runtime_probe",
  "seeded_defect_oracle",
  "patch_verify",
  "schema_guard",
] as const;
export type QualityDetectorKindV02 = (typeof QUALITY_DETECTOR_KINDS)[number];

export const BENCHMARK_SYSTEM_KINDS = [
  "raw_mtl_baseline",
  "itotori_draft",
  "itotori_repaired",
  "human_reference",
  "deterministic_fixture",
] as const;
export type BenchmarkSystemKindV02 = (typeof BENCHMARK_SYSTEM_KINDS)[number];

export const BENCHMARK_INPUT_KINDS = [
  "public_fixture",
  "private_local_corpus",
  "synthetic_fixture",
] as const;
export type BenchmarkInputKindV02 = (typeof BENCHMARK_INPUT_KINDS)[number];

export const BENCHMARK_PROVIDER_FAMILIES = [
  "fake",
  "recorded",
  "openrouter",
  "local-openai-compatible",
  "external_mtl",
  "local_tool",
] as const;
export type BenchmarkProviderFamilyV02 = (typeof BENCHMARK_PROVIDER_FAMILIES)[number];

export const BENCHMARK_COST_KINDS = [
  "billed",
  "provider_estimate",
  "local_estimate",
  "zero",
  "unknown",
] as const;
export type BenchmarkCostKindV02 = (typeof BENCHMARK_COST_KINDS)[number];

export const BENCHMARK_TOKEN_COUNT_SOURCES = [
  "provider_reported",
  "estimated",
  "deterministic_counter",
  "unknown",
] as const;
export type BenchmarkTokenCountSourceV02 = (typeof BENCHMARK_TOKEN_COUNT_SOURCES)[number];

export const BENCHMARK_RUN_STATUSES = ["passed", "failed", "partial"] as const;
export type BenchmarkRunStatusV02 = (typeof BENCHMARK_RUN_STATUSES)[number];

export const BENCHMARK_PROVIDER_RUN_STATUSES = [
  "succeeded",
  "failed",
  "partial",
  "skipped",
] as const;
export type BenchmarkProviderRunStatusV02 = (typeof BENCHMARK_PROVIDER_RUN_STATUSES)[number];

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
  "bridge_unit_id_mismatch",
  "protected_span_mapping_mismatch",
] as const;
export type PatchIncompatibilityReasonV02 = (typeof PATCH_INCOMPATIBILITY_REASONS_V02)[number];

export const PATCH_FAILURE_CATEGORIES_V02 = [
  "source_incompatible",
  "patch_write_failed",
  "protected_span_violation",
  "asset_missing",
  "adapter_unsupported",
  "output_hash_mismatch",
] as const;
export type PatchFailureCategoryV02 = (typeof PATCH_FAILURE_CATEGORIES_V02)[number];

export const PATCH_PARTIAL_WRITE_DISPOSITIONS_V02 = [
  "rolled_back",
  "cleaned_up",
  "retained_partial",
] as const;
export type PatchPartialWriteDispositionV02 = (typeof PATCH_PARTIAL_WRITE_DISPOSITIONS_V02)[number];

export const ITOTORI_PERMISSION_VALUES_V02 = [
  "project.import",
  "draft.write",
  "patch.export",
  "runtime.ingest",
  "feedback.import",
  "queue.manage",
  "queue.read",
  "catalog.read",
  "catalog.write",
  "system.reset",
] as const;
export type ItotoriPermissionV02 = (typeof ITOTORI_PERMISSION_VALUES_V02)[number];

export const CONTRACT_FIXTURE_KINDS_V02 = [
  "alpha-vertical-proof-manifest-v0.2",
  "asset-policy-v0.2",
  "benchmark-report-v0.2",
  "bridge-v0.2",
  "contract-compatibility-v0.2",
  "contract-fixtures-v0.2",
  "delta-package-v0.2",
  "finding-v0.2",
  "patch-export-v0.2",
  "patch-result-v0.2",
  "permission-local-user-v0.2",
  "runtime-evidence-v0.2",
  "triage-v0.2",
] as const;
export type ContractFixtureKindV02 = (typeof CONTRACT_FIXTURE_KINDS_V02)[number];

export const CONTRACT_COMPATIBILITY_STATUSES_V02 = ["compatible", "incompatible"] as const;
export type ContractCompatibilityStatusV02 = (typeof CONTRACT_COMPATIBILITY_STATUSES_V02)[number];

export const ALPHA_VERTICAL_PROOF_ARTIFACT_KINDS_V02 = [
  "public_fixture_manifest",
  "bridge_bundle",
  "patch_export",
  "patch_result",
  "delta_package",
  "runtime_report",
  "finding_report",
  "benchmark_report",
] as const;
export type AlphaVerticalProofArtifactKindV02 =
  (typeof ALPHA_VERTICAL_PROOF_ARTIFACT_KINDS_V02)[number];

export const ALPHA_VERTICAL_PROOF_HASH_SCOPES_V02 = [
  "public_fixture_manifest",
  "source_bundle",
  "bridge_bundle",
  "bridge_unit",
  "patch_export",
  "patch_result",
  "delta_package",
  "runtime_report",
  "finding_report",
  "benchmark_report",
  "provider_proof",
] as const;
export type AlphaVerticalProofHashScopeV02 = (typeof ALPHA_VERTICAL_PROOF_HASH_SCOPES_V02)[number];

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

export type AssetPolicyPatchRefV02 = {
  assetId: Uuid7;
  writeMode: PatchWriteModeV02;
  sourceUnitKey?: string;
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

export type LocaleBranchScopeV02 = {
  localeBranchId: Uuid7;
  targetLocale: Bcp47Locale;
  localeBranchKey?: string;
};

export type AssetPolicyDecisionV02 = {
  assetPolicyDecisionId: Uuid7;
  assetSurfaceKind: AssetPolicySurfaceKindV02;
  sourceAssetRef: AssetRefV02;
  sourceLocation?: SourceLocationV02;
  sourceText?: string;
  sourceHash: string;
  sourceRevision: SourceRevisionV02;
  policyAction: PolicyActionV02;
  targetText?: string;
  romanizationSystem?: string;
  preserveForm?: string;
  policyReason: string;
  textSourceKind: AssetPolicyTextSourceKindV02;
  patchMode: AssetPolicyPatchModeV02;
  patchRef?: AssetPolicyPatchRefV02;
  runtimeExpectation: RuntimeExpectationV02;
  reviewRequired?: boolean;
  linkedBridgeUnitRefs?: RuntimeBridgeUnitRefV02[];
  notes?: string[];
};

export type AssetPolicyBundleV02 = {
  schemaVersion: typeof BRIDGE_SCHEMA_VERSION_V02;
  assetPolicyBundleId: Uuid7;
  sourceBridgeId: Uuid7;
  sourceBundleHash?: string;
  sourceLocale: Bcp47Locale;
  localeBranch: LocaleBranchScopeV02;
  assets: BridgeAssetV02[];
  decisions: AssetPolicyDecisionV02[];
  compatibilityNotes: string[];
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

export type BenchmarkArtifactRefV02 = {
  artifactId: Uuid7;
  artifactKind: string;
  uri: string;
  hash?: string;
  mediaType?: string;
};

export type BenchmarkInputRefV02 = {
  corpusRefId: string;
  corpusKind: BenchmarkInputKindV02;
  label: string;
  manifestUri?: string;
  manifestHash?: string;
  sourceBundleHash?: string;
  sourceLocale: Bcp47Locale;
  targetLocale: Bcp47Locale;
  engineProfile: string;
  benchmarkSplit: string;
  sourceUnitCount: number;
  sourceCharacterCount: number;
  publicContent: boolean;
};

export type BenchmarkToolVersionV02 = {
  name: string;
  version: string;
  gitCommit?: string;
};

export type BenchmarkCommandLineV02 = {
  commandId: string;
  argv: string[];
};

export type BenchmarkComparedSystemV02 = {
  systemId: string;
  systemKind: BenchmarkSystemKindV02;
  displayName: string;
  generatedAt: string;
  providerRunIds: Uuid7[];
  promptPresetId?: string;
  promptPresetVersion?: string;
  outputArtifactRef?: BenchmarkArtifactRefV02;
};

export type BenchmarkProviderIdentityV02 = {
  providerFamily: BenchmarkProviderFamilyV02;
  endpointFamily: string;
  providerName: string;
  requestedModelId: string;
  actualModelId: string;
  upstreamProvider?: string;
  routeSettingsHash?: string;
};

export type BenchmarkPromptIdentityV02 = {
  promptPresetId: string;
  promptTemplateVersion: string;
  promptHash?: string;
  remotePresetSlug?: string;
  remotePresetVersion?: string;
  remotePresetConfigHash?: string;
};

export type BenchmarkTokenUsageV02 = {
  tokenCountSource: BenchmarkTokenCountSourceV02;
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
};

export type BenchmarkCostAmountV02 = {
  costKind: BenchmarkCostKindV02;
  currency: "USD";
  amountMicrosUsd?: number;
  pricingSnapshotId?: string;
};

export type BenchmarkProviderRunV02 = {
  providerRunId: Uuid7;
  systemId: string;
  taskKind: TriageTaskKindV02;
  startedAt: string;
  completedAt?: string;
  latencyMs?: number;
  status: BenchmarkProviderRunStatusV02;
  provider: BenchmarkProviderIdentityV02;
  prompt: BenchmarkPromptIdentityV02;
  structuredOutputMode: string;
  retryCount: number;
  errorClasses: string[];
  fallbackUsed: boolean;
  fallbackPlan?: string[];
  tokenUsage: BenchmarkTokenUsageV02;
  cost: BenchmarkCostAmountV02;
};

export type BenchmarkCostLedgerTotalV02 = {
  systemId: string;
  totalMicrosUsd: number;
};

export type BenchmarkCostLedgerV02 = {
  currency: "USD";
  reportTotalMicrosUsd: number;
  totalsBySystem: BenchmarkCostLedgerTotalV02[];
  includesUnknownCost: boolean;
};

export type BenchmarkFindingRecordV02 = {
  findingId: Uuid7;
  systemId: string;
  taxonomyId: typeof LOCALIZATION_QUALITY_TAXONOMY_ID;
  taxonomyVersion: typeof LOCALIZATION_QUALITY_TAXONOMY_VERSION;
  detectorKind: QualityDetectorKindV02;
  category: LocalizationQualityCategoryV02;
  qualitySubcategory?: string;
  qualitySeverity: LocalizationQualitySeverityV02;
  rootCause: LocalizationRootCauseV02;
  adjudicationState: LocalizationAdjudicationStateV02;
  affectedRefs: TriageSubjectRefV02[];
  evidence: EvidenceRecordV02[];
  provenance: ProvenanceRecordV02[];
  seededDefectId?: string;
  reviewerRationale?: string;
};

export type BenchmarkCountBucketV02<Bucket extends string = string> = {
  bucket: Bucket;
  count: number;
};

export type BenchmarkPenaltySummaryV02 = {
  penaltyTotal: number;
  penaltyPerThousandSourceChars: number;
  penaltyPerHundredSourceUnits: number;
};

export type BenchmarkSeededDefectOracleV02 = {
  seededDefectId: string;
  fixtureOrCorpusRefId: string;
  seedKind: string;
  targetLocale: Bcp47Locale;
  affectedRefs: TriageSubjectRefV02[];
  category: LocalizationQualityCategoryV02;
  qualitySubcategory?: string;
  qualitySeverity: LocalizationQualitySeverityV02;
  expectedRootCause: LocalizationRootCauseV02;
  expectedDetectorKinds: QualityDetectorKindV02[];
  matchedFindingIds: Uuid7[];
  publicContent: boolean;
};

export type DeterministicQaResultV02 = {
  deterministicQaRunId: Uuid7;
  evaluatedSystemId: string;
  checkName: string;
  checkVersion: string;
  startedAt: string;
  completedAt?: string;
  ruleCount: number;
  passedRuleCount: number;
  failedRuleCount: number;
  findingIds: Uuid7[];
  artifactRefs: BenchmarkArtifactRefV02[];
};

export type QaAgentMetricsV02 = {
  seededRecall: number;
  seededPrecision: number;
  f1: number;
  categoryAccuracy: number;
  qualitySeverityAccuracy: number;
  rootCauseAccuracy: number;
  criticalRecall: number;
  unscorableRate: number;
  humanConfirmedPrecision?: number;
  findingsEmitted: number;
  scorableFindings: number;
  adjudicatedFindings: number;
};

export type QaAgentEvaluationV02 = {
  qaAgentEvaluationId: Uuid7;
  qaAgentId: string;
  qaAgentVersion: string;
  evaluatedSystemId: string;
  providerRunIds: Uuid7[];
  findingIds: Uuid7[];
  metrics: QaAgentMetricsV02;
  limitations: string[];
};

export type HumanEvaluationResultV02 = {
  humanEvaluationId: Uuid7;
  reviewSessionId: Uuid7;
  evaluatedSystemIds: string[];
  reviewerCount: number;
  sampleUnitCount: number;
  sampleSourceCharacterCount: number;
  blindReview: boolean;
  adjudicatedFindingIds: Uuid7[];
  reviewerAgreementNotes?: string;
};

export type BenchmarkReportV02 = {
  schemaVersion: typeof BRIDGE_SCHEMA_VERSION_V02;
  benchmarkRunId: Uuid7;
  taxonomyId: typeof LOCALIZATION_QUALITY_TAXONOMY_ID;
  taxonomyVersion: typeof LOCALIZATION_QUALITY_TAXONOMY_VERSION;
  createdAt: string;
  benchmarkName: string;
  status: BenchmarkRunStatusV02;
  fixtureOrCorpusRefs: BenchmarkInputRefV02[];
  sourceLocale: Bcp47Locale;
  targetLocale: Bcp47Locale;
  engineProfile: string;
  gitCommit: string;
  bridgeSchemaVersion: typeof BRIDGE_SCHEMA_VERSION_V02;
  deterministicSeed?: string;
  toolVersions: BenchmarkToolVersionV02[];
  commandLines: BenchmarkCommandLineV02[];
  systemsCompared: BenchmarkComparedSystemV02[];
  providerModelCostRecords: BenchmarkProviderRunV02[];
  costLedger: BenchmarkCostLedgerV02;
  seededDefectOracle: BenchmarkSeededDefectOracleV02[];
  findingRecords: BenchmarkFindingRecordV02[];
  countsByQualitySeverity: BenchmarkCountBucketV02<LocalizationQualitySeverityV02>[];
  countsByCategory: BenchmarkCountBucketV02<LocalizationQualityCategoryV02>[];
  countsByRootCause: BenchmarkCountBucketV02<LocalizationRootCauseV02>[];
  countsByDetectorKind: BenchmarkCountBucketV02<QualityDetectorKindV02>[];
  countsByAdjudicationState: BenchmarkCountBucketV02<LocalizationAdjudicationStateV02>[];
  penaltySummary: BenchmarkPenaltySummaryV02;
  deterministicQaResults: DeterministicQaResultV02[];
  qaAgentEvaluations: QaAgentEvaluationV02[];
  humanEvaluationResults: HumanEvaluationResultV02[];
  knownBlindSpots: string[];
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
  protectedSpanMappings: Array<{
    raw: string;
    sourceSpanId?: Uuid7;
    sourceStartByte?: number;
    sourceEndByte?: number;
    targetStart: number;
    targetEnd: number;
  }>;
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
  actualBridgeUnitId?: Uuid7;
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

export type PatchFailureV02 = {
  failureId: Uuid7;
  category: PatchFailureCategoryV02;
  diagnosticCode: string;
  cause: string;
  assetId: Uuid7;
  bridgeUnitId: Uuid7;
  adapterId: string;
  command: string;
  patchExportEntryId?: Uuid7;
  sourceLocation?: SourceLocationV02;
};

export type PatchPartialWriteAccountingV02 = {
  attemptedAssetIds: Uuid7[];
  writtenAssetIds: Uuid7[];
  skippedAssetIds: Uuid7[];
  disposition: PatchPartialWriteDispositionV02;
  rollbackDiagnosticCode?: string;
};

export type PatchTouchedAssetV02 = {
  assetId: Uuid7;
  outputHash: string;
  byteSize: number;
};

export type PatchResultV02 = {
  schemaVersion: typeof BRIDGE_SCHEMA_VERSION_V02;
  patchResultId: Uuid7;
  patchExportId: Uuid7;
  adapterId: string;
  status: PatchResultStatusV02;
  outputHash?: string;
  touchedAssets?: PatchTouchedAssetV02[];
  failures: PatchFailureV02[];
  failureCategories?: PatchFailureCategoryV02[];
  partialWrite?: PatchPartialWriteAccountingV02;
  sourceCompatibility?: PatchSourceCompatibilityReportV02;
};

export type RuntimeFeatureSupportV02 = {
  feature: RuntimePlaybackFeatureV02;
  status: RuntimeFeatureStatusV02;
  evidenceTierCeiling?: RuntimeEvidenceTierV02;
  description: string;
  limitations: string[];
};

export type RuntimeCapabilityContractV02 = {
  contractVersion: typeof BRIDGE_SCHEMA_VERSION_V02;
  capabilityClass: RuntimeCapabilityClassV02;
  fidelityTierCeiling: RuntimeFidelityTierV02;
  evidenceTierCeiling: RuntimeEvidenceTierV02;
  features: RuntimeFeatureSupportV02[];
  limitations: string[];
};

export type ControlledPlaybackSessionV02 = {
  sessionId: Uuid7;
  adapterName: string;
  adapterVersion: string;
  capabilityClass: RuntimeCapabilityClassV02;
  requestedOperation: RuntimeRequestedOperationV02;
  status: "passed" | "failed";
  fidelityTier: RuntimeFidelityTierV02;
  evidenceTier: RuntimeEvidenceTierV02;
  featuresUsed: RuntimePlaybackFeatureV02[];
  limitations: string[];
};

export type ObservationAdapterId = {
  name: string;
  version: string;
};

export type ObservationEnvironment = {
  runtime: string;
  engine?: string;
  platform?: string;
  display?: string;
  locale?: string;
};

export type ObservationSourceRevision = {
  sourceId: string;
  revisionId?: string;
  contentHash?: string;
};

export type ObservationBridgeRef = {
  bridgeUnitId?: string;
  sourceUnitKey?: string;
  runtimeObjectId?: string;
};

export type ObservationRedactionMetadata = {
  status: ObservationRedactionStatus;
  rules?: string[];
  redactedFields?: string[];
};

export type ObservationArtifactRef = {
  artifactId: string;
  artifactKind: string;
  uri: string;
  mediaType?: string;
};

export type ObservationChoiceOption = {
  optionId: string;
  label: string;
  bridgeRef?: ObservationBridgeRef;
};

export type ObservationTextPayload = {
  payloadKind: "text";
  text: string;
  speaker?: string;
  textSurface?: string;
};

export type ObservationChoicePayload = {
  payloadKind: "choice";
  prompt?: string;
  options: ObservationChoiceOption[];
};

export type ObservationBranchPayload = {
  payloadKind: "branch";
  branchId: string;
  label?: string;
  destination?: string;
  taken?: boolean;
};

export type ObservationScenePayload = {
  payloadKind: "scene";
  sceneId: string;
  sceneName?: string;
};

export type ObservationFramePayload = {
  payloadKind: "frame";
  frame: number;
  width?: number;
  height?: number;
  artifactRef?: ObservationArtifactRef;
};

export type ObservationErrorPayload = {
  payloadKind: "error";
  errorType: string;
  message: string;
  fatal: boolean;
  stack?: string;
};

export type ObservationHookPayload =
  | ObservationTextPayload
  | ObservationChoicePayload
  | ObservationBranchPayload
  | ObservationScenePayload
  | ObservationFramePayload
  | ObservationErrorPayload;

export type ObservationHookEvent = {
  schemaVersion: typeof OBSERVATION_HOOK_SCHEMA_VERSION;
  eventId: string;
  observedAt: string;
  eventKind: ObservationHookEventKind;
  runtimeTargetId: string;
  adapterId: ObservationAdapterId;
  evidenceTier: RuntimeEvidenceTierV02;
  environment: ObservationEnvironment;
  sourceRevision?: ObservationSourceRevision;
  bridgeRefs?: ObservationBridgeRef[];
  redaction: ObservationRedactionMetadata;
  payload: ObservationHookPayload;
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
  runtimeCapabilities?: RuntimeCapabilityContractV02;
  controlledPlaybackSession?: ControlledPlaybackSessionV02;
  status: "passed" | "failed";
  createdAt: string;
  traceEvents: RuntimeTraceEventV02[];
  branchEvents: RuntimeBranchPointEventV02[];
  observationHookEvents?: ObservationHookEvent[];
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

export type FindingRecordFixtureV02 = {
  schemaVersion: typeof BRIDGE_SCHEMA_VERSION_V02;
  findingFixtureId: Uuid7;
  sourceTriageBundleId?: Uuid7;
  finding: FindingRecordV02;
  compatibilityNotes: string[];
};

export type PermissionLocalUserFixtureV02 = {
  schemaVersion: typeof BRIDGE_SCHEMA_VERSION_V02;
  permissionFixtureId: Uuid7;
  user: {
    userId: "local-user";
    displayName: "Local user";
  };
  grants: ItotoriPermissionV02[];
  compatibilityNotes: string[];
};

export type AlphaVerticalProofFixtureRefV02 = {
  fixtureId: string;
  publicManifestUri: string;
  publicManifestHash: string;
  publicRedistribution: "allowed";
};

export type AlphaVerticalProofEngineProfileV02 = {
  engineProfileId: string;
  engineKind: string;
  kaifuuProfileId: string;
  itotoriWorkflowId: string;
  utsushiRuntimeProfileId: string;
};

export type AlphaVerticalProofBridgeUnitRefV02 = {
  bridgeUnitId: Uuid7;
  sourceUnitKey: string;
  sourceHash: string;
};

export type AlphaVerticalProofArtifactRefV02 = {
  artifactId: Uuid7;
  artifactKind: AlphaVerticalProofArtifactKindV02;
  uri: string;
  hash: string;
  mediaType?: string;
  byteSize?: number;
};

export type AlphaVerticalProofArtifactRefsV02 = {
  publicFixtureManifest: AlphaVerticalProofArtifactRefV02 & {
    artifactKind: "public_fixture_manifest";
  };
  bridgeBundle: AlphaVerticalProofArtifactRefV02 & { artifactKind: "bridge_bundle" };
  patchExport: AlphaVerticalProofArtifactRefV02 & { artifactKind: "patch_export" };
  patchResult: AlphaVerticalProofArtifactRefV02 & { artifactKind: "patch_result" };
  deltaPackage: AlphaVerticalProofArtifactRefV02 & { artifactKind: "delta_package" };
  runtimeReport: AlphaVerticalProofArtifactRefV02 & { artifactKind: "runtime_report" };
  findingReport?: AlphaVerticalProofArtifactRefV02 & { artifactKind: "finding_report" };
  benchmarkReport: AlphaVerticalProofArtifactRefV02 & { artifactKind: "benchmark_report" };
};

export type AlphaVerticalProofBenchmarkOutputRefV02 = {
  benchmarkRunId: Uuid7;
  artifactRef: AlphaVerticalProofArtifactRefV02 & { artifactKind: "benchmark_report" };
};

export type AlphaVerticalProofContentHashV02 = {
  scope: AlphaVerticalProofHashScopeV02;
  contentId: string;
  hash: string;
};

export type AlphaVerticalProofManifestV02 = {
  schemaVersion: typeof BRIDGE_SCHEMA_VERSION_V02;
  proofManifestId: Uuid7;
  createdAt: string;
  fixture: AlphaVerticalProofFixtureRefV02;
  engineProfile: AlphaVerticalProofEngineProfileV02;
  sourceRevision: SourceRevisionV02;
  sourceBridgeId: Uuid7;
  sourceBundleHash: string;
  bridgeUnitRefs: AlphaVerticalProofBridgeUnitRefV02[];
  runtimeTargetIds: string[];
  artifactRefs: AlphaVerticalProofArtifactRefsV02;
  providerProofIds: Uuid7[];
  benchmarkOutputRefs: AlphaVerticalProofBenchmarkOutputRefV02[];
  contentHashes: AlphaVerticalProofContentHashV02[];
  compatibilityNotes: string[];
};

export type ContractFixtureManifestEntryV02 = {
  kind: ContractFixtureKindV02;
  path: string;
  description: string;
};

export type InvalidContractFixtureManifestEntryV02 = ContractFixtureManifestEntryV02 & {
  expectedSemanticError: string;
};

export type ContractFixtureManifestV02 = {
  schemaVersion: typeof BRIDGE_SCHEMA_VERSION_V02;
  suiteId: Uuid7;
  generatedAt: string;
  validFixtures: ContractFixtureManifestEntryV02[];
  invalidFixtures: InvalidContractFixtureManifestEntryV02[];
};

export type ContractCompatibilityCoverageV02 = {
  kind: ContractFixtureKindV02;
  typescriptValidator: string;
  rustValidator: string;
  validFixtures: string[];
  invalidFixtures: string[];
  status: ContractCompatibilityStatusV02;
};

export type ContractCompatibilityCrossRefV02 = {
  from: string;
  to: string;
  rule: string;
};

export type ContractCompatibilityReportV02 = {
  schemaVersion: typeof BRIDGE_SCHEMA_VERSION_V02;
  reportId: Uuid7;
  generatedAt: string;
  suiteManifestPath: string;
  sourceOfTruth: string;
  typescriptCommand: string[];
  rustCommand: string[];
  overallStatus: ContractCompatibilityStatusV02;
  coverage: ContractCompatibilityCoverageV02[];
  crossContractRefs: ContractCompatibilityCrossRefV02[];
  notes: string[];
};

export function assertBridgeBundle(value: unknown): asserts value is BridgeBundle {
  const bundle = asRecord(value, "BridgeBundle");
  assertEqual(bundle.schemaVersion, "0.1.0", "BridgeBundle.schemaVersion");
  assertString(bundle.bridgeId, "BridgeBundle.bridgeId");
  assertString(bundle.sourceBundleHash, "BridgeBundle.sourceBundleHash");
  assertString(bundle.sourceLocale, "BridgeBundle.sourceLocale");
  const units = asArray(bundle.units, "BridgeBundle.units");
  for (const [index, unit] of units.entries()) {
    assertBridgeUnit(unit, `BridgeBundle.units[${index}]`);
  }
}

function assertBridgeUnit(value: unknown, label: string): asserts value is BridgeUnit {
  const unit = asRecord(value, label);
  assertString(unit.bridgeUnitId, `${label}.bridgeUnitId`);
  assertString(unit.sourceUnitKey, `${label}.sourceUnitKey`);
  assertString(unit.occurrenceId, `${label}.occurrenceId`);
  assertString(unit.sourceHash, `${label}.sourceHash`);
  assertString(unit.sourceLocale, `${label}.sourceLocale`);
  assertString(unit.sourceText, `${label}.sourceText`);
  if (unit.speaker !== undefined && typeof unit.speaker !== "string") {
    throw new Error(`${label}.speaker must be a string`);
  }
  assertString(unit.textSurface, `${label}.textSurface`);
  const spans = asArray(unit.protectedSpans, `${label}.protectedSpans`);
  for (const [index, span] of spans.entries()) {
    assertProtectedSpan(span, `${label}.protectedSpans[${index}]`, unit.sourceText);
  }
  const patchRef = asRecord(unit.patchRef, `${label}.patchRef`);
  assertString(patchRef.assetId, `${label}.patchRef.assetId`);
  assertEqual(patchRef.writeMode, "replace", `${label}.patchRef.writeMode`);
  assertString(patchRef.sourceUnitKey, `${label}.patchRef.sourceUnitKey`);
}

function assertProtectedSpan(
  value: unknown,
  label: string,
  sourceText: string,
): asserts value is ProtectedSpan {
  const span = asRecord(value, label);
  assertEnum(span.kind, LEGACY_PROTECTED_SPAN_KINDS, `${label}.kind`);
  assertString(span.raw, `${label}.raw`);
  const [startByte, endByte] = asByteRangeNumbers(span.start, span.end, label);
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
  assertSpanRawMatchesSource(sourceText, span.raw, startByte, endByte, label);

  if (span.kind === "ruby_annotation") {
    asByteRangeNumbers(span.baseStartByte, span.baseEndByte, `${label}.base`);
    asByteRangeNumbers(span.annotationStartByte, span.annotationEndByte, `${label}.annotation`);
    assertString(span.annotationText, `${label}.annotationText`);
    assertOptionalString(span.annotationLocale, `${label}.annotationLocale`);
    assertOptionalString(span.displayMode, `${label}.displayMode`);
  }
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
  const bridgeUnitIds = new Set<Uuid7>();
  for (const [index, unit] of units.entries()) {
    const label = `BridgeBundleV02.units[${index}]`;
    assertLocalizationUnitV02(unit, label);
    if (bridgeUnitIds.has(unit.bridgeUnitId)) {
      throw new Error(`${label}.bridgeUnitId must be unique within BridgeBundleV02.units`);
    }
    bridgeUnitIds.add(unit.bridgeUnitId);
    assertLocalizationUnitAssetRefsExist(unit, label, assetIds);
    assertPatchRefMatchesUnitV02(unit, label);
  }

  const policyRecords = asArray(bundle.policyRecords, "BridgeBundleV02.policyRecords");
  for (const [index, record] of policyRecords.entries()) {
    assertPolicyRecordV02(record, `BridgeBundleV02.policyRecords[${index}]`);
  }
}

export function assertAssetPolicyBundleV02(value: unknown): asserts value is AssetPolicyBundleV02 {
  const bundle = asRecord(value, "AssetPolicyBundleV02");
  assertEqual(
    bundle.schemaVersion,
    BRIDGE_SCHEMA_VERSION_V02,
    "AssetPolicyBundleV02.schemaVersion",
  );
  assertUuid7(bundle.assetPolicyBundleId, "AssetPolicyBundleV02.assetPolicyBundleId");
  assertUuid7(bundle.sourceBridgeId, "AssetPolicyBundleV02.sourceBridgeId");
  assertOptionalHashStringV02(bundle.sourceBundleHash, "AssetPolicyBundleV02.sourceBundleHash");
  assertString(bundle.sourceLocale, "AssetPolicyBundleV02.sourceLocale");
  assertLocaleBranchScopeV02(bundle.localeBranch, "AssetPolicyBundleV02.localeBranch");

  const assets = asArray(bundle.assets, "AssetPolicyBundleV02.assets");
  const assetsById = new Map<Uuid7, BridgeAssetV02>();
  for (const [index, asset] of assets.entries()) {
    const label = `AssetPolicyBundleV02.assets[${index}]`;
    assertBridgeAssetV02(asset, label);
    if (assetsById.has(asset.assetId)) {
      throw new Error(`${label}.assetId must be unique within AssetPolicyBundleV02.assets`);
    }
    assetsById.set(asset.assetId, asset);
  }

  const decisions = asArray(bundle.decisions, "AssetPolicyBundleV02.decisions");
  if (decisions.length === 0) {
    throw new Error("AssetPolicyBundleV02.decisions must contain at least one policy decision");
  }
  const decisionIds = new Set<Uuid7>();
  for (const [index, decision] of decisions.entries()) {
    const label = `AssetPolicyBundleV02.decisions[${index}]`;
    assertAssetPolicyDecisionV02(decision, label);
    if (decisionIds.has(decision.assetPolicyDecisionId)) {
      throw new Error(
        `${label}.assetPolicyDecisionId must be unique within AssetPolicyBundleV02.decisions`,
      );
    }
    decisionIds.add(decision.assetPolicyDecisionId);
    assertAssetPolicyDecisionAssetRefsExist(decision, label, assetsById);
  }

  assertStringArray(bundle.compatibilityNotes, "AssetPolicyBundleV02.compatibilityNotes");
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

export function assertBenchmarkReportV02(value: unknown): asserts value is BenchmarkReportV02 {
  assertNoConfidenceFields(value, "BenchmarkReportV02");
  const report = asRecord(value, "BenchmarkReportV02");
  assertEqual(report.schemaVersion, BRIDGE_SCHEMA_VERSION_V02, "BenchmarkReportV02.schemaVersion");
  assertUuid7(report.benchmarkRunId, "BenchmarkReportV02.benchmarkRunId");
  assertEqual(report.taxonomyId, LOCALIZATION_QUALITY_TAXONOMY_ID, "BenchmarkReportV02.taxonomyId");
  assertEqual(
    report.taxonomyVersion,
    LOCALIZATION_QUALITY_TAXONOMY_VERSION,
    "BenchmarkReportV02.taxonomyVersion",
  );
  assertRfc3339Instant(report.createdAt, "BenchmarkReportV02.createdAt");
  assertString(report.benchmarkName, "BenchmarkReportV02.benchmarkName");
  assertEnum(report.status, BENCHMARK_RUN_STATUSES, "BenchmarkReportV02.status");
  assertString(report.sourceLocale, "BenchmarkReportV02.sourceLocale");
  assertString(report.targetLocale, "BenchmarkReportV02.targetLocale");
  assertString(report.engineProfile, "BenchmarkReportV02.engineProfile");
  assertString(report.gitCommit, "BenchmarkReportV02.gitCommit");
  assertEqual(
    report.bridgeSchemaVersion,
    BRIDGE_SCHEMA_VERSION_V02,
    "BenchmarkReportV02.bridgeSchemaVersion",
  );
  assertOptionalString(report.deterministicSeed, "BenchmarkReportV02.deterministicSeed");

  const inputRefs = asArray(report.fixtureOrCorpusRefs, "BenchmarkReportV02.fixtureOrCorpusRefs");
  if (inputRefs.length === 0) {
    throw new Error("BenchmarkReportV02.fixtureOrCorpusRefs must contain at least one ref");
  }
  const inputRefIds = new Set<string>();
  let totalSourceUnitCount = 0;
  let totalSourceCharacterCount = 0;
  for (const [index, inputRef] of inputRefs.entries()) {
    const label = `BenchmarkReportV02.fixtureOrCorpusRefs[${index}]`;
    assertBenchmarkInputRefV02(inputRef, label);
    if (inputRefIds.has(inputRef.corpusRefId)) {
      throw new Error(`${label}.corpusRefId must be unique within fixtureOrCorpusRefs`);
    }
    inputRefIds.add(inputRef.corpusRefId);
    totalSourceUnitCount += inputRef.sourceUnitCount;
    totalSourceCharacterCount += inputRef.sourceCharacterCount;
  }

  const toolVersions = asArray(report.toolVersions, "BenchmarkReportV02.toolVersions");
  for (const [index, toolVersion] of toolVersions.entries()) {
    assertBenchmarkToolVersionV02(toolVersion, `BenchmarkReportV02.toolVersions[${index}]`);
  }

  const commandLines = asArray(report.commandLines, "BenchmarkReportV02.commandLines");
  for (const [index, commandLine] of commandLines.entries()) {
    assertBenchmarkCommandLineV02(commandLine, `BenchmarkReportV02.commandLines[${index}]`);
  }

  const systemsInput = asArray(report.systemsCompared, "BenchmarkReportV02.systemsCompared");
  if (systemsInput.length === 0) {
    throw new Error("BenchmarkReportV02.systemsCompared must contain at least one system");
  }
  const systemIds = new Set<string>();
  const declaredProviderRunIds = new Set<Uuid7>();
  for (const [index, system] of systemsInput.entries()) {
    const label = `BenchmarkReportV02.systemsCompared[${index}]`;
    assertBenchmarkComparedSystemV02(system, label);
    if (systemIds.has(system.systemId)) {
      throw new Error(`${label}.systemId must be unique within systemsCompared`);
    }
    systemIds.add(system.systemId);
    for (const providerRunId of system.providerRunIds) {
      declaredProviderRunIds.add(providerRunId);
    }
  }

  const providerRunsInput = asArray(
    report.providerModelCostRecords,
    "BenchmarkReportV02.providerModelCostRecords",
  );
  const providerRunIds = new Set<Uuid7>();
  const providerRunSystemIds = new Map<Uuid7, string>();
  const llmQaProviderRunSystemIds = new Map<Uuid7, string>();
  const costTotalsBySystem = new Map<string, number>();
  let reportTotalMicrosUsd = 0;
  let includesUnknownCost = false;
  for (const [index, providerRun] of providerRunsInput.entries()) {
    const label = `BenchmarkReportV02.providerModelCostRecords[${index}]`;
    assertBenchmarkProviderRunV02(providerRun, label);
    if (providerRunIds.has(providerRun.providerRunId)) {
      throw new Error(`${label}.providerRunId must be unique within providerModelCostRecords`);
    }
    providerRunIds.add(providerRun.providerRunId);
    providerRunSystemIds.set(providerRun.providerRunId, providerRun.systemId);
    if (providerRun.taskKind === "llm_qa") {
      llmQaProviderRunSystemIds.set(providerRun.providerRunId, providerRun.systemId);
    }
    assertKnownStringRefV02(providerRun.systemId, `${label}.systemId`, "system", systemIds);
    if (providerRun.cost.costKind === "unknown") {
      includesUnknownCost = true;
      continue;
    }
    const amountMicrosUsd = providerRun.cost.amountMicrosUsd ?? 0;
    reportTotalMicrosUsd += amountMicrosUsd;
    costTotalsBySystem.set(
      providerRun.systemId,
      (costTotalsBySystem.get(providerRun.systemId) ?? 0) + amountMicrosUsd,
    );
  }
  for (const providerRunId of declaredProviderRunIds) {
    if (!providerRunIds.has(providerRunId)) {
      throw new Error(
        `BenchmarkReportV02.systemsCompared providerRunId ${providerRunId} must reference providerModelCostRecords`,
      );
    }
  }
  assertBenchmarkCostLedgerV02(
    report.costLedger,
    "BenchmarkReportV02.costLedger",
    systemIds,
    reportTotalMicrosUsd,
    costTotalsBySystem,
    includesUnknownCost,
  );

  const seededDefectOracle = asArray(
    report.seededDefectOracle,
    "BenchmarkReportV02.seededDefectOracle",
  );
  const seededDefectIds = new Set<string>();
  for (const [index, seed] of seededDefectOracle.entries()) {
    const label = `BenchmarkReportV02.seededDefectOracle[${index}]`;
    assertBenchmarkSeededDefectOracleV02(seed, label);
    assertKnownStringRefV02(
      seed.fixtureOrCorpusRefId,
      `${label}.fixtureOrCorpusRefId`,
      "fixtureOrCorpusRef",
      inputRefIds,
    );
    if (seededDefectIds.has(seed.seededDefectId)) {
      throw new Error(`${label}.seededDefectId must be unique within seededDefectOracle`);
    }
    seededDefectIds.add(seed.seededDefectId);
  }

  const findingRecords = asArray(report.findingRecords, "BenchmarkReportV02.findingRecords");
  const findingIds = new Set<Uuid7>();
  const findingQualitySeverities: LocalizationQualitySeverityV02[] = [];
  const findingCategories: LocalizationQualityCategoryV02[] = [];
  const findingRootCauses: LocalizationRootCauseV02[] = [];
  const findingDetectorKinds: QualityDetectorKindV02[] = [];
  const findingAdjudicationStates: LocalizationAdjudicationStateV02[] = [];
  const findingSystemIds = new Map<Uuid7, string>();
  const llmQaFindingSystemIds = new Map<Uuid7, string>();
  for (const [index, finding] of findingRecords.entries()) {
    const label = `BenchmarkReportV02.findingRecords[${index}]`;
    assertBenchmarkFindingRecordV02(finding, label);
    assertKnownStringRefV02(finding.systemId, `${label}.systemId`, "system", systemIds);
    if (findingIds.has(finding.findingId)) {
      throw new Error(`${label}.findingId must be unique within findingRecords`);
    }
    if (finding.seededDefectId !== undefined && !seededDefectIds.has(finding.seededDefectId)) {
      throw new Error(`${label}.seededDefectId must reference seededDefectOracle`);
    }
    findingIds.add(finding.findingId);
    findingSystemIds.set(finding.findingId, finding.systemId);
    findingQualitySeverities.push(finding.qualitySeverity);
    findingCategories.push(finding.category);
    findingRootCauses.push(finding.rootCause);
    findingDetectorKinds.push(finding.detectorKind);
    findingAdjudicationStates.push(finding.adjudicationState);
    if (finding.detectorKind === "llm_qa") {
      llmQaFindingSystemIds.set(finding.findingId, finding.systemId);
    }
  }

  for (const [index, seed] of (seededDefectOracle as BenchmarkSeededDefectOracleV02[]).entries()) {
    for (const [matchIndex, findingId] of seed.matchedFindingIds.entries()) {
      if (!findingIds.has(findingId)) {
        throw new Error(
          `BenchmarkReportV02.seededDefectOracle[${index}].matchedFindingIds[${matchIndex}] must reference findingRecords`,
        );
      }
    }
  }

  assertCountBucketsMatchV02(
    findingQualitySeverities,
    assertBenchmarkCountBucketsV02(
      report.countsByQualitySeverity,
      LOCALIZATION_QUALITY_SEVERITIES,
      "BenchmarkReportV02.countsByQualitySeverity",
    ),
    "BenchmarkReportV02.countsByQualitySeverity",
  );
  assertCountBucketsMatchV02(
    findingCategories,
    assertBenchmarkCountBucketsV02(
      report.countsByCategory,
      LOCALIZATION_QUALITY_CATEGORIES,
      "BenchmarkReportV02.countsByCategory",
    ),
    "BenchmarkReportV02.countsByCategory",
  );
  assertCountBucketsMatchV02(
    findingRootCauses,
    assertBenchmarkCountBucketsV02(
      report.countsByRootCause,
      LOCALIZATION_ROOT_CAUSES,
      "BenchmarkReportV02.countsByRootCause",
    ),
    "BenchmarkReportV02.countsByRootCause",
  );
  assertCountBucketsMatchV02(
    findingDetectorKinds,
    assertBenchmarkCountBucketsV02(
      report.countsByDetectorKind,
      QUALITY_DETECTOR_KINDS,
      "BenchmarkReportV02.countsByDetectorKind",
    ),
    "BenchmarkReportV02.countsByDetectorKind",
  );
  assertCountBucketsMatchV02(
    findingAdjudicationStates,
    assertBenchmarkCountBucketsV02(
      report.countsByAdjudicationState,
      LOCALIZATION_ADJUDICATION_STATES,
      "BenchmarkReportV02.countsByAdjudicationState",
    ),
    "BenchmarkReportV02.countsByAdjudicationState",
  );

  assertBenchmarkPenaltySummaryV02(
    report.penaltySummary,
    "BenchmarkReportV02.penaltySummary",
    findingQualitySeverities,
    totalSourceCharacterCount,
    totalSourceUnitCount,
  );

  const deterministicQaResults = asArray(
    report.deterministicQaResults,
    "BenchmarkReportV02.deterministicQaResults",
  );
  for (const [index, result] of deterministicQaResults.entries()) {
    const label = `BenchmarkReportV02.deterministicQaResults[${index}]`;
    assertDeterministicQaResultV02(result, label);
    assertKnownStringRefV02(
      result.evaluatedSystemId,
      `${label}.evaluatedSystemId`,
      "system",
      systemIds,
    );
    assertKnownUuid7RefsV02(result.findingIds, `${label}.findingIds`, "finding", findingIds);
  }

  const qaAgentEvaluations = asArray(
    report.qaAgentEvaluations,
    "BenchmarkReportV02.qaAgentEvaluations",
  );
  const qaAgentProviderRunIdsBySystem = new Map<string, Set<Uuid7>>();
  const qaAgentFindingIdsBySystem = new Map<string, Set<Uuid7>>();
  for (const [index, evaluation] of qaAgentEvaluations.entries()) {
    const label = `BenchmarkReportV02.qaAgentEvaluations[${index}]`;
    assertQaAgentEvaluationV02(evaluation, label);
    assertKnownStringRefV02(
      evaluation.evaluatedSystemId,
      `${label}.evaluatedSystemId`,
      "system",
      systemIds,
    );
    assertKnownUuid7RefsV02(
      evaluation.providerRunIds,
      `${label}.providerRunIds`,
      "providerRun",
      providerRunIds,
    );
    assertKnownUuid7RefsV02(evaluation.findingIds, `${label}.findingIds`, "finding", findingIds);
    for (const providerRunId of evaluation.providerRunIds) {
      const providerRunSystemId = providerRunSystemIds.get(providerRunId);
      if (providerRunSystemId !== evaluation.evaluatedSystemId) {
        throw new Error(
          `${label}.providerRunIds must reference providerModelCostRecords for evaluatedSystemId ${evaluation.evaluatedSystemId}`,
        );
      }
      addToSetMap(qaAgentProviderRunIdsBySystem, evaluation.evaluatedSystemId, providerRunId);
    }
    for (const findingId of evaluation.findingIds) {
      const findingSystemId = findingSystemIds.get(findingId);
      if (findingSystemId !== evaluation.evaluatedSystemId) {
        throw new Error(
          `${label}.findingIds must reference findingRecords for evaluatedSystemId ${evaluation.evaluatedSystemId}`,
        );
      }
      addToSetMap(qaAgentFindingIdsBySystem, evaluation.evaluatedSystemId, findingId);
    }
  }
  assertQaAgentCoverageV02(
    llmQaProviderRunSystemIds,
    llmQaFindingSystemIds,
    qaAgentProviderRunIdsBySystem,
    qaAgentFindingIdsBySystem,
  );

  const humanEvaluationResults = asArray(
    report.humanEvaluationResults,
    "BenchmarkReportV02.humanEvaluationResults",
  );
  for (const [index, evaluation] of humanEvaluationResults.entries()) {
    const label = `BenchmarkReportV02.humanEvaluationResults[${index}]`;
    assertHumanEvaluationResultV02(evaluation, label);
    for (const [systemIndex, systemId] of evaluation.evaluatedSystemIds.entries()) {
      assertKnownStringRefV02(
        systemId,
        `${label}.evaluatedSystemIds[${systemIndex}]`,
        "system",
        systemIds,
      );
    }
    assertKnownUuid7RefsV02(
      evaluation.adjudicatedFindingIds,
      `${label}.adjudicatedFindingIds`,
      "finding",
      findingIds,
    );
  }

  assertStringArray(report.knownBlindSpots, "BenchmarkReportV02.knownBlindSpots");
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
  assertOptionalRfc3339Instant(patch.generatedAt, "PatchExportV02.generatedAt");
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

export function computePatchResultOutputHashRollupV02(
  touchedAssets: readonly PatchTouchedAssetV02[],
): string {
  const sorted = [...touchedAssets].sort((a, b) =>
    a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0,
  );
  const payload = sorted.map((asset) => `${asset.assetId}\n${asset.outputHash}\n`).join("");
  const digest = createHash("sha256").update(payload, "utf8").digest("hex");
  return `sha256:${digest}`;
}

function assertPatchFailureV02(value: unknown, label: string): PatchFailureV02 {
  const failure = asRecord(value, label);
  assertUuid7(failure.failureId, `${label}.failureId`);
  assertEnum(failure.category, PATCH_FAILURE_CATEGORIES_V02, `${label}.category`);
  assertString(failure.diagnosticCode, `${label}.diagnosticCode`);
  assertString(failure.cause, `${label}.cause`);
  assertUuid7(failure.assetId, `${label}.assetId`);
  assertUuid7(failure.bridgeUnitId, `${label}.bridgeUnitId`);
  assertString(failure.adapterId, `${label}.adapterId`);
  assertString(failure.command, `${label}.command`);
  assertOptionalUuid7(failure.patchExportEntryId, `${label}.patchExportEntryId`);
  if (failure.sourceLocation !== undefined) {
    assertSourceLocationV02(failure.sourceLocation, `${label}.sourceLocation`);
  }
  return failure as PatchFailureV02;
}

function assertPatchFailuresV02(value: unknown, label: string): PatchFailureV02[] {
  const array = asArray(value, label);
  const failures: PatchFailureV02[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of array.entries()) {
    const failure = assertPatchFailureV02(entry, `${label}[${index}]`);
    if (seen.has(failure.failureId)) {
      throw new Error(`${label}[${index}].failureId must not duplicate ${failure.failureId}`);
    }
    seen.add(failure.failureId);
    failures.push(failure);
  }
  return failures;
}

function assertPatchTouchedAssetV02(value: unknown, label: string): PatchTouchedAssetV02 {
  const asset = asRecord(value, label);
  assertUuid7(asset.assetId, `${label}.assetId`);
  assertHashStringV02(asset.outputHash, `${label}.outputHash`);
  assertNonNegativeInteger(asset.byteSize, `${label}.byteSize`);
  return asset as PatchTouchedAssetV02;
}

function assertPatchTouchedAssetsV02(value: unknown, label: string): PatchTouchedAssetV02[] {
  const array = asArray(value, label);
  const assets: PatchTouchedAssetV02[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of array.entries()) {
    const asset = assertPatchTouchedAssetV02(entry, `${label}[${index}]`);
    if (seen.has(asset.assetId)) {
      throw new Error(`${label}[${index}].assetId must not duplicate ${asset.assetId}`);
    }
    seen.add(asset.assetId);
    assets.push(asset);
  }
  return assets;
}

function assertPatchPartialWriteAccountingV02(
  value: unknown,
  label: string,
): PatchPartialWriteAccountingV02 {
  const accounting = asRecord(value, label);
  const attempted = assertUuid7ArrayUnique(
    accounting.attemptedAssetIds,
    `${label}.attemptedAssetIds`,
  );
  const written = assertUuid7ArrayUnique(accounting.writtenAssetIds, `${label}.writtenAssetIds`);
  const skipped = assertUuid7ArrayUnique(accounting.skippedAssetIds, `${label}.skippedAssetIds`);
  assertEnum(accounting.disposition, PATCH_PARTIAL_WRITE_DISPOSITIONS_V02, `${label}.disposition`);
  if (accounting.rollbackDiagnosticCode !== undefined) {
    assertString(accounting.rollbackDiagnosticCode, `${label}.rollbackDiagnosticCode`);
  }
  const attemptedSet = new Set(attempted);
  const writtenSet = new Set(written);
  const skippedSet = new Set(skipped);
  if (writtenSet.size + skippedSet.size !== attemptedSet.size) {
    throw new Error(
      `${label}.attemptedAssetIds must equal disjoint union of writtenAssetIds and skippedAssetIds: kaifuu.patch_result.silent_partial_write`,
    );
  }
  for (const id of writtenSet) {
    if (skippedSet.has(id)) {
      throw new Error(
        `${label}.writtenAssetIds must not overlap skippedAssetIds: kaifuu.patch_result.silent_partial_write`,
      );
    }
    if (!attemptedSet.has(id)) {
      throw new Error(
        `${label}.attemptedAssetIds must equal disjoint union of writtenAssetIds and skippedAssetIds: kaifuu.patch_result.silent_partial_write`,
      );
    }
  }
  for (const id of skippedSet) {
    if (!attemptedSet.has(id)) {
      throw new Error(
        `${label}.attemptedAssetIds must equal disjoint union of writtenAssetIds and skippedAssetIds: kaifuu.patch_result.silent_partial_write`,
      );
    }
  }
  if (accounting.disposition === "retained_partial") {
    if (accounting.rollbackDiagnosticCode !== undefined) {
      throw new Error(
        `${label}.rollbackDiagnosticCode must be omitted when disposition is retained_partial`,
      );
    }
  } else {
    if (accounting.rollbackDiagnosticCode === undefined) {
      throw new Error(
        `${label}.rollbackDiagnosticCode is required when disposition is ${accounting.disposition}: kaifuu.patch_result.rollback_diagnostic_required`,
      );
    }
  }
  return accounting as PatchPartialWriteAccountingV02;
}

function assertUuid7ArrayUnique(value: unknown, label: string): Uuid7[] {
  const array = asArray(value, label);
  const seen = new Set<Uuid7>();
  const ids: Uuid7[] = [];
  for (const [index, item] of array.entries()) {
    assertUuid7(item, `${label}[${index}]`);
    if (seen.has(item)) {
      throw new Error(`${label}[${index}] must not duplicate ${item}`);
    }
    seen.add(item);
    ids.push(item);
  }
  return ids;
}

export function assertPatchResultV02(value: unknown): asserts value is PatchResultV02 {
  const result = asRecord(value, "PatchResultV02");
  assertEqual(result.schemaVersion, BRIDGE_SCHEMA_VERSION_V02, "PatchResultV02.schemaVersion");
  assertUuid7(result.patchResultId, "PatchResultV02.patchResultId");
  assertUuid7(result.patchExportId, "PatchResultV02.patchExportId");
  assertString(result.adapterId, "PatchResultV02.adapterId");
  assertEnum(result.status, PATCH_RESULT_STATUSES_V02, "PatchResultV02.status");
  assertOptionalHashStringV02(result.outputHash, "PatchResultV02.outputHash");
  const failures = assertPatchFailuresV02(result.failures, "PatchResultV02.failures");
  const touchedAssets =
    result.touchedAssets !== undefined
      ? assertPatchTouchedAssetsV02(result.touchedAssets, "PatchResultV02.touchedAssets")
      : undefined;
  let declaredCategories: PatchFailureCategoryV02[] | undefined;
  if (result.failureCategories !== undefined) {
    const categoriesArray = asArray(result.failureCategories, "PatchResultV02.failureCategories");
    const seenCategories = new Set<string>();
    const declared: PatchFailureCategoryV02[] = [];
    for (const [index, entry] of categoriesArray.entries()) {
      assertEnum(entry, PATCH_FAILURE_CATEGORIES_V02, `PatchResultV02.failureCategories[${index}]`);
      if (seenCategories.has(entry)) {
        throw new Error(`PatchResultV02.failureCategories[${index}] must not duplicate ${entry}`);
      }
      seenCategories.add(entry);
      declared.push(entry);
    }
    declaredCategories = declared;
  }
  const partialWrite =
    result.partialWrite !== undefined
      ? assertPatchPartialWriteAccountingV02(result.partialWrite, "PatchResultV02.partialWrite")
      : undefined;

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
    result.sourceCompatibility !== undefined &&
    result.sourceCompatibility.status !== "incompatible"
  ) {
    throw new Error(
      "PatchResultV02.sourceCompatibility.status must be incompatible for incompatible_source",
    );
  }

  if (result.status === "passed") {
    if (result.outputHash === undefined) {
      throw new Error(
        "PatchResultV02.outputHash is required when status is passed: kaifuu.patch_result.passed_requires_output_hash",
      );
    }
    if (touchedAssets === undefined || touchedAssets.length === 0) {
      throw new Error(
        "PatchResultV02.touchedAssets must include at least one asset when status is passed: kaifuu.patch_result.passed_requires_touched_assets",
      );
    }
    if (failures.length !== 0) {
      throw new Error(
        "PatchResultV02.failures must be empty when status is passed: kaifuu.patch_result.passed_must_have_no_failures",
      );
    }
    if (declaredCategories !== undefined) {
      throw new Error(
        "PatchResultV02.failureCategories must be omitted when status is passed: kaifuu.patch_result.passed_must_omit_failure_categories",
      );
    }
    if (partialWrite !== undefined) {
      throw new Error(
        "PatchResultV02.partialWrite must be omitted when status is passed: kaifuu.patch_result.passed_must_omit_partial_write",
      );
    }
    const rollup = computePatchResultOutputHashRollupV02(touchedAssets);
    if (rollup !== result.outputHash) {
      throw new Error(
        `PatchResultV02.outputHash must equal rollup of touchedAssets[].outputHash (expected ${rollup}): kaifuu.patch_result.output_hash_drift`,
      );
    }
  }

  if (result.status === "failed" || result.status === "incompatible_source") {
    if (failures.length === 0) {
      throw new Error(
        `PatchResultV02.failures must include at least one entry when status is ${result.status}: kaifuu.patch_result.non_passed_requires_failures`,
      );
    }
    if (declaredCategories === undefined) {
      throw new Error(
        `PatchResultV02.failureCategories is required when status is ${result.status}: kaifuu.patch_result.missing_failure_category`,
      );
    }
    const observedSet = new Set<PatchFailureCategoryV02>();
    for (const failure of failures) {
      observedSet.add(failure.category);
    }
    const declaredSet = new Set(declaredCategories);
    for (const observed of observedSet) {
      if (!declaredSet.has(observed)) {
        throw new Error(
          `PatchResultV02.failureCategories is missing ${observed}: kaifuu.patch_result.missing_failure_category`,
        );
      }
    }
    for (const declared of declaredSet) {
      if (!observedSet.has(declared)) {
        throw new Error(
          `PatchResultV02.failureCategories contains unobserved ${declared}: kaifuu.patch_result.unknown_failure_category`,
        );
      }
    }
    if (result.outputHash !== undefined) {
      throw new Error(`PatchResultV02.outputHash must be omitted when status is ${result.status}`);
    }
    if (touchedAssets !== undefined) {
      throw new Error(
        `PatchResultV02.touchedAssets must be omitted when status is ${result.status}`,
      );
    }
  }

  if (result.status === "incompatible_source") {
    for (const failure of failures) {
      if (failure.category !== "source_incompatible") {
        throw new Error(
          `PatchResultV02.failures[*].category must be source_incompatible when status is incompatible_source: kaifuu.patch_result.incompatible_source_category_required`,
        );
      }
    }
  }

  if (partialWrite !== undefined) {
    if (result.status === "passed") {
      throw new Error(
        "PatchResultV02.partialWrite must be omitted when status is passed: kaifuu.patch_result.passed_must_omit_partial_write",
      );
    }
    const attemptedSet = new Set(partialWrite.attemptedAssetIds);
    for (const failure of failures) {
      if (!attemptedSet.has(failure.assetId)) {
        throw new Error(
          `PatchResultV02.failures asset ${failure.assetId} must appear in partialWrite.attemptedAssetIds: kaifuu.patch_result.silent_partial_write`,
        );
      }
    }
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
  assertOptionalRfc3339Instant(metadata.createdAt, "DeltaPackageMetadataV02.createdAt");
}

export function assertFindingRecordFixtureV02(
  value: unknown,
): asserts value is FindingRecordFixtureV02 {
  assertNoConfidenceFields(value, "FindingRecordFixtureV02");
  const fixture = asRecord(value, "FindingRecordFixtureV02");
  assertEqual(
    fixture.schemaVersion,
    BRIDGE_SCHEMA_VERSION_V02,
    "FindingRecordFixtureV02.schemaVersion",
  );
  assertUuid7(fixture.findingFixtureId, "FindingRecordFixtureV02.findingFixtureId");
  assertOptionalUuid7(fixture.sourceTriageBundleId, "FindingRecordFixtureV02.sourceTriageBundleId");
  assertFindingRecordV02(fixture.finding, "FindingRecordFixtureV02.finding");
  assertFindingRecordEvidenceReferencesOwnProvenanceV02(
    fixture.finding,
    "FindingRecordFixtureV02.finding",
  );
  assertStringArray(fixture.compatibilityNotes, "FindingRecordFixtureV02.compatibilityNotes");
}

export function assertPermissionLocalUserFixtureV02(
  value: unknown,
): asserts value is PermissionLocalUserFixtureV02 {
  const fixture = asRecord(value, "PermissionLocalUserFixtureV02");
  assertEqual(
    fixture.schemaVersion,
    BRIDGE_SCHEMA_VERSION_V02,
    "PermissionLocalUserFixtureV02.schemaVersion",
  );
  assertUuid7(fixture.permissionFixtureId, "PermissionLocalUserFixtureV02.permissionFixtureId");
  const user = asRecord(fixture.user, "PermissionLocalUserFixtureV02.user");
  assertEqual(user.userId, "local-user", "PermissionLocalUserFixtureV02.user.userId");
  assertEqual(user.displayName, "Local user", "PermissionLocalUserFixtureV02.user.displayName");
  const grants = assertEnumArrayV02(
    fixture.grants,
    ITOTORI_PERMISSION_VALUES_V02,
    "PermissionLocalUserFixtureV02.grants",
  );
  assertExactStringSetV02(
    grants,
    ITOTORI_PERMISSION_VALUES_V02,
    "PermissionLocalUserFixtureV02.grants",
  );
  assertStringArray(fixture.compatibilityNotes, "PermissionLocalUserFixtureV02.compatibilityNotes");
}

export function assertAlphaVerticalProofManifestV02(
  value: unknown,
): asserts value is AlphaVerticalProofManifestV02 {
  assertNoConfidenceFields(value, "AlphaVerticalProofManifestV02");
  assertNoRawPrivateOrSecretFieldsV02(value, "AlphaVerticalProofManifestV02");
  const manifest = asRecord(value, "AlphaVerticalProofManifestV02");
  assertAllowedKeysV02(
    manifest,
    [
      "schemaVersion",
      "proofManifestId",
      "createdAt",
      "fixture",
      "engineProfile",
      "sourceRevision",
      "sourceBridgeId",
      "sourceBundleHash",
      "bridgeUnitRefs",
      "runtimeTargetIds",
      "artifactRefs",
      "providerProofIds",
      "benchmarkOutputRefs",
      "contentHashes",
      "compatibilityNotes",
    ],
    "AlphaVerticalProofManifestV02",
  );
  assertEqual(
    manifest.schemaVersion,
    BRIDGE_SCHEMA_VERSION_V02,
    "AlphaVerticalProofManifestV02.schemaVersion",
  );
  assertUuid7(manifest.proofManifestId, "AlphaVerticalProofManifestV02.proofManifestId");
  assertRfc3339Instant(manifest.createdAt, "AlphaVerticalProofManifestV02.createdAt");
  assertAlphaVerticalProofFixtureRefV02(manifest.fixture, "AlphaVerticalProofManifestV02.fixture");
  assertAlphaVerticalProofEngineProfileV02(
    manifest.engineProfile,
    "AlphaVerticalProofManifestV02.engineProfile",
  );
  assertSourceRevisionV02(manifest.sourceRevision, "AlphaVerticalProofManifestV02.sourceRevision");
  assertUuid7(manifest.sourceBridgeId, "AlphaVerticalProofManifestV02.sourceBridgeId");
  assertHashStringV02(manifest.sourceBundleHash, "AlphaVerticalProofManifestV02.sourceBundleHash");
  assertRevisionHashMatchesV02(
    manifest.sourceRevision,
    manifest.sourceBundleHash,
    "AlphaVerticalProofManifestV02.sourceRevision",
  );

  const bridgeUnitRefs = asArray(
    manifest.bridgeUnitRefs,
    "AlphaVerticalProofManifestV02.bridgeUnitRefs",
  );
  if (bridgeUnitRefs.length === 0) {
    throw new Error("AlphaVerticalProofManifestV02.bridgeUnitRefs must contain at least one ref");
  }
  const bridgeUnitRefKeys = new Set<string>();
  const validatedBridgeUnitRefs: AlphaVerticalProofBridgeUnitRefV02[] = [];
  for (const [index, ref] of bridgeUnitRefs.entries()) {
    const label = `AlphaVerticalProofManifestV02.bridgeUnitRefs[${index}]`;
    assertAlphaVerticalProofBridgeUnitRefV02(ref, label);
    const refKey = `${ref.bridgeUnitId}\0${ref.sourceUnitKey}`;
    if (bridgeUnitRefKeys.has(refKey)) {
      throw new Error(`${label} must be unique by bridgeUnitId and sourceUnitKey`);
    }
    bridgeUnitRefKeys.add(refKey);
    validatedBridgeUnitRefs.push(ref);
  }

  assertUniqueNonEmptyStringArrayV02(
    manifest.runtimeTargetIds,
    "AlphaVerticalProofManifestV02.runtimeTargetIds",
  );
  assertAlphaVerticalProofArtifactRefsV02(
    manifest.artifactRefs,
    "AlphaVerticalProofManifestV02.artifactRefs",
  );
  const artifactRefs = manifest.artifactRefs;
  const providerProofIds = assertUniqueUuid7ArrayV02(
    manifest.providerProofIds,
    "AlphaVerticalProofManifestV02.providerProofIds",
  );
  if (providerProofIds.length === 0) {
    throw new Error("AlphaVerticalProofManifestV02.providerProofIds must contain at least one id");
  }

  const benchmarkOutputRefs = asArray(
    manifest.benchmarkOutputRefs,
    "AlphaVerticalProofManifestV02.benchmarkOutputRefs",
  );
  if (benchmarkOutputRefs.length === 0) {
    throw new Error(
      "AlphaVerticalProofManifestV02.benchmarkOutputRefs must contain at least one ref",
    );
  }
  const benchmarkRunIds = new Set<Uuid7>();
  for (const [index, ref] of benchmarkOutputRefs.entries()) {
    const label = `AlphaVerticalProofManifestV02.benchmarkOutputRefs[${index}]`;
    assertAlphaVerticalProofBenchmarkOutputRefV02(ref, label);
    if (benchmarkRunIds.has(ref.benchmarkRunId)) {
      throw new Error(`${label}.benchmarkRunId must be unique within benchmarkOutputRefs`);
    }
    benchmarkRunIds.add(ref.benchmarkRunId);
  }

  const contentHashes = assertAlphaVerticalProofContentHashesV02(
    manifest.contentHashes,
    "AlphaVerticalProofManifestV02.contentHashes",
  );
  assertAlphaVerticalProofRequiredHashScopesV02(contentHashes);
  if (manifest.fixture.publicManifestUri !== artifactRefs.publicFixtureManifest.uri) {
    throw new Error(
      "AlphaVerticalProofManifestV02.fixture.publicManifestUri must match AlphaVerticalProofManifestV02.artifactRefs.publicFixtureManifest.uri",
    );
  }
  if (manifest.fixture.publicManifestHash !== artifactRefs.publicFixtureManifest.hash) {
    throw new Error(
      "AlphaVerticalProofManifestV02.fixture.publicManifestHash must match AlphaVerticalProofManifestV02.artifactRefs.publicFixtureManifest.hash",
    );
  }
  assertAlphaVerticalProofHashCoveredV02(
    contentHashes,
    "source_bundle",
    `${manifest.fixture.fixtureId}:source-bundle`,
    manifest.sourceBundleHash,
    "AlphaVerticalProofManifestV02.sourceBundleHash",
  );
  for (const [index, ref] of validatedBridgeUnitRefs.entries()) {
    assertAlphaVerticalProofHashCoveredV02(
      contentHashes,
      "bridge_unit",
      ref.bridgeUnitId,
      ref.sourceHash,
      `AlphaVerticalProofManifestV02.bridgeUnitRefs[${index}].sourceHash`,
    );
  }
  for (const [index, providerProofId] of providerProofIds.entries()) {
    assertAlphaVerticalProofHashScopeContentIdV02(
      contentHashes,
      "provider_proof",
      providerProofId,
      `AlphaVerticalProofManifestV02.providerProofIds[${index}]`,
    );
  }
  for (const artifactRef of Object.values(artifactRefs)) {
    if (artifactRef === undefined) {
      continue;
    }
    assertAlphaVerticalProofHashCoveredV02(
      contentHashes,
      alphaVerticalProofHashScopeForArtifactKindV02(artifactRef.artifactKind),
      artifactRef.uri,
      artifactRef.hash,
      `AlphaVerticalProofManifestV02.artifactRefs.${artifactRef.artifactKind}.hash`,
    );
  }
  assertStringArray(
    manifest.compatibilityNotes,
    "AlphaVerticalProofManifestV02.compatibilityNotes",
  );
}

export function assertContractFixtureManifestV02(
  value: unknown,
): asserts value is ContractFixtureManifestV02 {
  const manifest = asRecord(value, "ContractFixtureManifestV02");
  assertEqual(
    manifest.schemaVersion,
    BRIDGE_SCHEMA_VERSION_V02,
    "ContractFixtureManifestV02.schemaVersion",
  );
  assertUuid7(manifest.suiteId, "ContractFixtureManifestV02.suiteId");
  assertRfc3339Instant(manifest.generatedAt, "ContractFixtureManifestV02.generatedAt");
  const validFixtures = asArray(manifest.validFixtures, "ContractFixtureManifestV02.validFixtures");
  const invalidFixtures = asArray(
    manifest.invalidFixtures,
    "ContractFixtureManifestV02.invalidFixtures",
  );
  const paths = new Set<string>();
  const validKinds = new Set<ContractFixtureKindV02>();
  for (const [index, fixture] of validFixtures.entries()) {
    const label = `ContractFixtureManifestV02.validFixtures[${index}]`;
    assertContractFixtureManifestEntryV02(fixture, label);
    validKinds.add(fixture.kind);
    assertUniqueFixturePathV02(fixture.path, label, paths);
  }
  for (const [index, fixture] of invalidFixtures.entries()) {
    const label = `ContractFixtureManifestV02.invalidFixtures[${index}]`;
    assertInvalidContractFixtureManifestEntryV02(fixture, label);
    assertString(fixture.expectedSemanticError, `${label}.expectedSemanticError`);
    assertUniqueFixturePathV02(fixture.path, label, paths);
  }
  assertExactStringSetV02(
    [...validKinds],
    CONTRACT_FIXTURE_KINDS_V02,
    "ContractFixtureManifestV02.validFixtures.kind",
  );
}

export function assertContractCompatibilityReportV02(
  value: unknown,
): asserts value is ContractCompatibilityReportV02 {
  const report = asRecord(value, "ContractCompatibilityReportV02");
  assertEqual(
    report.schemaVersion,
    BRIDGE_SCHEMA_VERSION_V02,
    "ContractCompatibilityReportV02.schemaVersion",
  );
  assertUuid7(report.reportId, "ContractCompatibilityReportV02.reportId");
  assertRfc3339Instant(report.generatedAt, "ContractCompatibilityReportV02.generatedAt");
  assertContractFixturePathV02(
    report.suiteManifestPath,
    "ContractCompatibilityReportV02.suiteManifestPath",
  );
  assertString(report.sourceOfTruth, "ContractCompatibilityReportV02.sourceOfTruth");
  assertCommandTokensV02(
    report.typescriptCommand,
    "ContractCompatibilityReportV02.typescriptCommand",
  );
  assertCommandTokensV02(report.rustCommand, "ContractCompatibilityReportV02.rustCommand");
  assertEnum(
    report.overallStatus,
    CONTRACT_COMPATIBILITY_STATUSES_V02,
    "ContractCompatibilityReportV02.overallStatus",
  );

  const coverage = asArray(report.coverage, "ContractCompatibilityReportV02.coverage");
  const coveredKinds = new Set<ContractFixtureKindV02>();
  for (const [index, entry] of coverage.entries()) {
    const label = `ContractCompatibilityReportV02.coverage[${index}]`;
    assertContractCompatibilityCoverageV02(entry, label);
    if (coveredKinds.has(entry.kind)) {
      throw new Error(
        `${label}.kind must be unique within ContractCompatibilityReportV02.coverage`,
      );
    }
    coveredKinds.add(entry.kind);
    if (report.overallStatus === "compatible" && entry.status !== "compatible") {
      throw new Error(`${label}.status must be compatible when overallStatus is compatible`);
    }
  }
  assertExactStringSetV02(
    [...coveredKinds],
    CONTRACT_FIXTURE_KINDS_V02,
    "ContractCompatibilityReportV02.coverage.kind",
  );

  const crossRefs = asArray(
    report.crossContractRefs,
    "ContractCompatibilityReportV02.crossContractRefs",
  );
  for (const [index, ref] of crossRefs.entries()) {
    const label = `ContractCompatibilityReportV02.crossContractRefs[${index}]`;
    const crossRef = asRecord(ref, label);
    assertString(crossRef.from, `${label}.from`);
    assertString(crossRef.to, `${label}.to`);
    assertString(crossRef.rule, `${label}.rule`);
  }
  if (
    !crossRefs.some(
      (ref) => asRecord(ref, "crossContractRef").from === "./permission-local-user-v0.2.json",
    )
  ) {
    throw new Error(
      "ContractCompatibilityReportV02.crossContractRefs must document permission-local-user-v0.2.json",
    );
  }
  assertStringArray(report.notes, "ContractCompatibilityReportV02.notes");
}

/**
 * KAIFUU-053: validate a per-rung {@link CapabilityLevelStatusV02}.
 *
 * Enforces the same shape the Postgres CHECK constraint guards in
 * migration `0028_engine_capability_reports.sql`:
 *
 * - `supported`: no `limitations`, no `reason`.
 * - `partial`: `limitations` non-empty string array; no `reason`.
 * - `unsupported`: `reason` non-empty string; no `limitations`.
 */
export function assertCapabilityLevelStatusV02(
  value: unknown,
  label: string,
): asserts value is CapabilityLevelStatusV02 {
  const record = asRecord(value, label);
  assertEnum(record.kind, CAPABILITY_LEVEL_STATUS_KINDS_V02, `${label}.kind`);
  switch (record.kind) {
    case "supported":
      if ("limitations" in record) {
        throw new Error(`${label}.limitations must not be present when kind is supported`);
      }
      if ("reason" in record) {
        throw new Error(`${label}.reason must not be present when kind is supported`);
      }
      return;
    case "partial": {
      assertStringArray(record.limitations, `${label}.limitations`);
      const limitations = record.limitations as string[];
      if (limitations.length === 0) {
        throw new Error(
          `${label}.limitations must contain at least one entry when kind is partial`,
        );
      }
      if ("reason" in record) {
        throw new Error(`${label}.reason must not be present when kind is partial`);
      }
      return;
    }
    case "unsupported": {
      assertString(record.reason, `${label}.reason`);
      if ((record.reason as string).trim().length === 0) {
        throw new Error(`${label}.reason must not be empty when kind is unsupported`);
      }
      if ("limitations" in record) {
        throw new Error(`${label}.limitations must not be present when kind is unsupported`);
      }
      return;
    }
  }
}

/**
 * KAIFUU-053: validate an {@link AdapterCapabilityMatrixV02} fixture.
 */
export function assertAdapterCapabilityMatrixV02(
  value: unknown,
): asserts value is AdapterCapabilityMatrixV02 {
  const record = asRecord(value, "AdapterCapabilityMatrixV02");
  assertString(record.adapterId, "AdapterCapabilityMatrixV02.adapterId");
  for (const level of CAPABILITY_LEVELS_V02) {
    assertCapabilityLevelStatusV02(record[level], `AdapterCapabilityMatrixV02.${level}`);
  }
}

export function assertContractFixtureV02(kind: string, value: unknown): void {
  assertEnum(kind, CONTRACT_FIXTURE_KINDS_V02, "ContractFixtureV02.kind");
  switch (kind) {
    case "alpha-vertical-proof-manifest-v0.2":
      assertAlphaVerticalProofManifestV02(value);
      return;
    case "asset-policy-v0.2":
      assertAssetPolicyBundleV02(value);
      return;
    case "benchmark-report-v0.2":
      assertBenchmarkReportV02(value);
      return;
    case "bridge-v0.2":
      assertBridgeBundleV02(value);
      return;
    case "contract-compatibility-v0.2":
      assertContractCompatibilityReportV02(value);
      return;
    case "contract-fixtures-v0.2":
      assertContractFixtureManifestV02(value);
      return;
    case "delta-package-v0.2":
      assertDeltaPackageMetadataV02(value);
      return;
    case "finding-v0.2":
      assertFindingRecordFixtureV02(value);
      return;
    case "patch-export-v0.2":
      assertPatchExportV02(value);
      return;
    case "patch-result-v0.2":
      assertPatchResultV02(value);
      return;
    case "permission-local-user-v0.2":
      assertPermissionLocalUserFixtureV02(value);
      return;
    case "runtime-evidence-v0.2":
      assertRuntimeEvidenceReportV02(value);
      return;
    case "triage-v0.2":
      assertTriageBundleV02(value);
      return;
  }
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

    if (currentUnit.bridgeUnitId !== entry.bridgeUnitId) {
      incompatibleUnits.push({
        ...base,
        status: "incompatible",
        actualBridgeUnitId: currentUnit.bridgeUnitId,
        actualSourceHash: currentUnit.sourceHash,
        reason: "bridge_unit_id_mismatch",
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

    if (!patchEntrySpanMappingsCompatible(entry, currentUnit)) {
      incompatibleUnits.push({
        ...base,
        status: "incompatible",
        actualSourceHash: currentUnit.sourceHash,
        reason: "protected_span_mapping_mismatch",
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

function patchEntrySpanMappingsCompatible(
  entry: PatchExportEntryV02,
  unit: LocalizationUnitV02,
): boolean {
  const requiredCounts = new Map<string, number>();
  for (const span of unit.spans) {
    requiredCounts.set(span.raw, (requiredCounts.get(span.raw) ?? 0) + 1);
  }

  const targetRangesByRaw = new Map<string, Set<string>>();
  const explicitSourceKeys = new Set<string>();
  for (const mapping of entry.protectedSpanMappings) {
    if (
      !targetByteRangeMatchesRaw(
        entry.targetText,
        mapping.raw,
        mapping.targetStart,
        mapping.targetEnd,
      )
    ) {
      return false;
    }

    const hasSourceIdentity =
      mapping.sourceSpanId !== undefined ||
      mapping.sourceStartByte !== undefined ||
      mapping.sourceEndByte !== undefined;
    if ((requiredCounts.get(mapping.raw) ?? 0) > 1 && !hasSourceIdentity) {
      return false;
    }
    if (hasSourceIdentity) {
      const sourceSpan = unit.spans.find(
        (span) =>
          span.raw === mapping.raw &&
          (mapping.sourceSpanId === undefined || span.spanId === mapping.sourceSpanId) &&
          (mapping.sourceStartByte === undefined || span.startByte === mapping.sourceStartByte) &&
          (mapping.sourceEndByte === undefined || span.endByte === mapping.sourceEndByte),
      );
      if (sourceSpan === undefined) {
        return false;
      }
      const sourceKey = `${sourceSpan.spanId}:${sourceSpan.startByte}:${sourceSpan.endByte}`;
      if (explicitSourceKeys.has(sourceKey)) {
        return false;
      }
      explicitSourceKeys.add(sourceKey);
    }

    if (requiredCounts.has(mapping.raw)) {
      const ranges = targetRangesByRaw.get(mapping.raw) ?? new Set<string>();
      ranges.add(`${mapping.targetStart}:${mapping.targetEnd}`);
      targetRangesByRaw.set(mapping.raw, ranges);
    }
  }

  for (const [raw, requiredCount] of requiredCounts) {
    if ((targetRangesByRaw.get(raw)?.size ?? 0) < requiredCount) {
      return false;
    }
  }
  return true;
}

function targetByteRangeMatchesRaw(
  targetText: string,
  raw: string,
  targetStart: number,
  targetEnd: number,
): boolean {
  const targetBytes = Buffer.from(targetText, "utf8");
  if (targetEnd > targetBytes.length) {
    return false;
  }
  return targetBytes.subarray(targetStart, targetEnd).toString("utf8") === raw;
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
  const reportStatus = report.status;
  assertEnum(reportStatus, ["passed", "failed"] as const, "RuntimeEvidenceReportV02.status");
  if (report.runtimeCapabilities !== undefined) {
    assertRuntimeCapabilityContractV02(
      report.runtimeCapabilities,
      "RuntimeEvidenceReportV02.runtimeCapabilities",
      report.fidelityTier,
      report.evidenceTier,
    );
  }
  if (report.controlledPlaybackSession !== undefined) {
    assertControlledPlaybackSessionV02(
      report.controlledPlaybackSession,
      "RuntimeEvidenceReportV02.controlledPlaybackSession",
      report,
      reportStatus,
    );
  }
  assertRfc3339Instant(report.createdAt, "RuntimeEvidenceReportV02.createdAt");

  const traceEvents = asArray(report.traceEvents, "RuntimeEvidenceReportV02.traceEvents");
  for (const [index, event] of traceEvents.entries()) {
    assertRuntimeTraceEventV02(event, `RuntimeEvidenceReportV02.traceEvents[${index}]`);
  }

  const branchEvents = asArray(report.branchEvents, "RuntimeEvidenceReportV02.branchEvents");
  for (const [index, event] of branchEvents.entries()) {
    assertRuntimeBranchPointEventV02(event, `RuntimeEvidenceReportV02.branchEvents[${index}]`);
  }

  const observationHookEvents =
    report.observationHookEvents === undefined
      ? []
      : asArray(report.observationHookEvents, "RuntimeEvidenceReportV02.observationHookEvents");
  for (const [index, event] of observationHookEvents.entries()) {
    const label = `RuntimeEvidenceReportV02.observationHookEvents[${index}]`;
    assertObservationHookEvent(event, label);
    assertMaximumRuntimeEvidenceTierV02(
      (event as ObservationHookEvent).evidenceTier,
      report.evidenceTier,
      `${label}.evidenceTier`,
    );
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
  if (report.controlledPlaybackSession !== undefined) {
    assertControlledPlaybackSessionEvidenceSurfaceV02(
      (report.controlledPlaybackSession as ControlledPlaybackSessionV02).requestedOperation,
      {
        branchEvents,
        captures,
        recordings,
        referenceComparisons,
      },
      "RuntimeEvidenceReportV02.controlledPlaybackSession.requestedOperation",
    );
  }
  if (
    traceEvents.length === 0 &&
    observationHookEvents.length === 0 &&
    captures.length === 0 &&
    recordings.length === 0
  ) {
    throw new Error(
      "RuntimeEvidenceReportV02 must contain trace, observation hook, capture, or recording evidence",
    );
  }
  if (captures.length > 0) {
    assertMinimumRuntimeEvidenceTierV02(
      report.evidenceTier,
      "E2",
      "RuntimeEvidenceReportV02.evidenceTier",
    );
    if (report.runtimeCapabilities !== undefined) {
      assertRuntimeCapabilitySupportsFeatureV02(
        report.runtimeCapabilities as RuntimeCapabilityContractV02,
        "frame_capture",
        "RuntimeEvidenceReportV02.runtimeCapabilities",
      );
    }
  }
  if (recordings.length > 0) {
    assertMinimumRuntimeEvidenceTierV02(
      report.evidenceTier,
      "E3",
      "RuntimeEvidenceReportV02.evidenceTier",
    );
    if (report.runtimeCapabilities !== undefined) {
      assertRuntimeCapabilitySupportsFeatureV02(
        report.runtimeCapabilities as RuntimeCapabilityContractV02,
        "recording",
        "RuntimeEvidenceReportV02.runtimeCapabilities",
      );
    }
  }
  if (traceEvents.length > 0 && report.runtimeCapabilities !== undefined) {
    assertRuntimeCapabilitySupportsFeatureV02(
      report.runtimeCapabilities as RuntimeCapabilityContractV02,
      "text_trace",
      "RuntimeEvidenceReportV02.runtimeCapabilities",
    );
  }
  if (branchEvents.length > 0 && report.runtimeCapabilities !== undefined) {
    assertRuntimeCapabilitySupportsFeatureV02(
      report.runtimeCapabilities as RuntimeCapabilityContractV02,
      "branch_discovery",
      "RuntimeEvidenceReportV02.runtimeCapabilities",
    );
  }
  if (observationHookEvents.length > 0 && report.runtimeCapabilities !== undefined) {
    assertRuntimeCapabilitySupportsFeatureV02(
      report.runtimeCapabilities as RuntimeCapabilityContractV02,
      "instrumentation_hooks",
      "RuntimeEvidenceReportV02.runtimeCapabilities",
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
  if (referenceComparisons.length > 0 && report.runtimeCapabilities !== undefined) {
    assertRuntimeCapabilitySupportsFeatureV02(
      report.runtimeCapabilities as RuntimeCapabilityContractV02,
      "reference_comparison",
      "RuntimeEvidenceReportV02.runtimeCapabilities",
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
  assertPortableRuntimeArtifactUriV02(ref.uri, `${label}.uri`);
  assertOptionalHashStringV02(ref.hash, `${label}.hash`);
  assertOptionalString(ref.mediaType, `${label}.mediaType`);
  if (ref.byteSize !== undefined) {
    assertPositiveInteger(ref.byteSize, `${label}.byteSize`);
  }
}

function assertObservationHookEvent(
  value: unknown,
  label: string,
): asserts value is ObservationHookEvent {
  const event = asRecord(value, label);
  assertEqual(event.schemaVersion, OBSERVATION_HOOK_SCHEMA_VERSION, `${label}.schemaVersion`);
  assertString(event.eventId, `${label}.eventId`);
  assertRfc3339Instant(event.observedAt, `${label}.observedAt`);
  assertEnum(event.eventKind, OBSERVATION_HOOK_EVENT_KINDS, `${label}.eventKind`);
  assertString(event.runtimeTargetId, `${label}.runtimeTargetId`);
  assertObservationAdapterId(event.adapterId, `${label}.adapterId`);
  assertEnum(event.evidenceTier, RUNTIME_EVIDENCE_TIERS_V02, `${label}.evidenceTier`);
  assertObservationEnvironment(event.environment, `${label}.environment`);
  if (event.sourceRevision !== undefined) {
    assertObservationSourceRevision(event.sourceRevision, `${label}.sourceRevision`);
  }
  if (event.bridgeRefs !== undefined) {
    const bridgeRefs = asArray(event.bridgeRefs, `${label}.bridgeRefs`);
    for (const [index, bridgeRef] of bridgeRefs.entries()) {
      assertObservationBridgeRef(bridgeRef, `${label}.bridgeRefs[${index}]`);
    }
  }
  assertObservationRedactionMetadata(event.redaction, `${label}.redaction`);
  const payloadKind = assertObservationHookPayload(event.payload, `${label}.payload`);
  if (event.eventKind !== payloadKind) {
    throw new Error(`${label}.eventKind must match ${label}.payload.payloadKind`);
  }
}

function assertObservationAdapterId(
  value: unknown,
  label: string,
): asserts value is ObservationAdapterId {
  const adapterId = asRecord(value, label);
  assertString(adapterId.name, `${label}.name`);
  assertString(adapterId.version, `${label}.version`);
}

function assertObservationEnvironment(
  value: unknown,
  label: string,
): asserts value is ObservationEnvironment {
  const environment = asRecord(value, label);
  assertString(environment.runtime, `${label}.runtime`);
  assertOptionalString(environment.engine, `${label}.engine`);
  assertOptionalString(environment.platform, `${label}.platform`);
  assertOptionalString(environment.display, `${label}.display`);
  assertOptionalString(environment.locale, `${label}.locale`);
}

function assertObservationSourceRevision(
  value: unknown,
  label: string,
): asserts value is ObservationSourceRevision {
  const sourceRevision = asRecord(value, label);
  assertString(sourceRevision.sourceId, `${label}.sourceId`);
  assertOptionalString(sourceRevision.revisionId, `${label}.revisionId`);
  assertOptionalString(sourceRevision.contentHash, `${label}.contentHash`);
}

function assertObservationBridgeRef(
  value: unknown,
  label: string,
): asserts value is ObservationBridgeRef {
  const bridgeRef = asRecord(value, label);
  assertOptionalString(bridgeRef.bridgeUnitId, `${label}.bridgeUnitId`);
  assertOptionalString(bridgeRef.sourceUnitKey, `${label}.sourceUnitKey`);
  assertOptionalString(bridgeRef.runtimeObjectId, `${label}.runtimeObjectId`);
  if (
    isBlankString(bridgeRef.bridgeUnitId) &&
    isBlankString(bridgeRef.sourceUnitKey) &&
    isBlankString(bridgeRef.runtimeObjectId)
  ) {
    throw new Error(`${label} must identify a bridge unit, source unit, or runtime object`);
  }
}

function assertObservationRedactionMetadata(
  value: unknown,
  label: string,
): asserts value is ObservationRedactionMetadata {
  const redaction = asRecord(value, label);
  assertEnum(redaction.status, OBSERVATION_REDACTION_STATUSES, `${label}.status`);
  const rules = redaction.rules === undefined ? [] : asArray(redaction.rules, `${label}.rules`);
  const redactedFields =
    redaction.redactedFields === undefined
      ? []
      : asArray(redaction.redactedFields, `${label}.redactedFields`);
  for (const [index, rule] of rules.entries()) {
    assertNonBlankString(rule, `${label}.rules[${index}]`);
  }
  for (const [index, field] of redactedFields.entries()) {
    assertNonBlankString(field, `${label}.redactedFields[${index}]`);
  }
  if (redaction.status === "not_required" && (rules.length > 0 || redactedFields.length > 0)) {
    throw new Error(`${label} with status not_required must not declare redaction rules or fields`);
  }
  if (redaction.status === "redacted" && (rules.length === 0 || redactedFields.length === 0)) {
    throw new Error(`${label} with status redacted must declare rules and redactedFields`);
  }
}

function assertObservationHookPayload(value: unknown, label: string): ObservationHookEventKind {
  const payload = asRecord(value, label);
  assertEnum(payload.payloadKind, OBSERVATION_HOOK_EVENT_KINDS, `${label}.payloadKind`);
  switch (payload.payloadKind) {
    case "text":
      assertString(payload.text, `${label}.text`);
      assertOptionalString(payload.speaker, `${label}.speaker`);
      assertOptionalString(payload.textSurface, `${label}.textSurface`);
      return "text";
    case "choice": {
      assertOptionalString(payload.prompt, `${label}.prompt`);
      const options = asArray(payload.options, `${label}.options`);
      if (options.length === 0) {
        throw new Error(`${label}.options must include at least one option`);
      }
      for (const [index, option] of options.entries()) {
        assertObservationChoiceOption(option, `${label}.options[${index}]`);
      }
      return "choice";
    }
    case "branch":
      assertString(payload.branchId, `${label}.branchId`);
      assertOptionalString(payload.label, `${label}.label`);
      assertOptionalString(payload.destination, `${label}.destination`);
      if (payload.taken !== undefined) {
        assertBoolean(payload.taken, `${label}.taken`);
      }
      return "branch";
    case "scene":
      assertString(payload.sceneId, `${label}.sceneId`);
      assertOptionalString(payload.sceneName, `${label}.sceneName`);
      return "scene";
    case "frame":
      assertNonNegativeInteger(payload.frame, `${label}.frame`);
      if (payload.width !== undefined) {
        assertPositiveInteger(payload.width, `${label}.width`);
      }
      if (payload.height !== undefined) {
        assertPositiveInteger(payload.height, `${label}.height`);
      }
      if (payload.artifactRef !== undefined) {
        assertObservationArtifactRef(payload.artifactRef, `${label}.artifactRef`);
      }
      return "frame";
    case "error":
      assertString(payload.errorType, `${label}.errorType`);
      assertString(payload.message, `${label}.message`);
      assertBoolean(payload.fatal, `${label}.fatal`);
      assertOptionalString(payload.stack, `${label}.stack`);
      return "error";
  }
}

function assertObservationChoiceOption(
  value: unknown,
  label: string,
): asserts value is ObservationChoiceOption {
  const option = asRecord(value, label);
  assertString(option.optionId, `${label}.optionId`);
  assertString(option.label, `${label}.label`);
  if (option.bridgeRef !== undefined) {
    assertObservationBridgeRef(option.bridgeRef, `${label}.bridgeRef`);
  }
}

function assertObservationArtifactRef(
  value: unknown,
  label: string,
): asserts value is ObservationArtifactRef {
  const artifactRef = asRecord(value, label);
  assertString(artifactRef.artifactId, `${label}.artifactId`);
  assertString(artifactRef.artifactKind, `${label}.artifactKind`);
  assertPortableArtifactUriV02(artifactRef.uri, `${label}.uri`);
  assertOptionalString(artifactRef.mediaType, `${label}.mediaType`);
}

function assertRuntimeCapabilityContractV02(
  value: unknown,
  label: string,
  reportFidelityTier: RuntimeFidelityTierV02,
  reportEvidenceTier: RuntimeEvidenceTierV02,
): asserts value is RuntimeCapabilityContractV02 {
  const contract = asRecord(value, label);
  assertEqual(contract.contractVersion, BRIDGE_SCHEMA_VERSION_V02, `${label}.contractVersion`);
  assertEnum(contract.capabilityClass, RUNTIME_CAPABILITY_CLASSES_V02, `${label}.capabilityClass`);
  assertEnum(
    contract.fidelityTierCeiling,
    RUNTIME_FIDELITY_TIERS_V02,
    `${label}.fidelityTierCeiling`,
  );
  assertEnum(
    contract.evidenceTierCeiling,
    RUNTIME_EVIDENCE_TIERS_V02,
    `${label}.evidenceTierCeiling`,
  );
  assertRuntimeCapabilityClassCeilingV02(
    contract.capabilityClass,
    contract.fidelityTierCeiling,
    contract.evidenceTierCeiling,
    label,
  );
  assertRuntimeEvidenceTierWithinFidelityV02(
    contract.evidenceTierCeiling,
    contract.fidelityTierCeiling,
    label,
  );
  assertMaximumRuntimeFidelityTierV02(
    reportFidelityTier,
    contract.fidelityTierCeiling,
    "RuntimeEvidenceReportV02.fidelityTier",
  );
  assertMaximumRuntimeEvidenceTierV02(
    reportEvidenceTier,
    contract.evidenceTierCeiling,
    "RuntimeEvidenceReportV02.evidenceTier",
  );

  const features = asArray(contract.features, `${label}.features`);
  if (features.length === 0) {
    throw new Error(`${label}.features must include at least one runtime feature declaration`);
  }
  const seenFeatures = new Set<string>();
  for (const [index, feature] of features.entries()) {
    const featureLabel = `${label}.features[${index}]`;
    const featureRecord = assertRuntimeFeatureSupportV02(feature, featureLabel);
    if (seenFeatures.has(featureRecord.feature)) {
      throw new Error(`${featureLabel}.feature must be unique within runtime capability contract`);
    }
    seenFeatures.add(featureRecord.feature);
    if (
      featureRecord.evidenceTierCeiling !== undefined &&
      runtimeEvidenceTierRankV02(featureRecord.evidenceTierCeiling) >
        runtimeEvidenceTierRankV02(contract.evidenceTierCeiling)
    ) {
      throw new Error(
        `${featureLabel}.evidenceTierCeiling must not exceed contract evidenceTierCeiling`,
      );
    }
  }
  assertStringArray(contract.limitations, `${label}.limitations`);
}

function assertRuntimeFeatureSupportV02(value: unknown, label: string): RuntimeFeatureSupportV02 {
  const feature = asRecord(value, label);
  assertEnum(feature.feature, RUNTIME_PLAYBACK_FEATURES_V02, `${label}.feature`);
  assertEnum(feature.status, RUNTIME_FEATURE_STATUSES_V02, `${label}.status`);
  if (feature.evidenceTierCeiling !== undefined) {
    assertEnum(
      feature.evidenceTierCeiling,
      RUNTIME_EVIDENCE_TIERS_V02,
      `${label}.evidenceTierCeiling`,
    );
  }
  if (feature.status === "unsupported" && feature.evidenceTierCeiling !== undefined) {
    throw new Error(
      `${label}.evidenceTierCeiling must be omitted for unsupported runtime features`,
    );
  }
  if (feature.status !== "unsupported" && feature.evidenceTierCeiling === undefined) {
    throw new Error(`${label}.evidenceTierCeiling is required for supported runtime features`);
  }
  assertString(feature.description, `${label}.description`);
  assertStringArray(feature.limitations, `${label}.limitations`);
  return feature as RuntimeFeatureSupportV02;
}

function assertControlledPlaybackSessionV02(
  value: unknown,
  label: string,
  report: Record<string, unknown>,
  reportStatus: "passed" | "failed",
): asserts value is ControlledPlaybackSessionV02 {
  const session = asRecord(value, label);
  assertUuid7(session.sessionId, `${label}.sessionId`);
  assertString(session.adapterName, `${label}.adapterName`);
  assertString(session.adapterVersion, `${label}.adapterVersion`);
  if (session.adapterName !== report.adapterName) {
    throw new Error(`${label}.adapterName must match RuntimeEvidenceReportV02.adapterName`);
  }
  if (session.adapterVersion !== report.adapterVersion) {
    throw new Error(`${label}.adapterVersion must match RuntimeEvidenceReportV02.adapterVersion`);
  }
  assertEnum(session.capabilityClass, RUNTIME_CAPABILITY_CLASSES_V02, `${label}.capabilityClass`);
  assertEnum(
    session.requestedOperation,
    RUNTIME_REQUESTED_OPERATIONS_V02,
    `${label}.requestedOperation`,
  );
  assertEnum(session.status, ["passed", "failed"] as const, `${label}.status`);
  if (session.status !== reportStatus) {
    throw new Error(`${label}.status must match RuntimeEvidenceReportV02.status`);
  }
  assertEnum(session.fidelityTier, RUNTIME_FIDELITY_TIERS_V02, `${label}.fidelityTier`);
  assertEnum(session.evidenceTier, RUNTIME_EVIDENCE_TIERS_V02, `${label}.evidenceTier`);
  assertRuntimeEvidenceTierWithinFidelityV02(session.evidenceTier, session.fidelityTier, label);
  assertMaximumRuntimeFidelityTierV02(
    session.fidelityTier,
    report.fidelityTier as RuntimeFidelityTierV02,
    `${label}.fidelityTier`,
  );
  assertMaximumRuntimeEvidenceTierV02(
    session.evidenceTier,
    report.evidenceTier as RuntimeEvidenceTierV02,
    `${label}.evidenceTier`,
  );
  const featuresUsed = asArray(session.featuresUsed, `${label}.featuresUsed`);
  for (const [index, feature] of featuresUsed.entries()) {
    assertEnum(feature, RUNTIME_PLAYBACK_FEATURES_V02, `${label}.featuresUsed[${index}]`);
    if (report.runtimeCapabilities !== undefined) {
      assertRuntimeCapabilitySupportsFeatureV02(
        report.runtimeCapabilities as RuntimeCapabilityContractV02,
        feature as RuntimePlaybackFeatureV02,
        "RuntimeEvidenceReportV02.runtimeCapabilities",
      );
    }
  }
  if (
    report.runtimeCapabilities !== undefined &&
    session.capabilityClass !==
      (report.runtimeCapabilities as RuntimeCapabilityContractV02).capabilityClass
  ) {
    throw new Error(`${label}.capabilityClass must match runtimeCapabilities.capabilityClass`);
  }
  assertStringArray(session.limitations, `${label}.limitations`);
}

type RuntimeControlledPlaybackEvidenceSurfaceV02 =
  | "branchEvents"
  | "captures"
  | "recordings"
  | "referenceComparisons";

function assertControlledPlaybackSessionEvidenceSurfaceV02(
  requestedOperation: RuntimeRequestedOperationV02,
  evidence: Record<RuntimeControlledPlaybackEvidenceSurfaceV02, readonly unknown[]>,
  label: string,
): void {
  const forbiddenEvidenceByOperation: Record<
    RuntimeRequestedOperationV02,
    readonly RuntimeControlledPlaybackEvidenceSurfaceV02[]
  > = {
    trace: ["branchEvents", "captures", "recordings", "referenceComparisons"],
    branch_discovery: ["captures", "recordings", "referenceComparisons"],
    capture: ["branchEvents", "recordings", "referenceComparisons"],
    smoke_validation: [],
  };
  const evidenceLabelBySurface: Record<RuntimeControlledPlaybackEvidenceSurfaceV02, string> = {
    branchEvents: "branch event",
    captures: "capture",
    recordings: "recording",
    referenceComparisons: "reference comparison",
  };

  for (const surface of forbiddenEvidenceByOperation[requestedOperation]) {
    if (evidence[surface].length > 0) {
      throw new Error(
        `${label} ${requestedOperation} must not carry ${evidenceLabelBySurface[surface]} evidence`,
      );
    }
  }
}

function assertRuntimeCapabilitySupportsFeatureV02(
  contract: RuntimeCapabilityContractV02,
  feature: RuntimePlaybackFeatureV02,
  label: string,
): void {
  const declaration = contract.features.find((entry) => entry.feature === feature);
  if (declaration === undefined || declaration.status === "unsupported") {
    throw new Error(`${label} must advertise supported or partial ${feature} capability`);
  }
}

function assertRuntimeCapabilityClassCeilingV02(
  capabilityClass: RuntimeCapabilityClassV02,
  fidelityTierCeiling: RuntimeFidelityTierV02,
  evidenceTierCeiling: RuntimeEvidenceTierV02,
  label: string,
): void {
  const fidelityCeilingByClass: Record<RuntimeCapabilityClassV02, RuntimeFidelityTierV02> = {
    static_trace: "trace_only",
    launch_capture: "layout_probe",
    instrumented_runtime: "replay_review",
    partial_vm: "replay_review",
    reference_vm: "reference_fidelity",
  };
  const evidenceCeilingByClass: Record<RuntimeCapabilityClassV02, RuntimeEvidenceTierV02> = {
    static_trace: "E1",
    launch_capture: "E2",
    instrumented_runtime: "E3",
    partial_vm: "E3",
    reference_vm: "E4",
  };
  assertMaximumRuntimeFidelityTierV02(
    fidelityTierCeiling,
    fidelityCeilingByClass[capabilityClass],
    `${label}.fidelityTierCeiling`,
  );
  assertMaximumRuntimeEvidenceTierV02(
    evidenceTierCeiling,
    evidenceCeilingByClass[capabilityClass],
    `${label}.evidenceTierCeiling`,
  );
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

function assertMaximumRuntimeFidelityTierV02(
  actual: RuntimeFidelityTierV02,
  maximum: RuntimeFidelityTierV02,
  label: string,
): void {
  if (runtimeFidelityTierRankV02(actual) > runtimeFidelityTierRankV02(maximum)) {
    throw new Error(`${label} must not exceed ${maximum} for the declared runtime capability`);
  }
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

function runtimeFidelityTierRankV02(tier: RuntimeFidelityTierV02): number {
  return RUNTIME_FIDELITY_TIERS_V02.indexOf(tier);
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

function assertPortableRuntimeArtifactUriV02(
  value: unknown,
  label: string,
): asserts value is string {
  assertPortableArtifactUriV02(value, label);
  const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
  const hasDotSegment = value.split("/").some((segment) => segment === "." || segment === "..");
  if (hasScheme || hasDotSegment) {
    throw new Error(`${label} must be a portable relative runtime artifact path`);
  }
}

function assertPortablePublicArtifactUriV02(
  value: unknown,
  label: string,
): asserts value is string {
  assertPortableArtifactUriV02(value, label);
  if ((value as string).includes("fixtures/private-local/")) {
    throw new Error(`${label} must not reference fixtures/private-local`);
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

function assertLocaleBranchScopeV02(
  value: unknown,
  label: string,
): asserts value is LocaleBranchScopeV02 {
  const scope = asRecord(value, label);
  assertUuid7(scope.localeBranchId, `${label}.localeBranchId`);
  assertString(scope.targetLocale, `${label}.targetLocale`);
  assertOptionalString(scope.localeBranchKey, `${label}.localeBranchKey`);
}

function assertAssetPolicyDecisionV02(
  value: unknown,
  label: string,
): asserts value is AssetPolicyDecisionV02 {
  const decision = asRecord(value, label);
  assertUuid7(decision.assetPolicyDecisionId, `${label}.assetPolicyDecisionId`);
  assertEnum(decision.assetSurfaceKind, ASSET_POLICY_SURFACE_KINDS, `${label}.assetSurfaceKind`);
  assertAssetRefV02(decision.sourceAssetRef, `${label}.sourceAssetRef`);
  if (decision.sourceLocation !== undefined) {
    assertSourceLocationV02(decision.sourceLocation, `${label}.sourceLocation`);
  }
  assertOptionalString(decision.sourceText, `${label}.sourceText`);
  assertHashStringV02(decision.sourceHash, `${label}.sourceHash`);
  assertSourceRevisionV02(decision.sourceRevision, `${label}.sourceRevision`);
  assertEnum(decision.policyAction, POLICY_ACTIONS, `${label}.policyAction`);
  assertOptionalString(decision.targetText, `${label}.targetText`);
  assertOptionalString(decision.romanizationSystem, `${label}.romanizationSystem`);
  assertOptionalString(decision.preserveForm, `${label}.preserveForm`);
  assertString(decision.policyReason, `${label}.policyReason`);
  assertEnum(decision.textSourceKind, ASSET_POLICY_TEXT_SOURCE_KINDS, `${label}.textSourceKind`);
  assertEnum(decision.patchMode, ASSET_POLICY_PATCH_MODES, `${label}.patchMode`);
  if (decision.patchRef !== undefined) {
    assertAssetPolicyPatchRefV02(decision.patchRef, `${label}.patchRef`);
  }
  assertRuntimeExpectationV02(decision.runtimeExpectation, `${label}.runtimeExpectation`);
  if (decision.reviewRequired !== undefined) {
    assertBoolean(decision.reviewRequired, `${label}.reviewRequired`);
  }
  if (decision.linkedBridgeUnitRefs !== undefined) {
    const refs = asArray(decision.linkedBridgeUnitRefs, `${label}.linkedBridgeUnitRefs`);
    for (const [index, ref] of refs.entries()) {
      assertRuntimeBridgeUnitRefV02(ref, `${label}.linkedBridgeUnitRefs[${index}]`);
    }
  }
  if (decision.notes !== undefined) {
    assertStringArray(decision.notes, `${label}.notes`);
  }

  const validatedDecision = decision as AssetPolicyDecisionV02;
  assertAssetPolicyActionFieldsV02(validatedDecision, label);
  assertAssetPolicyTextSourceV02(validatedDecision, label);
  assertAssetPolicyPatchModeV02(validatedDecision, label);
}

function assertAssetPolicyPatchRefV02(
  value: unknown,
  label: string,
): asserts value is AssetPolicyPatchRefV02 {
  const patchRef = asRecord(value, label);
  assertUuid7(patchRef.assetId, `${label}.assetId`);
  assertEnum(patchRef.writeMode, PATCH_WRITE_MODES, `${label}.writeMode`);
  assertOptionalString(patchRef.sourceUnitKey, `${label}.sourceUnitKey`);
  assertSourceRevisionV02(patchRef.sourceRevision, `${label}.sourceRevision`);
  if (patchRef.constraints !== undefined) {
    assertStringArray(patchRef.constraints, `${label}.constraints`);
  }
}

function assertAssetPolicyActionFieldsV02(decision: AssetPolicyDecisionV02, label: string): void {
  const hasTextSource = decision.textSourceKind !== "not_applicable";
  if (
    (decision.policyAction === "localize" || decision.policyAction === "romanize") &&
    hasTextSource &&
    decision.targetText === undefined
  ) {
    throw new Error(`${label}.targetText is required for localized or romanized asset text`);
  }
  if (decision.policyAction === "romanize" && decision.romanizationSystem === undefined) {
    throw new Error(`${label}.romanizationSystem is required for romanize asset policies`);
  }
  if (
    decision.policyAction === "do_not_translate" &&
    hasTextSource &&
    decision.preserveForm === undefined &&
    decision.sourceText === undefined
  ) {
    throw new Error(`${label}.preserveForm or sourceText is required for do_not_translate`);
  }
}

function assertAssetPolicyTextSourceV02(decision: AssetPolicyDecisionV02, label: string): void {
  if (
    decision.textSourceKind === "not_applicable" &&
    !TEXTLESS_ASSET_POLICY_SURFACE_KINDS.includes(decision.assetSurfaceKind)
  ) {
    throw new Error(
      `${label}.textSourceKind not_applicable is only valid for textless asset policy surfaces`,
    );
  }
  if (decision.textSourceKind !== "not_applicable" && decision.sourceText === undefined) {
    throw new Error(`${label}.sourceText is required when textSourceKind is text-bearing`);
  }
  if (
    decision.textSourceKind === "ocr_hint" &&
    !["image_text", "ui_art", "video"].includes(decision.assetSurfaceKind)
  ) {
    throw new Error(`${label}.textSourceKind ocr_hint is only valid for visual asset surfaces`);
  }
}

function assertAssetPolicyPatchModeV02(decision: AssetPolicyDecisionV02, label: string): void {
  if (
    decision.patchMode === "metadata_only" &&
    decision.runtimeExpectation.expectationKind !== "metadata_only"
  ) {
    throw new Error(
      `${label}.patchMode metadata_only requires runtimeExpectation.expectationKind metadata_only`,
    );
  }

  if (decision.patchRef === undefined) {
    return;
  }

  const expectedWriteModes: Partial<Record<AssetPolicyPatchModeV02, PatchWriteModeV02[]>> = {
    metadata_only: ["metadata"],
    region_redraw_required: ["update_region"],
    asset_replacement_required: ["replace_asset"],
    font_substitution_required: ["replace_asset", "metadata"],
  };
  const writeModes = expectedWriteModes[decision.patchMode];
  if (writeModes !== undefined && !writeModes.includes(decision.patchRef.writeMode)) {
    throw new Error(
      `${label}.patchRef.writeMode must be ${writeModes.join(" or ")} for ${decision.patchMode}`,
    );
  }
  if (decision.patchMode === "unsupported" || decision.patchMode === "no_patch_required") {
    throw new Error(`${label}.patchRef must be omitted for ${decision.patchMode}`);
  }
}

function assertAssetPolicyDecisionAssetRefsExist(
  decision: AssetPolicyDecisionV02,
  label: string,
  assetsById: ReadonlyMap<Uuid7, BridgeAssetV02>,
): void {
  const sourceAsset = assetsById.get(decision.sourceAssetRef.assetId);
  if (sourceAsset === undefined) {
    throw new Error(
      `${label}.sourceAssetRef.assetId must reference an asset in asset policy assets`,
    );
  }
  assertAssetRefMatchesBridgeAssetV02(
    decision.sourceAssetRef,
    sourceAsset,
    `${label}.sourceAssetRef`,
  );
  assertAssetPolicySurfaceMatchesAssetKindV02(decision, sourceAsset, label);
  if (
    decision.sourceRevision.revisionId !== sourceAsset.sourceRevision.revisionId ||
    decision.sourceRevision.value !== sourceAsset.sourceRevision.value
  ) {
    throw new Error(`${label}.sourceRevision must match the referenced source asset revision`);
  }

  if (decision.patchRef !== undefined) {
    const patchAsset = assetsById.get(decision.patchRef.assetId);
    if (patchAsset === undefined) {
      throw new Error(`${label}.patchRef.assetId must reference an asset in asset policy assets`);
    }
    if (
      decision.patchRef.sourceRevision.revisionId !== patchAsset.sourceRevision.revisionId ||
      decision.patchRef.sourceRevision.value !== patchAsset.sourceRevision.value
    ) {
      throw new Error(`${label}.patchRef.sourceRevision must match the patch asset revision`);
    }
    assertAssetPolicyPatchAssetKindV02(decision, patchAsset, label);
  }
}

function assertAssetRefMatchesBridgeAssetV02(
  ref: AssetRefV02,
  asset: BridgeAssetV02,
  label: string,
): void {
  if (ref.assetKey !== undefined && ref.assetKey !== asset.assetKey) {
    throw new Error(`${label}.assetKey must match the referenced asset`);
  }
}

function assertAssetPolicySurfaceMatchesAssetKindV02(
  decision: AssetPolicyDecisionV02,
  sourceAsset: BridgeAssetV02,
  label: string,
): void {
  const allowedKinds = assetKindsForAssetPolicySurfaceKindV02(decision.assetSurfaceKind);
  if (!allowedKinds.includes(sourceAsset.assetKind)) {
    throw new Error(
      `${label}.assetSurfaceKind ${decision.assetSurfaceKind} is not valid for assetKind ${sourceAsset.assetKind}`,
    );
  }
}

function assertAssetPolicyPatchAssetKindV02(
  decision: AssetPolicyDecisionV02,
  patchAsset: BridgeAssetV02,
  label: string,
): void {
  const allowedKinds = assetKindsForAssetPolicyPatchRefV02(decision);
  if (!allowedKinds.includes(patchAsset.assetKind)) {
    throw new Error(
      `${label}.patchRef.assetId assetKind ${patchAsset.assetKind} is not valid for ${decision.patchMode} on ${decision.assetSurfaceKind}`,
    );
  }
}

function assetKindsForAssetPolicyPatchRefV02(
  decision: AssetPolicyDecisionV02,
): readonly AssetKindV02[] {
  const surfaceKinds = assetKindsForAssetPolicySurfaceKindV02(decision.assetSurfaceKind);
  const modeKinds = assetKindsForAssetPolicyPatchModeV02(decision.patchMode);
  return surfaceKinds.filter((kind) => modeKinds.includes(kind));
}

function assetKindsForAssetPolicyPatchModeV02(
  patchMode: AssetPolicyPatchModeV02,
): readonly AssetKindV02[] {
  switch (patchMode) {
    case "metadata_only":
    case "asset_replacement_required":
      return ASSET_KINDS;
    case "region_redraw_required":
      return REGION_PATCH_ASSET_KINDS;
    case "font_substitution_required":
      return ["font"];
    case "no_patch_required":
    case "unsupported":
      return [];
  }
}

function assetKindsForAssetPolicySurfaceKindV02(
  surfaceKind: AssetPolicySurfaceKindV02,
): readonly AssetKindV02[] {
  switch (surfaceKind) {
    case "image_text":
      return ["image", "ui_texture", "video"];
    case "ui_art":
      return ["ui_texture", "image"];
    case "song_title":
      return ["audio", "metadata"];
    case "font":
      return ["font"];
    case "credits":
      return ["metadata", "video"];
    case "video":
      return ["video"];
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
  assertOptionalRfc3339Instant(revision.createdAt, `${label}.createdAt`);
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
  assertOptionalUuid7(mapping.sourceSpanId, `${label}.sourceSpanId`);
  assertOptionalNonNegativeInteger(mapping.sourceStartByte, `${label}.sourceStartByte`);
  assertOptionalNonNegativeInteger(mapping.sourceEndByte, `${label}.sourceEndByte`);
  if ((mapping.sourceStartByte === undefined) !== (mapping.sourceEndByte === undefined)) {
    throw new Error(
      `${label}.sourceStartByte and ${label}.sourceEndByte must be provided together`,
    );
  }
  if (
    mapping.sourceStartByte !== undefined &&
    (mapping.sourceEndByte as number) <= (mapping.sourceStartByte as number)
  ) {
    throw new Error(`${label}.sourceEndByte must be greater than ${label}.sourceStartByte`);
  }
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
  assertOptionalUuid7(unit.actualBridgeUnitId, `${label}.actualBridgeUnitId`);
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
  if (unit.reason === "bridge_unit_id_mismatch" && unit.actualBridgeUnitId === undefined) {
    throw new Error(`${label}.actualBridgeUnitId is required for bridge_unit_id_mismatch`);
  }
  if (unit.reason !== "bridge_unit_id_mismatch" && unit.actualBridgeUnitId !== undefined) {
    throw new Error(`${label}.actualBridgeUnitId is only valid for bridge_unit_id_mismatch`);
  }
  if (unit.actualBridgeUnitId !== undefined && unit.actualBridgeUnitId === unit.bridgeUnitId) {
    throw new Error(`${label}.actualBridgeUnitId must differ from ${label}.bridgeUnitId`);
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
  assertRfc3339Instant(event.occurredAt, `${label}.occurredAt`);
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
  assertRfc3339Instant(task.createdAt, `${label}.createdAt`);
  assertString(task.summary, `${label}.summary`);
  assertOptionalUuid7(task.createdByEventId, `${label}.createdByEventId`);
  assertTriageSubjectRefsV02(task.inputRefs, `${label}.inputRefs`);
  assertProvenanceArrayV02(task.provenance, `${label}.provenance`);
  assertCausalLinksV02(task.causalLinks, `${label}.causalLinks`);
}

export function assertFindingRecordV02(
  value: unknown,
  label: string,
): asserts value is FindingRecordV02 {
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
  assertRfc3339Instant(finding.createdAt, `${label}.createdAt`);
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
      assertOptionalRfc3339Instant(provenance.observedAt, `${label}.observedAt`);
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

function assertFindingRecordEvidenceReferencesOwnProvenanceV02(
  finding: FindingRecordV02,
  label: string,
): void {
  const provenanceIds = new Set(finding.provenance.map((record) => record.provenanceId));
  for (const [evidenceIndex, evidence] of finding.evidence.entries()) {
    const evidenceLabel = `${label}.evidence[${evidenceIndex}]`;
    if (evidence.provenanceIds.length === 0) {
      throw new Error(`${evidenceLabel}.provenanceIds must contain at least one provenance id`);
    }
    for (const [provenanceIndex, provenanceId] of evidence.provenanceIds.entries()) {
      if (!provenanceIds.has(provenanceId)) {
        throw new Error(
          `${evidenceLabel}.provenanceIds[${provenanceIndex}] must reference provenance on the same finding`,
        );
      }
    }
  }
}

function assertBenchmarkInputRefV02(
  value: unknown,
  label: string,
): asserts value is BenchmarkInputRefV02 {
  const inputRef = asRecord(value, label);
  assertString(inputRef.corpusRefId, `${label}.corpusRefId`);
  assertEnum(inputRef.corpusKind, BENCHMARK_INPUT_KINDS, `${label}.corpusKind`);
  assertString(inputRef.label, `${label}.label`);
  if (inputRef.manifestUri !== undefined) {
    assertPortableArtifactUriV02(inputRef.manifestUri, `${label}.manifestUri`);
  }
  assertOptionalHashStringV02(inputRef.manifestHash, `${label}.manifestHash`);
  assertOptionalHashStringV02(inputRef.sourceBundleHash, `${label}.sourceBundleHash`);
  assertString(inputRef.sourceLocale, `${label}.sourceLocale`);
  assertString(inputRef.targetLocale, `${label}.targetLocale`);
  assertString(inputRef.engineProfile, `${label}.engineProfile`);
  assertString(inputRef.benchmarkSplit, `${label}.benchmarkSplit`);
  assertPositiveInteger(inputRef.sourceUnitCount, `${label}.sourceUnitCount`);
  assertPositiveInteger(inputRef.sourceCharacterCount, `${label}.sourceCharacterCount`);
  assertBoolean(inputRef.publicContent, `${label}.publicContent`);
  if (inputRef.corpusKind === "private_local_corpus" && inputRef.publicContent) {
    throw new Error(`${label}.publicContent must be false for private_local_corpus`);
  }
}

function assertBenchmarkToolVersionV02(
  value: unknown,
  label: string,
): asserts value is BenchmarkToolVersionV02 {
  const toolVersion = asRecord(value, label);
  assertString(toolVersion.name, `${label}.name`);
  assertString(toolVersion.version, `${label}.version`);
  assertOptionalString(toolVersion.gitCommit, `${label}.gitCommit`);
}

function assertBenchmarkCommandLineV02(
  value: unknown,
  label: string,
): asserts value is BenchmarkCommandLineV02 {
  const commandLine = asRecord(value, label);
  assertString(commandLine.commandId, `${label}.commandId`);
  const argv = asArray(commandLine.argv, `${label}.argv`);
  if (argv.length === 0) {
    throw new Error(`${label}.argv must contain at least one command token`);
  }
  for (const [index, token] of argv.entries()) {
    assertString(token, `${label}.argv[${index}]`);
  }
}

function assertBenchmarkComparedSystemV02(
  value: unknown,
  label: string,
): asserts value is BenchmarkComparedSystemV02 {
  const system = asRecord(value, label);
  assertString(system.systemId, `${label}.systemId`);
  assertEnum(system.systemKind, BENCHMARK_SYSTEM_KINDS, `${label}.systemKind`);
  assertString(system.displayName, `${label}.displayName`);
  assertRfc3339Instant(system.generatedAt, `${label}.generatedAt`);
  assertUuid7Array(system.providerRunIds, `${label}.providerRunIds`);
  assertOptionalString(system.promptPresetId, `${label}.promptPresetId`);
  assertOptionalString(system.promptPresetVersion, `${label}.promptPresetVersion`);
  if (system.outputArtifactRef !== undefined) {
    assertBenchmarkArtifactRefV02(system.outputArtifactRef, `${label}.outputArtifactRef`);
  }
  if (system.providerRunIds.length > 0 && system.promptPresetId === undefined) {
    throw new Error(`${label}.promptPresetId is required when providerRunIds are present`);
  }
}

function assertBenchmarkArtifactRefV02(
  value: unknown,
  label: string,
): asserts value is BenchmarkArtifactRefV02 {
  const ref = asRecord(value, label);
  assertUuid7(ref.artifactId, `${label}.artifactId`);
  assertString(ref.artifactKind, `${label}.artifactKind`);
  assertPortableArtifactUriV02(ref.uri, `${label}.uri`);
  assertOptionalHashStringV02(ref.hash, `${label}.hash`);
  assertOptionalString(ref.mediaType, `${label}.mediaType`);
}

function assertBenchmarkProviderRunV02(
  value: unknown,
  label: string,
): asserts value is BenchmarkProviderRunV02 {
  const run = asRecord(value, label);
  assertUuid7(run.providerRunId, `${label}.providerRunId`);
  assertString(run.systemId, `${label}.systemId`);
  assertEnum(run.taskKind, TRIAGE_TASK_KINDS, `${label}.taskKind`);
  assertStartedCompletedInstantsV02(run.startedAt, run.completedAt, label);
  if (run.latencyMs !== undefined) {
    assertNonNegativeInteger(run.latencyMs, `${label}.latencyMs`);
  }
  assertEnum(run.status, BENCHMARK_PROVIDER_RUN_STATUSES, `${label}.status`);
  assertBenchmarkProviderIdentityV02(run.provider, `${label}.provider`);
  assertBenchmarkPromptIdentityV02(run.prompt, `${label}.prompt`);
  assertString(run.structuredOutputMode, `${label}.structuredOutputMode`);
  assertNonNegativeInteger(run.retryCount, `${label}.retryCount`);
  assertStringArray(run.errorClasses, `${label}.errorClasses`);
  assertBoolean(run.fallbackUsed, `${label}.fallbackUsed`);
  if (run.fallbackPlan !== undefined) {
    assertStringArray(run.fallbackPlan, `${label}.fallbackPlan`);
  }
  assertBenchmarkTokenUsageV02(run.tokenUsage, `${label}.tokenUsage`);
  assertBenchmarkCostAmountV02(run.cost, `${label}.cost`);
  if (run.status === "failed" && run.errorClasses.length === 0) {
    throw new Error(`${label}.errorClasses must explain failed provider runs`);
  }
}

function assertBenchmarkProviderIdentityV02(
  value: unknown,
  label: string,
): asserts value is BenchmarkProviderIdentityV02 {
  const provider = asRecord(value, label);
  assertEnum(provider.providerFamily, BENCHMARK_PROVIDER_FAMILIES, `${label}.providerFamily`);
  assertString(provider.endpointFamily, `${label}.endpointFamily`);
  assertString(provider.providerName, `${label}.providerName`);
  assertString(provider.requestedModelId, `${label}.requestedModelId`);
  assertString(provider.actualModelId, `${label}.actualModelId`);
  assertOptionalString(provider.upstreamProvider, `${label}.upstreamProvider`);
  assertOptionalHashStringV02(provider.routeSettingsHash, `${label}.routeSettingsHash`);
}

function assertBenchmarkPromptIdentityV02(
  value: unknown,
  label: string,
): asserts value is BenchmarkPromptIdentityV02 {
  const prompt = asRecord(value, label);
  assertString(prompt.promptPresetId, `${label}.promptPresetId`);
  assertString(prompt.promptTemplateVersion, `${label}.promptTemplateVersion`);
  assertOptionalHashStringV02(prompt.promptHash, `${label}.promptHash`);
  assertOptionalString(prompt.remotePresetSlug, `${label}.remotePresetSlug`);
  assertOptionalString(prompt.remotePresetVersion, `${label}.remotePresetVersion`);
  assertOptionalHashStringV02(prompt.remotePresetConfigHash, `${label}.remotePresetConfigHash`);
}

function assertBenchmarkTokenUsageV02(
  value: unknown,
  label: string,
): asserts value is BenchmarkTokenUsageV02 {
  const usage = asRecord(value, label);
  assertEnum(usage.tokenCountSource, BENCHMARK_TOKEN_COUNT_SOURCES, `${label}.tokenCountSource`);
  assertOptionalNonNegativeInteger(usage.promptTokens, `${label}.promptTokens`);
  assertOptionalNonNegativeInteger(usage.completionTokens, `${label}.completionTokens`);
  assertOptionalNonNegativeInteger(usage.reasoningTokens, `${label}.reasoningTokens`);
  assertOptionalNonNegativeInteger(usage.cachedInputTokens, `${label}.cachedInputTokens`);
  assertOptionalNonNegativeInteger(usage.totalTokens, `${label}.totalTokens`);
  if (usage.tokenCountSource === "unknown" && usage.totalTokens !== undefined) {
    throw new Error(`${label}.totalTokens must be omitted when tokenCountSource is unknown`);
  }
  if (usage.tokenCountSource !== "unknown" && usage.totalTokens === undefined) {
    throw new Error(`${label}.totalTokens is required unless tokenCountSource is unknown`);
  }
  const countedTotal =
    (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0) + (usage.reasoningTokens ?? 0);
  if (usage.totalTokens !== undefined && countedTotal > usage.totalTokens) {
    throw new Error(`${label}.totalTokens must be at least prompt + completion + reasoning tokens`);
  }
}

function assertBenchmarkCostAmountV02(
  value: unknown,
  label: string,
): asserts value is BenchmarkCostAmountV02 {
  const cost = asRecord(value, label);
  assertEnum(cost.costKind, BENCHMARK_COST_KINDS, `${label}.costKind`);
  assertEqual(cost.currency, "USD", `${label}.currency`);
  assertOptionalNonNegativeInteger(cost.amountMicrosUsd, `${label}.amountMicrosUsd`);
  assertOptionalString(cost.pricingSnapshotId, `${label}.pricingSnapshotId`);
  if (cost.costKind === "unknown" && cost.amountMicrosUsd !== undefined) {
    throw new Error(`${label}.amountMicrosUsd must be omitted when costKind is unknown`);
  }
  if (cost.costKind !== "unknown" && cost.amountMicrosUsd === undefined) {
    throw new Error(`${label}.amountMicrosUsd is required unless costKind is unknown`);
  }
  if (cost.costKind === "zero" && cost.amountMicrosUsd !== 0) {
    throw new Error(`${label}.amountMicrosUsd must be 0 when costKind is zero`);
  }
}

function assertBenchmarkCostLedgerV02(
  value: unknown,
  label: string,
  systemIds: ReadonlySet<string>,
  expectedReportTotalMicrosUsd: number,
  expectedTotalsBySystem: ReadonlyMap<string, number>,
  expectedIncludesUnknownCost: boolean,
): asserts value is BenchmarkCostLedgerV02 {
  const ledger = asRecord(value, label);
  assertEqual(ledger.currency, "USD", `${label}.currency`);
  assertNonNegativeInteger(ledger.reportTotalMicrosUsd, `${label}.reportTotalMicrosUsd`);
  if (ledger.reportTotalMicrosUsd !== expectedReportTotalMicrosUsd) {
    throw new Error(`${label}.reportTotalMicrosUsd must equal providerModelCostRecords total`);
  }
  assertBoolean(ledger.includesUnknownCost, `${label}.includesUnknownCost`);
  if (ledger.includesUnknownCost !== expectedIncludesUnknownCost) {
    throw new Error(`${label}.includesUnknownCost must match providerModelCostRecords`);
  }
  const totals = asArray(ledger.totalsBySystem, `${label}.totalsBySystem`);
  const seenSystemIds = new Set<string>();
  for (const [index, total] of totals.entries()) {
    const totalLabel = `${label}.totalsBySystem[${index}]`;
    assertBenchmarkCostLedgerTotalV02(total, totalLabel);
    assertKnownStringRefV02(total.systemId, `${totalLabel}.systemId`, "system", systemIds);
    if (seenSystemIds.has(total.systemId)) {
      throw new Error(`${totalLabel}.systemId must be unique within totalsBySystem`);
    }
    seenSystemIds.add(total.systemId);
    const expectedTotal = expectedTotalsBySystem.get(total.systemId) ?? 0;
    if (total.totalMicrosUsd !== expectedTotal) {
      throw new Error(`${totalLabel}.totalMicrosUsd must equal providerModelCostRecords total`);
    }
  }
  for (const [systemId, expectedTotal] of expectedTotalsBySystem) {
    if (expectedTotal > 0 && !seenSystemIds.has(systemId)) {
      throw new Error(`${label}.totalsBySystem must include system ${systemId}`);
    }
  }
}

function assertBenchmarkCostLedgerTotalV02(
  value: unknown,
  label: string,
): asserts value is BenchmarkCostLedgerTotalV02 {
  const total = asRecord(value, label);
  assertString(total.systemId, `${label}.systemId`);
  assertNonNegativeInteger(total.totalMicrosUsd, `${label}.totalMicrosUsd`);
}

function assertBenchmarkSeededDefectOracleV02(
  value: unknown,
  label: string,
): asserts value is BenchmarkSeededDefectOracleV02 {
  const seed = asRecord(value, label);
  assertString(seed.seededDefectId, `${label}.seededDefectId`);
  assertString(seed.fixtureOrCorpusRefId, `${label}.fixtureOrCorpusRefId`);
  assertString(seed.seedKind, `${label}.seedKind`);
  assertString(seed.targetLocale, `${label}.targetLocale`);
  assertTriageSubjectRefsV02(seed.affectedRefs, `${label}.affectedRefs`);
  assertEnum(seed.category, LOCALIZATION_QUALITY_CATEGORIES, `${label}.category`);
  assertOptionalString(seed.qualitySubcategory, `${label}.qualitySubcategory`);
  assertEnum(seed.qualitySeverity, LOCALIZATION_QUALITY_SEVERITIES, `${label}.qualitySeverity`);
  assertEnum(seed.expectedRootCause, LOCALIZATION_ROOT_CAUSES, `${label}.expectedRootCause`);
  const expectedDetectorKinds = asArray(
    seed.expectedDetectorKinds,
    `${label}.expectedDetectorKinds`,
  );
  if (expectedDetectorKinds.length === 0) {
    throw new Error(`${label}.expectedDetectorKinds must contain at least one detector kind`);
  }
  for (const [index, detectorKind] of expectedDetectorKinds.entries()) {
    assertEnum(detectorKind, QUALITY_DETECTOR_KINDS, `${label}.expectedDetectorKinds[${index}]`);
  }
  assertUuid7Array(seed.matchedFindingIds, `${label}.matchedFindingIds`);
  assertBoolean(seed.publicContent, `${label}.publicContent`);
}

function assertBenchmarkFindingRecordV02(
  value: unknown,
  label: string,
): asserts value is BenchmarkFindingRecordV02 {
  const finding = asRecord(value, label);
  assertUuid7(finding.findingId, `${label}.findingId`);
  assertString(finding.systemId, `${label}.systemId`);
  assertEqual(finding.taxonomyId, LOCALIZATION_QUALITY_TAXONOMY_ID, `${label}.taxonomyId`);
  assertEqual(
    finding.taxonomyVersion,
    LOCALIZATION_QUALITY_TAXONOMY_VERSION,
    `${label}.taxonomyVersion`,
  );
  assertEnum(finding.detectorKind, QUALITY_DETECTOR_KINDS, `${label}.detectorKind`);
  assertEnum(finding.category, LOCALIZATION_QUALITY_CATEGORIES, `${label}.category`);
  assertOptionalString(finding.qualitySubcategory, `${label}.qualitySubcategory`);
  assertEnum(finding.qualitySeverity, LOCALIZATION_QUALITY_SEVERITIES, `${label}.qualitySeverity`);
  assertEnum(finding.rootCause, LOCALIZATION_ROOT_CAUSES, `${label}.rootCause`);
  assertEnum(
    finding.adjudicationState,
    LOCALIZATION_ADJUDICATION_STATES,
    `${label}.adjudicationState`,
  );
  assertTriageSubjectRefsV02(finding.affectedRefs, `${label}.affectedRefs`);
  assertEvidenceArrayV02(finding.evidence, `${label}.evidence`);
  assertProvenanceArrayV02(finding.provenance, `${label}.provenance`);
  assertBenchmarkFindingEvidenceProvenanceV02(finding as BenchmarkFindingRecordV02, label);
  assertOptionalString(finding.seededDefectId, `${label}.seededDefectId`);
  assertOptionalString(finding.reviewerRationale, `${label}.reviewerRationale`);
  if (
    finding.rootCause === "unknown_unadjudicated" &&
    finding.adjudicationState !== "unreviewed" &&
    finding.adjudicationState !== "needs_more_context"
  ) {
    throw new Error(`${label}.rootCause cannot be unknown_unadjudicated after adjudication`);
  }
}

function assertBenchmarkFindingEvidenceProvenanceV02(
  finding: BenchmarkFindingRecordV02,
  label: string,
): void {
  const provenanceIds = new Set(finding.provenance.map((record) => record.provenanceId));
  for (const [evidenceIndex, evidence] of finding.evidence.entries()) {
    const evidenceLabel = `${label}.evidence[${evidenceIndex}]`;
    if (evidence.provenanceIds.length === 0) {
      throw new Error(`${evidenceLabel}.provenanceIds must contain at least one provenance id`);
    }
    for (const [provenanceIndex, provenanceId] of evidence.provenanceIds.entries()) {
      if (!provenanceIds.has(provenanceId)) {
        throw new Error(
          `${evidenceLabel}.provenanceIds[${provenanceIndex}] must reference provenance on the same finding`,
        );
      }
    }
  }
}

function assertBenchmarkCountBucketsV02<T extends string>(
  value: unknown,
  allowedBuckets: readonly T[],
  label: string,
): BenchmarkCountBucketV02<T>[] {
  const records = asArray(value, label);
  const buckets: BenchmarkCountBucketV02<T>[] = [];
  const seenBuckets = new Set<T>();
  for (const [index, record] of records.entries()) {
    const bucketLabel = `${label}[${index}]`;
    const bucketRecord = asRecord(record, bucketLabel);
    assertEnum(bucketRecord.bucket, allowedBuckets, `${bucketLabel}.bucket`);
    assertNonNegativeInteger(bucketRecord.count, `${bucketLabel}.count`);
    if (seenBuckets.has(bucketRecord.bucket)) {
      throw new Error(`${bucketLabel}.bucket must be unique within ${label}`);
    }
    seenBuckets.add(bucketRecord.bucket);
    buckets.push({
      bucket: bucketRecord.bucket,
      count: bucketRecord.count,
    });
  }
  return buckets;
}

function assertCountBucketsMatchV02<T extends string>(
  actualValues: readonly T[],
  buckets: readonly BenchmarkCountBucketV02<T>[],
  label: string,
): void {
  const actualCounts = new Map<T, number>();
  for (const value of actualValues) {
    actualCounts.set(value, (actualCounts.get(value) ?? 0) + 1);
  }
  const reportedBuckets = new Set<T>();
  for (const bucket of buckets) {
    reportedBuckets.add(bucket.bucket);
    const actualCount = actualCounts.get(bucket.bucket) ?? 0;
    if (bucket.count !== actualCount) {
      throw new Error(`${label}.${bucket.bucket} count must match findingRecords`);
    }
  }
  for (const [bucket, actualCount] of actualCounts) {
    if (actualCount > 0 && !reportedBuckets.has(bucket)) {
      throw new Error(`${label} must include bucket ${bucket}`);
    }
  }
}

function assertBenchmarkPenaltySummaryV02(
  value: unknown,
  label: string,
  qualitySeverities: readonly LocalizationQualitySeverityV02[],
  totalSourceCharacterCount: number,
  totalSourceUnitCount: number,
): asserts value is BenchmarkPenaltySummaryV02 {
  const summary = asRecord(value, label);
  assertNonNegativeNumber(summary.penaltyTotal, `${label}.penaltyTotal`);
  assertNonNegativeNumber(
    summary.penaltyPerThousandSourceChars,
    `${label}.penaltyPerThousandSourceChars`,
  );
  assertNonNegativeNumber(
    summary.penaltyPerHundredSourceUnits,
    `${label}.penaltyPerHundredSourceUnits`,
  );
  const expectedPenaltyTotal = qualitySeverities.reduce(
    (total, severity) => total + LOCALIZATION_QUALITY_SEVERITY_WEIGHTS[severity],
    0,
  );
  if (summary.penaltyTotal !== expectedPenaltyTotal) {
    throw new Error(
      `${label}.penaltyTotal must match findingRecords qualitySeverity weights from ${LOCALIZATION_QUALITY_TAXONOMY_ID}`,
    );
  }
  assertNumberWithinTolerance(
    summary.penaltyPerThousandSourceChars,
    (expectedPenaltyTotal / totalSourceCharacterCount) * 1000,
    BENCHMARK_NORMALIZED_PENALTY_TOLERANCE,
    `${label}.penaltyPerThousandSourceChars`,
    "findingRecords qualitySeverity weights normalized by fixtureOrCorpusRefs.sourceCharacterCount",
  );
  assertNumberWithinTolerance(
    summary.penaltyPerHundredSourceUnits,
    (expectedPenaltyTotal / totalSourceUnitCount) * 100,
    BENCHMARK_NORMALIZED_PENALTY_TOLERANCE,
    `${label}.penaltyPerHundredSourceUnits`,
    "findingRecords qualitySeverity weights normalized by fixtureOrCorpusRefs.sourceUnitCount",
  );
}

function assertDeterministicQaResultV02(
  value: unknown,
  label: string,
): asserts value is DeterministicQaResultV02 {
  const result = asRecord(value, label);
  assertUuid7(result.deterministicQaRunId, `${label}.deterministicQaRunId`);
  assertString(result.evaluatedSystemId, `${label}.evaluatedSystemId`);
  assertString(result.checkName, `${label}.checkName`);
  assertString(result.checkVersion, `${label}.checkVersion`);
  assertStartedCompletedInstantsV02(result.startedAt, result.completedAt, label);
  assertNonNegativeInteger(result.ruleCount, `${label}.ruleCount`);
  assertNonNegativeInteger(result.passedRuleCount, `${label}.passedRuleCount`);
  assertNonNegativeInteger(result.failedRuleCount, `${label}.failedRuleCount`);
  if (result.passedRuleCount + result.failedRuleCount !== result.ruleCount) {
    throw new Error(`${label}.passedRuleCount plus failedRuleCount must equal ruleCount`);
  }
  assertUuid7Array(result.findingIds, `${label}.findingIds`);
  const artifactRefs = asArray(result.artifactRefs, `${label}.artifactRefs`);
  for (const [index, artifactRef] of artifactRefs.entries()) {
    assertBenchmarkArtifactRefV02(artifactRef, `${label}.artifactRefs[${index}]`);
  }
}

function assertQaAgentEvaluationV02(
  value: unknown,
  label: string,
): asserts value is QaAgentEvaluationV02 {
  const evaluation = asRecord(value, label);
  assertUuid7(evaluation.qaAgentEvaluationId, `${label}.qaAgentEvaluationId`);
  assertString(evaluation.qaAgentId, `${label}.qaAgentId`);
  assertString(evaluation.qaAgentVersion, `${label}.qaAgentVersion`);
  assertString(evaluation.evaluatedSystemId, `${label}.evaluatedSystemId`);
  assertUuid7Array(evaluation.providerRunIds, `${label}.providerRunIds`);
  assertUuid7Array(evaluation.findingIds, `${label}.findingIds`);
  assertQaAgentMetricsV02(evaluation.metrics, `${label}.metrics`);
  assertStringArray(evaluation.limitations, `${label}.limitations`);
}

function assertQaAgentMetricsV02(
  value: unknown,
  label: string,
): asserts value is QaAgentMetricsV02 {
  const metrics = asRecord(value, label);
  assertRatio(metrics.seededRecall, `${label}.seededRecall`);
  assertRatio(metrics.seededPrecision, `${label}.seededPrecision`);
  assertRatio(metrics.f1, `${label}.f1`);
  assertRatio(metrics.categoryAccuracy, `${label}.categoryAccuracy`);
  assertRatio(metrics.qualitySeverityAccuracy, `${label}.qualitySeverityAccuracy`);
  assertRatio(metrics.rootCauseAccuracy, `${label}.rootCauseAccuracy`);
  assertRatio(metrics.criticalRecall, `${label}.criticalRecall`);
  assertRatio(metrics.unscorableRate, `${label}.unscorableRate`);
  if (metrics.humanConfirmedPrecision !== undefined) {
    assertRatio(metrics.humanConfirmedPrecision, `${label}.humanConfirmedPrecision`);
  }
  assertNonNegativeInteger(metrics.findingsEmitted, `${label}.findingsEmitted`);
  assertNonNegativeInteger(metrics.scorableFindings, `${label}.scorableFindings`);
  assertNonNegativeInteger(metrics.adjudicatedFindings, `${label}.adjudicatedFindings`);
  if (metrics.scorableFindings > metrics.findingsEmitted) {
    throw new Error(`${label}.scorableFindings must not exceed findingsEmitted`);
  }
  if (metrics.adjudicatedFindings > metrics.findingsEmitted) {
    throw new Error(`${label}.adjudicatedFindings must not exceed findingsEmitted`);
  }
}

function assertHumanEvaluationResultV02(
  value: unknown,
  label: string,
): asserts value is HumanEvaluationResultV02 {
  const evaluation = asRecord(value, label);
  assertUuid7(evaluation.humanEvaluationId, `${label}.humanEvaluationId`);
  assertUuid7(evaluation.reviewSessionId, `${label}.reviewSessionId`);
  const evaluatedSystemIds = asArray(evaluation.evaluatedSystemIds, `${label}.evaluatedSystemIds`);
  if (evaluatedSystemIds.length === 0) {
    throw new Error(`${label}.evaluatedSystemIds must contain at least one system id`);
  }
  for (const [index, systemId] of evaluatedSystemIds.entries()) {
    assertString(systemId, `${label}.evaluatedSystemIds[${index}]`);
  }
  assertPositiveInteger(evaluation.reviewerCount, `${label}.reviewerCount`);
  assertPositiveInteger(evaluation.sampleUnitCount, `${label}.sampleUnitCount`);
  assertPositiveInteger(
    evaluation.sampleSourceCharacterCount,
    `${label}.sampleSourceCharacterCount`,
  );
  assertBoolean(evaluation.blindReview, `${label}.blindReview`);
  assertUuid7Array(evaluation.adjudicatedFindingIds, `${label}.adjudicatedFindingIds`);
  assertOptionalString(evaluation.reviewerAgreementNotes, `${label}.reviewerAgreementNotes`);
}

function assertQaAgentCoverageV02(
  llmQaProviderRunSystemIds: ReadonlyMap<Uuid7, string>,
  llmQaFindingSystemIds: ReadonlyMap<Uuid7, string>,
  qaAgentProviderRunIdsBySystem: ReadonlyMap<string, ReadonlySet<Uuid7>>,
  qaAgentFindingIdsBySystem: ReadonlyMap<string, ReadonlySet<Uuid7>>,
): void {
  for (const [providerRunId, systemId] of llmQaProviderRunSystemIds) {
    if (!qaAgentProviderRunIdsBySystem.get(systemId)?.has(providerRunId)) {
      throw new Error(
        `BenchmarkReportV02.qaAgentEvaluations.providerRunIds must cover llm_qa providerModelCostRecords run ${providerRunId} for evaluatedSystemId ${systemId}`,
      );
    }
  }
  for (const [findingId, systemId] of llmQaFindingSystemIds) {
    if (!qaAgentFindingIdsBySystem.get(systemId)?.has(findingId)) {
      throw new Error(
        `BenchmarkReportV02.qaAgentEvaluations.findingIds must cover llm_qa findingRecords finding ${findingId} for evaluatedSystemId ${systemId}`,
      );
    }
  }
}

function addToSetMap<Key, Value>(map: Map<Key, Set<Value>>, key: Key, value: Value): void {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, new Set([value]));
    return;
  }
  existing.add(value);
}

function assertKnownStringRefV02(
  id: string,
  label: string,
  targetName: string,
  knownIds: ReadonlySet<string>,
): void {
  if (!knownIds.has(id)) {
    throw new Error(`${label} must reference an existing ${targetName}`);
  }
}

function assertKnownUuid7RefsV02(
  ids: readonly Uuid7[],
  label: string,
  targetName: string,
  knownIds: ReadonlySet<Uuid7>,
): void {
  for (const [index, id] of ids.entries()) {
    if (!knownIds.has(id)) {
      throw new Error(`${label}[${index}] must reference an existing ${targetName}`);
    }
  }
}

function assertAlphaVerticalProofFixtureRefV02(
  value: unknown,
  label: string,
): asserts value is AlphaVerticalProofFixtureRefV02 {
  const fixture = asRecord(value, label);
  assertAllowedKeysV02(
    fixture,
    ["fixtureId", "publicManifestUri", "publicManifestHash", "publicRedistribution"],
    label,
  );
  assertPublicFixtureIdV02(fixture.fixtureId, `${label}.fixtureId`);
  assertPortablePublicArtifactUriV02(fixture.publicManifestUri, `${label}.publicManifestUri`);
  assertHashStringV02(fixture.publicManifestHash, `${label}.publicManifestHash`);
  assertEqual(fixture.publicRedistribution, "allowed", `${label}.publicRedistribution`);
}

function assertAlphaVerticalProofEngineProfileV02(
  value: unknown,
  label: string,
): asserts value is AlphaVerticalProofEngineProfileV02 {
  const profile = asRecord(value, label);
  assertAllowedKeysV02(
    profile,
    [
      "engineProfileId",
      "engineKind",
      "kaifuuProfileId",
      "itotoriWorkflowId",
      "utsushiRuntimeProfileId",
    ],
    label,
  );
  assertString(profile.engineProfileId, `${label}.engineProfileId`);
  assertString(profile.engineKind, `${label}.engineKind`);
  assertString(profile.kaifuuProfileId, `${label}.kaifuuProfileId`);
  assertString(profile.itotoriWorkflowId, `${label}.itotoriWorkflowId`);
  assertString(profile.utsushiRuntimeProfileId, `${label}.utsushiRuntimeProfileId`);
}

function assertAlphaVerticalProofBridgeUnitRefV02(
  value: unknown,
  label: string,
): asserts value is AlphaVerticalProofBridgeUnitRefV02 {
  const ref = asRecord(value, label);
  assertAllowedKeysV02(ref, ["bridgeUnitId", "sourceUnitKey", "sourceHash"], label);
  assertUuid7(ref.bridgeUnitId, `${label}.bridgeUnitId`);
  assertString(ref.sourceUnitKey, `${label}.sourceUnitKey`);
  assertHashStringV02(ref.sourceHash, `${label}.sourceHash`);
}

function assertAlphaVerticalProofArtifactRefsV02(
  value: unknown,
  label: string,
): asserts value is AlphaVerticalProofArtifactRefsV02 {
  const refs = asRecord(value, label);
  assertAllowedKeysV02(
    refs,
    [
      "publicFixtureManifest",
      "bridgeBundle",
      "patchExport",
      "patchResult",
      "deltaPackage",
      "runtimeReport",
      "findingReport",
      "benchmarkReport",
    ],
    label,
  );
  assertAlphaVerticalProofArtifactRefV02(
    refs.publicFixtureManifest,
    `${label}.publicFixtureManifest`,
    "public_fixture_manifest",
  );
  assertAlphaVerticalProofArtifactRefV02(
    refs.bridgeBundle,
    `${label}.bridgeBundle`,
    "bridge_bundle",
  );
  assertAlphaVerticalProofArtifactRefV02(refs.patchExport, `${label}.patchExport`, "patch_export");
  assertAlphaVerticalProofArtifactRefV02(refs.patchResult, `${label}.patchResult`, "patch_result");
  assertAlphaVerticalProofArtifactRefV02(
    refs.deltaPackage,
    `${label}.deltaPackage`,
    "delta_package",
  );
  assertAlphaVerticalProofArtifactRefV02(
    refs.runtimeReport,
    `${label}.runtimeReport`,
    "runtime_report",
  );
  if (refs.findingReport !== undefined) {
    assertAlphaVerticalProofArtifactRefV02(
      refs.findingReport,
      `${label}.findingReport`,
      "finding_report",
    );
  }
  assertAlphaVerticalProofArtifactRefV02(
    refs.benchmarkReport,
    `${label}.benchmarkReport`,
    "benchmark_report",
  );
}

function assertAlphaVerticalProofArtifactRefV02(
  value: unknown,
  label: string,
  expectedKind: AlphaVerticalProofArtifactKindV02,
): asserts value is AlphaVerticalProofArtifactRefV02 {
  const ref = asRecord(value, label);
  assertAllowedKeysV02(
    ref,
    ["artifactId", "artifactKind", "uri", "hash", "mediaType", "byteSize"],
    label,
  );
  assertUuid7(ref.artifactId, `${label}.artifactId`);
  assertEnum(ref.artifactKind, ALPHA_VERTICAL_PROOF_ARTIFACT_KINDS_V02, `${label}.artifactKind`);
  if (ref.artifactKind !== expectedKind) {
    throw new Error(`${label}.artifactKind must be ${expectedKind}`);
  }
  assertPortablePublicArtifactUriV02(ref.uri, `${label}.uri`);
  assertHashStringV02(ref.hash, `${label}.hash`);
  assertOptionalString(ref.mediaType, `${label}.mediaType`);
  if (ref.byteSize !== undefined) {
    assertPositiveInteger(ref.byteSize, `${label}.byteSize`);
  }
}

function assertAlphaVerticalProofBenchmarkOutputRefV02(
  value: unknown,
  label: string,
): asserts value is AlphaVerticalProofBenchmarkOutputRefV02 {
  const ref = asRecord(value, label);
  assertAllowedKeysV02(ref, ["benchmarkRunId", "artifactRef"], label);
  assertUuid7(ref.benchmarkRunId, `${label}.benchmarkRunId`);
  assertAlphaVerticalProofArtifactRefV02(
    ref.artifactRef,
    `${label}.artifactRef`,
    "benchmark_report",
  );
}

function assertAlphaVerticalProofContentHashesV02(
  value: unknown,
  label: string,
): AlphaVerticalProofContentHashV02[] {
  const hashes = asArray(value, label);
  if (hashes.length === 0) {
    throw new Error(`${label} must contain at least one content hash`);
  }
  const entries: AlphaVerticalProofContentHashV02[] = [];
  const keys = new Set<string>();
  for (const [index, hash] of hashes.entries()) {
    const hashLabel = `${label}[${index}]`;
    const entry = asRecord(hash, hashLabel);
    assertAllowedKeysV02(entry, ["scope", "contentId", "hash"], hashLabel);
    assertEnum(entry.scope, ALPHA_VERTICAL_PROOF_HASH_SCOPES_V02, `${hashLabel}.scope`);
    assertString(entry.contentId, `${hashLabel}.contentId`);
    assertHashStringV02(entry.hash, `${hashLabel}.hash`);
    const key = `${entry.scope}\0${entry.contentId}`;
    if (keys.has(key)) {
      throw new Error(`${hashLabel} must be unique by scope and contentId`);
    }
    keys.add(key);
    entries.push(entry as AlphaVerticalProofContentHashV02);
  }
  return entries;
}

function assertAlphaVerticalProofRequiredHashScopesV02(
  hashes: readonly AlphaVerticalProofContentHashV02[],
): void {
  const scopes = new Set(hashes.map((hash) => hash.scope));
  for (const scope of [
    "public_fixture_manifest",
    "source_bundle",
    "bridge_bundle",
    "bridge_unit",
    "patch_export",
    "patch_result",
    "delta_package",
    "runtime_report",
    "benchmark_report",
    "provider_proof",
  ] as const) {
    if (!scopes.has(scope)) {
      throw new Error(`AlphaVerticalProofManifestV02.contentHashes must include ${scope}`);
    }
  }
}

function assertAlphaVerticalProofHashCoveredV02(
  hashes: readonly AlphaVerticalProofContentHashV02[],
  scope: AlphaVerticalProofHashScopeV02,
  contentId: string,
  hash: string,
  label: string,
): void {
  if (
    !hashes.some(
      (entry) => entry.scope === scope && entry.contentId === contentId && entry.hash === hash,
    )
  ) {
    throw new Error(`${label} must be represented in AlphaVerticalProofManifestV02.contentHashes`);
  }
}

function assertAlphaVerticalProofHashScopeContentIdV02(
  hashes: readonly AlphaVerticalProofContentHashV02[],
  scope: AlphaVerticalProofHashScopeV02,
  contentId: string,
  label: string,
): void {
  if (!hashes.some((entry) => entry.scope === scope && entry.contentId === contentId)) {
    throw new Error(`${label} must be represented in AlphaVerticalProofManifestV02.contentHashes`);
  }
}

function alphaVerticalProofHashScopeForArtifactKindV02(
  kind: AlphaVerticalProofArtifactKindV02,
): AlphaVerticalProofHashScopeV02 {
  switch (kind) {
    case "public_fixture_manifest":
      return "public_fixture_manifest";
    case "bridge_bundle":
      return "bridge_bundle";
    case "patch_export":
      return "patch_export";
    case "patch_result":
      return "patch_result";
    case "delta_package":
      return "delta_package";
    case "runtime_report":
      return "runtime_report";
    case "finding_report":
      return "finding_report";
    case "benchmark_report":
      return "benchmark_report";
  }
}

function assertContractFixtureManifestEntryV02(
  value: unknown,
  label: string,
): asserts value is ContractFixtureManifestEntryV02 {
  const fixture = asRecord(value, label);
  assertEnum(fixture.kind, CONTRACT_FIXTURE_KINDS_V02, `${label}.kind`);
  assertContractFixturePathV02(fixture.path, `${label}.path`);
  assertString(fixture.description, `${label}.description`);
}

function assertInvalidContractFixtureManifestEntryV02(
  value: unknown,
  label: string,
): asserts value is InvalidContractFixtureManifestEntryV02 {
  assertContractFixtureManifestEntryV02(value, label);
  const fixture = asRecord(value, label);
  assertString(fixture.expectedSemanticError, `${label}.expectedSemanticError`);
}

function assertContractCompatibilityCoverageV02(
  value: unknown,
  label: string,
): asserts value is ContractCompatibilityCoverageV02 {
  const coverage = asRecord(value, label);
  assertEnum(coverage.kind, CONTRACT_FIXTURE_KINDS_V02, `${label}.kind`);
  assertString(coverage.typescriptValidator, `${label}.typescriptValidator`);
  assertString(coverage.rustValidator, `${label}.rustValidator`);
  assertFixturePathArrayV02(coverage.validFixtures, `${label}.validFixtures`, true);
  assertFixturePathArrayV02(coverage.invalidFixtures, `${label}.invalidFixtures`, false);
  assertEnum(coverage.status, CONTRACT_COMPATIBILITY_STATUSES_V02, `${label}.status`);
}

function assertFixturePathArrayV02(value: unknown, label: string, requireNonEmpty: boolean): void {
  const paths = asArray(value, label);
  if (requireNonEmpty && paths.length === 0) {
    throw new Error(`${label} must contain at least one fixture path`);
  }
  for (const [index, path] of paths.entries()) {
    assertContractFixturePathV02(path, `${label}[${index}]`);
  }
}

function assertContractFixturePathV02(value: unknown, label: string): asserts value is string {
  assertString(value, label);
  if (!value.startsWith("./")) {
    throw new Error(`${label} must be a relative fixture path starting with ./`);
  }
  assertPortableArtifactUriV02(value, label);
  if (value.includes("..") || value.includes("//") || !value.endsWith(".json")) {
    throw new Error(`${label} must be a normalized JSON fixture path`);
  }
}

function assertUniqueFixturePathV02(path: string, label: string, seenPaths: Set<string>): void {
  if (seenPaths.has(path)) {
    throw new Error(`${label}.path must be unique within the contract fixture manifest`);
  }
  seenPaths.add(path);
}

function assertCommandTokensV02(value: unknown, label: string): asserts value is string[] {
  const tokens = asArray(value, label);
  if (tokens.length === 0) {
    throw new Error(`${label} must contain at least one command token`);
  }
  for (const [index, token] of tokens.entries()) {
    assertString(token, `${label}[${index}]`);
  }
}

function assertEnumArrayV02<T extends string>(
  value: unknown,
  allowedValues: readonly T[],
  label: string,
): T[] {
  const array = asArray(value, label);
  return array.map((entry, index) => {
    assertEnum(entry, allowedValues, `${label}[${index}]`);
    return entry;
  });
}

function assertExactStringSetV02(
  values: readonly string[],
  expectedValues: readonly string[],
  label: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`${label} must not contain duplicate value ${value}`);
    }
    seen.add(value);
  }
  for (const expectedValue of expectedValues) {
    if (!seen.has(expectedValue)) {
      throw new Error(`${label} must include ${expectedValue}`);
    }
  }
  for (const value of seen) {
    if (!expectedValues.includes(value)) {
      throw new Error(`${label} contains unsupported value ${value}`);
    }
  }
}

function assertExtractor(value: unknown, label: string): void {
  const extractor = asRecord(value, label);
  assertString(extractor.name, `${label}.name`);
  assertString(extractor.version, `${label}.version`);
}

function assertAllowedKeysV02(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string,
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new Error(`${label}.${key} is not allowed`);
    }
  }
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

function assertPublicFixtureIdV02(value: unknown, label: string): asserts value is string {
  assertString(value, label);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(value)) {
    throw new Error(`${label} must be a public fixture id`);
  }
}

function assertNonBlankString(value: unknown, label: string): asserts value is string {
  assertString(value, label);
  if (value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function isBlankString(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
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

function assertRfc3339Instant(value: unknown, label: string): asserts value is string {
  assertString(value, label);
  const match = RFC3339_INSTANT_PATTERN.exec(value);
  if (match === null) {
    throw new Error(`${label} must be a valid RFC3339 timestamp instant`);
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (offsetText === undefined) {
    throw new Error(`${label} must be a valid RFC3339 timestamp instant`);
  }
  if (
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    !isValidCalendarDate(year, month, day)
  ) {
    throw new Error(`${label} must be a valid RFC3339 timestamp instant`);
  }
  if (offsetText !== "Z") {
    const offsetHour = Number(offsetText.slice(1, 3));
    const offsetMinute = Number(offsetText.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) {
      throw new Error(`${label} must be a valid RFC3339 timestamp instant`);
    }
  }
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a valid RFC3339 timestamp instant`);
  }
}

function assertOptionalRfc3339Instant(
  value: unknown,
  label: string,
): asserts value is string | undefined {
  if (value !== undefined) {
    assertRfc3339Instant(value, label);
  }
}

function assertStartedCompletedInstantsV02(
  startedAt: unknown,
  completedAt: unknown,
  label: string,
): void {
  assertRfc3339Instant(startedAt, `${label}.startedAt`);
  assertOptionalRfc3339Instant(completedAt, `${label}.completedAt`);
  if (completedAt !== undefined && Date.parse(completedAt) < Date.parse(startedAt)) {
    throw new Error(`${label}.completedAt must not be before ${label}.startedAt`);
  }
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= (daysInMonth[month - 1] ?? 0);
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
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

function assertUniqueNonEmptyStringArrayV02(value: unknown, label: string): string[] {
  const array = asArray(value, label);
  if (array.length === 0) {
    throw new Error(`${label} must contain at least one value`);
  }
  const seen = new Set<string>();
  const strings: string[] = [];
  for (const [index, item] of array.entries()) {
    assertString(item, `${label}[${index}]`);
    if (seen.has(item)) {
      throw new Error(`${label}[${index}] must not duplicate ${item}`);
    }
    seen.add(item);
    strings.push(item);
  }
  return strings;
}

function assertUuid7Array(value: unknown, label: string): asserts value is Uuid7[] {
  const array = asArray(value, label);
  for (const [index, item] of array.entries()) {
    assertUuid7(item, `${label}[${index}]`);
  }
}

function assertUniqueUuid7ArrayV02(value: unknown, label: string): Uuid7[] {
  const array = asArray(value, label);
  const seen = new Set<Uuid7>();
  const ids: Uuid7[] = [];
  for (const [index, item] of array.entries()) {
    assertUuid7(item, `${label}[${index}]`);
    if (seen.has(item)) {
      throw new Error(`${label}[${index}] must not duplicate ${item}`);
    }
    seen.add(item);
    ids.push(item);
  }
  return ids;
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

function assertOptionalNonNegativeInteger(
  value: unknown,
  label: string,
): asserts value is number | undefined {
  if (value !== undefined) {
    assertNonNegativeInteger(value, label);
  }
}

function assertNonNegativeNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
}

function assertNumberWithinTolerance(
  value: number,
  expected: number,
  tolerance: number,
  label: string,
  expectation: string,
): void {
  if (Math.abs(value - expected) > tolerance) {
    throw new Error(`${label} must match ${expectation}`);
  }
}

function assertRatio(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a number between 0 and 1`);
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

function assertNoRawPrivateOrSecretFieldsV02(value: unknown, label: string): void {
  if (typeof value !== "object" || value === null) {
    if (typeof value === "string" && value.includes("fixtures/private-local/")) {
      throw new Error(`${label} must not reference fixtures/private-local`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertNoRawPrivateOrSecretFieldsV02(item, `${label}[${index}]`);
    }
    return;
  }
  const forbiddenKeys = new Set([
    "authorization",
    "apiKey",
    "api_key",
    "bearer",
    "completionText",
    "completion_text",
    "password",
    "privateKey",
    "private_key",
    "promptText",
    "prompt_text",
    "rawContent",
    "raw_content",
    "rawPrivateData",
    "raw_private_data",
    "rawText",
    "raw_text",
    "requestBody",
    "request_body",
    "responseBody",
    "response_body",
    "secret",
  ]);
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) {
      throw new Error(`${label}.${key} is not allowed; record ids, hashes, or artifact refs`);
    }
    assertNoRawPrivateOrSecretFieldsV02(child, `${label}.${key}`);
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
