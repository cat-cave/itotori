//! Siglus narrative-structure provider and its format-root resolution.

use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

use kaifuu_core::BridgeBundleV02;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::super::StructureCommandInput;
use super::validate_empty_adapter_config;

pub(super) fn build_structure(input: StructureCommandInput) -> Result<Value, Box<dyn Error>> {
    validate_empty_adapter_config("siglus", &input)?;
    let (scene_path, gameexe_path) = siglus_paths(&input.game_root)?;
    let selection = read_bridge_selection(&input.bridge, &scene_path)?;
    let structure = utsushi_siglus::build_siglus_structure(&scene_path, &gameexe_path)
        .map_err(|error| -> Box<dyn Error> { error.into() })?;
    filter_structure_to_bridge(structure, &selection).map_err(Into::into)
}

/// The subset of a `Scene.pck` export represented by a validated bridge.
///
/// Siglus extraction scopes select whole SceneList entries, so each bridge
/// asset maps to one numeric scene id. The bridge's packed-name keys are
/// format properties, while Utsushi's common structure uses numeric ids.
#[derive(Debug)]
struct BridgeSelection {
    scene_ids: BTreeSet<u32>,
}

#[derive(Debug)]
struct SceneDirectory {
    source_bundle_hash: String,
    scene_ids_by_asset_key: BTreeMap<String, u32>,
    source_hashes_by_asset_key: BTreeMap<String, String>,
}

fn read_bridge_selection(
    bridge_path: &Path,
    scene_path: &Path,
) -> Result<BridgeSelection, Box<dyn Error>> {
    let bytes = fs::read(bridge_path).map_err(|error| {
        bridge_error(
            "read",
            format!("cannot read {}: {error}", bridge_path.display()),
        )
    })?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|error| bridge_error("json", format!("is not valid JSON: {error}")))?;
    let bridge = BridgeBundleV02::validate_json(&value)
        .map_err(|error| bridge_error("contract", error.to_string()))?;
    bridge_selection(&bridge, &scene_directory(scene_path)?)
}

fn scene_directory(scene_path: &Path) -> Result<SceneDirectory, Box<dyn Error>> {
    let bytes = fs::read(scene_path).map_err(|error| {
        bridge_error(
            "source.Scene.pck",
            format!("cannot read {}: {error}", scene_path.display()),
        )
    })?;
    let index = kaifuu_siglus::parse_scene_pck(&bytes).map_err(|error| {
        bridge_error(
            "source.Scene.pck",
            format!("cannot parse Scene.pck: {error}"),
        )
    })?;
    let mut scene_ids_by_asset_key = BTreeMap::new();
    let mut source_hashes_by_asset_key = BTreeMap::new();
    for entry in index.entries {
        let asset_key = scene_asset_key(entry.scene_name.as_deref(), entry.scene_id);
        let start = usize::try_from(entry.byte_offset).map_err(|error| {
            bridge_error(
                "source.Scene.pck",
                format!(
                    "scene {} offset cannot be addressed: {error}",
                    entry.scene_id
                ),
            )
        })?;
        let byte_len = usize::try_from(entry.byte_len).map_err(|error| {
            bridge_error(
                "source.Scene.pck",
                format!(
                    "scene {} length cannot be addressed: {error}",
                    entry.scene_id
                ),
            )
        })?;
        let end = start.checked_add(byte_len).ok_or_else(|| {
            bridge_error(
                "source.Scene.pck",
                format!("scene {} byte range overflows", entry.scene_id),
            )
        })?;
        let scene_bytes = bytes.get(start..end).ok_or_else(|| {
            bridge_error(
                "source.Scene.pck",
                format!("scene {} byte range is unavailable", entry.scene_id),
            )
        })?;
        if scene_ids_by_asset_key
            .insert(asset_key.clone(), entry.scene_id)
            .is_some()
        {
            return Err(bridge_error(
                "source.Scene.pck",
                format!("has duplicate packed scene key {asset_key:?}"),
            ));
        }
        source_hashes_by_asset_key.insert(asset_key, sha256_ref(scene_bytes));
    }
    Ok(SceneDirectory {
        source_bundle_hash: sha256_ref(&bytes),
        scene_ids_by_asset_key,
        source_hashes_by_asset_key,
    })
}

