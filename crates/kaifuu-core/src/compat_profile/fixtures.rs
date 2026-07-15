use super::*;
use crate::{ProofHash, SecretRef, sha256_hash_bytes};

fn proof(seed: &str) -> ProofHash {
    ProofHash::new(sha256_hash_bytes(seed.as_bytes())).expect("synthetic proof hash is valid")
}

fn secret_ref(name: &str) -> SecretRef {
    SecretRef::new(format!("local-secret:{name}")).expect("synthetic secret ref is valid")
}

fn extraction(seed: &str) -> EvidenceRef {
    EvidenceRef::new(
        format!("evidence/extract/{seed}"),
        proof(&format!("extract:{seed}")),
    )
}
fn validation(seed: &str) -> EvidenceRef {
    EvidenceRef::new(
        format!("evidence/validate/{seed}"),
        proof(&format!("validate:{seed}")),
    )
}
fn patch_back(seed: &str) -> EvidenceRef {
    EvidenceRef::new(
        format!("evidence/patch/{seed}"),
        proof(&format!("patch:{seed}")),
    )
}

/// LEVEL: `identify`. A recognized-but-unproven family — kaifuu can name it
/// and nothing more. No evidence, no overclaim.
pub fn level_identify() -> ClaimedSupportTuple {
    ClaimedSupportTuple {
        schema_version: CLAIMED_SUPPORT_SCHEMA_VERSION.to_string(),
        engine_family: CompatEngineFamily::RealLiveRuntime,
        engine_variant: "reallive_detected_only".to_string(),
        container: ContainerTransform::Archive,
        crypto: CryptoTransform::Unknown,
        codec: CodecTransform::Unknown,
        surface: SurfaceTransform::Unknown,
        patch_back_mode: PatchBackTransform::Unsupported,
        profile_or_fixture_id: "compat/reallive/identify-only".to_string(),
        secret_requirement_ids: vec![],
        diagnostics: vec![CompatDiagnostic::new(
            CompatLayer::Codec,
            CompatDiagnosticStatus::NotImplemented,
            SemanticErrorCode::MissingCodecCapability,
            PartialDiagnosticSeverity::P3,
        )],
        claimed_level: ClaimedSupportLevel::Identify,
        evidence: SupportEvidence::none(),
    }
}

/// LEVEL: `inventory`. Kaifuu can list assets but not extract text.
pub fn level_inventory() -> ClaimedSupportTuple {
    ClaimedSupportTuple {
        schema_version: CLAIMED_SUPPORT_SCHEMA_VERSION.to_string(),
        engine_family: CompatEngineFamily::KirikiriXp3,
        engine_variant: "kirikiri_xp3_inventory_only".to_string(),
        container: ContainerTransform::Xp3,
        crypto: CryptoTransform::NullKey,
        codec: CodecTransform::Unknown,
        surface: SurfaceTransform::ArchiveEntry,
        patch_back_mode: PatchBackTransform::Unsupported,
        profile_or_fixture_id: "compat/kirikiri-xp3/inventory-only".to_string(),
        secret_requirement_ids: vec![],
        diagnostics: vec![CompatDiagnostic::new(
            CompatLayer::Codec,
            CompatDiagnosticStatus::NotImplemented,
            SemanticErrorCode::MissingCodecCapability,
            PartialDiagnosticSeverity::P3,
        )],
        claimed_level: ClaimedSupportLevel::Inventory,
        evidence: SupportEvidence::none(),
    }
}

