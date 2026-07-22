use super::*;
use std::path::PathBuf;

fn fixtures_dir() -> PathBuf {
    crate::test_manifest_dir()
        .join("../..")
        .join("fixtures/kaifuu/alpha-readiness")
}

fn seeds_dir() -> PathBuf {
    fixtures_dir().join("seeds")
}

fn negative_dir() -> PathBuf {
    fixtures_dir().join("negative")
}

#[test]
fn every_seed_states_all_five_operations_and_passes() {
    for profile in alpha_readiness_seeds() {
        let entry = validate_alpha_readiness_profile(&profile);
        assert_eq!(
            entry.status,
            OperationStatus::Passed,
            "seed {} failed: {:?}",
            profile.profile_id,
            entry.findings
        );
        // All five operation statuses are populated (non-empty kinds).
        assert!(!entry.operations.identify.is_empty());
        assert!(!entry.operations.inventory.is_empty());
        assert!(!entry.operations.extract.is_empty());
        assert!(!entry.operations.patch.is_empty());
        assert!(!entry.operations.helper_key.is_empty());
    }
}

#[test]
fn all_five_subset_engines_are_seeded() {
    let families: Vec<PackedEngineFamily> = alpha_readiness_seeds()
        .iter()
        .map(|p| p.engine_family)
        .collect();
    for expected in [
        PackedEngineFamily::Siglus,
        PackedEngineFamily::KirikiriXp3,
        PackedEngineFamily::Wolf,
        PackedEngineFamily::Rgss3,
        PackedEngineFamily::Bgi,
    ] {
        assert!(
            families.contains(&expected),
            "missing seed for {expected:?}"
        );
    }
}

#[test]
fn bgi_is_detector_profile_only_no_parser_or_patch() {
    let entry = validate_alpha_readiness_profile(&alpha_readiness_seed_bgi());
    assert_eq!(entry.status, OperationStatus::Passed);
    assert!(entry.detector_only, "BGI must be detector/profile-only");
    assert_eq!(
        entry.highest_supported_level,
        Some(CapabilityLevel::Identify)
    );
    // No archive parser (inventory/extract) and no patch support.
    assert_eq!(entry.operations.inventory, "unsupported");
    assert_eq!(entry.operations.extract, "unsupported");
    assert_eq!(entry.operations.patch, "unsupported");
    assert_eq!(entry.patch_back, PatchBackTransform::Unsupported);
}

#[test]
fn seeds_round_trip_through_public_synthetic_json() {
    for profile in alpha_readiness_seeds() {
        let json = stable_json(&profile).expect("serialize seed");
        let parsed: AlphaReadinessProfile = serde_json::from_str(&json).expect("round trip seed");
        assert_eq!(parsed, profile);
        assert!(profile.provenance.from_public_synthetic_fixture);
    }
}

#[test]
fn profile_generates_from_public_synthetic_fixture_dir() {
    let summary = render_alpha_capability_summary_dir(&seeds_dir())
        .expect("summary renders without environmental error");
    assert_eq!(
        summary.status,
        OperationStatus::Passed,
        "rows: {:?}",
        summary.rows
    );
    assert_eq!(summary.engine_count, 5);
    // BGI is the sole detector-only engine in the subset.
    assert!(summary.detector_only_count >= 1);
    assert!(summary.patch_capable_count >= 1);
}

#[test]
fn private_local_aggregate_supplement_is_ref_only_and_valid() {
    let mut profile = alpha_readiness_seed_siglus();
    profile.provenance =
        AlphaReadinessProvenance::supplemented("aggregate:siglus-2026-07-04-abc123");
    let entry = validate_alpha_readiness_profile(&profile);
    assert_eq!(entry.status, OperationStatus::Passed);
    let json = stable_json(&entry).unwrap();
    assert!(!json.contains("/home/"));
}

