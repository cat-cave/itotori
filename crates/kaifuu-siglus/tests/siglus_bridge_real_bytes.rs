//! Env-gated bridge proof over two owned Siglus installations.
//!
//! The test reads the local corpus only when both configured roots are present.
//! It prints counts and hashes, never decoded text or Gameexe values.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use kaifuu_core::BridgeBundleV02;
use kaifuu_siglus::{
    BridgeOpts, BridgeSceneInput, SiglusSecondLayerKey, decode_scene_chunk, parse_scene_pck,
    produce_scene_pack_bundle, read_gameexe_inventory, recover_exe_angou_key,
};

const FIRST_TITLE_ENV: &str = "ITOTORI_REAL_GAME_ROOT_SIGLUS";
const SECOND_TITLE_ENV: &str = "ITOTORI_REAL_GAME_ROOT_SIGLUS_2";

fn title_paths(variable: &str) -> Option<(PathBuf, PathBuf, PathBuf)> {
    let value = std::env::var_os(variable).or_else(|| {
        eprintln!("SKIP siglus bridge real bytes: {variable} is unset");
        None
    })?;
    let root = PathBuf::from(value);
    let dir = if root.is_dir() {
        root
    } else {
        root.parent().map(Path::to_path_buf).unwrap_or(root)
    };
    let exe = dir.join("SiglusEngine.exe");
    let scene = dir.join("Scene.pck");
    let gameexe = dir.join("Gameexe.dat");
    if exe.is_file() && scene.is_file() && gameexe.is_file() {
        Some((exe, scene, gameexe))
    } else {
        eprintln!(
            "SKIP siglus bridge real bytes: {variable} has no SiglusEngine.exe + Scene.pck + Gameexe.dat under {}",
            dir.display()
        );
        None
    }
}

struct DecodedScene {
    scene_id: u32,
    scene_name: Option<String>,
    packed: Vec<u8>,
    decoded: Vec<u8>,
}

fn bundle_hash(json: &serde_json::Value) -> String {
    let bytes = serde_json::to_vec(json).expect("bridge json serializes");
    let mut hash = Sha256::new();
    hash.update(bytes);
    format!("sha256:{:x}", hash.finalize())
}

fn exercise_title(exe_path: &Path, scene_path: &Path, gameexe_path: &Path, label: &str) {
    let exe_bytes = std::fs::read(exe_path).expect("read real SiglusEngine.exe");
    let scene_bytes = std::fs::read(scene_path).expect("read real Scene.pck");
    let gameexe_bytes = std::fs::read(gameexe_path).expect("read real Gameexe.dat");
    let key_ref =
        SiglusSecondLayerKey::from_secret_ref(format!("secret://siglus/{label}/exe-angou"));
    let recovery = recover_exe_angou_key(&exe_bytes, &key_ref).expect("recover exe-angou key");
    let inventory = read_gameexe_inventory(&exe_bytes, &gameexe_bytes, &key_ref)
        .expect("read Gameexe inventory");
    let index = parse_scene_pck(&scene_bytes).expect("parse Scene.pck");
    let decoded: Vec<_> = index
        .entries
        .iter()
        .map(|entry| {
            let start = entry.byte_offset as usize;
            let end = start + entry.byte_len as usize;
            let packed = scene_bytes[start..end].to_vec();
            let decoded = decode_scene_chunk(
                entry.scene_id,
                &packed,
                index.extra_key_use,
                Some(recovery.material()),
            )
            .unwrap_or_else(|error| {
                panic!("{label}: scene {} decode failed: {error}", entry.scene_id)
            });
            DecodedScene {
                scene_id: entry.scene_id,
                scene_name: entry.scene_name.clone(),
                packed,
                decoded,
            }
        })
        .collect();
    let inputs: Vec<_> = decoded
        .iter()
        .map(|scene| BridgeSceneInput {
            scene_id: scene.scene_id,
            scene_name: scene.scene_name.as_deref(),
            scene_bytes: &scene.packed,
            decoded_scene: &scene.decoded,
        })
        .collect();
    let opts = BridgeOpts {
        game_id: label,
        game_version: "real-bytes",
        source_profile_id: "kaifuu-siglus-real-bytes",
        source_locale: "ja-JP",
        extractor_name: "kaifuu-siglus-bridge",
        extractor_version: env!("CARGO_PKG_VERSION"),
    };
    let first = produce_scene_pack_bundle(&scene_bytes, &inputs, &inventory, &opts)
        .unwrap_or_else(|error| panic!("{label}: bridge assembly failed: {error}"));
    let second = produce_scene_pack_bundle(&scene_bytes, &inputs, &inventory, &opts)
        .unwrap_or_else(|error| panic!("{label}: repeated bridge assembly failed: {error}"));
    assert!(
        BridgeBundleV02::validate_json(&first.json).is_ok(),
        "{label}: bridge must satisfy the v0.2 schema"
    );
    assert_eq!(
        first
            .bundle
            .units
            .iter()
            .map(|unit| unit.bridge_unit_id.as_str())
            .collect::<Vec<_>>(),
        second
            .bundle
            .units
            .iter()
            .map(|unit| unit.bridge_unit_id.as_str())
            .collect::<Vec<_>>(),
        "{label}: bridge unit ids must be deterministic"
    );

    let mut counts = BTreeMap::new();
    for unit in &first.bundle.units {
        *counts.entry(unit.surface_kind.as_str()).or_insert(0_usize) += 1;
        assert!(
            unit.source_unit_key.starts_with("siglus:scene-") && unit.source_unit_key.contains('#'),
            "{label}: source key must be scene and offset keyed"
        );
    }
    let choice_count = *counts.get("choice_label").unwrap_or(&0);
    assert!(
        choice_count > 0,
        "{label}: expected at least one selectable label"
    );
    for unit in first
        .bundle
        .units
        .iter()
        .filter(|unit| unit.surface_kind == "choice_label")
    {
        let choice = &unit.context["choice"];
        assert_eq!(choice["selectSyscallSite"]["systemFunctionId"], 76);
        let offset = choice["selectSyscallSite"]["byteOffset"]
            .as_u64()
            .expect("choice select site offset");
        assert!(
            choice["routeTargetRef"]
                .as_str()
                .is_some_and(|reference| reference.ends_with(&format!("#{offset}"))),
            "{label}: choice must link to its select syscall site"
        );
    }
    let dialogue = counts.get("dialogue").copied().unwrap_or(0);
    let speakers = counts.get("speaker_name").copied().unwrap_or(0);
    assert!(dialogue > 0, "{label}: expected dialogue units");
    assert!(speakers > 0, "{label}: expected speaker-name units");
    eprintln!(
        "REAL {label}: dialogue={dialogue} choice={choice_count} speaker={speakers} units={} bundle_sha256={}",
        first.bundle.units.len(),
        bundle_hash(&first.json)
    );
}

#[test]
fn two_real_siglus_titles_assemble_schema_valid_deterministic_bridges() {
    let Some((first_exe, first_scene, first_gameexe)) = title_paths(FIRST_TITLE_ENV) else {
        return;
    };
    let Some((second_exe, second_scene, second_gameexe)) = title_paths(SECOND_TITLE_ENV) else {
        return;
    };
    exercise_title(&first_exe, &first_scene, &first_gameexe, "siglus-title-one");
    exercise_title(
        &second_exe,
        &second_scene,
        &second_gameexe,
        "siglus-title-two",
    );
}
