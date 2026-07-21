//! Deterministic E1 text and choice observation over decoded Siglus scenes.
//!
//! This is a static scene walk, not a live VM: it consumes Kaifuu's decoded
//! `CD_TEXT` / `CD_NAME` surfaces plus linked `GLOBAL.SELBTN` choices in
//! `SceneList` order. Choice branch targets come from Kaifuu's bounded
//! select-to-conditional-jump recognizer; this remains static observation, not
//! a Siglus VM. The string-table transform is applied only to the referenced
//! UTF-16 range; packed scene bytes and key material never cross the port
//! boundary or enter a capture artifact.

use kaifuu_siglus::{
    SiglusSceneIndex, SiglusSecondLayerMaterial, decode_scene_chunk, decode_scene_flow,
    decode_scene_syscalls,
};
use serde::Serialize;
use utsushi_core::substrate::{
    AssetId, EnginePortError, EvidenceTier, LifecycleStage, ObservationBridgeRef, PortRequest,
    TextLine,
};

/// A static, player-facing Siglus selection with its linked branch arms.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusChoiceMoment {
    /// Stable static-observation id for this `GLOBAL.SELBTN` call.
    pub id: String,
    /// SceneList position containing the choice.
    pub scene_id: u32,
    /// Bytecode offset of the `CD_COMMAND` select call.
    pub select_offset: usize,
    /// Player-visible options in their source order.
    pub options: Vec<SiglusChoiceOption>,
}

/// One player-visible option in a [`SiglusChoiceMoment`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusChoiceOption {
    /// Zero-based display order in the selection.
    pub option_index: usize,
    /// Engine result value returned for this option.
    pub result_value: i32,
    /// Decoded UTF-16 label, also emitted through the E1 text sink.
    pub text: String,
    /// Stable bridge `choice_label` source-unit key.
    pub source_unit_key: String,
    /// E1 text-sink line id for this option.
    pub line_id: String,
    /// Resolved conditional-jump bytecode target, when structural decoding
    /// could determine one.
    pub branch_target_offset: Option<usize>,
}

/// An explicit unsupported or incomplete static selection shape.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum SiglusChoiceDiagnostic {
    /// The select call had no decoded positional string labels.
    EmptyOptionSet { scene_id: u32, select_offset: usize },
    /// An option has no recognized select-to-conditional-jump arm.
    UnlinkedOption {
        scene_id: u32,
        select_offset: usize,
        option_index: usize,
    },
    /// A recognized label decodes to the empty string and is not emitted.
    EmptyOptionLabel {
        scene_id: u32,
        select_offset: usize,
        option_index: usize,
    },
    /// A recognized arm's target label did not resolve in the scene.
    UnresolvedBranchTarget {
        scene_id: u32,
        select_offset: usize,
        option_index: usize,
    },
}

/// Static observation data retained across launch and `observe` ticks.
pub(crate) struct StaticObservationProgram {
    pub(crate) scenes: Vec<Vec<TextLine>>,
    pub(crate) choice_moments: Vec<SiglusChoiceMoment>,
    pub(crate) choice_diagnostics: Vec<SiglusChoiceDiagnostic>,
}

struct ChoiceScene<'a> {
    scene_id: u32,
    scene_name: &'a str,
    decoded_scene: &'a [u8],
    source_asset: &'a AssetId,
}

