use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};

use crate::{
    BRIDGE_SCHEMA_VERSION_V02, BridgeBundleV02, BridgeContractResult, BridgeContractValidationError,
};

mod asset_policy;
mod benchmark;
mod fixture_validation;
mod observation_hooks;
mod patch;
mod runtime;
mod runtime_capability;
mod runtime_evidence_events;
mod triage;
mod validation_helpers;
mod validation_helpers_ext;

use observation_hooks::*;
use runtime_capability::*;
use runtime_evidence_events::*;
use validation_helpers::*;
use validation_helpers_ext::*;

pub use asset_policy::validate_asset_policy_bundle_v02;
pub use benchmark::validate_benchmark_report_v02;
pub use fixture_validation::{
    validate_alpha_vertical_proof_manifest_v02, validate_contract_compatibility_report_v02,
    validate_contract_fixture_manifest_v02,
};
pub use patch::{
    validate_patch_export_v02, validate_patch_failure_v02,
    validate_patch_partial_write_accounting_v02_pub, validate_patch_result_v02,
    validate_patch_source_compatibility_v02,
};
pub use runtime::validate_runtime_evidence_report_v02;
pub use triage::{validate_finding_record_fixture_v02, validate_triage_bundle_v02};
pub use validation_helpers::validate_rfc3339_instant;

const CONTRACT_FIXTURE_KINDS_V02: &[&str] = &[
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
];

const ITOTORI_PERMISSION_VALUES_V02: &[&str] = &[
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
];

const ALPHA_VERTICAL_PROOF_ARTIFACT_KINDS_V02: &[&str] = &[
    "public_fixture_manifest",
    "bridge_bundle",
    "patch_export",
    "patch_result",
    "delta_package",
    "runtime_report",
    "finding_report",
    "benchmark_report",
];

const ALPHA_VERTICAL_PROOF_HASH_SCOPES_V02: &[&str] = &[
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
];

const PATCH_WRITE_MODES: &[&str] = &[
    "replace",
    "insert",
    "update_region",
    "replace_asset",
    "metadata",
];

pub const PATCH_FAILURE_CATEGORIES_V02: &[&str] = &[
    "source_incompatible",
    "patch_write_failed",
    "protected_span_violation",
    "asset_missing",
    "adapter_unsupported",
    "output_hash_mismatch",
];

pub const PATCH_PARTIAL_WRITE_DISPOSITIONS_V02: &[&str] =
    &["rolled_back", "cleaned_up", "retained_partial"];

/// UNIV-011 — property-test thresholds for `crates/kaifuu-core/tests/property.rs`.
/// The proptest suite for patch compatibility and protected-span preservation
/// is pinned to these PUBLIC, reproducible ChaCha seeds and BOUNDED case
/// counts. Fixing the seed makes each property run deterministic in CI (and any
/// counterexample reproduces from a committed seed rather than a random one);
/// the case counts bound wall-clock cost while still exercising a wide sample
/// of generated inputs. The seed bytes are arbitrary public constants, not
/// secrets. Keep these in sync with the documentation in the property test
/// module; changing a value is a deliberate, reviewable adjustment of the bar.
pub mod proptest_thresholds {
    /// Fixed public ChaCha seed for the protected-span-preservation property.
    pub const PROTECTED_SPAN_PRESERVATION_SEED: [u8; 32] = [
        0x55, 0x4e, 0x49, 0x56, 0x2d, 0x30, 0x31, 0x31, 0x50, 0x53, 0x50, 0x52, 0x45, 0x53, 0x45,
        0x52, 0x56, 0x45, 0x53, 0x50, 0x41, 0x4e, 0x53, 0x45, 0x45, 0x44, 0x00, 0x01, 0x02, 0x03,
        0x04, 0x05,
    ];
    /// Bounded case count for the protected-span-preservation property.
    pub const PROTECTED_SPAN_PRESERVATION_CASES: u32 = 512;

    /// Fixed public ChaCha seed for the patch-compatibility property.
    pub const PATCH_COMPATIBILITY_SEED: [u8; 32] = [
        0x55, 0x4e, 0x49, 0x56, 0x2d, 0x30, 0x31, 0x31, 0x50, 0x41, 0x54, 0x43, 0x48, 0x43, 0x4f,
        0x4d, 0x50, 0x41, 0x54, 0x53, 0x45, 0x45, 0x44, 0x00, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b,
        0x0c, 0x0d,
    ];
    /// Bounded case count for the patch-compatibility property.
    pub const PATCH_COMPATIBILITY_CASES: u32 = 512;
}

