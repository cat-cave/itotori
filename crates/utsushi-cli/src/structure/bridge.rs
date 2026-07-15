use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use kaifuu_core::BridgeBundleV02;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use utsushi_reallive::SceneId;

#[derive(Clone, Debug)]
pub(super) struct ChoiceRef {
    pub group_id: String,
    pub choice_id: String,
    pub option_index: u16,
}

#[derive(Clone, Debug)]
pub(super) struct BridgeUnit {
    pub id: String,
    pub source_unit_key: String,
    pub surface_kind: String,
    pub source_text: String,
    pub source_asset: Value,
    pub byte_start: u64,
    pub byte_end: u64,
    pub choice_command_offset: Option<u64>,
    pub character_id: Option<String>,
    pub color: Option<[u8; 3]>,
    pub choice: Option<ChoiceRef>,
}

impl BridgeUnit {
    pub fn bridge_ref(&self) -> Value {
        json!({
            "bridgeUnitId": self.id,
            "sourceUnitKey": self.source_unit_key,
        })
    }

    pub fn raw_byte_handle(&self) -> String {
        let asset = self.source_asset["assetId"].as_str().unwrap_or("unknown");
        format!("raw:{asset}:{}:{}", self.byte_start, self.byte_end)
    }
}

#[derive(Debug)]
pub(super) struct BridgeIndex {
    pub bridge_id: String,
    pub source_bundle_hash: String,
    pub asset_scene_ids: BTreeSet<SceneId>,
    pub assets_by_scene: BTreeMap<SceneId, Value>,
    pub units_by_scene: BTreeMap<SceneId, Vec<BridgeUnit>>,
    pub unit_count: usize,
}

impl BridgeIndex {
    pub fn load(path: &Path, seen_bytes: &[u8]) -> Result<Self, String> {
        let bytes = std::fs::read(path)
            .map_err(|err| format!("utsushi.structure.read_bridge: {}: {err}", path.display()))?;
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|err| format!("utsushi.structure.parse_bridge_json: {err}"))?;
        let validated = BridgeBundleV02::validate_json(&value)
            .map_err(|err| format!("utsushi.structure.validate_bridge: {err}"))?;
        let seen_hash = sha256_ref(seen_bytes);
        if validated.source_bundle_hash != seen_hash {
            return Err(format!(
                "utsushi.structure.bridge_seen_mismatch: bridge sourceBundleHash {} does not match Seen.txt {seen_hash}",
                validated.source_bundle_hash
            ));
        }

        let mut asset_scene_ids = BTreeSet::new();
        let mut assets_by_scene = BTreeMap::new();
        for (index, asset) in array(&value, "assets")?.iter().enumerate() {
            let key =
                string(asset, "assetKey").map_err(|err| format!("{err} at assets[{index}]"))?;
            let scene_id = scene_from_asset_key(key).ok_or_else(|| {
                format!(
                    "utsushi.structure.bridge_asset_scene: assets[{index}].assetKey {key:?} is not reallive:scene-NNNN"
                )
            })?;
            if !asset_scene_ids.insert(scene_id) {
                return Err(format!(
                    "utsushi.structure.bridge_asset_duplicate: scene {scene_id} has multiple assets"
                ));
            }
            assets_by_scene.insert(
                scene_id,
                json!({
                    "assetId": string(asset, "assetId")?,
                    "assetKey": key,
                }),
            );
        }

        let mut units_by_scene: BTreeMap<SceneId, Vec<BridgeUnit>> = BTreeMap::new();
        for (index, raw) in array(&value, "units")?.iter().enumerate() {
            let unit = parse_unit(raw)
                .map_err(|err| format!("utsushi.structure.bridge_unit[{index}]: {err}"))?;
            let scene_id = scene_from_source_key(&unit.source_unit_key).ok_or_else(|| {
                format!(
                    "utsushi.structure.bridge_unit[{index}]: sourceUnitKey {:?} is not scene-scoped",
                    unit.source_unit_key
                )
            })?;
            units_by_scene.entry(scene_id).or_default().push(unit);
        }
        for units in units_by_scene.values_mut() {
            units.sort_by_key(|unit| (unit.byte_start, unit.source_unit_key.clone()));
        }

