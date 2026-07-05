use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};

use crate::{
    BRIDGE_SCHEMA_VERSION_V02, BridgeBundleV02, BridgeContractResult, BridgeContractValidationError,
};

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

pub fn validate_alpha_vertical_proof_manifest_v02(value: &Value) -> BridgeContractResult<()> {
    assert_no_confidence_fields(value, "AlphaVerticalProofManifestV02")?;
    assert_no_raw_private_or_secret_fields(value, "AlphaVerticalProofManifestV02")?;
    let manifest = as_record(value, "AlphaVerticalProofManifestV02")?;
    assert_record_keys(
        manifest,
        &[
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
    )?;
    assert_schema_version(manifest, "AlphaVerticalProofManifestV02")?;
    assert_required_uuid7(
        manifest,
        "proofManifestId",
        "AlphaVerticalProofManifestV02.proofManifestId",
    )?;
    assert_required_rfc3339(
        manifest,
        "createdAt",
        "AlphaVerticalProofManifestV02.createdAt",
    )?;

    let fixture = required_record(manifest, "fixture", "AlphaVerticalProofManifestV02.fixture")?;
    assert_record_keys(
        fixture,
        &[
            "fixtureId",
            "publicManifestUri",
            "publicManifestHash",
            "publicRedistribution",
        ],
        "AlphaVerticalProofManifestV02.fixture",
    )?;
    let fixture_id = assert_required_string(
        fixture,
        "fixtureId",
        "AlphaVerticalProofManifestV02.fixture.fixtureId",
    )?;
    assert_public_fixture_id(
        fixture_id,
        "AlphaVerticalProofManifestV02.fixture.fixtureId",
    )?;
    assert_required_public_uri(
        fixture,
        "publicManifestUri",
        "AlphaVerticalProofManifestV02.fixture.publicManifestUri",
    )?;
    let fixture_public_manifest_uri = assert_required_string(
        fixture,
        "publicManifestUri",
        "AlphaVerticalProofManifestV02.fixture.publicManifestUri",
    )?;
    let fixture_public_manifest_hash = assert_required_hash(
        fixture,
        "publicManifestHash",
        "AlphaVerticalProofManifestV02.fixture.publicManifestHash",
    )?;
    assert_literal(
        fixture,
        "publicRedistribution",
        "allowed",
        "AlphaVerticalProofManifestV02.fixture.publicRedistribution",
    )?;

    let engine_profile = required_record(
        manifest,
        "engineProfile",
        "AlphaVerticalProofManifestV02.engineProfile",
    )?;
    assert_record_keys(
        engine_profile,
        &[
            "engineProfileId",
            "engineKind",
            "kaifuuProfileId",
            "itotoriWorkflowId",
            "utsushiRuntimeProfileId",
        ],
        "AlphaVerticalProofManifestV02.engineProfile",
    )?;
    for key in [
        "engineProfileId",
        "engineKind",
        "kaifuuProfileId",
        "itotoriWorkflowId",
        "utsushiRuntimeProfileId",
    ] {
        assert_required_string(
            engine_profile,
            key,
            &format!("AlphaVerticalProofManifestV02.engineProfile.{key}"),
        )?;
    }

    validate_source_revision(
        required(
            manifest,
            "sourceRevision",
            "AlphaVerticalProofManifestV02.sourceRevision",
        )?,
        "AlphaVerticalProofManifestV02.sourceRevision",
    )?;
    let source_revision = required_record(
        manifest,
        "sourceRevision",
        "AlphaVerticalProofManifestV02.sourceRevision",
    )?;
    let source_bundle_hash = assert_required_hash(
        manifest,
        "sourceBundleHash",
        "AlphaVerticalProofManifestV02.sourceBundleHash",
    )?;
    if source_revision.get("revisionKind").and_then(Value::as_str) == Some("content_hash")
        && source_revision.get("value").and_then(Value::as_str) != Some(source_bundle_hash)
    {
        return error(
            "AlphaVerticalProofManifestV02.sourceRevision.value must equal the matching content hash",
        );
    }
    assert_required_uuid7(
        manifest,
        "sourceBridgeId",
        "AlphaVerticalProofManifestV02.sourceBridgeId",
    )?;

    let bridge_unit_refs = required_array(
        manifest,
        "bridgeUnitRefs",
        "AlphaVerticalProofManifestV02.bridgeUnitRefs",
    )?;
    if bridge_unit_refs.is_empty() {
        return error("AlphaVerticalProofManifestV02.bridgeUnitRefs must contain at least one ref");
    }
    let mut bridge_unit_keys = HashSet::new();
    let mut bridge_unit_hashes = Vec::new();
    for (index, bridge_unit_ref) in bridge_unit_refs.iter().enumerate() {
        let label = format!("AlphaVerticalProofManifestV02.bridgeUnitRefs[{index}]");
        let bridge_unit_ref = as_record(bridge_unit_ref, &label)?;
        assert_record_keys(
            bridge_unit_ref,
            &["bridgeUnitId", "sourceUnitKey", "sourceHash"],
            &label,
        )?;
        let bridge_unit_id = assert_required_uuid7(
            bridge_unit_ref,
            "bridgeUnitId",
            &format!("{label}.bridgeUnitId"),
        )?;
        let source_unit_key = assert_required_string(
            bridge_unit_ref,
            "sourceUnitKey",
            &format!("{label}.sourceUnitKey"),
        )?;
        let source_hash = assert_required_hash(
            bridge_unit_ref,
            "sourceHash",
            &format!("{label}.sourceHash"),
        )?;
        let key = format!("{bridge_unit_id}\0{source_unit_key}");
        if !bridge_unit_keys.insert(key) {
            return error(format!(
                "{label} must be unique by bridgeUnitId and sourceUnitKey"
            ));
        }
        bridge_unit_hashes.push((label, bridge_unit_id.to_string(), source_hash.to_string()));
    }

    let runtime_target_ids = required_array(
        manifest,
        "runtimeTargetIds",
        "AlphaVerticalProofManifestV02.runtimeTargetIds",
    )?;
    if runtime_target_ids.is_empty() {
        return error(
            "AlphaVerticalProofManifestV02.runtimeTargetIds must contain at least one value",
        );
    }
    let mut runtime_targets = HashSet::new();
    for (index, runtime_target_id) in runtime_target_ids.iter().enumerate() {
        let runtime_target_id = string_value(
            runtime_target_id,
            &format!("AlphaVerticalProofManifestV02.runtimeTargetIds[{index}]"),
        )?;
        if !runtime_targets.insert(runtime_target_id.to_string()) {
            return error(format!(
                "AlphaVerticalProofManifestV02.runtimeTargetIds[{index}] must not duplicate {runtime_target_id}"
            ));
        }
    }

    let artifact_refs = required_record(
        manifest,
        "artifactRefs",
        "AlphaVerticalProofManifestV02.artifactRefs",
    )?;
    assert_record_keys(
        artifact_refs,
        &[
            "publicFixtureManifest",
            "bridgeBundle",
            "patchExport",
            "patchResult",
            "deltaPackage",
            "runtimeReport",
            "findingReport",
            "benchmarkReport",
        ],
        "AlphaVerticalProofManifestV02.artifactRefs",
    )?;
    let mut artifact_hashes = Vec::new();
    for (field, kind) in [
        ("publicFixtureManifest", "public_fixture_manifest"),
        ("bridgeBundle", "bridge_bundle"),
        ("patchExport", "patch_export"),
        ("patchResult", "patch_result"),
        ("deltaPackage", "delta_package"),
        ("runtimeReport", "runtime_report"),
        ("benchmarkReport", "benchmark_report"),
    ] {
        artifact_hashes.push(validate_alpha_proof_artifact_ref(
            required(
                artifact_refs,
                field,
                &format!("AlphaVerticalProofManifestV02.artifactRefs.{field}"),
            )?,
            &format!("AlphaVerticalProofManifestV02.artifactRefs.{field}"),
            kind,
        )?);
    }
    if let Some(finding_report) = artifact_refs.get("findingReport") {
        artifact_hashes.push(validate_alpha_proof_artifact_ref(
            finding_report,
            "AlphaVerticalProofManifestV02.artifactRefs.findingReport",
            "finding_report",
        )?);
    }

    let provider_proof_ids = assert_uuid7_array(
        required(
            manifest,
            "providerProofIds",
            "AlphaVerticalProofManifestV02.providerProofIds",
        )?,
        "AlphaVerticalProofManifestV02.providerProofIds",
    )?;
    if provider_proof_ids.is_empty() {
        return error(
            "AlphaVerticalProofManifestV02.providerProofIds must contain at least one id",
        );
    }
    let mut provider_proof_id_set = HashSet::new();
    for (index, provider_proof_id) in provider_proof_ids.iter().enumerate() {
        if !provider_proof_id_set.insert(provider_proof_id.clone()) {
            return error(format!(
                "AlphaVerticalProofManifestV02.providerProofIds[{index}] must not duplicate {provider_proof_id}"
            ));
        }
    }

    let benchmark_output_refs = required_array(
        manifest,
        "benchmarkOutputRefs",
        "AlphaVerticalProofManifestV02.benchmarkOutputRefs",
    )?;
    if benchmark_output_refs.is_empty() {
        return error(
            "AlphaVerticalProofManifestV02.benchmarkOutputRefs must contain at least one ref",
        );
    }
    let mut benchmark_run_ids = HashSet::new();
    for (index, benchmark_output_ref) in benchmark_output_refs.iter().enumerate() {
        let label = format!("AlphaVerticalProofManifestV02.benchmarkOutputRefs[{index}]");
        let benchmark_output_ref = as_record(benchmark_output_ref, &label)?;
        assert_record_keys(
            benchmark_output_ref,
            &["benchmarkRunId", "artifactRef"],
            &label,
        )?;
        let benchmark_run_id = assert_required_uuid7(
            benchmark_output_ref,
            "benchmarkRunId",
            &format!("{label}.benchmarkRunId"),
        )?;
        if !benchmark_run_ids.insert(benchmark_run_id.to_string()) {
            return error(format!(
                "{label}.benchmarkRunId must be unique within benchmarkOutputRefs"
            ));
        }
        validate_alpha_proof_artifact_ref(
            required(
                benchmark_output_ref,
                "artifactRef",
                &format!("{label}.artifactRef"),
            )?,
            &format!("{label}.artifactRef"),
            "benchmark_report",
        )?;
    }

    let content_hashes = validate_alpha_proof_content_hashes(
        required(
            manifest,
            "contentHashes",
            "AlphaVerticalProofManifestV02.contentHashes",
        )?,
        "AlphaVerticalProofManifestV02.contentHashes",
    )?;
    for required_scope in [
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
    ] {
        if !content_hashes
            .iter()
            .any(|(scope, _content_id, _hash)| scope == required_scope)
        {
            return error(format!(
                "AlphaVerticalProofManifestV02.contentHashes must include {required_scope}"
            ));
        }
    }
    let public_fixture_manifest = required_record(
        artifact_refs,
        "publicFixtureManifest",
        "AlphaVerticalProofManifestV02.artifactRefs.publicFixtureManifest",
    )?;
    if public_fixture_manifest.get("uri").and_then(Value::as_str)
        != Some(fixture_public_manifest_uri)
    {
        return error(
            "AlphaVerticalProofManifestV02.fixture.publicManifestUri must match AlphaVerticalProofManifestV02.artifactRefs.publicFixtureManifest.uri",
        );
    }
    if public_fixture_manifest.get("hash").and_then(Value::as_str)
        != Some(fixture_public_manifest_hash)
    {
        return error(
            "AlphaVerticalProofManifestV02.fixture.publicManifestHash must match AlphaVerticalProofManifestV02.artifactRefs.publicFixtureManifest.hash",
        );
    }
    assert_alpha_hash_covered(
        &content_hashes,
        "source_bundle",
        &format!("{fixture_id}:source-bundle"),
        source_bundle_hash,
        "AlphaVerticalProofManifestV02.sourceBundleHash",
    )?;
    for (label, bridge_unit_id, source_hash) in bridge_unit_hashes {
        assert_alpha_hash_covered(
            &content_hashes,
            "bridge_unit",
            &bridge_unit_id,
            &source_hash,
            &format!("{label}.sourceHash"),
        )?;
    }
    for (index, provider_proof_id) in provider_proof_ids.iter().enumerate() {
        assert_alpha_hash_scope_content_id(
            &content_hashes,
            "provider_proof",
            provider_proof_id,
            &format!("AlphaVerticalProofManifestV02.providerProofIds[{index}]"),
        )?;
    }
    for (kind, uri, hash) in artifact_hashes {
        assert_alpha_hash_covered(
            &content_hashes,
            alpha_hash_scope_for_artifact_kind(&kind),
            &uri,
            &hash,
            &format!("AlphaVerticalProofManifestV02.artifactRefs.{kind}.hash"),
        )?;
    }
    assert_string_array(
        required(
            manifest,
            "compatibilityNotes",
            "AlphaVerticalProofManifestV02.compatibilityNotes",
        )?,
        "AlphaVerticalProofManifestV02.compatibilityNotes",
    )?;
    Ok(())
}

pub fn validate_contract_fixture_manifest_v02(value: &Value) -> BridgeContractResult<()> {
    let manifest = as_record(value, "ContractFixtureManifestV02")?;
    assert_schema_version(manifest, "ContractFixtureManifestV02")?;
    assert_required_uuid7(manifest, "suiteId", "ContractFixtureManifestV02.suiteId")?;
    assert_required_rfc3339(
        manifest,
        "generatedAt",
        "ContractFixtureManifestV02.generatedAt",
    )?;

    let valid_fixtures = required_array(
        manifest,
        "validFixtures",
        "ContractFixtureManifestV02.validFixtures",
    )?;
    let invalid_fixtures = required_array(
        manifest,
        "invalidFixtures",
        "ContractFixtureManifestV02.invalidFixtures",
    )?;
    let mut paths = HashSet::new();
    let mut valid_kinds = HashSet::new();

    for (index, fixture) in valid_fixtures.iter().enumerate() {
        let label = format!("ContractFixtureManifestV02.validFixtures[{index}]");
        let (kind, path) = validate_contract_fixture_manifest_entry(fixture, &label)?;
        valid_kinds.insert(kind);
        assert_unique_path(&mut paths, &path, &label)?;
    }
    for (index, fixture) in invalid_fixtures.iter().enumerate() {
        let label = format!("ContractFixtureManifestV02.invalidFixtures[{index}]");
        let (_kind, path) = validate_contract_fixture_manifest_entry(fixture, &label)?;
        assert_required_string(
            as_record(fixture, &label)?,
            "expectedSemanticError",
            &format!("{label}.expectedSemanticError"),
        )?;
        assert_unique_path(&mut paths, &path, &label)?;
    }
    assert_exact_string_set(
        &valid_kinds,
        CONTRACT_FIXTURE_KINDS_V02,
        "ContractFixtureManifestV02.validFixtures.kind",
    )
}

pub fn validate_contract_compatibility_report_v02(value: &Value) -> BridgeContractResult<()> {
    let report = as_record(value, "ContractCompatibilityReportV02")?;
    assert_schema_version(report, "ContractCompatibilityReportV02")?;
    assert_required_uuid7(
        report,
        "reportId",
        "ContractCompatibilityReportV02.reportId",
    )?;
    assert_required_rfc3339(
        report,
        "generatedAt",
        "ContractCompatibilityReportV02.generatedAt",
    )?;
    assert_fixture_path_value(
        required(
            report,
            "suiteManifestPath",
            "ContractCompatibilityReportV02.suiteManifestPath",
        )?,
        "ContractCompatibilityReportV02.suiteManifestPath",
    )?;
    assert_required_string(
        report,
        "sourceOfTruth",
        "ContractCompatibilityReportV02.sourceOfTruth",
    )?;
    assert_command_tokens(
        required(
            report,
            "typescriptCommand",
            "ContractCompatibilityReportV02.typescriptCommand",
        )?,
        "ContractCompatibilityReportV02.typescriptCommand",
    )?;
    assert_command_tokens(
        required(
            report,
            "rustCommand",
            "ContractCompatibilityReportV02.rustCommand",
        )?,
        "ContractCompatibilityReportV02.rustCommand",
    )?;
    let overall_status = assert_required_one_of(
        report,
        "overallStatus",
        &["compatible", "incompatible"],
        "ContractCompatibilityReportV02.overallStatus",
    )?;

    let coverage = required_array(
        report,
        "coverage",
        "ContractCompatibilityReportV02.coverage",
    )?;
    let mut covered_kinds = HashSet::new();
    for (index, entry) in coverage.iter().enumerate() {
        let label = format!("ContractCompatibilityReportV02.coverage[{index}]");
        let entry = as_record(entry, &label)?;
        let kind = assert_required_one_of(
            entry,
            "kind",
            CONTRACT_FIXTURE_KINDS_V02,
            &format!("{label}.kind"),
        )?;
        if !covered_kinds.insert(kind.to_string()) {
            return error(format!("{label}.kind must be unique within coverage"));
        }
        assert_required_string(
            entry,
            "typescriptValidator",
            &format!("{label}.typescriptValidator"),
        )?;
        assert_required_string(entry, "rustValidator", &format!("{label}.rustValidator"))?;
        assert_fixture_path_array(
            required(entry, "validFixtures", &format!("{label}.validFixtures"))?,
            &format!("{label}.validFixtures"),
            true,
        )?;
        assert_fixture_path_array(
            required(
                entry,
                "invalidFixtures",
                &format!("{label}.invalidFixtures"),
            )?,
            &format!("{label}.invalidFixtures"),
            false,
        )?;
        let status = assert_required_one_of(
            entry,
            "status",
            &["compatible", "incompatible"],
            &format!("{label}.status"),
        )?;
        if overall_status == "compatible" && status != "compatible" {
            return error(format!(
                "{label}.status must be compatible when overallStatus is compatible"
            ));
        }
    }
    assert_exact_string_set(
        &covered_kinds,
        CONTRACT_FIXTURE_KINDS_V02,
        "ContractCompatibilityReportV02.coverage.kind",
    )?;

    let cross_refs = required_array(
        report,
        "crossContractRefs",
        "ContractCompatibilityReportV02.crossContractRefs",
    )?;
    let mut has_local_user_ref = false;
    for (index, cross_ref) in cross_refs.iter().enumerate() {
        let label = format!("ContractCompatibilityReportV02.crossContractRefs[{index}]");
        let cross_ref = as_record(cross_ref, &label)?;
        let from = assert_required_string(cross_ref, "from", &format!("{label}.from"))?;
        assert_required_string(cross_ref, "to", &format!("{label}.to"))?;
        assert_required_string(cross_ref, "rule", &format!("{label}.rule"))?;
        if from == "./permission-local-user-v0.2.json" {
            has_local_user_ref = true;
        }
    }
    if !has_local_user_ref {
        return error(
            "ContractCompatibilityReportV02.crossContractRefs must document permission-local-user-v0.2.json",
        );
    }
    assert_string_array(
        required(report, "notes", "ContractCompatibilityReportV02.notes")?,
        "ContractCompatibilityReportV02.notes",
    )?;
    Ok(())
}

pub fn validate_patch_export_v02(value: &Value) -> BridgeContractResult<()> {
    let patch = as_record(value, "PatchExportV02")?;
    assert_schema_version(patch, "PatchExportV02")?;
    assert_required_uuid7(patch, "patchExportId", "PatchExportV02.patchExportId")?;
    assert_required_uuid7(patch, "sourceBridgeId", "PatchExportV02.sourceBridgeId")?;
    validate_source_game_revision(
        required(patch, "sourceGame", "PatchExportV02.sourceGame")?,
        "PatchExportV02.sourceGame",
    )?;
    let source_bundle_hash =
        assert_required_hash(patch, "sourceBundleHash", "PatchExportV02.sourceBundleHash")?;
    validate_source_revision(
        required(
            patch,
            "sourceBundleRevision",
            "PatchExportV02.sourceBundleRevision",
        )?,
        "PatchExportV02.sourceBundleRevision",
    )?;
    assert_revision_hash_matches(
        required(
            patch,
            "sourceBundleRevision",
            "PatchExportV02.sourceBundleRevision",
        )?,
        source_bundle_hash,
        "PatchExportV02.sourceBundleRevision",
    )?;
    assert_required_string(patch, "sourceLocale", "PatchExportV02.sourceLocale")?;
    assert_required_string(patch, "targetLocale", "PatchExportV02.targetLocale")?;
    validate_hash_strategy(
        required(patch, "hashStrategy", "PatchExportV02.hashStrategy")?,
        "PatchExportV02.hashStrategy",
    )?;
    if let Some(hash) = patch.get("patchExportHash") {
        assert_hash_value(hash, "PatchExportV02.patchExportHash")?;
    }
    if let Some(generated_at) = patch.get("generatedAt") {
        assert_rfc3339_value(generated_at, "PatchExportV02.generatedAt")?;
    }

    let entries = required_array(patch, "entries", "PatchExportV02.entries")?;
    let mut entry_keys = HashSet::new();
    for (index, entry) in entries.iter().enumerate() {
        let label = format!("PatchExportV02.entries[{index}]");
        let entry = as_record(entry, &label)?;
        assert_required_uuid7(entry, "entryId", &format!("{label}.entryId"))?;
        let bridge_unit_id =
            assert_required_uuid7(entry, "bridgeUnitId", &format!("{label}.bridgeUnitId"))?;
        let source_unit_key =
            assert_required_string(entry, "sourceUnitKey", &format!("{label}.sourceUnitKey"))?;
        assert_required_hash(entry, "sourceHash", &format!("{label}.sourceHash"))?;
        validate_source_revision(
            required(entry, "sourceRevision", &format!("{label}.sourceRevision"))?,
            &format!("{label}.sourceRevision"),
        )?;
        assert_required_string(entry, "targetText", &format!("{label}.targetText"))?;
        let mappings = required_array(
            entry,
            "protectedSpanMappings",
            &format!("{label}.protectedSpanMappings"),
        )?;
        for (mapping_index, mapping) in mappings.iter().enumerate() {
            let mapping_label = format!("{label}.protectedSpanMappings[{mapping_index}]");
            let mapping = as_record(mapping, &mapping_label)?;
            assert_required_string(mapping, "raw", &format!("{mapping_label}.raw"))?;
            if let Some(source_span_id) = mapping.get("sourceSpanId") {
                assert_uuid7_value(source_span_id, &format!("{mapping_label}.sourceSpanId"))?;
            }
            let source_start = mapping
                .get("sourceStartByte")
                .map(|value| {
                    non_negative_integer_value(value, &format!("{mapping_label}.sourceStartByte"))
                })
                .transpose()?;
            let source_end = mapping
                .get("sourceEndByte")
                .map(|value| {
                    non_negative_integer_value(value, &format!("{mapping_label}.sourceEndByte"))
                })
                .transpose()?;
            if source_start.is_some() != source_end.is_some() {
                return error(format!(
                    "{mapping_label}.sourceStartByte and {mapping_label}.sourceEndByte must be provided together"
                ));
            }
            if let (Some(source_start), Some(source_end)) = (source_start, source_end)
                && source_end <= source_start
            {
                return error(format!(
                    "{mapping_label}.sourceEndByte must be greater than {mapping_label}.sourceStartByte"
                ));
            }
            let start = assert_required_non_negative_integer(
                mapping,
                "targetStart",
                &format!("{mapping_label}.targetStart"),
            )?;
            let end = assert_required_non_negative_integer(
                mapping,
                "targetEnd",
                &format!("{mapping_label}.targetEnd"),
            )?;
            if end <= start {
                return error(format!(
                    "{mapping_label}.targetEnd must be greater than {mapping_label}.targetStart"
                ));
            }
        }
        let entry_key = format!("{bridge_unit_id}\0{source_unit_key}");
        if !entry_keys.insert(entry_key) {
            return error(format!(
                "{label} must be unique by bridgeUnitId and sourceUnitKey"
            ));
        }
    }
    Ok(())
}

pub fn validate_patch_result_v02(value: &Value) -> BridgeContractResult<()> {
    let result = as_record(value, "PatchResultV02")?;
    assert_schema_version(result, "PatchResultV02")?;
    assert_required_uuid7(result, "patchResultId", "PatchResultV02.patchResultId")?;
    let patch_export_id =
        assert_required_uuid7(result, "patchExportId", "PatchResultV02.patchExportId")?.to_string();
    assert_required_string(result, "adapterId", "PatchResultV02.adapterId")?;
    let status = assert_required_one_of(
        result,
        "status",
        &["passed", "failed", "incompatible_source"],
        "PatchResultV02.status",
    )?
    .to_string();
    let output_hash = match result.get("outputHash") {
        Some(value) => {
            assert_hash_value(value, "PatchResultV02.outputHash")?;
            Some(
                value
                    .as_str()
                    .expect("checked by assert_hash_value")
                    .to_string(),
            )
        }
        None => None,
    };

    let failures_value = required(result, "failures", "PatchResultV02.failures")?;
    let failures_array = array_value(failures_value, "PatchResultV02.failures")?;
    let mut observed_categories: Vec<String> = Vec::new();
    let mut failure_asset_ids: Vec<String> = Vec::new();
    let mut seen_failure_ids: HashSet<String> = HashSet::new();
    for (index, failure_value) in failures_array.iter().enumerate() {
        let failure_label = format!("PatchResultV02.failures[{index}]");
        let (failure_id, category, asset_id) =
            validate_patch_failure_v02(failure_value, &failure_label)?;
        if !seen_failure_ids.insert(failure_id.clone()) {
            return error(format!(
                "{failure_label}.failureId must not duplicate {failure_id}"
            ));
        }
        observed_categories.push(category);
        failure_asset_ids.push(asset_id);
    }

    let touched_assets = match result.get("touchedAssets") {
        Some(value) => Some(validate_patch_touched_assets_v02(
            value,
            "PatchResultV02.touchedAssets",
        )?),
        None => None,
    };

    let declared_categories = match result.get("failureCategories") {
        Some(value) => {
            let array = array_value(value, "PatchResultV02.failureCategories")?;
            let mut seen = HashSet::new();
            let mut declared = Vec::new();
            for (index, entry) in array.iter().enumerate() {
                let label = format!("PatchResultV02.failureCategories[{index}]");
                let category = string_value(entry, &label)?;
                assert_one_of(category, PATCH_FAILURE_CATEGORIES_V02, &label)?;
                if !seen.insert(category.to_string()) {
                    return error(format!("{label} must not duplicate {category}"));
                }
                declared.push(category.to_string());
            }
            Some(declared)
        }
        None => None,
    };

    let partial_write = match result.get("partialWrite") {
        Some(value) => Some(validate_patch_partial_write_accounting_v02(
            value,
            "PatchResultV02.partialWrite",
        )?),
        None => None,
    };

    let source_compatibility = result.get("sourceCompatibility");
    if let Some(report) = source_compatibility {
        let compatibility_status =
            validate_patch_source_compatibility_v02(report, "PatchResultV02.sourceCompatibility")?;
        let report_record = as_record(report, "PatchResultV02.sourceCompatibility")?;
        let report_patch_export_id = assert_required_uuid7(
            report_record,
            "patchExportId",
            "PatchResultV02.sourceCompatibility.patchExportId",
        )?;
        if report_patch_export_id != patch_export_id {
            return error(
                "PatchResultV02.sourceCompatibility.patchExportId must match PatchResultV02.patchExportId",
            );
        }
        if compatibility_status == "incompatible" && status != "incompatible_source" {
            return error(
                "PatchResultV02.status must be incompatible_source when sourceCompatibility.status is incompatible",
            );
        }
    }
    if status == "incompatible_source" && source_compatibility.is_none() {
        return error("PatchResultV02.sourceCompatibility is required for incompatible_source");
    }
    if status == "incompatible_source" {
        let report = as_record(
            source_compatibility.expect("checked above"),
            "PatchResultV02.sourceCompatibility",
        )?;
        let compatibility_status = assert_required_one_of(
            report,
            "status",
            &["compatible", "incompatible"],
            "PatchResultV02.sourceCompatibility.status",
        )?;
        if compatibility_status != "incompatible" {
            return error(
                "PatchResultV02.sourceCompatibility.status must be incompatible for incompatible_source",
            );
        }
    }

    if status == "passed" {
        let touched = match touched_assets.as_ref() {
            Some(touched) if !touched.is_empty() => touched,
            _ => {
                return error(
                    "PatchResultV02.touchedAssets must include at least one asset when status is passed: kaifuu.patch_result.passed_requires_touched_assets",
                );
            }
        };
        let Some(top_hash) = output_hash.as_ref() else {
            return error(
                "PatchResultV02.outputHash is required when status is passed: kaifuu.patch_result.passed_requires_output_hash",
            );
        };
        if !failures_array.is_empty() {
            return error(
                "PatchResultV02.failures must be empty when status is passed: kaifuu.patch_result.passed_must_have_no_failures",
            );
        }
        if declared_categories.is_some() {
            return error(
                "PatchResultV02.failureCategories must be omitted when status is passed: kaifuu.patch_result.passed_must_omit_failure_categories",
            );
        }
        if partial_write.is_some() {
            return error(
                "PatchResultV02.partialWrite must be omitted when status is passed: kaifuu.patch_result.passed_must_omit_partial_write",
            );
        }
        let rollup = compute_patch_result_output_hash_rollup_v02(touched);
        if rollup.as_str() != top_hash.as_str() {
            return error(format!(
                "PatchResultV02.outputHash must equal rollup of touchedAssets[].outputHash (expected {rollup}): kaifuu.patch_result.output_hash_drift"
            ));
        }
    }

    if status == "failed" || status == "incompatible_source" {
        if failures_array.is_empty() {
            return error(format!(
                "PatchResultV02.failures must include at least one entry when status is {status}: kaifuu.patch_result.non_passed_requires_failures"
            ));
        }
        let Some(declared) = declared_categories.as_ref() else {
            return error(format!(
                "PatchResultV02.failureCategories is required when status is {status}: kaifuu.patch_result.missing_failure_category"
            ));
        };
        let observed_set: HashSet<&str> = observed_categories.iter().map(String::as_str).collect();
        let declared_set: HashSet<&str> = declared.iter().map(String::as_str).collect();
        for observed in &observed_set {
            if !declared_set.contains(observed) {
                return error(format!(
                    "PatchResultV02.failureCategories is missing {observed}: kaifuu.patch_result.missing_failure_category"
                ));
            }
        }
        for declared in &declared_set {
            if !observed_set.contains(declared) {
                return error(format!(
                    "PatchResultV02.failureCategories contains unobserved {declared}: kaifuu.patch_result.unknown_failure_category"
                ));
            }
        }
        if output_hash.is_some() {
            return error(format!(
                "PatchResultV02.outputHash must be omitted when status is {status}"
            ));
        }
        if touched_assets.is_some() {
            return error(format!(
                "PatchResultV02.touchedAssets must be omitted when status is {status}"
            ));
        }
    }

    if status == "incompatible_source" {
        for category in &observed_categories {
            if category != "source_incompatible" {
                return error(
                    "PatchResultV02.failures[*].category must be source_incompatible when status is incompatible_source: kaifuu.patch_result.incompatible_source_category_required",
                );
            }
        }
    }

    if let Some(accounting) = partial_write.as_ref() {
        if status == "passed" {
            return error(
                "PatchResultV02.partialWrite must be omitted when status is passed: kaifuu.patch_result.passed_must_omit_partial_write",
            );
        }
        let attempted_set: HashSet<&str> = accounting
            .attempted_asset_ids
            .iter()
            .map(String::as_str)
            .collect();
        for asset_id in &failure_asset_ids {
            if !attempted_set.contains(asset_id.as_str()) {
                return error(format!(
                    "PatchResultV02.failures asset {asset_id} must appear in partialWrite.attemptedAssetIds: kaifuu.patch_result.silent_partial_write"
                ));
            }
        }
    }

    Ok(())
}

#[derive(Debug, Clone)]
struct PatchTouchedAssetSummary {
    asset_id: String,
    output_hash: String,
}

#[derive(Debug, Clone)]
struct PatchPartialWriteAccountingSummary {
    attempted_asset_ids: Vec<String>,
}

pub fn validate_patch_failure_v02(
    value: &Value,
    label: &str,
) -> BridgeContractResult<(String, String, String)> {
    let failure = as_record(value, label)?;
    let failure_id =
        assert_required_uuid7(failure, "failureId", &format!("{label}.failureId"))?.to_string();
    let category = assert_required_one_of(
        failure,
        "category",
        PATCH_FAILURE_CATEGORIES_V02,
        &format!("{label}.category"),
    )?
    .to_string();
    assert_required_string(
        failure,
        "diagnosticCode",
        &format!("{label}.diagnosticCode"),
    )?;
    assert_required_string(failure, "cause", &format!("{label}.cause"))?;
    let asset_id =
        assert_required_uuid7(failure, "assetId", &format!("{label}.assetId"))?.to_string();
    assert_required_uuid7(failure, "bridgeUnitId", &format!("{label}.bridgeUnitId"))?;
    assert_required_string(failure, "adapterId", &format!("{label}.adapterId"))?;
    assert_required_string(failure, "command", &format!("{label}.command"))?;
    if let Some(entry_id) = failure.get("patchExportEntryId") {
        assert_uuid7_value(entry_id, &format!("{label}.patchExportEntryId"))?;
    }
    if let Some(location) = failure.get("sourceLocation") {
        validate_source_location(location, &format!("{label}.sourceLocation"))?;
    }
    Ok((failure_id, category, asset_id))
}

fn validate_patch_touched_assets_v02(
    value: &Value,
    label: &str,
) -> BridgeContractResult<Vec<PatchTouchedAssetSummary>> {
    let array = array_value(value, label)?;
    let mut summaries = Vec::new();
    let mut seen = HashSet::new();
    for (index, entry) in array.iter().enumerate() {
        let entry_label = format!("{label}[{index}]");
        let asset = as_record(entry, &entry_label)?;
        let asset_id =
            assert_required_uuid7(asset, "assetId", &format!("{entry_label}.assetId"))?.to_string();
        let output_hash =
            assert_required_hash(asset, "outputHash", &format!("{entry_label}.outputHash"))?
                .to_string();
        assert_required_non_negative_integer(
            asset,
            "byteSize",
            &format!("{entry_label}.byteSize"),
        )?;
        if !seen.insert(asset_id.clone()) {
            return error(format!(
                "{entry_label}.assetId must not duplicate {asset_id}"
            ));
        }
        summaries.push(PatchTouchedAssetSummary {
            asset_id,
            output_hash,
        });
    }
    Ok(summaries)
}

pub fn validate_patch_partial_write_accounting_v02_pub(
    value: &Value,
    label: &str,
) -> BridgeContractResult<()> {
    validate_patch_partial_write_accounting_v02(value, label).map(|_| ())
}

fn validate_patch_partial_write_accounting_v02(
    value: &Value,
    label: &str,
) -> BridgeContractResult<PatchPartialWriteAccountingSummary> {
    let accounting = as_record(value, label)?;
    let attempted = collect_unique_uuid7_array(
        required(
            accounting,
            "attemptedAssetIds",
            &format!("{label}.attemptedAssetIds"),
        )?,
        &format!("{label}.attemptedAssetIds"),
    )?;
    let written = collect_unique_uuid7_array(
        required(
            accounting,
            "writtenAssetIds",
            &format!("{label}.writtenAssetIds"),
        )?,
        &format!("{label}.writtenAssetIds"),
    )?;
    let skipped = collect_unique_uuid7_array(
        required(
            accounting,
            "skippedAssetIds",
            &format!("{label}.skippedAssetIds"),
        )?,
        &format!("{label}.skippedAssetIds"),
    )?;
    let disposition = assert_required_one_of(
        accounting,
        "disposition",
        PATCH_PARTIAL_WRITE_DISPOSITIONS_V02,
        &format!("{label}.disposition"),
    )?
    .to_string();
    let rollback_diagnostic = match accounting.get("rollbackDiagnosticCode") {
        Some(value) => {
            let v = string_value(value, &format!("{label}.rollbackDiagnosticCode"))?;
            Some(v.to_string())
        }
        None => None,
    };

    let attempted_set: HashSet<&str> = attempted.iter().map(String::as_str).collect();
    let written_set: HashSet<&str> = written.iter().map(String::as_str).collect();
    let skipped_set: HashSet<&str> = skipped.iter().map(String::as_str).collect();
    if written_set.len() + skipped_set.len() != attempted_set.len() {
        return error(format!(
            "{label}.attemptedAssetIds must equal disjoint union of writtenAssetIds and skippedAssetIds: kaifuu.patch_result.silent_partial_write"
        ));
    }
    for id in &written_set {
        if skipped_set.contains(id) {
            return error(format!(
                "{label}.writtenAssetIds must not overlap skippedAssetIds: kaifuu.patch_result.silent_partial_write"
            ));
        }
        if !attempted_set.contains(id) {
            return error(format!(
                "{label}.attemptedAssetIds must equal disjoint union of writtenAssetIds and skippedAssetIds: kaifuu.patch_result.silent_partial_write"
            ));
        }
    }
    for id in &skipped_set {
        if !attempted_set.contains(id) {
            return error(format!(
                "{label}.attemptedAssetIds must equal disjoint union of writtenAssetIds and skippedAssetIds: kaifuu.patch_result.silent_partial_write"
            ));
        }
    }

    if disposition == "retained_partial" {
        if rollback_diagnostic.is_some() {
            return error(format!(
                "{label}.rollbackDiagnosticCode must be omitted when disposition is retained_partial"
            ));
        }
    } else if rollback_diagnostic.is_none() {
        return error(format!(
            "{label}.rollbackDiagnosticCode is required when disposition is {disposition}: kaifuu.patch_result.rollback_diagnostic_required"
        ));
    }

    Ok(PatchPartialWriteAccountingSummary {
        attempted_asset_ids: attempted,
    })
}

fn collect_unique_uuid7_array(value: &Value, label: &str) -> BridgeContractResult<Vec<String>> {
    let array = array_value(value, label)?;
    let mut seen = HashSet::new();
    let mut ids = Vec::new();
    for (index, item) in array.iter().enumerate() {
        let entry_label = format!("{label}[{index}]");
        let id = string_value(item, &entry_label)?;
        assert_uuid7(id, &entry_label)?;
        if !seen.insert(id.to_string()) {
            return error(format!("{entry_label} must not duplicate {id}"));
        }
        ids.push(id.to_string());
    }
    Ok(ids)
}

fn compute_patch_result_output_hash_rollup_v02(
    touched_assets: &[PatchTouchedAssetSummary],
) -> String {
    use sha2::{Digest, Sha256};
    use std::fmt::Write as _;
    let mut sorted: Vec<&PatchTouchedAssetSummary> = touched_assets.iter().collect();
    sorted.sort_by(|a, b| a.asset_id.cmp(&b.asset_id));
    let payload: String = sorted.iter().fold(String::new(), |mut acc, asset| {
        let _ = write!(acc, "{}\n{}\n", asset.asset_id, asset.output_hash);
        acc
    });
    let mut hasher = Sha256::new();
    hasher.update(payload.as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in digest {
        let _ = write!(hex, "{byte:02x}");
    }
    format!("sha256:{hex}")
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

pub fn validate_asset_policy_bundle_v02(value: &Value) -> BridgeContractResult<()> {
    let bundle = as_record(value, "AssetPolicyBundleV02")?;
    assert_schema_version(bundle, "AssetPolicyBundleV02")?;
    assert_required_uuid7(
        bundle,
        "assetPolicyBundleId",
        "AssetPolicyBundleV02.assetPolicyBundleId",
    )?;
    assert_required_uuid7(
        bundle,
        "sourceBridgeId",
        "AssetPolicyBundleV02.sourceBridgeId",
    )?;
    if let Some(hash) = bundle.get("sourceBundleHash") {
        assert_hash_value(hash, "AssetPolicyBundleV02.sourceBundleHash")?;
    }
    assert_required_string(bundle, "sourceLocale", "AssetPolicyBundleV02.sourceLocale")?;
    validate_locale_branch_scope(
        required(bundle, "localeBranch", "AssetPolicyBundleV02.localeBranch")?,
        "AssetPolicyBundleV02.localeBranch",
    )?;

    let assets = required_array(bundle, "assets", "AssetPolicyBundleV02.assets")?;
    let mut assets_by_id = HashMap::new();
    for (index, asset) in assets.iter().enumerate() {
        let label = format!("AssetPolicyBundleV02.assets[{index}]");
        let (asset_id, summary) = validate_bridge_asset(asset, &label)?;
        if assets_by_id.insert(asset_id, summary).is_some() {
            return error(format!(
                "{label}.assetId must be unique within AssetPolicyBundleV02.assets"
            ));
        }
    }

    let decisions = required_array(bundle, "decisions", "AssetPolicyBundleV02.decisions")?;
    if decisions.is_empty() {
        return error("AssetPolicyBundleV02.decisions must contain at least one policy decision");
    }
    let mut decision_ids = HashSet::new();
    for (index, decision) in decisions.iter().enumerate() {
        let label = format!("AssetPolicyBundleV02.decisions[{index}]");
        let decision = as_record(decision, &label)?;
        let decision_id = assert_required_uuid7(
            decision,
            "assetPolicyDecisionId",
            &format!("{label}.assetPolicyDecisionId"),
        )?;
        if !decision_ids.insert(decision_id.to_string()) {
            return error(format!(
                "{label}.assetPolicyDecisionId must be unique within AssetPolicyBundleV02.decisions"
            ));
        }
        validate_asset_policy_decision(decision, &label, &assets_by_id)?;
    }
    assert_string_array(
        required(
            bundle,
            "compatibilityNotes",
            "AssetPolicyBundleV02.compatibilityNotes",
        )?,
        "AssetPolicyBundleV02.compatibilityNotes",
    )?;
    Ok(())
}

pub fn validate_runtime_evidence_report_v02(value: &Value) -> BridgeContractResult<()> {
    let report = as_record(value, "RuntimeEvidenceReportV02")?;
    assert_schema_version(report, "RuntimeEvidenceReportV02")?;
    assert_required_uuid7(
        report,
        "runtimeReportId",
        "RuntimeEvidenceReportV02.runtimeReportId",
    )?;
    if let Some(source_bridge_id) = report.get("sourceBridgeId") {
        assert_uuid7_value(source_bridge_id, "RuntimeEvidenceReportV02.sourceBridgeId")?;
    }
    if let Some(source_bundle_hash) = report.get("sourceBundleHash") {
        assert_hash_value(
            source_bundle_hash,
            "RuntimeEvidenceReportV02.sourceBundleHash",
        )?;
    }
    if let Some(source_locale) = report.get("sourceLocale") {
        string_value(source_locale, "RuntimeEvidenceReportV02.sourceLocale")?;
    }
    if let Some(target_locale) = report.get("targetLocale") {
        string_value(target_locale, "RuntimeEvidenceReportV02.targetLocale")?;
    }
    assert_required_string(
        report,
        "adapterName",
        "RuntimeEvidenceReportV02.adapterName",
    )?;
    assert_required_string(
        report,
        "adapterVersion",
        "RuntimeEvidenceReportV02.adapterVersion",
    )?;
    let fidelity_tier = assert_required_one_of(
        report,
        "fidelityTier",
        RUNTIME_FIDELITY_TIERS,
        "RuntimeEvidenceReportV02.fidelityTier",
    )?;
    let evidence_tier = assert_required_one_of(
        report,
        "evidenceTier",
        RUNTIME_EVIDENCE_TIERS,
        "RuntimeEvidenceReportV02.evidenceTier",
    )?;
    assert_runtime_evidence_tier_within_fidelity(evidence_tier, fidelity_tier)?;
    let report_status = assert_required_one_of(
        report,
        "status",
        &["passed", "failed"],
        "RuntimeEvidenceReportV02.status",
    )?;
    if let Some(runtime_capabilities) = report.get("runtimeCapabilities") {
        validate_runtime_capability_contract(
            runtime_capabilities,
            "RuntimeEvidenceReportV02.runtimeCapabilities",
            fidelity_tier,
            evidence_tier,
        )?;
    }
    if let Some(controlled_playback_session) = report.get("controlledPlaybackSession") {
        validate_controlled_playback_session(
            controlled_playback_session,
            "RuntimeEvidenceReportV02.controlledPlaybackSession",
            report,
            fidelity_tier,
            evidence_tier,
            report_status,
        )?;
    }
    assert_required_rfc3339(report, "createdAt", "RuntimeEvidenceReportV02.createdAt")?;

    let trace_events = required_array(
        report,
        "traceEvents",
        "RuntimeEvidenceReportV02.traceEvents",
    )?;
    for (index, event) in trace_events.iter().enumerate() {
        validate_runtime_trace_event(
            event,
            &format!("RuntimeEvidenceReportV02.traceEvents[{index}]"),
        )?;
    }
    let branch_events = required_array(
        report,
        "branchEvents",
        "RuntimeEvidenceReportV02.branchEvents",
    )?;
    for (index, event) in branch_events.iter().enumerate() {
        validate_runtime_branch_event(
            event,
            &format!("RuntimeEvidenceReportV02.branchEvents[{index}]"),
        )?;
    }
    let observation_hook_events = optional_array(
        report,
        "observationHookEvents",
        "RuntimeEvidenceReportV02.observationHookEvents",
    )?;
    for (index, event) in observation_hook_events.iter().enumerate() {
        validate_observation_hook_event(
            event,
            &format!("RuntimeEvidenceReportV02.observationHookEvents[{index}]"),
            evidence_tier,
        )?;
    }
    let captures = required_array(report, "captures", "RuntimeEvidenceReportV02.captures")?;
    for (index, capture) in captures.iter().enumerate() {
        validate_runtime_capture(
            capture,
            &format!("RuntimeEvidenceReportV02.captures[{index}]"),
        )?;
    }
    let recordings = required_array(report, "recordings", "RuntimeEvidenceReportV02.recordings")?;
    for (index, recording) in recordings.iter().enumerate() {
        validate_runtime_recording(
            recording,
            &format!("RuntimeEvidenceReportV02.recordings[{index}]"),
        )?;
    }
    let approximations = required_array(
        report,
        "approximations",
        "RuntimeEvidenceReportV02.approximations",
    )?;
    for (index, approximation) in approximations.iter().enumerate() {
        validate_runtime_approximation(
            approximation,
            &format!("RuntimeEvidenceReportV02.approximations[{index}]"),
        )?;
    }
    let findings = required_array(
        report,
        "validationFindings",
        "RuntimeEvidenceReportV02.validationFindings",
    )?;
    for (index, finding) in findings.iter().enumerate() {
        validate_runtime_validation_finding(
            finding,
            &format!("RuntimeEvidenceReportV02.validationFindings[{index}]"),
        )?;
    }
    let reference_comparisons = optional_array(
        report,
        "referenceComparisons",
        "RuntimeEvidenceReportV02.referenceComparisons",
    )?;
    let mut has_passed_reference_comparison = false;
    for (index, comparison) in reference_comparisons.iter().enumerate() {
        if validate_runtime_reference_comparison(
            comparison,
            &format!("RuntimeEvidenceReportV02.referenceComparisons[{index}]"),
        )? {
            has_passed_reference_comparison = true;
        }
    }
    assert_string_array(
        required(
            report,
            "limitations",
            "RuntimeEvidenceReportV02.limitations",
        )?,
        "RuntimeEvidenceReportV02.limitations",
    )?;

    if let Some(controlled_playback_session) = report.get("controlledPlaybackSession") {
        let session = as_record(
            controlled_playback_session,
            "RuntimeEvidenceReportV02.controlledPlaybackSession",
        )?;
        validate_controlled_playback_session_evidence_surface(
            string_field(session, "requestedOperation")?,
            !branch_events.is_empty(),
            !captures.is_empty(),
            !recordings.is_empty(),
            !reference_comparisons.is_empty(),
            "RuntimeEvidenceReportV02.controlledPlaybackSession.requestedOperation",
        )?;
    }

    if trace_events.is_empty()
        && observation_hook_events.is_empty()
        && captures.is_empty()
        && recordings.is_empty()
    {
        return error(
            "RuntimeEvidenceReportV02 must contain trace, observation hook, capture, or recording evidence",
        );
    }
    if !captures.is_empty() {
        assert_minimum_runtime_evidence_tier(
            evidence_tier,
            "E2",
            "RuntimeEvidenceReportV02.evidenceTier",
        )?;
        if let Some(runtime_capabilities) = report.get("runtimeCapabilities") {
            validate_runtime_capability_supports_feature(
                runtime_capabilities,
                "frame_capture",
                "RuntimeEvidenceReportV02.runtimeCapabilities",
            )?;
        }
    }
    if !recordings.is_empty() {
        assert_minimum_runtime_evidence_tier(
            evidence_tier,
            "E3",
            "RuntimeEvidenceReportV02.evidenceTier",
        )?;
        if let Some(runtime_capabilities) = report.get("runtimeCapabilities") {
            validate_runtime_capability_supports_feature(
                runtime_capabilities,
                "recording",
                "RuntimeEvidenceReportV02.runtimeCapabilities",
            )?;
        }
    }
    if !trace_events.is_empty()
        && let Some(runtime_capabilities) = report.get("runtimeCapabilities")
    {
        validate_runtime_capability_supports_feature(
            runtime_capabilities,
            "text_trace",
            "RuntimeEvidenceReportV02.runtimeCapabilities",
        )?;
    }
    if !branch_events.is_empty()
        && let Some(runtime_capabilities) = report.get("runtimeCapabilities")
    {
        validate_runtime_capability_supports_feature(
            runtime_capabilities,
            "branch_discovery",
            "RuntimeEvidenceReportV02.runtimeCapabilities",
        )?;
    }
    if !observation_hook_events.is_empty()
        && let Some(runtime_capabilities) = report.get("runtimeCapabilities")
    {
        validate_runtime_capability_supports_feature(
            runtime_capabilities,
            "instrumentation_hooks",
            "RuntimeEvidenceReportV02.runtimeCapabilities",
        )?;
    }
    if fidelity_tier != "reference_fidelity" && approximations.is_empty() {
        return error(
            "RuntimeEvidenceReportV02.approximations must document non-reference runtime limits",
        );
    }
    if (fidelity_tier == "reference_fidelity" || evidence_tier == "E4")
        && !has_passed_reference_comparison
    {
        return error(
            "RuntimeEvidenceReportV02.referenceComparisons must include passed reference-runtime or conformance comparison evidence for E4/reference_fidelity claims",
        );
    }
    if !reference_comparisons.is_empty()
        && let Some(runtime_capabilities) = report.get("runtimeCapabilities")
    {
        validate_runtime_capability_supports_feature(
            runtime_capabilities,
            "reference_comparison",
            "RuntimeEvidenceReportV02.runtimeCapabilities",
        )?;
    }
    if string_field(report, "status")? == "failed" && findings.is_empty() {
        return error(
            "RuntimeEvidenceReportV02.validationFindings must explain failed runtime evidence",
        );
    }
    Ok(())
}

pub fn validate_finding_record_fixture_v02(value: &Value) -> BridgeContractResult<()> {
    assert_no_confidence_fields(value, "FindingRecordFixtureV02")?;
    let fixture = as_record(value, "FindingRecordFixtureV02")?;
    assert_schema_version(fixture, "FindingRecordFixtureV02")?;
    assert_required_uuid7(
        fixture,
        "findingFixtureId",
        "FindingRecordFixtureV02.findingFixtureId",
    )?;
    if let Some(id) = fixture.get("sourceTriageBundleId") {
        assert_uuid7_value(id, "FindingRecordFixtureV02.sourceTriageBundleId")?;
    }
    let finding = required(fixture, "finding", "FindingRecordFixtureV02.finding")?;
    validate_finding_record(finding, "FindingRecordFixtureV02.finding")?;
    validate_finding_evidence_own_provenance(finding, "FindingRecordFixtureV02.finding")?;
    assert_string_array(
        required(
            fixture,
            "compatibilityNotes",
            "FindingRecordFixtureV02.compatibilityNotes",
        )?,
        "FindingRecordFixtureV02.compatibilityNotes",
    )?;
    Ok(())
}

pub fn validate_triage_bundle_v02(value: &Value) -> BridgeContractResult<()> {
    assert_no_confidence_fields(value, "TriageBundleV02")?;
    let bundle = as_record(value, "TriageBundleV02")?;
    assert_schema_version(bundle, "TriageBundleV02")?;
    assert_required_uuid7(bundle, "triageBundleId", "TriageBundleV02.triageBundleId")?;
    for (key, label) in [
        ("projectId", "TriageBundleV02.projectId"),
        ("sourceBridgeId", "TriageBundleV02.sourceBridgeId"),
        ("localeBranchId", "TriageBundleV02.localeBranchId"),
    ] {
        if let Some(value) = bundle.get(key) {
            assert_uuid7_value(value, label)?;
        }
    }

    let events = required_array(bundle, "events", "TriageBundleV02.events")?;
    let tasks = required_array(bundle, "tasks", "TriageBundleV02.tasks")?;
    let findings = required_array(bundle, "findings", "TriageBundleV02.findings")?;
    let mut event_ids = HashSet::new();
    let mut task_ids = HashSet::new();
    let mut finding_ids = HashSet::new();
    let mut provenance_ids = HashSet::new();

    for (index, event) in events.iter().enumerate() {
        let label = format!("TriageBundleV02.events[{index}]");
        let id = validate_triage_event(event, &label, &event_ids)?;
        if !event_ids.insert(id) {
            return error(format!(
                "{label}.eventId must be unique within TriageBundleV02.events"
            ));
        }
        collect_provenance_ids(event, &mut provenance_ids)?;
    }
    for (index, task) in tasks.iter().enumerate() {
        let label = format!("TriageBundleV02.tasks[{index}]");
        let id = validate_triage_task(task, &label)?;
        if !task_ids.insert(id) {
            return error(format!(
                "{label}.taskId must be unique within TriageBundleV02.tasks"
            ));
        }
        collect_provenance_ids(task, &mut provenance_ids)?;
    }
    for (index, finding) in findings.iter().enumerate() {
        let label = format!("TriageBundleV02.findings[{index}]");
        let id = validate_finding_record(finding, &label)?;
        if !finding_ids.insert(id) {
            return error(format!(
                "{label}.findingId must be unique within TriageBundleV02.findings"
            ));
        }
        collect_provenance_ids(finding, &mut provenance_ids)?;
    }

    for (index, event) in events.iter().enumerate() {
        let label = format!("TriageBundleV02.events[{index}]");
        let event = as_record(event, &label)?;
        assert_optional_known_reference(
            event.get("taskId"),
            &format!("{label}.taskId"),
            "task",
            &task_ids,
        )?;
        assert_optional_known_reference(
            event.get("findingId"),
            &format!("{label}.findingId"),
            "finding",
            &finding_ids,
        )?;
        validate_causal_link_targets(
            event,
            &format!("{label}.causalLinks"),
            &event_ids,
            &task_ids,
            &finding_ids,
        )?;
    }
    for (index, task) in tasks.iter().enumerate() {
        let label = format!("TriageBundleV02.tasks[{index}]");
        let task = as_record(task, &label)?;
        assert_optional_known_reference(
            task.get("createdByEventId"),
            &format!("{label}.createdByEventId"),
            "event",
            &event_ids,
        )?;
        validate_causal_link_targets(
            task,
            &format!("{label}.causalLinks"),
            &event_ids,
            &task_ids,
            &finding_ids,
        )?;
    }
    for (index, finding) in findings.iter().enumerate() {
        let label = format!("TriageBundleV02.findings[{index}]");
        let finding_record = as_record(finding, &label)?;
        assert_optional_known_reference(
            finding_record.get("reportedByTaskId"),
            &format!("{label}.reportedByTaskId"),
            "task",
            &task_ids,
        )?;
        assert_optional_known_reference(
            finding_record.get("firstSeenEventId"),
            &format!("{label}.firstSeenEventId"),
            "event",
            &event_ids,
        )?;
        validate_causal_link_targets(
            finding_record,
            &format!("{label}.causalLinks"),
            &event_ids,
            &task_ids,
            &finding_ids,
        )?;
        validate_finding_evidence_provenance(finding, &label, &provenance_ids)?;
    }
    Ok(())
}

pub fn validate_benchmark_report_v02(value: &Value) -> BridgeContractResult<()> {
    assert_no_confidence_fields(value, "BenchmarkReportV02")?;
    let report = as_record(value, "BenchmarkReportV02")?;
    assert_schema_version(report, "BenchmarkReportV02")?;
    assert_required_uuid7(
        report,
        "benchmarkRunId",
        "BenchmarkReportV02.benchmarkRunId",
    )?;
    assert_literal(
        report,
        "taxonomyId",
        "itotori-lqa-1",
        "BenchmarkReportV02.taxonomyId",
    )?;
    assert_literal(
        report,
        "taxonomyVersion",
        "itotori-quality-taxonomy-0.1.0",
        "BenchmarkReportV02.taxonomyVersion",
    )?;
    assert_required_rfc3339(report, "createdAt", "BenchmarkReportV02.createdAt")?;
    assert_required_string(report, "benchmarkName", "BenchmarkReportV02.benchmarkName")?;
    assert_required_one_of(
        report,
        "status",
        &["passed", "failed", "partial"],
        "BenchmarkReportV02.status",
    )?;
    assert_required_string(report, "sourceLocale", "BenchmarkReportV02.sourceLocale")?;
    assert_required_string(report, "targetLocale", "BenchmarkReportV02.targetLocale")?;
    assert_required_string(report, "engineProfile", "BenchmarkReportV02.engineProfile")?;
    assert_required_string(report, "gitCommit", "BenchmarkReportV02.gitCommit")?;
    assert_literal(
        report,
        "bridgeSchemaVersion",
        BRIDGE_SCHEMA_VERSION_V02,
        "BenchmarkReportV02.bridgeSchemaVersion",
    )?;
    if let Some(seed) = report.get("deterministicSeed") {
        string_value(seed, "BenchmarkReportV02.deterministicSeed")?;
    }

    let input_refs = required_array(
        report,
        "fixtureOrCorpusRefs",
        "BenchmarkReportV02.fixtureOrCorpusRefs",
    )?;
    if input_refs.is_empty() {
        return error("BenchmarkReportV02.fixtureOrCorpusRefs must contain at least one ref");
    }
    let mut input_ref_ids = HashSet::new();
    let mut total_source_units = 0_u64;
    let mut total_source_chars = 0_u64;
    for (index, input_ref) in input_refs.iter().enumerate() {
        let label = format!("BenchmarkReportV02.fixtureOrCorpusRefs[{index}]");
        let input_ref = as_record(input_ref, &label)?;
        let corpus_ref_id =
            assert_required_string(input_ref, "corpusRefId", &format!("{label}.corpusRefId"))?;
        if !input_ref_ids.insert(corpus_ref_id.to_string()) {
            return error(format!(
                "{label}.corpusRefId must be unique within fixtureOrCorpusRefs"
            ));
        }
        let corpus_kind = assert_required_one_of(
            input_ref,
            "corpusKind",
            &[
                "public_fixture",
                "private_local_corpus",
                "synthetic_fixture",
            ],
            &format!("{label}.corpusKind"),
        )?;
        assert_required_string(input_ref, "label", &format!("{label}.label"))?;
        if let Some(uri) = input_ref.get("manifestUri") {
            assert_portable_uri(uri, &format!("{label}.manifestUri"))?;
        }
        if let Some(hash) = input_ref.get("manifestHash") {
            assert_hash_value(hash, &format!("{label}.manifestHash"))?;
        }
        if let Some(hash) = input_ref.get("sourceBundleHash") {
            assert_hash_value(hash, &format!("{label}.sourceBundleHash"))?;
        }
        for key in [
            "sourceLocale",
            "targetLocale",
            "engineProfile",
            "benchmarkSplit",
        ] {
            assert_required_string(input_ref, key, &format!("{label}.{key}"))?;
        }
        let source_unit_count = assert_required_positive_integer(
            input_ref,
            "sourceUnitCount",
            &format!("{label}.sourceUnitCount"),
        )?;
        let source_char_count = assert_required_positive_integer(
            input_ref,
            "sourceCharacterCount",
            &format!("{label}.sourceCharacterCount"),
        )?;
        total_source_units += source_unit_count;
        total_source_chars += source_char_count;
        let public_content = assert_required_bool(
            input_ref,
            "publicContent",
            &format!("{label}.publicContent"),
        )?;
        if corpus_kind == "private_local_corpus" && public_content {
            return error(format!(
                "{label}.publicContent must be false for private_local_corpus"
            ));
        }
    }

    validate_tool_versions(report)?;
    validate_command_lines(report)?;

    let systems = required_array(
        report,
        "systemsCompared",
        "BenchmarkReportV02.systemsCompared",
    )?;
    if systems.is_empty() {
        return error("BenchmarkReportV02.systemsCompared must contain at least one system");
    }
    let mut system_ids = HashSet::new();
    let mut declared_provider_run_ids = HashSet::new();
    for (index, system) in systems.iter().enumerate() {
        let label = format!("BenchmarkReportV02.systemsCompared[{index}]");
        let system = as_record(system, &label)?;
        let system_id = assert_required_string(system, "systemId", &format!("{label}.systemId"))?;
        if !system_ids.insert(system_id.to_string()) {
            return error(format!(
                "{label}.systemId must be unique within systemsCompared"
            ));
        }
        assert_required_one_of(
            system,
            "systemKind",
            &[
                "raw_mtl_baseline",
                "itotori_draft",
                "itotori_repaired",
                "human_reference",
                "deterministic_fixture",
            ],
            &format!("{label}.systemKind"),
        )?;
        assert_required_string(system, "displayName", &format!("{label}.displayName"))?;
        assert_required_rfc3339(system, "generatedAt", &format!("{label}.generatedAt"))?;
        let provider_run_ids =
            required_array(system, "providerRunIds", &format!("{label}.providerRunIds"))?;
        for (provider_index, provider_run_id) in provider_run_ids.iter().enumerate() {
            let provider_run_id = string_value(
                provider_run_id,
                &format!("{label}.providerRunIds[{provider_index}]"),
            )?;
            assert_uuid7(
                provider_run_id,
                &format!("{label}.providerRunIds[{provider_index}]"),
            )?;
            declared_provider_run_ids.insert(provider_run_id.to_string());
        }
        if !provider_run_ids.is_empty() && system.get("promptPresetId").is_none() {
            return error(format!(
                "{label}.promptPresetId is required when providerRunIds are present"
            ));
        }
        if let Some(prompt_preset_id) = system.get("promptPresetId") {
            string_value(prompt_preset_id, &format!("{label}.promptPresetId"))?;
        }
        if let Some(prompt_preset_version) = system.get("promptPresetVersion") {
            string_value(
                prompt_preset_version,
                &format!("{label}.promptPresetVersion"),
            )?;
        }
        if let Some(artifact) = system.get("outputArtifactRef") {
            validate_benchmark_artifact_ref(artifact, &format!("{label}.outputArtifactRef"))?;
        }
    }

    let provider_runs = required_array(
        report,
        "providerModelCostRecords",
        "BenchmarkReportV02.providerModelCostRecords",
    )?;
    let mut provider_run_ids = HashSet::new();
    let mut provider_run_system_ids = HashMap::new();
    let mut llm_qa_provider_run_system_ids = HashMap::new();
    let mut cost_totals_by_system: HashMap<String, u64> = HashMap::new();
    let mut report_total_micros_usd = 0_u64;
    let mut includes_unknown_cost = false;
    for (index, run) in provider_runs.iter().enumerate() {
        let label = format!("BenchmarkReportV02.providerModelCostRecords[{index}]");
        let run = as_record(run, &label)?;
        let provider_run_id = validate_benchmark_provider_run(
            run,
            &label,
            &system_ids,
            &mut cost_totals_by_system,
            &mut report_total_micros_usd,
            &mut includes_unknown_cost,
        )?;
        if !provider_run_ids.insert(provider_run_id.clone()) {
            return error(format!(
                "{label}.providerRunId must be unique within providerModelCostRecords"
            ));
        }
        let provider_run_system_id = string_field(run, "systemId")?.to_string();
        provider_run_system_ids.insert(provider_run_id.clone(), provider_run_system_id.clone());
        if string_field(run, "taskKind")? == "llm_qa" {
            llm_qa_provider_run_system_ids.insert(provider_run_id, provider_run_system_id);
        }
    }
    for provider_run_id in &declared_provider_run_ids {
        if !provider_run_ids.contains(provider_run_id) {
            return error(format!(
                "BenchmarkReportV02.systemsCompared providerRunId {provider_run_id} must reference providerModelCostRecords"
            ));
        }
    }
    validate_benchmark_cost_ledger(
        required(report, "costLedger", "BenchmarkReportV02.costLedger")?,
        &system_ids,
        report_total_micros_usd,
        &cost_totals_by_system,
        includes_unknown_cost,
    )?;

    let seed_records = required_array(
        report,
        "seededDefectOracle",
        "BenchmarkReportV02.seededDefectOracle",
    )?;
    let mut seeded_defect_ids = HashSet::new();
    let mut seeded_matched_finding_ids: Vec<(usize, usize, String)> = Vec::new();
    for (index, seed) in seed_records.iter().enumerate() {
        let label = format!("BenchmarkReportV02.seededDefectOracle[{index}]");
        let seed = as_record(seed, &label)?;
        let seed_id = validate_seeded_defect(seed, &label, &input_ref_ids)?;
        if !seeded_defect_ids.insert(seed_id) {
            return error(format!(
                "{label}.seededDefectId must be unique within seededDefectOracle"
            ));
        }
        let matched = required_array(
            seed,
            "matchedFindingIds",
            &format!("{label}.matchedFindingIds"),
        )?;
        for (matched_index, finding_id) in matched.iter().enumerate() {
            seeded_matched_finding_ids.push((
                index,
                matched_index,
                string_value(
                    finding_id,
                    &format!("{label}.matchedFindingIds[{matched_index}]"),
                )?
                .to_string(),
            ));
        }
    }

    let finding_records = required_array(
        report,
        "findingRecords",
        "BenchmarkReportV02.findingRecords",
    )?;
    let mut finding_ids = HashSet::new();
    let mut quality_severities = Vec::new();
    let mut categories = Vec::new();
    let mut root_causes = Vec::new();
    let mut detector_kinds = Vec::new();
    let mut adjudication_states = Vec::new();
    let mut finding_system_ids = HashMap::new();
    let mut llm_qa_finding_system_ids = HashMap::new();
    for (index, finding) in finding_records.iter().enumerate() {
        let label = format!("BenchmarkReportV02.findingRecords[{index}]");
        let finding = as_record(finding, &label)?;
        let finding_id =
            validate_benchmark_finding_record(finding, &label, &system_ids, &seeded_defect_ids)?;
        if !finding_ids.insert(finding_id.clone()) {
            return error(format!(
                "{label}.findingId must be unique within findingRecords"
            ));
        }
        let severity = string_field(finding, "qualitySeverity")?.to_string();
        let category = string_field(finding, "category")?.to_string();
        let root_cause = string_field(finding, "rootCause")?.to_string();
        let detector_kind = string_field(finding, "detectorKind")?.to_string();
        let adjudication_state = string_field(finding, "adjudicationState")?.to_string();
        let finding_system_id = string_field(finding, "systemId")?.to_string();
        finding_system_ids.insert(finding_id.clone(), finding_system_id.clone());
        if detector_kind == "llm_qa" {
            llm_qa_finding_system_ids.insert(finding_id, finding_system_id);
        }
        quality_severities.push(severity);
        categories.push(category);
        root_causes.push(root_cause);
        detector_kinds.push(detector_kind);
        adjudication_states.push(adjudication_state);
    }
    for (seed_index, match_index, finding_id) in seeded_matched_finding_ids {
        if !finding_ids.contains(&finding_id) {
            return error(format!(
                "BenchmarkReportV02.seededDefectOracle[{seed_index}].matchedFindingIds[{match_index}] must reference findingRecords"
            ));
        }
    }

    assert_count_buckets_match(
        &quality_severities,
        required(
            report,
            "countsByQualitySeverity",
            "BenchmarkReportV02.countsByQualitySeverity",
        )?,
        LOCALIZATION_QUALITY_SEVERITIES,
        "BenchmarkReportV02.countsByQualitySeverity",
    )?;
    assert_count_buckets_match(
        &categories,
        required(
            report,
            "countsByCategory",
            "BenchmarkReportV02.countsByCategory",
        )?,
        LOCALIZATION_QUALITY_CATEGORIES,
        "BenchmarkReportV02.countsByCategory",
    )?;
    assert_count_buckets_match(
        &root_causes,
        required(
            report,
            "countsByRootCause",
            "BenchmarkReportV02.countsByRootCause",
        )?,
        LOCALIZATION_ROOT_CAUSES,
        "BenchmarkReportV02.countsByRootCause",
    )?;
    assert_count_buckets_match(
        &detector_kinds,
        required(
            report,
            "countsByDetectorKind",
            "BenchmarkReportV02.countsByDetectorKind",
        )?,
        QUALITY_DETECTOR_KINDS,
        "BenchmarkReportV02.countsByDetectorKind",
    )?;
    assert_count_buckets_match(
        &adjudication_states,
        required(
            report,
            "countsByAdjudicationState",
            "BenchmarkReportV02.countsByAdjudicationState",
        )?,
        LOCALIZATION_ADJUDICATION_STATES,
        "BenchmarkReportV02.countsByAdjudicationState",
    )?;
    validate_benchmark_penalty_summary(
        required(
            report,
            "penaltySummary",
            "BenchmarkReportV02.penaltySummary",
        )?,
        &quality_severities,
        total_source_chars,
        total_source_units,
    )?;

    validate_deterministic_qa_results(report, &system_ids, &finding_ids)?;
    let qa_agent_refs = validate_qa_agent_evaluations(
        report,
        &system_ids,
        &provider_run_ids,
        &provider_run_system_ids,
        &finding_ids,
        &finding_system_ids,
    )?;
    validate_human_evaluations(report, &system_ids, &finding_ids)?;
    for (provider_run_id, system_id) in &llm_qa_provider_run_system_ids {
        if !qa_agent_refs
            .provider_run_ids
            .get(system_id)
            .is_some_and(|ids| ids.contains(provider_run_id))
        {
            return error(format!(
                "BenchmarkReportV02.qaAgentEvaluations.providerRunIds must cover llm_qa providerModelCostRecords run {provider_run_id} for evaluatedSystemId {system_id}"
            ));
        }
    }
    for (finding_id, system_id) in &llm_qa_finding_system_ids {
        if !qa_agent_refs
            .finding_ids
            .get(system_id)
            .is_some_and(|ids| ids.contains(finding_id))
        {
            return error(format!(
                "BenchmarkReportV02.qaAgentEvaluations.findingIds must cover llm_qa findingRecords finding {finding_id} for evaluatedSystemId {system_id}"
            ));
        }
    }
    assert_string_array(
        required(
            report,
            "knownBlindSpots",
            "BenchmarkReportV02.knownBlindSpots",
        )?,
        "BenchmarkReportV02.knownBlindSpots",
    )?;
    Ok(())
}

fn validate_contract_fixture_manifest_entry(
    value: &Value,
    label: &str,
) -> BridgeContractResult<(String, String)> {
    let entry = as_record(value, label)?;
    let kind = assert_required_one_of(
        entry,
        "kind",
        CONTRACT_FIXTURE_KINDS_V02,
        &format!("{label}.kind"),
    )?;
    let path = assert_required_string(entry, "path", &format!("{label}.path"))?;
    assert_fixture_path(path, &format!("{label}.path"))?;
    assert_required_string(entry, "description", &format!("{label}.description"))?;
    Ok((kind.to_string(), path.to_string()))
}

pub fn validate_patch_source_compatibility_v02(
    value: &Value,
    label: &str,
) -> BridgeContractResult<String> {
    validate_patch_source_compatibility_report_v02(value, label)
}

fn validate_patch_source_compatibility_report_v02(
    value: &Value,
    label: &str,
) -> BridgeContractResult<String> {
    let report = as_record(value, label)?;
    assert_schema_version(report, label)?;
    assert_required_uuid7(report, "patchExportId", &format!("{label}.patchExportId"))?;
    assert_required_uuid7(report, "sourceBridgeId", &format!("{label}.sourceBridgeId"))?;
    let status = assert_required_one_of(
        report,
        "status",
        &["compatible", "incompatible"],
        &format!("{label}.status"),
    )?;
    let expected_hash = assert_required_hash(
        report,
        "expectedSourceBundleHash",
        &format!("{label}.expectedSourceBundleHash"),
    )?;
    let actual_hash = assert_required_hash(
        report,
        "actualSourceBundleHash",
        &format!("{label}.actualSourceBundleHash"),
    )?;
    let matches = assert_required_bool(
        report,
        "sourceBundleHashMatches",
        &format!("{label}.sourceBundleHashMatches"),
    )?;
    if matches != (expected_hash == actual_hash) {
        return error(format!(
            "{label}.sourceBundleHashMatches must match source bundle hashes"
        ));
    }
    let compatible_units = required_array(
        report,
        "compatibleUnits",
        &format!("{label}.compatibleUnits"),
    )?;
    for (index, unit) in compatible_units.iter().enumerate() {
        let unit_label = format!("{label}.compatibleUnits[{index}]");
        let unit_status = validate_unit_source_compatibility(unit, &unit_label)?;
        if unit_status != "compatible" {
            return error(format!("{unit_label}.status must be compatible"));
        }
    }
    let incompatible_units = required_array(
        report,
        "incompatibleUnits",
        &format!("{label}.incompatibleUnits"),
    )?;
    for (index, unit) in incompatible_units.iter().enumerate() {
        let unit_label = format!("{label}.incompatibleUnits[{index}]");
        let unit_status = validate_unit_source_compatibility(unit, &unit_label)?;
        if unit_status != "incompatible" {
            return error(format!("{unit_label}.status must be incompatible"));
        }
    }
    if status == "compatible" && !incompatible_units.is_empty() {
        return error(format!(
            "{label}.status cannot be compatible with incompatibleUnits"
        ));
    }
    if status == "incompatible" && incompatible_units.is_empty() {
        return error(format!(
            "{label}.status cannot be incompatible with empty incompatibleUnits"
        ));
    }
    Ok(status.to_string())
}

fn validate_unit_source_compatibility(value: &Value, label: &str) -> BridgeContractResult<String> {
    let unit = as_record(value, label)?;
    assert_required_uuid7(unit, "entryId", &format!("{label}.entryId"))?;
    let bridge_unit_id =
        assert_required_uuid7(unit, "bridgeUnitId", &format!("{label}.bridgeUnitId"))?;
    let actual_bridge_unit_id = match unit.get("actualBridgeUnitId") {
        Some(value) => {
            let value = string_value(value, &format!("{label}.actualBridgeUnitId"))?;
            assert_uuid7(value, &format!("{label}.actualBridgeUnitId"))?;
            Some(value)
        }
        None => None,
    };
    assert_required_string(unit, "sourceUnitKey", &format!("{label}.sourceUnitKey"))?;
    let status = assert_required_one_of(
        unit,
        "status",
        &["compatible", "incompatible"],
        &format!("{label}.status"),
    )?;
    assert_required_hash(
        unit,
        "expectedSourceHash",
        &format!("{label}.expectedSourceHash"),
    )?;
    if let Some(actual_hash) = unit.get("actualSourceHash") {
        assert_hash_value(actual_hash, &format!("{label}.actualSourceHash"))?;
    }
    let reason = if let Some(reason) = unit.get("reason") {
        let reason = string_value(reason, &format!("{label}.reason"))?;
        assert_one_of(
            reason,
            &[
                "source_hash_mismatch",
                "missing_source_unit",
                "duplicate_source_unit_key",
                "bridge_unit_id_mismatch",
            ],
            &format!("{label}.reason"),
        )?;
        Some(reason)
    } else {
        None
    };
    if status == "incompatible" && reason.is_none() {
        return error(format!("{label}.reason is required for incompatible units"));
    }
    if status == "compatible" && reason.is_some() {
        return error(format!(
            "{label}.reason is only valid for incompatible units"
        ));
    }
    if reason == Some("bridge_unit_id_mismatch") && actual_bridge_unit_id.is_none() {
        return error(format!(
            "{label}.actualBridgeUnitId is required for bridge_unit_id_mismatch"
        ));
    }
    if reason != Some("bridge_unit_id_mismatch") && actual_bridge_unit_id.is_some() {
        return error(format!(
            "{label}.actualBridgeUnitId is only valid for bridge_unit_id_mismatch"
        ));
    }
    if actual_bridge_unit_id == Some(bridge_unit_id) {
        return error(format!(
            "{label}.actualBridgeUnitId must differ from {label}.bridgeUnitId"
        ));
    }
    Ok(status.to_string())
}

fn validate_asset_policy_decision(
    decision: &Map<String, Value>,
    label: &str,
    assets_by_id: &HashMap<String, AssetSummary>,
) -> BridgeContractResult<()> {
    let surface_kind = assert_required_one_of(
        decision,
        "assetSurfaceKind",
        &[
            "image_text",
            "ui_art",
            "song_title",
            "font",
            "credits",
            "video",
        ],
        &format!("{label}.assetSurfaceKind"),
    )?;
    let source_asset_ref = required_record(
        decision,
        "sourceAssetRef",
        &format!("{label}.sourceAssetRef"),
    )?;
    let source_asset_id = assert_required_uuid7(
        source_asset_ref,
        "assetId",
        &format!("{label}.sourceAssetRef.assetId"),
    )?;
    if let Some(source_location) = decision.get("sourceLocation") {
        validate_source_location(source_location, &format!("{label}.sourceLocation"))?;
    }
    if let Some(source_text) = decision.get("sourceText") {
        string_value(source_text, &format!("{label}.sourceText"))?;
    }
    assert_required_hash(decision, "sourceHash", &format!("{label}.sourceHash"))?;
    validate_source_revision(
        required(
            decision,
            "sourceRevision",
            &format!("{label}.sourceRevision"),
        )?,
        &format!("{label}.sourceRevision"),
    )?;
    let policy_action = assert_required_one_of(
        decision,
        "policyAction",
        &["localize", "romanize", "do_not_translate"],
        &format!("{label}.policyAction"),
    )?;
    if let Some(target_text) = decision.get("targetText") {
        string_value(target_text, &format!("{label}.targetText"))?;
    }
    if let Some(system) = decision.get("romanizationSystem") {
        string_value(system, &format!("{label}.romanizationSystem"))?;
    }
    if let Some(preserve_form) = decision.get("preserveForm") {
        string_value(preserve_form, &format!("{label}.preserveForm"))?;
    }
    assert_required_string(decision, "policyReason", &format!("{label}.policyReason"))?;
    let text_source_kind = assert_required_one_of(
        decision,
        "textSourceKind",
        &[
            "metadata",
            "manual_transcription",
            "ocr_hint",
            "not_applicable",
        ],
        &format!("{label}.textSourceKind"),
    )?;
    let patch_mode = assert_required_one_of(
        decision,
        "patchMode",
        &[
            "metadata_only",
            "no_patch_required",
            "region_redraw_required",
            "asset_replacement_required",
            "font_substitution_required",
            "unsupported",
        ],
        &format!("{label}.patchMode"),
    )?;
    if let Some(runtime_expectation) = decision.get("runtimeExpectation") {
        validate_runtime_expectation(runtime_expectation, &format!("{label}.runtimeExpectation"))?;
    } else {
        return error(format!("{label}.runtimeExpectation must be an object"));
    }
    if let Some(review_required) = decision.get("reviewRequired")
        && review_required.as_bool().is_none()
    {
        return error(format!("{label}.reviewRequired must be a boolean"));
    }
    if let Some(refs) = decision.get("linkedBridgeUnitRefs") {
        let refs = array_value(refs, &format!("{label}.linkedBridgeUnitRefs"))?;
        for (index, unit_ref) in refs.iter().enumerate() {
            validate_runtime_bridge_unit_ref(
                unit_ref,
                &format!("{label}.linkedBridgeUnitRefs[{index}]"),
            )?;
        }
    }
    if let Some(notes) = decision.get("notes") {
        assert_string_array(notes, &format!("{label}.notes"))?;
    }

    let has_text_source = text_source_kind != "not_applicable";
    if (policy_action == "localize" || policy_action == "romanize")
        && has_text_source
        && decision.get("targetText").is_none()
    {
        return error(format!(
            "{label}.targetText is required for localized or romanized asset text"
        ));
    }
    if policy_action == "romanize" && decision.get("romanizationSystem").is_none() {
        return error(format!(
            "{label}.romanizationSystem is required for romanize asset policies"
        ));
    }
    if policy_action == "do_not_translate"
        && has_text_source
        && decision.get("preserveForm").is_none()
        && decision.get("sourceText").is_none()
    {
        return error(format!(
            "{label}.preserveForm or sourceText is required for do_not_translate"
        ));
    }
    if text_source_kind == "not_applicable" && !["ui_art", "font", "video"].contains(&surface_kind)
    {
        return error(format!(
            "{label}.textSourceKind not_applicable is only valid for textless asset policy surfaces"
        ));
    }
    if text_source_kind != "not_applicable" && decision.get("sourceText").is_none() {
        return error(format!(
            "{label}.sourceText is required when textSourceKind is text-bearing"
        ));
    }
    if text_source_kind == "ocr_hint" && !["image_text", "ui_art", "video"].contains(&surface_kind)
    {
        return error(format!(
            "{label}.textSourceKind ocr_hint is only valid for visual asset surfaces"
        ));
    }

    let runtime_expectation = required_record(
        decision,
        "runtimeExpectation",
        &format!("{label}.runtimeExpectation"),
    )?;
    if patch_mode == "metadata_only"
        && string_field(runtime_expectation, "expectationKind")? != "metadata_only"
    {
        return error(format!(
            "{label}.patchMode metadata_only requires runtimeExpectation.expectationKind metadata_only"
        ));
    }
    if (patch_mode == "unsupported" || patch_mode == "no_patch_required")
        && decision.get("patchRef").is_some()
    {
        return error(format!("{label}.patchRef must be omitted for {patch_mode}"));
    }
    if let Some(patch_ref) = decision.get("patchRef") {
        validate_asset_policy_patch_ref(patch_ref, &format!("{label}.patchRef"))?;
        let write_mode = string_field(
            as_record(patch_ref, &format!("{label}.patchRef"))?,
            "writeMode",
        )?;
        let allowed_write_modes = match patch_mode {
            "metadata_only" => Some(&["metadata"][..]),
            "region_redraw_required" => Some(&["update_region"][..]),
            "asset_replacement_required" => Some(&["replace_asset"][..]),
            "font_substitution_required" => Some(&["replace_asset", "metadata"][..]),
            _ => None,
        };
        if let Some(allowed_write_modes) = allowed_write_modes
            && !allowed_write_modes.contains(&write_mode)
        {
            return error(format!(
                "{label}.patchRef.writeMode must be {} for {patch_mode}",
                allowed_write_modes.join(" or ")
            ));
        }
    }

    let source_asset = assets_by_id.get(source_asset_id).ok_or_else(|| {
        BridgeContractValidationError::new(format!(
            "{label}.sourceAssetRef.assetId must reference an asset in asset policy assets"
        ))
    })?;
    if let Some(asset_key) = source_asset_ref.get("assetKey") {
        let asset_key = string_value(asset_key, &format!("{label}.sourceAssetRef.assetKey"))?;
        if asset_key != source_asset.asset_key {
            return error(format!(
                "{label}.sourceAssetRef.assetKey must match the referenced asset"
            ));
        }
    }
    if !asset_kinds_for_asset_policy_surface(surface_kind)
        .contains(&source_asset.asset_kind.as_str())
    {
        return error(format!(
            "{label}.assetSurfaceKind {surface_kind} is not valid for assetKind {}",
            source_asset.asset_kind
        ));
    }
    assert_revision_matches_summary(
        required(
            decision,
            "sourceRevision",
            &format!("{label}.sourceRevision"),
        )?,
        source_asset,
        &format!("{label}.sourceRevision"),
    )?;
    if let Some(patch_ref) = decision.get("patchRef") {
        let patch_ref = as_record(patch_ref, &format!("{label}.patchRef"))?;
        let patch_asset_id =
            assert_required_uuid7(patch_ref, "assetId", &format!("{label}.patchRef.assetId"))?;
        let patch_asset = assets_by_id.get(patch_asset_id).ok_or_else(|| {
            BridgeContractValidationError::new(format!(
                "{label}.patchRef.assetId must reference an asset in asset policy assets"
            ))
        })?;
        assert_revision_matches_summary(
            required(
                patch_ref,
                "sourceRevision",
                &format!("{label}.patchRef.sourceRevision"),
            )?,
            patch_asset,
            &format!("{label}.patchRef.sourceRevision"),
        )?;
        let allowed_kinds = asset_kinds_for_asset_policy_patch(surface_kind, patch_mode);
        if !allowed_kinds.contains(&patch_asset.asset_kind.as_str()) {
            return error(format!(
                "{label}.patchRef.assetId assetKind {} is not valid for {patch_mode} on {surface_kind}",
                patch_asset.asset_kind
            ));
        }
    }
    Ok(())
}

fn validate_asset_policy_patch_ref(value: &Value, label: &str) -> BridgeContractResult<()> {
    let patch_ref = as_record(value, label)?;
    assert_required_uuid7(patch_ref, "assetId", &format!("{label}.assetId"))?;
    assert_required_one_of(
        patch_ref,
        "writeMode",
        PATCH_WRITE_MODES,
        &format!("{label}.writeMode"),
    )?;
    if let Some(source_unit_key) = patch_ref.get("sourceUnitKey") {
        string_value(source_unit_key, &format!("{label}.sourceUnitKey"))?;
    }
    validate_source_revision(
        required(
            patch_ref,
            "sourceRevision",
            &format!("{label}.sourceRevision"),
        )?,
        &format!("{label}.sourceRevision"),
    )?;
    if let Some(constraints) = patch_ref.get("constraints") {
        assert_string_array(constraints, &format!("{label}.constraints"))?;
    }
    Ok(())
}

fn validate_locale_branch_scope(value: &Value, label: &str) -> BridgeContractResult<()> {
    let scope = as_record(value, label)?;
    assert_required_uuid7(scope, "localeBranchId", &format!("{label}.localeBranchId"))?;
    assert_required_string(scope, "targetLocale", &format!("{label}.targetLocale"))?;
    if let Some(locale_branch_key) = scope.get("localeBranchKey") {
        string_value(locale_branch_key, &format!("{label}.localeBranchKey"))?;
    }
    Ok(())
}

fn validate_bridge_asset(
    value: &Value,
    label: &str,
) -> BridgeContractResult<(String, AssetSummary)> {
    let asset = as_record(value, label)?;
    let asset_id = assert_required_uuid7(asset, "assetId", &format!("{label}.assetId"))?;
    let asset_key = assert_required_string(asset, "assetKey", &format!("{label}.assetKey"))?;
    let asset_kind = assert_required_one_of(
        asset,
        "assetKind",
        &[
            "script",
            "image",
            "audio",
            "video",
            "ui_texture",
            "font",
            "database",
            "metadata",
            "text",
        ],
        &format!("{label}.assetKind"),
    )?;
    let source_hash = assert_required_hash(asset, "sourceHash", &format!("{label}.sourceHash"))?;
    let source_revision = required(asset, "sourceRevision", &format!("{label}.sourceRevision"))?;
    validate_source_revision(source_revision, &format!("{label}.sourceRevision"))?;
    assert_revision_hash_matches(
        source_revision,
        source_hash,
        &format!("{label}.sourceRevision"),
    )?;
    if let Some(path) = asset.get("path") {
        string_value(path, &format!("{label}.path"))?;
    }
    let source_revision = as_record(source_revision, &format!("{label}.sourceRevision"))?;
    Ok((
        asset_id.to_string(),
        AssetSummary {
            asset_key: asset_key.to_string(),
            asset_kind: asset_kind.to_string(),
            source_revision_id: string_field(source_revision, "revisionId")?.to_string(),
            source_revision_value: string_field(source_revision, "value")?.to_string(),
        },
    ))
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

fn validate_runtime_trace_event(value: &Value, label: &str) -> BridgeContractResult<()> {
    let event = as_record(value, label)?;
    assert_required_uuid7(event, "traceEventId", &format!("{label}.traceEventId"))?;
    assert_required_one_of(
        event,
        "eventKind",
        &[
            "scene_entered",
            "text_observed",
            "branch_point_reached",
            "capture_requested",
        ],
        &format!("{label}.eventKind"),
    )?;
    validate_runtime_bridge_unit_ref(
        required(event, "bridgeUnitRef", &format!("{label}.bridgeUnitRef"))?,
        &format!("{label}.bridgeUnitRef"),
    )?;
    assert_required_non_negative_integer(event, "frame", &format!("{label}.frame"))?;
    for key in ["traceKey", "observedText"] {
        if let Some(value) = event.get(key) {
            string_value(value, &format!("{label}.{key}"))?;
        }
    }
    if let Some(artifact_ref) = event.get("artifactRef") {
        validate_runtime_artifact_ref(artifact_ref, &format!("{label}.artifactRef"), None)?;
    }
    Ok(())
}

fn validate_runtime_branch_event(value: &Value, label: &str) -> BridgeContractResult<()> {
    let event = as_record(value, label)?;
    assert_required_uuid7(event, "branchEventId", &format!("{label}.branchEventId"))?;
    validate_runtime_bridge_unit_ref(
        required(event, "bridgeUnitRef", &format!("{label}.bridgeUnitRef"))?,
        &format!("{label}.bridgeUnitRef"),
    )?;
    assert_required_non_negative_integer(event, "frame", &format!("{label}.frame"))?;
    for key in ["branchPointKey", "promptText"] {
        if let Some(value) = event.get(key) {
            string_value(value, &format!("{label}.{key}"))?;
        }
    }
    let options = required_array(event, "options", &format!("{label}.options"))?;
    if options.is_empty() {
        return error(format!(
            "{label}.options must contain at least one branch option"
        ));
    }
    let mut option_ids = HashSet::new();
    for (index, option) in options.iter().enumerate() {
        let option_label = format!("{label}.options[{index}]");
        let option_id = validate_runtime_branch_option(option, &option_label)?;
        if !option_ids.insert(option_id) {
            return error(format!(
                "{option_label}.optionId must be unique within {label}.options"
            ));
        }
    }
    if let Some(selected_option_id) = event.get("selectedOptionId") {
        let selected_option_id =
            string_value(selected_option_id, &format!("{label}.selectedOptionId"))?;
        assert_uuid7(selected_option_id, &format!("{label}.selectedOptionId"))?;
        if !option_ids.contains(selected_option_id) {
            return error(format!(
                "{label}.selectedOptionId must reference an option in {label}.options"
            ));
        }
    }
    Ok(())
}

fn validate_runtime_branch_option(value: &Value, label: &str) -> BridgeContractResult<String> {
    let option = as_record(value, label)?;
    let option_id = assert_required_uuid7(option, "optionId", &format!("{label}.optionId"))?;
    if let Some(label_value) = option.get("label") {
        string_value(label_value, &format!("{label}.label"))?;
    }
    if let Some(label_ref) = option.get("labelBridgeUnitRef") {
        validate_runtime_bridge_unit_ref(label_ref, &format!("{label}.labelBridgeUnitRef"))?;
    }
    if let Some(target_route_key) = option.get("targetRouteKey") {
        string_value(target_route_key, &format!("{label}.targetRouteKey"))?;
    }
    if let Some(target_ref) = option.get("targetBridgeUnitRef") {
        validate_runtime_bridge_unit_ref(target_ref, &format!("{label}.targetBridgeUnitRef"))?;
    }
    Ok(option_id.to_string())
}

fn validate_runtime_capture(value: &Value, label: &str) -> BridgeContractResult<()> {
    let capture = as_record(value, label)?;
    assert_required_uuid7(capture, "captureId", &format!("{label}.captureId"))?;
    validate_runtime_bridge_unit_ref(
        required(capture, "bridgeUnitRef", &format!("{label}.bridgeUnitRef"))?,
        &format!("{label}.bridgeUnitRef"),
    )?;
    let evidence_tier = assert_required_one_of(
        capture,
        "evidenceTier",
        RUNTIME_EVIDENCE_TIERS,
        &format!("{label}.evidenceTier"),
    )?;
    assert_minimum_runtime_evidence_tier(evidence_tier, "E2", &format!("{label}.evidenceTier"))?;
    assert_required_non_negative_integer(capture, "frame", &format!("{label}.frame"))?;
    assert_required_positive_integer(capture, "width", &format!("{label}.width"))?;
    assert_required_positive_integer(capture, "height", &format!("{label}.height"))?;
    if let Some(non_zero_pixels) = capture.get("nonZeroPixels") {
        non_negative_integer_value(non_zero_pixels, &format!("{label}.nonZeroPixels"))?;
    }
    if let Some(region) = capture.get("region") {
        validate_pixel_region(region, &format!("{label}.region"))?;
    }
    validate_runtime_artifact_ref(
        required(capture, "artifactRef", &format!("{label}.artifactRef"))?,
        &format!("{label}.artifactRef"),
        Some("screenshot"),
    )
}

fn validate_runtime_recording(value: &Value, label: &str) -> BridgeContractResult<()> {
    let recording = as_record(value, label)?;
    assert_required_uuid7(recording, "recordingId", &format!("{label}.recordingId"))?;
    validate_runtime_bridge_unit_ref(
        required(
            recording,
            "bridgeUnitRef",
            &format!("{label}.bridgeUnitRef"),
        )?,
        &format!("{label}.bridgeUnitRef"),
    )?;
    let evidence_tier = assert_required_one_of(
        recording,
        "evidenceTier",
        RUNTIME_EVIDENCE_TIERS,
        &format!("{label}.evidenceTier"),
    )?;
    assert_minimum_runtime_evidence_tier(evidence_tier, "E3", &format!("{label}.evidenceTier"))?;
    assert_required_non_negative_integer(
        recording,
        "startedAtFrame",
        &format!("{label}.startedAtFrame"),
    )?;
    assert_required_positive_integer(recording, "frameCount", &format!("{label}.frameCount"))?;
    assert_required_positive_integer(recording, "width", &format!("{label}.width"))?;
    assert_required_positive_integer(recording, "height", &format!("{label}.height"))?;
    assert_required_string(recording, "encoding", &format!("{label}.encoding"))?;
    validate_runtime_artifact_ref(
        required(recording, "artifactRef", &format!("{label}.artifactRef"))?,
        &format!("{label}.artifactRef"),
        Some("recording"),
    )
}

fn validate_runtime_approximation(value: &Value, label: &str) -> BridgeContractResult<()> {
    let approximation = as_record(value, label)?;
    assert_required_uuid7(
        approximation,
        "approximationId",
        &format!("{label}.approximationId"),
    )?;
    assert_required_one_of(
        approximation,
        "approximationTier",
        &[
            "none",
            "deterministic_fixture",
            "layout_probe",
            "engine_partial",
            "reference_matched",
        ],
        &format!("{label}.approximationTier"),
    )?;
    assert_required_string(approximation, "scope", &format!("{label}.scope"))?;
    assert_required_string(
        approximation,
        "description",
        &format!("{label}.description"),
    )?;
    let refs = required_array(
        approximation,
        "affectedBridgeUnitRefs",
        &format!("{label}.affectedBridgeUnitRefs"),
    )?;
    if refs.is_empty() {
        return error(format!(
            "{label}.affectedBridgeUnitRefs must contain at least one bridge unit ref"
        ));
    }
    for (index, unit_ref) in refs.iter().enumerate() {
        validate_runtime_bridge_unit_ref(
            unit_ref,
            &format!("{label}.affectedBridgeUnitRefs[{index}]"),
        )?;
    }
    assert_required_one_of(
        approximation,
        "evidenceTierCeiling",
        RUNTIME_EVIDENCE_TIERS,
        &format!("{label}.evidenceTierCeiling"),
    )?;
    Ok(())
}

fn validate_runtime_validation_finding(value: &Value, label: &str) -> BridgeContractResult<()> {
    let finding = as_record(value, label)?;
    assert_required_uuid7(finding, "findingId", &format!("{label}.findingId"))?;
    assert_required_one_of(
        finding,
        "findingKind",
        &[
            "missing_trace",
            "missing_capture",
            "text_mismatch",
            "artifact_unreadable",
            "unsupported_runtime_feature",
            "schema_violation",
        ],
        &format!("{label}.findingKind"),
    )?;
    assert_required_one_of(
        finding,
        "severity",
        TRIAGE_SEVERITIES,
        &format!("{label}.severity"),
    )?;
    if let Some(unit_ref) = finding.get("bridgeUnitRef") {
        validate_runtime_bridge_unit_ref(unit_ref, &format!("{label}.bridgeUnitRef"))?;
    }
    if let Some(artifact_ref) = finding.get("artifactRef") {
        validate_runtime_artifact_ref(artifact_ref, &format!("{label}.artifactRef"), None)?;
    }
    assert_required_string(finding, "message", &format!("{label}.message"))?;
    assert_required_one_of(
        finding,
        "evidenceTier",
        RUNTIME_EVIDENCE_TIERS,
        &format!("{label}.evidenceTier"),
    )?;
    Ok(())
}

fn validate_runtime_reference_comparison(value: &Value, label: &str) -> BridgeContractResult<bool> {
    let comparison = as_record(value, label)?;
    assert_required_uuid7(comparison, "comparisonId", &format!("{label}.comparisonId"))?;
    assert_required_one_of(
        comparison,
        "comparisonKind",
        &["reference_runtime", "conformance_fixture"],
        &format!("{label}.comparisonKind"),
    )?;
    let status = assert_required_one_of(
        comparison,
        "status",
        &["passed", "failed"],
        &format!("{label}.status"),
    )?;
    assert_required_string(comparison, "scope", &format!("{label}.scope"))?;
    let refs = required_array(
        comparison,
        "coveredBridgeUnitRefs",
        &format!("{label}.coveredBridgeUnitRefs"),
    )?;
    if refs.is_empty() {
        return error(format!(
            "{label}.coveredBridgeUnitRefs must contain at least one bridge unit ref"
        ));
    }
    for (index, unit_ref) in refs.iter().enumerate() {
        validate_runtime_bridge_unit_ref(
            unit_ref,
            &format!("{label}.coveredBridgeUnitRefs[{index}]"),
        )?;
    }
    validate_runtime_artifact_ref(
        required(comparison, "artifactRef", &format!("{label}.artifactRef"))?,
        &format!("{label}.artifactRef"),
        Some("reference_comparison"),
    )?;
    Ok(status == "passed")
}

fn validate_runtime_bridge_unit_ref(value: &Value, label: &str) -> BridgeContractResult<()> {
    let unit_ref = as_record(value, label)?;
    assert_required_string(unit_ref, "bridgeUnitId", &format!("{label}.bridgeUnitId"))?;
    if let Some(source_unit_key) = unit_ref.get("sourceUnitKey") {
        string_value(source_unit_key, &format!("{label}.sourceUnitKey"))?;
    }
    Ok(())
}

fn validate_runtime_artifact_ref(
    value: &Value,
    label: &str,
    expected_kind: Option<&str>,
) -> BridgeContractResult<()> {
    let artifact_ref = as_record(value, label)?;
    assert_required_uuid7(artifact_ref, "artifactId", &format!("{label}.artifactId"))?;
    let kind = assert_required_one_of(
        artifact_ref,
        "artifactKind",
        &[
            "trace_log",
            "screenshot",
            "recording",
            "capture_metadata",
            "reference_comparison",
            "runtime_report",
        ],
        &format!("{label}.artifactKind"),
    )?;
    if let Some(expected_kind) = expected_kind
        && kind != expected_kind
    {
        return error(format!("{label}.artifactKind must be {expected_kind}"));
    }
    assert_portable_uri(
        required(artifact_ref, "uri", &format!("{label}.uri"))?,
        &format!("{label}.uri"),
    )?;
    if let Some(hash) = artifact_ref.get("hash") {
        assert_hash_value(hash, &format!("{label}.hash"))?;
    }
    if let Some(media_type) = artifact_ref.get("mediaType") {
        string_value(media_type, &format!("{label}.mediaType"))?;
    }
    if let Some(byte_size) = artifact_ref.get("byteSize") {
        positive_integer_value(byte_size, &format!("{label}.byteSize"))?;
    }
    Ok(())
}

fn validate_observation_hook_event(
    value: &Value,
    label: &str,
    report_evidence_tier: &str,
) -> BridgeContractResult<()> {
    let event = as_record(value, label)?;
    assert_literal(
        event,
        "schemaVersion",
        OBSERVATION_HOOK_SCHEMA_VERSION,
        &format!("{label}.schemaVersion"),
    )?;
    assert_required_string(event, "eventId", &format!("{label}.eventId"))?;
    assert_required_rfc3339(event, "observedAt", &format!("{label}.observedAt"))?;
    let event_kind = assert_required_one_of(
        event,
        "eventKind",
        OBSERVATION_HOOK_EVENT_KINDS,
        &format!("{label}.eventKind"),
    )?;
    assert_required_string(
        event,
        "runtimeTargetId",
        &format!("{label}.runtimeTargetId"),
    )?;
    validate_observation_adapter_id(
        required(event, "adapterId", &format!("{label}.adapterId"))?,
        &format!("{label}.adapterId"),
    )?;
    let evidence_tier = assert_required_one_of(
        event,
        "evidenceTier",
        RUNTIME_EVIDENCE_TIERS,
        &format!("{label}.evidenceTier"),
    )?;
    assert_maximum_runtime_evidence_tier(
        evidence_tier,
        report_evidence_tier,
        &format!("{label}.evidenceTier"),
    )?;
    validate_observation_environment(
        required(event, "environment", &format!("{label}.environment"))?,
        &format!("{label}.environment"),
    )?;
    if let Some(source_revision) = event.get("sourceRevision") {
        validate_observation_source_revision(source_revision, &format!("{label}.sourceRevision"))?;
    }
    let bridge_refs = optional_array(event, "bridgeRefs", &format!("{label}.bridgeRefs"))?;
    for (index, bridge_ref) in bridge_refs.iter().enumerate() {
        validate_observation_bridge_ref(bridge_ref, &format!("{label}.bridgeRefs[{index}]"))?;
    }
    validate_observation_redaction_metadata(
        required(event, "redaction", &format!("{label}.redaction"))?,
        &format!("{label}.redaction"),
    )?;
    let payload_kind = validate_observation_hook_payload(
        required(event, "payload", &format!("{label}.payload"))?,
        &format!("{label}.payload"),
    )?;
    if event_kind != payload_kind {
        return error(format!(
            "{label}.eventKind must match {label}.payload.payloadKind"
        ));
    }
    Ok(())
}

fn validate_observation_adapter_id(value: &Value, label: &str) -> BridgeContractResult<()> {
    let adapter_id = as_record(value, label)?;
    assert_required_string(adapter_id, "name", &format!("{label}.name"))?;
    assert_required_string(adapter_id, "version", &format!("{label}.version"))?;
    Ok(())
}

fn validate_observation_environment(value: &Value, label: &str) -> BridgeContractResult<()> {
    let environment = as_record(value, label)?;
    assert_required_string(environment, "runtime", &format!("{label}.runtime"))?;
    for key in ["engine", "platform", "display", "locale"] {
        if let Some(value) = environment.get(key) {
            string_value(value, &format!("{label}.{key}"))?;
        }
    }
    Ok(())
}

fn validate_observation_source_revision(value: &Value, label: &str) -> BridgeContractResult<()> {
    let source_revision = as_record(value, label)?;
    assert_required_string(source_revision, "sourceId", &format!("{label}.sourceId"))?;
    for key in ["revisionId", "contentHash"] {
        if let Some(value) = source_revision.get(key) {
            string_value(value, &format!("{label}.{key}"))?;
        }
    }
    Ok(())
}

fn validate_observation_bridge_ref(value: &Value, label: &str) -> BridgeContractResult<()> {
    let bridge_ref = as_record(value, label)?;
    let bridge_unit_id =
        optional_string(bridge_ref, "bridgeUnitId", &format!("{label}.bridgeUnitId"))?;
    let source_unit_key = optional_string(
        bridge_ref,
        "sourceUnitKey",
        &format!("{label}.sourceUnitKey"),
    )?;
    let runtime_object_id = optional_string(
        bridge_ref,
        "runtimeObjectId",
        &format!("{label}.runtimeObjectId"),
    )?;
    if is_blank_string(bridge_unit_id)
        && is_blank_string(source_unit_key)
        && is_blank_string(runtime_object_id)
    {
        return error(format!(
            "{label} must identify a bridge unit, source unit, or runtime object"
        ));
    }
    Ok(())
}

fn validate_observation_redaction_metadata(value: &Value, label: &str) -> BridgeContractResult<()> {
    let redaction = as_record(value, label)?;
    let status = assert_required_one_of(
        redaction,
        "status",
        OBSERVATION_REDACTION_STATUSES,
        &format!("{label}.status"),
    )?;
    let rules = optional_array(redaction, "rules", &format!("{label}.rules"))?;
    let redacted_fields = optional_array(
        redaction,
        "redactedFields",
        &format!("{label}.redactedFields"),
    )?;
    for (index, rule) in rules.iter().enumerate() {
        non_blank_string_value(rule, &format!("{label}.rules[{index}]"))?;
    }
    for (index, field) in redacted_fields.iter().enumerate() {
        non_blank_string_value(field, &format!("{label}.redactedFields[{index}]"))?;
    }
    if status == "not_required" && (!rules.is_empty() || !redacted_fields.is_empty()) {
        return error(format!(
            "{label} with status not_required must not declare redaction rules or fields"
        ));
    }
    if status == "redacted" && (rules.is_empty() || redacted_fields.is_empty()) {
        return error(format!(
            "{label} with status redacted must declare rules and redactedFields"
        ));
    }
    Ok(())
}

fn validate_observation_hook_payload<'a>(
    value: &'a Value,
    label: &str,
) -> BridgeContractResult<&'a str> {
    let payload = as_record(value, label)?;
    let payload_kind = assert_required_one_of(
        payload,
        "payloadKind",
        OBSERVATION_HOOK_EVENT_KINDS,
        &format!("{label}.payloadKind"),
    )?;
    match payload_kind {
        "text" => {
            assert_required_string(payload, "text", &format!("{label}.text"))?;
            for key in ["speaker", "textSurface"] {
                if let Some(value) = payload.get(key) {
                    string_value(value, &format!("{label}.{key}"))?;
                }
            }
        }
        "choice" => {
            if let Some(prompt) = payload.get("prompt") {
                string_value(prompt, &format!("{label}.prompt"))?;
            }
            let options = required_array(payload, "options", &format!("{label}.options"))?;
            if options.is_empty() {
                return error(format!("{label}.options must include at least one option"));
            }
            for (index, option) in options.iter().enumerate() {
                validate_observation_choice_option(option, &format!("{label}.options[{index}]"))?;
            }
        }
        "branch" => {
            assert_required_string(payload, "branchId", &format!("{label}.branchId"))?;
            for key in ["label", "destination"] {
                if let Some(value) = payload.get(key) {
                    string_value(value, &format!("{label}.{key}"))?;
                }
            }
            if let Some(taken) = payload.get("taken")
                && taken.as_bool().is_none()
            {
                return error(format!("{label}.taken must be a boolean"));
            }
        }
        "scene" => {
            assert_required_string(payload, "sceneId", &format!("{label}.sceneId"))?;
            if let Some(scene_name) = payload.get("sceneName") {
                string_value(scene_name, &format!("{label}.sceneName"))?;
            }
        }
        "frame" => {
            assert_required_non_negative_integer(payload, "frame", &format!("{label}.frame"))?;
            if let Some(width) = payload.get("width") {
                positive_integer_value(width, &format!("{label}.width"))?;
            }
            if let Some(height) = payload.get("height") {
                positive_integer_value(height, &format!("{label}.height"))?;
            }
            if let Some(artifact_ref) = payload.get("artifactRef") {
                validate_observation_artifact_ref(artifact_ref, &format!("{label}.artifactRef"))?;
            }
        }
        "error" => {
            assert_required_string(payload, "errorType", &format!("{label}.errorType"))?;
            assert_required_string(payload, "message", &format!("{label}.message"))?;
            required(payload, "fatal", &format!("{label}.fatal"))?
                .as_bool()
                .ok_or_else(|| {
                    BridgeContractValidationError::new(format!("{label}.fatal must be a boolean"))
                })?;
            if let Some(stack) = payload.get("stack") {
                string_value(stack, &format!("{label}.stack"))?;
            }
        }
        _ => unreachable!("payload kind was validated above"),
    }
    Ok(payload_kind)
}

fn validate_observation_choice_option(value: &Value, label: &str) -> BridgeContractResult<()> {
    let option = as_record(value, label)?;
    assert_required_string(option, "optionId", &format!("{label}.optionId"))?;
    assert_required_string(option, "label", &format!("{label}.label"))?;
    if let Some(bridge_ref) = option.get("bridgeRef") {
        validate_observation_bridge_ref(bridge_ref, &format!("{label}.bridgeRef"))?;
    }
    Ok(())
}

fn validate_observation_artifact_ref(value: &Value, label: &str) -> BridgeContractResult<()> {
    let artifact_ref = as_record(value, label)?;
    assert_required_string(artifact_ref, "artifactId", &format!("{label}.artifactId"))?;
    assert_required_string(
        artifact_ref,
        "artifactKind",
        &format!("{label}.artifactKind"),
    )?;
    assert_portable_uri(
        required(artifact_ref, "uri", &format!("{label}.uri"))?,
        &format!("{label}.uri"),
    )?;
    if let Some(media_type) = artifact_ref.get("mediaType") {
        string_value(media_type, &format!("{label}.mediaType"))?;
    }
    Ok(())
}

fn validate_runtime_expectation(value: &Value, label: &str) -> BridgeContractResult<()> {
    let expectation = as_record(value, label)?;
    assert_required_one_of(
        expectation,
        "expectationKind",
        &[
            "trace_text",
            "layout_probe",
            "screenshot_region",
            "metadata_only",
        ],
        &format!("{label}.expectationKind"),
    )?;
    if let Some(region) = expectation.get("region") {
        validate_pixel_region(region, &format!("{label}.region"))?;
    }
    if let Some(trace_key) = expectation.get("traceKey") {
        string_value(trace_key, &format!("{label}.traceKey"))?;
    }
    Ok(())
}

fn validate_source_location(value: &Value, label: &str) -> BridgeContractResult<()> {
    let location = as_record(value, label)?;
    if let Some(container_key) = location.get("containerKey") {
        string_value(container_key, &format!("{label}.containerKey"))?;
    }
    if let Some(entry_path) = location.get("entryPath") {
        assert_string_array(entry_path, &format!("{label}.entryPath"))?;
    }
    if let Some(range) = location.get("range") {
        let range = as_record(range, &format!("{label}.range"))?;
        let start = assert_required_non_negative_integer(
            range,
            "startByte",
            &format!("{label}.range.startByte"),
        )?;
        let end = assert_required_non_negative_integer(
            range,
            "endByte",
            &format!("{label}.range.endByte"),
        )?;
        if end <= start {
            return error(format!(
                "{label}.range.endByte must be greater than {label}.range.startByte"
            ));
        }
    }
    if let Some(region) = location.get("region") {
        validate_pixel_region(region, &format!("{label}.region"))?;
    }
    Ok(())
}

fn validate_pixel_region(value: &Value, label: &str) -> BridgeContractResult<()> {
    let region = as_record(value, label)?;
    assert_required_non_negative_integer(region, "x", &format!("{label}.x"))?;
    assert_required_non_negative_integer(region, "y", &format!("{label}.y"))?;
    assert_required_positive_integer(region, "width", &format!("{label}.width"))?;
    assert_required_positive_integer(region, "height", &format!("{label}.height"))?;
    Ok(())
}

fn validate_triage_event(
    value: &Value,
    label: &str,
    prior_event_ids: &HashSet<String>,
) -> BridgeContractResult<String> {
    assert_no_mutable_event_bucket_fields(value, label)?;
    let event = as_record(value, label)?;
    let event_id = assert_required_uuid7(event, "eventId", &format!("{label}.eventId"))?;
    assert_required_one_of(
        event,
        "eventKind",
        &[
            "task_requested",
            "task_started",
            "model_output_recorded",
            "qa_finding_reported",
            "patch_result_recorded",
            "triage_decision_recorded",
            "repair_requested",
            "finding_superseded",
        ],
        &format!("{label}.eventKind"),
    )?;
    assert_required_rfc3339(event, "occurredAt", &format!("{label}.occurredAt"))?;
    validate_triage_actor(
        required(event, "actor", &format!("{label}.actor"))?,
        &format!("{label}.actor"),
    )?;
    for key in ["taskId", "findingId"] {
        if let Some(value) = event.get(key) {
            assert_uuid7_value(value, &format!("{label}.{key}"))?;
        }
    }
    validate_triage_subject_refs(
        required(event, "subjectRefs", &format!("{label}.subjectRefs"))?,
        &format!("{label}.subjectRefs"),
    )?;
    validate_provenance_array(
        required(event, "provenance", &format!("{label}.provenance"))?,
        &format!("{label}.provenance"),
    )?;
    validate_causal_links(
        required(event, "causalLinks", &format!("{label}.causalLinks"))?,
        &format!("{label}.causalLinks"),
    )?;
    let causal_links = array_value(
        required(event, "causalLinks", &format!("{label}.causalLinks"))?,
        &format!("{label}.causalLinks"),
    )?;
    for (index, link) in causal_links.iter().enumerate() {
        let link = as_record(link, &format!("{label}.causalLinks[{index}]"))?;
        if string_field(link, "targetKind")? == "event" {
            let target_id = string_field(link, "targetId")?;
            if !prior_event_ids.contains(target_id) {
                return error(format!(
                    "{label}.causalLinks[{index}].targetId must reference a prior event"
                ));
            }
        }
    }
    if let Some(payload) = event.get("payload") {
        as_record(payload, &format!("{label}.payload"))?;
    }
    Ok(event_id.to_string())
}

fn validate_triage_task(value: &Value, label: &str) -> BridgeContractResult<String> {
    let task = as_record(value, label)?;
    let task_id = assert_required_uuid7(task, "taskId", &format!("{label}.taskId"))?;
    assert_required_one_of(
        task,
        "taskKind",
        &[
            "extract",
            "draft_translation",
            "deterministic_qa",
            "llm_qa",
            "patch",
            "runtime_verify",
            "human_review",
            "repair",
        ],
        &format!("{label}.taskKind"),
    )?;
    assert_required_rfc3339(task, "createdAt", &format!("{label}.createdAt"))?;
    assert_required_string(task, "summary", &format!("{label}.summary"))?;
    if let Some(created_by_event_id) = task.get("createdByEventId") {
        assert_uuid7_value(created_by_event_id, &format!("{label}.createdByEventId"))?;
    }
    validate_triage_subject_refs(
        required(task, "inputRefs", &format!("{label}.inputRefs"))?,
        &format!("{label}.inputRefs"),
    )?;
    validate_provenance_array(
        required(task, "provenance", &format!("{label}.provenance"))?,
        &format!("{label}.provenance"),
    )?;
    validate_causal_links(
        required(task, "causalLinks", &format!("{label}.causalLinks"))?,
        &format!("{label}.causalLinks"),
    )?;
    Ok(task_id.to_string())
}

fn validate_finding_record(value: &Value, label: &str) -> BridgeContractResult<String> {
    let finding = as_record(value, label)?;
    let finding_id = assert_required_uuid7(finding, "findingId", &format!("{label}.findingId"))?;
    assert_required_one_of(
        finding,
        "findingKind",
        &[
            "source_annotation_issue",
            "style_guide_violation",
            "model_output_issue",
            "patching_issue",
            "runtime_issue",
            "policy_issue",
            "protected_span_issue",
        ],
        &format!("{label}.findingKind"),
    )?;
    assert_required_one_of(
        finding,
        "severity",
        TRIAGE_SEVERITIES,
        &format!("{label}.severity"),
    )?;
    if let Some(category) = finding.get("qualityCategory") {
        let category = string_value(category, &format!("{label}.qualityCategory"))?;
        assert_one_of(
            category,
            LOCALIZATION_QUALITY_CATEGORIES,
            &format!("{label}.qualityCategory"),
        )?;
    }
    for key in ["title", "description", "impact"] {
        assert_required_string(finding, key, &format!("{label}.{key}"))?;
    }
    assert_required_rfc3339(finding, "createdAt", &format!("{label}.createdAt"))?;
    for key in ["reportedByTaskId", "firstSeenEventId"] {
        if let Some(value) = finding.get(key) {
            assert_uuid7_value(value, &format!("{label}.{key}"))?;
        }
    }
    validate_triage_subject_refs(
        required(finding, "affectedRefs", &format!("{label}.affectedRefs"))?,
        &format!("{label}.affectedRefs"),
    )?;
    validate_evidence_array(
        required(finding, "evidence", &format!("{label}.evidence"))?,
        &format!("{label}.evidence"),
    )?;
    validate_provenance_array(
        required(finding, "provenance", &format!("{label}.provenance"))?,
        &format!("{label}.provenance"),
    )?;
    validate_causal_links(
        required(finding, "causalLinks", &format!("{label}.causalLinks"))?,
        &format!("{label}.causalLinks"),
    )?;
    Ok(finding_id.to_string())
}

fn validate_triage_actor(value: &Value, label: &str) -> BridgeContractResult<()> {
    let actor = as_record(value, label)?;
    assert_required_one_of(
        actor,
        "actorKind",
        &["human", "agent", "tool", "system"],
        &format!("{label}.actorKind"),
    )?;
    if let Some(actor_id) = actor.get("actorId") {
        assert_uuid7_value(actor_id, &format!("{label}.actorId"))?;
    }
    if let Some(display_name) = actor.get("displayName") {
        string_value(display_name, &format!("{label}.displayName"))?;
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

fn validate_evidence_array(value: &Value, label: &str) -> BridgeContractResult<()> {
    let evidence = array_value(value, label)?;
    if evidence.is_empty() {
        return error(format!("{label} must contain at least one evidence record"));
    }
    for (index, record) in evidence.iter().enumerate() {
        validate_evidence_record(record, &format!("{label}[{index}]"))?;
    }
    Ok(())
}

fn validate_evidence_record(value: &Value, label: &str) -> BridgeContractResult<()> {
    let evidence = as_record(value, label)?;
    assert_required_uuid7(evidence, "evidenceId", &format!("{label}.evidenceId"))?;
    assert_required_one_of(
        evidence,
        "evidenceKind",
        &[
            "text_excerpt",
            "json_pointer",
            "artifact",
            "trace",
            "screenshot_region",
            "diff",
            "validator_message",
        ],
        &format!("{label}.evidenceKind"),
    )?;
    assert_required_string(evidence, "summary", &format!("{label}.summary"))?;
    if let Some(subject_ref) = evidence.get("subjectRef") {
        validate_triage_subject_refs(
            &Value::Array(vec![subject_ref.clone()]),
            &format!("{label}.subjectRef"),
        )?;
    }
    if let Some(artifact_ref) = evidence.get("artifactRef") {
        validate_triage_artifact_ref(artifact_ref, &format!("{label}.artifactRef"))?;
    }
    if let Some(source_location) = evidence.get("sourceLocation") {
        validate_source_location(source_location, &format!("{label}.sourceLocation"))?;
    }
    for key in ["expectedValue", "observedValue"] {
        if let Some(value) = evidence.get(key) {
            string_value(value, &format!("{label}.{key}"))?;
        }
    }
    assert_uuid7_array(
        required(evidence, "provenanceIds", &format!("{label}.provenanceIds"))?,
        &format!("{label}.provenanceIds"),
    )?;
    Ok(())
}

fn validate_provenance_array(value: &Value, label: &str) -> BridgeContractResult<()> {
    let provenance = array_value(value, label)?;
    if provenance.is_empty() {
        return error(format!(
            "{label} must contain at least one provenance record"
        ));
    }
    for (index, record) in provenance.iter().enumerate() {
        validate_provenance_record(record, &format!("{label}[{index}]"))?;
    }
    Ok(())
}

fn validate_provenance_record(value: &Value, label: &str) -> BridgeContractResult<()> {
    let provenance = as_record(value, label)?;
    assert_required_uuid7(provenance, "provenanceId", &format!("{label}.provenanceId"))?;
    let kind = assert_required_one_of(
        provenance,
        "provenanceKind",
        &[
            "source_annotation",
            "style_guide",
            "model_output",
            "patching_cause",
            "runtime_evidence",
            "human_review",
            "deterministic_check",
        ],
        &format!("{label}.provenanceKind"),
    )?;
    match kind {
        "source_annotation" => {
            assert_required_uuid7(provenance, "bridgeUnitId", &format!("{label}.bridgeUnitId"))?;
            if let Some(span_id) = provenance.get("spanId") {
                assert_uuid7_value(span_id, &format!("{label}.spanId"))?;
            }
            if let Some(source_asset_ref) = provenance.get("sourceAssetRef") {
                validate_asset_ref(source_asset_ref, &format!("{label}.sourceAssetRef"))?;
            }
            if let Some(source_location) = provenance.get("sourceLocation") {
                validate_source_location(source_location, &format!("{label}.sourceLocation"))?;
            }
            if let Some(annotation_text) = provenance.get("annotationText") {
                string_value(annotation_text, &format!("{label}.annotationText"))?;
            }
            if let Some(observed_at) = provenance.get("observedAt") {
                assert_rfc3339_value(observed_at, &format!("{label}.observedAt"))?;
            }
        }
        "style_guide" => {
            assert_required_uuid7(provenance, "styleGuideId", &format!("{label}.styleGuideId"))?;
            assert_required_uuid7(
                provenance,
                "styleGuideVersionId",
                &format!("{label}.styleGuideVersionId"),
            )?;
            assert_required_string(provenance, "ruleId", &format!("{label}.ruleId"))?;
            for key in ["rulePath", "excerptHash"] {
                if let Some(value) = provenance.get(key) {
                    string_value(value, &format!("{label}.{key}"))?;
                }
            }
        }
        "model_output" => {
            assert_required_uuid7(
                provenance,
                "modelOutputId",
                &format!("{label}.modelOutputId"),
            )?;
            if let Some(task_id) = provenance.get("taskId") {
                assert_uuid7_value(task_id, &format!("{label}.taskId"))?;
            }
            for key in ["provider", "model", "outputHash"] {
                assert_required_string(provenance, key, &format!("{label}.{key}"))?;
            }
            if let Some(prompt_hash) = provenance.get("promptHash") {
                string_value(prompt_hash, &format!("{label}.promptHash"))?;
            }
            if let Some(artifact_ref) = provenance.get("artifactRef") {
                validate_triage_artifact_ref(artifact_ref, &format!("{label}.artifactRef"))?;
            }
        }
        "patching_cause" => {
            for key in ["patchResultId", "patchExportId", "bridgeUnitId"] {
                if let Some(value) = provenance.get(key) {
                    assert_uuid7_value(value, &format!("{label}.{key}"))?;
                }
            }
            if let Some(asset_ref) = provenance.get("assetRef") {
                validate_asset_ref(asset_ref, &format!("{label}.assetRef"))?;
            }
            if let Some(write_mode) = provenance.get("writeMode") {
                let write_mode = string_value(write_mode, &format!("{label}.writeMode"))?;
                assert_one_of(write_mode, PATCH_WRITE_MODES, &format!("{label}.writeMode"))?;
            }
            for key in ["failureCode", "failureDetail"] {
                if let Some(value) = provenance.get(key) {
                    string_value(value, &format!("{label}.{key}"))?;
                }
            }
            if provenance.get("patchResultId").is_none()
                && provenance.get("patchExportId").is_none()
            {
                return error(format!(
                    "{label} must include patchResultId or patchExportId"
                ));
            }
        }
        "runtime_evidence" => {
            assert_required_uuid7(
                provenance,
                "runtimeReportId",
                &format!("{label}.runtimeReportId"),
            )?;
            if let Some(bridge_unit_id) = provenance.get("bridgeUnitId") {
                assert_uuid7_value(bridge_unit_id, &format!("{label}.bridgeUnitId"))?;
            }
            if let Some(artifact_ref) = provenance.get("artifactRef") {
                validate_triage_artifact_ref(artifact_ref, &format!("{label}.artifactRef"))?;
            }
            if let Some(evidence_tier) = provenance.get("evidenceTier") {
                let evidence_tier = string_value(evidence_tier, &format!("{label}.evidenceTier"))?;
                assert_one_of(
                    evidence_tier,
                    RUNTIME_EVIDENCE_TIERS,
                    &format!("{label}.evidenceTier"),
                )?;
            }
        }
        "human_review" => {
            for key in ["reviewerId", "reviewSessionId"] {
                if let Some(value) = provenance.get(key) {
                    assert_uuid7_value(value, &format!("{label}.{key}"))?;
                }
            }
            assert_required_string(provenance, "noteHash", &format!("{label}.noteHash"))?;
        }
        "deterministic_check" => {
            assert_required_uuid7(provenance, "checkId", &format!("{label}.checkId"))?;
            assert_required_string(provenance, "checkName", &format!("{label}.checkName"))?;
            assert_required_string(provenance, "checkVersion", &format!("{label}.checkVersion"))?;
            if let Some(artifact_ref) = provenance.get("artifactRef") {
                validate_triage_artifact_ref(artifact_ref, &format!("{label}.artifactRef"))?;
            }
        }
        _ => unreachable!(),
    }
    Ok(())
}

fn validate_triage_artifact_ref(value: &Value, label: &str) -> BridgeContractResult<()> {
    let artifact = as_record(value, label)?;
    assert_required_uuid7(artifact, "artifactId", &format!("{label}.artifactId"))?;
    assert_required_string(artifact, "artifactKind", &format!("{label}.artifactKind"))?;
    for key in ["uri", "hash"] {
        if let Some(value) = artifact.get(key) {
            string_value(value, &format!("{label}.{key}"))?;
        }
    }
    Ok(())
}

fn validate_causal_links(value: &Value, label: &str) -> BridgeContractResult<()> {
    let links = array_value(value, label)?;
    for (index, link) in links.iter().enumerate() {
        let link_label = format!("{label}[{index}]");
        let link = as_record(link, &link_label)?;
        assert_required_uuid7(link, "causalLinkId", &format!("{link_label}.causalLinkId"))?;
        assert_required_one_of(
            link,
            "linkKind",
            &[
                "caused_by",
                "derived_from",
                "supersedes",
                "blocks",
                "unblocks",
            ],
            &format!("{link_label}.linkKind"),
        )?;
        assert_required_one_of(
            link,
            "targetKind",
            &["event", "task", "finding"],
            &format!("{link_label}.targetKind"),
        )?;
        assert_required_uuid7(link, "targetId", &format!("{link_label}.targetId"))?;
        if let Some(rationale) = link.get("rationale") {
            string_value(rationale, &format!("{link_label}.rationale"))?;
        }
    }
    Ok(())
}

fn collect_provenance_ids(
    value: &Value,
    provenance_ids: &mut HashSet<String>,
) -> BridgeContractResult<()> {
    let object = as_record(value, "provenance owner")?;
    let Some(provenance) = object.get("provenance") else {
        return Ok(());
    };
    for record in array_value(provenance, "provenance")? {
        let record = as_record(record, "provenance record")?;
        provenance_ids.insert(string_field(record, "provenanceId")?.to_string());
    }
    Ok(())
}

fn validate_causal_link_targets(
    owner: &Map<String, Value>,
    label: &str,
    event_ids: &HashSet<String>,
    task_ids: &HashSet<String>,
    finding_ids: &HashSet<String>,
) -> BridgeContractResult<()> {
    let links = required_array(owner, "causalLinks", label)?;
    for (index, link) in links.iter().enumerate() {
        let link = as_record(link, &format!("{label}[{index}]"))?;
        let target_kind = string_field(link, "targetKind")?;
        let target_id = string_field(link, "targetId")?;
        let known = match target_kind {
            "event" => event_ids.contains(target_id),
            "task" => task_ids.contains(target_id),
            "finding" => finding_ids.contains(target_id),
            _ => false,
        };
        if !known {
            return error(format!(
                "{label}[{index}].targetId must reference an existing triage {target_kind}"
            ));
        }
    }
    Ok(())
}

fn assert_optional_known_reference(
    value: Option<&Value>,
    label: &str,
    target_kind: &str,
    known_ids: &HashSet<String>,
) -> BridgeContractResult<()> {
    if let Some(value) = value {
        let id = string_value(value, label)?;
        assert_uuid7(id, label)?;
        if !known_ids.contains(id) {
            return error(format!(
                "{label} must reference an existing triage {target_kind}"
            ));
        }
    }
    Ok(())
}

fn validate_finding_evidence_provenance(
    finding: &Value,
    label: &str,
    all_provenance_ids: &HashSet<String>,
) -> BridgeContractResult<()> {
    let finding_record = as_record(finding, label)?;
    let finding_provenance =
        required_array(finding_record, "provenance", &format!("{label}.provenance"))?;
    let mut own_provenance_ids = HashSet::new();
    for provenance in finding_provenance {
        own_provenance_ids.insert(
            string_field(as_record(provenance, "finding provenance")?, "provenanceId")?.to_string(),
        );
    }
    let evidence = required_array(finding_record, "evidence", &format!("{label}.evidence"))?;
    for (evidence_index, evidence_record) in evidence.iter().enumerate() {
        let evidence_label = format!("{label}.evidence[{evidence_index}]");
        let evidence_record = as_record(evidence_record, &evidence_label)?;
        let provenance_ids = required_array(
            evidence_record,
            "provenanceIds",
            &format!("{evidence_label}.provenanceIds"),
        )?;
        if provenance_ids.is_empty() {
            return error(format!(
                "{evidence_label}.provenanceIds must contain at least one provenance id"
            ));
        }
        for (provenance_index, provenance_id) in provenance_ids.iter().enumerate() {
            let provenance_label = format!("{evidence_label}.provenanceIds[{provenance_index}]");
            let provenance_id = string_value(provenance_id, &provenance_label)?;
            if !all_provenance_ids.contains(provenance_id) {
                return error(format!(
                    "{provenance_label} must reference provenance in TriageBundleV02"
                ));
            }
            if !own_provenance_ids.contains(provenance_id) {
                return error(format!(
                    "{provenance_label} must reference provenance on the same finding"
                ));
            }
        }
    }
    Ok(())
}

fn validate_finding_evidence_own_provenance(
    value: &Value,
    label: &str,
) -> BridgeContractResult<()> {
    let finding = as_record(value, label)?;
    let provenance = required_array(finding, "provenance", &format!("{label}.provenance"))?;
    let mut provenance_ids = HashSet::new();
    for record in provenance {
        provenance_ids.insert(
            string_field(as_record(record, "finding provenance")?, "provenanceId")?.to_string(),
        );
    }
    let evidence = required_array(finding, "evidence", &format!("{label}.evidence"))?;
    for (evidence_index, evidence_record) in evidence.iter().enumerate() {
        let evidence_label = format!("{label}.evidence[{evidence_index}]");
        let evidence_record = as_record(evidence_record, &evidence_label)?;
        let ids = required_array(
            evidence_record,
            "provenanceIds",
            &format!("{evidence_label}.provenanceIds"),
        )?;
        if ids.is_empty() {
            return error(format!(
                "{evidence_label}.provenanceIds must contain at least one provenance id"
            ));
        }
        for (index, id) in ids.iter().enumerate() {
            let id = string_value(id, &format!("{evidence_label}.provenanceIds[{index}]"))?;
            if !provenance_ids.contains(id) {
                return error(format!(
                    "{evidence_label}.provenanceIds[{index}] must reference provenance on the same finding"
                ));
            }
        }
    }
    Ok(())
}

fn validate_benchmark_provider_run(
    run: &Map<String, Value>,
    label: &str,
    system_ids: &HashSet<String>,
    cost_totals_by_system: &mut HashMap<String, u64>,
    report_total_micros_usd: &mut u64,
    includes_unknown_cost: &mut bool,
) -> BridgeContractResult<String> {
    let provider_run_id =
        assert_required_uuid7(run, "providerRunId", &format!("{label}.providerRunId"))?;
    let system_id = assert_required_string(run, "systemId", &format!("{label}.systemId"))?;
    assert_known_string(
        system_id,
        &format!("{label}.systemId"),
        "system",
        system_ids,
    )?;
    assert_required_one_of(
        run,
        "taskKind",
        &[
            "extract",
            "draft_translation",
            "deterministic_qa",
            "llm_qa",
            "patch",
            "runtime_verify",
            "human_review",
            "repair",
        ],
        &format!("{label}.taskKind"),
    )?;
    validate_started_completed(run, label)?;
    if let Some(latency_ms) = run.get("latencyMs") {
        non_negative_integer_value(latency_ms, &format!("{label}.latencyMs"))?;
    }
    assert_required_one_of(
        run,
        "status",
        &["succeeded", "failed", "partial", "skipped"],
        &format!("{label}.status"),
    )?;
    validate_benchmark_provider_identity(
        required(run, "provider", &format!("{label}.provider"))?,
        &format!("{label}.provider"),
    )?;
    validate_benchmark_prompt_identity(
        required(run, "prompt", &format!("{label}.prompt"))?,
        &format!("{label}.prompt"),
    )?;
    assert_required_string(
        run,
        "structuredOutputMode",
        &format!("{label}.structuredOutputMode"),
    )?;
    assert_required_non_negative_integer(run, "retryCount", &format!("{label}.retryCount"))?;
    assert_string_array(
        required(run, "errorClasses", &format!("{label}.errorClasses"))?,
        &format!("{label}.errorClasses"),
    )?;
    assert_required_bool(run, "fallbackUsed", &format!("{label}.fallbackUsed"))?;
    if let Some(fallback_plan) = run.get("fallbackPlan") {
        assert_string_array(fallback_plan, &format!("{label}.fallbackPlan"))?;
    }
    validate_token_usage(
        required(run, "tokenUsage", &format!("{label}.tokenUsage"))?,
        &format!("{label}.tokenUsage"),
    )?;
    let cost_amount = validate_cost_amount(
        required(run, "cost", &format!("{label}.cost"))?,
        &format!("{label}.cost"),
    )?;
    if cost_amount.is_none() {
        *includes_unknown_cost = true;
    } else {
        let amount = cost_amount.unwrap_or(0);
        *report_total_micros_usd += amount;
        *cost_totals_by_system
            .entry(system_id.to_string())
            .or_default() += amount;
    }
    Ok(provider_run_id.to_string())
}

fn validate_benchmark_provider_identity(value: &Value, label: &str) -> BridgeContractResult<()> {
    let provider = as_record(value, label)?;
    assert_required_one_of(
        provider,
        "providerFamily",
        &[
            "fake",
            "recorded",
            "openrouter",
            "local-openai-compatible",
            "external_mtl",
            "local_tool",
        ],
        &format!("{label}.providerFamily"),
    )?;
    for key in [
        "endpointFamily",
        "providerName",
        "requestedModelId",
        "actualModelId",
    ] {
        assert_required_string(provider, key, &format!("{label}.{key}"))?;
    }
    for key in ["upstreamProvider", "routeSettingsHash"] {
        if let Some(value) = provider.get(key) {
            if key == "routeSettingsHash" {
                assert_hash_value(value, &format!("{label}.{key}"))?;
            } else {
                string_value(value, &format!("{label}.{key}"))?;
            }
        }
    }
    Ok(())
}

fn validate_benchmark_prompt_identity(value: &Value, label: &str) -> BridgeContractResult<()> {
    let prompt = as_record(value, label)?;
    assert_required_string(prompt, "promptPresetId", &format!("{label}.promptPresetId"))?;
    assert_required_string(
        prompt,
        "promptTemplateVersion",
        &format!("{label}.promptTemplateVersion"),
    )?;
    for key in ["promptHash", "remotePresetConfigHash"] {
        if let Some(value) = prompt.get(key) {
            assert_hash_value(value, &format!("{label}.{key}"))?;
        }
    }
    for key in ["remotePresetSlug", "remotePresetVersion"] {
        if let Some(value) = prompt.get(key) {
            string_value(value, &format!("{label}.{key}"))?;
        }
    }
    Ok(())
}

fn validate_token_usage(value: &Value, label: &str) -> BridgeContractResult<()> {
    let usage = as_record(value, label)?;
    assert_required_one_of(
        usage,
        "tokenCountSource",
        &[
            "provider_reported",
            "estimated",
            "deterministic_counter",
            "unknown",
        ],
        &format!("{label}.tokenCountSource"),
    )?;
    for key in [
        "promptTokens",
        "completionTokens",
        "reasoningTokens",
        "cachedInputTokens",
        "totalTokens",
    ] {
        if let Some(value) = usage.get(key) {
            non_negative_integer_value(value, &format!("{label}.{key}"))?;
        }
    }
    Ok(())
}

fn validate_cost_amount(value: &Value, label: &str) -> BridgeContractResult<Option<u64>> {
    let cost = as_record(value, label)?;
    let cost_kind = assert_required_one_of(
        cost,
        "costKind",
        &[
            "billed",
            "provider_estimate",
            "local_estimate",
            "zero",
            "unknown",
        ],
        &format!("{label}.costKind"),
    )?;
    assert_literal(cost, "currency", "USD", &format!("{label}.currency"))?;
    if let Some(pricing_snapshot_id) = cost.get("pricingSnapshotId") {
        string_value(pricing_snapshot_id, &format!("{label}.pricingSnapshotId"))?;
    }
    if cost_kind == "unknown" {
        return Ok(None);
    }
    let amount = match cost.get("amountMicrosUsd") {
        Some(value) => non_negative_integer_value(value, &format!("{label}.amountMicrosUsd"))?,
        None => 0,
    };
    Ok(Some(amount))
}

fn validate_benchmark_cost_ledger(
    value: &Value,
    system_ids: &HashSet<String>,
    report_total_micros_usd: u64,
    cost_totals_by_system: &HashMap<String, u64>,
    includes_unknown_cost: bool,
) -> BridgeContractResult<()> {
    let ledger = as_record(value, "BenchmarkReportV02.costLedger")?;
    assert_literal(
        ledger,
        "currency",
        "USD",
        "BenchmarkReportV02.costLedger.currency",
    )?;
    let report_total = assert_required_non_negative_integer(
        ledger,
        "reportTotalMicrosUsd",
        "BenchmarkReportV02.costLedger.reportTotalMicrosUsd",
    )?;
    if report_total != report_total_micros_usd {
        return error(
            "BenchmarkReportV02.costLedger.reportTotalMicrosUsd must equal providerModelCostRecords cost sum",
        );
    }
    let totals = required_array(
        ledger,
        "totalsBySystem",
        "BenchmarkReportV02.costLedger.totalsBySystem",
    )?;
    let mut seen_systems = HashSet::new();
    for (index, total) in totals.iter().enumerate() {
        let label = format!("BenchmarkReportV02.costLedger.totalsBySystem[{index}]");
        let total = as_record(total, &label)?;
        let system_id = assert_required_string(total, "systemId", &format!("{label}.systemId"))?;
        assert_known_string(
            system_id,
            &format!("{label}.systemId"),
            "system",
            system_ids,
        )?;
        if !seen_systems.insert(system_id.to_string()) {
            return error(format!(
                "{label}.systemId must be unique within totalsBySystem"
            ));
        }
        let total_value = assert_required_non_negative_integer(
            total,
            "totalMicrosUsd",
            &format!("{label}.totalMicrosUsd"),
        )?;
        if total_value != *cost_totals_by_system.get(system_id).unwrap_or(&0) {
            return error(format!(
                "{label}.totalMicrosUsd must equal providerModelCostRecords cost sum for system"
            ));
        }
    }
    let includes_unknown = assert_required_bool(
        ledger,
        "includesUnknownCost",
        "BenchmarkReportV02.costLedger.includesUnknownCost",
    )?;
    if includes_unknown != includes_unknown_cost {
        return error(
            "BenchmarkReportV02.costLedger.includesUnknownCost must match unknown provider costs",
        );
    }
    Ok(())
}

fn validate_seeded_defect(
    seed: &Map<String, Value>,
    label: &str,
    input_ref_ids: &HashSet<String>,
) -> BridgeContractResult<String> {
    let seeded_defect_id =
        assert_required_string(seed, "seededDefectId", &format!("{label}.seededDefectId"))?;
    let ref_id = assert_required_string(
        seed,
        "fixtureOrCorpusRefId",
        &format!("{label}.fixtureOrCorpusRefId"),
    )?;
    assert_known_string(
        ref_id,
        &format!("{label}.fixtureOrCorpusRefId"),
        "fixtureOrCorpusRef",
        input_ref_ids,
    )?;
    assert_required_string(seed, "seedKind", &format!("{label}.seedKind"))?;
    assert_required_string(seed, "targetLocale", &format!("{label}.targetLocale"))?;
    validate_triage_subject_refs(
        required(seed, "affectedRefs", &format!("{label}.affectedRefs"))?,
        &format!("{label}.affectedRefs"),
    )?;
    assert_required_one_of(
        seed,
        "category",
        LOCALIZATION_QUALITY_CATEGORIES,
        &format!("{label}.category"),
    )?;
    if let Some(subcategory) = seed.get("qualitySubcategory") {
        string_value(subcategory, &format!("{label}.qualitySubcategory"))?;
    }
    assert_required_one_of(
        seed,
        "qualitySeverity",
        LOCALIZATION_QUALITY_SEVERITIES,
        &format!("{label}.qualitySeverity"),
    )?;
    assert_required_one_of(
        seed,
        "expectedRootCause",
        LOCALIZATION_ROOT_CAUSES,
        &format!("{label}.expectedRootCause"),
    )?;
    assert_string_enum_array(
        required(
            seed,
            "expectedDetectorKinds",
            &format!("{label}.expectedDetectorKinds"),
        )?,
        QUALITY_DETECTOR_KINDS,
        &format!("{label}.expectedDetectorKinds"),
    )?;
    assert_uuid7_array(
        required(
            seed,
            "matchedFindingIds",
            &format!("{label}.matchedFindingIds"),
        )?,
        &format!("{label}.matchedFindingIds"),
    )?;
    assert_required_bool(seed, "publicContent", &format!("{label}.publicContent"))?;
    Ok(seeded_defect_id.to_string())
}

fn validate_benchmark_finding_record(
    finding: &Map<String, Value>,
    label: &str,
    system_ids: &HashSet<String>,
    seeded_defect_ids: &HashSet<String>,
) -> BridgeContractResult<String> {
    let finding_id = assert_required_uuid7(finding, "findingId", &format!("{label}.findingId"))?;
    let system_id = assert_required_string(finding, "systemId", &format!("{label}.systemId"))?;
    assert_known_string(
        system_id,
        &format!("{label}.systemId"),
        "system",
        system_ids,
    )?;
    assert_literal(
        finding,
        "taxonomyId",
        "itotori-lqa-1",
        &format!("{label}.taxonomyId"),
    )?;
    assert_literal(
        finding,
        "taxonomyVersion",
        "itotori-quality-taxonomy-0.1.0",
        &format!("{label}.taxonomyVersion"),
    )?;
    assert_required_one_of(
        finding,
        "detectorKind",
        QUALITY_DETECTOR_KINDS,
        &format!("{label}.detectorKind"),
    )?;
    assert_required_one_of(
        finding,
        "category",
        LOCALIZATION_QUALITY_CATEGORIES,
        &format!("{label}.category"),
    )?;
    if let Some(subcategory) = finding.get("qualitySubcategory") {
        string_value(subcategory, &format!("{label}.qualitySubcategory"))?;
    }
    assert_required_one_of(
        finding,
        "qualitySeverity",
        LOCALIZATION_QUALITY_SEVERITIES,
        &format!("{label}.qualitySeverity"),
    )?;
    let root_cause = assert_required_one_of(
        finding,
        "rootCause",
        LOCALIZATION_ROOT_CAUSES,
        &format!("{label}.rootCause"),
    )?;
    let adjudication_state = assert_required_one_of(
        finding,
        "adjudicationState",
        LOCALIZATION_ADJUDICATION_STATES,
        &format!("{label}.adjudicationState"),
    )?;
    validate_triage_subject_refs(
        required(finding, "affectedRefs", &format!("{label}.affectedRefs"))?,
        &format!("{label}.affectedRefs"),
    )?;
    validate_evidence_array(
        required(finding, "evidence", &format!("{label}.evidence"))?,
        &format!("{label}.evidence"),
    )?;
    validate_provenance_array(
        required(finding, "provenance", &format!("{label}.provenance"))?,
        &format!("{label}.provenance"),
    )?;
    validate_benchmark_finding_evidence_provenance(finding, label)?;
    if let Some(seeded_defect_id) = finding.get("seededDefectId") {
        let seeded_defect_id = string_value(seeded_defect_id, &format!("{label}.seededDefectId"))?;
        if !seeded_defect_ids.contains(seeded_defect_id) {
            return error(format!(
                "{label}.seededDefectId must reference seededDefectOracle"
            ));
        }
    }
    if let Some(rationale) = finding.get("reviewerRationale") {
        string_value(rationale, &format!("{label}.reviewerRationale"))?;
    }
    if root_cause == "unknown_unadjudicated"
        && adjudication_state != "unreviewed"
        && adjudication_state != "needs_more_context"
    {
        return error(format!(
            "{label}.rootCause cannot be unknown_unadjudicated after adjudication"
        ));
    }
    Ok(finding_id.to_string())
}

fn validate_benchmark_finding_evidence_provenance(
    finding: &Map<String, Value>,
    label: &str,
) -> BridgeContractResult<()> {
    let provenance = required_array(finding, "provenance", &format!("{label}.provenance"))?;
    let mut provenance_ids = HashSet::new();
    for record in provenance {
        provenance_ids.insert(
            string_field(as_record(record, "benchmark provenance")?, "provenanceId")?.to_string(),
        );
    }
    let evidence = required_array(finding, "evidence", &format!("{label}.evidence"))?;
    for (evidence_index, evidence_record) in evidence.iter().enumerate() {
        let evidence_label = format!("{label}.evidence[{evidence_index}]");
        let evidence_record = as_record(evidence_record, &evidence_label)?;
        let ids = required_array(
            evidence_record,
            "provenanceIds",
            &format!("{evidence_label}.provenanceIds"),
        )?;
        if ids.is_empty() {
            return error(format!(
                "{evidence_label}.provenanceIds must contain at least one provenance id"
            ));
        }
        for (index, id) in ids.iter().enumerate() {
            let id = string_value(id, &format!("{evidence_label}.provenanceIds[{index}]"))?;
            if !provenance_ids.contains(id) {
                return error(format!(
                    "{evidence_label}.provenanceIds[{index}] must reference provenance on the same finding"
                ));
            }
        }
    }
    Ok(())
}

fn validate_tool_versions(report: &Map<String, Value>) -> BridgeContractResult<()> {
    let versions = required_array(report, "toolVersions", "BenchmarkReportV02.toolVersions")?;
    for (index, version) in versions.iter().enumerate() {
        let label = format!("BenchmarkReportV02.toolVersions[{index}]");
        let version = as_record(version, &label)?;
        assert_required_string(version, "name", &format!("{label}.name"))?;
        assert_required_string(version, "version", &format!("{label}.version"))?;
        if let Some(commit) = version.get("gitCommit") {
            string_value(commit, &format!("{label}.gitCommit"))?;
        }
    }
    Ok(())
}

fn validate_command_lines(report: &Map<String, Value>) -> BridgeContractResult<()> {
    let commands = required_array(report, "commandLines", "BenchmarkReportV02.commandLines")?;
    for (index, command) in commands.iter().enumerate() {
        let label = format!("BenchmarkReportV02.commandLines[{index}]");
        let command = as_record(command, &label)?;
        assert_required_string(command, "commandId", &format!("{label}.commandId"))?;
        let argv = required_array(command, "argv", &format!("{label}.argv"))?;
        if argv.is_empty() {
            return error(format!(
                "{label}.argv must contain at least one command token"
            ));
        }
        for (arg_index, arg) in argv.iter().enumerate() {
            string_value(arg, &format!("{label}.argv[{arg_index}]"))?;
        }
    }
    Ok(())
}

fn validate_benchmark_artifact_ref(value: &Value, label: &str) -> BridgeContractResult<()> {
    let artifact = as_record(value, label)?;
    assert_required_uuid7(artifact, "artifactId", &format!("{label}.artifactId"))?;
    assert_required_string(artifact, "artifactKind", &format!("{label}.artifactKind"))?;
    assert_portable_uri(
        required(artifact, "uri", &format!("{label}.uri"))?,
        &format!("{label}.uri"),
    )?;
    if let Some(hash) = artifact.get("hash") {
        assert_hash_value(hash, &format!("{label}.hash"))?;
    }
    if let Some(media_type) = artifact.get("mediaType") {
        string_value(media_type, &format!("{label}.mediaType"))?;
    }
    Ok(())
}

fn validate_started_completed(value: &Map<String, Value>, label: &str) -> BridgeContractResult<()> {
    let started = assert_required_rfc3339(value, "startedAt", &format!("{label}.startedAt"))?;
    if let Some(completed) = value.get("completedAt") {
        let completed = assert_rfc3339_value(completed, &format!("{label}.completedAt"))?;
        if completed < started {
            return error(format!(
                "{label}.completedAt must not be before {label}.startedAt"
            ));
        }
    }
    Ok(())
}

fn assert_count_buckets_match(
    actual_values: &[String],
    value: &Value,
    allowed_buckets: &[&str],
    label: &str,
) -> BridgeContractResult<()> {
    let records = array_value(value, label)?;
    let mut actual_counts: HashMap<&str, u64> = HashMap::new();
    for value in actual_values {
        *actual_counts.entry(value.as_str()).or_default() += 1;
    }
    let mut reported_buckets = HashSet::new();
    for (index, record) in records.iter().enumerate() {
        let bucket_label = format!("{label}[{index}]");
        let record = as_record(record, &bucket_label)?;
        let bucket = assert_required_one_of(
            record,
            "bucket",
            allowed_buckets,
            &format!("{bucket_label}.bucket"),
        )?;
        if !reported_buckets.insert(bucket.to_string()) {
            return error(format!(
                "{bucket_label}.bucket must be unique within {label}"
            ));
        }
        let count = assert_required_non_negative_integer(
            record,
            "count",
            &format!("{bucket_label}.count"),
        )?;
        let actual_count = *actual_counts.get(bucket).unwrap_or(&0);
        if count != actual_count {
            return error(format!("{label}.{bucket} count must match findingRecords"));
        }
    }
    for (bucket, count) in actual_counts {
        if count > 0 && !reported_buckets.contains(bucket) {
            return error(format!("{label} must include bucket {bucket}"));
        }
    }
    Ok(())
}

fn validate_benchmark_penalty_summary(
    value: &Value,
    quality_severities: &[String],
    total_source_chars: u64,
    total_source_units: u64,
) -> BridgeContractResult<()> {
    let summary = as_record(value, "BenchmarkReportV02.penaltySummary")?;
    let penalty_total = required_number(
        summary,
        "penaltyTotal",
        "BenchmarkReportV02.penaltySummary.penaltyTotal",
    )?;
    let chars_penalty = required_number(
        summary,
        "penaltyPerThousandSourceChars",
        "BenchmarkReportV02.penaltySummary.penaltyPerThousandSourceChars",
    )?;
    let units_penalty = required_number(
        summary,
        "penaltyPerHundredSourceUnits",
        "BenchmarkReportV02.penaltySummary.penaltyPerHundredSourceUnits",
    )?;
    let expected_total: f64 = quality_severities
        .iter()
        .map(|severity| match severity.as_str() {
            "critical" => 25.0,
            "major" => 5.0,
            "minor" => 1.0,
            // "neutral" and any other severity contribute no penalty.
            _ => 0.0,
        })
        .sum();
    if (penalty_total - expected_total).abs() > f64::EPSILON {
        return error(
            "BenchmarkReportV02.penaltySummary.penaltyTotal must match findingRecords qualitySeverity weights from itotori-lqa-1",
        );
    }
    assert_number_within_tolerance(
        chars_penalty,
        (expected_total / total_source_chars as f64) * 1000.0,
        "BenchmarkReportV02.penaltySummary.penaltyPerThousandSourceChars",
        "findingRecords qualitySeverity weights normalized by fixtureOrCorpusRefs.sourceCharacterCount",
    )?;
    assert_number_within_tolerance(
        units_penalty,
        (expected_total / total_source_units as f64) * 100.0,
        "BenchmarkReportV02.penaltySummary.penaltyPerHundredSourceUnits",
        "findingRecords qualitySeverity weights normalized by fixtureOrCorpusRefs.sourceUnitCount",
    )
}

fn validate_deterministic_qa_results(
    report: &Map<String, Value>,
    system_ids: &HashSet<String>,
    finding_ids: &HashSet<String>,
) -> BridgeContractResult<()> {
    let results = required_array(
        report,
        "deterministicQaResults",
        "BenchmarkReportV02.deterministicQaResults",
    )?;
    for (index, result) in results.iter().enumerate() {
        let label = format!("BenchmarkReportV02.deterministicQaResults[{index}]");
        let result = as_record(result, &label)?;
        assert_required_uuid7(
            result,
            "deterministicQaRunId",
            &format!("{label}.deterministicQaRunId"),
        )?;
        let system_id = assert_required_string(
            result,
            "evaluatedSystemId",
            &format!("{label}.evaluatedSystemId"),
        )?;
        assert_known_string(
            system_id,
            &format!("{label}.evaluatedSystemId"),
            "system",
            system_ids,
        )?;
        assert_required_string(result, "checkName", &format!("{label}.checkName"))?;
        assert_required_string(result, "checkVersion", &format!("{label}.checkVersion"))?;
        validate_started_completed(result, &label)?;
        let rule_count = assert_required_non_negative_integer(
            result,
            "ruleCount",
            &format!("{label}.ruleCount"),
        )?;
        let passed = assert_required_non_negative_integer(
            result,
            "passedRuleCount",
            &format!("{label}.passedRuleCount"),
        )?;
        let failed = assert_required_non_negative_integer(
            result,
            "failedRuleCount",
            &format!("{label}.failedRuleCount"),
        )?;
        if passed + failed != rule_count {
            return error(format!(
                "{label}.passedRuleCount plus failedRuleCount must equal ruleCount"
            ));
        }
        assert_known_uuid_refs(
            required(result, "findingIds", &format!("{label}.findingIds"))?,
            &format!("{label}.findingIds"),
            "finding",
            finding_ids,
        )?;
        let artifact_refs =
            required_array(result, "artifactRefs", &format!("{label}.artifactRefs"))?;
        for (artifact_index, artifact_ref) in artifact_refs.iter().enumerate() {
            validate_benchmark_artifact_ref(
                artifact_ref,
                &format!("{label}.artifactRefs[{artifact_index}]"),
            )?;
        }
    }
    Ok(())
}

fn validate_qa_agent_evaluations(
    report: &Map<String, Value>,
    system_ids: &HashSet<String>,
    provider_run_ids: &HashSet<String>,
    provider_run_system_ids: &HashMap<String, String>,
    finding_ids: &HashSet<String>,
    finding_system_ids: &HashMap<String, String>,
) -> BridgeContractResult<QaAgentEvaluationRefs> {
    let evaluations = required_array(
        report,
        "qaAgentEvaluations",
        "BenchmarkReportV02.qaAgentEvaluations",
    )?;
    let mut qa_agent_provider_ids: HashMap<String, HashSet<String>> = HashMap::new();
    let mut qa_agent_finding_ids: HashMap<String, HashSet<String>> = HashMap::new();
    for (index, evaluation) in evaluations.iter().enumerate() {
        let label = format!("BenchmarkReportV02.qaAgentEvaluations[{index}]");
        let evaluation = as_record(evaluation, &label)?;
        assert_required_uuid7(
            evaluation,
            "qaAgentEvaluationId",
            &format!("{label}.qaAgentEvaluationId"),
        )?;
        assert_required_string(evaluation, "qaAgentId", &format!("{label}.qaAgentId"))?;
        assert_required_string(
            evaluation,
            "qaAgentVersion",
            &format!("{label}.qaAgentVersion"),
        )?;
        let system_id = assert_required_string(
            evaluation,
            "evaluatedSystemId",
            &format!("{label}.evaluatedSystemId"),
        )?;
        assert_known_string(
            system_id,
            &format!("{label}.evaluatedSystemId"),
            "system",
            system_ids,
        )?;
        for id in assert_known_uuid_refs(
            required(
                evaluation,
                "providerRunIds",
                &format!("{label}.providerRunIds"),
            )?,
            &format!("{label}.providerRunIds"),
            "providerRun",
            provider_run_ids,
        )? {
            if provider_run_system_ids.get(&id) != Some(&system_id.to_string()) {
                return error(format!(
                    "{label}.providerRunIds must reference providerModelCostRecords for evaluatedSystemId {system_id}"
                ));
            }
            qa_agent_provider_ids
                .entry(system_id.to_string())
                .or_default()
                .insert(id);
        }
        for id in assert_known_uuid_refs(
            required(evaluation, "findingIds", &format!("{label}.findingIds"))?,
            &format!("{label}.findingIds"),
            "finding",
            finding_ids,
        )? {
            if finding_system_ids.get(&id) != Some(&system_id.to_string()) {
                return error(format!(
                    "{label}.findingIds must reference findingRecords for evaluatedSystemId {system_id}"
                ));
            }
            qa_agent_finding_ids
                .entry(system_id.to_string())
                .or_default()
                .insert(id);
        }
        validate_qa_agent_metrics(
            required(evaluation, "metrics", &format!("{label}.metrics"))?,
            &format!("{label}.metrics"),
        )?;
        assert_string_array(
            required(evaluation, "limitations", &format!("{label}.limitations"))?,
            &format!("{label}.limitations"),
        )?;
    }
    Ok(QaAgentEvaluationRefs {
        provider_run_ids: qa_agent_provider_ids,
        finding_ids: qa_agent_finding_ids,
    })
}

fn validate_qa_agent_metrics(value: &Value, label: &str) -> BridgeContractResult<()> {
    let metrics = as_record(value, label)?;
    for key in [
        "seededRecall",
        "seededPrecision",
        "f1",
        "categoryAccuracy",
        "qualitySeverityAccuracy",
        "rootCauseAccuracy",
        "criticalRecall",
        "unscorableRate",
    ] {
        assert_required_ratio(metrics, key, &format!("{label}.{key}"))?;
    }
    if let Some(value) = metrics.get("humanConfirmedPrecision") {
        ratio_value(value, &format!("{label}.humanConfirmedPrecision"))?;
    }
    let emitted = assert_required_non_negative_integer(
        metrics,
        "findingsEmitted",
        &format!("{label}.findingsEmitted"),
    )?;
    let scorable = assert_required_non_negative_integer(
        metrics,
        "scorableFindings",
        &format!("{label}.scorableFindings"),
    )?;
    let adjudicated = assert_required_non_negative_integer(
        metrics,
        "adjudicatedFindings",
        &format!("{label}.adjudicatedFindings"),
    )?;
    if scorable > emitted {
        return error(format!(
            "{label}.scorableFindings must not exceed findingsEmitted"
        ));
    }
    if adjudicated > emitted {
        return error(format!(
            "{label}.adjudicatedFindings must not exceed findingsEmitted"
        ));
    }
    Ok(())
}

fn validate_human_evaluations(
    report: &Map<String, Value>,
    system_ids: &HashSet<String>,
    finding_ids: &HashSet<String>,
) -> BridgeContractResult<()> {
    let evaluations = required_array(
        report,
        "humanEvaluationResults",
        "BenchmarkReportV02.humanEvaluationResults",
    )?;
    for (index, evaluation) in evaluations.iter().enumerate() {
        let label = format!("BenchmarkReportV02.humanEvaluationResults[{index}]");
        let evaluation = as_record(evaluation, &label)?;
        assert_required_uuid7(
            evaluation,
            "humanEvaluationId",
            &format!("{label}.humanEvaluationId"),
        )?;
        assert_required_uuid7(
            evaluation,
            "reviewSessionId",
            &format!("{label}.reviewSessionId"),
        )?;
        let evaluated_systems = required_array(
            evaluation,
            "evaluatedSystemIds",
            &format!("{label}.evaluatedSystemIds"),
        )?;
        if evaluated_systems.is_empty() {
            return error(format!(
                "{label}.evaluatedSystemIds must contain at least one system id"
            ));
        }
        for (system_index, system_id) in evaluated_systems.iter().enumerate() {
            let system_id = string_value(
                system_id,
                &format!("{label}.evaluatedSystemIds[{system_index}]"),
            )?;
            assert_known_string(
                system_id,
                &format!("{label}.evaluatedSystemIds[{system_index}]"),
                "system",
                system_ids,
            )?;
        }
        assert_required_positive_integer(
            evaluation,
            "reviewerCount",
            &format!("{label}.reviewerCount"),
        )?;
        assert_required_positive_integer(
            evaluation,
            "sampleUnitCount",
            &format!("{label}.sampleUnitCount"),
        )?;
        assert_required_positive_integer(
            evaluation,
            "sampleSourceCharacterCount",
            &format!("{label}.sampleSourceCharacterCount"),
        )?;
        assert_required_bool(evaluation, "blindReview", &format!("{label}.blindReview"))?;
        assert_known_uuid_refs(
            required(
                evaluation,
                "adjudicatedFindingIds",
                &format!("{label}.adjudicatedFindingIds"),
            )?,
            &format!("{label}.adjudicatedFindingIds"),
            "finding",
            finding_ids,
        )?;
        if let Some(notes) = evaluation.get("reviewerAgreementNotes") {
            string_value(notes, &format!("{label}.reviewerAgreementNotes"))?;
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

fn asset_kinds_for_asset_policy_surface(surface_kind: &str) -> &'static [&'static str] {
    match surface_kind {
        "image_text" => &["image", "ui_texture", "video"],
        "ui_art" => &["ui_texture", "image"],
        "song_title" => &["audio", "metadata"],
        "font" => &["font"],
        "credits" => &["metadata", "video"],
        "video" => &["video"],
        _ => &[],
    }
}

fn asset_kinds_for_patch_mode(patch_mode: &str) -> &'static [&'static str] {
    match patch_mode {
        "metadata_only" | "asset_replacement_required" => &[
            "script",
            "image",
            "audio",
            "video",
            "ui_texture",
            "font",
            "database",
            "metadata",
            "text",
        ],
        "region_redraw_required" => &["image", "video", "ui_texture"],
        "font_substitution_required" => &["font"],
        // "no_patch_required", "unsupported", and any other strategy require no assets.
        _ => &[],
    }
}

fn asset_kinds_for_asset_policy_patch(surface_kind: &str, patch_mode: &str) -> Vec<&'static str> {
    let surface_kinds = asset_kinds_for_asset_policy_surface(surface_kind);
    let mode_kinds = asset_kinds_for_patch_mode(patch_mode);
    surface_kinds
        .iter()
        .copied()
        .filter(|kind| mode_kinds.contains(kind))
        .collect()
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

fn assert_runtime_evidence_tier_within_fidelity(
    evidence_tier: &str,
    fidelity_tier: &str,
) -> BridgeContractResult<()> {
    let maximum = match fidelity_tier {
        "trace_only" => "E1",
        "layout_probe" => "E2",
        "replay_review" => "E3",
        "reference_fidelity" => "E4",
        _ => "E0",
    };
    if runtime_evidence_tier_rank(evidence_tier) > runtime_evidence_tier_rank(maximum) {
        return error(format!(
            "RuntimeEvidenceReportV02.evidenceTier must not exceed {maximum} for the declared fidelityTier"
        ));
    }
    Ok(())
}

fn validate_runtime_capability_contract(
    value: &Value,
    label: &str,
    report_fidelity_tier: &str,
    report_evidence_tier: &str,
) -> BridgeContractResult<()> {
    let contract = as_record(value, label)?;
    assert_literal(
        contract,
        "contractVersion",
        BRIDGE_SCHEMA_VERSION_V02,
        &format!("{label}.contractVersion"),
    )?;
    let capability_class = assert_required_one_of(
        contract,
        "capabilityClass",
        RUNTIME_CAPABILITY_CLASSES,
        &format!("{label}.capabilityClass"),
    )?;
    let fidelity_tier_ceiling = assert_required_one_of(
        contract,
        "fidelityTierCeiling",
        RUNTIME_FIDELITY_TIERS,
        &format!("{label}.fidelityTierCeiling"),
    )?;
    let evidence_tier_ceiling = assert_required_one_of(
        contract,
        "evidenceTierCeiling",
        RUNTIME_EVIDENCE_TIERS,
        &format!("{label}.evidenceTierCeiling"),
    )?;
    assert_runtime_capability_class_ceiling(
        capability_class,
        fidelity_tier_ceiling,
        evidence_tier_ceiling,
        label,
    )?;
    assert_runtime_evidence_tier_within_fidelity(evidence_tier_ceiling, fidelity_tier_ceiling)?;
    assert_maximum_runtime_fidelity_tier(
        report_fidelity_tier,
        fidelity_tier_ceiling,
        "RuntimeEvidenceReportV02.fidelityTier",
    )?;
    assert_maximum_runtime_evidence_tier(
        report_evidence_tier,
        evidence_tier_ceiling,
        "RuntimeEvidenceReportV02.evidenceTier",
    )?;

    let features = required_array(contract, "features", &format!("{label}.features"))?;
    if features.is_empty() {
        return error(format!(
            "{label}.features must include at least one runtime feature declaration"
        ));
    }
    let mut seen_features = HashSet::new();
    for (index, feature) in features.iter().enumerate() {
        let feature_label = format!("{label}.features[{index}]");
        let feature = validate_runtime_feature_support(feature, &feature_label)?;
        let feature_name = string_field(feature, "feature")?;
        if !seen_features.insert(feature_name.to_string()) {
            return error(format!(
                "{feature_label}.feature must be unique within runtime capability contract"
            ));
        }
        if let Some(feature_ceiling) = feature.get("evidenceTierCeiling") {
            let feature_ceiling = string_value(
                feature_ceiling,
                &format!("{feature_label}.evidenceTierCeiling"),
            )?;
            assert_maximum_runtime_evidence_tier(
                feature_ceiling,
                evidence_tier_ceiling,
                &format!("{feature_label}.evidenceTierCeiling"),
            )?;
        }
    }
    assert_string_array(
        required(contract, "limitations", &format!("{label}.limitations"))?,
        &format!("{label}.limitations"),
    )?;
    Ok(())
}

fn validate_runtime_feature_support<'a>(
    value: &'a Value,
    label: &str,
) -> BridgeContractResult<&'a Map<String, Value>> {
    let feature = as_record(value, label)?;
    assert_required_one_of(
        feature,
        "feature",
        RUNTIME_PLAYBACK_FEATURES,
        &format!("{label}.feature"),
    )?;
    let status = assert_required_one_of(
        feature,
        "status",
        RUNTIME_FEATURE_STATUSES,
        &format!("{label}.status"),
    )?;
    if let Some(evidence_tier_ceiling) = feature.get("evidenceTierCeiling") {
        let evidence_tier_ceiling = string_value(
            evidence_tier_ceiling,
            &format!("{label}.evidenceTierCeiling"),
        )?;
        assert_one_of(
            evidence_tier_ceiling,
            RUNTIME_EVIDENCE_TIERS,
            &format!("{label}.evidenceTierCeiling"),
        )?;
    }
    if status == "unsupported" && feature.get("evidenceTierCeiling").is_some() {
        return error(format!(
            "{label}.evidenceTierCeiling must be omitted for unsupported runtime features"
        ));
    }
    if status != "unsupported" && feature.get("evidenceTierCeiling").is_none() {
        return error(format!(
            "{label}.evidenceTierCeiling is required for supported runtime features"
        ));
    }
    assert_required_string(feature, "description", &format!("{label}.description"))?;
    assert_string_array(
        required(feature, "limitations", &format!("{label}.limitations"))?,
        &format!("{label}.limitations"),
    )?;
    Ok(feature)
}

fn validate_controlled_playback_session(
    value: &Value,
    label: &str,
    report: &Map<String, Value>,
    report_fidelity_tier: &str,
    report_evidence_tier: &str,
    report_status: &str,
) -> BridgeContractResult<()> {
    let session = as_record(value, label)?;
    assert_required_uuid7(session, "sessionId", &format!("{label}.sessionId"))?;
    let adapter_name =
        assert_required_string(session, "adapterName", &format!("{label}.adapterName"))?;
    if adapter_name != string_field(report, "adapterName")? {
        return error(format!(
            "{label}.adapterName must match RuntimeEvidenceReportV02.adapterName"
        ));
    }
    let adapter_version = assert_required_string(
        session,
        "adapterVersion",
        &format!("{label}.adapterVersion"),
    )?;
    if adapter_version != string_field(report, "adapterVersion")? {
        return error(format!(
            "{label}.adapterVersion must match RuntimeEvidenceReportV02.adapterVersion"
        ));
    }
    let capability_class = assert_required_one_of(
        session,
        "capabilityClass",
        RUNTIME_CAPABILITY_CLASSES,
        &format!("{label}.capabilityClass"),
    )?;
    assert_required_one_of(
        session,
        "requestedOperation",
        RUNTIME_REQUESTED_OPERATIONS,
        &format!("{label}.requestedOperation"),
    )?;
    let status = assert_required_one_of(
        session,
        "status",
        &["passed", "failed"],
        &format!("{label}.status"),
    )?;
    if status != report_status {
        return error(format!(
            "{label}.status must match RuntimeEvidenceReportV02.status"
        ));
    }
    let fidelity_tier = assert_required_one_of(
        session,
        "fidelityTier",
        RUNTIME_FIDELITY_TIERS,
        &format!("{label}.fidelityTier"),
    )?;
    let evidence_tier = assert_required_one_of(
        session,
        "evidenceTier",
        RUNTIME_EVIDENCE_TIERS,
        &format!("{label}.evidenceTier"),
    )?;
    assert_runtime_evidence_tier_within_fidelity(evidence_tier, fidelity_tier)?;
    assert_maximum_runtime_fidelity_tier(
        fidelity_tier,
        report_fidelity_tier,
        &format!("{label}.fidelityTier"),
    )?;
    assert_maximum_runtime_evidence_tier(
        evidence_tier,
        report_evidence_tier,
        &format!("{label}.evidenceTier"),
    )?;

    let features_used = required_array(session, "featuresUsed", &format!("{label}.featuresUsed"))?;
    for (index, feature) in features_used.iter().enumerate() {
        let feature = string_value(feature, &format!("{label}.featuresUsed[{index}]"))?;
        assert_one_of(
            feature,
            RUNTIME_PLAYBACK_FEATURES,
            &format!("{label}.featuresUsed[{index}]"),
        )?;
        if let Some(runtime_capabilities) = report.get("runtimeCapabilities") {
            validate_runtime_capability_supports_feature(
                runtime_capabilities,
                feature,
                "RuntimeEvidenceReportV02.runtimeCapabilities",
            )?;
        }
    }
    if let Some(runtime_capabilities) = report.get("runtimeCapabilities") {
        let runtime_capabilities = as_record(
            runtime_capabilities,
            "RuntimeEvidenceReportV02.runtimeCapabilities",
        )?;
        if capability_class != string_field(runtime_capabilities, "capabilityClass")? {
            return error(format!(
                "{label}.capabilityClass must match runtimeCapabilities.capabilityClass"
            ));
        }
    }
    assert_string_array(
        required(session, "limitations", &format!("{label}.limitations"))?,
        &format!("{label}.limitations"),
    )?;
    Ok(())
}

fn validate_controlled_playback_session_evidence_surface(
    requested_operation: &str,
    has_branch_events: bool,
    has_captures: bool,
    has_recordings: bool,
    has_reference_comparisons: bool,
    label: &str,
) -> BridgeContractResult<()> {
    match requested_operation {
        "trace" => {
            reject_controlled_playback_operation_evidence(
                requested_operation,
                has_branch_events,
                "branch event",
                label,
            )?;
            reject_controlled_playback_operation_evidence(
                requested_operation,
                has_captures,
                "capture",
                label,
            )?;
            reject_controlled_playback_operation_evidence(
                requested_operation,
                has_recordings,
                "recording",
                label,
            )?;
            reject_controlled_playback_operation_evidence(
                requested_operation,
                has_reference_comparisons,
                "reference comparison",
                label,
            )?;
        }
        "branch_discovery" => {
            reject_controlled_playback_operation_evidence(
                requested_operation,
                has_captures,
                "capture",
                label,
            )?;
            reject_controlled_playback_operation_evidence(
                requested_operation,
                has_recordings,
                "recording",
                label,
            )?;
            reject_controlled_playback_operation_evidence(
                requested_operation,
                has_reference_comparisons,
                "reference comparison",
                label,
            )?;
        }
        "capture" => {
            reject_controlled_playback_operation_evidence(
                requested_operation,
                has_branch_events,
                "branch event",
                label,
            )?;
            reject_controlled_playback_operation_evidence(
                requested_operation,
                has_recordings,
                "recording",
                label,
            )?;
            reject_controlled_playback_operation_evidence(
                requested_operation,
                has_reference_comparisons,
                "reference comparison",
                label,
            )?;
        }
        "smoke_validation" => {}
        _ => unreachable!("controlled playback requestedOperation was already validated"),
    }
    Ok(())
}

fn reject_controlled_playback_operation_evidence(
    requested_operation: &str,
    has_evidence: bool,
    evidence_label: &str,
    label: &str,
) -> BridgeContractResult<()> {
    if has_evidence {
        return error(format!(
            "{label} {requested_operation} must not carry {evidence_label} evidence"
        ));
    }
    Ok(())
}

fn validate_runtime_capability_supports_feature(
    value: &Value,
    required_feature: &str,
    label: &str,
) -> BridgeContractResult<()> {
    let contract = as_record(value, label)?;
    let features = required_array(contract, "features", &format!("{label}.features"))?;
    for feature in features {
        let feature = as_record(feature, &format!("{label}.features[]"))?;
        if string_field(feature, "feature")? == required_feature
            && string_field(feature, "status")? != "unsupported"
        {
            return Ok(());
        }
    }
    error(format!(
        "{label} must advertise supported or partial {required_feature} capability"
    ))
}

fn assert_runtime_capability_class_ceiling(
    capability_class: &str,
    fidelity_tier_ceiling: &str,
    evidence_tier_ceiling: &str,
    label: &str,
) -> BridgeContractResult<()> {
    let (fidelity_ceiling, evidence_ceiling) = match capability_class {
        "launch_capture" => ("layout_probe", "E2"),
        "instrumented_runtime" | "partial_vm" => ("replay_review", "E3"),
        "reference_vm" => ("reference_fidelity", "E4"),
        // "static_trace" and any unrecognized class get the most conservative ceiling.
        _ => ("trace_only", "E1"),
    };
    assert_maximum_runtime_fidelity_tier(
        fidelity_tier_ceiling,
        fidelity_ceiling,
        &format!("{label}.fidelityTierCeiling"),
    )?;
    assert_maximum_runtime_evidence_tier(
        evidence_tier_ceiling,
        evidence_ceiling,
        &format!("{label}.evidenceTierCeiling"),
    )
}

fn assert_maximum_runtime_fidelity_tier(
    actual: &str,
    maximum: &str,
    label: &str,
) -> BridgeContractResult<()> {
    if runtime_fidelity_tier_rank(actual) > runtime_fidelity_tier_rank(maximum) {
        return error(format!(
            "{label} must not exceed {maximum} for the declared runtime capability"
        ));
    }
    Ok(())
}

fn assert_minimum_runtime_evidence_tier(
    actual: &str,
    minimum: &str,
    label: &str,
) -> BridgeContractResult<()> {
    if runtime_evidence_tier_rank(actual) < runtime_evidence_tier_rank(minimum) {
        return error(format!("{label} must be at least {minimum}"));
    }
    Ok(())
}

fn assert_maximum_runtime_evidence_tier(
    actual: &str,
    maximum: &str,
    label: &str,
) -> BridgeContractResult<()> {
    if runtime_evidence_tier_rank(actual) > runtime_evidence_tier_rank(maximum) {
        return error(format!(
            "{label} must not exceed {maximum} for the declared fidelityTier"
        ));
    }
    Ok(())
}

fn runtime_evidence_tier_rank(tier: &str) -> usize {
    RUNTIME_EVIDENCE_TIERS
        .iter()
        .position(|candidate| *candidate == tier)
        .unwrap_or(0)
}

fn runtime_fidelity_tier_rank(tier: &str) -> usize {
    RUNTIME_FIDELITY_TIERS
        .iter()
        .position(|candidate| *candidate == tier)
        .unwrap_or(0)
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

fn assert_schema_version(value: &Map<String, Value>, label: &str) -> BridgeContractResult<()> {
    let schema_version =
        assert_required_string(value, "schemaVersion", &format!("{label}.schemaVersion"))?;
    if schema_version == BRIDGE_SCHEMA_VERSION_V02 {
        Ok(())
    } else if schema_version == "0.1.0" {
        error(format!(
            "{label}.schemaVersion must be {BRIDGE_SCHEMA_VERSION_V02}; 0.1.0 is the legacy fixture contract"
        ))
    } else {
        error(format!(
            "{label}.schemaVersion must be {BRIDGE_SCHEMA_VERSION_V02}"
        ))
    }
}

fn required<'a>(
    record: &'a Map<String, Value>,
    key: &str,
    label: &str,
) -> BridgeContractResult<&'a Value> {
    record
        .get(key)
        .ok_or_else(|| BridgeContractValidationError::new(format!("{label} is required")))
}

fn assert_record_keys(
    record: &Map<String, Value>,
    allowed_keys: &[&str],
    label: &str,
) -> BridgeContractResult<()> {
    for key in record.keys() {
        if !allowed_keys.contains(&key.as_str()) {
            return error(format!("{label}.{key} is not allowed"));
        }
    }
    Ok(())
}

fn required_record<'a>(
    record: &'a Map<String, Value>,
    key: &str,
    label: &str,
) -> BridgeContractResult<&'a Map<String, Value>> {
    as_record(required(record, key, label)?, label)
}

