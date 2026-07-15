use std::path::PathBuf;

use crate::{
    CapabilityLevel, CodecTransform, LayeredAccessHelperStatus, LayeredAccessKeyMaterialStatus,
    OperationStatus, read_json,
};

use super::super::{
    PACKED_ENGINE_READINESS_SUPPORT_BOUNDARY, PACKED_READINESS_REPORT_SCHEMA_VERSION,
    PackedEngineFamily,
};
use super::*;

fn fixtures_dir() -> PathBuf {
    crate::test_manifest_dir()
        .join("../..")
        .join("fixtures/kaifuu/packed-engine")
}

fn negative_dir() -> PathBuf {
    fixtures_dir().join("negative")
}

fn load(name: &str) -> PackedEngineReadinessProfile {
    read_json(&fixtures_dir().join(name)).unwrap_or_else(|e| panic!("load {name}: {e}"))
}

fn load_negative(name: &str) -> PackedEngineReadinessProfile {
    read_json(&negative_dir().join(name)).unwrap_or_else(|e| panic!("load negative {name}: {e}"))
}

#[test]
fn gated_states_can_never_be_profile_ready() {
    for family in PackedEngineFamily::recognized() {
        let spec = family.profile_spec().unwrap();
        let codec = *spec.allowed_codec.first().unwrap();
        for declared in CapabilityLevel::all() {
            // Every gated state is non-profile-ready for EVERY family.
            for (key, helper) in [
                (
                    LayeredAccessKeyMaterialStatus::Missing,
                    LayeredAccessHelperStatus::NotRequired,
                ),
                (
                    LayeredAccessKeyMaterialStatus::HelperGated,
                    LayeredAccessHelperStatus::Available,
                ),
                (
                    LayeredAccessKeyMaterialStatus::NotRequired,
                    LayeredAccessHelperStatus::Unavailable,
                ),
            ] {
                let out = derive_packed_readiness_outcome(&spec, declared, codec, key, helper);
                assert!(
                    !out.is_profile_ready(),
                    "{} gated state {key:?}/{helper:?} must not be profile-ready",
                    family.as_str()
                );
            }

            // For the non-media text engines the exact readiness outcome
            // is pinned (the media family short-circuits earlier — covered
            // by `media_transform_is_never_profile_ready`).
            if !spec.media_transform {
                assert_eq!(
                    derive_packed_readiness_outcome(
                        &spec,
                        declared,
                        codec,
                        LayeredAccessKeyMaterialStatus::Missing,
                        LayeredAccessHelperStatus::NotRequired,
                    ),
                    PackedReadinessOutcome::MissingKey
                );
                assert_eq!(
                    derive_packed_readiness_outcome(
                        &spec,
                        declared,
                        codec,
                        LayeredAccessKeyMaterialStatus::HelperGated,
                        LayeredAccessHelperStatus::Available,
                    ),
                    PackedReadinessOutcome::HelperRequired
                );
                assert_eq!(
                    derive_packed_readiness_outcome(
                        &spec,
                        declared,
                        codec,
                        LayeredAccessKeyMaterialStatus::NotRequired,
                        LayeredAccessHelperStatus::Unavailable,
                    ),
                    PackedReadinessOutcome::HelperRequired
                );
            }
        }
    }
}

#[test]
fn media_transform_is_never_profile_ready() {
    let spec = PackedEngineFamily::RpgMakerMvMzMedia
        .profile_spec()
        .unwrap();
    for declared in CapabilityLevel::all() {
        let out = derive_packed_readiness_outcome(
            &spec,
            declared,
            CodecTransform::PngImage,
            LayeredAccessKeyMaterialStatus::Resolved,
            LayeredAccessHelperStatus::NotRequired,
        );
        assert_eq!(out, PackedReadinessOutcome::UnsupportedLayeredTransform);
        assert!(!out.is_profile_ready());
    }
}

#[test]
fn resolved_gates_reach_the_declared_rung_capped_at_ceiling() {
    let spec = PackedEngineFamily::Siglus.profile_spec().unwrap();
    assert_eq!(
        derive_packed_readiness_outcome(
            &spec,
            CapabilityLevel::Patch,
            CodecTransform::Utf16Text,
            LayeredAccessKeyMaterialStatus::Resolved,
            LayeredAccessHelperStatus::NotRequired,
        ),
        PackedReadinessOutcome::Patch
    );
    assert_eq!(
        derive_packed_readiness_outcome(
            &spec,
            CapabilityLevel::Inventory,
            CodecTransform::Utf16Text,
            LayeredAccessKeyMaterialStatus::Resolved,
            LayeredAccessHelperStatus::NotRequired,
        ),
        PackedReadinessOutcome::Inventory
    );
}

#[test]
fn positive_fixture_dir_is_green_and_covers_all_outcomes() {
    use PackedReadinessOutcome::{
        Extract, HelperRequired, Identify, Inventory, MissingKey, Patch,
        UnsupportedLayeredTransform,
    };
    let report = validate_packed_engine_readiness_dir(&fixtures_dir())
        .expect("validation runs without environmental error");
    assert_eq!(
        report.status,
        OperationStatus::Passed,
        "entries: {:?}",
        report
            .entries
            .iter()
            .filter(|e| e.status == OperationStatus::Failed)
            .map(|e| (e.profile_id.clone(), e.findings.clone()))
            .collect::<Vec<_>>()
    );
    for entry in &report.entries {
        assert!(!entry.source_node_id.is_empty());
        assert!(!entry.fixture_id.is_empty());
    }
    // Every one of the seven outcomes appears at least once.
    for outcome in [
        Identify,
        Inventory,
        Extract,
        Patch,
        HelperRequired,
        MissingKey,
        UnsupportedLayeredTransform,
    ] {
        assert!(
            report
                .entries
                .iter()
                .any(|e| e.effective_outcome == outcome),
            "no entry produced outcome {}",
            outcome.as_str()
        );
    }
    // Both postures are populated and counted consistently.
    assert!(report.profile_ready_count > 0);
    assert!(report.readiness_only_count > 0);
    assert_eq!(
        report.profile_ready_count + report.readiness_only_count,
        report.profile_count
    );
}

