//! Single-profile alpha readiness validation.
//! Classifies each finding as an out-of-profile boundary or an in-profile bug.

use crate::packed_engine_readiness::EngineProfileSpec;
use crate::{
    AdapterCapabilityMatrix, CapabilityLevel, CapabilityLevelStatus, LayeredAccessHelperStatus,
    LayeredAccessKeyMaterialStatus, OperationStatus, PartialDiagnosticSeverity, PatchBackTransform,
    SemanticErrorCode,
};

use super::{
    ALPHA_READINESS_PROFILE_SCHEMA_VERSION, AlphaOperationStatuses, AlphaReadinessEntry,
    AlphaReadinessFinding, AlphaReadinessProfile, ReadinessFailureClass, helper_status_str,
    key_status_str,
};

pub(super) fn finding(
    code: &str,
    severity: PartialDiagnosticSeverity,
    failure_class: ReadinessFailureClass,
    field: &str,
    message: String,
    semantic_code: SemanticErrorCode,
) -> AlphaReadinessFinding {
    AlphaReadinessFinding {
        code: code.to_string(),
        severity,
        failure_class,
        field: field.to_string(),
        message,
        semantic_code: semantic_code.as_str().to_string(),
    }
}

/// The highest rung the matrix claims as strictly `supported`.
fn highest_supported_level(matrix: &AdapterCapabilityMatrix) -> Option<CapabilityLevel> {
    CapabilityLevel::all()
        .into_iter()
        .rfind(|level| matrix.supports(*level))
}

fn is_claimed(status: &CapabilityLevelStatus) -> bool {
    status.is_supported() || status.is_partial()
}

/// A real, usable patch-back write mode (vs. `Unsupported`/`Unknown`).
fn is_write_mode(mode: PatchBackTransform) -> bool {
    matches!(mode, PatchBackTransform::RepackArchive)
}

fn ref_looks_like_path(value: &str) -> bool {
    value.contains('/')
        || value.contains('\\')
        || value.contains(char::is_whitespace)
        || value.contains("..")
}

/// Validate a single alpha readiness profile, producing one structured entry.
/// Never panics, never returns `Err`; every inconsistency is a classified
/// finding.
pub fn validate_alpha_readiness_profile(profile: &AlphaReadinessProfile) -> AlphaReadinessEntry {
    let mut findings: Vec<AlphaReadinessFinding> = Vec::new();

    if profile.schema_version != ALPHA_READINESS_PROFILE_SCHEMA_VERSION {
        findings.push(finding(
            "alpha.readiness.schema_version_mismatch",
            PartialDiagnosticSeverity::P1,
            ReadinessFailureClass::InProfileBug,
            "schemaVersion",
            format!(
                "profile declared schemaVersion {} but validator expects {}",
                profile.schema_version, ALPHA_READINESS_PROFILE_SCHEMA_VERSION
            ),
            SemanticErrorCode::UnsupportedEngineVariant,
        ));
    }
    if profile.profile_id.trim().is_empty() {
        findings.push(finding(
            "alpha.readiness.profile_id_missing",
            PartialDiagnosticSeverity::P0,
            ReadinessFailureClass::InProfileBug,
            "profileId",
            "profile is missing a non-empty profileId".to_string(),
            SemanticErrorCode::UnknownEngineVariant,
        ));
    }
    // A required backing fixture id must be present.
    if profile.fixture_id.trim().is_empty() {
        findings.push(finding(
            "alpha.readiness.fixture_missing",
            PartialDiagnosticSeverity::P0,
            ReadinessFailureClass::InProfileBug,
            "fixtureId",
            "profile is missing the required backing fixtureId".to_string(),
            SemanticErrorCode::UnsupportedEngineVariant,
        ));
    }
    if profile.prerequisite_proof.trim().is_empty() {
        findings.push(finding(
            "alpha.readiness.prerequisite_proof_missing",
            PartialDiagnosticSeverity::P0,
            ReadinessFailureClass::InProfileBug,
            "prerequisiteProof",
            "profile is missing the required prerequisiteProof reference".to_string(),
            SemanticErrorCode::UnsupportedEngineVariant,
        ));
    }

    // --- Provenance: must be generated from a public synthetic fixture (and
    // any private-aggregate supplement is a ref, never a path). ----------
    validate_provenance(profile, &mut findings);

    let Some(spec) = profile.engine_family.profile_spec() else {
        findings.push(finding(
            "alpha.readiness.unknown_engine_family",
            PartialDiagnosticSeverity::P0,
            ReadinessFailureClass::OutOfProfile,
            "engineFamily",
            "engineFamily is unknown / unrecognized (out of the alpha subset)".to_string(),
            SemanticErrorCode::UnknownEngineVariant,
        ));
        return build_entry(profile, findings);
    };

    validate_capability_claims(profile, &spec, &mut findings);

    validate_helper_key(profile, &mut findings);

    build_entry(profile, findings)
}

