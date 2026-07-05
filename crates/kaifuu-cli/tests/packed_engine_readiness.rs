//! KAIFUU-103 — CLI command-contract smoke for the packed-engine readiness
//! profile validator.
//!
//! Spawns `kaifuu readiness validate` against the committed synthetic
//! profile-fixture tree and asserts the generated report is evidence-driven:
//! every profile records its id / fixture id / capability levels / helper id /
//! key ref / diagnostics / content hash, the seven outcomes (identify,
//! inventory, extract, patch, helper_required, missing_key,
//! unsupported_layered_transform) are mechanically distinguished, and the
//! positive tree is green. Pointing the command at the committed negative tree
//! fails with structured findings rather than a panic. No private corpora are
//! used; the report carries only counts and hashes.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

fn kaifuu_cli_binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_kaifuu-cli"))
}

/// Resolve this crate's manifest directory for locating tracked test fixtures.
///
/// `env!("CARGO_MANIFEST_DIR")` is baked at COMPILE time, so a test binary
/// reused from a different (since-removed) worktree would point fixture reads at
/// a dead path (`Os NotFound`). `cargo test` sets `CARGO_MANIFEST_DIR` in the
/// RUNTIME environment to the LIVE crate directory; prefer that, falling back to
/// the compile-time constant only outside cargo.
fn test_manifest_dir() -> PathBuf {
    std::env::var_os("CARGO_MANIFEST_DIR")
        .map_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")), PathBuf::from)
}

fn packed_dir() -> PathBuf {
    test_manifest_dir()
        .join("../..")
        .join("fixtures/kaifuu/packed-engine")
}

fn run(fixtures_dir: &Path, output: &Path) -> std::process::Output {
    Command::new(kaifuu_cli_binary())
        .arg("readiness")
        .arg("validate")
        .arg("--fixtures-dir")
        .arg(fixtures_dir)
        .arg("--output")
        .arg(output)
        .output()
        .expect("kaifuu-cli should run")
}

#[test]
fn positive_tree_validates_and_distinguishes_all_outcomes() {
    let work = tempfile::tempdir().unwrap();
    let report_path = work.path().join("packed-readiness-validation.json");

    let output = run(&packed_dir(), &report_path);
    assert!(
        output.status.success(),
        "expected success; stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );

    let report: Value = serde_json::from_slice(&fs::read(&report_path).unwrap()).unwrap();
    assert_eq!(report["status"], "passed");
    assert!(report["profileReadyCount"].as_u64().unwrap() > 0);
    assert!(report["readinessOnlyCount"].as_u64().unwrap() > 0);

    let entries = report["entries"].as_array().unwrap();
    // Every one of the seven outcomes is present.
    for outcome in [
        "identify",
        "inventory",
        "extract",
        "patch",
        "helper_required",
        "missing_key",
        "unsupported_layered_transform",
    ] {
        assert!(
            entries
                .iter()
                .any(|entry| entry["effectiveOutcome"] == outcome),
            "no entry produced outcome {outcome}"
        );
    }

    // Each entry carries the full acceptance tuple.
    for entry in entries {
        assert!(!entry["profileId"].as_str().unwrap().is_empty());
        assert!(!entry["fixtureId"].as_str().unwrap().is_empty());
        assert!(
            entry["contentHash"]
                .as_str()
                .unwrap()
                .starts_with("sha256:")
        );
        assert!(entry["declaredCapability"].is_string());
        assert!(entry["posture"].is_string());
        // profile-ready vs readiness-only is mechanically consistent.
        let ready = entry["posture"] == "profile_ready";
        let outcome = entry["effectiveOutcome"].as_str().unwrap();
        let outcome_ready = matches!(outcome, "identify" | "inventory" | "extract" | "patch");
        assert_eq!(ready, outcome_ready, "posture/outcome mismatch: {entry}");
    }
}

#[test]
fn negative_tree_fails_with_structured_findings_not_panic() {
    let work = tempfile::tempdir().unwrap();
    let report_path = work.path().join("report.json");

    let output = run(&packed_dir().join("negative"), &report_path);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!output.status.success(), "negative tree must fail");
    assert!(!stderr.contains("panicked"), "must not panic: {stderr}");
    assert!(
        stderr.contains("packed-engine readiness validation failed"),
        "stderr missing structured failure: {stderr}"
    );

    let report: Value = serde_json::from_slice(&fs::read(&report_path).unwrap()).unwrap();
    assert_eq!(report["status"], "failed");
    // Every negative profile is a Failed entry carrying at least one finding.
    for entry in report["entries"].as_array().unwrap() {
        assert_eq!(entry["status"], "failed", "{entry}");
        assert!(
            !entry["findings"].as_array().unwrap().is_empty(),
            "negative entry without findings: {entry}"
        );
    }
}

#[test]
fn report_carries_no_raw_local_paths_or_key_material() {
    let work = tempfile::tempdir().unwrap();
    let report_path = work.path().join("report.json");
    run(&packed_dir(), &report_path);
    let raw = fs::read_to_string(&report_path).unwrap();
    // Key references use the local-secret scheme (refs, never raw key bytes).
    assert!(raw.contains("local-secret:"));
    assert!(!raw.contains("/home/"));
}
