use kaifuu_core::LocalizationUnitV02;

use super::PatchbackError;

pub(super) fn parse_source_key(key: &str) -> Result<(String, usize), PatchbackError> {
    let rest =
        key.strip_prefix("siglus:scene-")
            .ok_or_else(|| PatchbackError::ProvenanceMismatch {
                source_unit_key: key.to_string(),
                reason: "missing siglus:scene- prefix".into(),
            })?;
    let (scene, site) =
        rest.rsplit_once('#')
            .ok_or_else(|| PatchbackError::ProvenanceMismatch {
                source_unit_key: key.to_string(),
                reason: "missing #command-offset suffix".into(),
            })?;
    let site = site
        .parse::<usize>()
        .map_err(|_| PatchbackError::ProvenanceMismatch {
            source_unit_key: key.to_string(),
            reason: "command-offset suffix is not decimal".into(),
        })?;
    if scene.is_empty() {
        return Err(PatchbackError::ProvenanceMismatch {
            source_unit_key: key.to_string(),
            reason: "scene name is empty".into(),
        });
    }
    Ok((scene.to_string(), site))
}

pub(super) fn parse_location(
    unit: &LocalizationUnitV02,
    scene_name: &str,
) -> Result<(i32, usize, usize), PatchbackError> {
    let bad = |reason: &str| PatchbackError::ProvenanceMismatch {
        source_unit_key: unit.source_unit_key.clone(),
        reason: reason.to_string(),
    };
    let location = unit
        .source_location
        .as_object()
        .ok_or_else(|| bad("sourceLocation is not an object"))?;
    if location
        .get("containerKey")
        .and_then(serde_json::Value::as_str)
        != Some(format!("siglus:scene-{scene_name}").as_str())
    {
        return Err(bad(
            "sourceLocation.containerKey disagrees with sourceUnitKey",
        ));
    }
    let path = location
        .get("entryPath")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| bad("sourceLocation.entryPath is not an array"))?;
    let index = path
        .get(3)
        .and_then(serde_json::Value::as_str)
        .and_then(|value| value.parse::<i32>().ok())
        .filter(|index| *index >= 0)
        .ok_or_else(|| bad("sourceLocation.entryPath has no non-negative string index"))?;
    let shape_ok = path.len() == 4
        && path[0].as_str() == Some("scene")
        && path[1].as_str() == Some(scene_name)
        && path[2].as_str() == Some("string-table");
    if !shape_ok {
        return Err(bad(
            "sourceLocation.entryPath is not the canonical Siglus string-table path",
        ));
    }
    let range = location
        .get("range")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| bad("sourceLocation.range is not an object"))?;
    let start = range
        .get("startByte")
        .and_then(serde_json::Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| bad("sourceLocation.range.startByte is invalid"))?;
    let end = range
        .get("endByte")
        .and_then(serde_json::Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| bad("sourceLocation.range.endByte is invalid"))?;
    if end <= start {
        return Err(bad("sourceLocation range is empty or reversed"));
    }
    Ok((index, start, end))
}

pub(super) fn scene_identity(entry: &crate::archive::SiglusSceneEntry) -> String {
    entry
        .scene_name
        .clone()
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| format!("{:04}", entry.scene_id))
}
