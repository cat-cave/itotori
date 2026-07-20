//! Env-gated real-bytes proof for `utsushi structure` (M1 bridge layering).
//!
//! The narrative-structure producer lives on the UTSUSHI side (it needs the
//! replay runtime; deps flow utsushi → kaifuu, never back). This drives the
//! `utsushi-cli` binary's `structure` subcommand over the REAL Sweetie HD
//! archive and asserts it emits a `utsushi.narrative-structure.v1` whose
//! `sceneDispatchOrder` is the REAL play-loop dispatch order (led by the entry
//! scene), spanning many scenes — the artifact the whole-game localize driver
//! joins to the kaifuu-produced bridge by `context.route.sceneKey`.
//!
//! Env-gated on `ITOTORI_REAL_GAME_ROOT`; runs only in the periodic
//! ground-truth oracle where the corpus is staged.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::path::PathBuf;
use std::process::Command;

use serde_json::Value;

/// The `SeenEnd` terminator sentinel every launcher/terminator scene emits —
/// a structure of ONLY these messages is the #62 regression.
const SEEN_END_SENTINEL: &str = "ＳｅｅｎＥｎｄ";

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
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn utsushi_structure_real_sweetie_writes_real_dispatch_order() {
    let (Some(gameexe), Some(seen)) = (
        real_corpus::gameexe_ini_path(),
        real_corpus::seen_txt_path(),
    ) else {
        eprintln!(
            "{}",
            real_corpus::skip_message("utsushi structure real-bytes test")
        );
        return;
    };

    let tmp_dir = tempfile::tempdir().expect("tmp dir");
    let structure_out = tmp_dir.path().join("sweetie-hd.structure.json");

    let output = Command::new(utsushi_cli_binary())
        .arg("structure")
        .args(["--engine", "reallive"])
        .arg("--gameexe")
        .arg(&gameexe)
        .arg("--seen")
        .arg(&seen)
        .arg("--output")
        .arg(&structure_out)
        .output()
        .expect("utsushi-cli must run");
    assert!(
        output.status.success(),
        "utsushi structure exited non-zero: status={:?}\nstdout={}\nstderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );

    let bytes = std::fs::read(&structure_out).expect("structure file must exist");
    let structure: Value = serde_json::from_slice(&bytes).expect("structure must be valid JSON");
    assert_eq!(structure["schemaVersion"], "utsushi.narrative-structure.v1");

    let entry_scene = structure["entryScene"].as_str().expect("entryScene");
    let scene_ids: std::collections::BTreeSet<&str> = structure["scenes"]
        .as_array()
        .expect("scenes array")
        .iter()
        .map(|scene| scene["sceneId"].as_str().expect("sceneId"))
        .collect();
    let dispatch_order: Vec<&str> = structure["sceneDispatchOrder"]
        .as_array()
        .expect("sceneDispatchOrder array")
        .iter()
        .map(|scene| scene.as_str().expect("scene id"))
        .collect();

    // The structure covers many scenes (entry chain + whole-archive coverage
    // reaches the store-gated narrative a single #SEEN_START chain cannot).
    assert!(
        scene_ids.len() >= 10,
        "expected the Sweetie structure to span ≥10 scenes; got {}",
        scene_ids.len()
    );

    // REGRESSION GUARD for #62: the export must reach the REAL narrative, not
    // dead-end at the launcher's `SeenEnd` terminator. Assert a large body of
    // real (non-`SeenEnd`) dialogue, plus real choices and speakers — the
    // structure-informed context the drafter depends on.
    let scenes = structure["scenes"].as_array().expect("scenes array");
    let mut real_messages = 0usize;
    let mut seen_end_messages = 0usize;
    let mut total_choices = 0usize;
    let mut speakers: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for scene in scenes {
        for message in scene["messages"].as_array().expect("messages array") {
            let text = message["text"].as_str().unwrap_or_default();
            if text == SEEN_END_SENTINEL {
                seen_end_messages += 1;
            } else if !text.is_empty() {
                real_messages += 1;
            }
            if let Some(speaker) = message["speaker"].as_str() {
                speakers.insert(speaker.to_string());
            }
        }
        total_choices += scene["choices"].as_array().expect("choices array").len();
    }
    assert!(
        real_messages >= 5_000,
        "expected ≥5000 real (non-SeenEnd) narrative messages; got {real_messages} \
         (seenEnd={seen_end_messages}) — the walk did not reach the real narrative"
    );
    assert!(
        total_choices >= 10,
        "expected ≥10 decoded choice prompts across the narrative; got {total_choices}"
    );
    assert!(
        speakers.len() >= 3,
        "expected ≥3 distinct decoded speakers (#NAMAE); got {}",
        speakers.len()
    );
    // sceneDispatchOrder is exactly the crossed scenes, once each (no doubling
    // no dropped scene), and leads with the entry scene — the REAL dispatch
    // order from the replay walk, NOT archive slot order.
    assert_eq!(
        dispatch_order
            .iter()
            .copied()
            .collect::<std::collections::BTreeSet<&str>>(),
        scene_ids,
        "sceneDispatchOrder must list every crossed scene exactly once"
    );
    assert_eq!(
        dispatch_order.first().copied(),
        Some(entry_scene),
        "dispatch order must begin at the entry scene (SEEN_START)"
    );

    eprintln!(
        "M1 utsushi structure real bytes: scenes={}, dispatchOrder[0]={}, \
         realMessages={real_messages}, seenEndMessages={seen_end_messages}, \
         choices={total_choices}, speakers={}",
        scene_ids.len(),
        dispatch_order.first().copied().unwrap_or_default(),
        speakers.len(),
    );
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn utsushi_structure_real_sweetie_rejects_truncation_without_an_artifact() {
    let (Some(gameexe), Some(seen)) = (
        real_corpus::gameexe_ini_path(),
        real_corpus::seen_txt_path(),
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
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT and ITOTORI_REAL_BRIDGE_PATH"]
fn utsushi_structure_real_sweetie_v2_matches_bridge_and_graph() {
    let (Some(gameexe), Some(seen), Some(bridge_path)) = (
        real_corpus::gameexe_ini_path(),
        real_corpus::seen_txt_path(),
        std::env::var_os("ITOTORI_REAL_BRIDGE_PATH").map(PathBuf::from),
    ) else {
        eprintln!(
            "set ITOTORI_REAL_GAME_ROOT and ITOTORI_REAL_BRIDGE_PATH for expanded structure proof"
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