fn validate_provenance(profile: &AlphaReadinessProfile, findings: &mut Vec<AlphaReadinessFinding>) {
    let provenance = &profile.provenance;
    if !provenance.from_public_synthetic_fixture && provenance.private_aggregate_ref.is_none() {
        findings.push(finding(
            "alpha.readiness.provenance_missing",
            PartialDiagnosticSeverity::P0,
            ReadinessFailureClass::InProfileBug,
            "provenance",
            "profile declares no provenance (neither a public synthetic fixture nor a private-local aggregate reference)".to_string(),
            SemanticErrorCode::UnsupportedEngineVariant,
        ));
    }
    if let Some(reference) = &provenance.private_aggregate_ref
        && (reference.trim().is_empty() || ref_looks_like_path(reference))
    {
        findings.push(finding(
            "alpha.readiness.provenance_ref_invalid",
            PartialDiagnosticSeverity::P0,
            ReadinessFailureClass::InProfileBug,
            "provenance.privateAggregateRef",
            "privateAggregateRef must be a non-empty hash/id reference, never a local path"
                .to_string(),
            SemanticErrorCode::UnsupportedEngineVariant,
        ));
    }
}

fn validate_capability_claims(
    profile: &AlphaReadinessProfile,
    spec: &EngineProfileSpec,
    findings: &mut Vec<AlphaReadinessFinding>,
) {
    let matrix = &profile.capabilities;
    let key_status = profile.helper_key.key_status;
    let helper_status = profile.helper_key.helper_status;

    for level in CapabilityLevel::all() {
        let status = matrix.get(level);
        if !is_claimed(status) {
            // An honestly-unsupported rung is the declared boundary, not a
            // finding.
            continue;
        }
        // A claim PAST the engine family's theoretical ceiling is out-of-profile.
        if level > spec.capability_ceiling {
            findings.push(finding(
                "alpha.readiness.capability_overclaim",
                PartialDiagnosticSeverity::P0,
                ReadinessFailureClass::OutOfProfile,
                "capabilities",
                format!(
                    "engine {} ceiling is {} but profile claims {}",
                    profile.engine_family.as_str(),
                    spec.capability_ceiling.as_str(),
                    level.as_str()
                ),
                SemanticErrorCode::UnsupportedVariantPacked,
            ));
            continue;
        }
        // Extract/patch on a key-required engine need resolved key material.
        if level >= CapabilityLevel::Extract && spec.key_required {
            match key_status {
                LayeredAccessKeyMaterialStatus::Resolved => {}
                LayeredAccessKeyMaterialStatus::HelperGated
                    if helper_status == LayeredAccessHelperStatus::Available => {}
                LayeredAccessKeyMaterialStatus::HelperGated => findings.push(finding(
                    "alpha.readiness.helper_required_for_claimed_extract",
                    PartialDiagnosticSeverity::P0,
                    ReadinessFailureClass::InProfileBug,
                    "helperKey.helperStatus",
                    format!(
                        "engine {} claims {} but its key is helper-gated and the helper is not available",
                        profile.engine_family.as_str(),
                        level.as_str()
                    ),
                    SemanticErrorCode::HelperRequired,
                )),
                LayeredAccessKeyMaterialStatus::Missing
                | LayeredAccessKeyMaterialStatus::NotRequired => findings.push(finding(
                    "alpha.readiness.key_missing_for_claimed_extract",
                    PartialDiagnosticSeverity::P0,
                    ReadinessFailureClass::InProfileBug,
                    "helperKey.keyStatus",
                    format!(
                        "engine {} claims {} but requires key material the profile has not resolved (keyStatus {})",
                        profile.engine_family.as_str(),
                        level.as_str(),
                        key_status_str(key_status)
                    ),
                    SemanticErrorCode::MissingKeyMaterial,
                )),
            }
        }
        // A claimed patch rung needs a real patch-back write mode.
        if level == CapabilityLevel::Patch && !is_write_mode(profile.patch_back) {
            findings.push(finding(
                "alpha.readiness.patch_back_missing_for_claimed_patch",
                PartialDiagnosticSeverity::P0,
                ReadinessFailureClass::InProfileBug,
                "patchBack",
                format!(
                    "engine {} claims patch but patchBack {:?} is not a write mode",
                    profile.engine_family.as_str(),
                    profile.patch_back
                ),
                SemanticErrorCode::MissingPatchBackCapability,
            ));
        }
    }
}

