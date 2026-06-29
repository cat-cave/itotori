//! KAIFUU-171 — end-to-end CLI smoke for the encrypted-XP3 contract
//! scaffolding harness.
//!
//! Spawns `kaifuu xp3 contract-scaffold` against the committed synthetic
//! public fixture and asserts the full contract surface
//! (detect -> key resolution -> extract -> patch -> verify -> delta-apply)
//! runs end-to-end, the output declares itself contract scaffolding (not a
//! retail readiness claim), and that injected contract drift fails with a
//! semantic diagnostic rather than a panic. No private corpora are used.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

fn kaifuu_cli_binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_kaifuu-cli"))
}

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("fixtures/public/kaifuu-encrypted-xp3-contract-scaffold")
}

fn descriptor() -> PathBuf {
    fixture_dir().join("contract-scaffold.fixture.json")
}

fn copy_dir_recursive(source: &Path, dest: &Path) {
    fs::create_dir_all(dest).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let target = dest.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir_recursive(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), &target).unwrap();
        }
    }
}

#[test]
fn contract_scaffold_runs_full_surface_and_disclaims_readiness() {
    let work = tempfile::tempdir().unwrap();
    let report_path = work.path().join("report.json");

    let output = Command::new(kaifuu_cli_binary())
        .arg("xp3")
        .arg("contract-scaffold")
        .arg("--fixture")
        .arg(descriptor())
        .arg("--output")
        .arg(&report_path)
        .output()
        .expect("kaifuu-cli should run");

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "expected success; stdout={stdout}; stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );

    // Disclaimer is present and disclaims retail readiness.
    assert!(
        stdout.contains("CONTRACT SCAFFOLDING ONLY"),
        "stdout missing disclaimer: {stdout}"
    );
    assert!(
        stdout.contains("NOT a claim of retail encrypted-XP3 readiness"),
        "stdout missing readiness disclaimer: {stdout}"
    );

    // Every contract stage is named and passed.
    for stage in [
        "detect",
        "key_resolution",
        "extract",
        "patch",
        "verify",
        "delta_apply",
    ] {
        assert!(
            stdout.contains(&format!("[PASS] {stage}")),
            "stage {stage} did not pass in stdout: {stdout}"
        );
    }

    let report: Value = serde_json::from_slice(&fs::read(&report_path).unwrap()).unwrap();
    assert_eq!(report["status"], "passed");
    assert_eq!(report["notRetailReadinessClaim"], true);
    assert_eq!(report["stages"].as_array().unwrap().len(), 6);
    assert!(
        report["disclaimer"]
            .as_str()
            .unwrap()
            .contains("NOT a claim of retail encrypted-XP3 readiness")
    );
}

#[test]
fn contract_scaffold_drift_fails_with_semantic_diagnostic() {
    let tmp = tempfile::tempdir().unwrap();
    let drifted = tmp.path().join("fixture");
    copy_dir_recursive(&fixture_dir(), &drifted);

    // Corrupt the decrypted inner archive into encrypted bytes so the extract
    // stage drifts.
    let envelope = fs::read(drifted.join("encrypted-envelope.xp3")).unwrap();
    fs::write(drifted.join("decrypted-inner.xp3"), &envelope).unwrap();

    let report_path = tmp.path().join("report.json");
    let output = Command::new(kaifuu_cli_binary())
        .arg("xp3")
        .arg("contract-scaffold")
        .arg("--fixture")
        .arg(drifted.join("contract-scaffold.fixture.json"))
        .arg("--output")
        .arg(&report_path)
        .output()
        .expect("kaifuu-cli should run");

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    assert!(
        !output.status.success(),
        "drift must fail the harness; stdout={stdout}"
    );
    // Disclaimer is still printed even on drift.
    assert!(
        stdout.contains("CONTRACT SCAFFOLDING ONLY"),
        "stdout={stdout}"
    );
    // The failure surfaces a semantic diagnostic (drift summary + code), not a
    // panic or opaque error.
    assert!(
        stderr.contains("contract scaffold drift")
            && stderr.contains("kaifuu.unsupported_variant.encrypted"),
        "stderr missing semantic drift diagnostic: {stderr}"
    );
    assert!(
        !stderr.contains("panicked"),
        "harness must not panic: {stderr}"
    );

    // The persisted report records the failed extract stage with its semantic
    // code.
    let report: Value = serde_json::from_slice(&fs::read(&report_path).unwrap()).unwrap();
    assert_eq!(report["status"], "failed");
    let extract = report["stages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|stage| stage["stage"] == "extract")
        .unwrap();
    assert_eq!(extract["status"], "failed");
    assert_eq!(
        extract["semanticCode"],
        "kaifuu.unsupported_variant.encrypted"
    );
}
