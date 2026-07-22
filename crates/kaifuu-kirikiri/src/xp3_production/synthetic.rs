use super::*;
use crate::xp3_crypt::{KirikiriXp3Surface, Xp3CryptoProfile};
use crate::xp3_patch::Xp3TextReplacement;
use kaifuu_core::{
    HELPER_RESULT_SCHEMA_VERSION, HelperCapabilityLevel, HelperDiagnostic, HelperDiagnosticCode,
    HelperExecutionFilesystemAccess, HelperExecutionSummary, HelperKind, HelperProvenance,
    HelperRedaction, HelperRedactionStatus, HelperResult, HelperResultExecutionMode,
    HelperResultSecretRef, KeyMaterialKind, KeyValidationMethod, KeyValidationProof, ProofHash,
    SecretRef,
};

fn proof_hash(byte: u8) -> ProofHash {
    ProofHash::new(format!("sha256:{}", format!("{byte:02x}").repeat(32)))
        .expect("synthetic proof hash is valid")
}

/// A satisfied manual-key-entry helper result referencing `requirement_id`.
#[must_use]
pub fn satisfied_manual_entry_helper(requirement_id: &str, secret_ref: &SecretRef) -> HelperResult {
    HelperResult {
        schema_version: HELPER_RESULT_SCHEMA_VERSION.to_string(),
        fixture_id: "kaifuu-k057-xp3-manual-entry-helper".to_string(),
        helper_result_id: "helper-result/kaifuu/k057/xp3/manual-entry".to_string(),
        profile_id: "019ed057-0000-7000-8000-0000000a5701".to_string(),
        helper: HelperProvenance {
            helper_id: "kaifuu.fixture.manual-entry".to_string(),
            helper_version: "0.1.0".to_string(),
            helper_kind: HelperKind::ManualKeyEntry,
        },
        capability_level: HelperCapabilityLevel::ManualEntry,
        execution: HelperExecutionSummary {
            // ManualKeyEntry is a not-executed (operator-supplied) path.
            mode: HelperResultExecutionMode::NotExecuted,
            platform: "fixture-local".to_string(),
            bounded: true,
            timeout_ms: 1000,
            duration_ms: Some(0),
            network_access: false,
            filesystem_access: HelperExecutionFilesystemAccess::None,
        },
        diagnostic: HelperDiagnostic {
            code: HelperDiagnosticCode::Success,
            message: "synthetic manual key entry resolved the archive password".to_string(),
        },
        redaction: HelperRedaction {
            status: HelperRedactionStatus::Redacted,
            redacted_log_hash: proof_hash(0x57),
        },
        secret_refs: vec![HelperResultSecretRef {
            requirement_id: requirement_id.to_string(),
            secret_ref: secret_ref.clone(),
            material_kind: KeyMaterialKind::ArchivePassword,
            bytes: None,
            validation: None,
        }],
        // A Success diagnostic must carry at least one validation proof.
        proof_hashes: vec![KeyValidationProof {
            method: KeyValidationMethod::ArchiveIndexProof,
            proof_hash: proof_hash(0x58),
        }],
    }
}

