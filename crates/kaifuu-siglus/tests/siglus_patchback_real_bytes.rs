//! Env-gated, two-installation proof of bundle-driven `Scene.pck` patchback.
//!
//! The private corpus is optional: when either configured root is absent this
//! test skips cleanly. With both roots present, each installation proves an
//! identity bundle is byte-identical, one UTF-16 string-table edit survives a
//! full re-decode/re-decompile, and a stale source hash is rejected.

use std::path::{Path, PathBuf};

use serde_json::json;

use kaifuu_siglus::{
    BridgeOpts, BridgeSceneInput, PatchbackError, PatchbackOpts, SiglusSecondLayerKey,
    TranslatedBundleV02, apply_translated_bundle, decode_scene_chunk, parse_scene_pck,
    partition_scene, produce_scene_pack_bundle, read_gameexe_inventory, recover_exe_angou_key,
};

const FIRST_ROOT_ENV: &str = "ITOTORI_REAL_GAME_ROOT_SIGLUS";
const SECOND_ROOT_ENV: &str = "ITOTORI_REAL_GAME_ROOT_SIGLUS_2";

struct DecodedScene {
    scene_id: u32,
    scene_name: Option<String>,
    packed: Vec<u8>,
    decoded: Vec<u8>,
}

fn installation_paths(variable: &str) -> Option<(PathBuf, PathBuf, PathBuf)> {
    let root = std::env::var_os(variable).map(PathBuf::from).or_else(|| {
        eprintln!("SKIP siglus patchback real bytes: {variable} is unset");
        None
    })?;
    let directory = if root.is_dir() {
        root
    } else {
        root.parent().map(Path::to_path_buf).unwrap_or(root)
    };
    let exe = directory.join("SiglusEngine.exe");
    let scene = directory.join("Scene.pck");
    let gameexe = directory.join("Gameexe.dat");
    if exe.is_file() && scene.is_file() && gameexe.is_file() {
        Some((exe, scene, gameexe))
    } else {
        eprintln!(
            "SKIP siglus patchback real bytes: {variable} lacks SiglusEngine.exe + Scene.pck + Gameexe.dat under {}",
            directory.display()
        );
        None
    }
}

fn exercise_installation(exe: &Path, scene: &Path, gameexe: &Path, label: &str) {
    let exe_bytes = std::fs::read(exe).expect("read SiglusEngine.exe");
    let source_archive = std::fs::read(scene).expect("read Scene.pck");
    let gameexe_bytes = std::fs::read(gameexe).expect("read Gameexe.dat");
    let key_ref =
        SiglusSecondLayerKey::from_secret_ref(format!("secret://siglus/{label}/patchback"));
    let recovery = recover_exe_angou_key(&exe_bytes, &key_ref).expect("recover scene key");
    let inventory = read_gameexe_inventory(&exe_bytes, &gameexe_bytes, &key_ref)
        .expect("read Gameexe inventory");
    let source_index = parse_scene_pck(&source_archive).expect("parse source Scene.pck");
    let source_scenes = decode_all(&source_archive, &source_index, recovery.material());
    let bridge = build_bridge(&source_archive, &source_scenes, &inventory, label);
    assert!(
        !bridge.bundle.units.is_empty(),
        "{label}: bridge has a text unit"
    );

    let identity_json = translated_json(&bridge.json, None);
    let identity = TranslatedBundleV02::from_json(&identity_json).expect("identity bundle");
    let opts = PatchbackOpts::utf16le_with_second_layer(recovery.material());
    let identity_result =
        apply_translated_bundle(&source_archive, &identity, &opts).expect("identity patchback");
    assert_eq!(
        identity_result, source_archive,
        "{label}: identity targets must not rewrite a packed scene"
    );

    let selected = &bridge.bundle.units[0];
    let selected_string_index = bridge.json["units"][0]["sourceLocation"]["entryPath"][3]
        .as_str()
        .expect("string index");
    let target = format!("{} [kaifuu patchback]", selected.source_text);
    let changed_json = translated_json(&bridge.json, Some((selected_string_index, &target)));
    let changed = TranslatedBundleV02::from_json(&changed_json).expect("changed bundle");
    let patched = apply_translated_bundle(&source_archive, &changed, &opts)
        .expect("length-changing patchback");
    let patched_index = parse_scene_pck(&patched).expect("patched SceneList parses");
    assert_eq!(patched_index.entries.len(), source_index.entries.len());
    let patched_scenes = decode_all(&patched, &patched_index, recovery.material());
    for decoded in &patched_scenes {
        let partition = partition_scene(&decoded.decoded).expect("patched siglus-08 partition");
        assert!(
            partition.fully_partitioned,
            "{label}: scene {} has new Unknown opcodes after patchback",
            decoded.scene_id
        );
    }
    let reparsed_bridge = build_bridge(&patched, &patched_scenes, &inventory, label);
    let returned = reparsed_bridge
        .bundle
        .units
        .iter()
        .find(|unit| unit.source_unit_key == selected.source_unit_key)
        .expect("edited surface remains bridge-addressable");
    assert_eq!(returned.source_text, target, "{label}: target re-decodes");

    let mut stale_json = identity_json;
    stale_json["units"][0]["sourceHash"] = json!(format!("sha256:{}", "0".repeat(64)));
    let stale = TranslatedBundleV02::from_json(&stale_json).expect("stale bundle schema");
    assert!(matches!(
        apply_translated_bundle(&source_archive, &stale, &opts),
        Err(PatchbackError::StaleSource { .. })
    ));
    eprintln!(
        "REAL {label}: scenes={} units={} identity=byte-identical edit=redecoded stale=blocked",
        source_index.entries.len(),
        bridge.bundle.units.len()
    );
}

