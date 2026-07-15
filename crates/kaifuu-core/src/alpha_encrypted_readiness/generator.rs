//! Generator: compose packed-engine readiness validation with synthetic
//! patch artifacts into alpha-encrypted readiness evidence.

use std::collections::BTreeMap;
use std::path::Path;

use crate::packed_engine_readiness::{
    PackedEngineReadinessProfile, PackedReadinessEntryReport, PackedReadinessValidationReport,
    validate_packed_engine_readiness_dir,
};
use crate::{
    KaifuuResult, LayeredAccessHelperStatus, LayeredAccessKeyMaterialStatus, OperationStatus,
    PackedReadinessOutcome, PackedReadinessPosture, PartialDiagnosticSeverity, ProofHash,
    SemanticErrorCode, read_json, redact_for_log_or_report, sha256_hash_bytes, stable_json,
};

use super::{
    ALPHA_ENCRYPTED_PATCH_ARTIFACT_SCHEMA_VERSION, ALPHA_ENCRYPTED_READINESS_REPORT_SCHEMA_VERSION,
    ALPHA_ENCRYPTED_READINESS_SUPPORT_BOUNDARY, ALPHA_ENCRYPTED_SOURCE_NODE_ID,
    AlphaEncryptedFinding, AlphaEncryptedPatchArtifact, AlphaEncryptedPatchResultRef,
    AlphaEncryptedReadinessEntry, AlphaEncryptedReadinessReport, ConsumedValidationReport, finding,
};

// Generator

/// True iff the effective outcome is a patch-capable profile-ready rung
/// (`extract`/`patch`) that therefore REQUIRES a patch-result reference.
pub(super) fn requires_patch_evidence(outcome: PackedReadinessOutcome) -> bool {
    matches!(
        outcome,
        PackedReadinessOutcome::Extract | PackedReadinessOutcome::Patch
    )
}

