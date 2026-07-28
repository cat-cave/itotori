//! Deterministic synthetic builders. No corpus bytes, no retail names, no
//! real keys — only logical ids, secret **requirement** ids, and hashes.

use super::{Xp3HelperResultAggregate, Xp3SupportTupleSummaryFixture};
use kaifuu_core::compat_profile::{
    ClaimedSupportLevel, ClaimedSupportTuple, CompatDiagnostic, CompatDiagnosticStatus,
    CompatEngineFamily, CompatLayer, EvidenceRef, SecretRequirementId, SupportEvidence,
};
use kaifuu_core::{
    CodecTransform, ContainerTransform, CryptoTransform, HelperCapabilityLevel, HelperDiagnostic,
    HelperDiagnosticCode, HelperExecutionFilesystemAccess, HelperExecutionSummary, HelperKind,
    HelperProvenance, HelperRedaction, HelperRedactionStatus, HelperResult,
    HelperResultExecutionMode, HelperResultSecretRef, KeyMaterialKind, KeyValidationMethod,
    KeyValidationProof, PartialDiagnosticSeverity, PatchBackTransform, ProofHash, SecretRef,
    SemanticErrorCode, SurfaceTransform,
};

use super::XP3_PRIVATE_LOCAL_SUMMARY_SCHEMA_VERSION;

fn proof_hash(byte: u8) -> ProofHash {
    let hex = format!("{byte:02x}").repeat(32);
    ProofHash::new(format!("sha256:{hex}")).expect("synthetic proof hash is valid")
}

/// The helper-result aggregate an operator's local key helpers
/// produced against a synthetic XP3 tree.
#[must_use]
pub fn helper_result_aggregate() -> Xp3HelperResultAggregate {
    Xp3HelperResultAggregate {
            schema_version: XP3_PRIVATE_LOCAL_SUMMARY_SCHEMA_VERSION.to_string(),
            aggregate_id: "kaifuu/k102/xp3-helper-result-aggregate".to_string(),
            helper_results: vec![
                // A helper-gated profile: manual key entry required before table access.
                HelperResult {
                    schema_version: kaifuu_core::HELPER_RESULT_SCHEMA_VERSION.to_string(),
                    fixture_id: "kaifuu-k102-xp3-helper-required".to_string(),
                    helper_result_id: "helper-result/kaifuu/k102/xp3/helper-required".to_string(),
                    profile_id: "019ed000-0000-7000-8000-0000000a2001".to_string(),
                    helper: HelperProvenance {
                        helper_id: "kaifuu.fixture.manual-entry".to_string(),
                        helper_version: "0.1.0".to_string(),
                        helper_kind: HelperKind::ManualKeyEntry,
                    },
                    capability_level: HelperCapabilityLevel::ManualEntry,
                    execution: HelperExecutionSummary {
                        mode: HelperResultExecutionMode::NotExecuted,
                        platform: "fixture-local".to_string(),
                        bounded: true,
                        timeout_ms: 1000,
                        duration_ms: Some(0),
                        network_access: false,
                        filesystem_access: HelperExecutionFilesystemAccess::None,
                    },
                    diagnostic: HelperDiagnostic {
                        code: HelperDiagnosticCode::HelperRequired,
                        message: "synthetic XP3 helper-gated profile requires a local helper result before archive table access".to_string(),
                    },
                    redaction: HelperRedaction {
                        status: HelperRedactionStatus::NotRequired,
                        redacted_log_hash: proof_hash(0x10),
                    },
                    secret_refs: vec![HelperResultSecretRef {
                        requirement_id: "kirikiri-xp3-key-profile".to_string(),
                        secret_ref: SecretRef::new("prompt:fixture/kirikiri/xp3-archive-password")
                            .expect("synthetic secret ref is valid"),
                        material_kind: KeyMaterialKind::ArchivePassword,
                        bytes: None,
                        validation: None,
                    }],
                    proof_hashes: vec![KeyValidationProof {
                        method: KeyValidationMethod::ArchiveIndexProof,
                        proof_hash: proof_hash(0x11),
                    }],
                },
                // A known-key import that could not find local material.
                HelperResult {
                    schema_version: kaifuu_core::HELPER_RESULT_SCHEMA_VERSION.to_string(),
                    fixture_id: "kaifuu-k102-xp3-missing-key".to_string(),
                    helper_result_id: "helper-result/kaifuu/k102/xp3/missing-key".to_string(),
                    profile_id: "019ed000-0000-7000-8000-0000000a2002".to_string(),
                    helper: HelperProvenance {
                        helper_id: "kaifuu.fixture.known-key-import".to_string(),
                        helper_version: "0.1.0".to_string(),
                        helper_kind: HelperKind::KnownKeyDatabaseImport,
                    },
                    capability_level: HelperCapabilityLevel::LocalKeyImport,
                    execution: HelperExecutionSummary {
                        mode: HelperResultExecutionMode::NotExecuted,
                        platform: "fixture-local".to_string(),
                        bounded: true,
                        timeout_ms: 1000,
                        duration_ms: Some(0),
                        network_access: false,
                        filesystem_access: HelperExecutionFilesystemAccess::None,
                    },
                    diagnostic: HelperDiagnostic {
                        code: HelperDiagnosticCode::MissingKey,
                        message: "synthetic XP3 encrypted profile declares kirikiri-xp3-key-profile but no local key material was found".to_string(),
                    },
                    redaction: HelperRedaction {
                        status: HelperRedactionStatus::Redacted,
                        redacted_log_hash: proof_hash(0x20),
                    },
                    secret_refs: vec![HelperResultSecretRef {
                        requirement_id: "kirikiri-xp3-key-profile".to_string(),
                        secret_ref: SecretRef::new("local-secret:fixture/kirikiri/xp3/missing-password")
                            .expect("synthetic secret ref is valid"),
                        material_kind: KeyMaterialKind::ArchivePassword,
                        bytes: None,
                        validation: None,
                    }],
                    proof_hashes: vec![],
                },
            ],
        }
}