fn required_array<'a>(
    record: &'a Map<String, Value>,
    key: &str,
    label: &str,
) -> BridgeContractResult<&'a Vec<Value>> {
    array_value(required(record, key, label)?, label)
}

fn optional_array<'a>(
    record: &'a Map<String, Value>,
    key: &str,
    label: &str,
) -> BridgeContractResult<Vec<&'a Value>> {
    match record.get(key) {
        Some(value) => Ok(array_value(value, label)?.iter().collect()),
        None => Ok(vec![]),
    }
}

fn as_record<'a>(value: &'a Value, label: &str) -> BridgeContractResult<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| BridgeContractValidationError::new(format!("{label} must be an object")))
}

fn array_value<'a>(value: &'a Value, label: &str) -> BridgeContractResult<&'a Vec<Value>> {
    value
        .as_array()
        .ok_or_else(|| BridgeContractValidationError::new(format!("{label} must be an array")))
}

fn string_value<'a>(value: &'a Value, label: &str) -> BridgeContractResult<&'a str> {
    match value.as_str() {
        Some(value) if !value.is_empty() => Ok(value),
        _ => error(format!("{label} must be a non-empty string")),
    }
}

fn non_blank_string_value<'a>(value: &'a Value, label: &str) -> BridgeContractResult<&'a str> {
    let value = string_value(value, label)?;
    if value.trim().is_empty() {
        error(format!("{label} must be a non-empty string"))
    } else {
        Ok(value)
    }
}

