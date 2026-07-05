//! KAIFUU-056 — CLI command-contract smoke for the alpha packed/encrypted-engine
//! readiness-PROFILE subset.
//!
//! Spawns `kaifuu readiness alpha-profile` against the committed synthetic seed
//! fixtures (Siglus / KiriKiri XP3 / Wolf / RGSS3 / BGI) and asserts: every
//! engine states identify / inventory / extract / patch / helper-key status;
//! BGI is detector/profile-only (no inventory / extract / patch, no patch-back);
//! the rendered summary carries only kinds and counts (no keys, no local paths);
//! and a profile missing a required field fails with a classified finding rather
//! than a panic. No private corpora are used.

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

fn seeds_dir() -> PathBuf {
    test_manifest_dir()
        .join("../..")
        .join("fixtures/kaifuu/alpha-readiness/seeds")
}

fn negative_dir() -> PathBuf {
    test_manifest_dir()
        .join("../..")
        .join("fixtures/kaifuu/alpha-readiness/negative")
}

fn run(fixtures_dir: &Path, report: &Path, summary: &Path) -> std::process::Output {
    Command::new(kaifuu_cli_binary())
        .arg("readiness")
        .arg("alpha-profile")
        .arg("--fixtures-dir")
        .arg(fixtures_dir)
        .arg("--output")
        .arg(report)
        .arg("--summary-output")
        .arg(summary)
        .output()
        .expect("kaifuu-cli should run")
}

#[test]
fn seed_subset_states_all_five_operations_and_bgi_is_detector_only() {
    let work = tempfile::tempdir().unwrap();
    let report_path = work.path().join("alpha-readiness-validation.json");
    let summary_path = work.path().join("alpha-readiness.summary.json");

    let output = run(&seeds_dir(), &report_path, &summary_path);
    assert!(
        output.status.success(),
        "expected success; stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );

    let summary: Value = serde_json::from_slice(&fs::read(&summary_path).unwrap()).unwrap();
    assert_eq!(summary["status"], "passed");
    assert_eq!(summary["engineCount"], 5);
    assert!(summary["detectorOnlyCount"].as_u64().unwrap() >= 1);

    let rows = summary["rows"].as_array().unwrap();
    // Every row states all five operations.
    for row in rows {
        let ops = &row["operations"];
        for op in ["identify", "inventory", "extract", "patch", "helperKey"] {
            assert!(ops[op].is_string(), "row missing {op}: {row}");
        }
    }
    // BGI is detector/profile-only: identify supported, no parser, no patch.
    let bgi = rows
        .iter()
        .find(|row| row["engineFamily"] == "bgi")
        .expect("bgi row");
    assert_eq!(bgi["detectorOnly"], true);
    assert_eq!(bgi["operations"]["identify"], "supported");
    assert_eq!(bgi["operations"]["inventory"], "unsupported");
    assert_eq!(bgi["operations"]["extract"], "unsupported");
    assert_eq!(bgi["operations"]["patch"], "unsupported");

    // The detailed report carries per-operation classified findings.
    let report: Value = serde_json::from_slice(&fs::read(&report_path).unwrap()).unwrap();
    assert_eq!(report["status"], "passed");
    assert_eq!(report["profileCount"], 5);
}

#[test]
fn summary_carries_no_keys_or_local_paths() {
    let work = tempfile::tempdir().unwrap();
    let report_path = work.path().join("report.json");
    let summary_path = work.path().join("summary.json");
    run(&seeds_dir(), &report_path, &summary_path);

    // The README-safe summary names only kinds/counts — never a key ref or path.
    let summary_raw = fs::read_to_string(&summary_path).unwrap();
    assert!(!summary_raw.contains("local-secret:"));
    assert!(!summary_raw.contains("/home/"));

    // The detailed report may echo the local-secret REF (allowed), but never a
    // raw local path.
    let report_raw = fs::read_to_string(&report_path).unwrap();
    assert!(!report_raw.contains("/home/"));
}

#[test]
fn missing_required_field_fails_without_panic() {
    let work = tempfile::tempdir().unwrap();
    let report_path = work.path().join("report.json");
    let summary_path = work.path().join("summary.json");

    let output = run(&negative_dir(), &report_path, &summary_path);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!output.status.success(), "negative tree must fail");
    assert!(!stderr.contains("panicked"), "must not panic: {stderr}");
    assert!(
        stderr.contains("alpha readiness-profile validation failed"),
        "stderr missing structured failure: {stderr}"
    );
}
