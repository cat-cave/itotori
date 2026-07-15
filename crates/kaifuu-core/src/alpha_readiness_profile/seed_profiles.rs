use crate::{
    AdapterCapabilityMatrix, CapabilityLevel, CapabilityLevelStatus, PackedEngineFamily,
    PatchBackTransform, SecretRef,
};

use super::{
    ALPHA_READINESS_PROFILE_SCHEMA_VERSION, ALPHA_READINESS_SOURCE_NODE_ID, AlphaHelperKeyStatus,
    AlphaReadinessProfile, AlphaReadinessProvenance,
};

// Template + seeds (generation from public synthetic fixtures)

fn matrix_up_to(
    family: PackedEngineFamily,
    ceiling: CapabilityLevel,
    reason_above: &str,
) -> AdapterCapabilityMatrix {
    AdapterCapabilityMatrix::up_to(
        AlphaReadinessProfile::synthetic_adapter_id(family),
        ceiling,
        reason_above,
    )
}

pub(super) fn secret(name: &str) -> SecretRef {
    SecretRef::new(name).expect("static local-secret ref is valid")
}

/// The canonical, validation-passing TEMPLATE an author copies to declare a new
/// alpha subset engine. Conservative by construction: identify-only, no key,
/// no helper, no patch-back — an author RAISES rungs as proof lands.
pub fn alpha_readiness_profile_template() -> AlphaReadinessProfile {
    AlphaReadinessProfile {
        schema_version: ALPHA_READINESS_PROFILE_SCHEMA_VERSION.to_string(),
        profile_id: "packed/_template".to_string(),
        fixture_id: "alpha.readiness.template".to_string(),
        source_node_id: ALPHA_READINESS_SOURCE_NODE_ID.to_string(),
        prerequisite_proof: "packed_engine_readiness.EngineProfileSpec".to_string(),
        engine_family: PackedEngineFamily::Bgi,
        capabilities: AdapterCapabilityMatrix::identify_only(
            AlphaReadinessProfile::synthetic_adapter_id(PackedEngineFamily::Bgi),
            "template: raise this rung only when a prerequisite proof node backs it",
        ),
        helper_key: AlphaHelperKeyStatus::none_required(),
        patch_back: PatchBackTransform::Unsupported,
        provenance: AlphaReadinessProvenance::public_synthetic(),
    }
}

/// Siglus seed — the richest subset engine: identify → extract supported, patch
/// alpha-partial (synthetic scene patch-back proven; retail repack not yet
/// blessed). Static scene key resolved.
pub fn alpha_readiness_seed_siglus() -> AlphaReadinessProfile {
    let mut capabilities = matrix_up_to(
        PackedEngineFamily::Siglus,
        CapabilityLevel::Patch,
        "alpha: not yet blessed",
    );
    capabilities.patch = CapabilityLevelStatus::partial([
        "alpha: synthetic scene patch-back proven; retail-scale repack not yet blessed",
    ]);
    AlphaReadinessProfile {
        schema_version: ALPHA_READINESS_PROFILE_SCHEMA_VERSION.to_string(),
        profile_id: "packed/siglus/alpha".to_string(),
        fixture_id: "alpha.readiness.siglus".to_string(),
        source_node_id: ALPHA_READINESS_SOURCE_NODE_ID.to_string(),
        prerequisite_proof: "siglus_profile_proof".to_string(),
        engine_family: PackedEngineFamily::Siglus,
        capabilities,
        helper_key: AlphaHelperKeyStatus::resolved_key(secret(
            "local-secret:siglus-scene-static-key",
        )),
        patch_back: PatchBackTransform::RepackArchive,
        provenance: AlphaReadinessProvenance::public_synthetic(),
    }
}

/// KiriKiri XP3 seed — plain-archive text: identify → extract supported, patch
/// not yet blessed at alpha. Plain XP3 needs neither key nor helper.
pub fn alpha_readiness_seed_kirikiri_xp3() -> AlphaReadinessProfile {
    AlphaReadinessProfile {
        schema_version: ALPHA_READINESS_PROFILE_SCHEMA_VERSION.to_string(),
        profile_id: "packed/kirikiri-xp3/alpha".to_string(),
        fixture_id: "alpha.readiness.kirikiri-xp3".to_string(),
        source_node_id: ALPHA_READINESS_SOURCE_NODE_ID.to_string(),
        prerequisite_proof: "xp3_capability_profile".to_string(),
        engine_family: PackedEngineFamily::KirikiriXp3,
        capabilities: matrix_up_to(
            PackedEngineFamily::KirikiriXp3,
            CapabilityLevel::Extract,
            "alpha: XP3 repack patch-back not yet blessed",
        ),
        helper_key: AlphaHelperKeyStatus::none_required(),
        patch_back: PatchBackTransform::Unsupported,
        provenance: AlphaReadinessProvenance::public_synthetic(),
    }
}