fn bridge_selection(
    bridge: &BridgeBundleV02,
    directory: &SceneDirectory,
) -> Result<BridgeSelection, Box<dyn Error>> {
    if bridge.extractor.name != "kaifuu-siglus-bridge" {
        return Err(bridge_error(
            "extractor.name",
            format!(
                "must equal \"kaifuu-siglus-bridge\", got {:?}",
                bridge.extractor.name
            ),
        ));
    }
    if bridge.source_bundle_hash != directory.source_bundle_hash {
        return Err(bridge_error(
            "sourceBundleHash",
            "does not match the selected source Scene.pck",
        ));
    }
    if bridge.assets.is_empty() {
        return Err(bridge_error(
            "assets",
            "must contain at least one Siglus Scene.pck asset",
        ));
    }

    let mut asset_keys_by_id = BTreeMap::new();
    let mut scene_ids = BTreeSet::new();
    for (index, asset) in bridge.assets.iter().enumerate() {
        let key = format!("assets[{index}].assetKey");
        let Some(scene_id) = directory.scene_ids_by_asset_key.get(&asset.asset_key) else {
            return Err(bridge_error(
                &key,
                format!(
                    "{:?} is not a Scene.pck scene in this source",
                    asset.asset_key
                ),
            ));
        };
        let expected_hash = directory
            .source_hashes_by_asset_key
            .get(&asset.asset_key)
            .ok_or_else(|| {
                bridge_error(
                    &key,
                    "has no source-byte hash in the selected Scene.pck directory",
                )
            })?;
        if asset.source_hash != *expected_hash {
            return Err(bridge_error(
                &format!("assets[{index}].sourceHash"),
                "does not match its Scene.pck scene bytes",
            ));
        }
        if !scene_ids.insert(*scene_id) {
            return Err(bridge_error(
                &key,
                "selects the same Scene.pck scene more than once",
            ));
        }
        asset_keys_by_id.insert(asset.asset_id.as_str(), asset.asset_key.as_str());
    }

    for (index, unit) in bridge.units.iter().enumerate() {
        let prefix = format!("units[{index}]");
        let asset_key = asset_keys_by_id
            .get(unit.source_asset_ref.asset_id.as_str())
            .ok_or_else(|| {
                bridge_error(
                    &format!("{prefix}.sourceAssetRef.assetId"),
                    "does not refer to a selected Siglus asset",
                )
            })?;
        if unit.source_asset_ref.asset_key.as_deref() != Some(*asset_key) {
            return Err(bridge_error(
                &format!("{prefix}.sourceAssetRef.assetKey"),
                "must match the selected Siglus assetKey",
            ));
        }
        let unit_asset_key = source_asset_key(&unit.source_unit_key).ok_or_else(|| {
            bridge_error(
                &format!("{prefix}.sourceUnitKey"),
                "must be siglus:scene-<packed-name>#<decimal-offset>",
            )
        })?;
        if unit_asset_key != *asset_key {
            return Err(bridge_error(
                &format!("{prefix}.sourceUnitKey"),
                "must name the same scene as sourceAssetRef.assetKey",
            ));
        }
    }
    Ok(BridgeSelection { scene_ids })
}