/// Build one evidence entry by joining a validator entry with its
/// (optional) profile fixture and patch artifacts. Pure; every inconsistency is
/// a structured finding.
pub(super) fn build_entry(
    validation_entry: &PackedReadinessEntryReport,
    profile: Option<&PackedEngineReadinessProfile>,
    artifacts: &[AlphaEncryptedPatchArtifact],
) -> AlphaEncryptedReadinessEntry {
    let mut findings: Vec<AlphaEncryptedFinding> = Vec::new();

    // --- Propagate any validation failure (never bless a rejected
    // profile). ------------------------------------------------------------
    if validation_entry.status == OperationStatus::Failed {
        let codes = validation_entry
            .findings
            .iter()
            .filter(|f| f.severity.is_blocking())
            .map(|f| f.code.clone())
            .collect::<Vec<_>>()
            .join(",");
        findings.push(finding(
            "alpha.encrypted.validation_failed",
            PartialDiagnosticSeverity::P0,
            "validationStatus",
            format!(
                "profile {} failed packed-engine readiness validation [{codes}]",
                validation_entry.profile_id
            ),
            SemanticErrorCode::UnsupportedEngineVariant,
        ));
    }

    // Surface ids are the synthetic in-archive asset ids from the profile.
    let surface_ids = if let Some(profile) = profile {
        let mut ids: Vec<String> = profile.content.iter().map(|c| c.asset_id.clone()).collect();
        ids.sort();
        ids
    } else {
        findings.push(finding(
            "alpha.encrypted.fixture_input_missing",
            PartialDiagnosticSeverity::P0,
            "profileId",
            format!(
                "no readable profile fixture for validated entry {}",
                validation_entry.profile_id
            ),
            SemanticErrorCode::UnknownEngineVariant,
        ));
        Vec::new()
    };

    if validation_entry.key_status == LayeredAccessKeyMaterialStatus::Resolved
        && validation_entry.key_ref.is_none()
    {
        findings.push(finding(
            "alpha.encrypted.key_metadata_missing",
            PartialDiagnosticSeverity::P0,
            "keyRef",
            format!(
                "profile {} has a resolved key but the report carries no keyRef",
                validation_entry.profile_id
            ),
            SemanticErrorCode::MissingKeyMaterial,
        ));
    }
    if matches!(
        validation_entry.helper_status,
        LayeredAccessHelperStatus::Available | LayeredAccessHelperStatus::Unavailable
    ) && validation_entry.helper_id.is_none()
    {
        findings.push(finding(
            "alpha.encrypted.helper_metadata_missing",
            PartialDiagnosticSeverity::P0,
            "helperId",
            format!(
                "profile {} requires a helper but the report carries no helperId",
                validation_entry.profile_id
            ),
            SemanticErrorCode::HelperRequired,
        ));
    }

    // A patch-capable profile-ready entry MUST carry exactly one patch result;
    // a readiness-only entry MUST NOT (overstating readiness as production
    // patch support is a hard error).
    let needs_patch = validation_entry.posture == PackedReadinessPosture::ProfileReady
        && requires_patch_evidence(validation_entry.effective_outcome);

    for artifact in artifacts {
        if artifact.patch_back != validation_entry.transform_stack.patch_back {
            findings.push(finding(
                "alpha.encrypted.patch_back_mismatch",
                PartialDiagnosticSeverity::P0,
                "patchBack",
                format!(
                    "patch artifact {} declares patchBack {:?} but profile {} uses {:?}",
                    artifact.patch_result_id,
                    artifact.patch_back,
                    validation_entry.profile_id,
                    validation_entry.transform_stack.patch_back
                ),
                SemanticErrorCode::MissingPatchBackCapability,
            ));
        }
        if artifact.status == OperationStatus::Passed && artifact.touched_assets.is_empty() {
            findings.push(finding(
                "alpha.encrypted.patch_result_empty",
                PartialDiagnosticSeverity::P0,
                "touchedAssets",
                format!(
                    "patch artifact {} is passed but touched no assets",
                    artifact.patch_result_id
                ),
                SemanticErrorCode::MissingPatchBackCapability,
            ));
        }
    }

    let patch_result = artifacts
        .first()
        .map(AlphaEncryptedPatchResultRef::from_artifact);

    if needs_patch && patch_result.is_none() {
        findings.push(finding(
            "alpha.encrypted.patch_result_ref_missing",
            PartialDiagnosticSeverity::P0,
            "patchResult",
            format!(
                "profile {} is profile-ready at {} but no patch artifact references it",
                validation_entry.profile_id,
                validation_entry.effective_outcome.as_str()
            ),
            SemanticErrorCode::MissingPatchBackCapability,
        ));
    }
    if !needs_patch && patch_result.is_some() {
        findings.push(finding(
            "alpha.encrypted.readiness_only_claims_patch",
            PartialDiagnosticSeverity::P0,
            "patchResult",
            format!(
                "profile {} is {} ({}) but carries a patch result — readiness must not claim patch support",
                validation_entry.profile_id,
                validation_entry.posture.as_str(),
                validation_entry.effective_outcome.as_str()
            ),
            SemanticErrorCode::UnsupportedLayeredTransform,
        ));
    }
    if artifacts.len() > 1 {
        findings.push(finding(
            "alpha.encrypted.ambiguous_patch_result",
            PartialDiagnosticSeverity::P0,
            "patchResult",
            format!(
                "profile {} has {} patch artifacts; expected at most one",
                validation_entry.profile_id,
                artifacts.len()
            ),
            SemanticErrorCode::AmbiguousEngineVariant,
        ));
    }

    let status = if findings.iter().any(|f| f.severity.is_blocking()) {
        OperationStatus::Failed
    } else {
        OperationStatus::Passed
    };

    AlphaEncryptedReadinessEntry {
        profile_id: validation_entry.profile_id.clone(),
        fixture_id: validation_entry.fixture_id.clone(),
        source_node_id: ALPHA_ENCRYPTED_SOURCE_NODE_ID.to_string(),
        engine_family: validation_entry.engine_family,
        transform_stack: validation_entry.transform_stack,
        surface_ids,
        declared_capability: validation_entry.declared_capability,
        effective_outcome: validation_entry.effective_outcome,
        posture: validation_entry.posture,
        key_status: validation_entry.key_status,
        key_ref: validation_entry.key_ref.clone(),
        key_requirement_id: validation_entry.key_requirement_id.clone(),
        helper_status: validation_entry.helper_status,
        helper_id: validation_entry.helper_id.clone(),
        content_hash: validation_entry.content_hash.clone(),
        content_entry_count: validation_entry.content_entry_count,
        validation_status: validation_entry.status.clone(),
        patch_result,
        status,
        findings,
    }
}