        Ok(Self {
            bridge_id: validated.bridge_id,
            source_bundle_hash: validated.source_bundle_hash,
            asset_scene_ids,
            assets_by_scene,
            unit_count: validated.units.len(),
            units_by_scene,
        })
    }

    pub fn units(&self, scene_id: SceneId) -> &[BridgeUnit] {
        self.units_by_scene
            .get(&scene_id)
            .map(Vec::as_slice)
            .unwrap_or_default()
    }

    pub fn asset(&self, scene_id: SceneId) -> Option<&Value> {
        self.assets_by_scene.get(&scene_id)
    }
}

fn parse_unit(value: &Value) -> Result<BridgeUnit, String> {
    let location = object(value, "sourceLocation")?;
    let range = location
        .get("range")
        .and_then(Value::as_object)
        .ok_or("sourceLocation.range must be an object")?;
    let context = object(value, "context")?;
    let speaker = value.get("speaker").and_then(Value::as_object);
    let choice = context
        .get("choice")
        .map(|raw| -> Result<ChoiceRef, String> {
            Ok(ChoiceRef {
                group_id: string(raw, "choiceGroupId")?.to_string(),
                choice_id: string(raw, "choiceId")?.to_string(),
                option_index: u16::try_from(unsigned(raw, "optionIndex")?)
                    .map_err(|err| format!("optionIndex out of range: {err}"))?,
            })
        })
        .transpose()?;
    let color = speaker
        .and_then(|speaker| speaker.get("textColor"))
        .map(rgb)
        .transpose()?;
    let byte_start = unsigned_map(range, "startByte")?;
    Ok(BridgeUnit {
        id: string(value, "bridgeUnitId")?.to_string(),
        source_unit_key: string(value, "sourceUnitKey")?.to_string(),
        surface_kind: string(value, "surfaceKind")?.to_string(),
        source_text: string(value, "sourceText")?.to_string(),
        source_asset: value
            .get("sourceAssetRef")
            .cloned()
            .ok_or("sourceAssetRef is missing")?,
        byte_start,
        byte_end: unsigned_map(range, "endByte")?,
        choice_command_offset: choice.as_ref().map(|_| byte_start),
        character_id: speaker
            .and_then(|speaker| speaker.get("speakerId"))
            .and_then(Value::as_str)
            .map(str::to_string),
        color,
        choice,
    })
}

fn rgb(value: &Value) -> Result<[u8; 3], String> {
    let channels = value.as_array().ok_or("textColor must be an RGB array")?;
    if channels.len() != 3 {
        return Err("textColor must contain three channels".to_string());
    }
    let mut rgb = [0u8; 3];
    for (index, channel) in channels.iter().enumerate() {
        rgb[index] = u8::try_from(channel.as_u64().ok_or("RGB channel must be unsigned")?)
            .map_err(|err| format!("RGB channel out of range: {err}"))?;
    }
    Ok(rgb)
}

fn scene_from_asset_key(key: &str) -> Option<SceneId> {
    key.strip_prefix("reallive:scene-")?.parse().ok()
}

fn scene_from_source_key(key: &str) -> Option<SceneId> {
    key.strip_prefix("reallive:scene-")?
        .split_once('#')?
        .0
        .parse()
        .ok()
}

fn array<'a>(value: &'a Value, key: &str) -> Result<&'a Vec<Value>, String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{key} must be an array"))
}

fn object<'a>(value: &'a Value, key: &str) -> Result<&'a serde_json::Map<String, Value>, String> {
    value
        .get(key)
        .and_then(Value::as_object)
        .ok_or_else(|| format!("{key} must be an object"))
}

fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{key} must be a string"))
}

fn unsigned(value: &Value, key: &str) -> Result<u64, String> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("{key} must be an unsigned integer"))
}

fn unsigned_map(value: &serde_json::Map<String, Value>, key: &str) -> Result<u64, String> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("{key} must be an unsigned integer"))
}

fn sha256_ref(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{:x}", hasher.finalize())
}