fn validate_helper_key(profile: &AlphaReadinessProfile, findings: &mut Vec<AlphaReadinessFinding>) {
    let helper_key = &profile.helper_key;
    // Resolved key material must carry the (redaction-safe) reference.
    if helper_key.key_status == LayeredAccessKeyMaterialStatus::Resolved
        && helper_key.key_ref.is_none()
    {
        findings.push(finding(
            "alpha.readiness.key_ref_missing",
            PartialDiagnosticSeverity::P0,
            ReadinessFailureClass::InProfileBug,
            "helperKey.keyRef",
            "resolved key material must carry a keyRef".to_string(),
            SemanticErrorCode::MissingKeyMaterial,
        ));
    }
    // A required helper (available/unavailable) must name WHICH helper.
    if matches!(
        helper_key.helper_status,
        LayeredAccessHelperStatus::Available | LayeredAccessHelperStatus::Unavailable
    ) && helper_key.helper_id.is_none()
    {
        findings.push(finding(
            "alpha.readiness.helper_id_missing",
            PartialDiagnosticSeverity::P0,
            ReadinessFailureClass::InProfileBug,
            "helperKey.helperId",
            format!(
                "helperStatus {} requires a helperId",
                helper_status_str(helper_key.helper_status)
            ),
            SemanticErrorCode::HelperRequired,
        ));
    }
    // Redundant references are non-blocking notes, not failures.
    if helper_key.key_status == LayeredAccessKeyMaterialStatus::NotRequired
        && helper_key.key_ref.is_some()
    {
        findings.push(finding(
            "alpha.readiness.unexpected_key_ref",
            PartialDiagnosticSeverity::P2,
            ReadinessFailureClass::InProfileBug,
            "helperKey.keyRef",
            "keyStatus not_required should not carry a keyRef".to_string(),
            SemanticErrorCode::MissingKeyMaterial,
        ));
    }
    if helper_key.helper_status == LayeredAccessHelperStatus::NotRequired
        && helper_key.helper_id.is_some()
    {
        findings.push(finding(
            "alpha.readiness.unexpected_helper_id",
            PartialDiagnosticSeverity::P2,
            ReadinessFailureClass::InProfileBug,
            "helperKey.helperId",
            "helperStatus not_required should not carry a helperId".to_string(),
            SemanticErrorCode::HelperRequired,
        ));
    }
}

fn build_entry(
    profile: &AlphaReadinessProfile,
    findings: Vec<AlphaReadinessFinding>,
) -> AlphaReadinessEntry {
    let status = if findings.iter().any(|f| f.severity.is_blocking()) {
        OperationStatus::Failed
    } else {
        OperationStatus::Passed
    };
    let out_of_profile_finding_count = findings
        .iter()
        .filter(|f| f.failure_class == ReadinessFailureClass::OutOfProfile)
        .count() as u64;
    let in_profile_bug_count = findings
        .iter()
        .filter(|f| f.failure_class == ReadinessFailureClass::InProfileBug)
        .count() as u64;
    let highest = highest_supported_level(&profile.capabilities);
    // Detector/profile-only = detection is supported and NOTHING above it is
    // even claimed (every higher rung strictly unsupported — a `partial` claim
    // above identify means the engine reaches past detection).
    let matrix = &profile.capabilities;
    let detector_only = matrix.supports(CapabilityLevel::Identify)
        && !is_claimed(&matrix.inventory)
        && !is_claimed(&matrix.extract)
        && !is_claimed(&matrix.patch);
    AlphaReadinessEntry {
        profile_id: profile.profile_id.clone(),
        fixture_id: profile.fixture_id.clone(),
        source_node_id: profile.source_node_id.clone(),
        prerequisite_proof: profile.prerequisite_proof.clone(),
        engine_family: profile.engine_family,
        operations: AlphaOperationStatuses::from(&profile.capabilities, &profile.helper_key),
        highest_supported_level: highest,
        detector_only,
        helper_key: profile.helper_key.clone(),
        patch_back: profile.patch_back,
        provenance: profile.provenance.clone(),
        status,
        out_of_profile_finding_count,
        in_profile_bug_count,
        findings,
    }
}
