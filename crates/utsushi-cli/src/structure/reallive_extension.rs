//! Projection of RealLive-only evidence into the opaque common extension.
//!
//! Replay and bytecode code keeps numeric archive addresses internally.  The
//! exported common graph carries only stable tagged strings; byte coordinates,
//! raw byte handles, Shift-JIS bodies, and Gameexe provenance live under the
//! provider extension so another engine never has to emulate this format.

use serde_json::{Map, Value, json};

pub(super) fn common_structure(mut structure: Value) -> Result<Value, String> {
    let root = object_mut(&mut structure, "structure root")?;
    root.insert("engine".to_string(), Value::String("reallive".to_string()));
    root.insert(
        "engineEvidence".to_string(),
        json!({
            "reallive": {
                "gameexe": {
                    "entrySceneSource": "SEEN_START",
                    "speakerResolver": "#NAMAE",
                    "colorTable": "#COLOR_TABLE"
                }
            }
        }),
    );
    scene_id_field(root, "entryScene")?;
    scene_id_array(root, "sceneDispatchOrder")?;

    if let Some(routes) = root.get_mut("routes").and_then(Value::as_array_mut) {
        for route in routes {
            let route = object_mut(route, "route")?;
            scene_id_field(route, "entrySceneId")?;
            scene_id_array(route, "sceneIds")?;
        }
    }
    if let Some(edges) = root.get_mut("edges").and_then(Value::as_array_mut) {
        for edge in edges {
            let edge = object_mut(edge, "edge")?;
            scene_id_field(edge, "fromSceneId")?;
            scene_id_field(edge, "toSceneId")?;
        }
    }
    if let Some(scenes) = root.get_mut("scenes").and_then(Value::as_array_mut) {
        for scene in scenes {
            common_scene(scene)?;
        }
    }
    Ok(structure)
}

fn common_scene(scene: &mut Value) -> Result<(), String> {
    let scene = object_mut(scene, "scene")?;
    scene_id_field(scene, "sceneId")?;
    scene_id_field(scene, "nextScene")?;
    for field in ["dispatchFanoutScenes", "predecessors", "successors"] {
        scene_id_array(scene, field)?;
    }
    if let Some(messages) = scene.get_mut("messages").and_then(Value::as_array_mut) {
        for message in messages {
            move_reallive_evidence(message)?;
        }
    }
    if let Some(units) = scene.get_mut("units").and_then(Value::as_array_mut) {
        for unit in units {
            move_reallive_evidence(unit)?;
        }
    }
    if let Some(choices) = scene.get_mut("choices").and_then(Value::as_array_mut) {
        for choice in choices {
            let choice = object_mut(choice, "choice")?;
            scene_id_field(choice, "branchEntryScene")?;
            scene_id_field(choice, "branchTargetSceneId")?;
            move_reallive_evidence_object(choice);
            if let Some(messages) = choice
                .get_mut("branchMessages")
                .and_then(Value::as_array_mut)
            {
                for message in messages {
                    move_reallive_evidence(message)?;
                }
            }
        }
    }
    Ok(())
}

fn move_reallive_evidence(value: &mut Value) -> Result<(), String> {
    let object = object_mut(value, "narrative element")?;
    move_reallive_evidence_object(object);
    Ok(())
}

fn move_reallive_evidence_object(object: &mut Map<String, Value>) {
    let mut evidence = Map::new();
    for field in [
        "byteOffsetInScene",
        "byteLength",
        "rawByteHandle",
        "bodyShiftJisHex",
    ] {
        if let Some(value) = object.remove(field) {
            evidence.insert(field.to_string(), value);
        }
    }
    if !evidence.is_empty() {
        object.insert(
            "engineEvidence".to_string(),
            json!({ "reallive": evidence }),
        );
    }
}

fn scene_id_field(object: &mut Map<String, Value>, field: &str) -> Result<(), String> {
    let Some(value) = object.get_mut(field) else {
        return Ok(());
    };
    if value.is_null() {
        return Ok(());
    }
    *value = tagged_scene_id(value)?;
    Ok(())
}

fn scene_id_array(object: &mut Map<String, Value>, field: &str) -> Result<(), String> {
    let Some(values) = object.get_mut(field).and_then(Value::as_array_mut) else {
        return Ok(());
    };
    for value in values {
        *value = tagged_scene_id(value)?;
    }
    Ok(())
}

fn tagged_scene_id(value: &Value) -> Result<Value, String> {
    let scene = value
        .as_u64()
        .ok_or_else(|| format!("expected numeric internal scene id, found {value}"))?;
    Ok(Value::String(format!("scene:{scene:04}")))
}

fn object_mut<'a>(value: &'a mut Value, label: &str) -> Result<&'a mut Map<String, Value>, String> {
    value
        .as_object_mut()
        .ok_or_else(|| format!("{label} must be a JSON object"))
}
