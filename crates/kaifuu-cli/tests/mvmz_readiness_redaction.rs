//! CLI redaction regression for `kaifuu rpg-maker readiness-report`.
//!
//! Seeds a synthetic-but-realistic private-local MV/MZ game tree under a temp
//! directory (stand-in for `fixtures/private-local/<id>`), runs the readiness
//! report subcommand, and asserts the emitted JSON:
//! - has EXACTLY the six aggregate top-level keys,
//! - never contains any project filename, full path, or `encryptionKey` bytes,
//! - reports `encryptionKey` presence as a boolean only.
//!
//! No private corpora are required; the test is deterministic and CI-safe.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

/// Distinctive asset basename the report must never emit.
const SECRET_ASSET_BASENAME: &str = "SecretOwnedTitleBanner_DO_NOT_LEAK";
/// Distinctive map dialogue the report must never emit.
const SECRET_DIALOGUE: &str = "SECRET_MAP_DIALOGUE_DO_NOT_LEAK_UNDER_THE_CHERRY_TREE";
/// Distinctive 32-hex `encryptionKey` the report must never emit.
const SECRET_KEY: &str = "deadbeefcafebabe0123456789abcdef";
/// Distinctive audio basename the report must never emit.
const SECRET_AUDIO: &str = "BattleThemeSecretOwned_DO_NOT_LEAK";

fn kaifuu_cli_binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_kaifuu-cli"))
}

fn stage_synthetic_private_local_game(game_dir: &Path) {
    let data = game_dir.join("data");
    let img = game_dir.join("img").join("pictures");
    let audio = game_dir.join("audio").join("bgm");
    fs::create_dir_all(&data).unwrap();
    fs::create_dir_all(&img).unwrap();
    fs::create_dir_all(&audio).unwrap();

    let system = serde_json::json!({
        "gameTitle": "SyntheticPrivateOwnedTitle",
        "encryptionKey": SECRET_KEY,
        "hasEncryptedImages": true,
        "hasEncryptedAudio": true
    });
    fs::write(
        data.join("System.json"),
        serde_json::to_vec_pretty(&system).unwrap(),
    )
    .unwrap();

    let map = serde_json::json!({
        "id": 1,
        "events": [
            null,
            {
                "id": 1,
                "pages": [{
                    "list": [
                        { "code": 101, "parameters": ["", 0, 0, 2] },
                        { "code": 401, "parameters": [SECRET_DIALOGUE] },
                        { "code": 102, "parameters": [["Yes", "No"], 1, 0, 2, 0] },
                        { "code": 402, "parameters": [0, "Yes"] },
                        { "code": 405, "parameters": ["scrolling secret line"] },
                        { "code": 108, "parameters": ["comment secret"] },
                        { "code": 0, "parameters": [] }
                    ]
                }]
            }
        ]
    });
    fs::write(data.join("Map001.json"), serde_json::to_vec(&map).unwrap()).unwrap();
    fs::write(
        data.join("MapInfos.json"),
        b"[null,{\"id\":1,\"name\":\"SecretTownName\"}]",
    )
    .unwrap();

    fs::write(
        img.join(format!("{SECRET_ASSET_BASENAME}.rpgmvp")),
        b"RPGMV\0fake-image",
    )
    .unwrap();
    fs::write(
        audio.join(format!("{SECRET_AUDIO}.rpgmvo")),
        b"RPGMV\0fake-audio",
    )
    .unwrap();
    fs::write(game_dir.join("index.html"), b"<html></html>").unwrap();
}

fn run_readiness_report(game_dir: &Path, output: &Path) -> std::process::Output {
    Command::new(kaifuu_cli_binary())
        .arg("rpg-maker")
        .arg("readiness-report")
        .arg("--game")
        .arg(game_dir)
        .arg("--output")
        .arg(output)
        .output()
        .expect("kaifuu-cli should spawn")
}

#[test]
fn readiness_report_top_level_keys_are_exactly_the_six() {
    let work = tempfile::tempdir().unwrap();
    // Stand-in for fixtures/private-local/<id> — path lane only; bodies are
    // never committed. The test seeds its own synthetic tree.
    let game_dir = work
        .path()
        .join("private-local")
        .join("synthetic-owned-mv-mz");
    stage_synthetic_private_local_game(&game_dir);
    let output = work.path().join("readiness.json");

    let proc = run_readiness_report(&game_dir, &output);
    assert!(
        proc.status.success(),
        "expected success; stderr={}",
        String::from_utf8_lossy(&proc.stderr)
    );

    let report: Value = serde_json::from_slice(&fs::read(&output).unwrap()).unwrap();
    let keys: BTreeSet<String> = report
        .as_object()
        .expect("object")
        .keys()
        .cloned()
        .collect();
    let expected: BTreeSet<String> = [
        "spec",
        "assetSuffixHistogram",
        "systemJsonHasEncryptionKey",
        "mapTextSurfaceCounts",
        "helperRequirements",
        "aggregateDataHashSha256",
    ]
    .iter()
    .map(ToString::to_string)
    .collect();
    assert_eq!(keys, expected, "top-level keys must be EXACTLY the six");
}

