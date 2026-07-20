use std::collections::{BTreeMap, BTreeSet};

use crate::{
    GameexeDatReport, GameexeInventory, SiglusSelChoice, SiglusStringRef, SiglusTextSurface,
    decode_scene_flow, decode_scene_syscalls,
};

use super::ids::scene_namespace;
use super::json::{produce_json_bundle, source_unit_key};
use super::model::{
    BridgeOpts, BridgeProduceError, BridgeSceneInput, ProducedBundle, inventory_from_report,
};

#[derive(Debug, Clone)]
pub(super) enum SpeakerResolution {
    Known {
        display_name: String,
        canonical_ref: String,
    },
    ParserUnknown {
        raw: String,
    },
    NotApplicable,
}

#[derive(Debug, Clone)]
pub(super) struct ProtoUnit {
    pub(super) surface_kind: &'static str,
    pub(super) command_offset: usize,
    pub(super) source_key_offset: usize,
    pub(super) string_index: i32,
    pub(super) literal_byte_offset: usize,
    pub(super) literal_byte_len: usize,
    pub(super) source_text: String,
    pub(super) speaker: SpeakerResolution,
    pub(super) choice: Option<ChoiceLink>,
    pub(super) ordinal: usize,
}

#[derive(Debug, Clone)]
pub(super) struct ChoiceLink {
    pub(super) select_offset: usize,
    pub(super) option_index: usize,
    pub(super) result_value: i32,
    pub(super) branch_target_offset: Option<usize>,
}

pub(super) struct SceneParts<'a> {
    pub(super) scene_id: u32,
    pub(super) scene_name: String,
    pub(super) scene_bytes: &'a [u8],
    pub(super) units: Vec<ProtoUnit>,
}

/// Assemble one decoded scene.  This compatibility entry point uses the
/// zero-padded SceneList id when a caller has not retained the packed name.
pub fn produce_bundle(
    scene_id: u32,
    scene_bytes: &[u8],
    decoded_scene: &[u8],
    gameexe_report: &GameexeDatReport,
    opts: &BridgeOpts<'_>,
) -> Result<ProducedBundle, BridgeProduceError> {
    let inventory = inventory_from_report(gameexe_report);
    let scene_name = format!("{scene_id:04}");
    let parts = collect_scene_parts(
        scene_id,
        &scene_name,
        scene_bytes,
        decoded_scene,
        &inventory,
    )?;
    if parts.units.is_empty() {
        return Err(BridgeProduceError::NoTextUnits { scene_id });
    }
    let namespace = scene_namespace(opts.game_id, opts.source_profile_id, &scene_name);
    produce_json_bundle(scene_bytes, &namespace, vec![parts], opts)
}