/// The support-tuple summary declaring the operator's XP3 posture.
#[must_use]
pub fn support_tuple_summary() -> Xp3SupportTupleSummaryFixture {
    Xp3SupportTupleSummaryFixture {
        schema_version: XP3_PRIVATE_LOCAL_SUMMARY_SCHEMA_VERSION.to_string(),
        summary_id: "kaifuu/k102/xp3-support-tuple-summary".to_string(),
        support_tuples: vec![
            // An honest known-key XP3 extract claim.
            ClaimedSupportTuple {
                schema_version: "0.1.0".to_string(),
                engine_family: CompatEngineFamily::KirikiriXp3,
                engine_variant: "kirikiri_xp3_known_key".to_string(),
                container: ContainerTransform::Xp3,
                crypto: CryptoTransform::KeyProfile,
                codec: CodecTransform::ShiftJisText,
                surface: SurfaceTransform::ArchiveEntry,
                patch_back_mode: PatchBackTransform::RepackArchive,
                profile_or_fixture_id: "compat/kirikiri-xp3/known-key-extract".to_string(),
                secret_requirement_ids: vec![SecretRequirementId::new(
                    "kirikiri-xp3-key-profile",
                    SecretRef::new("prompt:fixture/kirikiri/xp3-archive-password")
                        .expect("synthetic secret ref is valid"),
                )],
                diagnostics: vec![CompatDiagnostic {
                    layer: CompatLayer::Crypto,
                    status: CompatDiagnosticStatus::KnownKeyOnly,
                    reason_id: SemanticErrorCode::KeyValidationFailed,
                    severity: PartialDiagnosticSeverity::P3,
                    detail: Some(
                        "extract limited to a catalogued known key; arbitrary titles unsupported"
                            .to_string(),
                    ),
                }],
                claimed_level: ClaimedSupportLevel::Extract,
                evidence: SupportEvidence {
                    extraction: Some(EvidenceRef::new(
                        "evidence/extract/xp3-known-key",
                        proof_hash(0x31),
                    )),
                    validation: None,
                    patch_back: None,
                    runtime: None,
                },
            },
            // An honest patch-back claim with the full evidence chain.
            ClaimedSupportTuple {
                schema_version: "0.1.0".to_string(),
                engine_family: CompatEngineFamily::KirikiriXp3,
                engine_variant: "kirikiri_xp3_fixture_patch".to_string(),
                container: ContainerTransform::Xp3,
                crypto: CryptoTransform::KeyProfile,
                codec: CodecTransform::ShiftJisText,
                surface: SurfaceTransform::ArchiveEntry,
                patch_back_mode: PatchBackTransform::RepackArchive,
                profile_or_fixture_id: "compat/kirikiri-xp3/fixture-patch-back".to_string(),
                secret_requirement_ids: vec![SecretRequirementId::new(
                    "kaifuu-k100-xp3-crypt-key",
                    SecretRef::new("local-secret:kaifuu-kirikiri-crypt-fixture-key")
                        .expect("synthetic secret ref is valid"),
                )],
                diagnostics: vec![],
                claimed_level: ClaimedSupportLevel::Patch,
                evidence: SupportEvidence {
                    extraction: Some(EvidenceRef::new(
                        "evidence/extract/xp3-fixture",
                        proof_hash(0x41),
                    )),
                    validation: Some(EvidenceRef::new(
                        "evidence/validate/xp3-fixture",
                        proof_hash(0x42),
                    )),
                    patch_back: Some(EvidenceRef::new(
                        "evidence/patch/xp3-fixture",
                        proof_hash(0x43),
                    )),
                    runtime: None,
                },
            },
        ],
    }
}