fn optional_string<'a>(
    record: &'a Map<String, Value>,
    key: &str,
    label: &str,
) -> BridgeContractResult<Option<&'a str>> {
    match record.get(key) {
        Some(value) => string_value(value, label).map(Some),
        None => Ok(None),
    }
}

fn is_blank_string(value: Option<&str>) -> bool {
    value.is_none_or(|value| value.trim().is_empty())
}

fn string_field<'a>(record: &'a Map<String, Value>, key: &str) -> BridgeContractResult<&'a str> {
    string_value(
        record
            .get(key)
            .ok_or_else(|| BridgeContractValidationError::new(format!("{key} is required")))?,
        key,
    )
}

fn assert_required_string<'a>(
    record: &'a Map<String, Value>,
    key: &str,
    label: &str,
) -> BridgeContractResult<&'a str> {
    string_value(required(record, key, label)?, label)
}

fn assert_public_fixture_id(value: &str, label: &str) -> BridgeContractResult<()> {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return error(format!("{label} must be a public fixture id"));
    };
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return error(format!("{label} must be a public fixture id"));
    }
    if chars
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '.' | '_' | '-'))
    {
        Ok(())
    } else {
        error(format!("{label} must be a public fixture id"))
    }
}

fn assert_required_uuid7<'a>(
    record: &'a Map<String, Value>,
    key: &str,
    label: &str,
) -> BridgeContractResult<&'a str> {
    let value = assert_required_string(record, key, label)?;
    assert_uuid7(value, label)?;
    Ok(value)
}

