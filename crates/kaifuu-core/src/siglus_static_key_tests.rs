use super::*;

use std::path::PathBuf;

use crate::{KeyValidationMethod, read_json, sha256_hash_bytes};
use zeroize::Zeroizing;

fn manifest_dir() -> PathBuf {
    crate::test_manifest_dir()
        .join("../..")
        .join("fixtures/kaifuu/siglus")
}

fn load_fixture() -> SiglusStaticKeyFixture {
    read_json(&manifest_dir().join("siglus-static-key.json"))
        .expect("static-key manifest must parse")
}

fn discover(fixture: &SiglusStaticKeyFixture) -> SiglusStaticKeyReport {
    discover_siglus_static_key(SiglusStaticKeyRequest {
        fixture,
        fixture_dir: &manifest_dir(),
        fixture_file_name: "siglus-static-key.json",
    })
    .expect("discovery must not error environmentally")
}

fn entry_mut<'a>(
    fixture: &'a mut SiglusStaticKeyFixture,
    entry_id: &str,
) -> &'a mut SiglusStaticKeyFixtureEntry {
    fixture
        .entries
        .iter_mut()
        .find(|entry| entry.entry_id == entry_id)
        .expect("entry must exist")
}

fn has_finding(report: &SiglusStaticKeyReport, entry_id: &str, code: &str) -> bool {
    report
        .entry(entry_id)
        .is_some_and(|entry| entry.findings.iter().any(|finding| finding.code == code))
}

#[test]
fn static_key_manifest_passes_and_records_capability() {
    let report = discover(&load_fixture());
    assert_eq!(
        report.status,
        OperationStatus::Passed,
        "{:?}",
        report.entries
    );

    // The capability entry records helper facts and validation activity.
    assert!(!report.capability.shells_out);
    assert!(report.capability.validate_before_consume);
    assert_eq!(report.capability.helper_kind, HelperKind::StaticParser);
    assert_eq!(
        report.capability.execution_mode,
        HelperResultExecutionMode::InProcess
    );
    assert!(!report.capability.network_access);

    for entry in &report.entries {
        assert_eq!(entry.status, OperationStatus::Passed, "{entry:?}");
        assert!(
            entry
                .validation_command
                .starts_with("kaifuu siglus static-key --fixture")
        );
        assert_eq!(entry.redaction_status, "redacted");
    }
}

#[test]
fn capability_reflects_whether_the_validation_path_ran() {
    let validated_report = discover(&load_fixture());
    assert!(validated_report.capability.validate_before_consume);

    let mut pre_validation_failure = load_fixture();
    pre_validation_failure
        .entries
        .retain(|entry| entry.stub == Some(SiglusStaticKeyStubScenario::UnsupportedPacker));
    let skipped_report = discover(&pre_validation_failure);

    assert_eq!(skipped_report.status, OperationStatus::Passed);
    assert!(!skipped_report.capability.validate_before_consume);
}

#[test]
fn only_validated_entry_publishes_a_consumable_key_ref() {
    let report = discover(&load_fixture());

    let valid = report.entry("static-key-valid").unwrap();
    assert_eq!(valid.outcome, SiglusStaticKeyOutcome::Validated);
    assert!(valid.validated);
    let key_ref = valid
        .consumable_key_ref()
        .expect("validated entry is consumable");
    assert_eq!(
        key_ref.validation.method,
        KeyValidationMethod::KnownPlaintextProof
    );
    // Proof hash is a sha256 over the PUBLIC known-plaintext, never the key.
    assert_eq!(
        key_ref.validation.proof_hash.as_str(),
        sha256_hash_bytes(GAMEEXE_KNOWN_PLAINTEXT)
    );

    // Every non-validated entry refuses consumption.
    for entry_id in [
        "static-key-wrong-key",
        "static-key-unsupported-packer",
        "static-key-protected-executable",
        "static-key-no-key-region",
        "static-key-helper-mismatch",
    ] {
        let entry = report.entry(entry_id).unwrap();
        assert_ne!(
            entry.outcome,
            SiglusStaticKeyOutcome::Validated,
            "{entry_id}"
        );
        assert!(!entry.validated, "{entry_id} must not be validated");
        assert!(
            entry.key_ref.is_none(),
            "{entry_id} must publish no key-ref"
        );
        assert!(
            entry.consumable_key_ref().is_none(),
            "{entry_id} must not be consumable"
        );
    }
}

#[test]
fn wrong_key_fails_validation_before_consume() {
    let report = discover(&load_fixture());
    let entry = report.entry("static-key-wrong-key").unwrap();
    assert_eq!(entry.outcome, SiglusStaticKeyOutcome::ValidationFailed);
    assert!(has_finding(
        &report,
        "static-key-wrong-key",
        FINDING_VALIDATION_FAILED
    ));
    assert!(entry.consumable_key_ref().is_none());
}

#[test]
fn unsupported_packer_is_structured() {
    let report = discover(&load_fixture());
    let entry = report.entry("static-key-unsupported-packer").unwrap();
    assert_eq!(entry.outcome, SiglusStaticKeyOutcome::UnsupportedPacker);
    let finding = entry
        .findings
        .iter()
        .find(|finding| finding.code == FINDING_UNSUPPORTED_PACKER)
        .expect("structured packer finding");
    assert_eq!(
        finding.semantic_code.as_deref(),
        Some(SEMANTIC_SIGLUS_STATIC_KEY_UNSUPPORTED_PACKER)
    );
}