/// Compute the `sha256:` report hash over the canonical serialization of the
/// (already-sorted-by-profile-id) entries.
fn compute_report_hash(entries: &[AlphaEncryptedReadinessEntry]) -> KaifuuResult<ProofHash> {
    let redacted: Vec<AlphaEncryptedReadinessEntry> = entries
        .iter()
        .map(AlphaEncryptedReadinessEntry::redacted_for_report)
        .collect();
    let canonical = stable_json(&redacted)?;
    ProofHash::new(sha256_hash_bytes(canonical.as_bytes())).map_err(Into::into)
}

fn consumed_validation(
    validation: &PackedReadinessValidationReport,
) -> KaifuuResult<ConsumedValidationReport> {
    let canonical = validation.stable_json()?;
    let report_hash = ProofHash::new(sha256_hash_bytes(canonical.as_bytes()))?;
    Ok(ConsumedValidationReport {
        schema_version: validation.schema_version.clone(),
        status: validation.status.clone(),
        profile_count: validation.profile_count,
        profile_ready_count: validation.profile_ready_count,
        readiness_only_count: validation.readiness_only_count,
        report_hash,
    })
}

/// Synthetic patch artifacts grouped by the `profileId` they reference.
type PatchArtifactsByProfile = BTreeMap<String, Vec<AlphaEncryptedPatchArtifact>>;

/// Read every synthetic patch artifact (`*.patch.json`) under `dir`, grouped by
/// `profileId`. A malformed artifact becomes a report-level finding, never a
/// hard error.
fn read_patch_artifacts(
    dir: &Path,
) -> KaifuuResult<(PatchArtifactsByProfile, Vec<AlphaEncryptedFinding>)> {
    let mut by_profile: BTreeMap<String, Vec<AlphaEncryptedPatchArtifact>> = BTreeMap::new();
    let mut findings: Vec<AlphaEncryptedFinding> = Vec::new();

    let mut files: Vec<std::path::PathBuf> = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_file()
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".patch.json"))
        {
            files.push(path);
        }
    }
    files.sort();

    for path in &files {
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("<unknown>");
        match read_json::<AlphaEncryptedPatchArtifact>(path) {
            Ok(artifact) => {
                if artifact.schema_version != ALPHA_ENCRYPTED_PATCH_ARTIFACT_SCHEMA_VERSION {
                    findings.push(finding(
                        "alpha.encrypted.patch_artifact_schema_mismatch",
                        PartialDiagnosticSeverity::P1,
                        "schemaVersion",
                        format!(
                            "patch artifact {file_name} declared schemaVersion {} but generator expects {}",
                            artifact.schema_version, ALPHA_ENCRYPTED_PATCH_ARTIFACT_SCHEMA_VERSION
                        ),
                        SemanticErrorCode::UnsupportedEngineVariant,
                    ));
                }
                by_profile
                    .entry(artifact.profile_id.clone())
                    .or_default()
                    .push(artifact);
            }
            Err(error) => findings.push(finding(
                "alpha.encrypted.patch_artifact_unparseable",
                PartialDiagnosticSeverity::P0,
                "patchArtifact",
                format!(
                    "patch artifact {file_name} could not be parsed: {}",
                    redact_for_log_or_report(&error.to_string())
                ),
                SemanticErrorCode::UnsupportedEngineVariant,
            )),
        }
    }

    // Keep grouped artifacts in a stable order.
    for artifacts in by_profile.values_mut() {
        artifacts.sort_by(|a, b| a.patch_result_id.cmp(&b.patch_result_id));
    }

    Ok((by_profile, findings))
}

