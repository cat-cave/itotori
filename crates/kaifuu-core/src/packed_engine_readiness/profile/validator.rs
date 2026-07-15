use std::path::Path;

use crate::{
    CapabilityLevel, CodecTransform, ContainerTransform, CryptoTransform, KaifuuResult,
    LayeredAccessHelperStatus, LayeredAccessKeyMaterialStatus, OperationStatus,
    PartialDiagnosticSeverity, PatchBackTransform, ProofHash, SemanticErrorCode, SurfaceTransform,
    read_json, redact_for_log_or_report, sha256_hash_bytes,
};

use super::super::{
    EngineProfileSpec, PACKED_ENGINE_READINESS_SCHEMA_VERSION,
    PACKED_ENGINE_READINESS_SUPPORT_BOUNDARY, PACKED_READINESS_REPORT_SCHEMA_VERSION,
    PackedEngineFamily,
};
use super::{
    PackedEngineReadinessProfile, PackedReadinessEntryReport, PackedReadinessFinding,
    PackedReadinessOutcome, PackedReadinessPosture, PackedReadinessValidationReport,
    PackedTransformStack, derive_packed_readiness_outcome, recompute_content_hash,
};

// Validator

fn finding(
    code: &str,
    severity: PartialDiagnosticSeverity,
    field: &str,
    message: String,
    semantic_code: SemanticErrorCode,
) -> PackedReadinessFinding {
    PackedReadinessFinding {
        code: code.to_string(),
        severity,
        field: field.to_string(),
        message,
        semantic_code: semantic_code.as_str().to_string(),
    }
}

