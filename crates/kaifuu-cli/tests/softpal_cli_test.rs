//! CLI integration test for `kaifuu-cli extract --engine softpal <root>` with
//! the game root passed **positionally** (consistent with the other engines'
//! extract surface). Env-gated on `ITOTORI_SOFTPAL_RESEARCH_ROOT`; runs the
//! kaifuu-cli binary against the real, read-only Softpal corpus (v60663 —
//! Dimension Totsu Lovers, plaintext TEXT.DAT) and asserts the extracted
//! BridgeBundle carries the exact known dialogue+choice unit count (39848 =
//! 39832 dialogue + 16 text-bearing choices), matching kaifuu-softpal's
//! committed real-corpus expectations. Never prints raw copyrighted bytes.
//! Wired into the PERIODIC `ci-real-bytes` lane (the wider
//! `-p kaifuu-cli -- --ignored` invocation already picks this up); soft-skips
//! when `ITOTORI_SOFTPAL_RESEARCH_ROOT` is unset (skip-when-absent is
//! legitimate for the periodic lane).

use std::path::PathBuf;
use std::process::Command;

use serde_json::Value;

/// v60663 (Dimension Totsu Lovers): 39832 dialogue + 16 text-bearing choices.
const V60663_EXPECTED_UNITS: usize = 39848;

fn kaifuu_cli_binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_kaifuu-cli"))
}

/// Locate the v60663 game dir (the one carrying `data.pac`) under the corpus
/// root. Returns `None` when the env var is unset or the title is absent.
fn v60663_game_dir() -> Option<PathBuf> {
    let root = PathBuf::from(std::env::var_os("ITOTORI_SOFTPAL_RESEARCH_ROOT")?);
    let candidate = root.join("v60663").join("game");
    candidate.join("data.pac").is_file().then_some(candidate)
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_SOFTPAL_RESEARCH_ROOT (read-only Softpal corpus)"]
fn cli_extract_engine_softpal_positional_root_writes_bridge_with_expected_units() {
    let Some(game_dir) = v60663_game_dir() else {
        eprintln!("skipping: set ITOTORI_SOFTPAL_RESEARCH_ROOT with a v60663/game/data.pac");
        return;
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