#[test]
fn protected_executable_is_structured() {
    let report = discover(&load_fixture());
    let entry = report.entry("static-key-protected-executable").unwrap();
    assert_eq!(entry.outcome, SiglusStaticKeyOutcome::ProtectedExecutable);
    assert!(has_finding(
        &report,
        "static-key-protected-executable",
        FINDING_PROTECTED_EXECUTABLE
    ));
}

#[test]
fn helper_provenance_mismatch_is_structured_and_short_circuits() {
    let report = discover(&load_fixture());
    let entry = report.entry("static-key-helper-mismatch").unwrap();
    assert_eq!(entry.outcome, SiglusStaticKeyOutcome::HelperMismatch);
    assert!(has_finding(
        &report,
        "static-key-helper-mismatch",
        FINDING_HELPER_MISMATCH
    ));
}

#[test]
fn missing_key_region_is_structured() {
    let report = discover(&load_fixture());
    let entry = report.entry("static-key-no-key-region").unwrap();
    assert_eq!(entry.outcome, SiglusStaticKeyOutcome::KeyRegionNotFound);
    assert!(has_finding(
        &report,
        "static-key-no-key-region",
        FINDING_KEY_REGION_NOT_FOUND
    ));
}

#[test]
fn validator_fails_on_outcome_mismatch() {
    let mut fixture = load_fixture();
    // Claim the wrong-key entry validates; evidence says otherwise.
    entry_mut(&mut fixture, "static-key-wrong-key").expected = SiglusStaticKeyOutcome::Validated;
    let report = discover(&fixture);
    assert_eq!(report.status, OperationStatus::Failed);
    assert!(has_finding(
        &report,
        "static-key-wrong-key",
        FINDING_OUTCOME_MISMATCH
    ));
}

#[test]
fn report_never_carries_raw_key_material() {
    use std::fmt::Write as _;
    let report = discover(&load_fixture());
    let json = report.stable_json().expect("stable json");

    // The synthetic key bytes (and their hex) must never appear.
    let key_text = String::from_utf8_lossy(STUB_KEY_CORRECT);
    assert!(!json.contains(key_text.as_ref()), "raw key leaked");
    let key_hex: String = STUB_KEY_CORRECT
        .iter()
        .fold(String::new(), |mut acc, byte| {
            let _ = write!(acc, "{byte:02x}");
            acc
        });
    assert!(!json.contains(&key_hex), "raw key hex leaked");

    // The key-ref carries a one-way commitment + count, not the key.
    let key_ref = report
        .entry("static-key-valid")
        .unwrap()
        .key_ref
        .as_ref()
        .unwrap();
    assert_eq!(key_ref.bytes as usize, STUB_KEY_CORRECT.len());
    assert_eq!(
        key_ref.material_hash.as_str(),
        sha256_hash_bytes(STUB_KEY_CORRECT)
    );
    // The commitment is a hash, not the key.
    assert!(!key_ref.material_hash.as_str().contains(key_text.as_ref()));
}

#[test]
fn candidate_debug_is_redacted_and_zeroized() {
    let candidate = StaticKeyCandidate {
        bytes: Zeroizing::new(STUB_KEY_CORRECT.to_vec()),
    };
    let rendered = format!("{candidate:?}");
    assert!(rendered.contains("REDACTED"));
    assert!(!rendered.contains(&String::from_utf8_lossy(STUB_KEY_CORRECT).into_owned()));
}

// (Compile-time guarantee: `analyze_siglus_executable`,
// `validate_candidate_against_gameexe`, and `StaticKeyCandidate` are not
// `pub`, so pure Siglus parsing / patching cannot reach the helper. These
// tests merely exercise the in-module gate.)

#[test]
fn analysis_recovers_then_validation_gates_the_candidate() {
    let valid = build_siglus_static_key_stub(SiglusStaticKeyStubScenario::Valid);
    let candidate =
        analyze_siglus_executable(&valid.executable).expect("valid stub yields a candidate");
    assert!(
        validate_candidate_against_gameexe(&candidate, &valid.gameexe)
            .unwrap()
            .is_some()
    );

    let wrong = build_siglus_static_key_stub(SiglusStaticKeyStubScenario::WrongKey);
    let wrong_candidate =
        analyze_siglus_executable(&wrong.executable).expect("wrong stub still yields bytes");
    assert!(
        validate_candidate_against_gameexe(&wrong_candidate, &wrong.gameexe)
            .unwrap()
            .is_none(),
        "wrong key must not validate"
    );

    let packer = build_siglus_static_key_stub(SiglusStaticKeyStubScenario::UnsupportedPacker);
    assert_eq!(
        analyze_siglus_executable(&packer.executable).err(),
        Some(StaticAnalysisError::UnsupportedPacker)
    );
    let protected = build_siglus_static_key_stub(SiglusStaticKeyStubScenario::ProtectedExecutable);
    assert_eq!(
        analyze_siglus_executable(&protected.executable).err(),
        Some(StaticAnalysisError::ProtectedExecutable)
    );
    let keyless = build_siglus_static_key_stub(SiglusStaticKeyStubScenario::KeyRegionMissing);
    assert_eq!(
        analyze_siglus_executable(&keyless.executable).err(),
        Some(StaticAnalysisError::KeyRegionNotFound)
    );
}