/// Validate a single packed-engine readiness profile, producing one structured
/// report entry. Every inconsistency is a structured finding; this never
/// panics and never returns `Err`.
pub fn validate_packed_engine_readiness_profile(
    profile: &PackedEngineReadinessProfile,
) -> PackedReadinessEntryReport {
    let mut findings: Vec<PackedReadinessFinding> = Vec::new();

    if profile.schema_version != PACKED_ENGINE_READINESS_SCHEMA_VERSION {
        findings.push(finding(
            "packed.readiness.schema_version_mismatch",
            PartialDiagnosticSeverity::P1,
            "schemaVersion",
            format!(
                "profile declared schemaVersion {} but validator expects {}",
                profile.schema_version, PACKED_ENGINE_READINESS_SCHEMA_VERSION
            ),
            SemanticErrorCode::UnsupportedEngineVariant,
        ));
    }
    if profile.profile_id.trim().is_empty() {
        findings.push(finding(
            "packed.readiness.profile_id_missing",
            PartialDiagnosticSeverity::P0,
            "profileId",
            "profile is missing a non-empty profileId".to_string(),
            SemanticErrorCode::UnknownEngineVariant,
        ));
    }
    if profile.fixture_id.trim().is_empty() {
        findings.push(finding(
            "packed.readiness.fixture_id_missing",
            PartialDiagnosticSeverity::P0,
            "fixtureId",
            "profile is missing a non-empty fixtureId".to_string(),
            SemanticErrorCode::UnknownEngineVariant,
        ));
    }

    let Some(spec) = profile.engine_family.profile_spec() else {
        findings.push(finding(
            "packed.readiness.unknown_engine_family",
            PartialDiagnosticSeverity::P0,
            "engineFamily",
            "engineFamily is unknown / unrecognized".to_string(),
            SemanticErrorCode::UnknownEngineVariant,
        ));
        return build_entry(
            profile,
            None,
            PackedReadinessOutcome::UnsupportedLayeredTransform,
            findings,
        );
    };

    if profile.container != spec.container {
        findings.push(finding(
            "packed.readiness.out_of_profile_container",
            PartialDiagnosticSeverity::P0,
            "container",
            format!(
                "engine {} requires container {:?} but profile declared {:?}",
                profile.engine_family.as_str(),
                spec.container,
                profile.container
            ),
            if profile.container == ContainerTransform::Unknown {
                SemanticErrorCode::MissingContainerCapability
            } else {
                SemanticErrorCode::UnsupportedVariantPacked
            },
        ));
    }
    if !spec.allowed_crypto.contains(&profile.crypto) {
        findings.push(finding(
            "packed.readiness.unsupported_crypto",
            PartialDiagnosticSeverity::P0,
            "crypto",
            format!(
                "engine {} does not support crypto {:?}",
                profile.engine_family.as_str(),
                profile.crypto
            ),
            SemanticErrorCode::MissingCryptoCapability,
        ));
    }
    if !spec.allowed_codec.contains(&profile.codec) {
        findings.push(finding(
            "packed.readiness.unsupported_codec",
            PartialDiagnosticSeverity::P0,
            "codec",
            format!(
                "engine {} does not support codec {:?}",
                profile.engine_family.as_str(),
                profile.codec
            ),
            SemanticErrorCode::MissingCodecCapability,
        ));
    }
    if !spec.allowed_surface.contains(&profile.surface) {
        findings.push(finding(
            "packed.readiness.unsupported_surface",
            PartialDiagnosticSeverity::P0,
            "surface",
            format!(
                "engine {} does not support surface {:?}",
                profile.engine_family.as_str(),
                profile.surface
            ),
            SemanticErrorCode::UnsupportedLayeredTransform,
        ));
    }
    if !spec.allowed_patch_back.contains(&profile.patch_back) {
        findings.push(finding(
            "packed.readiness.unsupported_patch_back",
            PartialDiagnosticSeverity::P0,
            "patchBack",
            format!(
                "engine {} does not support patch-back {:?}",
                profile.engine_family.as_str(),
                profile.patch_back
            ),
            SemanticErrorCode::MissingPatchBackCapability,
        ));
    }

    if profile.declared_capability > spec.capability_ceiling {
        findings.push(finding(
            "packed.readiness.capability_overclaim",
            PartialDiagnosticSeverity::P0,
            "declaredCapability",
            format!(
                "engine {} ceiling is {} but profile declared {}",
                profile.engine_family.as_str(),
                spec.capability_ceiling.as_str(),
                profile.declared_capability.as_str()
            ),
            SemanticErrorCode::UnsupportedVariantPacked,
        ));
    }

    validate_key(profile, &spec, &mut findings);

    validate_helper(profile, &mut findings);

    if profile.content.is_empty() {
        findings.push(finding(
            "packed.readiness.content_missing",
            PartialDiagnosticSeverity::P1,
            "content",
            "profile declares no synthetic content descriptors".to_string(),
            SemanticErrorCode::UnsupportedEngineVariant,
        ));
    }
    match recompute_content_hash(&profile.content) {
        Ok(recomputed) => {
            if recomputed.as_str() != profile.content_hash.as_str() {
                findings.push(finding(
                    "packed.readiness.content_hash_mismatch",
                    PartialDiagnosticSeverity::P0,
                    "contentHash",
                    "declared contentHash does not match the recomputed content hash".to_string(),
                    SemanticErrorCode::UnsupportedEngineVariant,
                ));
            }
        }
        Err(error) => findings.push(finding(
            "packed.readiness.content_hash_uncomputable",
            PartialDiagnosticSeverity::P0,
            "contentHash",
            redact_for_log_or_report(&error.to_string()),
            SemanticErrorCode::UnsupportedEngineVariant,
        )),
    }

    let outcome = derive_packed_readiness_outcome(
        &spec,
        profile.declared_capability,
        profile.codec,
        profile.key.status,
        profile.helper.status,
    );

    build_entry(profile, Some(spec), outcome, findings)
}

