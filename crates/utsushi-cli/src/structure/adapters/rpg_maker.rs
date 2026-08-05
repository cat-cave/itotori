//! RPG Maker narrative structure projected from verified bridge ordering.

use std::collections::HashSet;
use std::error::Error;
use std::fs;
use std::path::Path;

use serde_json::{Map, Value, json};

use super::super::StructureCommandInput;
use super::validate_empty_adapter_config;

const ENGINE: &str = "rpg-maker";
const SCENE_ID: &str = "bridge:source-order";

/// Project bridge-backed source order into the shared narrative structure.
pub(super) fn build_structure(input: StructureCommandInput) -> Result<Value, Box<dyn Error>> {
    validate_empty_adapter_config(ENGINE, &input)?;
    let game_root = &input.game_root;
    if !game_root.is_dir() {
        return Err(format!(
            "utsushi.structure.rpg-maker: --game-root is not a directory: {}",
            game_root.display()
        )
        .into());
    }
    let bridge_path = &input.bridge;
    let bridge = read_bridge(bridge_path)?;
    project_bridge(&bridge)
}

fn read_bridge(path: &Path) -> Result<Value, Box<dyn Error>> {
    let bytes = fs::read(path).map_err(|error| {
        format!(
            "utsushi.structure.rpg-maker.bridge: cannot read {}: {error}",
            path.display()
        )
    })?;
    serde_json::from_slice(&bytes).map_err(|error| {
        format!(
            "utsushi.structure.rpg-maker.bridge: {} is not valid JSON: {error}",
            path.display()
        )
        .into()
    })
}

/// Validate every bridge field this projection dereferences so malformed
/// provenance cannot become a malformed narrative artifact.
fn project_bridge(bridge: &Value) -> Result<Value, Box<dyn Error>> {
    let bridge = required_object(bridge, "bridge")?;
    let schema_version = required_string(bridge, "schemaVersion")?;
    if schema_version != "0.2.0" {
        return Err(bridge_error("schemaVersion", "must equal \"0.2.0\""));
    }
    let bridge_id = required_identifier(bridge, "bridgeId")?;
    let source_bundle_hash = required_sha256(bridge, "sourceBundleHash")?;
    let bridge_units = required_array(bridge, "units")?;
    let mut unit_ids = HashSet::new();
    let mut units = Vec::with_capacity(bridge_units.len());
    for (index, unit) in bridge_units.iter().enumerate() {
        let (unit_id, unit) = project_unit(unit, index)?;
        if !unit_ids.insert(unit_id) {
            return Err(bridge_error(
                &format!("units[{index}].bridgeUnitId"),
                "must be unique",
            ));
        }
        units.push(unit);
    }
    Ok(json!({
        "schemaVersion": "utsushi.narrative-structure.v2",
        "engine": ENGINE,
        "entryScene": SCENE_ID,
        "sceneDispatchOrder": [SCENE_ID],
        "bridgeId": bridge_id,
        "sourceBundleHash": source_bundle_hash,
        "scenes": [{
            "sceneId": SCENE_ID,
            "selectionControl": "none",
            "nextScene": null,
            "messages": [],
            "choices": [],
            "units": units,
        }],
    }))
}