fn assert_uuid7_value(value: &Value, label: &str) -> BridgeContractResult<()> {
    let value = string_value(value, label)?;
    assert_uuid7(value, label)
}

fn assert_uuid7(value: &str, label: &str) -> BridgeContractResult<()> {
    let bytes = value.as_bytes();
    let valid = bytes.len() == 36
        && bytes[8] == b'-'
        && bytes[13] == b'-'
        && bytes[18] == b'-'
        && bytes[23] == b'-'
        && bytes[14] == b'7'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 8 | 13 | 18 | 23) || byte.is_ascii_hexdigit());
    if valid {
        Ok(())
    } else {
        error(format!("{label} must be a UUID7 string"))
    }
}

fn assert_required_hash<'a>(
    record: &'a Map<String, Value>,
    key: &str,
    label: &str,
) -> BridgeContractResult<&'a str> {
    let value = assert_required_string(record, key, label)?;
    assert_hash(value, label)?;
    Ok(value)
}

fn assert_hash_value(value: &Value, label: &str) -> BridgeContractResult<()> {
    let value = string_value(value, label)?;
    assert_hash(value, label)
}

fn assert_hash(value: &str, label: &str) -> BridgeContractResult<()> {
    if value.len() != 71 || !value.starts_with("sha256:") {
        return error(format!("{label} must be a canonical sha256 hash string"));
    }
    if value[7..]
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        error(format!("{label} must be a canonical sha256 hash string"))
    }
}