/// LEVEL: `extract`. Siglus at its HONEST posture: identify + known-static-
/// key extraction, NOT patch/runtime. Patch-back is declared not-implemented.
pub fn level_extract_siglus() -> ClaimedSupportTuple {
    ClaimedSupportTuple {
        schema_version: CLAIMED_SUPPORT_SCHEMA_VERSION.to_string(),
        engine_family: CompatEngineFamily::Siglus,
        engine_variant: "siglus_pck_static_key".to_string(),
        container: ContainerTransform::SiglusPck,
        crypto: CryptoTransform::FixedKey,
        codec: CodecTransform::Utf16Text,
        surface: SurfaceTransform::ArchiveEntry,
        patch_back_mode: PatchBackTransform::Unsupported,
        profile_or_fixture_id: "compat/siglus/known-key-extract".to_string(),
        secret_requirement_ids: vec![SecretRequirementId::new(
            "siglus.scene-pck.static-key",
            secret_ref("siglus-scene-static-key"),
        )],
        diagnostics: vec![
            CompatDiagnostic::new(
                CompatLayer::Crypto,
                CompatDiagnosticStatus::KnownKeyOnly,
                SemanticErrorCode::MissingKeyMaterial,
                PartialDiagnosticSeverity::P2,
            )
            .with_detail("extraction is limited to catalogued known static keys"),
            CompatDiagnostic::new(
                CompatLayer::PatchBack,
                CompatDiagnosticStatus::NotImplemented,
                SemanticErrorCode::MissingPatchBackCapability,
                PartialDiagnosticSeverity::P2,
            )
            .with_detail("Siglus patch-back is not yet proven"),
        ],
        claimed_level: ClaimedSupportLevel::Extract,
        evidence: SupportEvidence {
            extraction: Some(extraction("siglus")),
            validation: None,
            patch_back: None,
            runtime: None,
        },
    }
}

/// LEVEL: `patch`. KiriKiri plaintext KAG `.ks`: extract + patch, container
/// is `loose_file` (NOT commercial XP3), no crypto. Full evidence chain.
pub fn level_patch_kirikiri_kag_plaintext() -> ClaimedSupportTuple {
    ClaimedSupportTuple {
        schema_version: CLAIMED_SUPPORT_SCHEMA_VERSION.to_string(),
        engine_family: CompatEngineFamily::KirikiriKagPlaintext,
        engine_variant: "kirikiri_kag_plaintext_ks".to_string(),
        container: ContainerTransform::LooseFile,
        crypto: CryptoTransform::NullKey,
        codec: CodecTransform::ShiftJisText,
        surface: SurfaceTransform::Identity,
        patch_back_mode: PatchBackTransform::ReplaceFile,
        profile_or_fixture_id: "compat/kirikiri-kag/plaintext-patch".to_string(),
        secret_requirement_ids: vec![],
        diagnostics: vec![
            CompatDiagnostic::new(
                CompatLayer::Container,
                CompatDiagnosticStatus::NotImplemented,
                SemanticErrorCode::UnsupportedVariantEncrypted,
                PartialDiagnosticSeverity::P3,
            )
            .with_detail("plaintext KAG only — encrypted commercial XP3 is NOT covered"),
        ],
        claimed_level: ClaimedSupportLevel::Patch,
        evidence: SupportEvidence {
            extraction: Some(extraction("kag")),
            validation: Some(validation("kag")),
            patch_back: Some(patch_back("kag")),
            runtime: None,
        },
    }
}

/// LEVEL: `patch`. TyranoScript plaintext `.ks` scenario markup, expressed
/// as the layered pipeline: `identity` container (loose files on disk),
/// `null_key` crypto (plaintext), `tyrano_script_markup` codec. Extracts
/// dialogue + choice/link + speaker text and patches back preserving all
/// structure (tags/labels/jumps/variables). Full evidence chain. The
/// adapter lives in `kaifuu-tyrano`.
pub fn level_patch_tyranoscript() -> ClaimedSupportTuple {
    ClaimedSupportTuple {
        schema_version: CLAIMED_SUPPORT_SCHEMA_VERSION.to_string(),
        engine_family: CompatEngineFamily::TyranoScript,
        engine_variant: "tyranoscript_ks".to_string(),
        container: ContainerTransform::Identity,
        crypto: CryptoTransform::NullKey,
        codec: CodecTransform::TyranoScriptMarkup,
        surface: SurfaceTransform::Identity,
        patch_back_mode: PatchBackTransform::ReplaceFile,
        profile_or_fixture_id: "compat/tyranoscript/plaintext-patch".to_string(),
        secret_requirement_ids: vec![],
        diagnostics: vec![],
        claimed_level: ClaimedSupportLevel::Patch,
        evidence: SupportEvidence {
            extraction: Some(extraction("tyrano")),
            validation: Some(validation("tyrano")),
            patch_back: Some(patch_back("tyrano")),
            runtime: None,
        },
    }
}

