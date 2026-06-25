//! KAIFUU-210 — CLI integration test for
//! `kaifuu-cli extract --engine reallive --scene 1 --bundle-output PATH`.
//!
//! Env-gated on `KAIFUU_REAL_SWEETIE_HD_PATH`. Runs the kaifuu-cli
//! binary against the real Sweetie HD extracted root, asserts the
//! output file exists and decodes as a v0.2 bridge bundle whose
//! `schemaVersion` and `units` length pass the canonical contract.

use std::env;
use std::path::PathBuf;
use std::process::Command;

use serde_json::Value;

fn kaifuu_cli_binary() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_BIN_EXE_kaifuu-cli"));
    if path.exists() {
        return path;
    }
    // Fallback: assume the harness runs after `cargo build -p kaifuu-cli`.
    path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.join("target/debug/kaifuu-cli"))
        .expect("workspace root");
    path
}

#[test]
#[ignore = "real-bytes; requires KAIFUU_REAL_SWEETIE_HD_PATH env var"]
fn cli_extract_engine_reallive_scene_1_writes_schema_valid_v02_bundle() {
    let Some(root) = env::var_os("KAIFUU_REAL_SWEETIE_HD_PATH") else {
        eprintln!(
            "KAIFUU_REAL_SWEETIE_HD_PATH unset; skipping (re-run with \
             KAIFUU_REAL_SWEETIE_HD_PATH=/scratch/itotori-research/sweetie-hd/extracted)"
        );
        return;
    };
    let game_root = PathBuf::from(root);

    let tmp_dir = tempfile::tempdir().expect("tmp dir");
    let bundle_out = tmp_dir.path().join("sweetie-hd-scene-1.bridge.json");

    let mut cmd = Command::new(kaifuu_cli_binary());
    cmd.arg("extract")
        .arg("--engine")
        .arg("reallive")
        .arg("--scene")
        .arg("1")
        .arg("--bundle-output")
        .arg(&bundle_out)
        .arg("--game-root")
        .arg(&game_root);
    let output = cmd.output().expect("kaifuu-cli must run");
    assert!(
        output.status.success(),
        "kaifuu-cli exited non-zero: status={:?}\nstdout={}\nstderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );

    let bundle_bytes = std::fs::read(&bundle_out).expect("bundle file must exist");
    let bundle_value: Value =
        serde_json::from_slice(&bundle_bytes).expect("bundle must be valid JSON");
    assert_eq!(
        bundle_value["schemaVersion"], "0.2.0",
        "bundle must declare canonical v0.2 schemaVersion"
    );
    let units = bundle_value["units"]
        .as_array()
        .expect("units must be an array");
    assert!(
        !units.is_empty(),
        "bundle must carry ≥1 unit (no silent zero-state); got 0"
    );
    eprintln!(
        "KAIFUU-210 CLI bundle: units={}, schemaVersion=0.2.0",
        units.len()
    );

    // Re-validate against the canonical v0.2 contract for a Rust-side
    // schema check (avoids needing JSON-schema tooling at the test
    // boundary).
    let bundle =
        kaifuu_core::BridgeBundleV02::validate_json(&bundle_value).expect("bundle v0.2 contract");
    assert_eq!(bundle.units.len(), units.len());
}
