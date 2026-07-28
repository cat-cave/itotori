//! Encrypted-media report finalization.

use super::*;

pub(super) struct EncryptedMediaReportFinalizeInput<'a> {
    pub(super) fixture: &'a EncryptedMediaProofFixture,
    pub(super) assets: Vec<EncryptedMediaProofAsset>,
    pub(super) diagnostics: Vec<EncryptedMediaProofDiagnostic>,
    pub(super) key_profile_status: EncryptedMediaKeyRefStatus,
    pub(super) system_json_proof_hash: Option<ProofHash>,
    pub(super) system_json_present: bool,
    pub(super) system_json_key_present: bool,
    pub(super) system_json_key_well_formed: bool,
    pub(super) expected_system_json_key_hash: Option<ProofHash>,
    pub(super) system_json_key_hash: Option<ProofHash>,
    pub(super) has_encrypted_images_flag: Option<bool>,
    pub(super) has_encrypted_audio_flag: Option<bool>,
}

pub(super) fn finalize_encrypted_media_report(
    input: EncryptedMediaReportFinalizeInput<'_>,
) -> EncryptedMediaProofReport {
    let EncryptedMediaReportFinalizeInput {
        fixture,
        assets,
        diagnostics,
        key_profile_status,
        system_json_proof_hash,
        system_json_present,
        system_json_key_present,
        system_json_key_well_formed,
        expected_system_json_key_hash,
        system_json_key_hash,
        has_encrypted_images_flag,
        has_encrypted_audio_flag,
    } = input;
    // Aggregate readiness: `Ready` requires *all* encrypted assets to
    // be `Ready` and no blocking diagnostics. Plaintext-only fixtures
    // resolve to `PlaintextEvidence`. Anything else routes to
    // `Unsupported`.
    let has_blocking_diagnostic = diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity.is_blocking());
    let aggregate_readiness = if has_blocking_diagnostic || assets.is_empty() {
        EncryptedMediaReadiness::Unsupported
    } else if assets
        .iter()
        .all(|asset| matches!(asset.readiness, EncryptedMediaReadiness::PlaintextEvidence))
    {
        EncryptedMediaReadiness::PlaintextEvidence
    } else if assets.iter().all(|asset| {
        matches!(
            asset.readiness,
            EncryptedMediaReadiness::Ready | EncryptedMediaReadiness::PlaintextEvidence
        )
    }) && assets
        .iter()
        .any(|asset| matches!(asset.readiness, EncryptedMediaReadiness::Ready))
    {
        EncryptedMediaReadiness::Ready
    } else {
        EncryptedMediaReadiness::Unsupported
    };

    let key_profile_id = fixture
        .key_profile
        .as_ref()
        .map(|profile| profile.profile_id.clone());
    let requirement_id = fixture
        .key_profile
        .as_ref()
        .and_then(|profile| profile.key_ref_requirement.as_ref())
        .map(|requirement| requirement.requirement_id.clone());
    let secret_ref = fixture
        .key_profile
        .as_ref()
        .and_then(|profile| profile.key_ref_requirement.as_ref())
        .map(|requirement| requirement.secret_ref.clone());

    let semantic_remediation = if matches!(aggregate_readiness, EncryptedMediaReadiness::Ready) {
        Some(
            "encrypted-media readiness reports profile wiring only;  makes no decryption, extraction, script-patch, or dialogue-extraction capability claim".to_string(),
        )
    } else if matches!(
        aggregate_readiness,
        EncryptedMediaReadiness::PlaintextEvidence
    ) {
        Some(
            "plaintext media surfaced as evidence only; no patch capability is claimed".to_string(),
        )
    } else {
        Some(
            "encrypted-media routing diagnostics fired;  makes no decryption, extraction, script-patch, or dialogue-extraction capability claim".to_string(),
        )
    };

    let status = if has_blocking_diagnostic {
        OperationStatus::Failed
    } else {
        OperationStatus::Passed
    };

    EncryptedMediaProofReport {
        schema_version: ENCRYPTED_MEDIA_PROOF_SCHEMA_VERSION.to_string(),
        fixture_id: fixture.fixture_id.clone(),
        profile_id: fixture.profile_id.clone(),
        status,
        support_boundary: ENCRYPTED_MEDIA_PROOF_SUPPORT_BOUNDARY.to_string(),
        readiness: aggregate_readiness,
        patch_capability_level: if matches!(
            aggregate_readiness,
            EncryptedMediaReadiness::PlaintextEvidence
        ) {
            EncryptedMediaPatchCapability::NotClaimed
        } else {
            EncryptedMediaPatchCapability::Unsupported
        },
        // Acceptance criterion: "Readiness output never claims dialogue
        // extraction or script patch support based only on media-key
        // detection." Hardcoded false; this is the load-bearing
        // separation between media routing and script capability.
        script_capability_claimed: false,
        // Acceptance criterion: "Missing or wrong keys return semantic
        // diagnostics before decrypted bytes are persisted." The proof
        // never decrypts; this flag is hardcoded false so downstream
        // auditors can confirm the proof did not persist decrypted
        // bytes.
        decrypted_bytes_persisted: false,
        assets,
        key_profile: EncryptedMediaProofKeyProfile {
            status: key_profile_status,
            key_profile_id,
            requirement_id,
            secret_ref,
            system_json_proof_hash,
            system_json_present,
            system_json_key_present,
            system_json_key_well_formed,
            expected_system_json_key_hash,
            system_json_key_hash,
            has_encrypted_images_flag,
            has_encrypted_audio_flag,
        },
        diagnostics,
        semantic_remediation,
    }
}