#[test]
fn every_recognized_engine_has_a_positive_fixture() {
    let report = validate_packed_engine_readiness_dir(&fixtures_dir()).unwrap();
    for family in PackedEngineFamily::recognized() {
        assert!(
            report.entries.iter().any(|e| e.engine_family == family),
            "no positive fixture for {}",
            family.as_str()
        );
    }
}

fn has_code(entry: &PackedReadinessEntryReport, code: &str) -> bool {
    entry.findings.iter().any(|f| f.code == code)
}

#[test]
fn negative_missing_helper_fails() {
    let entry = validate_packed_engine_readiness_profile(&load_negative(
        "wolf-missing-helper.profile.json",
    ));
    assert_eq!(entry.status, OperationStatus::Failed);
    assert!(has_code(&entry, "packed.readiness.helper_id_missing"));
}

#[test]
fn negative_missing_key_fails() {
    let entry =
        validate_packed_engine_readiness_profile(&load_negative("rgss3-missing-key.profile.json"));
    assert_eq!(entry.status, OperationStatus::Failed);
    assert!(has_code(
        &entry,
        "packed.readiness.key_required_but_not_declared"
    ));
}

#[test]
fn negative_unsupported_codec_fails() {
    let entry = validate_packed_engine_readiness_profile(&load_negative(
        "siglus-unsupported-codec.profile.json",
    ));
    assert_eq!(entry.status, OperationStatus::Failed);
    assert!(has_code(&entry, "packed.readiness.unsupported_codec"));
}

#[test]
fn negative_hash_mismatch_fails() {
    let entry =
        validate_packed_engine_readiness_profile(&load_negative("bgi-hash-mismatch.profile.json"));
    assert_eq!(entry.status, OperationStatus::Failed);
    assert!(has_code(&entry, "packed.readiness.content_hash_mismatch"));
}

#[test]
fn negative_out_of_profile_container_fails() {
    let entry = validate_packed_engine_readiness_profile(&load_negative(
        "kirikiri-xp3-out-of-profile.profile.json",
    ));
    assert_eq!(entry.status, OperationStatus::Failed);
    assert!(has_code(
        &entry,
        "packed.readiness.out_of_profile_container"
    ));
}

#[test]
fn negative_capability_overclaim_fails() {
    let entry = validate_packed_engine_readiness_profile(&load_negative(
        "mv-mz-media-overclaim.profile.json",
    ));
    assert_eq!(entry.status, OperationStatus::Failed);
    assert!(has_code(&entry, "packed.readiness.capability_overclaim"));
}

#[test]
fn negative_dir_report_is_failed() {
    let report = validate_packed_engine_readiness_dir(&negative_dir())
        .expect("negative dir validates without environmental error");
    assert_eq!(report.status, OperationStatus::Failed);
    assert!(
        report
            .entries
            .iter()
            .all(|e| e.status == OperationStatus::Failed)
    );
}

#[test]
fn report_round_trips_and_carries_acceptance_tuple() {
    let report = validate_packed_engine_readiness_dir(&fixtures_dir()).unwrap();
    let json = report.stable_json().expect("stable json");
    assert!(json.ends_with('\n'));
    let parsed: PackedReadinessValidationReport = serde_json::from_str(&json).expect("round trip");
    // Spot-check that the acceptance tuple survives serialization.
    let entry = parsed
        .entries
        .iter()
        .find(|e| e.posture == PackedReadinessPosture::ProfileReady)
        .unwrap();
    assert!(!entry.profile_id.is_empty());
    assert!(!entry.fixture_id.is_empty());
    assert!(entry.content_hash.as_str().starts_with("sha256:"));
}

#[test]
fn report_redacts_path_bearing_ids() {
    let mut profile = load("siglus.positive.profile.json");
    profile.profile_id = "/home/trevor/private/leak.pck".to_string();
    let entry = validate_packed_engine_readiness_profile(&profile);
    let report = PackedReadinessValidationReport {
        schema_version: PACKED_READINESS_REPORT_SCHEMA_VERSION.to_string(),
        support_boundary: PACKED_ENGINE_READINESS_SUPPORT_BOUNDARY.to_string(),
        status: entry.status.clone(),
        profile_count: 1,
        profile_ready_count: 1,
        readiness_only_count: 0,
        entries: vec![entry],
    };
    let json = report.stable_json().unwrap();
    assert!(!json.contains("/home/trevor/private/leak.pck"));
    assert!(json.contains("[REDACTED:"));
}

#[test]
fn content_hash_recompute_is_order_independent() {
    let mut profile = load("siglus.positive.profile.json");
    profile.content.reverse();
    let recomputed = recompute_content_hash(&profile.content).unwrap();
    assert_eq!(recomputed.as_str(), profile.content_hash.as_str());
}
