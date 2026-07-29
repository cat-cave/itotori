//! Env-gated real-bytes proof for `utsushi structure` (M1 bridge layering).
//!
//! The narrative-structure producer lives on the UTSUSHI side (it needs the
//! replay runtime; deps flow utsushi → kaifuu, never back). This drives the
//! `utsushi-cli` binary's `structure` subcommand over the REAL primary_corpus HD
//! archive and asserts the bridge-bound v2 structure contains complete,
//! replay-derived narrative evidence.
//!
//! Env-gated on `private inventory row`; runs only in the periodic
//! ground-truth oracle where the corpus is staged.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::path::PathBuf;
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

#[test]
#[ignore = "real-bytes; requires the private inventory and its generated bridge artifact"]
fn utsushi_structure_primary_corpus_rejects_truncation_without_an_artifact() {
    let (Some(gameexe), Some(seen), Some(bridge_path)) = (
        real_corpus::gameexe_ini_path(),
        real_corpus::seen_txt_path(),
        real_corpus::game_root()
            .map(|root| root.join("bridge.json"))
            .filter(|path| path.is_file()),
    ) else {
        eprintln!("{}", real_corpus::skip_message("structure truncation test"));
        return;
    };
    let tmp_dir = tempfile::tempdir().expect("tmp dir");
    let structure_out = tmp_dir.path().join("must-not-exist.json");
    let output = Command::new(utsushi_cli_binary())
        .args(["structure", "--engine", "reallive", "--gameexe"])
        .arg(gameexe)
        .arg("--seen")
        .arg(seen)
        .arg("--bridge")
        .arg(bridge_path)
        .arg("--output")
        .arg(&structure_out)
        .args(["--max-scenes", "1"])
        .output()
        .expect("utsushi-cli must run");
    assert!(!output.status.success(), "truncated export must fail");
    assert!(
        !structure_out.exists(),
        "a rejected partial export must not leave an artifact"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("utsushi.structure.truncated"), "{stderr}");
    assert!(stderr.contains("no artifact was written"), "{stderr}");
}

#[test]
#[ignore = "real-bytes; requires the private inventory and its generated bridge artifact"]
fn utsushi_structure_primary_corpus_v2_matches_bridge_and_graph() {
    let (Some(gameexe), Some(seen), Some(bridge_path)) = (
        real_corpus::gameexe_ini_path(),
        real_corpus::seen_txt_path(),
        real_corpus::game_root()
            .map(|root| root.join("bridge.json"))
            .filter(|path| path.is_file()),
    ) else {
        eprintln!(
            "reallive/1/encrypted or its generated bridge artifact is unavailable for expanded structure proof"
        );
        return;
    };
    let bridge: Value = serde_json::from_slice(&std::fs::read(&bridge_path).expect("read bridge"))
        .expect("bridge JSON");
    let bridge_units = bridge["units"].as_array().expect("bridge units");
    let by_id = bridge_units
        .iter()
        .map(|unit| (unit["bridgeUnitId"].as_str().expect("bridgeUnitId"), unit))
        .collect::<std::collections::HashMap<_, _>>();

    let tmp_dir = tempfile::tempdir().expect("tmp dir");
    let structure_out = tmp_dir.path().join("expanded.json");
    let output = Command::new(utsushi_cli_binary())
        .args(["structure", "--engine", "reallive", "--gameexe"])
        .arg(gameexe)
        .arg("--seen")
        .arg(seen)
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
                    unit["byteOffsetInScene"],
                    source["sourceLocation"]["range"]["startByte"]
                );
            }
            let start = unit["byteOffsetInScene"].as_u64().expect("start");
            let length = unit["byteLength"].as_u64().expect("length");
            let asset = unit["sourceAsset"]["assetId"].as_str().expect("asset id");
            assert_eq!(
                unit["rawByteHandle"],
                format!("raw:{asset}:{start}:{}", start + length)
            );
        }
        for message in scene["messages"].as_array().expect("messages") {
            for field in [
                "lineId",
                "evidenceTier",
                "color",
                "sourceAsset",
                "byteOffsetInScene",
                "rawByteHandle",
                "playOrder",
                "revealOrder",
                "routeMembership",
            ] {
                assert!(message.get(field).is_some(), "message is missing {field}");
            }
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
                    message["byteOffsetInScene"],
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