#[test]
fn private_aggregate_path_is_rejected() {
    let mut profile = alpha_readiness_seed_siglus();
    profile.provenance =
        AlphaReadinessProvenance::supplemented("/home/trevor/private/aggregate.json");
    let entry = validate_alpha_readiness_profile(&profile);
    assert_eq!(entry.status, OperationStatus::Failed);
    assert!(
        entry
            .findings
            .iter()
            .any(|f| f.code == "alpha.readiness.provenance_ref_invalid")
    );
}

#[test]
fn missing_fixture_field_fails() {
    let mut profile = alpha_readiness_seed_wolf();
    profile.fixture_id = String::new();
    let entry = validate_alpha_readiness_profile(&profile);
    assert_eq!(entry.status, OperationStatus::Failed);
    assert!(
        entry
            .findings
            .iter()
            .any(|f| f.code == "alpha.readiness.fixture_missing")
    );
}

#[test]
fn claimed_patch_without_write_mode_fails_as_in_profile_bug() {
    let mut profile = alpha_readiness_seed_siglus();
    // Siglus claims patch, but drop the patch-back write mode.
    profile.patch_back = PatchBackTransform::Unsupported;
    let entry = validate_alpha_readiness_profile(&profile);
    assert_eq!(entry.status, OperationStatus::Failed);
    let finding = entry
        .findings
        .iter()
        .find(|f| f.code == "alpha.readiness.patch_back_missing_for_claimed_patch")
        .expect("patch-back finding");
    assert_eq!(finding.failure_class, ReadinessFailureClass::InProfileBug);
}

#[test]
fn claimed_extract_without_key_fails_for_key_required_engine() {
    let mut profile = alpha_readiness_seed_siglus();
    profile.helper_key = AlphaHelperKeyStatus::none_required();
    let entry = validate_alpha_readiness_profile(&profile);
    assert_eq!(entry.status, OperationStatus::Failed);
    assert!(entry.findings.iter().any(|f| {
        f.code == "alpha.readiness.key_missing_for_claimed_extract"
            && f.failure_class == ReadinessFailureClass::InProfileBug
    }));
}

#[test]
fn resolved_key_without_ref_fails() {
    let mut profile = alpha_readiness_seed_rgss3();
    profile.helper_key.key_ref = None;
    let entry = validate_alpha_readiness_profile(&profile);
    assert_eq!(entry.status, OperationStatus::Failed);
    assert!(
        entry
            .findings
            .iter()
            .any(|f| f.code == "alpha.readiness.key_ref_missing")
    );
}

#[test]
fn required_helper_without_id_fails() {
    let mut profile = alpha_readiness_seed_wolf();
    profile.helper_key.helper_status = LayeredAccessHelperStatus::Available;
    let entry = validate_alpha_readiness_profile(&profile);
    assert_eq!(entry.status, OperationStatus::Failed);
    assert!(
        entry
            .findings
            .iter()
            .any(|f| f.code == "alpha.readiness.helper_id_missing")
    );
}

#[test]
fn unknown_engine_is_out_of_profile_not_a_bug() {
    let mut profile = alpha_readiness_seed_bgi();
    profile.engine_family = PackedEngineFamily::Unknown;
    let entry = validate_alpha_readiness_profile(&profile);
    assert_eq!(entry.status, OperationStatus::Failed);
    assert_eq!(entry.out_of_profile_finding_count, 1);
    assert_eq!(entry.in_profile_bug_count, 0);
    assert!(entry.findings.iter().any(|f| {
        f.code == "alpha.readiness.unknown_engine_family"
            && f.failure_class == ReadinessFailureClass::OutOfProfile
    }));
}

