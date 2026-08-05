//! Compile-time real-bytes proof for the Utsushi structure command (M1 bridge layering).
//!
//! The test builds its exact whole-archive bridge directly from the staged
//! Seen.txt and Gameexe.ini, then drives the Utsushi structure command. It
//! therefore has no pre-generated bridge-artifact dependency.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

fn test_manifest_dir() -> PathBuf {
    std::env::var_os("CARGO_MANIFEST_DIR")
        .map_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")), PathBuf::from)
}

fn utsushi_cli_binary() -> PathBuf {
    let path = PathBuf::from(env!("CARGO_BIN_EXE_utsushi-cli"));
    if path.exists() {
        return path;
    }
    // Fallback: assume the harness ran `cargo build -p utsushi-cli`.
    test_manifest_dir()
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.join("target/debug/utsushi-cli"))
        .expect("workspace root")
}

fn real_paths() -> (PathBuf, PathBuf) {
    let gameexe = real_corpus::gameexe_ini_path()
        .unwrap_or_else(|| panic!("real-bytes proof requires staged Gameexe.ini"));
    let seen = real_corpus::seen_txt_path()
        .unwrap_or_else(|| panic!("real-bytes proof requires staged Seen.txt"));
    (gameexe, seen)
}

fn real_game_root() -> PathBuf {
    real_corpus::game_root()
        .unwrap_or_else(|| panic!("real-bytes proof requires staged RealLive game root"))
}

fn write_whole_seen_bridge(gameexe_path: &Path, seen_path: &Path, output: &Path) -> Value {
    let seen_bytes = fs::read(seen_path).expect("read staged Seen.txt");
    let gameexe_bytes = fs::read(gameexe_path).expect("read staged Gameexe.ini");
    let index = kaifuu_reallive::parse_archive(&seen_bytes).expect("parse Seen.txt archive");
    let mut corpus = kaifuu_reallive::decompress_archive_scenes(&seen_bytes, &index);
    assert_eq!(
        corpus.scenes.len(),
        index.entries.len(),
        "every populated archive scene must decompress for the whole bridge"
    );
    let recovery = kaifuu_reallive::recover_and_decrypt_archive(&mut corpus.scenes);
    assert!(
        recovery.validated,
        "staged archive must validate its cross-scene xor_2 recovery: {recovery:?}"
    );

    let scene_inputs: Vec<_> = index
        .entries
        .iter()
        .map(|entry| {
            let position = corpus.position_of(entry.scene_id).unwrap_or_else(|| {
                panic!(
                    "scene {} vanished from the decompressed corpus",
                    entry.scene_id
                )
            });
            let start = entry.byte_offset as usize;
            let end = start + entry.byte_len as usize;
            let scene_bytes = &seen_bytes[start..end];
            let header = kaifuu_reallive::SceneHeader::parse(scene_bytes)
                .expect("indexed scene header remains valid");
            kaifuu_reallive::BridgeSceneInput {
                scene_id: entry.scene_id,
                scene_bytes,
                decompressed_bytecode: &corpus.scenes[position].bytecode,
                scene_kidoku_count: header.kidoku_count,
            }
        })
        .collect();
    let gameexe = kaifuu_reallive::parse_gameexe_inventory(&gameexe_bytes);
    let opts = kaifuu_reallive::BridgeOpts {
        game_id: "primary-corpus",
        game_version: "1.0.0",
        source_profile_id: "kaifuu-reallive-primary-corpus",
        source_locale: "ja-JP",
        extractor_name: "kaifuu-reallive-bridge",
        extractor_version: "0.1.0",
        scene_kidoku_count: 0,
    };
    let bridge =
        kaifuu_reallive::produce_whole_seen_bundle(&seen_bytes, &scene_inputs, &gameexe, &opts)
            .expect("whole staged archive produces a valid bridge");
    fs::write(
        output,
        serde_json::to_vec(&bridge.json).expect("serialize bridge"),
    )
    .expect("write temporary bridge");
    bridge.json
}

/// The common structure schema keeps engine-specific byte provenance under the
/// provider extension. These assertions deliberately retain the prior proof's
/// required fields; only their canonical schema location differs.
fn reallive_evidence<'a>(value: &'a Value, field: &str) -> &'a Value {
    value
        .get("engineEvidence")
        .and_then(|evidence| evidence.get("reallive"))
        .and_then(|evidence| evidence.get(field))
        .unwrap_or_else(|| panic!("narrative element is missing engineEvidence.reallive.{field}"))
}

#[test]
fn utsushi_structure_primary_corpus_rejects_removed_limit_without_an_artifact() {
    let game_root = real_game_root();
    let (gameexe, seen) = real_paths();
    let tmp_dir = tempfile::tempdir().expect("tmp dir");
    let bridge_path = tmp_dir.path().join("whole.bridge.json");
    let _bridge = write_whole_seen_bridge(&gameexe, &seen, &bridge_path);
    let structure_out = tmp_dir.path().join("must-not-exist.json");
    let output = Command::new(utsushi_cli_binary())
        .args(["structure", "--engine", "reallive", "--game-root"])
        .arg(game_root)
        .arg("--bridge")
        .arg(bridge_path)
        .arg("--output")
        .arg(&structure_out)
        .args(["--max-scenes", "1"])
        .output()
        .expect("utsushi-cli must run");
    assert!(!output.status.success(), "removed limit must fail");
    assert!(
        !structure_out.exists(),
        "a rejected partial export must not leave an artifact"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("unknown structure flag: --max-scenes"),
        "{stderr}"
    );
}

