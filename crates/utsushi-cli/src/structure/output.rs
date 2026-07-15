use std::collections::BTreeMap;

use kaifuu_reallive::{RealLiveOpcode, parse_scene};
use serde_json::{Value, json};
use utsushi_core::TextLine;
use utsushi_reallive::SceneId;

use super::bridge::BridgeUnit;
use super::graph::{self, Edge, GraphFacts};

const OP_SELECT_OBJBTN: u16 = 4;
const OP_OBJBTN_INIT: u16 = 20;
const OP_SELECT_OBJBTN_CANCEL: u16 = 14;

pub(super) fn message_value(
    order: usize,
    line: &TextLine,
    unit: &BridgeUnit,
) -> Result<Value, String> {
    let serialized = serde_json::to_value(line).map_err(|err| err.to_string())?;
    let mut bridge_ref = unit.bridge_ref();
    bridge_ref["runtimeObjectId"] = json!(line.line_id);
    Ok(json!({
        "order": order,
        "playOrder": order,
        "revealOrder": null,
        "speaker": line.speaker,
        "characterId": unit.character_id,
        "text": line.text,
        "textSurface": line.text_surface,
        "lineId": line.line_id,
        "evidenceTier": serialized["evidenceTier"],
        "color": line.color,
        "bridgeDeclaredColor": unit.color,
        "sourceAsset": unit.source_asset,
        "byteOffsetInScene": unit.byte_start,
        "byteLength": unit.byte_end.saturating_sub(unit.byte_start),
        "rawByteHandle": unit.raw_byte_handle(),
        "bodyShiftJisHex": serialized.get("bodyShiftJisHex").cloned().unwrap_or(Value::Null),
        "bridgeRef": bridge_ref,
        "linkageStatus": "bridge_linked",
        "routeMembership": [],
    }))
}

pub(super) fn runtime_only_message_value(
    order: usize,
    line: &TextLine,
    source_asset: &Value,
) -> Result<Value, String> {
    let serialized = serde_json::to_value(line).map_err(|err| err.to_string())?;
    let offset = line.byte_offset_in_scene.map(u64::from);
    let byte_length = line.body_shift_jis.as_ref().map(Vec::len);
    let raw_byte_handle = offset.zip(byte_length).and_then(|(start, length)| {
        let asset_id = source_asset["assetId"].as_str()?;
        Some(format!("raw:{asset_id}:{start}:{}", start + length as u64))
    });
    Ok(json!({
        "order": order,
        "playOrder": order,
        "revealOrder": null,
        "speaker": line.speaker,
        "characterId": null,
        "text": line.text,
        "textSurface": line.text_surface,
        "lineId": line.line_id,
        "evidenceTier": serialized["evidenceTier"],
        "color": line.color,
        "sourceAsset": source_asset,
        "byteOffsetInScene": offset,
        "byteLength": byte_length,
        "rawByteHandle": raw_byte_handle,
        "bodyShiftJisHex": serialized.get("bodyShiftJisHex").cloned().unwrap_or(Value::Null),
        "bridgeRef": null,
        "linkageStatus": "runtime_only",
        "runtimeOnlyReason": "no BridgeUnit exists for this runtime surface",
        "routeMembership": [],
    }))
}

pub(super) fn unit_value(unit: &BridgeUnit, messages: &[Value]) -> Value {
    let observed: Vec<&Value> = messages
        .iter()
        .filter(|message| message["bridgeRef"]["bridgeUnitId"].as_str() == Some(unit.id.as_str()))
        .collect();
    let line_ids: Vec<&str> = observed
        .iter()
        .filter_map(|message| message["lineId"].as_str())
        .collect();
    let play_order = observed
        .first()
        .and_then(|message| message["playOrder"].as_u64());
    let evidence_tier = observed
        .first()
        .map_or(Value::Null, |message| message["evidenceTier"].clone());
    json!({
        "unitId": unit.id,
        "bridgeRef": unit.bridge_ref(),
        "surfaceKind": unit.surface_kind,
        "sourceText": unit.source_text,
        "characterId": unit.character_id,
        "evidenceTier": evidence_tier,
        "color": observed.first().map_or(Value::Null, |message| message["color"].clone()),
        "bridgeDeclaredColor": unit.color,
        "sourceAsset": unit.source_asset,
        "byteOffsetInScene": unit.byte_start,
        "byteLength": unit.byte_end.saturating_sub(unit.byte_start),
        "rawByteHandle": unit.raw_byte_handle(),
        "choiceId": unit.choice.as_ref().map(|choice| choice.choice_id.as_str()),
        "playOrder": play_order,
        "revealOrder": null,
        "observedLineIds": line_ids,
        "routeMembership": [],
    })
}

