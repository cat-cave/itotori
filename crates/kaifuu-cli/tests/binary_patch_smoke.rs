//! KAIFUU-011 — Integration tests for the composed binary patch smoke
//! subcommand.
//!
//! The smoke module is exposed as a binary-private module in
//! `crates/kaifuu-cli/src/binary_patch_smoke.rs`. To exercise it from
//! the integration tests without restructuring the binary into a lib,
//! we re-include the module source here via `#[path]` — this is a
//! small, contained pragma that the Rust book and rustc docs support
//! for exactly this case.
//!
//! # KAIFUU FIX-1 / KAIFUU-211 status
//!
//! `binary_patch_smoke::build_synthetic_seen_txt` emits the
//! **post-KAIFUU-191** real opener-byte shape (8-byte `CommandElement`
//! headers, a Shift-JIS Textout dialogue run, a bracketed `select`
//! argument list, and a Meta prologue) wrapped in a real 0x1d0-byte scene
//! header + AVG32 LZSS compression frame. The smoke translates the
//! editable Textout Dialogue unit through the canonical
//! `bundle_driven::apply_translated_bundle` patchback (the legacy
//! slot-edit surface is deleted). The synthetic translation is chosen to
//! keep the archive byte-length-identical (so the composed KAIFUU-084
//! identity-relocation transaction promotes), but the dialogue bytes
//! change and the patched archive still re-parses as a one-scene envelope.
//!
//! # KAIFUU-187 — failure-injection gating
//!
//! These tests exercise the `InjectFailure` seam, which is compiled out of a
//! release `--no-default-features` build. The whole test file is therefore
//! gated behind the same `cfg(any(debug_assertions, feature =
//! "failure-injection"))` predicate: it compiles and runs under ordinary
//! `cargo test` (debug) or with `--features failure-injection`, and is an
//! empty test crate in a release `--no-default-features` build (so
//! `clippy --release --no-default-features --all-targets` sees no dangling
//! references to the gated-out enum/field).
#![cfg(any(debug_assertions, feature = "failure-injection"))]

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

    // Patched SEEN.TXT was promoted to the output path. The synthetic
    // translation keeps the archive byte-length-identical (so the identity
    // relocation invariant holds), but the dialogue bytes change, so the
    // output differs from the source while still re-parsing as a one-scene
    // archive.
    let output_seen = std::fs::read(dir.path().join("SEEN.TXT")).expect("SEEN.TXT written");
    let synthetic = binary_patch_smoke::build_synthetic_seen_txt();
    assert_eq!(output_seen.len(), synthetic.len(), "length-preserving");
    assert_ne!(
        output_seen, synthetic,
        "the dialogue bytes actually changed"
    );
    let reparsed =
        kaifuu_reallive::parse_archive(&output_seen).expect("patched SEEN.TXT re-parses");
    assert_eq!(
        reparsed.entries.len(),
        1,
        "patched archive keeps its one populated scene"
    );

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
    // The smoke pointed the unit's source provenance at an occurrence the
    // scene bytecode cannot resolve, so the bundle_driven patchback
    // refuses via PatchbackError::ProvenanceMismatch — that error maps to
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

#[test]
fn supplied_fixture_that_cannot_be_read_aborts_instead_of_silently_synthesizing() {
    // 012 regression: when `--fixture` is supplied but the fixture's
    // SEEN.TXT cannot be read, the smoke used to swallow the read error
    // and substitute the synthetic envelope — reporting a PASS against
    // synthetic bytes while the user believed the real fixture ran. It
    // must now abort with a typed error mentioning the bad path, and must
    // NOT write a patch-result.json (no false PASS).
    let out = tempdir().unwrap();
    let missing_fixture = out.path().join("nonexistent-fixture-dir");

    let outcome = binary_patch_smoke::run_binary_patch_smoke(BinaryPatchSmokeConfig {
        fixture_dir: Some(missing_fixture.as_path()),
        output_dir: out.path(),
        inject_failure: InjectFailure::None,
        run_id: "binary-patch-smoke-fixture-abort",
    });

    match outcome {
        BinarySmokeOutcome::Aborted(reason) => {
            assert!(
                reason.contains("SEEN.TXT"),
                "abort reason must name the unreadable fixture, got {reason:?}"
            );
        }
        other => panic!("expected Aborted on unreadable fixture, got {other:?}"),
    }
}

#[test]
fn inject_failure_parse_maps_every_cli_token_and_rejects_unknown() {
    // Covers the CLI `--inject-failure` token parser (used by main.rs's
    // dispatch arm). Exercised here so the integration-test compilation of
    // the module also uses it — no `#[allow(dead_code)]` masking needed.
    assert_eq!(InjectFailure::parse("none"), Ok(InjectFailure::None));
    assert_eq!(
        InjectFailure::parse("preflight-byte-budget"),
        Ok(InjectFailure::PreflightByteBudget)
    );
    assert_eq!(
        InjectFailure::parse("preflight-source-hash"),
        Ok(InjectFailure::PreflightSourceHash)
    );
    assert_eq!(
        InjectFailure::parse("verify-hash-mismatch"),
        Ok(InjectFailure::VerifyHashMismatch)
    );
    let err = InjectFailure::parse("bogus").expect_err("unknown token must error");
    assert!(
        err.contains("bogus"),
        "error names the bad token, got {err:?}"
    );
}

#[test]
fn write_smoke_summary_emits_status_line_per_outcome() {
    // Covers the stdout-summary writer (used by main.rs). Exercised here so
    // the module's integration-test compilation also uses it.
    let mut passed = Vec::new();
    binary_patch_smoke::write_smoke_summary(&mut passed, &BinarySmokeOutcome::Passed);
    assert_eq!(
        String::from_utf8(passed).unwrap(),
        "binary-patch-smoke status=passed exit=0\n"
    );

    let mut failed = Vec::new();
    binary_patch_smoke::write_smoke_summary(&mut failed, &BinarySmokeOutcome::Failed);
    assert_eq!(
        String::from_utf8(failed).unwrap(),
        "binary-patch-smoke status=failed exit=1\n"
    );

    let mut aborted = Vec::new();
    binary_patch_smoke::write_smoke_summary(
        &mut aborted,
        &BinarySmokeOutcome::Aborted("boom".to_string()),
    );
    assert_eq!(
        String::from_utf8(aborted).unwrap(),
        "binary-patch-smoke aborted: boom\n"
    );
}
