use super::*;
use std::path::PathBuf;

fn fixtures_dir() -> PathBuf {
    crate::test_manifest_dir()
        .join("../..")
        .join("fixtures/kaifuu/wolf")
}

fn load() -> WolfHelperBoundaryFixture {
    read_wolf_helper_boundary_fixture(&fixtures_dir().join("helper-boundary.profiles.json"))
        .expect("Wolf helper-boundary fixture must parse")
}

fn run() -> WolfHelperBoundaryReport {
    run_wolf_helper_boundary(&load())
}

#[test]
fn boundary_fixture_set_passes_and_records_every_field() {
    let fixture = load();
    let report = run_wolf_helper_boundary(&fixture);
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
            "profile {} failed: {:?}",
            entry.profile_id,
            entry.findings
        );
        assert_eq!(entry.engine_family, WOLF_ENGINE_FAMILY);
        assert_eq!(entry.source_node_id, fixture.source_node_id);
        // Acceptance: profile id + secret requirement ids + proof hashes +
        // diagnostics are all present on the local-only helper result.
        assert!(!entry.profile_id.is_empty());
        assert!(!entry.helper_result.profile_id.is_empty());
        assert!(!entry.secret_requirement_ids.is_empty());
        assert!(!entry.helper_result.diagnostic.message.is_empty());
        // The boundary never runs the helper.
        assert_eq!(entry.helper_result.execution.duration_ms, Some(0));
        assert!(!entry.helper_result.execution.network_access);
    }
}

#[test]
fn every_helper_result_conforms_to_kaifuu_085() {
    let report = run();
    for entry in &report.entries {
        let value = serde_json::to_value(&entry.helper_result).unwrap();
        assert_eq!(
            validate_helper_result_value(&value).status,
            OperationStatus::Passed,
            "profile {} helper result failed helper-result schema validation",
            entry.profile_id
        );
        // And the strongly-typed self-validation agrees.
        assert_eq!(
            entry.helper_result.validate().status,
            OperationStatus::Passed
        );
    }
}

#[test]
fn the_four_outcomes_are_distinct_and_carry_the_right_shape() {
    let report = run();
    let resolved = report.entry("wolf.static-key.resolved").unwrap();
    let missing = report.entry("wolf.static-key.missing").unwrap();
    let helper = report.entry("wolf.dynamic-key.helper-required").unwrap();
    let unavailable = report.entry("wolf.dynamic-key.helper-unavailable").unwrap();

    assert_eq!(resolved.outcome, WolfHelperBoundaryOutcome::KeyResolved);
    assert_eq!(missing.outcome, WolfHelperBoundaryOutcome::KeyMissing);
    assert_eq!(helper.outcome, WolfHelperBoundaryOutcome::HelperRequired);
    assert_eq!(
        unavailable.outcome,
        WolfHelperBoundaryOutcome::HelperUnavailable
    );

    // Protected static-key boundary maps to the local key-import path.
    assert_eq!(
        resolved.protection_profile,
        WolfProtectionProfile::Protected
    );
    assert_eq!(
        resolved.helper_result.helper.helper_kind,
        HelperKind::KnownKeyDatabaseImport
    );
    assert_eq!(
        resolved.helper_result.capability_level,
        HelperCapabilityLevel::LocalKeyImport
    );
    assert_eq!(
        resolved.helper_result.diagnostic.code,
        HelperDiagnosticCode::Success
    );
    // A resolved key carries a validation proof hash; a missing one does not.
    assert!(!resolved.proof_hashes.is_empty());
    assert!(resolved.helper_result.secret_refs[0].validation.is_some());
    assert!(missing.proof_hashes.is_empty());
    assert!(missing.helper_result.secret_refs[0].validation.is_none());
    assert_eq!(
        missing.helper_result.diagnostic.code,
        HelperDiagnosticCode::MissingKey
    );

    // HelperRequired maps to the Wolf "Pro" dynamic-key local helper path.
    assert_eq!(
        helper.protection_profile,
        WolfProtectionProfile::HelperRequired
    );
    assert_eq!(
        helper.helper_result.helper.helper_kind,
        HelperKind::WineLocalWindowsHelper
    );
    assert_eq!(
        helper.helper_result.execution.mode,
        HelperResultExecutionMode::PlatformHelper
    );
    assert_eq!(
        helper.helper_result.diagnostic.code,
        HelperDiagnosticCode::HelperRequired
    );
    assert_eq!(
        unavailable.helper_result.diagnostic.code,
        HelperDiagnosticCode::HelperUnavailable
    );
}