/// A second HONEST `patch` tuple: RPG Maker MV/MZ project JSON text at the
/// declared JSON-pointer surface. Extract + patch, no crypto.
pub fn patch_rpg_maker_mv_mz_json() -> ClaimedSupportTuple {
    ClaimedSupportTuple {
        schema_version: CLAIMED_SUPPORT_SCHEMA_VERSION.to_string(),
        engine_family: CompatEngineFamily::RpgMakerMvMzJson,
        engine_variant: "rpg_maker_mz".to_string(),
        container: ContainerTransform::ProjectAsset,
        crypto: CryptoTransform::NullKey,
        codec: CodecTransform::RpgMakerMvMzJson,
        surface: SurfaceTransform::JsonPointer,
        patch_back_mode: PatchBackTransform::RewriteJson,
        profile_or_fixture_id: "compat/rpg-maker/mz-json-patch".to_string(),
        secret_requirement_ids: vec![],
        diagnostics: vec![],
        claimed_level: ClaimedSupportLevel::Patch,
        evidence: SupportEvidence {
            extraction: Some(extraction("mz-json")),
            validation: Some(validation("mz-json")),
            patch_back: Some(patch_back("mz-json")),
            runtime: None,
        },
    }
}

/// LEVEL: `helper`. KiriKiri XP3 commercial: patch reachable only with an
/// external key/helper present. Helper-gated crypto + a helper diagnostic;
/// full evidence chain for what it can do once the helper resolves the key.
pub fn level_helper_kirikiri_xp3() -> ClaimedSupportTuple {
    ClaimedSupportTuple {
        schema_version: CLAIMED_SUPPORT_SCHEMA_VERSION.to_string(),
        engine_family: CompatEngineFamily::KirikiriXp3,
        engine_variant: "kirikiri_xp3_encrypted".to_string(),
        container: ContainerTransform::Xp3,
        crypto: CryptoTransform::HelperGated,
        codec: CodecTransform::Utf16Text,
        surface: SurfaceTransform::ArchiveEntry,
        patch_back_mode: PatchBackTransform::RepackArchive,
        profile_or_fixture_id: "compat/kirikiri-xp3/helper-gated-patch".to_string(),
        secret_requirement_ids: vec![SecretRequirementId::new(
            "kirikiri.xp3.per-title-key",
            secret_ref("kirikiri-xp3-per-title-key"),
        )],
        diagnostics: vec![
            CompatDiagnostic::new(
                CompatLayer::Crypto,
                CompatDiagnosticStatus::HelperRequired,
                SemanticErrorCode::HelperRequired,
                PartialDiagnosticSeverity::P2,
            )
            .with_detail("per-title key material must be resolved by an external helper"),
        ],
        claimed_level: ClaimedSupportLevel::Helper,
        evidence: SupportEvidence {
            extraction: Some(extraction("xp3")),
            validation: Some(validation("xp3")),
            patch_back: Some(patch_back("xp3")),
            runtime: None,
        },
    }
}