fn validate_key(
    profile: &PackedEngineReadinessProfile,
    spec: &EngineProfileSpec,
    findings: &mut Vec<PackedReadinessFinding>,
) {
    let status = profile.key.status;
    let has_ref = profile.key.key_ref.is_some() || profile.key.requirement_id.is_some();

    if spec.key_required && status == LayeredAccessKeyMaterialStatus::NotRequired {
        findings.push(finding(
            "packed.readiness.key_required_but_not_declared",
            PartialDiagnosticSeverity::P0,
            "key.status",
            format!(
                "engine {} requires key material but the profile declares keyStatus not_required",
                profile.engine_family.as_str()
            ),
            SemanticErrorCode::MissingKeyMaterial,
        ));
    }
    // A gated/resolved key must reference WHICH key it is (ref or requirement
    // id) — a missing key with no reference is itself an inconsistency.
    if matches!(
        status,
        LayeredAccessKeyMaterialStatus::Missing
            | LayeredAccessKeyMaterialStatus::Resolved
            | LayeredAccessKeyMaterialStatus::HelperGated
    ) && !has_ref
    {
        findings.push(finding(
            "packed.readiness.key_ref_missing",
            PartialDiagnosticSeverity::P0,
            "key.keyRef",
            format!("keyStatus {status:?} requires a keyRef or requirementId reference"),
            SemanticErrorCode::MissingKeyMaterial,
        ));
    }
    // A resolved key must carry the actual key reference.
    if status == LayeredAccessKeyMaterialStatus::Resolved && profile.key.key_ref.is_none() {
        findings.push(finding(
            "packed.readiness.resolved_key_without_ref",
            PartialDiagnosticSeverity::P0,
            "key.keyRef",
            "resolved key material must carry a keyRef".to_string(),
            SemanticErrorCode::MissingKeyMaterial,
        ));
    }
    // A not-required key must not carry a reference.
    if status == LayeredAccessKeyMaterialStatus::NotRequired
        && (profile.key.key_ref.is_some() || profile.key.requirement_id.is_some())
    {
        findings.push(finding(
            "packed.readiness.unexpected_key_ref",
            PartialDiagnosticSeverity::P1,
            "key.keyRef",
            "keyStatus not_required must not carry a keyRef / requirementId".to_string(),
            SemanticErrorCode::MissingKeyMaterial,
        ));
    }
}

fn validate_helper(
    profile: &PackedEngineReadinessProfile,
    findings: &mut Vec<PackedReadinessFinding>,
) {
    let status = profile.helper.status;
    let has_id = profile.helper.helper_id.is_some();

    // Helper-gated crypto must declare a required (available/unavailable)
    // helper, never not_required.
    if profile.crypto == CryptoTransform::HelperGated
        && status == LayeredAccessHelperStatus::NotRequired
    {
        findings.push(finding(
            "packed.readiness.helper_gated_crypto_without_helper",
            PartialDiagnosticSeverity::P0,
            "helper.status",
            "helper_gated crypto requires a helper but helperStatus is not_required".to_string(),
            SemanticErrorCode::HelperRequired,
        ));
    }
    // A helper-gated key likewise requires a helper.
    if profile.key.status == LayeredAccessKeyMaterialStatus::HelperGated
        && status == LayeredAccessHelperStatus::NotRequired
    {
        findings.push(finding(
            "packed.readiness.helper_gated_key_without_helper",
            PartialDiagnosticSeverity::P0,
            "helper.status",
            "helper_gated key material requires a helper but helperStatus is not_required"
                .to_string(),
            SemanticErrorCode::HelperRequired,
        ));
    }
    // A required helper (available/unavailable) must name WHICH helper.
    if matches!(
        status,
        LayeredAccessHelperStatus::Available | LayeredAccessHelperStatus::Unavailable
    ) && !has_id
    {
        findings.push(finding(
            "packed.readiness.helper_id_missing",
            PartialDiagnosticSeverity::P0,
            "helper.helperId",
            format!("helperStatus {status:?} requires a helperId"),
            SemanticErrorCode::HelperRequired,
        ));
    }
    // A not-required helper must not name a helper.
    if status == LayeredAccessHelperStatus::NotRequired && has_id {
        findings.push(finding(
            "packed.readiness.unexpected_helper_id",
            PartialDiagnosticSeverity::P1,
            "helper.helperId",
            "helperStatus not_required must not carry a helperId".to_string(),
            SemanticErrorCode::HelperRequired,
        ));
    }
}

