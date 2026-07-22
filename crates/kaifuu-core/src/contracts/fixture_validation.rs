use super::*;

#[path = "fixture_validation_contract.rs"]
mod contract;
pub use contract::*;

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