/// Wolf RPG Editor seed — archive text: identify → extract supported, patch
/// alpha-partial. No key/helper for the plain archive variant.
pub fn alpha_readiness_seed_wolf() -> AlphaReadinessProfile {
    let mut capabilities = matrix_up_to(
        PackedEngineFamily::Wolf,
        CapabilityLevel::Patch,
        "alpha: not yet blessed",
    );
    capabilities.patch = CapabilityLevelStatus::partial([
        "alpha: synthetic archive patch-back proven; retail repack not yet blessed",
    ]);
    AlphaReadinessProfile {
        schema_version: ALPHA_READINESS_PROFILE_SCHEMA_VERSION.to_string(),
        profile_id: "packed/wolf/alpha".to_string(),
        fixture_id: "alpha.readiness.wolf".to_string(),
        source_node_id: ALPHA_READINESS_SOURCE_NODE_ID.to_string(),
        prerequisite_proof: "wolf_archive_readiness_fixture".to_string(),
        engine_family: PackedEngineFamily::Wolf,
        capabilities,
        helper_key: AlphaHelperKeyStatus::none_required(),
        patch_back: PatchBackTransform::RepackArchive,
        provenance: AlphaReadinessProvenance::public_synthetic(),
    }
}

/// RPG Maker VX Ace / RGSS3 seed — RGSSAD header XOR key resolved; identify
/// supported, inventory alpha-partial, extract/patch not yet blessed.
pub fn alpha_readiness_seed_rgss3() -> AlphaReadinessProfile {
    let mut capabilities = matrix_up_to(
        PackedEngineFamily::Rgss3,
        CapabilityLevel::Identify,
        "alpha: RGSSAD extraction not yet blessed",
    );
    capabilities.inventory = CapabilityLevelStatus::partial([
        "alpha: RGSSAD entry listing proven on synthetic archive; not retail-blessed",
    ]);
    AlphaReadinessProfile {
        schema_version: ALPHA_READINESS_PROFILE_SCHEMA_VERSION.to_string(),
        profile_id: "packed/rgss3/alpha".to_string(),
        fixture_id: "alpha.readiness.rgss3".to_string(),
        source_node_id: ALPHA_READINESS_SOURCE_NODE_ID.to_string(),
        prerequisite_proof: "rgss3_header_key_readiness_fixture".to_string(),
        engine_family: PackedEngineFamily::Rgss3,
        capabilities,
        helper_key: AlphaHelperKeyStatus::resolved_key(secret("local-secret:rgss3-header-xor-key")),
        patch_back: PatchBackTransform::Unsupported,
        provenance: AlphaReadinessProvenance::public_synthetic(),
    }
}

/// BGI / Ethornell seed — the honest detector/profile-only ceiling. Identify
/// supported; inventory / extract / patch UNSUPPORTED (no archive parser, no
/// patch support). Backed by the detection node.
pub fn alpha_readiness_seed_bgi() -> AlphaReadinessProfile {
    AlphaReadinessProfile {
        schema_version: ALPHA_READINESS_PROFILE_SCHEMA_VERSION.to_string(),
        profile_id: "packed/bgi/alpha".to_string(),
        fixture_id: "alpha.readiness.bgi".to_string(),
        source_node_id: ALPHA_READINESS_SOURCE_NODE_ID.to_string(),
        prerequisite_proof: "bgi-detection".to_string(),
        engine_family: PackedEngineFamily::Bgi,
        capabilities: AdapterCapabilityMatrix::identify_only(
            AlphaReadinessProfile::synthetic_adapter_id(PackedEngineFamily::Bgi),
            "detector/profile evidence only; no archive parser or patch support",
        ),
        helper_key: AlphaHelperKeyStatus::none_required(),
        patch_back: PatchBackTransform::Unsupported,
        provenance: AlphaReadinessProvenance::public_synthetic(),
    }
}

/// All five alpha subset seeds, in canonical order.
pub fn alpha_readiness_seeds() -> Vec<AlphaReadinessProfile> {
    vec![
        alpha_readiness_seed_siglus(),
        alpha_readiness_seed_kirikiri_xp3(),
        alpha_readiness_seed_wolf(),
        alpha_readiness_seed_rgss3(),
        alpha_readiness_seed_bgi(),
    ]
}