/// Assemble all decoded SceneList entries into one bridge.  Scene names from
/// the `Scene.pck` directory are retained in source keys; numeric ids are only
/// a lossless fallback for an absent packed name.
pub fn produce_scene_pack_bundle(
    scene_pck_bytes: &[u8],
    scenes: &[BridgeSceneInput<'_>],
    gameexe_inventory: &GameexeInventory,
    opts: &BridgeOpts<'_>,
) -> Result<ProducedBundle, BridgeProduceError> {
    let mut parts = Vec::with_capacity(scenes.len());
    let mut total_units = 0_usize;
    for scene in scenes {
        let fallback_name = format!("{:04}", scene.scene_id);
        let scene_name = scene
            .scene_name
            .filter(|name| !name.is_empty())
            .unwrap_or(&fallback_name);
        let scene_parts = collect_scene_parts(
            scene.scene_id,
            scene_name,
            scene.scene_bytes,
            scene.decoded_scene,
            gameexe_inventory,
        )?;
        total_units += scene_parts.units.len();
        parts.push(scene_parts);
    }
    if total_units == 0 {
        return Err(BridgeProduceError::WholePackNoTextUnits {
            scene_count: scenes.len(),
        });
    }
    let namespace = format!(
        "siglus-bridge:game-id={}:source-profile-id={}:whole-scene-pack",
        opts.game_id, opts.source_profile_id
    );
    produce_json_bundle(scene_pck_bytes, &namespace, parts, opts)
}

/// Alias retained for callers that name the archive rather than its file.
pub fn produce_whole_scene_pack_bundle(
    scene_pck_bytes: &[u8],
    scenes: &[BridgeSceneInput<'_>],
    gameexe_inventory: &GameexeInventory,
    opts: &BridgeOpts<'_>,
) -> Result<ProducedBundle, BridgeProduceError> {
    produce_scene_pack_bundle(scene_pck_bytes, scenes, gameexe_inventory, opts)
}

fn collect_scene_parts<'a>(
    scene_id: u32,
    scene_name: &str,
    scene_bytes: &'a [u8],
    decoded_scene: &[u8],
    inventory: &GameexeInventory,
) -> Result<SceneParts<'a>, BridgeProduceError> {
    if decoded_scene.is_empty() {
        return Err(BridgeProduceError::EmptyScene { scene_id });
    }
    let flow = decode_scene_flow(decoded_scene)?;
    let syscalls = decode_scene_syscalls(decoded_scene)?;
    let registry = speaker_registry(inventory);
    let mut events = Vec::with_capacity(flow.text_surfaces.len() + syscalls.selections.len());
    events.extend(
        flow.text_surfaces
            .iter()
            .enumerate()
            .map(|(index, surface)| (surface.site_offset, 0_u8, index)),
    );
    events.extend(
        syscalls
            .selections
            .iter()
            .enumerate()
            // `GLOBAL.SELBTN` is a callable surface, not by itself proof that
            // every string argument is player-visible text.  Only the
            // siglus-10-recognized select -> conditional-jump shape is a
            // Bridge choice surface; control arguments remain raw bytes.
            .filter(|(_, selection)| selection.structural_choice_index.is_some())
            .map(|(index, selection)| (selection.call_offset, 1_u8, index)),
    );
    events.sort_unstable();

    let mut current_speaker = SpeakerResolution::NotApplicable;
    let mut units = Vec::new();
    for (offset, kind, index) in events {
        match kind {
            0 => collect_surface(
                scene_id,
                decoded_scene,
                &flow.text_surfaces[index],
                &registry,
                &mut current_speaker,
                &mut units,
            )?,
            1 => collect_selection(
                scene_id,
                decoded_scene,
                &syscalls.selections[index],
                &mut units,
            )?,
            _ => unreachable!(),
        }
        let _ = offset;
    }
    for (ordinal, unit) in units.iter_mut().enumerate() {
        unit.ordinal = ordinal;
    }
    ensure_unique_source_keys(scene_id, scene_name, &units)?;
    Ok(SceneParts {
        scene_id,
        scene_name: scene_name.to_string(),
        scene_bytes,
        units,
    })
}

fn collect_surface(
    scene_id: u32,
    decoded_scene: &[u8],
    surface: &SiglusTextSurface,
    registry: &BTreeMap<String, SpeakerResolution>,
    current_speaker: &mut SpeakerResolution,
    units: &mut Vec<ProtoUnit>,
) -> Result<(), BridgeProduceError> {
    let literal = literal_from_surface(scene_id, decoded_scene, surface)?;
    if surface.is_name {
        *current_speaker = if literal.text.is_empty() {
            SpeakerResolution::NotApplicable
        } else {
            registry.get(&literal.text).cloned().unwrap_or_else(|| {
                SpeakerResolution::ParserUnknown {
                    raw: literal.text.clone(),
                }
            })
        };
        if literal.text.is_empty() {
            return Ok(());
        }
        units.push(ProtoUnit {
            surface_kind: "speaker_name",
            command_offset: surface.site_offset,
            source_key_offset: surface.site_offset,
            string_index: literal.index,
            literal_byte_offset: literal.byte_offset,
            literal_byte_len: literal.byte_len,
            source_text: literal.text,
            speaker: current_speaker.clone(),
            choice: None,
            ordinal: 0,
        });
    } else if !literal.text.is_empty() {
        units.push(ProtoUnit {
            surface_kind: "dialogue",
            command_offset: surface.site_offset,
            source_key_offset: surface.site_offset,
            string_index: literal.index,
            literal_byte_offset: literal.byte_offset,
            literal_byte_len: literal.byte_len,
            source_text: literal.text,
            speaker: current_speaker.clone(),
            choice: None,
            ordinal: 0,
        });
    }
    Ok(())
}

