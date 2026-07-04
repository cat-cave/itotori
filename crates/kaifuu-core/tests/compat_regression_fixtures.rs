//! KAIFUU-107 — the committed regression fixtures (the KAIFUU-051 public-fixture
//! catalogue + the recorded diagnostic baseline) load from disk, match the
//! in-code fixtures, and drive a green regression run against the KAIFUU-106
//! clean reproduction bundle.
//!
//! The recorded baseline is a COMMITTED artifact: a fresh run must reproduce its
//! fingerprints. Regenerating it is a deliberate act (the crate's ignored
//! `emit_committed_fixtures` helper), never a silent side effect of the runner.

use std::path::{Path, PathBuf};

use kaifuu_core::OperationStatus;
use kaifuu_core::compat_regression::{
    ClaimedProfileRegressionReport, PublicFixtureCatalogue, RegressionBaseline,
    RegressionFindingKind, fixtures, run_claimed_profile_regression,
};
use kaifuu_core::repro_bundle::fixtures as bundle_fixtures;

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("fixtures/kaifuu/compat-regression")
}

fn load<T: serde::de::DeserializeOwned>(name: &str) -> T {
    kaifuu_core::read_json(&fixtures_dir().join(name)).expect("fixture parses against the schema")
}

#[test]
fn committed_fixtures_match_the_in_code_fixtures() {
    let catalogue: PublicFixtureCatalogue = load("public-fixture-catalogue.json");
    let baseline: RegressionBaseline = load("baseline.json");
    assert_eq!(catalogue, fixtures::public_catalogue());
    assert_eq!(baseline, fixtures::baseline());
}

#[test]
fn committed_fixtures_drive_a_green_regression_run() {
    let catalogue: PublicFixtureCatalogue = load("public-fixture-catalogue.json");
    let baseline: RegressionBaseline = load("baseline.json");
    let bundle = bundle_fixtures::clean_bundle();

    let report: ClaimedProfileRegressionReport =
        run_claimed_profile_regression(&bundle, &catalogue, &baseline);
    assert_eq!(report.status, OperationStatus::Passed, "{report:#?}");
    assert!(report.is_clean());
    assert_eq!(report.drift_count, 0);
    assert_eq!(report.passed_count, report.tuple_count);
    // No finding of any kind on the clean, correctly-baselined bundle.
    for kind in [
        RegressionFindingKind::MissingFixtureEvidence,
        RegressionFindingKind::MissingSecretRequirementMetadata,
        RegressionFindingKind::OverclaimTuple,
        RegressionFindingKind::DiagnosticDrift,
    ] {
        assert!(report.findings_of(kind).is_empty(), "unexpected {kind:?}");
    }
}

#[test]
fn committed_report_artifact_is_redacted() {
    let catalogue: PublicFixtureCatalogue = load("public-fixture-catalogue.json");
    let baseline: RegressionBaseline = load("baseline.json");
    let report =
        run_claimed_profile_regression(&bundle_fixtures::clean_bundle(), &catalogue, &baseline);
    let json = report.stable_json().expect("serialize");
    // Ref-only: proof-hash + local-secret refs, never raw material or paths.
    assert!(json.contains("sha256:"));
    assert!(!json.contains("BEGIN"));
    assert!(!json.contains("/home/"));
}