const TRIAGE_SEVERITIES: &[&str] = &["P0", "P1", "P2", "P3"];
const RUNTIME_EVIDENCE_TIERS: &[&str] = &["E0", "E1", "E2", "E3", "E4"];
const RUNTIME_FIDELITY_TIERS: &[&str] = &[
    "trace_only",
    "layout_probe",
    "replay_review",
    "reference_fidelity",
];
const RUNTIME_CAPABILITY_CLASSES: &[&str] = &[
    "static_trace",
    "launch_capture",
    "instrumented_runtime",
    "partial_vm",
    "reference_vm",
];
const RUNTIME_PLAYBACK_FEATURES: &[&str] = &[
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
];
const RUNTIME_FEATURE_STATUSES: &[&str] = &["supported", "partial", "unsupported"];
const OBSERVATION_HOOK_SCHEMA_VERSION: &str = "0.1.0-alpha";
const OBSERVATION_HOOK_EVENT_KINDS: &[&str] =
    &["text", "choice", "branch", "scene", "frame", "error"];
const OBSERVATION_REDACTION_STATUSES: &[&str] = &["not_required", "redacted"];
const RUNTIME_REQUESTED_OPERATIONS: &[&str] =
    &["trace", "branch_discovery", "capture", "smoke_validation"];

const LOCALIZATION_QUALITY_CATEGORIES: &[&str] = &[
    "accuracy",
    "terminology",
    "style",
    "tone_register",
    "locale_convention",
    "protected_content",
    "layout",
    "technical_integrity",
];

const LOCALIZATION_QUALITY_SEVERITIES: &[&str] = &["critical", "major", "minor", "neutral"];

const LOCALIZATION_ROOT_CAUSES: &[&str] = &[
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
];

const QUALITY_DETECTOR_KINDS: &[&str] = &[
    "deterministic_qa",
    "llm_qa",
    "human_review",
    "runtime_probe",
    "seeded_defect_oracle",
    "patch_verify",
    "schema_guard",
];

type SystemScopedUuidRefs = HashMap<String, HashSet<String>>;

struct QaAgentEvaluationRefs {
    provider_run_ids: SystemScopedUuidRefs,
    finding_ids: SystemScopedUuidRefs,
}

const LOCALIZATION_ADJUDICATION_STATES: &[&str] = &[
    "unreviewed",
    "confirmed",
    "rejected_false_positive",
    "duplicate",
    "needs_more_context",
    "intentional_or_accepted",
    "fixed_verified",
];

#[derive(Debug, Clone)]
struct AssetSummary {
    asset_key: String,
    asset_kind: String,
    source_revision_id: String,
    source_revision_value: String,
}

pub fn validate_shared_contract_fixture_v02(kind: &str, value: &Value) -> BridgeContractResult<()> {
    assert_one_of(kind, CONTRACT_FIXTURE_KINDS_V02, "ContractFixtureV02.kind")?;
    match kind {
        "alpha-vertical-proof-manifest-v0.2" => validate_alpha_vertical_proof_manifest_v02(value),
        "asset-policy-v0.2" => validate_asset_policy_bundle_v02(value),
        "benchmark-report-v0.2" => validate_benchmark_report_v02(value),
        "bridge-v0.2" => BridgeBundleV02::validate_json(value).map(|_| ()),
        "contract-compatibility-v0.2" => validate_contract_compatibility_report_v02(value),
        "contract-fixtures-v0.2" => validate_contract_fixture_manifest_v02(value),
        "delta-package-v0.2" => validate_delta_package_metadata_v02(value),
        "finding-v0.2" => validate_finding_record_fixture_v02(value),
        "patch-export-v0.2" => validate_patch_export_v02(value),
        "patch-result-v0.2" => validate_patch_result_v02(value),
        "permission-local-user-v0.2" => validate_permission_local_user_fixture_v02(value),
        "runtime-evidence-v0.2" => validate_runtime_evidence_report_v02(value),
        "triage-v0.2" => validate_triage_bundle_v02(value),
        _ => unreachable!(),
    }
}