/// Read every readiness profile fixture (`*.profile.json`) under `dir`, keyed
/// by `profileId`, for surface-id extraction. Malformed fixtures are ignored
/// here — the validator already records them as failed entries.
fn read_profiles(dir: &Path) -> KaifuuResult<BTreeMap<String, PackedEngineReadinessProfile>> {
    let mut by_id = BTreeMap::new();
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        let is_profile = path.is_file()
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".profile.json"));
        if is_profile && let Ok(profile) = read_json::<PackedEngineReadinessProfile>(&path) {
            by_id.insert(profile.profile_id.clone(), profile);
        }
    }
    Ok(by_id)
}

/// Generate the alpha-encrypted readiness evidence report by COMPOSING the
/// validator output over `dir` with the synthetic patch artifacts in
/// the same directory. Never panics; every inconsistency is a structured
/// finding. Returns `Err` only on an environmental I/O / hashing failure.
pub fn generate_alpha_encrypted_readiness(
    dir: &Path,
) -> KaifuuResult<AlphaEncryptedReadinessReport> {
    // 1. Consume the packed-engine readiness validator output (do not reimplement it).
    let validation = validate_packed_engine_readiness_dir(dir)?;
    let consumed_validation = consumed_validation(&validation)?;

    // 2. Read the profile fixtures (surface ids) and synthetic patch artifacts.
    let profiles = read_profiles(dir)?;
    let (mut artifacts_by_profile, mut report_findings) = read_patch_artifacts(dir)?;

    // 3. Join each validated profile entry with its profile + patch artifacts.
    let mut entries: Vec<AlphaEncryptedReadinessEntry> =
        Vec::with_capacity(validation.profile_count as usize);
    for validation_entry in &validation.entries {
        let profile = profiles.get(&validation_entry.profile_id);
        let artifacts = artifacts_by_profile
            .remove(&validation_entry.profile_id)
            .unwrap_or_default();
        entries.push(build_entry(validation_entry, profile, &artifacts));
    }

    // 4. Any patch artifact that referenced no known profile is dangling.
    for (profile_id, artifacts) in &artifacts_by_profile {
        for artifact in artifacts {
            report_findings.push(finding(
                "alpha.encrypted.dangling_patch_artifact",
                PartialDiagnosticSeverity::P0,
                "patchArtifact",
                format!(
                    "patch artifact {} references unknown profileId {profile_id}",
                    artifact.patch_result_id
                ),
                SemanticErrorCode::UnknownEngineVariant,
            ));
        }
    }

    // 5. An empty fixture directory is a missing-input failure.
    if validation.profile_count == 0 {
        report_findings.push(finding(
            "alpha.encrypted.fixture_inputs_missing",
            PartialDiagnosticSeverity::P0,
            "fixturesDir",
            "alpha-encrypted fixture directory declares no readiness profile fixtures".to_string(),
            SemanticErrorCode::UnknownEngineVariant,
        ));
    }

    // 6. Stable order + counts + report hash.
    entries.sort_by(|a, b| a.profile_id.cmp(&b.profile_id));
    let profile_ready_count = entries
        .iter()
        .filter(|e| e.posture == PackedReadinessPosture::ProfileReady)
        .count() as u64;
    let readiness_only_count = entries
        .iter()
        .filter(|e| e.posture == PackedReadinessPosture::ReadinessOnly)
        .count() as u64;
    let patch_evidence_count = entries.iter().filter(|e| e.patch_result.is_some()).count() as u64;
    let report_hash = compute_report_hash(&entries)?;

    let entries_ok = entries.iter().all(|e| e.status == OperationStatus::Passed);
    let report_findings_blocking = report_findings.iter().any(|f| f.severity.is_blocking());
    let status = if entries_ok && !report_findings_blocking {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };

    Ok(AlphaEncryptedReadinessReport {
        schema_version: ALPHA_ENCRYPTED_READINESS_REPORT_SCHEMA_VERSION.to_string(),
        source_node_id: ALPHA_ENCRYPTED_SOURCE_NODE_ID.to_string(),
        support_boundary: ALPHA_ENCRYPTED_READINESS_SUPPORT_BOUNDARY.to_string(),
        status,
        consumed_validation,
        profile_count: entries.len() as u64,
        profile_ready_count,
        readiness_only_count,
        patch_evidence_count,
        entries,
        findings: report_findings,
        report_hash,
    })
}
