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

export const LOCALIZATION_QUALITY_SEVERITY_WEIGHTS: Record<LocalizationQualitySeverityV02, number> =
  {
    critical: 25,
    major: 5,
    minor: 1,
    neutral: 0,
  };

export const BENCHMARK_NORMALIZED_PENALTY_TOLERANCE = 0.01;
export const RFC3339_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Shared cross-language semantic code emitted when a contract field is not a
 * valid RFC3339 date-time instant. The Rust contract validator emits the
 * identical code (`SEMANTIC_RFC3339_INSTANT_MALFORMED` in
 * `crates/kaifuu-core/src/semantics.rs`). See
 * `docs/contracts/rfc3339-instant-acceptance.md`.
 */
export const RFC3339_INSTANT_MALFORMED_CODE = "itotori.contract.rfc3339_instant_malformed";

/**
 * Typed rejection for a malformed RFC3339 date-time instant. Carries a stable
 * {@link RFC3339_INSTANT_MALFORMED_CODE} so callers branch on a named semantic
 * failure rather than parsing the human-readable message.
 */
export class Rfc3339InstantValidationError extends Error {
  readonly code = RFC3339_INSTANT_MALFORMED_CODE;
  readonly value: unknown;

  constructor(label: string, value: unknown) {
    super(`${label} must be a valid RFC3339 timestamp instant`);
    this.name = "Rfc3339InstantValidationError";
    this.value = value;
  }
}

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

// NOTE: estimate/unknown kinds (provider_estimate, local_estimate, unknown)
// apply ONLY to externally-benchmarked systems whose cost is genuinely
// unknowable (e.g. third-party MTL services, local tools) — never to
// itotori's own OpenRouter spend, which is always exact billed cost.
// itotori spend is purged of these sentinels and must never
// be approximated.
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

export const HASH_NORMALIZATIONS = ["utf8-lf-json-stable-v1", "bytes"] as const;
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

export const PERMISSION_VALUES_V02 = [
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
export type ItotoriPermissionV02 = (typeof PERMISSION_VALUES_V02)[number];

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

export const SPEAKER_REVEAL_STATES = ["revealed", "concealed"] as const;

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
