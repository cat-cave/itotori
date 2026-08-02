export type Uuid7 = string;
export type Bcp47Locale = string;

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

// Capability-leveled engine detector registry.
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
 * count — that is the whole point of the capability-ladder strict gate.
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

export const TEXTLESS_ASSET_POLICY_SURFACE_KINDS: readonly AssetPolicySurfaceKindV02[] = [
  "ui_art",
  "font",
  "video",
];
export const REGION_PATCH_ASSET_KINDS: readonly AssetKindV02[] = ["image", "video", "ui_texture"];

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