#[test]
fn readiness_report_never_leaks_filename_path_or_encryption_key_bytes() {
    let work = tempfile::tempdir().unwrap();
    let game_dir = work
        .path()
        .join("private-local")
        .join("synthetic-owned-mv-mz");
    stage_synthetic_private_local_game(&game_dir);
    let output = work.path().join("readiness.json");

    let proc = run_readiness_report(&game_dir, &output);
    assert!(
        proc.status.success(),
        "expected success; stderr={}",
        String::from_utf8_lossy(&proc.stderr)
    );

    let json = fs::read_to_string(&output).unwrap();
    let report: Value = serde_json::from_str(&json).unwrap();

    // Boolean key presence only — never the literal encryptionKey value.
    assert_eq!(report["systemJsonHasEncryptionKey"], true);
    assert!(
        !json.contains(SECRET_KEY),
        "System.json.encryptionKey byte string must not appear in the report"
    );
    assert!(
        !json.contains("deadbeef"),
        "key hex material must not appear in the report"
    );

    // No project filename / basename.
    assert!(
        !json.contains(SECRET_ASSET_BASENAME),
        "asset basename must not leak"
    );
    assert!(!json.contains(SECRET_AUDIO), "audio basename must not leak");
    assert!(!json.contains("Map001"), "map filename must not leak");
    assert!(
        !json.contains("System.json"),
        "System.json name must not leak"
    );
    assert!(!json.contains("MapInfos"), "MapInfos name must not leak");
    assert!(!json.contains("index.html"), "html filename must not leak");
    assert!(
        !json.contains("SecretTownName"),
        "map-info display name must not leak"
    );

    // No full path (absolute path from the staged private-local tree).
    if let Some(path_text) = game_dir.to_str() {
        assert!(
            !json.contains(path_text),
            "absolute game path must not leak"
        );
    }
    assert!(
        !json.contains("private-local"),
        "private-local path segment must not leak"
    );
    assert!(
        !json.contains("synthetic-owned-mv-mz"),
        "corpus id path segment must not leak"
    );
    assert!(
        !json.contains('/'),
        "no path separator may appear in the report"
    );

    // No dialogue / comment / scrolling text.
    assert!(!json.contains(SECRET_DIALOGUE), "dialogue must not leak");
    assert!(
        !json.contains("scrolling secret line"),
        "scrolling text must not leak"
    );
    assert!(
        !json.contains("comment secret"),
        "comment text must not leak"
    );

    // Structure was observed (counts / histograms only).
    assert!(
        report["assetSuffixHistogram"]["rpgmvp"]
            .as_u64()
            .unwrap_or(0)
            >= 1
    );
    assert!(
        report["assetSuffixHistogram"]["rpgmvo"]
            .as_u64()
            .unwrap_or(0)
            >= 1
    );
    assert_eq!(report["mapTextSurfaceCounts"]["show_text"], 1);
    assert_eq!(report["mapTextSurfaceCounts"]["choice_option"], 2);
    assert_eq!(report["mapTextSurfaceCounts"]["choice_branch"], 1);
    assert_eq!(report["mapTextSurfaceCounts"]["scrolling_text"], 1);
    assert_eq!(report["mapTextSurfaceCounts"]["comment"], 1);
    assert_eq!(report["helperRequirements"], serde_json::json!(["none"]));
    assert_eq!(
        report["aggregateDataHashSha256"]
            .as_str()
            .expect("hash string")
            .len(),
        64
    );
    assert_eq!(
        report["spec"],
        "kaifuu.rpgmaker.mv_mz_readiness_report@0.1.0"
    );
}

#[test]
fn readiness_report_is_deterministic() {
    let work = tempfile::tempdir().unwrap();
    let game_dir = work
        .path()
        .join("private-local")
        .join("synthetic-owned-mv-mz");
    stage_synthetic_private_local_game(&game_dir);
    let out_a = work.path().join("a.json");
    let out_b = work.path().join("b.json");

    let a = run_readiness_report(&game_dir, &out_a);
    let b = run_readiness_report(&game_dir, &out_b);
    assert!(a.status.success());
    assert!(b.status.success());
    assert_eq!(
        fs::read_to_string(&out_a).unwrap(),
        fs::read_to_string(&out_b).unwrap(),
        "same input must emit byte-identical report JSON"
    );
}
