//! integration smoke for the private-local XP3 helper + patch
//! summary renderer.
//! Proves the renderer composes the committed synthetic helper-result aggregate,
//! support-tuple summary, and a real XP3 patch-back summary into ONE
//! redacted validation summary that:
//! - is byte-identical to the committed public-safe summary fixture (reproducible
//!   from SYNTHETIC inputs only — no private-local assets),
//! - reproduces identically whether the inputs come from the committed JSON
//!   fixtures or the in-code synthetic builders, and
//! - remains valid + Passed when the private-local patch rows are omitted.

use std::path::PathBuf;

use kaifuu_core::OperationStatus;
use kaifuu_kirikiri::run_xp3_patch_smoke_from_paths;
use kaifuu_kirikiri::xp3_private_local_summary::{
    Xp3HelperResultAggregate, Xp3PrivateLocalSummaryInput, Xp3SupportTupleSummaryFixture, synthetic,
};

fn kirikiri_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("fixtures/kaifuu/kirikiri")
}

fn private_local_dir() -> PathBuf {
    kirikiri_dir().join("xp3-private-local")
}

fn load_aggregate() -> Xp3HelperResultAggregate {
    let text = std::fs::read_to_string(private_local_dir().join("helper-result-aggregate.json"))
        .expect("helper-result aggregate fixture is present");
    serde_json::from_str(&text).expect("helper-result aggregate fixture deserializes")
}

fn load_support_tuples() -> Xp3SupportTupleSummaryFixture {
    let text = std::fs::read_to_string(private_local_dir().join("support-tuple-summary.json"))
        .expect("support-tuple summary fixture is present");
    serde_json::from_str(&text).expect("support-tuple summary fixture deserializes")
}

fn synthetic_patch_report() -> kaifuu_kirikiri::Xp3PatchReport {
    let dir = kirikiri_dir();
    run_xp3_patch_smoke_from_paths(
        &dir.join("xp3-patch.json"),
        &dir.join("xp3-patch-manifest.json"),
    )
    .expect("KAIFUU-101 XP3 patch-back smoke runs from the committed fixture")
}

/// The composed summary is byte-identical to the committed public-safe fixture,
/// reproduced entirely from synthetic inputs (no private-local assets).
#[test]
fn public_summary_reproduces_from_synthetic_inputs() {
    let aggregate = load_aggregate();
    let tuples = load_support_tuples();
    let patch = synthetic_patch_report();

    let summary = kaifuu_kirikiri::render_xp3_private_local_summary(Xp3PrivateLocalSummaryInput {
        summary_id: "kaifuu/k102/xp3-private-local-summary",
        helper_results: &aggregate.helper_results,
        support_tuples: &tuples.support_tuples,
        patch_reports: std::slice::from_ref(&patch),
    })
    .expect("renders from committed synthetic fixtures");

    assert_eq!(summary.status, OperationStatus::Passed);
    assert_eq!(summary.helper_result_count, 2);
    assert_eq!(summary.support_tuple_count, 2);
    assert_eq!(summary.patch_summary_count, 1);

    let committed = std::fs::read_to_string(private_local_dir().join("public-summary.json"))
        .expect("committed public-summary fixture is present");
    // `stable_json` has no trailing newline; the committed file adds one.
    assert_eq!(
        format!("{}\n", summary.stable_json().expect("stable json")),
        committed,
        "public summary must reproduce the committed fixture byte-for-byte"
    );
}

/// The committed JSON fixtures and the in-code synthetic builders render the
/// same summary — the fixtures are pure serializations of the builders.
#[test]
fn json_fixtures_match_synthetic_builders() {
    let from_json_helpers = load_aggregate().helper_results;
    let from_json_tuples = load_support_tuples().support_tuples;
    let builder_helpers = synthetic::helper_result_aggregate().helper_results;
    let builder_tuples = synthetic::support_tuple_summary().support_tuples;
    assert_eq!(from_json_helpers, builder_helpers);
    assert_eq!(from_json_tuples, builder_tuples);
}

/// Private-local patch rows can be omitted without affecting the render: the
/// summary is still valid, Passed, and carries the helper + support rows.
#[test]
fn private_local_rows_are_omittable() {
    let aggregate = load_aggregate();
    let tuples = load_support_tuples();

    let summary = kaifuu_kirikiri::render_xp3_private_local_summary(Xp3PrivateLocalSummaryInput {
        summary_id: "kaifuu/k102/xp3-private-local-no-patch",
        helper_results: &aggregate.helper_results,
        support_tuples: &tuples.support_tuples,
        patch_reports: &[],
    })
    .expect("renders with the patch rows omitted");

    assert_eq!(summary.status, OperationStatus::Passed);
    assert_eq!(summary.patch_summary_count, 0);
    assert_eq!(summary.helper_result_count, 2);
    assert_eq!(summary.support_tuple_count, 2);
    assert!(summary.redaction_summary.deep_scan_performed);

    // The fully-empty case is also valid + deterministic (no private-local
    // aggregate is ever a public-CI dependency).
    let empty = kaifuu_kirikiri::render_xp3_private_local_summary(Xp3PrivateLocalSummaryInput {
        summary_id: "kaifuu/k102/xp3-private-local-empty",
        helper_results: &[],
        support_tuples: &[],
        patch_reports: &[],
    })
    .expect("empty render is valid");
    assert_eq!(empty.status, OperationStatus::Passed);
    assert_eq!(empty.helper_result_count, 0);
}