fn project_unit(unit: &Value, index: usize) -> Result<(String, Value), Box<dyn Error>> {
    let prefix = format!("units[{index}]");
    let unit = required_object(unit, &prefix)?;
    let bridge_unit_id = required_identifier(unit, &format!("{prefix}.bridgeUnitId"))?;
    let source_unit_key = required_identifier(unit, &format!("{prefix}.sourceUnitKey"))?;
    let surface_kind = required_identifier(unit, &format!("{prefix}.surfaceKind"))?;
    let source_text = required_string(unit, &format!("{prefix}.sourceText"))?;
    let source_asset = required_field_object(unit, "sourceAssetRef", &prefix)?;
    let asset_id = required_identifier(source_asset, &format!("{prefix}.sourceAssetRef.assetId"))?;
    let asset_key =
        required_identifier(source_asset, &format!("{prefix}.sourceAssetRef.assetKey"))?;
    let source_location = required_field_object(unit, "sourceLocation", &prefix)?;
    let source_range = required_source_range(source_location, &prefix)?;
    let link_kind = match surface_kind.as_str() {
        "choice_label" => "choice",
        "dialogue" | "narration" => "line",
        _ => "non-narrative",
    };

    let projected_unit_id = bridge_unit_id.clone();
    Ok((
        projected_unit_id,
        json!({
            "unitId": format!("unit:{bridge_unit_id}"),
            "bridgeRef": {
                "bridgeUnitId": bridge_unit_id,
                "sourceUnitKey": source_unit_key,
            },
            "linkKind": link_kind,
            "surfaceKind": surface_kind,
            "sourceText": source_text,
            "characterId": null,
            "evidenceTier": "E0",
            "color": null,
            "sourceAsset": { "assetId": asset_id, "assetKey": asset_key },
            "engineEvidence": { "sourceRange": source_range },
            "choiceId": if link_kind == "choice" {
                Value::String(format!("choice:{bridge_unit_id}"))
            } else {
                Value::Null
            },
            "playOrder": index,
            "revealOrder": { "sceneOrder": 0, "itemOrder": index },
            "observedLineIds": [],
            "routeMembership": [],
        }),
    ))
}

fn required_source_range(
    location: &Map<String, Value>,
    unit_prefix: &str,
) -> Result<Value, Box<dyn Error>> {
    let field = format!("{unit_prefix}.sourceLocation.range");
    let range = location
        .get("range")
        .ok_or_else(|| bridge_error(&field, "is required"))?;
    let range = required_object(range, &field)?;
    let start = required_nonnegative_integer(range, &format!("{field}.startByte"))?;
    let end = required_nonnegative_integer(range, &format!("{field}.endByte"))?;
    if end <= start {
        return Err(bridge_error(
            &format!("{field}.endByte"),
            &format!("must be greater than {field}.startByte"),
        ));
    }
    Ok(Value::Object(range.clone()))
}

fn required_object<'a>(
    value: &'a Value,
    field: &str,
) -> Result<&'a Map<String, Value>, Box<dyn Error>> {
    value
        .as_object()
        .ok_or_else(|| bridge_error(field, "must be an object"))
}

fn required_field_object<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    parent: &str,
) -> Result<&'a Map<String, Value>, Box<dyn Error>> {
    let field = format!("{parent}.{key}");
    object
        .get(key)
        .and_then(Value::as_object)
        .ok_or_else(|| bridge_error(&field, "must be an object"))
}

fn required_array<'a>(
    object: &'a Map<String, Value>,
    field: &str,
) -> Result<&'a Vec<Value>, Box<dyn Error>> {
    object
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| bridge_error(field, "must be an array"))
}

fn required_string(object: &Map<String, Value>, field: &str) -> Result<String, Box<dyn Error>> {
    let key = field.rsplit('.').next().expect("field always has a key");
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| bridge_error(field, "must be a non-empty string"))
}

fn required_identifier(object: &Map<String, Value>, field: &str) -> Result<String, Box<dyn Error>> {
    let value = required_string(object, field)?;
    is_identifier(&value)
        .then_some(value)
        .ok_or_else(|| bridge_error(field, "must be an ASCII identifier"))
}

fn required_sha256(object: &Map<String, Value>, field: &str) -> Result<String, Box<dyn Error>> {
    let value = required_string(object, field)?;
    is_sha256(&value)
        .then_some(value)
        .ok_or_else(|| bridge_error(field, "must be a sha256 hash"))
}

fn required_nonnegative_integer(
    object: &Map<String, Value>,
    field: &str,
) -> Result<u64, Box<dyn Error>> {
    let key = field.rsplit('.').next().expect("field always has a key");
    object
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| bridge_error(field, "must be a non-negative integer"))
}

fn is_identifier(value: &str) -> bool {
    value.len() <= 256
        && matches!(value.as_bytes().first(), Some(byte) if byte.is_ascii_alphanumeric())
        && value.as_bytes().iter().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'#' | b'/' | b'-')
        })
}

