use super::*;
use std::path::PathBuf;

use crate::wolf_helper_boundary::WolfHelperBoundaryOutcome;

fn fixtures_dir() -> PathBuf {
    crate::test_manifest_dir()
        .join("../..")
        .join("fixtures/kaifuu/wolf")
}

fn load() -> WolfReadinessFixture {
    read_wolf_readiness_fixture(&fixtures_dir().join("readiness.cases.json"))
        .expect("Wolf readiness fixture must parse")
}

fn run() -> WolfReadinessReport {
    run_wolf_readiness(&load())
}

#[test]
fn readiness_fixture_set_passes_and_records_every_field() {
    let fixture = load();
    let expected_source_node_id = fixture.source_node_id.clone();
    let report = run_wolf_readiness(&fixture);
    assert_eq!(
        report.status,
        OperationStatus::Passed,
        "{:?}",
        report.entries
    );
    assert!(!report.entries.is_empty());
    for entry in &report.entries {
        assert_eq!(
            entry.status,
            OperationStatus::Passed,
            "case {} failed: {:?}",
            entry.case_id,
            entry.findings
        );
        assert_eq!(entry.engine_family, WOLF_ENGINE_FAMILY);
        assert_eq!(entry.source_node_id, expected_source_node_id);
        assert!(!entry.case_id.is_empty());
        assert!(!entry.claim_basis.is_empty());
    }
}

#[test]
fn the_six_levels_are_distinguished_by_fixture_evidence() {
    let report = run();
    assert_eq!(
        report.level("wolf.readiness.unsupported"),
        Some(WolfReadinessLevel::Unsupported)
    );
    assert_eq!(
        report.level("wolf.readiness.identify"),
        Some(WolfReadinessLevel::Identify)
    );
    assert_eq!(
        report.level("wolf.readiness.inventory"),
        Some(WolfReadinessLevel::Inventory)
    );
    assert_eq!(
        report.level("wolf.readiness.helper-required"),
        Some(WolfReadinessLevel::HelperRequired)
    );
    assert_eq!(
        report.level("wolf.readiness.extract"),
        Some(WolfReadinessLevel::Extract)
    );
    assert_eq!(
        report.level("wolf.readiness.patch"),
        Some(WolfReadinessLevel::Patch)
    );
}

#[test]
fn each_case_combines_detector_and_helper_boundary_evidence() {
    let report = run();
    // A plain inventory case carries detector evidence, no helper boundary.
    let inventory = report.entry("wolf.readiness.inventory").unwrap();
    assert_eq!(inventory.protection_profile, WolfProtectionProfile::Plain);
    assert!(inventory.helper_outcome.is_none());
    assert!(inventory.helper_boundary.is_none());

    // A helper-required case carries BOTH the detector profile AND the
    // helper-boundary outcome.
    let helper = report.entry("wolf.readiness.helper-required").unwrap();
    assert!(matches!(
        helper.protection_profile,
        WolfProtectionProfile::Protected | WolfProtectionProfile::HelperRequired
    ));
    assert!(helper.helper_outcome.is_some());
    assert!(helper.helper_boundary.is_some());
    assert!(!helper.secret_requirement_ids.is_empty());

    // The extract case cleared the key gate (key resolved) AND carries a
    // synthetic extract proof.
    let extract = report.entry("wolf.readiness.extract").unwrap();
    assert_eq!(
        extract.helper_outcome,
        Some(WolfHelperBoundaryOutcome::KeyResolved)
    );
    assert!(!extract.proof_hashes.is_empty());
}

// --- Honesty: extract/patch are NEVER claimed without an explicit proof. --