pub(super) fn selection_control_signal(bytecode: &[u8]) -> Result<&'static str, String> {
    let ops = parse_scene(bytecode)
        .map_err(|err| format!("selection-control bytecode decode failed: {err}"))?;
    let mut has_button_object = false;
    let mut has_text_choice = false;
    for op in &ops {
        match op {
            RealLiveOpcode::SelectionControl { opcode }
                if matches!(
                    *opcode,
                    OP_SELECT_OBJBTN | OP_OBJBTN_INIT | OP_SELECT_OBJBTN_CANCEL
                ) =>
            {
                has_button_object = true;
            }
            RealLiveOpcode::Choice { .. } => has_text_choice = true,
            _ => {}
        }
    }
    Ok(if has_button_object {
        "button-object"
    } else if has_text_choice {
        "text-window"
    } else {
        "none"
    })
}

pub(super) fn enrich_scenes(
    scenes: &mut [Value],
    edges: &[Edge],
    facts: &GraphFacts,
) -> Result<(), String> {
    for scene in scenes {
        let scene_id = u16::try_from(
            scene["sceneId"]
                .as_u64()
                .ok_or("sceneId must be unsigned")?,
        )
        .map_err(|err| err.to_string())?;
        let memberships = facts
            .route_membership
            .get(&scene_id)
            .cloned()
            .unwrap_or_default();
        scene["dispatchFanoutScenes"] = json!(graph::resolved_fanout(edges, scene_id));
        scene["predecessors"] = json!(
            facts
                .predecessors
                .get(&scene_id)
                .cloned()
                .unwrap_or_default()
        );
        scene["successors"] = json!(facts.successors.get(&scene_id).cloned().unwrap_or_default());
        scene["reachable"] = json!(facts.reachable.contains(&scene_id));
        scene["routeMembership"] = json!(memberships);

        let reveal_scene = scene["revealOrder"].as_u64();
        let route_membership = scene["routeMembership"].clone();
        for key in ["messages", "units"] {
            let values = scene[key]
                .as_array_mut()
                .ok_or_else(|| format!("scene {scene_id} {key} must be an array"))?;
            for value in values {
                value["routeMembership"] = route_membership.clone();
                if let Some(scene_order) = reveal_scene {
                    let item_order = value["playOrder"].as_u64();
                    value["revealOrder"] = match item_order {
                        Some(item_order) => json!({
                            "sceneOrder": scene_order,
                            "itemOrder": item_order,
                        }),
                        None => Value::Null,
                    };
                }
            }
        }
    }
    Ok(())
}

pub(super) fn fill_branch_messages(scenes: &mut [Value]) -> Result<(), String> {
    let messages_by_scene: BTreeMap<SceneId, Vec<Value>> = scenes
        .iter()
        .map(|scene| {
            let scene_id = u16::try_from(scene["sceneId"].as_u64().unwrap_or_default())
                .map_err(|err| err.to_string())?;
            let messages = scene["messages"]
                .as_array()
                .ok_or("messages must be an array")?
                .clone();
            Ok((scene_id, messages))
        })
        .collect::<Result<_, String>>()?;
    for scene in scenes {
        let choices = scene["choices"]
            .as_array_mut()
            .ok_or("choices must be an array")?;
        for choice in choices {
            if let Some(target) = choice["branchTargetSceneId"].as_u64() {
                let target = u16::try_from(target).map_err(|err| err.to_string())?;
                choice["branchMessages"] =
                    json!(messages_by_scene.get(&target).cloned().unwrap_or_default());
            }
        }
    }
    Ok(())
}