fn assert_required_one_of<'a>(
    record: &'a Map<String, Value>,
    key: &str,
    allowed: &[&str],
    label: &str,
) -> BridgeContractResult<&'a str> {
    let value = assert_required_string(record, key, label)?;
    assert_one_of(value, allowed, label)?;
    Ok(value)
}

fn assert_one_of(value: &str, allowed: &[&str], label: &str) -> BridgeContractResult<()> {
    if allowed.contains(&value) {
        Ok(())
    } else {
        error(format!("{label} must be one of: {}", allowed.join(", ")))
    }
}

fn assert_literal(
    record: &Map<String, Value>,
    key: &str,
    expected: &str,
    label: &str,
) -> BridgeContractResult<()> {
    let value = assert_required_string(record, key, label)?;
    if value == expected {
        Ok(())
    } else {
        error(format!("{label} must be {expected}"))
    }
}

fn assert_required_rfc3339<'a>(
    record: &'a Map<String, Value>,
    key: &str,
    label: &str,
) -> BridgeContractResult<&'a str> {
    assert_rfc3339_value(required(record, key, label)?, label)
}

fn assert_rfc3339_value<'a>(value: &'a Value, label: &str) -> BridgeContractResult<&'a str> {
    let value = string_value(value, label)?;
    if is_valid_rfc3339_instant(value) {
        Ok(value)
    } else {
        error(format!("{label} must be a valid RFC3339 timestamp instant"))
    }
}

