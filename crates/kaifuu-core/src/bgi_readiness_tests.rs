use super::*;
use std::path::PathBuf;

use crate::{BGI_ENGINE_FAMILY, BgiDetectorProfile, OperationStatus, ProofHash};

fn fixtures_dir() -> PathBuf {
    crate::test_manifest_dir()
        .join("../..")
        .join("fixtures/kaifuu/bgi")
}

fn load() -> BgiReadinessFixture {
    read_bgi_readiness_fixture(&fixtures_dir().join("readiness.cases.json"))
        .expect("BGI readiness fixture must parse")
}

fn run() -> BgiReadinessReport {
    run_bgi_readiness(&load())
}

#[test]
fn readiness_fixture_set_passes_and_records_every_field() {
    let fixture = load();
    let report = run_bgi_readiness(&fixture);
    assert_eq!(
        report.status,
        OperationStatus::Passed,
        "{:?}",
        report.entries
    );
    assert!(!report.entries.is_empty());
    assert_eq!(report.engine_family, BGI_ENGINE_FAMILY);
    assert_eq!(report.source_node_id, fixture.source_node_id);
    for entry in &report.entries {
        assert_eq!(
            entry.status,
            OperationStatus::Passed,
            "case {} failed: {:?}",
            entry.case_id,
            entry.findings
        );
        assert_eq!(entry.engine_family, BGI_ENGINE_FAMILY);
        assert!(!entry.case_id.is_empty());
        assert!(!entry.claim_basis.is_empty());
    }
}

#[test]
fn the_five_levels_are_distinguished_by_fixture_evidence() {
    let report = run();
    assert_eq!(
        report.level("bgi.readiness.unsupported-encrypted"),
        Some(BgiReadinessLevel::Unsupported)
    );
    assert_eq!(
        report.level("bgi.readiness.unsupported-compressed"),
        Some(BgiReadinessLevel::Unsupported)
    );
    assert_eq!(
        report.level("bgi.readiness.unsupported-unknown"),
        Some(BgiReadinessLevel::Unsupported)
    );
    assert_eq!(
        report.level("bgi.readiness.identify"),
        Some(BgiReadinessLevel::Identify)
    );
    assert_eq!(
        report.level("bgi.readiness.inventory-header"),
        Some(BgiReadinessLevel::Inventory)
    );
    assert_eq!(
        report.level("bgi.readiness.inventory-no-header"),
        Some(BgiReadinessLevel::Inventory)
    );
    assert_eq!(
        report.level("bgi.readiness.extract"),
        Some(BgiReadinessLevel::Extract)
    );
    assert_eq!(
        report.level("bgi.readiness.patch"),
        Some(BgiReadinessLevel::Patch)
    );
}

#[test]
fn each_case_combines_detector_and_bytecode_evidence() {
    let report = run();
    let identify = report.entry("bgi.readiness.identify").unwrap();
    assert_eq!(
        identify.container_profile,
        Some(BgiDetectorProfile::BurikoArc20Container)
    );
    assert!(identify.detector.is_some());
    assert!(identify.bytecode.is_none());
    assert_eq!(identify.inventory_surface_count, 0);

    let inventory = report.entry("bgi.readiness.inventory-header").unwrap();
    assert!(inventory.bytecode.is_some());
    assert!(inventory.inventory_surface_count > 0);

    let extract = report.entry("bgi.readiness.extract").unwrap();
    assert_eq!(
        extract.container_profile,
        Some(BgiDetectorProfile::BurikoArc20Container)
    );
    assert!(extract.inventory_surface_count > 0);
    assert!(!extract.proof_hashes.is_empty());
}

#[test]
fn unsupported_cases_report_the_honest_missing_capability_boundary() {
    let report = run();
    let encrypted = report.entry("bgi.readiness.unsupported-encrypted").unwrap();
    assert_eq!(
        encrypted.container_profile,
        Some(BgiDetectorProfile::BseEncryptedContainer)
    );
    let detector = encrypted.detector.as_ref().unwrap();
    assert!(detector.secret_requirement_ids.is_empty());
    assert!(
        detector
            .diagnostics
            .iter()
            .any(|d| { d.semantic_code == crate::SemanticErrorCode::UnsupportedVariantEncrypted })
    );
    assert!(
        detector
            .diagnostics
            .iter()
            .any(|d| d.semantic_code == crate::SemanticErrorCode::MissingCryptoCapability)
    );

    let compressed = report
        .entry("bgi.readiness.unsupported-compressed")
        .unwrap();
    let compressed_detector = compressed.detector.as_ref().unwrap();
    assert!(
        compressed_detector
            .diagnostics
            .iter()
            .any(|d| d.semantic_code == crate::SemanticErrorCode::MissingCodecCapability)
    );
}