fn collect_selection(
    scene_id: u32,
    decoded_scene: &[u8],
    selection: &SiglusSelChoice,
    units: &mut Vec<ProtoUnit>,
) -> Result<(), BridgeProduceError> {
    for (option_index, option) in selection.options.iter().enumerate() {
        // A selection call can carry string-valued control arguments.  The
        // syscall decoder categorizes a player-visible label by matching its
        // result value to a siglus-10 dispatch arm.  Do not decode arbitrary
        // string-table entries merely because they were arguments to SELBTN.
        if option.structural_arm_index.is_none() {
            continue;
        }
        let literal = literal_from_string_ref(scene_id, decoded_scene, &option.text)?;
        if literal.text.is_empty() {
            continue;
        }
        // A selection command owns multiple labels. The source push site is
        // their distinct command-byte coordinate; `choice.selectSyscallSite`
        // below links every label back to the shared select and dispatch arm.
        units.push(ProtoUnit {
            surface_kind: "choice_label",
            command_offset: selection.call_offset,
            // Prefer the option's push-site command coordinate; when the sel
            // decoder did not record one, the option's own text-literal byte
            // offset is a stable, unique per-option coordinate for the source key.
            source_key_offset: option.source_command_offset.unwrap_or(literal.byte_offset),
            string_index: literal.index,
            literal_byte_offset: literal.byte_offset,
            literal_byte_len: literal.byte_len,
            source_text: literal.text,
            speaker: SpeakerResolution::NotApplicable,
            choice: Some(ChoiceLink {
                select_offset: selection.call_offset,
                option_index,
                result_value: option.result_value,
                branch_target_offset: option.branch_target_offset,
            }),
            ordinal: 0,
        });
    }
    Ok(())
}

struct Literal {
    index: i32,
    byte_offset: usize,
    byte_len: usize,
    text: String,
}

fn literal_from_surface(
    scene_id: u32,
    decoded_scene: &[u8],
    surface: &SiglusTextSurface,
) -> Result<Literal, BridgeProduceError> {
    let (Some(index), Some(byte_offset), Some(char_len)) = (
        surface.str_index,
        surface.str_byte_offset,
        surface.str_char_len,
    ) else {
        return Err(BridgeProduceError::UnlocatedString {
            scene_id,
            command_offset: surface.site_offset,
        });
    };
    literal_from_parts(scene_id, decoded_scene, index, byte_offset, char_len)
}

fn literal_from_string_ref(
    scene_id: u32,
    decoded_scene: &[u8],
    string: &SiglusStringRef,
) -> Result<Literal, BridgeProduceError> {
    literal_from_parts(
        scene_id,
        decoded_scene,
        string.index,
        string.byte_offset,
        string.char_len,
    )
}

fn literal_from_parts(
    scene_id: u32,
    decoded_scene: &[u8],
    index: i32,
    byte_offset: usize,
    char_len: i32,
) -> Result<Literal, BridgeProduceError> {
    let byte_len = usize::try_from(char_len)
        .ok()
        .and_then(|length| length.checked_mul(2))
        .ok_or(BridgeProduceError::InvalidStringRange {
            scene_id,
            string_index: index,
        })?;
    let raw = decoded_scene
        .get(byte_offset..byte_offset.saturating_add(byte_len))
        .ok_or(BridgeProduceError::InvalidStringRange {
            scene_id,
            string_index: index,
        })?;
    // Siglus string-table text is XOR-encrypted per-u16 with key = 28807 * str_index,
    // null-terminated, then decoded UTF-16LE (lossy) — mirroring the reference VM
    // (siglus_rs siglus_scene_vm/src/scene_stream.rs:392-405).
    let key = 28807u16.wrapping_mul(index as u16);
    let mut units = Vec::with_capacity(raw.len() / 2);
    for pair in raw.chunks_exact(2) {
        let w = u16::from_le_bytes([pair[0], pair[1]]) ^ key;
        if w == 0 {
            break;
        }
        units.push(w);
    }
    let text = String::from_utf16_lossy(&units);
    Ok(Literal {
        index,
        byte_offset,
        byte_len,
        text,
    })
}

fn speaker_registry(inventory: &GameexeInventory) -> BTreeMap<String, SpeakerResolution> {
    let mut speakers = BTreeMap::new();
    for entry in inventory.entries_in_category("NAMAE") {
        let Some(display_name) = gameexe_display_name(&entry.value) else {
            continue;
        };
        speakers
            .entry(display_name.clone())
            .or_insert(SpeakerResolution::Known {
                display_name,
                canonical_ref: entry.key.clone(),
            });
    }
    speakers
}

fn gameexe_display_name(value: &str) -> Option<String> {
    let value = value.trim();
    let display = if let Some(rest) = value.strip_prefix('"') {
        rest.split_once('"').map_or(rest, |(head, _)| head)
    } else {
        value.split_once(',').map_or(value, |(head, _)| head).trim()
    };
    (!display.is_empty()).then(|| display.to_string())
}

fn ensure_unique_source_keys(
    scene_id: u32,
    scene_name: &str,
    units: &[ProtoUnit],
) -> Result<(), BridgeProduceError> {
    let mut seen = BTreeSet::new();
    for unit in units {
        let key = source_unit_key(scene_name, unit.source_key_offset);
        if !seen.insert(key.clone()) {
            return Err(BridgeProduceError::DuplicateSourceUnitKey {
                scene_id,
                source_unit_key: key,
            });
        }
    }
    Ok(())
}