/// A HONEST encrypted-asset `patch` tuple: RPG Maker MV/MZ encrypted media
/// asset replacement, gated by the asset encryption key (secretRequirement).
/// Full evidence chain (asset round-trip).
pub fn patch_rpg_maker_encrypted_asset() -> ClaimedSupportTuple {
    ClaimedSupportTuple {
        schema_version: CLAIMED_SUPPORT_SCHEMA_VERSION.to_string(),
        engine_family: CompatEngineFamily::RpgMakerMvMzEncryptedAsset,
        engine_variant: "rpg_maker_mv_encrypted_asset".to_string(),
        container: ContainerTransform::ProjectAsset,
        crypto: CryptoTransform::RpgMakerAssetKey,
        codec: CodecTransform::PngImage,
        surface: SurfaceTransform::BinaryOffset,
        patch_back_mode: PatchBackTransform::ReplaceAsset,
        profile_or_fixture_id: "compat/rpg-maker/mv-encrypted-asset-patch".to_string(),
        secret_requirement_ids: vec![SecretRequirementId::new(
            "rpg_maker.mv.encryption-key",
            secret_ref("rpgmaker-mv-encryption-key"),
        )],
        diagnostics: vec![
            CompatDiagnostic::new(
                CompatLayer::Codec,
                CompatDiagnosticStatus::MediaNonExtractable,
                SemanticErrorCode::UnsupportedLayeredTransform,
                PartialDiagnosticSeverity::P3,
            )
            .with_detail("media asset carries no extractable text; patch is asset replacement"),
        ],
        claimed_level: ClaimedSupportLevel::Patch,
        evidence: SupportEvidence {
            extraction: Some(extraction("mv-asset")),
            validation: Some(validation("mv-asset")),
            patch_back: Some(patch_back("mv-asset")),
            runtime: None,
        },
    }
}

/// LEVEL: `runtime`. A synthetic runtime-ready tuple carrying a full
/// evidence chain INCLUDING a runtime leg. This demonstrates the level is
/// distinguished; the honest live posture of the RealLive runtime is the
/// identify-only tuple above (the runtime engine is largely unbuilt).
pub fn level_runtime_synthetic() -> ClaimedSupportTuple {
    ClaimedSupportTuple {
        schema_version: CLAIMED_SUPPORT_SCHEMA_VERSION.to_string(),
        engine_family: CompatEngineFamily::RealLiveRuntime,
        engine_variant: "reallive_runtime_synthetic".to_string(),
        container: ContainerTransform::Archive,
        crypto: CryptoTransform::NullKey,
        codec: CodecTransform::BytecodeDecompile,
        surface: SurfaceTransform::RuntimeTrace,
        patch_back_mode: PatchBackTransform::RecompileBytecode,
        profile_or_fixture_id: "compat/reallive/runtime-synthetic".to_string(),
        secret_requirement_ids: vec![],
        diagnostics: vec![],
        claimed_level: ClaimedSupportLevel::Runtime,
        evidence: SupportEvidence {
            extraction: Some(extraction("runtime")),
            validation: Some(validation("runtime")),
            patch_back: Some(patch_back("runtime")),
            runtime: Some(EvidenceRef::new(
                "evidence/runtime/reallive",
                proof("runtime:reallive"),
            )),
        },
    }
}

/// An OVERCLAIMING tuple: claims `patch` but carries NO evidence and an
/// `unsupported` patch-back mode. The validator MUST fail this (acceptance
/// invariant 3). Used by the anti-overclaim test.
pub fn overclaim_patch_without_evidence() -> ClaimedSupportTuple {
    ClaimedSupportTuple {
        schema_version: CLAIMED_SUPPORT_SCHEMA_VERSION.to_string(),
        engine_family: CompatEngineFamily::Siglus,
        engine_variant: "siglus_pck_static_key".to_string(),
        container: ContainerTransform::SiglusPck,
        crypto: CryptoTransform::FixedKey,
        codec: CodecTransform::Utf16Text,
        surface: SurfaceTransform::ArchiveEntry,
        patch_back_mode: PatchBackTransform::Unsupported,
        profile_or_fixture_id: "compat/siglus/OVERCLAIM-patch".to_string(),
        secret_requirement_ids: vec![],
        diagnostics: vec![],
        claimed_level: ClaimedSupportLevel::Patch,
        evidence: SupportEvidence::none(),
    }
}

/// The full set of HONEST fixtures — one per level plus the extra real
/// adapters. Every one of these validates green.
pub fn honest_catalogue() -> Vec<ClaimedSupportTuple> {
    vec![
        level_identify(),
        level_inventory(),
        level_extract_siglus(),
        level_patch_kirikiri_kag_plaintext(),
        level_patch_tyranoscript(),
        patch_rpg_maker_mv_mz_json(),
        level_helper_kirikiri_xp3(),
        patch_rpg_maker_encrypted_asset(),
        level_runtime_synthetic(),
    ]
}