#[test]
fn failed_detector_stays_at_the_floor_while_passing_detector_lifts() {
    let mut failed_fixture = load();
    let sample_case = failed_fixture
        .cases
        .iter_mut()
        .find(|case| case.expected_level == BgiReadinessLevel::Extract)
        .expect("fixture includes an extract case");
    let sample_fixture_id = sample_case.fixture_id.clone();
    sample_case
        .detector
        .as_mut()
        .expect("extract case includes a detector")
        .proof_hashes
        .clear();

    let failed = run_bgi_readiness(&failed_fixture);
    let failed_entry = failed.entry(&sample_fixture_id).unwrap();
    assert_eq!(
        failed_entry
            .detector
            .as_ref()
            .map(|detector| &detector.status),
        Some(&OperationStatus::Failed)
    );
    assert!(failed_entry.inventory_surface_count > 0);
    assert_eq!(failed_entry.container_profile, None);
    assert_eq!(failed_entry.readiness_level, BgiReadinessLevel::Unsupported);
    assert!(
        failed_entry
            .findings
            .iter()
            .any(|finding| finding.code == "bgi.readiness.detector_evidence_failed")
    );

    let passing = run();
    let passing_entry = passing.entry(&sample_fixture_id).unwrap();
    assert_eq!(passing_entry.status, OperationStatus::Passed);
    assert_eq!(passing_entry.readiness_level, BgiReadinessLevel::Extract);
}

#[test]
fn extract_and_patch_require_an_explicit_fixture_proof() {
    let no_proof = BgiReadinessEvidence {
        container_profile: Some(BgiDetectorProfile::BurikoArc20Container),
        detector_failed: false,
        inventory_proven: true,
        extract_proven: false,
        patch_proven: false,
    };
    assert_eq!(
        derive_bgi_readiness_level(&no_proof),
        BgiReadinessLevel::Inventory
    );

    let extract = BgiReadinessEvidence {
        extract_proven: true,
        ..no_proof
    };
    assert_eq!(
        derive_bgi_readiness_level(&extract),
        BgiReadinessLevel::Extract
    );

    let patch = BgiReadinessEvidence {
        extract_proven: true,
        patch_proven: true,
        ..no_proof
    };
    assert_eq!(derive_bgi_readiness_level(&patch), BgiReadinessLevel::Patch);
}

#[test]
fn closed_container_is_never_lifted_by_a_proof() {
    for profile in [
        BgiDetectorProfile::BseEncryptedContainer,
        BgiDetectorProfile::DscCompressedContainer,
        BgiDetectorProfile::CompressedBgLayeredTransform,
        BgiDetectorProfile::NoHeaderArc,
        BgiDetectorProfile::UnknownContainer,
    ] {
        for (inventory_proven, extract_proven, patch_proven) in [
            (false, false, false),
            (true, false, false),
            (true, true, false),
            (true, true, true),
        ] {
            let evidence = BgiReadinessEvidence {
                container_profile: Some(profile),
                detector_failed: false,
                inventory_proven,
                extract_proven,
                patch_proven,
            };
            assert_eq!(
                derive_bgi_readiness_level(&evidence),
                BgiReadinessLevel::Unsupported,
                "profile {profile:?} must not be lifted above unsupported",
            );
        }
    }
}

