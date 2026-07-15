//! CLI integration test for
//! `kaifuu-cli extract --engine reallive --scene 2011 --bundle-output PATH`.
//! Env-gated on `ITOTORI_REAL_GAME_ROOT`. Runs the kaifuu-cli
//! binary against the real Sweetie HD extracted root, asserts the
//! output file exists and decodes as a v0.2 bridge bundle whose
//! `schemaVersion` and `units` length pass the canonical contract.
//! Scene **2011** is a dialogue-bearing scene (the same scene the
//! `kaifuu-reallive` `bridge_real_bytes` test exercises). Scene 1 is
//! binary-only — after the dialogue-surface filter the bridge correctly
//! returns no_text_units for it, so this test targets a dialogue scene to
//! exercise real translatable-text extraction end-to-end.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::path::PathBuf;
use std::process::Command;

use serde_json::Value;

/// Resolve this crate's manifest directory (runtime `CARGO_MANIFEST_DIR`).
/// `env!("CARGO_MANIFEST_DIR")` is baked at COMPILE time, so a test binary
/// reused from a different (since-removed) worktree would resolve to a dead
/// path. `cargo test` sets `CARGO_MANIFEST_DIR` in the RUNTIME environment to
/// the LIVE crate directory; prefer that, falling back to the compile-time
/// constant only outside cargo.
fn test_manifest_dir() -> PathBuf {
    std::env::var_os("CARGO_MANIFEST_DIR")
        .map_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")), PathBuf::from)
}

fn kaifuu_cli_binary() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_BIN_EXE_kaifuu-cli"));
    if path.exists() {
        return path;
    }
    // Fallback: assume the harness runs after `cargo build -p kaifuu-cli`.
    path = test_manifest_dir()
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.join("target/debug/kaifuu-cli"))
        .expect("workspace root");
    path
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn cli_extract_engine_reallive_dialogue_scene_writes_schema_valid_v02_bundle() {
    let Some(game_root) = real_corpus::game_root() else {
        eprintln!(
            "{}",
            real_corpus::skip_message("CLI extract real-bytes test")
        );
        return;
    };

    let tmp_dir = tempfile::tempdir().expect("tmp dir");
    let bundle_out = tmp_dir.path().join("sweetie-hd-scene-2011.bridge.json");

    let mut cmd = Command::new(kaifuu_cli_binary());
    cmd.arg("extract")
        .arg("--engine")
        .arg("reallive")
        .arg("--scene")
        .arg("2011")
        .arg("--bundle-output")
        .arg(&bundle_out)
        .arg("--game-root")
        .arg(&game_root)
        .arg("--game-id")
        .arg("sweetie-hd")
        .arg("--game-version")
        .arg("1.0.0")
        .arg("--source-profile-id")
        .arg("kaifuu-reallive-sweetie-hd")
        .arg("--source-locale")
        .arg("ja-JP");
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

/// Env-gated whole-SEEN real-bytes proof (M1 bridge). Runs
/// `extract --whole-seen` over the ENTIRE real Sweetie HD SEEN archive — every
/// populated scene decodes (decode-100), producing ONE multi-scene v0.2 BRIDGE.
/// `kaifuu extract --whole-seen` produces the BRIDGE only — NOT the replay
/// -derived narrative structure. Deriving the structure / `sceneDispatchOrder`
/// needs the Utsushi replay runtime and kaifuu must never depend on utsushi
/// (deps flow utsushi → kaifuu). The real-Sweetie STRUCTURE proof lives on the
/// utsushi side (`utsushi-cli` `structure_real_sweetie_hd.rs`).
/// Asserts the bridge is schema-valid, spans many scenes, and that every unit
/// carries its numeric scene in `context.route.sceneKey` — the field the
/// whole-game localize driver joins to the utsushi-produced structure.
#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn cli_extract_whole_seen_real_sweetie_writes_multi_scene_bridge() {
    let Some(game_root) = real_corpus::game_root() else {
        eprintln!(
            "{}",
            real_corpus::skip_message("CLI whole-SEEN real-bytes test")
        );
        return;
    };

    let tmp_dir = tempfile::tempdir().expect("tmp dir");
    let bundle_out = tmp_dir.path().join("sweetie-hd-whole.bridge.json");
    let report_out = tmp_dir
        .path()
        .join("sweetie-hd-whole.decompile-report.json");

    let mut cmd = Command::new(kaifuu_cli_binary());
    cmd.arg("extract")
        .arg("--engine")
        .arg("reallive")
        .arg("--whole-seen")
        .arg("--bundle-output")
        .arg(&bundle_out)
        .arg("--decompile-report-output")
        .arg(&report_out)
        .arg("--game-root")
        .arg(&game_root)
        .arg("--game-id")
        .arg("sweetie-hd")
        .arg("--game-version")
        .arg("1.0.0")
        .arg("--source-profile-id")
        .arg("kaifuu-reallive-sweetie-hd")
        .arg("--source-locale")
        .arg("ja-JP");
    let output = cmd.output().expect("kaifuu-cli must run");
    assert!(
        output.status.success(),
        "kaifuu-cli --whole-seen exited non-zero: status={:?}\nstdout={}\nstderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );

    let bundle_bytes = std::fs::read(&bundle_out).expect("bridge file must exist");
    let bundle_value: Value =
        serde_json::from_slice(&bundle_bytes).expect("bridge must be valid JSON");
    let bundle = kaifuu_core::BridgeBundleV02::validate_json(&bundle_value)
        .expect("whole-SEEN bridge v0.2 contract");
    assert!(
        !bundle.units.is_empty(),
        "whole-SEEN bridge must carry ≥1 unit"
    );

    // Every unit must carry a `scene-NNNN` route key (the driver join key).
    let unrouted = bundle_value["units"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|unit| {
            unit["context"]["route"]["sceneKey"]
                .as_str()
                .is_none_or(|s| !s.starts_with("scene-"))
        })
        .count();
    assert_eq!(
        unrouted, 0,
        "every whole-SEEN unit must carry a scene route key"
    );

    // The bridge spans many scenes (whole-SEEN, not a single scene).
    let bridge_scenes: std::collections::BTreeSet<String> = bundle_value["units"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|unit| {
            unit["context"]["route"]["sceneKey"]
                .as_str()
                .map(str::to_string)
        })
        .collect();
    assert!(
        bridge_scenes.len() >= 50,
        "expected the whole-SEEN bridge to span many scenes; got {}",
        bridge_scenes.len()
    );

    let report_bytes = std::fs::read(&report_out).expect("report file must exist");
    let report: Value = serde_json::from_slice(&report_bytes).expect("report JSON");
    assert_eq!(report["scope"], "whole-seen");
    assert_eq!(
        report["unknownOpcodes"].as_u64(),
        Some(0),
        "decode-100: zero unknown opcodes across the whole SEEN archive"
    );

    eprintln!(
        "M1 whole-SEEN bridge real bytes: bridgeScenes={}, units={}",
        bridge_scenes.len(),
        bundle.units.len(),
    );
}