pub fn validate_delta_package_metadata_v02(value: &Value) -> BridgeContractResult<()> {
    let metadata = as_record(value, "DeltaPackageMetadataV02")?;
    assert_schema_version(metadata, "DeltaPackageMetadataV02")?;
    assert_required_uuid7(
        metadata,
        "deltaPackageId",
        "DeltaPackageMetadataV02.deltaPackageId",
    )?;
    assert_required_uuid7(
        metadata,
        "sourceBridgeId",
        "DeltaPackageMetadataV02.sourceBridgeId",
    )?;
    validate_source_game_revision(
        required(metadata, "sourceGame", "DeltaPackageMetadataV02.sourceGame")?,
        "DeltaPackageMetadataV02.sourceGame",
    )?;
    let source_bundle_hash = assert_required_hash(
        metadata,
        "sourceBundleHash",
        "DeltaPackageMetadataV02.sourceBundleHash",
    )?;
    validate_source_revision(
        required(
            metadata,
            "sourceBundleRevision",
            "DeltaPackageMetadataV02.sourceBundleRevision",
        )?,
        "DeltaPackageMetadataV02.sourceBundleRevision",
    )?;
    assert_revision_hash_matches(
        required(
            metadata,
            "sourceBundleRevision",
            "DeltaPackageMetadataV02.sourceBundleRevision",
        )?,
        source_bundle_hash,
        "DeltaPackageMetadataV02.sourceBundleRevision",
    )?;
    assert_required_uuid7(
        metadata,
        "generatedPatchExportId",
        "DeltaPackageMetadataV02.generatedPatchExportId",
    )?;
    assert_required_hash(
        metadata,
        "generatedPatchExportHash",
        "DeltaPackageMetadataV02.generatedPatchExportHash",
    )?;
    assert_required_string(
        metadata,
        "targetLocale",
        "DeltaPackageMetadataV02.targetLocale",
    )?;
    validate_hash_strategy(
        required(
            metadata,
            "hashStrategy",
            "DeltaPackageMetadataV02.hashStrategy",
        )?,
        "DeltaPackageMetadataV02.hashStrategy",
    )?;
    if let Some(created_at) = metadata.get("createdAt") {
        assert_rfc3339_value(created_at, "DeltaPackageMetadataV02.createdAt")?;
    }
    Ok(())
}

pub fn validate_permission_local_user_fixture_v02(value: &Value) -> BridgeContractResult<()> {
    let fixture = as_record(value, "PermissionLocalUserFixtureV02")?;
    assert_schema_version(fixture, "PermissionLocalUserFixtureV02")?;
    assert_required_uuid7(
        fixture,
        "permissionFixtureId",
        "PermissionLocalUserFixtureV02.permissionFixtureId",
    )?;
    let user = required_record(fixture, "user", "PermissionLocalUserFixtureV02.user")?;
    let user_id =
        assert_required_string(user, "userId", "PermissionLocalUserFixtureV02.user.userId")?;
    if user_id != "local-user" {
        return error("PermissionLocalUserFixtureV02.user.userId must be local-user");
    }
    let display_name = assert_required_string(
        user,
        "displayName",
        "PermissionLocalUserFixtureV02.user.displayName",
    )?;
    if display_name != "Local user" {
        return error("PermissionLocalUserFixtureV02.user.displayName must be Local user");
    }

    let grants = required_array(fixture, "grants", "PermissionLocalUserFixtureV02.grants")?;
    let mut seen = HashSet::new();
    for (index, grant) in grants.iter().enumerate() {
        let grant = string_value(
            grant,
            &format!("PermissionLocalUserFixtureV02.grants[{index}]"),
        )?;
        assert_one_of(
            grant,
            ITOTORI_PERMISSION_VALUES_V02,
            &format!("PermissionLocalUserFixtureV02.grants[{index}]"),
        )?;
        if !seen.insert(grant.to_string()) {
            return error(format!(
                "PermissionLocalUserFixtureV02.grants must not duplicate {grant}"
            ));
        }
    }
    assert_exact_string_set(
        &seen,
        ITOTORI_PERMISSION_VALUES_V02,
        "PermissionLocalUserFixtureV02.grants",
    )?;
    assert_string_array(
        required(
            fixture,
            "compatibilityNotes",
            "PermissionLocalUserFixtureV02.compatibilityNotes",
        )?,
        "PermissionLocalUserFixtureV02.compatibilityNotes",
    )?;
    Ok(())
}

fn validate_source_game_revision(value: &Value, label: &str) -> BridgeContractResult<()> {
    let source_game = as_record(value, label)?;
    assert_required_string(source_game, "gameId", &format!("{label}.gameId"))?;
    assert_required_string(source_game, "gameVersion", &format!("{label}.gameVersion"))?;
    assert_required_string(
        source_game,
        "sourceProfileId",
        &format!("{label}.sourceProfileId"),
    )?;
    validate_source_revision(
        required(
            source_game,
            "sourceProfileRevision",
            &format!("{label}.sourceProfileRevision"),
        )?,
        &format!("{label}.sourceProfileRevision"),
    )
}

fn validate_source_revision(value: &Value, label: &str) -> BridgeContractResult<()> {
    let revision = as_record(value, label)?;
    assert_required_uuid7(revision, "revisionId", &format!("{label}.revisionId"))?;
    let revision_kind = assert_required_one_of(
        revision,
        "revisionKind",
        &["content_hash", "source_control", "build", "manual_snapshot"],
        &format!("{label}.revisionKind"),
    )?;
    let value = assert_required_string(revision, "value", &format!("{label}.value"))?;
    if revision_kind == "content_hash" {
        assert_hash(value, &format!("{label}.value"))?;
    }
    if let Some(created_at) = revision.get("createdAt") {
        assert_rfc3339_value(created_at, &format!("{label}.createdAt"))?;
    }
    Ok(())
}