fn is_valid_rfc3339_instant(value: &str) -> bool {
    let Some((date, time_and_offset)) = value.split_once('T') else {
        return false;
    };
    if date.len() != 10
        || date.as_bytes().get(4) != Some(&b'-')
        || date.as_bytes().get(7) != Some(&b'-')
    {
        return false;
    }
    let Some(year) = parse_u32_digits(&date[0..4]) else {
        return false;
    };
    let Some(month) = parse_u32_digits(&date[5..7]) else {
        return false;
    };
    let Some(day) = parse_u32_digits(&date[8..10]) else {
        return false;
    };

    let (time, offset) = if let Some(time) = time_and_offset.strip_suffix('Z') {
        (time, "Z")
    } else if let Some((offset_index, _)) = time_and_offset
        .char_indices()
        .rev()
        .find(|(_, c)| *c == '+' || *c == '-')
    {
        if offset_index == 0 {
            return false;
        }
        (
            &time_and_offset[..offset_index],
            &time_and_offset[offset_index..],
        )
    } else {
        return false;
    };

    if time.len() < 8
        || time.as_bytes().get(2) != Some(&b':')
        || time.as_bytes().get(5) != Some(&b':')
    {
        return false;
    }
    let Some(hour) = parse_u32_digits(&time[0..2]) else {
        return false;
    };
    let Some(minute) = parse_u32_digits(&time[3..5]) else {
        return false;
    };
    let second_text = &time[6..];
    let (second_text, fraction) = second_text
        .split_once('.')
        .map_or((second_text, None), |(second, fraction)| {
            (second, Some(fraction))
        });
    let Some(second) = parse_u32_digits(second_text) else {
        return false;
    };
    if second_text.len() != 2
        || fraction.is_some_and(|fraction| {
            fraction.is_empty() || !fraction.as_bytes().iter().all(u8::is_ascii_digit)
        })
    {
        return false;
    }

    if month == 0
        || month > 12
        || day == 0
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return false;
    }

    if offset == "Z" {
        return true;
    }
    if offset.len() != 6 || offset.as_bytes().get(3) != Some(&b':') {
        return false;
    }
    let Some(offset_hour) = parse_u32_digits(&offset[1..3]) else {
        return false;
    };
    let Some(offset_minute) = parse_u32_digits(&offset[4..6]) else {
        return false;
    };
    offset_hour <= 23 && offset_minute <= 59
}

