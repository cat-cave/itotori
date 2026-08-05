//! Real-byte CLI integration for `kaifuu-cli extract --engine softpal <root>`.
//!
//! The staged plaintext corpus test asserts its exact known dialogue and choice
//! unit count through the positional game-root interface. This target belongs
//! to the compile-time real-bytes oracle feature.

use std::path::PathBuf;
use std::process::Command;

use serde_json::Value;

/// The plaintext staged corpus: 39832 dialogue + 16 text-bearing choices.
const V60663_EXPECTED_UNITS: usize = 39848;

fn kaifuu_cli_binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_kaifuu-cli"))
}

/// Locate the v60663 game dir (the one carrying `data.pac`) under the corpus
/// root. Returns `None` when the env var is unset or the title is absent.
fn v60663_game_dir() -> Option<PathBuf> {
    let root = corpus_registry::resolve_identity("softpal/1/plain").ok()?;
    let candidate = root.join("v60663").join("game");
    candidate.join("data.pac").is_file().then_some(candidate)
}

#[test]
fn cli_extract_engine_softpal_positional_root_writes_bridge_with_expected_units() {
    let Some(game_dir) = v60663_game_dir() else {
        panic!("real-bytes proof not established: required corpus is unavailable");
    };

    let tmp_dir = tempfile::tempdir().expect("tmp dir");
    let bundle_out = tmp_dir.path().join("v60663.bridge.json");

    // Game root passed POSITIONALLY (no --game-dir): this is the contract the
    // audit required — a positional root must work like the other engines.
    let output = Command::new(kaifuu_cli_binary())
        .arg("extract")
        .arg("--engine")
        .arg("softpal")
        .arg(&game_dir)
        .arg("--bundle-output")
        .arg(&bundle_out)
        .output()
        .expect("kaifuu-cli must run");
    assert!(
        output.status.success(),
        "kaifuu-cli extract --engine softpal <positional root> exited non-zero: status={:?}\nstderr={}",
        output.status,
        String::from_utf8_lossy(&output.stderr),
    );

    let bundle: Value = serde_json::from_slice(&std::fs::read(&bundle_out).expect("bundle file"))
        .expect("bundle must be valid JSON");
    let units = bundle["units"].as_array().expect("units array");
    assert_eq!(
        units.len(),
        V60663_EXPECTED_UNITS,
        "v60663 must extract the known dialogue+choice unit count via the positional root"
    );
    eprintln!("softpal positional extract: units={}", units.len());
}