fn build_entry(
    profile: &PackedEngineReadinessProfile,
    _spec: Option<EngineProfileSpec>,
    outcome: PackedReadinessOutcome,
    findings: Vec<PackedReadinessFinding>,
) -> PackedReadinessEntryReport {
    let status = if findings.iter().any(|f| f.severity.is_blocking()) {
        OperationStatus::Failed
    } else {
        OperationStatus::Passed
    };
    PackedReadinessEntryReport {
        profile_id: profile.profile_id.clone(),
        fixture_id: profile.fixture_id.clone(),
        source_node_id: profile.source_node_id.clone(),
        engine_family: profile.engine_family,
        transform_stack: PackedTransformStack {
            container: profile.container,
            crypto: profile.crypto,
            codec: profile.codec,
            surface: profile.surface,
            patch_back: profile.patch_back,
        },
        declared_capability: profile.declared_capability,
        effective_outcome: outcome,
        posture: outcome.posture(),
        key_status: profile.key.status,
        key_ref: profile.key.key_ref.clone(),
        key_requirement_id: profile.key.requirement_id.clone(),
        helper_status: profile.helper.status,
        helper_id: profile.helper.helper_id.clone(),
        content_hash: profile.content_hash.clone(),
        content_entry_count: profile.content.len() as u64,
        status,
        findings,
    }
}

/// Read every `*.profile.json` fixture under `dir` (sorted by file name),
/// validate each, and aggregate one [`PackedReadinessValidationReport`]. A
/// malformed fixture becomes a failed entry, never a hard error.
pub fn validate_packed_engine_readiness_dir(
    dir: &Path,
) -> KaifuuResult<PackedReadinessValidationReport> {
    let mut files: Vec<std::path::PathBuf> = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_file()
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".profile.json"))
        {
            files.push(path);
        }
    }
    files.sort();

    let mut entries = Vec::with_capacity(files.len());
    for path in &files {
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("<unknown>");
        match read_json::<PackedEngineReadinessProfile>(path) {
            Ok(profile) => entries.push(validate_packed_engine_readiness_profile(&profile)),
            Err(error) => entries.push(malformed_entry(file_name, &error.to_string())),
        }
    }

    let profile_ready_count = entries
        .iter()
        .filter(|entry| entry.posture == PackedReadinessPosture::ProfileReady)
        .count() as u64;
    let readiness_only_count = entries
        .iter()
        .filter(|entry| entry.posture == PackedReadinessPosture::ReadinessOnly)
        .count() as u64;
    let status = if entries
        .iter()
        .all(|entry| matches!(entry.status, OperationStatus::Passed))
    {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };

    Ok(PackedReadinessValidationReport {
        schema_version: PACKED_READINESS_REPORT_SCHEMA_VERSION.to_string(),
        support_boundary: PACKED_ENGINE_READINESS_SUPPORT_BOUNDARY.to_string(),
        status,
        profile_count: entries.len() as u64,
        profile_ready_count,
        readiness_only_count,
        entries,
    })
}

fn malformed_entry(file_name: &str, error: &str) -> PackedReadinessEntryReport {
    let placeholder_hash = ProofHash::new(sha256_hash_bytes(&[]))
        .unwrap_or_else(|_| unreachable!("empty sha256 is a valid proof hash"));
    PackedReadinessEntryReport {
        profile_id: format!("{file_name}-unparseable"),
        fixture_id: file_name.to_string(),
        source_node_id: "packed-engine-readiness".to_string(),
        engine_family: PackedEngineFamily::Unknown,
        transform_stack: PackedTransformStack {
            container: ContainerTransform::Unknown,
            crypto: CryptoTransform::Unknown,
            codec: CodecTransform::Unknown,
            surface: SurfaceTransform::Unknown,
            patch_back: PatchBackTransform::Unknown,
        },
        declared_capability: CapabilityLevel::Identify,
        effective_outcome: PackedReadinessOutcome::UnsupportedLayeredTransform,
        posture: PackedReadinessPosture::ReadinessOnly,
        key_status: LayeredAccessKeyMaterialStatus::NotRequired,
        key_ref: None,
        key_requirement_id: None,
        helper_status: LayeredAccessHelperStatus::NotRequired,
        helper_id: None,
        content_hash: placeholder_hash,
        content_entry_count: 0,
        status: OperationStatus::Failed,
        findings: vec![finding(
            "packed.readiness.fixture_unparseable",
            PartialDiagnosticSeverity::P0,
            "fixture",
            format!(
                "profile fixture could not be parsed: {}",
                redact_for_log_or_report(error)
            ),
            SemanticErrorCode::UnknownEngineVariant,
        )],
    }
}