fn filter_structure_to_bridge(
    structure: Value,
    selection: &BridgeSelection,
) -> Result<Value, String> {
    let mut root = structure
        .as_object()
        .cloned()
        .ok_or("utsushi.structure.siglus.output: structure must be an object")?;
    if root.get("engine").and_then(Value::as_str) != Some("siglus") {
        return Err("utsushi.structure.siglus.output: structure engine must be siglus".to_string());
    }
    let scenes = root
        .remove("scenes")
        .and_then(|value| value.as_array().cloned())
        .ok_or("utsushi.structure.siglus.output: scenes must be an array")?;
    let mut all_scene_ids = BTreeSet::new();
    let mut retained = Vec::new();
    for scene in scenes {
        let scene_id = scene
            .get("sceneId")
            .and_then(Value::as_str)
            .and_then(structure_scene_id)
            .ok_or("utsushi.structure.siglus.output: sceneId must be siglus:scene-NNNN")?;
        if !all_scene_ids.insert(scene_id) {
            return Err(format!(
                "utsushi.structure.siglus.output: duplicate sceneId {scene_id}"
            ));
        }
        if selection.scene_ids.contains(&scene_id) {
            retained.push(scene);
        }
    }
    if !selection.scene_ids.is_subset(&all_scene_ids) {
        let missing = selection
            .scene_ids
            .difference(&all_scene_ids)
            .map(|id| format!("siglus:scene-{id:04}"))
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "utsushi.structure.siglus.bridge.selection: selected scenes are absent from the source structure: {missing}"
        ));
    }
    let dispatch = retained
        .iter()
        .map(|scene| scene["sceneId"].clone())
        .collect::<Vec<_>>();
    let entry_scene = dispatch
        .first()
        .cloned()
        .ok_or("utsushi.structure.siglus.bridge.selection: bridge selected no structure scenes")?;
    root.insert("scenes".to_string(), Value::Array(retained));
    root.insert("sceneDispatchOrder".to_string(), Value::Array(dispatch));
    root.insert("entryScene".to_string(), entry_scene);
    Ok(Value::Object(root))
}

fn scene_asset_key(scene_name: Option<&str>, scene_id: u32) -> String {
    let name = scene_name
        .filter(|name| !name.is_empty())
        .map_or_else(|| format!("{scene_id:04}"), ToOwned::to_owned);
    format!("siglus:scene-{name}")
}

fn source_asset_key(source_unit_key: &str) -> Option<&str> {
    let (asset_key, offset) = source_unit_key.split_once('#')?;
    (asset_key
        .strip_prefix("siglus:scene-")
        .is_some_and(|name| !name.is_empty())
        && offset.parse::<u64>().is_ok())
    .then_some(asset_key)
}

fn structure_scene_id(scene_id: &str) -> Option<u32> {
    scene_id.strip_prefix("siglus:scene-")?.parse().ok()
}

fn sha256_ref(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{:x}", hasher.finalize())
}

fn bridge_error(key: &str, detail: impl std::fmt::Display) -> Box<dyn Error> {
    format!("utsushi.structure.siglus.bridge.{key}: {detail}").into()
}

/// Resolve Siglus's sibling format containers from the common project root.
fn siglus_paths(game_root: &Path) -> Result<(PathBuf, PathBuf), Box<dyn Error>> {
    validate_game_root(game_root)?;
    let game_root = find_siglus_game_root(game_root)?;
    Ok((
        game_root_asset(&game_root, "Scene.pck")?,
        game_root_asset(&game_root, "Gameexe.dat")?,
    ))
}

fn find_siglus_game_root(root: &Path) -> Result<PathBuf, Box<dyn Error>> {
    let mut pending = vec![root.to_path_buf()];
    let mut unkeyed_root = None;
    while let Some(candidate) = pending.pop() {
        if candidate.join("Scene.pck").is_file() && candidate.join("Gameexe.dat").is_file() {
            if candidate.join("SiglusEngine.exe").is_file() {
                return Ok(candidate);
            }
            if unkeyed_root.is_none() {
                unkeyed_root = Some(candidate.clone());
            }
        }
        for entry in fs::read_dir(&candidate)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                pending.push(entry.path());
            }
        }
    }
    unkeyed_root.ok_or_else(|| missing_game_root_asset(root, "Scene.pck"))
}

fn game_root_asset(game_root: &Path, name: &str) -> Result<PathBuf, Box<dyn Error>> {
    let path = game_root.join(name);
    path.is_file()
        .then_some(path)
        .ok_or_else(|| missing_game_root_asset(game_root, name))
}

fn validate_game_root(game_root: &Path) -> Result<(), Box<dyn Error>> {
    game_root.is_dir().then_some(()).ok_or_else(|| {
        format!(
            "utsushi.structure.siglus.game_root: {} is not a directory",
            game_root.display()
        )
        .into()
    })
}

fn missing_game_root_asset(game_root: &Path, name: &str) -> Box<dyn Error> {
    format!(
        "utsushi.structure.siglus.game_root: {} is missing required {name}",
        game_root.display()
    )
    .into()
}

#[cfg(test)]
mod tests;