#[test]
fn extract_and_patch_require_an_explicit_fixture_proof() {
    // Same key-resolved evidence, but no extract proof → capped at
    // helper_required (the cleared gate proves no extraction).
    let no_proof = WolfReadinessEvidence {
        protection_profile: WolfProtectionProfile::Protected,
        helper_outcome: Some(WolfHelperBoundaryOutcome::KeyResolved),
        extract_proven: false,
        patch_proven: false,
    };
    assert_eq!(
        derive_wolf_readiness_level(&no_proof),
        WolfReadinessLevel::HelperRequired
    );

    // With the extract proof honored → extract.
    let extract = WolfReadinessEvidence {
        extract_proven: true,
        ..no_proof
    };
    assert_eq!(
        derive_wolf_readiness_level(&extract),
        WolfReadinessLevel::Extract
    );

    // With both → patch.
    let patch = WolfReadinessEvidence {
        extract_proven: true,
        patch_proven: true,
        ..no_proof
    };
    assert_eq!(
        derive_wolf_readiness_level(&patch),
        WolfReadinessLevel::Patch
    );
}

#[test]
fn unknown_profile_is_never_lifted_by_a_proof() {
    for (extract_proven, patch_proven) in [(false, false), (true, false), (true, true)] {
        let evidence = WolfReadinessEvidence {
            protection_profile: WolfProtectionProfile::Unknown,
            helper_outcome: None,
            extract_proven,
            patch_proven,
        };
        assert_eq!(
            derive_wolf_readiness_level(&evidence),
            WolfReadinessLevel::Unsupported
        );
    }
}

#[test]
fn closed_gate_refuses_extraction_even_with_a_proof() {
    for outcome in [
        WolfHelperBoundaryOutcome::KeyMissing,
        WolfHelperBoundaryOutcome::HelperRequired,
        WolfHelperBoundaryOutcome::HelperUnavailable,
    ] {
        let evidence = WolfReadinessEvidence {
            protection_profile: WolfProtectionProfile::Protected,
            helper_outcome: Some(outcome),
            extract_proven: true,
            patch_proven: true,
        };
        assert_eq!(
            derive_wolf_readiness_level(&evidence),
            WolfReadinessLevel::HelperRequired,
            "outcome {outcome:?} must not reach extract",
        );
    }
}

#[test]
fn fabricated_extract_proof_is_refused() {
    let mut fixture = load();
    let case = fixture
        .cases
        .iter_mut()
        .find(|c| c.fixture_id == "wolf.readiness.extract")
        .unwrap();
    // Corrupt the extract proof hash: a fabricated proof must not be honored.
    case.extract_proof.as_mut().unwrap().proof_hash =
        ProofHash::new(format!("sha256:{}", "a".repeat(64))).unwrap();
    let report = run_wolf_readiness(&fixture);
    let entry = report.entry("wolf.readiness.extract").unwrap();
    assert_eq!(entry.status, OperationStatus::Failed);
    assert!(
        entry
            .findings
            .iter()
            .any(|f| f.code == "wolf.readiness.artifact_proof_invalid")
    );
    // And the DERIVED level fell back below extract (the fabricated proof
    // was refused, so the cleared gate proves only helper_required).
    assert_eq!(entry.readiness_level, WolfReadinessLevel::HelperRequired);
}

#[test]
fn readiness_patch_hash_equals_the_smoke_bound_value() {
    // The fixture's honored patch proof hash is exactly the SMOKE-BOUND
    // canonical value from a genuinely-run round-trip — not a
    let fixture = load();
    let smoke = crate::wolf_extract_patch_verify_smoke::run_wolf_extract_patch_verify_smoke(
        &fixture.source_node_id,
    )
    .expect("smoke runs");
    let canonical_patch = canonical_wolf_readiness_artifact_hash_from_smoke(
        &smoke,
        WolfReadinessArtifactKind::SyntheticPatchFixture,
    )
    .expect("smoke yields a patch proof");
    let patch_case = fixture
        .cases
        .iter()
        .find(|c| c.fixture_id == "wolf.readiness.patch")
        .unwrap();
    assert_eq!(
        patch_case.patch_proof.as_ref().unwrap().proof_hash,
        canonical_patch,
        "the fixture patch proof must equal the smoke-bound value",
    );
    // And with that binding, the case genuinely reaches `patch`.
    let report = run_wolf_readiness(&fixture);
    assert_eq!(
        report.level("wolf.readiness.patch"),
        Some(WolfReadinessLevel::Patch)
    );
}