#[test]
fn overclaim_past_family_ceiling_is_out_of_profile() {
    // RPG Maker MV/MZ media has an `identify` ceiling; claim patch on it.
    let profile = AlphaReadinessProfile {
        schema_version: ALPHA_READINESS_PROFILE_SCHEMA_VERSION.to_string(),
        profile_id: "packed/mvmz/overclaim".to_string(),
        fixture_id: "alpha.readiness.mvmz-overclaim".to_string(),
        source_node_id: ALPHA_READINESS_SOURCE_NODE_ID.to_string(),
        prerequisite_proof: "mv_mz_readiness".to_string(),
        engine_family: PackedEngineFamily::RpgMakerMvMzMedia,
        capabilities: AdapterCapabilityMatrix::up_to(
            "kaifuu.packed.rpg_maker_mv_mz_media",
            CapabilityLevel::Patch,
            "n/a",
        ),
        helper_key: AlphaHelperKeyStatus::resolved_key(seed_profiles::secret(
            "local-secret:rpgmaker-mv-asset-key",
        )),
        patch_back: PatchBackTransform::RepackArchive,
        provenance: AlphaReadinessProvenance::public_synthetic(),
    };
    let entry = validate_alpha_readiness_profile(&profile);
    assert_eq!(entry.status, OperationStatus::Failed);
    assert!(entry.findings.iter().any(|f| {
        f.code == "alpha.readiness.capability_overclaim"
            && f.failure_class == ReadinessFailureClass::OutOfProfile
    }));
}

#[test]
fn honest_unsupported_rung_is_not_a_finding() {
    // BGI honestly declares inventory/extract/patch unsupported — that is
    // the boundary, not a defect: zero findings, and it passes.
    let entry = validate_alpha_readiness_profile(&alpha_readiness_seed_bgi());
    assert!(entry.findings.is_empty());
    assert_eq!(entry.in_profile_bug_count, 0);
    assert_eq!(entry.out_of_profile_finding_count, 0);
}

#[test]
fn template_is_valid_and_conservative() {
    let template = alpha_readiness_profile_template();
    let entry = validate_alpha_readiness_profile(&template);
    assert_eq!(entry.status, OperationStatus::Passed);
    assert_eq!(
        entry.highest_supported_level,
        Some(CapabilityLevel::Identify)
    );
    assert!(entry.detector_only);
}

#[test]
fn renderer_covers_all_engines_and_round_trips() {
    let summary = render_alpha_capability_summary(&alpha_readiness_seeds());
    assert_eq!(summary.status, OperationStatus::Passed);
    assert_eq!(summary.engine_count, 5);
    assert!(summary.row(PackedEngineFamily::Bgi).unwrap().detector_only);
    let json = summary.stable_json().expect("stable json");
    assert!(json.ends_with('\n'));
    let parsed: AlphaCapabilitySummary = serde_json::from_str(&json).expect("round trip");
    assert_eq!(parsed.engine_count, 5);
    // Text table names engines + kinds only.
    let table = summary.render_text_table();
    assert!(table.contains("siglus"));
    assert!(table.contains("bgi"));
}

#[test]
fn summary_serializes_no_keys_paths_or_filenames() {
    let mut profiles = alpha_readiness_seeds();
    // Inject a path into an id; it must be redacted, never serialized raw.
    profiles[0].profile_id = "/home/trevor/private/scene/000.ss".to_string();
    let summary = render_alpha_capability_summary(&profiles);
    let json = summary.stable_json().unwrap();
    assert!(!json.contains("/home/"));
    assert!(json.contains("[REDACTED:"));
    // The rendered summary never carries a raw key ref at all (only kinds).
    assert!(!json.contains("local-secret:"));
}

#[test]
fn key_ref_never_serializes_raw_key_bytes() {
    // The profile serializes the local-secret REF (allowed), never raw key
    // material, and never a local path.
    let json = stable_json(&alpha_readiness_seed_siglus()).unwrap();
    assert!(json.contains("local-secret:siglus-scene-static-key"));
    assert!(!json.contains("/home/"));
}

#[test]
fn malformed_fixture_is_a_failed_row_not_a_panic() {
    let summary = render_alpha_capability_summary_dir(&negative_dir())
        .expect("negative dir renders without environmental error");
    assert_eq!(summary.status, OperationStatus::Failed);
    assert!(
        summary
            .rows
            .iter()
            .all(|r| r.status == OperationStatus::Failed)
    );
}