#[test]
fn patch_level_requires_verified_bytecode_patch_report() {
    let mut fixture = load();
    let case = fixture
        .cases
        .iter_mut()
        .find(|case| case.fixture_id == "bgi.readiness.patch")
        .unwrap();
    let bytecode = case.bytecode.as_mut().unwrap();
    bytecode.claims_patch_support = false;
    bytecode.patch_cases.clear();

    let report = run_bgi_readiness(&fixture);
    let entry = report.entry("bgi.readiness.patch").unwrap();
    assert_eq!(entry.status, OperationStatus::Failed);
    assert!(
        entry
            .findings
            .iter()
            .any(|finding| finding.code == "bgi.readiness.bytecode_patch_proof_missing")
    );
    assert_eq!(entry.readiness_level, BgiReadinessLevel::Extract);
    assert!(
        entry
            .bytecode
            .as_ref()
            .is_some_and(|bytecode| bytecode.patch_reports.is_empty())
    );
}

#[test]
fn committed_patch_case_composes_bytecode_extract_to_patch_proof() {
    let report = run();
    let entry = report.entry("bgi.readiness.patch").unwrap();
    assert_eq!(
        entry.status,
        OperationStatus::Passed,
        "{:?}",
        entry.findings
    );
    assert_eq!(entry.readiness_level, BgiReadinessLevel::Patch);
    let bytecode = entry.bytecode.as_ref().expect("patch case embeds bytecode");
    assert!(!bytecode.patch_reports.is_empty());
    assert!(
        bytecode
            .patch_reports
            .iter()
            .all(|report| report.patched_text_verified && report.untouched_bytes_identical)
    );
}

#[test]
fn fabricated_extract_proof_is_refused() {
    let mut fixture = load();
    let case = fixture
        .cases
        .iter_mut()
        .find(|case| case.fixture_id == "bgi.readiness.extract")
        .unwrap();
    case.extract_proof.as_mut().unwrap().proof_hash =
        ProofHash::new(format!("sha256:{}", "a".repeat(64))).unwrap();
    let report = run_bgi_readiness(&fixture);
    let entry = report.entry("bgi.readiness.extract").unwrap();
    assert_eq!(entry.status, OperationStatus::Failed);
    assert!(
        entry
            .findings
            .iter()
            .any(|finding| finding.code == "bgi.readiness.artifact_proof_invalid")
    );
    assert_eq!(entry.readiness_level, BgiReadinessLevel::Inventory);
}

#[test]
fn declared_level_mismatch_is_a_finding() {
    let mut fixture = load();
    let case = fixture
        .cases
        .iter_mut()
        .find(|case| case.fixture_id == "bgi.readiness.inventory-header")
        .unwrap();
    case.expected_level = BgiReadinessLevel::Patch;
    let report = run_bgi_readiness(&fixture);
    assert_eq!(report.status, OperationStatus::Failed);
    let entry = report.entry("bgi.readiness.inventory-header").unwrap();
    assert!(
        entry
            .findings
            .iter()
            .any(|finding| finding.code == "bgi.readiness.level_mismatch")
    );
    assert_eq!(entry.readiness_level, BgiReadinessLevel::Inventory);
}

#[test]
fn report_is_redaction_clean() {
    let report = run();
    let json = report.stable_json().expect("stable json");
    assert!(json.contains("sha256:"));
    assert!(!json.contains("BEGIN"));
    assert!(!json.contains("/home/"));
    assert!(!json.contains("local-secret:"));
}

#[test]
fn report_redacts_local_paths_and_never_carries_raw_key_material() {
    let mut fixture = load();
    fixture.readiness_set_id = "/home/trevor/private/bgi/leak.arc".to_string();
    let report = run_bgi_readiness(&fixture);
    let json = report.stable_json().expect("stable json");
    assert!(json.contains("[REDACTED:"));
    assert!(!json.contains("/home/trevor/private/bgi/leak.arc"));
    assert!(!json.contains("BEGIN"));
}

#[test]
fn report_round_trips_through_json() {
    let report = run();
    let json = serde_json::to_string(&report.redacted_for_report()).expect("serialize");
    let round: BgiReadinessReport = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(round, report.redacted_for_report());
}

#[test]
fn level_ordering_places_unsupported_at_the_floor() {
    assert!(BgiReadinessLevel::Unsupported < BgiReadinessLevel::Identify);
    assert!(BgiReadinessLevel::Identify < BgiReadinessLevel::Inventory);
    assert!(BgiReadinessLevel::Inventory < BgiReadinessLevel::Extract);
    assert!(BgiReadinessLevel::Extract < BgiReadinessLevel::Patch);
}