#[test]
fn utsushi_structure_primary_corpus_v2_matches_bridge_and_graph() {
    let game_root = real_game_root();
    let (gameexe, seen) = real_paths();
    let tmp_dir = tempfile::tempdir().expect("tmp dir");
    let bridge_path = tmp_dir.path().join("whole.bridge.json");
    let bridge = write_whole_seen_bridge(&gameexe, &seen, &bridge_path);
    let bridge_units = bridge["units"].as_array().expect("bridge units");
    let by_id = bridge_units
        .iter()
        .map(|unit| (unit["bridgeUnitId"].as_str().expect("bridgeUnitId"), unit))
        .collect::<std::collections::HashMap<_, _>>();
    let structure_out = tmp_dir.path().join("expanded.json");
    let output = Command::new(utsushi_cli_binary())
        .args(["structure", "--engine", "reallive", "--game-root"])
        .arg(game_root)
        .arg("--bridge")
        .arg(bridge_path)
        .arg("--output")
        .arg(&structure_out)
        .output()
        .expect("utsushi-cli must run");
    assert!(
        output.status.success(),
        "expanded structure failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let structure: Value =
        serde_json::from_slice(&std::fs::read(structure_out).expect("read structure"))
            .expect("structure JSON");
    assert_eq!(structure["schemaVersion"], "utsushi.narrative-structure.v2");
    assert_eq!(structure["bridgeId"], bridge["bridgeId"]);
    assert_eq!(structure["sourceBundleHash"], bridge["sourceBundleHash"]);

    let coverage = &structure["coverage"];
    assert_eq!(coverage["complete"], true);
    assert_eq!(coverage["truncated"], false);
    assert_eq!(coverage["truncationStatus"], "complete");
    assert_eq!(
        coverage["archiveUnitCount"].as_u64(),
        Some(bridge_units.len() as u64)
    );
    assert_eq!(coverage["archiveUnitCount"], coverage["emittedUnitCount"]);
    assert_eq!(coverage["archiveSceneCount"], coverage["emittedSceneCount"]);
    assert_eq!(coverage["archiveEdgeCount"], coverage["emittedEdgeCount"]);

    for scene in structure["scenes"].as_array().expect("scenes") {
        for unit in scene["units"].as_array().expect("units") {
            let id = unit["bridgeRef"]["bridgeUnitId"]
                .as_str()
                .expect("unit bridge ref");
            let source = by_id.get(id).expect("unit must exist in exact bridge");
            assert_eq!(unit["sourceAsset"], source["sourceAssetRef"]);
            if source["surfaceKind"] == "dialogue" {
                assert_eq!(
                    *reallive_evidence(unit, "byteOffsetInScene"),
                    source["sourceLocation"]["range"]["startByte"]
                );
            }
            let start = reallive_evidence(unit, "byteOffsetInScene")
                .as_u64()
                .expect("start");
            let length = reallive_evidence(unit, "byteLength")
                .as_u64()
                .expect("length");
            let asset = unit["sourceAsset"]["assetId"].as_str().expect("asset id");
            assert_eq!(
                *reallive_evidence(unit, "rawByteHandle"),
                format!("raw:{asset}:{start}:{}", start + length)
            );
        }
        for message in scene["messages"].as_array().expect("messages") {
            for field in [
                "lineId",
                "evidenceTier",
                "color",
                "sourceAsset",
                "playOrder",
                "revealOrder",
                "routeMembership",
            ] {
                assert!(message.get(field).is_some(), "message is missing {field}");
            }
            reallive_evidence(message, "byteOffsetInScene");
            reallive_evidence(message, "rawByteHandle");
            if message["linkageStatus"] == "runtime_only" {
                assert!(message["bridgeRef"].is_null());
                continue;
            }
            let id = message["bridgeRef"]["bridgeUnitId"]
                .as_str()
                .expect("message bridge ref");
            let source = by_id.get(id).expect("message must exist in exact bridge");
            assert_eq!(message["sourceAsset"], source["sourceAssetRef"]);
            if source["surfaceKind"] == "dialogue" {
                assert_eq!(
                    *reallive_evidence(message, "byteOffsetInScene"),
                    source["sourceLocation"]["range"]["startByte"]
                );
            }
        }
        for field in [
            "sceneRef",
            "predecessors",
            "successors",
            "reachable",
            "routeMembership",
        ] {
            assert!(scene.get(field).is_some(), "scene is missing {field}");
        }
    }
    for edge in structure["edges"].as_array().expect("edges") {
        for field in ["edgeId", "resolution", "diagnostic"] {
            assert!(edge.get(field).is_some(), "edge is missing {field}");
        }
        if edge["resolution"] == "unknown" {
            assert!(edge["toSceneId"].is_null());
            assert!(
                edge["diagnostic"]
                    .as_str()
                    .is_some_and(|text| !text.is_empty())
            );
        }
    }
}