/// The canonical synthetic production registry: two claimed variants across
/// two distinct crypt schemes (one direct-key, one manual-entry-helper-gated)
/// plus one explicit out-of-scope not-claimed variant.
#[must_use]
pub fn production_registry() -> Xp3ProductionRegistry {
    // Variant A: XorSimpleCryptFixture, direct key (no helper).
    let a_requirement = "kaifuu-k057-xp3-simple-key".to_string();
    let a_ref = SecretRef::new("local-secret:kaifuu/k057/xp3-simple-crypt-key")
        .expect("synthetic secret ref is valid");
    let a_archive_key = private_fixture_secret_holder(&a_ref, b"K057-XP3-SIMPLEKEY01".to_vec());
    let a_resolved_key = private_fixture_secret_holder(&a_ref, b"K057-XP3-SIMPLEKEY01".to_vec());
    let variant_a = Xp3ProductionVariant::new(
        "kaifuu-k057-xp3-simple-crypt".to_string(),
        Xp3CryptoProfile::XorSimpleCryptFixture,
        KirikiriXp3Surface::ScenarioScript,
        a_requirement.clone(),
        a_ref.clone(),
        Xp3HelperWorkflow::None,
        None,
        vec![
            (
                "scenario/opening.ks".to_string(),
                "*start\n#Narrator\n[synthetic-k057-simple-line-0]\n@wait time=200\n".to_string(),
            ),
            (
                "system/config.txt".to_string(),
                "[synthetic-k057-simple-config]\nwindow=default\n".to_string(),
            ),
        ],
        vec![Xp3TextReplacement {
            member_id: "scenario/opening.ks".to_string(),
            find: "[synthetic-k057-simple-line-0]".to_string(),
            replace: "[localized-k057-simple-line-0-JA-longer]".to_string(),
        }],
        true,
        a_archive_key,
        Some(a_resolved_key),
    );

    // Variant B: XorPositionCryptFixture, manual-entry-helper-gated key.
    let b_requirement = "kaifuu-k057-xp3-position-key".to_string();
    let b_ref = SecretRef::new("prompt:kaifuu/k057/xp3-position-archive-password")
        .expect("synthetic secret ref is valid");
    let b_archive_key = private_fixture_secret_holder(&b_ref, b"K057-XP3-POSITIONKEY02".to_vec());
    let b_resolved_key = private_fixture_secret_holder(&b_ref, b"K057-XP3-POSITIONKEY02".to_vec());
    let variant_b = Xp3ProductionVariant::new(
        "kaifuu-k057-xp3-position-crypt".to_string(),
        Xp3CryptoProfile::XorPositionCryptFixture,
        KirikiriXp3Surface::ScenarioScript,
        b_requirement.clone(),
        b_ref.clone(),
        Xp3HelperWorkflow::ManualKeyEntry,
        Some(satisfied_manual_entry_helper(&b_requirement, &b_ref)),
        vec![
            (
                "scenario/route_a.ks".to_string(),
                "*route_a\n#Heroine\n[synthetic-k057-position-line-0]\n@wait time=120\n"
                    .to_string(),
            ),
            (
                "scenario/route_b.ks".to_string(),
                "*route_b\n#Heroine\n[synthetic-k057-position-line-1]\n".to_string(),
            ),
            (
                "system/scn.txt".to_string(),
                "[synthetic-k057-position-scn]\nmode=adv\n".to_string(),
            ),
        ],
        vec![Xp3TextReplacement {
            member_id: "scenario/route_a.ks".to_string(),
            find: "[synthetic-k057-position-line-0]".to_string(),
            replace: "[localized-k057-position-line-0-JA]".to_string(),
        }],
        true,
        b_archive_key,
        Some(b_resolved_key),
    );

    // Variant C: explicitly NOT claimed — a research-tier scheme the profile
    // does not advance to a claim (out of scope).
    let c_ref = SecretRef::new("local-secret:kaifuu/k057/xp3-research-only")
        .expect("synthetic secret ref is valid");
    let c_archive_key = private_fixture_secret_holder(&c_ref, b"K057-XP3-RESEARCHKEY0".to_vec());
    let variant_c = Xp3ProductionVariant::new(
        "kaifuu-k057-xp3-research-only".to_string(),
        Xp3CryptoProfile::XorSimpleCryptFixture,
        KirikiriXp3Surface::ScenarioScript,
        "kaifuu-k057-xp3-research-key".to_string(),
        c_ref,
        Xp3HelperWorkflow::KnownKeyImport,
        None,
        vec![(
            "scenario/unknown.ks".to_string(),
            "[synthetic-k057-research-line]\n".to_string(),
        )],
        vec![],
        false,
        c_archive_key,
        None,
    );

    Xp3ProductionRegistry {
        registry_id: deterministic_id("kaifuu-k057-xp3-production-registry", 1),
        variants: vec![variant_a, variant_b, variant_c],
    }
}
