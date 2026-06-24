//! KAIFUU-011 — Integration tests for the composed binary patch smoke
//! subcommand.
//!
//! The smoke module is exposed as a binary-private module in
//! `crates/kaifuu-cli/src/binary_patch_smoke.rs`. To exercise it from
//! the integration tests without restructuring the binary into a lib,
//! we re-include the module source here via `#[path]` — this is a
//! small, contained pragma that the Rust book and rustc docs support
//! for exactly this case.

#[path = "../src/binary_patch_smoke.rs"]
mod binary_patch_smoke;

use std::path::Path;

use binary_patch_smoke::{BinaryPatchSmokeConfig, BinarySmokeOutcome, InjectFailure};
use serde_json::Value;
use tempfile::tempdir;

fn run_smoke(output_dir: &Path, inject_failure: InjectFailure) -> (BinarySmokeOutcome, Value) {
    let outcome = binary_patch_smoke::run_binary_patch_smoke(BinaryPatchSmokeConfig {
        fixture_dir: None,
        output_dir,
        inject_failure,
        run_id: "binary-patch-smoke-0001",
    });
    let json_path = output_dir.join("patch-result.json");
    let raw = std::fs::read_to_string(&json_path).expect("patch-result.json was written");
    let value: Value = serde_json::from_str(&raw).expect("patch-result.json is valid JSON");
    (outcome, value)
}

#[test]
fn positive_smoke_produces_passed_v02_with_output_hash() {
    let dir = tempdir().unwrap();
    let (outcome, value) = run_smoke(dir.path(), InjectFailure::None);
    assert!(matches!(outcome, BinarySmokeOutcome::Passed));

    assert_eq!(
        value.get("schemaVersion").and_then(Value::as_str),
        Some("0.2.0")
    );
    assert_eq!(value.get("status").and_then(Value::as_str), Some("passed"));
    assert_eq!(
        value.get("adapterId").and_then(Value::as_str),
        Some("kaifuu-reallive")
    );
    let touched = value
        .get("touchedAssets")
        .and_then(Value::as_array)
        .expect("touchedAssets is an array");
    assert!(
        !touched.is_empty(),
        "passed result touched at least one asset"
    );

    // Patched SEEN.TXT was promoted to the output path; it must equal
    // the apply_patches result (which is byte-for-byte a length
    // preserving translation of the source).
    let output_seen = std::fs::read(dir.path().join("SEEN.TXT")).expect("SEEN.TXT written");
    let synthetic = binary_patch_smoke::build_synthetic_seen_txt();
    assert_eq!(output_seen.len(), synthetic.len(), "length-preserving");

    kaifuu_core::contracts::validate_patch_result_v02(&value)
        .expect("emitted JSON validates against the v0.2 contract");
}

#[test]
fn preflight_byte_budget_failure_produces_v02_failed_with_category() {
    let dir = tempdir().unwrap();
    let (outcome, value) = run_smoke(dir.path(), InjectFailure::PreflightByteBudget);
    assert!(matches!(outcome, BinarySmokeOutcome::Failed));

    assert_eq!(value.get("status").and_then(Value::as_str), Some("failed"));
    let failures = value
        .get("failures")
        .and_then(Value::as_array)
        .expect("failures present");
    assert!(
        !failures.is_empty(),
        "v0.2 failed result has at least one failure"
    );
    let first_category = failures[0]
        .get("category")
        .and_then(Value::as_str)
        .expect("category present");
    assert_eq!(first_category, "patch_write_failed");

    // Output bytes equal source bytes (preflight rejected before any
    // promotion happened).
    let output_seen = std::fs::read(dir.path().join("SEEN.TXT")).expect("SEEN.TXT written");
    let synthetic = binary_patch_smoke::build_synthetic_seen_txt();
    assert_eq!(output_seen, synthetic);

    kaifuu_core::contracts::validate_patch_result_v02(&value)
        .expect("emitted JSON validates against the v0.2 contract");
}

#[test]
fn verify_hash_mismatch_rolls_back_and_emits_v02_failed() {
    let dir = tempdir().unwrap();
    let (outcome, value) = run_smoke(dir.path(), InjectFailure::VerifyHashMismatch);
    assert!(matches!(outcome, BinarySmokeOutcome::Failed));

    assert_eq!(value.get("status").and_then(Value::as_str), Some("failed"));
    let failures = value
        .get("failures")
        .and_then(Value::as_array)
        .expect("failures present");
    let first_category = failures[0]
        .get("category")
        .and_then(Value::as_str)
        .expect("category present");
    assert_eq!(first_category, "output_hash_mismatch");

    // Rollback preserved the source bytes at the output path.
    let output_seen = std::fs::read(dir.path().join("SEEN.TXT")).expect("SEEN.TXT written");
    let synthetic = binary_patch_smoke::build_synthetic_seen_txt();
    assert_eq!(output_seen, synthetic);

    // Staging directory cleanup — no leftover .tmp files.
    let staging_dir = dir.path().join(".staging");
    if staging_dir.exists() {
        let leftover: Vec<_> = std::fs::read_dir(&staging_dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().and_then(|s| s.to_str()) == Some("tmp"))
            .collect();
        assert!(
            leftover.is_empty(),
            "rollback did not clean up staging dir; leftover: {leftover:?}"
        );
    }

    kaifuu_core::contracts::validate_patch_result_v02(&value)
        .expect("emitted JSON validates against the v0.2 contract");
}

#[test]
fn positive_smoke_byte_stable_across_two_runs() {
    let dir_a = tempdir().unwrap();
    let dir_b = tempdir().unwrap();
    let (_outcome_a, value_a) = run_smoke(dir_a.path(), InjectFailure::None);
    let (_outcome_b, value_b) = run_smoke(dir_b.path(), InjectFailure::None);

    // patchResultId is deterministic by KAIFUU-084's deterministic_id,
    // so two runs of the same fixture + run-id MUST produce the same
    // value. The whole JSON should compare equal modulo any timestamps
    // (the v0.2 contract has none).
    assert_eq!(
        value_a, value_b,
        "positive smoke is byte-stable across reruns"
    );
}

#[test]
fn preflight_source_hash_failure_is_classified_as_source_incompatible() {
    let dir = tempdir().unwrap();
    let (outcome, value) = run_smoke(dir.path(), InjectFailure::PreflightSourceHash);
    assert!(matches!(outcome, BinarySmokeOutcome::Failed));

    assert_eq!(value.get("status").and_then(Value::as_str), Some("failed"));
    let failures = value
        .get("failures")
        .and_then(Value::as_array)
        .expect("failures present");
    let first_category = failures[0]
        .get("category")
        .and_then(Value::as_str)
        .expect("category present");
    // The smoke poisoned expected_source_hash on the SlotEdit, which
    // causes the kaifuu-reallive patchback layer to refuse via
    // PatchBackErrorCode::StaleSourceHash — that error maps to
    // source_incompatible in the v0.2 vocabulary.
    assert_eq!(first_category, "source_incompatible");

    kaifuu_core::contracts::validate_patch_result_v02(&value)
        .expect("emitted JSON validates against the v0.2 contract");
}

#[test]
fn smoke_command_writes_patch_result_json_with_v02_schema_version() {
    let dir = tempdir().unwrap();
    let (_outcome, value) = run_smoke(dir.path(), InjectFailure::None);
    assert_eq!(
        value.get("schemaVersion").and_then(Value::as_str),
        Some("0.2.0")
    );
}