fn decode_all(
    archive: &[u8],
    index: &kaifuu_siglus::SiglusSceneIndex,
    key: &kaifuu_siglus::SiglusSecondLayerMaterial,
) -> Vec<DecodedScene> {
    index
        .entries
        .iter()
        .map(|entry| {
            let start = entry.byte_offset as usize;
            let end = start + entry.byte_len as usize;
            let packed = archive[start..end].to_vec();
            let decoded =
                decode_scene_chunk(entry.scene_id, &packed, index.extra_key_use, Some(key))
                    .unwrap_or_else(|error| panic!("scene {} decode: {error}", entry.scene_id));
            DecodedScene {
                scene_id: entry.scene_id,
                scene_name: entry.scene_name.clone(),
                packed,
                decoded,
            }
        })
        .collect()
}

fn build_bridge(
    archive: &[u8],
    scenes: &[DecodedScene],
    inventory: &kaifuu_siglus::GameexeInventory,
    label: &str,
) -> kaifuu_siglus::ProducedBundle {
    let inputs = scenes
        .iter()
        .map(|scene| BridgeSceneInput {
            scene_id: scene.scene_id,
            scene_name: scene.scene_name.as_deref(),
            scene_bytes: &scene.packed,
            decoded_scene: &scene.decoded,
        })
        .collect::<Vec<_>>();
    let opts = BridgeOpts {
        game_id: label,
        game_version: "real-bytes",
        source_profile_id: "siglus-patchback-real-bytes",
        source_locale: "ja-JP",
        extractor_name: "kaifuu-siglus-patchback",
        extractor_version: env!("CARGO_PKG_VERSION"),
    };
    produce_scene_pack_bundle(archive, &inputs, inventory, &opts).expect("assemble bridge")
}

fn translated_json(source: &serde_json::Value, changed: Option<(&str, &str)>) -> serde_json::Value {
    let mut value = source.clone();
    for unit in value["units"]
        .as_array_mut()
        .expect("bridge units")
        .iter_mut()
    {
        let source_text = unit["sourceText"]
            .as_str()
            .expect("source text")
            .to_string();
        let string_index = unit["sourceLocation"]["entryPath"][3]
            .as_str()
            .expect("string index");
        let target = if changed.is_some_and(|(changed_index, _)| changed_index == string_index) {
            changed.expect("checked some").1
        } else {
            &source_text
        };
        unit["target"] = json!({ "locale": "en-US", "text": target });
    }
    value
}

#[test]
fn two_real_siglus_installations_patch_back_byte_correctly() {
    let Some((first_exe, first_scene, first_gameexe)) = installation_paths(FIRST_ROOT_ENV) else {
        return;
    };
    let Some((second_exe, second_scene, second_gameexe)) = installation_paths(SECOND_ROOT_ENV)
    else {
        return;
    };
    exercise_installation(&first_exe, &first_scene, &first_gameexe, "siglus-root-one");
    exercise_installation(
        &second_exe,
        &second_scene,
        &second_gameexe,
        "siglus-root-two",
    );
}
