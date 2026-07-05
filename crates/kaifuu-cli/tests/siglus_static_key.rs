//! KAIFUU-069 — CLI command-contract smoke for the Siglus static-key helper
//! adapter.
//!
//! Spawns `kaifuu siglus static-key` against the committed synthetic manifest
//! and asserts the in-process discovery is evidence-driven: only the validated
//! entry publishes a consumable secret-ref + proof hash, every failure class
//! (unsupported packer, protected executable, helper mismatch, missing key
//! region, validation failure) is a structured finding, and an entry that
//! declares an outcome the evidence disagrees with fails with a structured
//! finding rather than a panic. No retail bytes are used; the report carries
//! only secret-refs and proof hashes — never raw key material.

use std::fs;
use std::path::PathBuf;
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

fn siglus_dir() -> PathBuf {
    test_manifest_dir()
        .join("../..")
        .join("fixtures/kaifuu/siglus")
}

fn manifest() -> PathBuf {
    siglus_dir().join("siglus-static-key.json")
}

fn entry<'a>(report: &'a Value, entry_id: &str) -> &'a Value {
    report["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["entryId"] == entry_id)
        .unwrap_or_else(|| panic!("entry {entry_id} missing"))
}

#[test]
fn static_key_discovery_is_evidence_driven_and_passes() {
    let work = tempfile::tempdir().unwrap();
    let report_path = work.path().join("report.json");

    let output = Command::new(kaifuu_cli_binary())
        .arg("siglus")
        .arg("static-key")
        .arg("--fixture")
        .arg(manifest())
        .arg("--output")
        .arg(&report_path)
        .output()
        .expect("kaifuu-cli should run");

    assert!(
        output.status.success(),
        "expected success; stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );

    let report: Value = serde_json::from_slice(&fs::read(&report_path).unwrap()).unwrap();
    assert_eq!(report["status"], "passed");
    assert_eq!(report["sourceNodeId"], "KAIFUU-069");

    // The capability entry records the in-process / no-shell-out facts.
    assert_eq!(report["capability"]["shellsOut"], false);
    assert_eq!(report["capability"]["validateBeforeConsume"], true);
    assert_eq!(report["capability"]["executionMode"], "inProcess");
    assert_eq!(report["capability"]["helperKind"], "staticParser");

    // Only the validated entry publishes a consumable key-ref.
    let valid = entry(&report, "static-key-valid");
    assert_eq!(valid["outcome"], "validated");
    assert_eq!(valid["validated"], true);
    assert_eq!(
        valid["keyRef"]["validation"]["method"],
        "knownPlaintextProof"
    );
    assert!(
        valid["keyRef"]["materialHash"]
            .as_str()
            .unwrap()
            .starts_with("sha256:")
    );

    // Every failure class is a structured finding with no published key-ref.
    for (entry_id, outcome, code) in [
        (
            "static-key-wrong-key",
            "validation_failed",
            "siglus.static_key.validation_failed",
        ),
        (
            "static-key-unsupported-packer",
            "unsupported_packer",
            "siglus.static_key.unsupported_packer",
        ),
        (
            "static-key-protected-executable",
            "protected_executable",
            "siglus.static_key.protected_executable",
        ),
        (
            "static-key-no-key-region",
            "key_region_not_found",
            "siglus.static_key.key_region_not_found",
        ),
        (
            "static-key-helper-mismatch",
            "helper_mismatch",
            "siglus.static_key.helper_mismatch",
        ),
    ] {
        let entry = entry(&report, entry_id);
        assert_eq!(entry["outcome"], outcome, "{entry_id}");
        assert_eq!(
            entry["validated"], false,
            "{entry_id} must not be validated"
        );
        assert!(
            entry["keyRef"].is_null(),
            "{entry_id} must publish no key-ref"
        );
        let has_finding = entry["findings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|finding| finding["code"] == code);
        assert!(has_finding, "{entry_id} missing structured finding {code}");
    }

    // No raw key material anywhere in the serialized report.
    let raw = String::from_utf8(fs::read(&report_path).unwrap()).unwrap();
    assert!(!raw.contains("SIGLUSXORKEY0123"), "raw key leaked");
}

#[test]
fn outcome_mismatch_fails_with_structured_finding_not_panic() {
    let tmp = tempfile::tempdir().unwrap();
    // Claim the wrong-key entry validates; the evidence disagrees.
    let mut value: Value = serde_json::from_slice(&fs::read(manifest()).unwrap()).unwrap();
    for entry in value["entries"].as_array_mut().unwrap() {
        if entry["entryId"] == "static-key-wrong-key" {
            entry["expected"] = Value::String("validated".to_string());
        }
    }
    let drifted = siglus_dir().join(format!(
        ".tmp-siglus-static-key-mismatch-{}.json",
        std::process::id()
    ));
    fs::write(&drifted, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    let _guard = RemoveOnDrop(drifted.clone());

    let report_path = tmp.path().join("report.json");
    let output = Command::new(kaifuu_cli_binary())
        .arg("siglus")
        .arg("static-key")
        .arg("--fixture")
        .arg(&drifted)
        .arg("--output")
        .arg(&report_path)
        .output()
        .expect("kaifuu-cli should run");

    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!output.status.success(), "outcome mismatch must fail");
    assert!(!stderr.contains("panicked"), "must not panic: {stderr}");
    assert!(
        stderr.contains("Siglus static-key discovery failed")
            && stderr.contains("static-key-wrong-key"),
        "stderr missing structured failure: {stderr}"
    );

    let report: Value = serde_json::from_slice(&fs::read(&report_path).unwrap()).unwrap();
    assert_eq!(report["status"], "failed");
    let wrong = entry(&report, "static-key-wrong-key");
    assert_eq!(wrong["status"], "failed");
    // Still no key-ref — validate-before-consume held.
    assert!(wrong["keyRef"].is_null());
    let has_mismatch = wrong["findings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|finding| finding["code"] == "siglus.static_key.outcome_mismatch");
    assert!(has_mismatch, "missing outcome-mismatch finding: {wrong}");
}

struct RemoveOnDrop(PathBuf);

impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