fn parse_u32_digits(value: &str) -> Option<u32> {
    if value.is_empty() || !value.as_bytes().iter().all(u8::is_ascii_digit) {
        return None;
    }
    value.parse().ok()
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

fn is_leap_year(year: u32) -> bool {
    year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400))
}

fn assert_required_bool(
    record: &Map<String, Value>,
    key: &str,
    label: &str,
) -> BridgeContractResult<bool> {
    required(record, key, label)?
        .as_bool()
        .ok_or_else(|| BridgeContractValidationError::new(format!("{label} must be a boolean")))
}

fn assert_required_non_negative_integer(
    record: &Map<String, Value>,
    key: &str,
    label: &str,
) -> BridgeContractResult<u64> {
    non_negative_integer_value(required(record, key, label)?, label)
}

fn non_negative_integer_value(value: &Value, label: &str) -> BridgeContractResult<u64> {
    value.as_u64().ok_or_else(|| {
        BridgeContractValidationError::new(format!("{label} must be a non-negative integer"))
    })
}

fn assert_required_positive_integer(
    record: &Map<String, Value>,
    key: &str,
    label: &str,
) -> BridgeContractResult<u64> {
    positive_integer_value(required(record, key, label)?, label)
}

fn positive_integer_value(value: &Value, label: &str) -> BridgeContractResult<u64> {
    match value.as_u64() {
        Some(value) if value > 0 => Ok(value),
        _ => error(format!("{label} must be a positive integer")),
    }
}

fn required_number(
    record: &Map<String, Value>,
    key: &str,
    label: &str,
) -> BridgeContractResult<f64> {
    let value = required(record, key, label)?.as_f64().ok_or_else(|| {
        BridgeContractValidationError::new(format!("{label} must be a non-negative number"))
    })?;
    if value < 0.0 || !value.is_finite() {
        return error(format!("{label} must be a non-negative number"));
    }
    Ok(value)
}