struct ChoiceOutputs<'a> {
    lines: &'a mut Vec<TextLine>,
    moments: &'a mut Vec<SiglusChoiceMoment>,
    diagnostics: &'a mut Vec<SiglusChoiceDiagnostic>,
}

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
) -> Result<StaticObservationProgram, EnginePortError> {
    let mut scenes = Vec::with_capacity(scene_index.entries.len());
    let mut choice_moments = Vec::new();
    let mut choice_diagnostics = Vec::new();

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
        let syscalls = decode_scene_syscalls(&decoded).map_err(|error| {
            lifecycle_error(format!(
                "scene {} choice-surface walk failed: {error}",
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
        append_choice_lines(
            ChoiceScene {
                scene_id: entry.scene_id,
                scene_name: &scene_name,
                decoded_scene: &decoded,
                source_asset: &source_asset,
            },
            syscalls.selections,
            ChoiceOutputs {
                lines: &mut lines,
                moments: &mut choice_moments,
                diagnostics: &mut choice_diagnostics,
            },
        )?;
        scenes.push(lines);
    }

    Ok(StaticObservationProgram {
        scenes,
        choice_moments,
        choice_diagnostics,
    })
}

fn append_choice_lines(
    scene: ChoiceScene<'_>,
    selections: Vec<kaifuu_siglus::SiglusSelChoice>,
    outputs: ChoiceOutputs<'_>,
) -> Result<(), EnginePortError> {
    for selection in selections {
        if selection.options.is_empty() {
            outputs
                .diagnostics
                .push(SiglusChoiceDiagnostic::EmptyOptionSet {
                    scene_id: scene.scene_id,
                    select_offset: selection.call_offset,
                });
            continue;
        }
        let moment_id = format!(
            "siglus:scene-{}:choice:{}",
            scene.scene_name, selection.call_offset
        );
        let mut options = Vec::new();
        for (option_index, option) in selection.options.into_iter().enumerate() {
            if option.structural_arm_index.is_none() {
                outputs
                    .diagnostics
                    .push(SiglusChoiceDiagnostic::UnlinkedOption {
                        scene_id: scene.scene_id,
                        select_offset: selection.call_offset,
                        option_index,
                    });
                continue;
            }
            let text = decode_string_ref(scene.scene_id, scene.decoded_scene, &option.text)?;
            if text.is_empty() {
                outputs
                    .diagnostics
                    .push(SiglusChoiceDiagnostic::EmptyOptionLabel {
                        scene_id: scene.scene_id,
                        select_offset: selection.call_offset,
                        option_index,
                    });
                continue;
            }
            if option.branch_target_offset.is_none() {
                outputs
                    .diagnostics
                    .push(SiglusChoiceDiagnostic::UnresolvedBranchTarget {
                        scene_id: scene.scene_id,
                        select_offset: selection.call_offset,
                        option_index,
                    });
            }
            let source_offset = option
                .source_command_offset
                .unwrap_or(option.text.byte_offset);
            let source_unit_key = format!("siglus:scene-{}#{source_offset}", scene.scene_name);
            let line_id = format!(
                "siglus:{:04}:{:08x}:choice:{option_index}",
                scene.scene_id, selection.call_offset
            );
            outputs.lines.push(TextLine {
                line_id: line_id.clone(),
                evidence_tier: EvidenceTier::E1,
                text: text.clone(),
                speaker: None,
                color: None,
                text_surface: Some(format!("choice:{option_index}")),
                bridge_ref: Some(ObservationBridgeRef {
                    bridge_unit_id: None,
                    source_unit_key: Some(source_unit_key.clone()),
                    runtime_object_id: Some(moment_id.clone()),
                }),
                source_asset: Some(scene.source_asset.clone()),
                byte_offset_in_scene: u32::try_from(option.text.byte_offset).ok(),
                body_shift_jis: None,
            });
            options.push(SiglusChoiceOption {
                option_index,
                result_value: option.result_value,
                text,
                source_unit_key,
                line_id,
                branch_target_offset: option.branch_target_offset,
            });
        }
        if !options.is_empty() {
            outputs.moments.push(SiglusChoiceMoment {
                id: moment_id,
                scene_id: scene.scene_id,
                select_offset: selection.call_offset,
                options,
            });
        }
    }
    Ok(())
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

fn decode_string_ref(
    scene_id: u32,
    decoded_scene: &[u8],
    string: &kaifuu_siglus::SiglusStringRef,
) -> Result<String, EnginePortError> {
    let surface = kaifuu_siglus::SiglusTextSurface {
        site_offset: string.byte_offset,
        is_name: false,
        read_flag: None,
        str_index: Some(string.index),
        str_byte_offset: Some(string.byte_offset),
        str_char_len: Some(string.char_len),
    };
    decode_surface_text(scene_id, decoded_scene, &surface)
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

    #[test]
    fn records_an_explicit_diagnostic_for_an_optionless_selection() {
        let mut lines = Vec::new();
        let mut moments = Vec::new();
        let mut diagnostics = Vec::new();
        let source_asset =
            AssetId::from_parts("fixture", "Scene.pck").expect("valid fixture asset id");
        append_choice_lines(
            ChoiceScene {
                scene_id: 7,
                scene_name: "opening",
                decoded_scene: &[],
                source_asset: &source_asset,
            },
            vec![kaifuu_siglus::SiglusSelChoice {
                call_offset: 42,
                call_index: 0,
                structural_choice_index: None,
                options: Vec::new(),
            }],
            ChoiceOutputs {
                lines: &mut lines,
                moments: &mut moments,
                diagnostics: &mut diagnostics,
            },
        )
        .expect("optionless selection is a diagnostic, not a failure");

        assert!(lines.is_empty());
        assert!(moments.is_empty());
        assert_eq!(
            diagnostics,
            vec![SiglusChoiceDiagnostic::EmptyOptionSet {
                scene_id: 7,
                select_offset: 42,
            }]
        );
    }
}