#[test]
fn keys_are_refs_only_and_report_is_redaction_clean() {
    let report = run();
    let json = report.stable_json().expect("stable json");
    // Ref-only: local-scheme secret refs + sha256 proof hashes survive.
    assert!(json.contains("local-secret:"));
    assert!(json.contains("sha256:"));
    // No raw key material, no private paths, no PEM blocks, no retail bytes.
    assert!(!json.contains("BEGIN"));
    assert!(!json.contains("/home/"));
    assert!(!json.contains("deadbeef"));
    // Every secret ref is a local scheme naming a requirement id only.
    for entry in &report.entries {
        for secret in &entry.helper_result.secret_refs {
            assert_eq!(
                secret.secret_ref.scheme(),
                crate::SecretRefScheme::LocalSecret
            );
            assert!(!secret.requirement_id.is_empty());
            // The ref never carries decoded byte length / raw material.
            assert!(secret.bytes.is_none());
        }
    }
}

#[test]
fn report_redacts_local_paths_and_never_carries_raw_key_material() {
    let mut fixture = load();
    fixture.boundary_set_id = "/home/trevor/private/wolf/leak.wolf".to_string();
    let report = run_wolf_helper_boundary(&fixture);
    let json = report.stable_json().expect("stable json");
    assert!(json.contains("[REDACTED:"));
    assert!(!json.contains("/home/trevor/private/wolf/leak.wolf"));
    assert!(!json.contains("BEGIN"));
}

#[test]
fn classifier_is_total_over_kind_and_availability() {
    assert_eq!(
        derive_wolf_helper_boundary_outcome(WolfHelperBoundaryKind::StaticKeyLocalImport, true),
        WolfHelperBoundaryOutcome::KeyResolved
    );
    assert_eq!(
        derive_wolf_helper_boundary_outcome(WolfHelperBoundaryKind::StaticKeyLocalImport, false),
        WolfHelperBoundaryOutcome::KeyMissing
    );
    assert_eq!(
        derive_wolf_helper_boundary_outcome(WolfHelperBoundaryKind::DynamicKeyLocalHelper, true),
        WolfHelperBoundaryOutcome::HelperRequired
    );
    assert_eq!(
        derive_wolf_helper_boundary_outcome(WolfHelperBoundaryKind::DynamicKeyLocalHelper, false),
        WolfHelperBoundaryOutcome::HelperUnavailable
    );
}

#[test]
fn declared_outcome_mismatch_is_a_finding() {
    let mut fixture = load();
    let profile = fixture
        .profiles
        .iter_mut()
        .find(|p| p.fixture_id == "wolf.static-key.resolved")
        .unwrap();
    profile.expected_outcome = WolfHelperBoundaryOutcome::KeyMissing;
    let report = run_wolf_helper_boundary(&fixture);
    assert_eq!(report.status, OperationStatus::Failed);
    let entry = report.entry("wolf.static-key.resolved").unwrap();
    assert_eq!(entry.status, OperationStatus::Failed);
    assert!(
        entry
            .findings
            .iter()
            .any(|f| f.code == "wolf.helper_boundary.outcome_mismatch")
    );
    // The DERIVED outcome still refuses the lie.
    assert_eq!(entry.outcome, WolfHelperBoundaryOutcome::KeyResolved);
}

#[test]
fn report_round_trips_through_json() {
    let report = run();
    let json = serde_json::to_string(&report.redacted_for_report()).expect("serialize");
    let round: WolfHelperBoundaryReport = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(round, report.redacted_for_report());
}