fn assert_required_ratio(
    record: &Map<String, Value>,
    key: &str,
    label: &str,
) -> BridgeContractResult<f64> {
    ratio_value(required(record, key, label)?, label)
}

fn ratio_value(value: &Value, label: &str) -> BridgeContractResult<f64> {
    let value = value.as_f64().ok_or_else(|| {
        BridgeContractValidationError::new(format!("{label} must be a number between 0 and 1"))
    })?;
    if (0.0..=1.0).contains(&value) && value.is_finite() {
        Ok(value)
    } else {
        error(format!("{label} must be a number between 0 and 1"))
    }
}

fn assert_string_array(value: &Value, label: &str) -> BridgeContractResult<()> {
    let array = array_value(value, label)?;
    for (index, item) in array.iter().enumerate() {
        string_value(item, &format!("{label}[{index}]"))?;
    }
    Ok(())
}

fn assert_uuid7_array(value: &Value, label: &str) -> BridgeContractResult<Vec<String>> {
    let array = array_value(value, label)?;
    let mut ids = Vec::new();
    for (index, item) in array.iter().enumerate() {
        let item = string_value(item, &format!("{label}[{index}]"))?;
        assert_uuid7(item, &format!("{label}[{index}]"))?;
        ids.push(item.to_string());
    }
    Ok(ids)
}

fn assert_string_enum_array(
    value: &Value,
    allowed: &[&str],
    label: &str,
) -> BridgeContractResult<()> {
    let array = array_value(value, label)?;
    for (index, item) in array.iter().enumerate() {
        let item = string_value(item, &format!("{label}[{index}]"))?;
        assert_one_of(item, allowed, &format!("{label}[{index}]"))?;
    }
    Ok(())
}

fn assert_known_uuid_refs(
    value: &Value,
    label: &str,
    target_name: &str,
    known_ids: &HashSet<String>,
) -> BridgeContractResult<Vec<String>> {
    let ids = assert_uuid7_array(value, label)?;
    for (index, id) in ids.iter().enumerate() {
        if !known_ids.contains(id) {
            return error(format!(
                "{label}[{index}] must reference an existing {target_name}"
            ));
        }
    }
    Ok(ids)
}

fn assert_known_string(
    id: &str,
    label: &str,
    target_name: &str,
    known_ids: &HashSet<String>,
) -> BridgeContractResult<()> {
    if known_ids.contains(id) {
        Ok(())
    } else {
        error(format!("{label} must reference an existing {target_name}"))
    }
}

fn assert_exact_string_set(
    values: &HashSet<String>,
    expected_values: &[&str],
    label: &str,
) -> BridgeContractResult<()> {
    for expected in expected_values {
        if !values.contains(*expected) {
            return error(format!("{label} must include {expected}"));
        }
    }
    for value in values {
        if !expected_values.contains(&value.as_str()) {
            return error(format!("{label} contains unsupported value {value}"));
        }
    }
    Ok(())
}

fn validate_alpha_proof_artifact_ref(
    value: &Value,
    label: &str,
    expected_kind: &str,
) -> BridgeContractResult<(String, String, String)> {
    let artifact_ref = as_record(value, label)?;
    assert_record_keys(
        artifact_ref,
        &[
            "artifactId",
            "artifactKind",
            "uri",
            "hash",
            "mediaType",
            "byteSize",
        ],
        label,
    )?;
    assert_required_uuid7(artifact_ref, "artifactId", &format!("{label}.artifactId"))?;
    let kind = assert_required_one_of(
        artifact_ref,
        "artifactKind",
        ALPHA_VERTICAL_PROOF_ARTIFACT_KINDS_V02,
        &format!("{label}.artifactKind"),
    )?;
    if kind != expected_kind {
        return error(format!("{label}.artifactKind must be {expected_kind}"));
    }
    assert_required_public_uri(artifact_ref, "uri", &format!("{label}.uri"))?;
    let uri = assert_required_string(artifact_ref, "uri", &format!("{label}.uri"))?;
    let hash = assert_required_hash(artifact_ref, "hash", &format!("{label}.hash"))?;
    if let Some(media_type) = artifact_ref.get("mediaType") {
        string_value(media_type, &format!("{label}.mediaType"))?;
    }
    if let Some(byte_size) = artifact_ref.get("byteSize") {
        positive_integer_value(byte_size, &format!("{label}.byteSize"))?;
    }
    Ok((kind.to_string(), uri.to_string(), hash.to_string()))
}

fn validate_alpha_proof_content_hashes(
    value: &Value,
    label: &str,
) -> BridgeContractResult<Vec<(String, String, String)>> {
    let hashes = array_value(value, label)?;
    if hashes.is_empty() {
        return error(format!("{label} must contain at least one content hash"));
    }
    let mut entries = Vec::new();
    let mut keys = HashSet::new();
    for (index, hash) in hashes.iter().enumerate() {
        let hash_label = format!("{label}[{index}]");
        let entry = as_record(hash, &hash_label)?;
        assert_record_keys(entry, &["scope", "contentId", "hash"], &hash_label)?;
        let scope = assert_required_one_of(
            entry,
            "scope",
            ALPHA_VERTICAL_PROOF_HASH_SCOPES_V02,
            &format!("{hash_label}.scope"),
        )?;
        let content_id =
            assert_required_string(entry, "contentId", &format!("{hash_label}.contentId"))?;
        let hash = assert_required_hash(entry, "hash", &format!("{hash_label}.hash"))?;
        let key = format!("{scope}\0{content_id}");
        if !keys.insert(key) {
            return error(format!(
                "{hash_label} must be unique by scope and contentId"
            ));
        }
        entries.push((scope.to_string(), content_id.to_string(), hash.to_string()));
    }
    Ok(entries)
}

fn assert_alpha_hash_covered(
    hashes: &[(String, String, String)],
    scope: &str,
    content_id: &str,
    hash: &str,
    label: &str,
) -> BridgeContractResult<()> {
    if hashes
        .iter()
        .any(|(candidate_scope, candidate_content_id, candidate_hash)| {
            candidate_scope == scope && candidate_content_id == content_id && candidate_hash == hash
        })
    {
        Ok(())
    } else {
        error(format!(
            "{label} must be represented in AlphaVerticalProofManifestV02.contentHashes"
        ))
    }
}

fn assert_alpha_hash_scope_content_id(
    hashes: &[(String, String, String)],
    scope: &str,
    content_id: &str,
    label: &str,
) -> BridgeContractResult<()> {
    if hashes
        .iter()
        .any(|(candidate_scope, candidate_content_id, _candidate_hash)| {
            candidate_scope == scope && candidate_content_id == content_id
        })
    {
        Ok(())
    } else {
        error(format!(
            "{label} must be represented in AlphaVerticalProofManifestV02.contentHashes"
        ))
    }
}

fn alpha_hash_scope_for_artifact_kind(kind: &str) -> &str {
    match kind {
        "public_fixture_manifest" => "public_fixture_manifest",
        "bridge_bundle" => "bridge_bundle",
        "patch_export" => "patch_export",
        "patch_result" => "patch_result",
        "delta_package" => "delta_package",
        "runtime_report" => "runtime_report",
        "finding_report" => "finding_report",
        "benchmark_report" => "benchmark_report",
        _ => unreachable!(),
    }
}

fn assert_fixture_path_value(value: &Value, label: &str) -> BridgeContractResult<()> {
    let value = string_value(value, label)?;
    assert_fixture_path(value, label)
}

fn assert_fixture_path(value: &str, label: &str) -> BridgeContractResult<()> {
    if !value.starts_with("./") {
        return error(format!(
            "{label} must be a relative fixture path starting with ./"
        ));
    }
    // reason: this validates an already-normalized relative fixture path against
    // a deliberate literal lowercase `.json` suffix contract (not a filesystem
    // extension probe); a case-insensitive `Path::extension` match would weaken
    // the normalization guarantee and change accepted inputs.
    #[allow(clippy::case_sensitive_file_extension_comparisons)]
    let is_json_suffix = value.ends_with(".json");
    if value.contains("..") || value.contains("//") || !is_json_suffix {
        return error(format!("{label} must be a normalized JSON fixture path"));
    }
    assert_portable_path(value, label)
}

fn assert_fixture_path_array(
    value: &Value,
    label: &str,
    require_non_empty: bool,
) -> BridgeContractResult<()> {
    let paths = array_value(value, label)?;
    if require_non_empty && paths.is_empty() {
        return error(format!("{label} must contain at least one fixture path"));
    }
    for (index, path) in paths.iter().enumerate() {
        assert_fixture_path_value(path, &format!("{label}[{index}]"))?;
    }
    Ok(())
}

fn assert_unique_path(
    paths: &mut HashSet<String>,
    path: &str,
    label: &str,
) -> BridgeContractResult<()> {
    if !paths.insert(path.to_string()) {
        return error(format!(
            "{label}.path must be unique within the contract fixture manifest"
        ));
    }
    Ok(())
}

fn assert_command_tokens(value: &Value, label: &str) -> BridgeContractResult<()> {
    let tokens = array_value(value, label)?;
    if tokens.is_empty() {
        return error(format!("{label} must contain at least one command token"));
    }
    for (index, token) in tokens.iter().enumerate() {
        string_value(token, &format!("{label}[{index}]"))?;
    }
    Ok(())
}

fn assert_portable_uri(value: &Value, label: &str) -> BridgeContractResult<()> {
    let value = string_value(value, label)?;
    assert_portable_path(value, label)?;
    if value.starts_with("data:") || value.starts_with("file:") {
        return error(format!(
            "{label} must reference an artifact, not embed artifact bytes"
        ));
    }
    Ok(())
}

fn assert_required_public_uri(
    record: &Map<String, Value>,
    key: &str,
    label: &str,
) -> BridgeContractResult<()> {
    let value = required(record, key, label)?;
    assert_portable_uri(value, label)?;
    let value = string_value(value, label)?;
    if value.contains("fixtures/private-local/") {
        return error(format!("{label} must not reference fixtures/private-local"));
    }
    Ok(())
}

fn assert_portable_path(value: &str, label: &str) -> BridgeContractResult<()> {
    if value.starts_with('/') {
        return error(format!(
            "{label} must be portable and must not be an absolute local path"
        ));
    }
    if value.contains('\\') || value.as_bytes().get(1) == Some(&b':') {
        return error(format!(
            "{label} must use portable forward-slash artifact paths"
        ));
    }
    Ok(())
}

fn assert_number_within_tolerance(
    value: f64,
    expected: f64,
    label: &str,
    expectation: &str,
) -> BridgeContractResult<()> {
    if (value - expected).abs() > 0.01 {
        error(format!("{label} must match {expectation}"))
    } else {
        Ok(())
    }
}

fn assert_no_confidence_fields(value: &Value, label: &str) -> BridgeContractResult<()> {
    match value {
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                assert_no_confidence_fields(item, &format!("{label}[{index}]"))?;
            }
        }
        Value::Object(object) => {
            for (key, child) in object {
                if key.to_ascii_lowercase().contains("confidence") {
                    return error(format!(
                        "{label}.{key} is not allowed; record evidence instead of confidence"
                    ));
                }
                assert_no_confidence_fields(child, &format!("{label}.{key}"))?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn assert_no_raw_private_or_secret_fields(value: &Value, label: &str) -> BridgeContractResult<()> {
    match value {
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                assert_no_raw_private_or_secret_fields(item, &format!("{label}[{index}]"))?;
            }
        }
        Value::Object(object) => {
            for (key, child) in object {
                if [
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
                ]
                .contains(&key.as_str())
                {
                    return error(format!(
                        "{label}.{key} is not allowed; record ids, hashes, or artifact refs"
                    ));
                }
                assert_no_raw_private_or_secret_fields(child, &format!("{label}.{key}"))?;
            }
        }
        Value::String(value) if value.contains("fixtures/private-local/") => {
            return error(format!("{label} must not reference fixtures/private-local"));
        }
        _ => {}
    }
    Ok(())
}

fn assert_no_mutable_event_bucket_fields(value: &Value, label: &str) -> BridgeContractResult<()> {
    match value {
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                assert_no_mutable_event_bucket_fields(item, &format!("{label}[{index}]"))?;
            }
        }
        Value::Object(object) => {
            for (key, child) in object {
                if ["status", "currentStatus", "updatedAt", "deletedAt"].contains(&key.as_str()) {
                    return error(format!(
                        "{label}.{key} is not allowed on append-only events"
                    ));
                }
                assert_no_mutable_event_bucket_fields(child, &format!("{label}.{key}"))?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn error<T>(message: impl Into<String>) -> BridgeContractResult<T> {
    Err(BridgeContractValidationError::new(message))
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::validate_runtime_evidence_report_v02;

    fn runtime_evidence_with_observation_hook() -> Value {
        json!({
            "schemaVersion": "0.2.0",
            "runtimeReportId": "019ed003-0000-7000-8000-000000000901",
            "adapterName": "utsushi-contract-test",
            "adapterVersion": "0.2.0",
            "fidelityTier": "trace_only",
            "evidenceTier": "E1",
            "status": "passed",
            "createdAt": "2026-06-17T00:00:00.000Z",
            "traceEvents": [],
            "branchEvents": [],
            "observationHookEvents": [
                {
                    "schemaVersion": "0.1.0-alpha",
                    "eventId": "obs-0001",
                    "observedAt": "2026-06-17T00:00:00.000Z",
                    "eventKind": "text",
                    "runtimeTargetId": "fixture:runtime-target",
                    "adapterId": {
                        "name": "utsushi-contract-test",
                        "version": "0.2.0"
                    },
                    "evidenceTier": "E1",
                    "environment": {
                        "runtime": "browser"
                    },
                    "bridgeRefs": [
                        {
                            "bridgeUnitId": "019ed001-0000-7000-8000-000000000201",
                            "sourceUnitKey": "script/prologue#line-001"
                        }
                    ],
                    "redaction": {
                        "status": "not_required"
                    },
                    "payload": {
                        "payloadKind": "text",
                        "text": "Bonjour, {player}."
                    }
                }
            ],
            "captures": [],
            "recordings": [],
            "approximations": [
                {
                    "approximationId": "019ed003-0000-7000-8000-000000000902",
                    "approximationTier": "deterministic_fixture",
                    "scope": "fixture runtime hook",
                    "description": "Observation hook evidence comes from a deterministic fixture route.",
                    "affectedBridgeUnitRefs": [
                        {
                            "bridgeUnitId": "019ed001-0000-7000-8000-000000000201",
                            "sourceUnitKey": "script/prologue#line-001"
                        }
                    ],
                    "evidenceTierCeiling": "E1"
                }
            ],
            "validationFindings": [],
            "limitations": []
        })
    }

    #[test]
    fn runtime_evidence_accepts_observation_hook_events() {
        let report = runtime_evidence_with_observation_hook();

        validate_runtime_evidence_report_v02(&report).unwrap();
    }

    #[test]
    fn runtime_evidence_rejects_invalid_observation_observed_at() {
        let mut report = runtime_evidence_with_observation_hook();
        report["observationHookEvents"][0]["observedAt"] = json!("2026-02-30T00:00:00.000Z");

        let error = validate_runtime_evidence_report_v02(&report)
            .unwrap_err()
            .to_string();
        assert!(error.contains("observationHookEvents[0].observedAt"));
    }

    #[test]
    fn runtime_evidence_rejects_blank_observation_redaction_rules() {
        let mut report = runtime_evidence_with_observation_hook();
        report["observationHookEvents"][0]["redaction"] = json!({
            "status": "redacted",
            "rules": [" "],
            "redactedFields": ["payload.text"]
        });

        let error = validate_runtime_evidence_report_v02(&report)
            .unwrap_err()
            .to_string();
        assert!(error.contains("observationHookEvents[0].redaction.rules[0]"));
    }

    #[test]
    fn runtime_evidence_rejects_observation_payload_kind_mismatch() {
        let mut report = runtime_evidence_with_observation_hook();
        report["observationHookEvents"][0]["eventKind"] = json!("error");

        let error = validate_runtime_evidence_report_v02(&report)
            .unwrap_err()
            .to_string();
        assert!(error.contains("eventKind must match"));
    }

    use super::validate_patch_result_v02;

    fn passed_patch_result_fixture() -> Value {
        // Rollup of the two touched assets below.
        json!({
            "schemaVersion": "0.2.0",
            "patchResultId": "019ed001-0000-7000-8000-000000000950",
            "patchExportId": "019ed001-0000-7000-8000-000000000901",
            "adapterId": "kaifuu-reallive",
            "status": "passed",
            "outputHash": "sha256:da95500381246b4466b73a2dd6fc2610ad5ecea58719c2e9d28c4805ac24c83d",
            "touchedAssets": [
                {
                    "assetId": "019ed001-0000-7000-8000-000000000810",
                    "outputHash": "sha256:fa01799c693dbf37732740572dde0106c2d67bed57a5955528687642896968e1",
                    "byteSize": 64
                },
                {
                    "assetId": "019ed001-0000-7000-8000-000000000811",
                    "outputHash": "sha256:8566707ead9fabf49905b018e40ab4772e166d6f0c6e126ebdb5e6af7a7258ca",
                    "byteSize": 72
                }
            ],
            "failures": []
        })
    }

    #[test]
    fn patch_result_v02_accepts_passed_fixture_with_matching_rollup() {
        validate_patch_result_v02(&passed_patch_result_fixture()).unwrap();
    }

    #[test]
    fn patch_result_v02_rejects_passed_without_output_hash() {
        let mut fixture = passed_patch_result_fixture();
        fixture.as_object_mut().unwrap().remove("outputHash");
        let error = validate_patch_result_v02(&fixture).unwrap_err().to_string();
        assert!(
            error.contains("kaifuu.patch_result.passed_requires_output_hash"),
            "{error}"
        );
    }

    #[test]
    fn patch_result_v02_rejects_passed_without_touched_assets() {
        let mut fixture = passed_patch_result_fixture();
        fixture.as_object_mut().unwrap().remove("touchedAssets");
        let error = validate_patch_result_v02(&fixture).unwrap_err().to_string();
        assert!(
            error.contains("kaifuu.patch_result.passed_requires_touched_assets"),
            "{error}"
        );
    }

    #[test]
    fn patch_result_v02_rejects_output_hash_drift() {
        let mut fixture = passed_patch_result_fixture();
        fixture["outputHash"] =
            json!("sha256:0000000000000000000000000000000000000000000000000000000000000000");
        let error = validate_patch_result_v02(&fixture).unwrap_err().to_string();
        assert!(
            error.contains("kaifuu.patch_result.output_hash_drift"),
            "{error}"
        );
    }

    #[test]
    fn patch_result_v02_rejects_failed_without_failure_categories() {
        let fixture = json!({
            "schemaVersion": "0.2.0",
            "patchResultId": "019ed001-0000-7000-8000-000000000951",
            "patchExportId": "019ed001-0000-7000-8000-000000000901",
            "adapterId": "kaifuu-reallive",
            "status": "failed",
            "failures": [
                {
                    "failureId": "019ed001-0000-7000-8000-000000000a01",
                    "category": "patch_write_failed",
                    "diagnosticCode": "kaifuu.reallive.patchback_offset_overflow",
                    "cause": "offset overflow",
                    "assetId": "019ed001-0000-7000-8000-000000000810",
                    "bridgeUnitId": "019ed001-0000-7000-8000-000000000201",
                    "adapterId": "kaifuu-reallive",
                    "command": "patch.write_string_slot"
                }
            ]
        });
        let error = validate_patch_result_v02(&fixture).unwrap_err().to_string();
        assert!(
            error.contains("kaifuu.patch_result.missing_failure_category"),
            "{error}"
        );
    }

    #[test]
    fn patch_result_v02_rejects_silent_partial_write_attempted_mismatch() {
        let fixture = json!({
            "schemaVersion": "0.2.0",
            "patchResultId": "019ed001-0000-7000-8000-000000000952",
            "patchExportId": "019ed001-0000-7000-8000-000000000901",
            "adapterId": "kaifuu-reallive",
            "status": "failed",
            "failures": [
                {
                    "failureId": "019ed001-0000-7000-8000-000000000a02",
                    "category": "patch_write_failed",
                    "diagnosticCode": "kaifuu.reallive.patchback_offset_overflow",
                    "cause": "offset overflow",
                    "assetId": "019ed001-0000-7000-8000-000000000810",
                    "bridgeUnitId": "019ed001-0000-7000-8000-000000000201",
                    "adapterId": "kaifuu-reallive",
                    "command": "patch.write_string_slot"
                }
            ],
            "failureCategories": ["patch_write_failed"],
            "partialWrite": {
                "attemptedAssetIds": [
                    "019ed001-0000-7000-8000-000000000810",
                    "019ed001-0000-7000-8000-000000000811"
                ],
                "writtenAssetIds": ["019ed001-0000-7000-8000-000000000810"],
                "skippedAssetIds": [],
                "disposition": "rolled_back",
                "rollbackDiagnosticCode": "kaifuu.reallive.rollback_complete"
            }
        });
        let error = validate_patch_result_v02(&fixture).unwrap_err().to_string();
        assert!(
            error.contains("kaifuu.patch_result.silent_partial_write"),
            "{error}"
        );
    }

    #[test]
    fn patch_result_v02_rejects_rolled_back_without_rollback_diagnostic() {
        let fixture = json!({
            "schemaVersion": "0.2.0",
            "patchResultId": "019ed001-0000-7000-8000-000000000953",
            "patchExportId": "019ed001-0000-7000-8000-000000000901",
            "adapterId": "kaifuu-reallive",
            "status": "failed",
            "failures": [
                {
                    "failureId": "019ed001-0000-7000-8000-000000000a03",
                    "category": "patch_write_failed",
                    "diagnosticCode": "kaifuu.reallive.patchback_offset_overflow",
                    "cause": "offset overflow",
                    "assetId": "019ed001-0000-7000-8000-000000000810",
                    "bridgeUnitId": "019ed001-0000-7000-8000-000000000201",
                    "adapterId": "kaifuu-reallive",
                    "command": "patch.write_string_slot"
                }
            ],
            "failureCategories": ["patch_write_failed"],
            "partialWrite": {
                "attemptedAssetIds": ["019ed001-0000-7000-8000-000000000810"],
                "writtenAssetIds": [],
                "skippedAssetIds": ["019ed001-0000-7000-8000-000000000810"],
                "disposition": "rolled_back"
            }
        });
        let error = validate_patch_result_v02(&fixture).unwrap_err().to_string();
        assert!(
            error.contains("kaifuu.patch_result.rollback_diagnostic_required"),
            "{error}"
        );
    }

    #[test]
    fn patch_result_v02_accepts_retained_partial_without_rollback_diagnostic() {
        let fixture = json!({
            "schemaVersion": "0.2.0",
            "patchResultId": "019ed001-0000-7000-8000-000000000954",
            "patchExportId": "019ed001-0000-7000-8000-000000000901",
            "adapterId": "kaifuu-reallive",
            "status": "failed",
            "failures": [
                {
                    "failureId": "019ed001-0000-7000-8000-000000000a04",
                    "category": "patch_write_failed",
                    "diagnosticCode": "kaifuu.reallive.patchback_offset_overflow",
                    "cause": "mid-write corruption could not be rolled back",
                    "assetId": "019ed001-0000-7000-8000-000000000810",
                    "bridgeUnitId": "019ed001-0000-7000-8000-000000000201",
                    "adapterId": "kaifuu-reallive",
                    "command": "patch.write_string_slot"
                }
            ],
            "failureCategories": ["patch_write_failed"],
            "partialWrite": {
                "attemptedAssetIds": ["019ed001-0000-7000-8000-000000000810"],
                "writtenAssetIds": ["019ed001-0000-7000-8000-000000000810"],
                "skippedAssetIds": [],
                "disposition": "retained_partial"
            }
        });
        validate_patch_result_v02(&fixture).unwrap();
    }

    #[test]
    fn patch_result_v02_rejects_incompatible_source_non_source_failure_category() {
        let fixture = json!({
            "schemaVersion": "0.2.0",
            "patchResultId": "019ed001-0000-7000-8000-000000000955",
            "patchExportId": "019ed001-0000-7000-8000-000000000901",
            "adapterId": "kaifuu-reallive",
            "status": "incompatible_source",
            "failures": [
                {
                    "failureId": "019ed001-0000-7000-8000-000000000a05",
                    "category": "patch_write_failed",
                    "diagnosticCode": "kaifuu.reallive.patchback_offset_overflow",
                    "cause": "wrong category",
                    "assetId": "019ed001-0000-7000-8000-000000000810",
                    "bridgeUnitId": "019ed001-0000-7000-8000-000000000201",
                    "adapterId": "kaifuu-reallive",
                    "command": "patch.write_string_slot"
                }
            ],
            "failureCategories": ["patch_write_failed"],
            "sourceCompatibility": {
                "schemaVersion": "0.2.0",
                "patchExportId": "019ed001-0000-7000-8000-000000000901",
                "sourceBridgeId": "019ed001-0000-7000-8000-000000000001",
                "status": "incompatible",
                "expectedSourceBundleHash": "sha256:fd8dc24ee34b959fbd2beb9af53af65f5a376da5cb392bf4ef7246aff8804647",
                "actualSourceBundleHash": "sha256:530752517d6fe6af8505a362c5da79a034a16bb1c73b9c3b4c2e5bd5c2a2c060",
                "sourceBundleHashMatches": false,
                "compatibleUnits": [],
                "incompatibleUnits": [
                    {
                        "entryId": "019ed001-0000-7000-8000-000000000910",
                        "bridgeUnitId": "019ed001-0000-7000-8000-000000000201",
                        "sourceUnitKey": "script/prologue#line-001",
                        "status": "incompatible",
                        "expectedSourceHash": "sha256:fa01799c693dbf37732740572dde0106c2d67bed57a5955528687642896968e1",
                        "actualSourceHash": "sha256:ee738430dc6b47e520cbf9de9a54130e50671aa69dfd4d05bc447a9cbb980ea3",
                        "reason": "source_hash_mismatch"
                    }
                ]
            }
        });
        let error = validate_patch_result_v02(&fixture).unwrap_err().to_string();
        assert!(
            error.contains("kaifuu.patch_result.incompatible_source_category_required"),
            "{error}"
        );
    }

    #[test]
    fn patch_result_v02_rejects_passed_with_failures() {
        let mut fixture = passed_patch_result_fixture();
        fixture["failures"] = json!([
            {
                "failureId": "019ed001-0000-7000-8000-000000000a06",
                "category": "patch_write_failed",
                "diagnosticCode": "kaifuu.reallive.patchback_offset_overflow",
                "cause": "spurious",
                "assetId": "019ed001-0000-7000-8000-000000000810",
                "bridgeUnitId": "019ed001-0000-7000-8000-000000000201",
                "adapterId": "kaifuu-reallive",
                "command": "patch.write_string_slot"
            }
        ]);
        let error = validate_patch_result_v02(&fixture).unwrap_err().to_string();
        assert!(
            error.contains("kaifuu.patch_result.passed_must_have_no_failures"),
            "{error}"
        );
    }
}
