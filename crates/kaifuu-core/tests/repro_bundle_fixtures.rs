//! the committed clean reproduction-bundle fixture loads from
//! disk, matches the in-code fixture, and validates green: no private assets,
//! self-sufficient for public reproduction, every embedded tuple honest.
//! Only the CLEAN redacted bundle is committed (no raw private assets on disk);
//! the per-private-asset-class REJECTION cases are exercised in the crate's own
//! `repro_bundle` unit tests, which construct dirty bundles in-code from
//! synthetic markers.

use std::path::{Path, PathBuf};

use kaifuu_core::OperationStatus;
use kaifuu_core::repro_bundle::{PrivateAssetClass, ReproBundle, fixtures, validate_repro_bundle};

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("fixtures/kaifuu/repro-bundle")
}

fn load(name: &str) -> ReproBundle {
    kaifuu_core::read_json(&fixtures_dir().join(name)).expect("fixture parses against the schema")
}

#[test]
fn committed_clean_bundle_matches_the_in_code_fixture() {
    let on_disk = load("clean.bundle.json");
    assert_eq!(on_disk, fixtures::clean_bundle());
}

#[test]
fn committed_clean_bundle_validates_green() {
    let report = validate_repro_bundle(&load("clean.bundle.json"));
    assert_eq!(report.status, OperationStatus::Passed, "{report:#?}");
    assert!(report.is_clean());
    assert!(report.self_sufficient);
    assert!(report.violations.is_empty());
    assert!(report.gaps.is_empty());
    assert_eq!(report.tuple_report.status, OperationStatus::Passed);
}

#[test]
fn committed_clean_bundle_carries_no_private_assets() {
    let report = validate_repro_bundle(&load("clean.bundle.json"));
    for class in PrivateAssetClass::all() {
        assert!(
            report.violations_of(class).is_empty(),
            "clean fixture must carry no {} asset",
            class.as_str()
        );
    }
    // The redacted report is ref-only: proof-hash refs + local-secret refs, no
    // raw key material.
    let json = report.stable_json().expect("serialize");
    assert!(json.contains("sha256:"));
    assert!(json.contains("local-secret:"));
    assert!(!json.contains("BEGIN"));
}