fn validate_hash_strategy(value: &Value, label: &str) -> BridgeContractResult<()> {
    let strategy = as_record(value, label)?;
    validate_hash_rule(
        required(strategy, "sourceProfile", &format!("{label}.sourceProfile"))?,
        &format!("{label}.sourceProfile"),
        "source_profile",
        "utf8-lf-json-stable-v1",
        false,
    )?;
    validate_hash_rule(
        required(strategy, "sourceBundle", &format!("{label}.sourceBundle"))?,
        &format!("{label}.sourceBundle"),
        "source_bundle",
        "utf8-lf-json-stable-v1",
        false,
    )?;
    validate_hash_rule(
        required(strategy, "sourceAsset", &format!("{label}.sourceAsset"))?,
        &format!("{label}.sourceAsset"),
        "source_asset",
        "bytes",
        false,
    )?;
    validate_hash_rule(
        required(strategy, "sourceUnit", &format!("{label}.sourceUnit"))?,
        &format!("{label}.sourceUnit"),
        "source_unit",
        "utf8-lf-json-stable-v1",
        true,
    )?;
    validate_hash_rule(
        required(strategy, "patchExport", &format!("{label}.patchExport"))?,
        &format!("{label}.patchExport"),
        "patch_export",
        "utf8-lf-json-stable-v1",
        false,
    )?;
    validate_hash_rule(
        required(strategy, "deltaPackage", &format!("{label}.deltaPackage"))?,
        &format!("{label}.deltaPackage"),
        "delta_package",
        "utf8-lf-json-stable-v1",
        false,
    )
}

fn validate_hash_rule(
    value: &Value,
    label: &str,
    expected_scope: &str,
    expected_normalization: &str,
    require_fields: bool,
) -> BridgeContractResult<()> {
    let rule = as_record(value, label)?;
    assert_literal(rule, "scope", expected_scope, &format!("{label}.scope"))?;
    assert_literal(rule, "algorithm", "sha256", &format!("{label}.algorithm"))?;
    assert_literal(
        rule,
        "normalization",
        expected_normalization,
        &format!("{label}.normalization"),
    )?;
    if let Some(fields) = rule.get("fields") {
        let fields = array_value(fields, &format!("{label}.fields"))?;
        for (index, field) in fields.iter().enumerate() {
            string_value(field, &format!("{label}.fields[{index}]"))?;
        }
        if require_fields && fields.is_empty() {
            return error(format!("{label}.fields must not be empty"));
        }
    } else if require_fields {
        return error(format!("{label}.fields must not be empty"));
    }
    Ok(())
}

fn validate_triage_subject_refs(value: &Value, label: &str) -> BridgeContractResult<()> {
    let refs = array_value(value, label)?;
    for (index, subject_ref) in refs.iter().enumerate() {
        let ref_label = format!("{label}[{index}]");
        let subject_ref = as_record(subject_ref, &ref_label)?;
        assert_required_one_of(
            subject_ref,
            "subjectKind",
            &[
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
            ],
            &format!("{ref_label}.subjectKind"),
        )?;
        assert_required_uuid7(subject_ref, "subjectId", &format!("{ref_label}.subjectId"))?;
        if let Some(label_value) = subject_ref.get("label") {
            string_value(label_value, &format!("{ref_label}.label"))?;
        }
    }
    Ok(())
}

fn validate_asset_ref(value: &Value, label: &str) -> BridgeContractResult<()> {
    let asset_ref = as_record(value, label)?;
    assert_required_uuid7(asset_ref, "assetId", &format!("{label}.assetId"))?;
    if let Some(asset_key) = asset_ref.get("assetKey") {
        string_value(asset_key, &format!("{label}.assetKey"))?;
    }
    Ok(())
}

fn assert_revision_matches_summary(
    value: &Value,
    asset: &AssetSummary,
    label: &str,
) -> BridgeContractResult<()> {
    let revision = as_record(value, label)?;
    if string_field(revision, "revisionId")? != asset.source_revision_id
        || string_field(revision, "value")? != asset.source_revision_value
    {
        return error(format!(
            "{label} must match the referenced source asset revision"
        ));
    }
    Ok(())
}

fn assert_revision_hash_matches(
    value: &Value,
    hash: &str,
    label: &str,
) -> BridgeContractResult<()> {
    let revision = as_record(value, label)?;
    if string_field(revision, "revisionKind")? == "content_hash"
        && string_field(revision, "value")? != hash
    {
        return error(format!(
            "{label}.value must equal the matching content hash"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