#[test]
fn a_label_only_patch_proof_does_not_reach_patch_proven() {
    // Reproduce the OLD label hash (sha256 over a static label).
    // Because it is NOT the smoke-bound value, the patch rung is refused —
    // a fixture without a passing smoke behind it cannot reach patch-proven.
    let label_hash = ProofHash::new(crate::sha256_hash_bytes(
        b"wolf-readiness-artifact/synthetic_patch_fixture/wolf.synthetic.patch",
    ))
    .unwrap();
    let mut fixture = load();
    let case = fixture
        .cases
        .iter_mut()
        .find(|c| c.fixture_id == "wolf.readiness.patch")
        .unwrap();
    case.patch_proof.as_mut().unwrap().proof_hash = label_hash;
    let report = run_wolf_readiness(&fixture);
    let entry = report.entry("wolf.readiness.patch").unwrap();
    assert_eq!(entry.status, OperationStatus::Failed);
    assert!(
        entry
            .findings
            .iter()
            .any(|f| f.code == "wolf.readiness.artifact_proof_invalid"),
        "label-only proof must raise the invalid-proof finding: {:?}",
        entry.findings
    );
    // The DERIVED level fell BELOW patch: the label-only proof was refused,
    // so the case does NOT reach patch-proven.
    assert_ne!(entry.readiness_level, WolfReadinessLevel::Patch);
    assert!(entry.readiness_level < WolfReadinessLevel::Patch);
}

#[test]
fn declared_level_mismatch_is_a_finding() {
    let mut fixture = load();
    let case = fixture
        .cases
        .iter_mut()
        .find(|c| c.fixture_id == "wolf.readiness.inventory")
        .unwrap();
    case.expected_level = WolfReadinessLevel::Patch;
    let report = run_wolf_readiness(&fixture);
    assert_eq!(report.status, OperationStatus::Failed);
    let entry = report.entry("wolf.readiness.inventory").unwrap();
    assert!(
        entry
            .findings
            .iter()
            .any(|f| f.code == "wolf.readiness.level_mismatch")
    );
    // The DERIVED level still refuses the lie.
    assert_eq!(entry.readiness_level, WolfReadinessLevel::Inventory);
}

#[test]
fn report_is_redaction_clean() {
    let report = run();
    let json = report.stable_json().expect("stable json");
    // Ref-only: local-scheme secret refs + sha256 proof hashes survive.
    assert!(json.contains("local-secret:"));
    assert!(json.contains("sha256:"));
    // No raw key material, no private paths, no PEM blocks, no retail bytes.
    assert!(!json.contains("BEGIN"));
    assert!(!json.contains("/home/"));
    assert!(!json.contains("deadbeef"));
}

#[test]
fn report_redacts_local_paths_and_never_carries_raw_key_material() {
    let mut fixture = load();
    fixture.readiness_set_id = "/home/trevor/private/wolf/leak.wolf".to_string();
    let report = run_wolf_readiness(&fixture);
    let json = report.stable_json().expect("stable json");
    assert!(json.contains("[REDACTED:"));
    assert!(!json.contains("/home/trevor/private/wolf/leak.wolf"));
    assert!(!json.contains("BEGIN"));
}

#[test]
fn report_round_trips_through_json() {
    let report = run();
    let json = serde_json::to_string(&report.redacted_for_report()).expect("serialize");
    let round: WolfReadinessReport = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(round, report.redacted_for_report());
}

#[test]
fn level_ordering_places_unsupported_at_the_floor() {
    assert!(WolfReadinessLevel::Unsupported < WolfReadinessLevel::Identify);
    assert!(WolfReadinessLevel::Identify < WolfReadinessLevel::Inventory);
    assert!(WolfReadinessLevel::Inventory < WolfReadinessLevel::HelperRequired);
    assert!(WolfReadinessLevel::HelperRequired < WolfReadinessLevel::Extract);
    assert!(WolfReadinessLevel::Extract < WolfReadinessLevel::Patch);
}
