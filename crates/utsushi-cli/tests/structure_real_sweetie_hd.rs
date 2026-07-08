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

    let entry_scene = structure["entryScene"].as_u64().expect("entryScene");
    let scene_ids: std::collections::BTreeSet<u64> = structure["scenes"]
        .as_array()
        .expect("scenes array")
        .iter()
        .map(|scene| scene["sceneId"].as_u64().expect("sceneId"))
        .collect();
    let dispatch_order: Vec<u64> = structure["sceneDispatchOrder"]
        .as_array()
        .expect("sceneDispatchOrder array")
        .iter()
        .map(|scene| scene.as_u64().expect("scene id"))
        .collect();

    // The real driven playthrough crosses many scenes.
    assert!(
        scene_ids.len() >= 10,
        "expected the Sweetie playthrough to cross ≥10 scenes; got {}",
        scene_ids.len()
    );
    // sceneDispatchOrder is exactly the crossed scenes, once each (no doubling,
    // no dropped scene), and leads with the entry scene — the REAL dispatch
    // order from the replay walk, NOT archive slot order.
    assert_eq!(
        dispatch_order
            .iter()
            .copied()
            .collect::<std::collections::BTreeSet<u64>>(),
        scene_ids,
        "sceneDispatchOrder must list every crossed scene exactly once"
    );
    assert_eq!(
        dispatch_order.first().copied(),
        Some(entry_scene),
        "dispatch order must begin at the entry scene (SEEN_START)"
    );

    eprintln!(
        "M1 utsushi structure real bytes: crossedScenes={}, dispatchOrder[0]={}",
        scene_ids.len(),
        dispatch_order.first().copied().unwrap_or_default(),
    );
}