fn is_sha256(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hash| {
        hash.len() == 64
            && hash
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

fn bridge_error(field: &str, detail: &str) -> Box<dyn Error> {
    format!("utsushi.structure.rpg-maker.bridge: {field} {detail}").into()
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::*;

    fn valid_bridge() -> Value {
        json!({
            "schemaVersion": "0.2.0",
            "bridgeId": "bridge:project",
            "sourceBundleHash": format!("sha256:{}", "a".repeat(64)),
            "units": [
                {
                    "bridgeUnitId": "bridge-unit:line",
                    "sourceUnitKey": "source/line",
                    "surfaceKind": "dialogue",
                    "sourceText": "line",
                    "sourceAssetRef": { "assetId": "asset:source", "assetKey": "asset/source" },
                    "sourceLocation": { "range": { "startByte": 0, "endByte": 4 } },
                },
                {
                    "bridgeUnitId": "bridge-unit:choice",
                    "sourceUnitKey": "source/choice",
                    "surfaceKind": "choice_label",
                    "sourceText": "choice",
                    "sourceAssetRef": { "assetId": "asset:source", "assetKey": "asset/source" },
                    "sourceLocation": { "range": { "startByte": 4, "endByte": 10 } },
                },
                {
                    "bridgeUnitId": "bridge-unit:label",
                    "sourceUnitKey": "source/label",
                    "surfaceKind": "ui_label",
                    "sourceText": "label",
                    "sourceAssetRef": { "assetId": "asset:source", "assetKey": "asset/source" },
                    "sourceLocation": { "range": { "startByte": 10, "endByte": 15 } },
                },
            ],
        })
    }

    #[test]
    fn generic_command_projects_the_bridge_source_order() {
        let root = TempDir::new().expect("temporary source root");
        let bridge_path = root.path().join("bridge.json");
        fs::write(
            &bridge_path,
            serde_json::to_vec(&valid_bridge()).expect("serialize bridge"),
        )
        .expect("write bridge");
        let output = root.path().join("structure.json");
        let args = vec![
            "--engine".to_owned(),
            ENGINE.to_owned(),
            "--game-root".to_owned(),
            root.path().to_string_lossy().into_owned(),
            "--bridge".to_owned(),
            bridge_path.to_string_lossy().into_owned(),
            "--adapter-config".to_owned(),
            "{}".to_owned(),
            "--output".to_owned(),
            output.to_string_lossy().into_owned(),
        ];

        super::super::super::run_structure_command(&args).expect("project bridge structure");
        let structure: Value = serde_json::from_slice(&fs::read(output).expect("read structure"))
            .expect("structure is JSON");

        assert_eq!(structure["schemaVersion"], "utsushi.narrative-structure.v2");
        assert_eq!(structure["engine"], ENGINE);
        assert_eq!(structure["bridgeId"], "bridge:project");
        let units = structure["scenes"][0]["units"]
            .as_array()
            .expect("projected units");
        assert_eq!(units.len(), 3);
        assert_eq!(units[0]["linkKind"], "line");
        assert_eq!(units[1]["linkKind"], "choice");
        assert_eq!(units[1]["choiceId"], "choice:bridge-unit:choice");
        assert_eq!(units[2]["linkKind"], "non-narrative");
        assert_eq!(units[2]["engineEvidence"]["sourceRange"]["startByte"], 10);
    }

    #[test]
    fn bridge_requires_a_byte_range_for_every_projected_unit() {
        let mut bridge = valid_bridge();
        bridge["units"][0]["sourceLocation"] = json!({});

        let error = project_bridge(&bridge).expect_err("bridge range is required");

        assert_eq!(
            error.to_string(),
            "utsushi.structure.rpg-maker.bridge: units[0].sourceLocation.range is required"
        );
    }

    #[test]
    fn provider_requires_an_empty_adapter_config() {
        let error = build_structure(StructureCommandInput {
            game_root: "source-root".into(),
            bridge: "bridge.json".into(),
            adapter_config: Some(json!({ "unknown": true })),
        })
        .expect_err("unknown adapter config key must fail");

        assert_eq!(
            error.to_string(),
            "utsushi.structure.rpg-maker.adapter_config: unsupported key \"unknown\""
        );
    }
}
