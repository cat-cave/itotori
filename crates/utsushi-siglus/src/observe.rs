//! Deterministic E1 text observation over decoded Siglus scenes.
//!
//! This is a static scene walk, not a live VM: it consumes Kaifuu's decoded
//! `CD_TEXT` / `CD_NAME` surfaces in `SceneList` order and prepares one
//! substrate [`TextLine`] per surface. The string-table transform is applied
//! only to the referenced UTF-16 range; packed scene bytes and key material
//! never cross the port boundary or enter a capture artifact.

use kaifuu_siglus::{
    SiglusSceneIndex, SiglusSecondLayerMaterial, decode_scene_chunk, decode_scene_flow,
};
use utsushi_core::substrate::{
    AssetId, EnginePortError, EvidenceTier, LifecycleStage, ObservationBridgeRef, PortRequest,
    TextLine,
};

/// Build the deterministic, static text program for one decoded scene pack.
///
/// Surface keys intentionally use the exact `siglus-13` bridge address:
/// `siglus:scene-{packed-name}#{command-offset}`. The runtime owns no bridge
/// bundle, so it carries this stable resolving key rather than inventing a
/// bridge-unit id at observation time. Scene boundaries are retained so the
/// E1 port can consume a finite decoded scene per observation step instead of
/// making one runner tick per text surface.
pub(crate) fn build_static_scene_text_program(
    scene_pack: &[u8],
    scene_index: &SiglusSceneIndex,
    second_layer: Option<&SiglusSecondLayerMaterial>,
    source_asset: AssetId,
    request: &PortRequest<'_>,
) -> Result<Vec<Vec<TextLine>>, EnginePortError> {
    let mut scenes = Vec::with_capacity(scene_index.entries.len());

    for entry in &scene_index.entries {
        request.cancellation.check(LifecycleStage::Launch)?;
        let start = usize::try_from(entry.byte_offset).map_err(|_| {
            lifecycle_error(format!(
                "scene {} offset cannot be addressed",
                entry.scene_id
            ))
        })?;
        let len = usize::try_from(entry.byte_len).map_err(|_| {
            lifecycle_error(format!(
                "scene {} length cannot be addressed",
                entry.scene_id
            ))
        })?;
        let end = start.checked_add(len).ok_or_else(|| {
            lifecycle_error(format!("scene {} byte range overflows", entry.scene_id))
        })?;
        let chunk = scene_pack.get(start..end).ok_or_else(|| {
            lifecycle_error(format!(
                "scene {} byte range is unavailable",
                entry.scene_id
            ))
        })?;
        let decoded = decode_scene_chunk(
            entry.scene_id,
            chunk,
            scene_index.extra_key_use,
            second_layer,
        )
        .map_err(|error| {
            lifecycle_error(format!("scene {} decode failed: {error}", entry.scene_id))
        })?;
        let flow = decode_scene_flow(&decoded).map_err(|error| {
            lifecycle_error(format!(
                "scene {} text-surface walk failed: {error}",
                entry.scene_id
            ))
        })?;
        let scene_name = entry
            .scene_name
            .as_deref()
            .filter(|name| !name.is_empty())
            .map_or_else(|| format!("{:04}", entry.scene_id), ToOwned::to_owned);

        let mut lines = Vec::with_capacity(flow.text_surfaces.len());
        for surface in flow.text_surfaces {
            let text = decode_surface_text(entry.scene_id, &decoded, &surface)?;
            let surface_label = if surface.is_name {
                "speaker_name"
            } else {
                "dialogue"
            };
            let source_unit_key = format!("siglus:scene-{scene_name}#{}", surface.site_offset);
            let byte_offset_in_scene = surface
                .str_byte_offset
                .and_then(|offset| u32::try_from(offset).ok());
            lines.push(TextLine {
                line_id: format!(
                    "siglus:{:04}:{:08x}:{surface_label}",
                    entry.scene_id, surface.site_offset
                ),
                evidence_tier: EvidenceTier::E1,
                text,
                speaker: None,
                color: None,
                text_surface: Some(surface_label.to_string()),
                bridge_ref: Some(ObservationBridgeRef {
                    bridge_unit_id: None,
                    source_unit_key: Some(source_unit_key),
                    runtime_object_id: None,
                }),
                source_asset: Some(source_asset.clone()),
                byte_offset_in_scene,
                body_shift_jis: None,
            });
        }
        scenes.push(lines);
    }

    Ok(scenes)
}

fn decode_surface_text(
    scene_id: u32,
    decoded_scene: &[u8],
    surface: &kaifuu_siglus::SiglusTextSurface,
) -> Result<String, EnginePortError> {
    let (Some(index), Some(byte_offset), Some(char_len)) = (
        surface.str_index,
        surface.str_byte_offset,
        surface.str_char_len,
    ) else {
        return Err(lifecycle_error(format!(
            "scene {scene_id} text surface at {} has no literal string reference",
            surface.site_offset
        )));
    };
    if index < 0 || char_len < 0 {
        return Err(lifecycle_error(format!(
            "scene {scene_id} text surface at {} has an invalid string reference",
            surface.site_offset
        )));
    }
    let byte_len = usize::try_from(char_len)
        .ok()
        .and_then(|length| length.checked_mul(2))
        .ok_or_else(|| {
            lifecycle_error(format!(
                "scene {scene_id} text surface at {} has an invalid string length",
                surface.site_offset
            ))
        })?;
    let end = byte_offset.checked_add(byte_len).ok_or_else(|| {
        lifecycle_error(format!(
            "scene {scene_id} text surface at {} overflows its string range",
            surface.site_offset
        ))
    })?;
    let raw = decoded_scene.get(byte_offset..end).ok_or_else(|| {
        lifecycle_error(format!(
            "scene {scene_id} text surface at {} exceeds the decoded scene",
            surface.site_offset
        ))
    })?;

    // The engine masks each UTF-16 code unit with `28807 * str_index`; this is
    // an involution and is applied before the terminating NUL is interpreted.
    let key = 28807u16.wrapping_mul(index as u16);
    let mut units = Vec::with_capacity(raw.len() / 2);
    for pair in raw.chunks_exact(2) {
        let unit = u16::from_le_bytes([pair[0], pair[1]]) ^ key;
        if unit == 0 {
            break;
        }
        units.push(unit);
    }
    Ok(String::from_utf16_lossy(&units))
}

fn lifecycle_error(message: String) -> EnginePortError {
    EnginePortError::Lifecycle {
        stage: LifecycleStage::Launch,
        message: format!("siglus static observation preparation failed: {message}"),
        source: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_xor_masked_utf16_string_table_entry() {
        let index = 3_i32;
        let key = 28807u16.wrapping_mul(index as u16);
        let plain = ['テ', 'ス', 'ト', '\0'];
        let mut scene = Vec::new();
        for unit in plain.map(|character| character as u16) {
            scene.extend_from_slice(&(unit ^ key).to_le_bytes());
        }
        let surface = kaifuu_siglus::SiglusTextSurface {
            site_offset: 12,
            is_name: false,
            read_flag: Some(0),
            str_index: Some(index),
            str_byte_offset: Some(0),
            str_char_len: Some(4),
        };

        assert_eq!(
            decode_surface_text(0, &scene, &surface).expect("decode XOR text"),
            "テスト"
        );
    }
}
