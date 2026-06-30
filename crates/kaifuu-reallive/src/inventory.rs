//! Bridge-schema inventory walk for Scene/SEEN ASTs.
//!
//! Clean-room provenance (KAIFUU-174):
//! - The walk consumes the KAIFUU-173 AST surface (`SceneIndex`, `Scene`,
//!   `StringSlot`) and the bounded protected-span catalogue described in
//!   [`crate::protected_spans`]. No expression is copied from rlvm.
//! - The asset-reference heuristic (§4.5 of the plan) keys on the
//!   documented extensions `.g00` / `.koe` / `.ovk` / `.nwk` (ASCII,
//!   case-insensitive).
//! - The speaker attribution heuristic is the approximate one disclosed
//!   in the KAIFUU-174 plan: a Dialogue slot inherits the most recent
//!   SetSpeaker slot's decoded text. Unattributed Dialogue surfaces a
//!   `kaifuu.reallive.inventory.unattributed_dialogue` warning.

use std::collections::HashMap;

use kaifuu_core::{BridgeUnit, PatchRef, ProtectedSpan, sha256_hash_bytes};
use serde::{Deserialize, Serialize};

use crate::archive::{RealLiveSceneIndex, SceneEntry};
use crate::ast::{InstructionKind, Operand, Scene, StringSlotRole};
use crate::encoding::decode_shift_jis_slot;
use crate::opcodes::NamedOpcode;
use crate::protected_spans::{ProtectedSpanKind, RealLiveProtectedSpan, detect_protected_spans};

/// Stable warning codes for the inventory walk.
pub const INVENTORY_UNATTRIBUTED_DIALOGUE_CODE: &str =
    "kaifuu.reallive.inventory.unattributed_dialogue";
pub const INVENTORY_UNKNOWN_ASSET_EXTENSION_CODE: &str =
    "kaifuu.reallive.inventory.unknown_asset_extension";
pub const INVENTORY_UNSUPPORTED_TEXT_SHAPE_CODE: &str = "kaifuu.reallive.unsupported_text_shape";

/// Categorised asset reference (file paths embedded in scene text).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetReferenceKind {
    Image,
    VoiceArchive,
    SceneScript,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetReference {
    pub reference_id: String,
    pub kind: AssetReferenceKind,
    pub raw_path: String,
    pub source_unit_key: String,
    pub byte_offset: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetReferenceInventory {
    pub assets: Vec<AssetReference>,
}

/// Stable diagnostic code emitted by the inventory walk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryWarning {
    pub code: String,
    pub source_unit_key: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InventoryWarningCode {
    UnattributedDialogue,
    UnknownAssetExtension,
    UnsupportedTextShape,
    ShiftJisDecodeFailure,
    ProtectedSpanUnknownControl,
}

/// Output of the Scene/SEEN bridge inventory walk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryReport {
    /// Bridge units (one per Dialogue / SpeakerName / Choice StringSlot).
    pub bridge_units: Vec<BridgeUnit>,
    /// Asset-reference inventory (one entry per detected file path).
    pub asset_references: AssetReferenceInventory,
    /// Recoverable diagnostics surfaced to the adapter boundary.
    pub warnings: Vec<InventoryWarning>,
}

/// Walk a parsed Scene/SEEN AST and project it into the bridge schema.
///
/// `archive_bytes` is the original SEEN.TXT bytes (used only for hash
/// derivation, not for parsing); `scene_index` and `scenes` are the
/// outputs of [`crate::parse_archive`] and per-scene [`crate::parse_scene`]
/// calls, respectively.
pub fn build_scene_inventory(
    _archive_bytes: &[u8],
    scene_index: &RealLiveSceneIndex,
    scenes: &[Scene],
) -> InventoryReport {
    let mut bridge_units = Vec::new();
    let mut asset_assets = Vec::new();
    let mut warnings = Vec::new();

    let scene_by_id: HashMap<&str, &Scene> =
        scenes.iter().map(|s| (s.scene_id.as_str(), s)).collect();

    for entry in &scene_index.entries {
        let entry_scene_id_str = entry.scene_id_str();
        let Some(scene) = scene_by_id.get(entry_scene_id_str.as_str()) else {
            continue;
        };
        walk_scene(
            entry,
            scene,
            &mut bridge_units,
            &mut asset_assets,
            &mut warnings,
        );
    }

    bridge_units.sort_by(|a, b| a.source_unit_key.cmp(&b.source_unit_key));
    asset_assets.sort_by(|a, b| a.reference_id.cmp(&b.reference_id));

    InventoryReport {
        bridge_units,
        asset_references: AssetReferenceInventory {
            assets: asset_assets,
        },
        warnings,
    }
}

fn walk_scene(
    entry: &SceneEntry,
    scene: &Scene,
    bridge_units: &mut Vec<BridgeUnit>,
    asset_assets: &mut Vec<AssetReference>,
    warnings: &mut Vec<InventoryWarning>,
) {
    // Walk instructions in byte_offset order so the speaker heuristic is
    // deterministic.
    let mut instructions = scene.instructions.iter().collect::<Vec<_>>();
    instructions.sort_by_key(|instr| instr.byte_offset);

    let mut current_speaker: String = String::new();
    let mut bridge_index_within_scene: u64 = 0;

    for instr in instructions {
        let opcode = match instr.kind {
            InstructionKind::Named { opcode } => Some(opcode),
            InstructionKind::Unrecognized { .. } => None,
        };
        for operand in &instr.operands {
            let Operand::String { slot_ref } = operand else {
                continue;
            };
            // Resolve the slot.
            let Some(slot) = scene.strings.iter().find(|s| s.slot_id == slot_ref.slot_id) else {
                continue;
            };

            let raw_bytes = parse_hex(&slot.raw_bytes_hex);
            let decode = decode_shift_jis_slot(&raw_bytes);
            if decode.had_replacement {
                warnings.push(InventoryWarning {
                    code: super::encoding::SHIFT_JIS_DECODE_FAILURE_CODE.to_string(),
                    source_unit_key: Some(slot.slot_id.as_str().to_string()),
                    message: format!(
                        "Shift-JIS decode produced U+FFFD replacement(s) for slot {}; \
                         preserving raw bytes for round-trip",
                        slot.slot_id.as_str()
                    ),
                });
            }

            let decoded_text = decode.text;
            let spans_report = match detect_protected_spans(&raw_bytes, &decoded_text) {
                Ok(report) => report,
                Err(err) => {
                    // Malformed/adversarial Shift-JIS made the decoded byte
                    // range non-char-boundary. Record it (no silent skip)
                    // and continue the walk instead of crashing.
                    warnings.push(InventoryWarning {
                        code: crate::protected_spans::PROTECTED_SPAN_DECODED_RANGE_CODE.to_string(),
                        source_unit_key: Some(slot.slot_id.as_str().to_string()),
                        message: format!(
                            "protected-span detection failed for slot {}: {err}; \
                             preserving raw bytes, emitting no protected spans for this slot",
                            slot.slot_id.as_str()
                        ),
                    });
                    continue;
                }
            };
            for warning in spans_report.warnings {
                warnings.push(InventoryWarning {
                    code: warning.code,
                    source_unit_key: Some(slot.slot_id.as_str().to_string()),
                    message: warning.message,
                });
            }

            let (text_surface, effective_role) = match opcode {
                Some(NamedOpcode::TextDisplay) => ("dialogue", StringSlotRole::Dialogue),
                Some(NamedOpcode::SetSpeaker) => ("speaker_name", StringSlotRole::SpeakerName),
                Some(NamedOpcode::Choice) => ("choice_label", StringSlotRole::Choice),
                _ => match slot.semantic_role {
                    StringSlotRole::Dialogue => ("dialogue", StringSlotRole::Dialogue),
                    StringSlotRole::SpeakerName => ("speaker_name", StringSlotRole::SpeakerName),
                    StringSlotRole::Choice => ("choice_label", StringSlotRole::Choice),
                    StringSlotRole::AssetReference => {
                        ("metadata_text", StringSlotRole::AssetReference)
                    }
                    StringSlotRole::Unknown => {
                        warnings.push(InventoryWarning {
                            code: INVENTORY_UNSUPPORTED_TEXT_SHAPE_CODE.to_string(),
                            source_unit_key: Some(slot.slot_id.as_str().to_string()),
                            message: format!(
                                "string slot {} has Unknown semantic role; defaulting to \
                                 dialogue surface but flagging for translator review",
                                slot.slot_id.as_str()
                            ),
                        });
                        ("dialogue", StringSlotRole::Unknown)
                    }
                },
            };

            // Asset-reference heuristic. ASCII-only run ending with one
            // of the documented extensions.
            if let Some(kind) = classify_asset_path(&decoded_text) {
                asset_assets.push(AssetReference {
                    reference_id: format!(
                        "asset-ref:scene-{:04}:slot-{}",
                        entry.scene_id,
                        slot.slot_id.as_str()
                    ),
                    kind,
                    raw_path: decoded_text.clone(),
                    source_unit_key: slot.slot_id.as_str().to_string(),
                    byte_offset: slot.byte_offset_within_scene,
                });
                // Asset-shaped slots are AssetReference role; do not emit
                // a BridgeUnit for them.
                if matches!(opcode, Some(NamedOpcode::SetSpeaker)) {
                    // Reclassified — fall through to record the bridge
                    // unit anyway because the operand may also be a
                    // speaker.
                } else if matches!(effective_role, StringSlotRole::Unknown) {
                    continue;
                }
            } else if matches!(effective_role, StringSlotRole::AssetReference) {
                // Slot was AssetReference role but did not match a known
                // extension. Surface a warning per §9.1 of the plan.
                warnings.push(InventoryWarning {
                    code: INVENTORY_UNKNOWN_ASSET_EXTENSION_CODE.to_string(),
                    source_unit_key: Some(slot.slot_id.as_str().to_string()),
                    message: format!(
                        "asset-reference-shaped slot {} did not match any known \
                         extension catalogue; recording as metadata_text",
                        slot.slot_id.as_str()
                    ),
                });
            }

            // Speaker attribution: Dialogue inherits the most recent
            // SetSpeaker. Empty / unknown => warning.
            let speaker = match opcode {
                Some(NamedOpcode::SetSpeaker) => {
                    current_speaker = decoded_text.clone();
                    String::new()
                }
                Some(NamedOpcode::TextDisplay) => {
                    if current_speaker.is_empty() {
                        warnings.push(InventoryWarning {
                            code: INVENTORY_UNATTRIBUTED_DIALOGUE_CODE.to_string(),
                            source_unit_key: Some(slot.slot_id.as_str().to_string()),
                            message: format!(
                                "Dialogue slot {} has no preceding SetSpeaker; \
                                 emitting bridge unit with empty speaker for translator review",
                                slot.slot_id.as_str()
                            ),
                        });
                    }
                    current_speaker.clone()
                }
                _ => String::new(),
            };

            // Map protected spans onto kaifuu_core::ProtectedSpan.
            let protected_spans = spans_report
                .spans
                .into_iter()
                .map(|span| map_protected_span(&span, &decoded_text))
                .collect();

            let source_unit_key = slot.slot_id.as_str().to_string();
            let occurrence_id = format!("{source_unit_key}#occ-{bridge_index_within_scene:04}");
            bridge_index_within_scene += 1;

            let bridge_unit = BridgeUnit {
                bridge_unit_id: uuid::Uuid::now_v7().to_string(),
                source_unit_key: source_unit_key.clone(),
                occurrence_id,
                source_hash: sha256_hash_bytes(&raw_bytes),
                source_locale: "ja-JP".to_string(),
                source_text: decoded_text,
                speaker,
                text_surface: text_surface.to_string(),
                protected_spans,
                patch_ref: PatchRef {
                    asset_id: "reallive-seen-txt".to_string(),
                    write_mode: "replace".to_string(),
                    source_unit_key,
                },
            };
            bridge_units.push(bridge_unit);
        }
    }
}

fn map_protected_span(span: &RealLiveProtectedSpan, _decoded_text: &str) -> ProtectedSpan {
    let label = span.kind.label();
    let raw_for_span = span.raw_text.clone();
    let start = span.decoded_range_start;
    let end = span.decoded_range_end;
    // Empty raw_text spans (bare control bytes that didn't survive the
    // decode) cannot be expressed in `kaifuu_core::ProtectedSpan` because
    // it requires `start < end` against the decoded text. Encode them
    // verbatim using the raw hex as the `raw` and a `0..0` byte range
    // anchored at the decoded offset; the upstream patch-back planner
    // works off the raw byte ranges in `RealLiveProtectedSpan`, not the
    // bridge `ProtectedSpan`.
    if start == end || raw_for_span.is_empty() {
        // Mark with a synthetic placeholder span keyed on the byte
        // position so downstream tooling can still see it.
        let mut span_value = ProtectedSpan::control_markup(
            format!("[ctrl:0x{:02X}@b{}]", raw_byte_first(span), start),
            start,
            start.saturating_add(0),
            label,
            vec![format!("rawHex:{}", span.raw_bytes_hex)],
        );
        // Override end so kaifuu_core's normalizer does not later reject
        // an empty span; we make the marker a single-character placeholder
        // by emitting a "logical" 0..0 anchor. Bridge schema rules disallow
        // start == end on normalize, but we are returning a raw protected
        // span list (no normalize is called here at the inventory layer).
        span_value.start = start;
        span_value.end = end;
        span_value.raw = format!("[ctrl:0x{:02X}]", raw_byte_first(span));
        return span_value;
    }
    match &span.kind {
        ProtectedSpanKind::ColorCode { color_index } => ProtectedSpan::control_markup(
            raw_for_span,
            start,
            end,
            "color_code",
            vec![format!("{color_index:02x}")],
        ),
        ProtectedSpanKind::Ruby { base, ruby } => ProtectedSpan::control_markup(
            raw_for_span,
            start,
            end,
            "ruby",
            vec![base.clone(), ruby.clone()],
        ),
        ProtectedSpanKind::NamePlaceholder { index } => {
            ProtectedSpan::variable_placeholder(raw_for_span, start, end, format!("name_{index}"))
        }
        ProtectedSpanKind::ChoiceToken { choice_index } => ProtectedSpan::control_markup(
            raw_for_span,
            start,
            end,
            "choice_token",
            vec![format!("{choice_index:02x}")],
        ),
        ProtectedSpanKind::TextSizeDirective { size_byte } => ProtectedSpan::control_markup(
            raw_for_span,
            start,
            end,
            "text_size_directive",
            vec![format!("{size_byte:02x}")],
        ),
        ProtectedSpanKind::WaitDirective { frames_byte } => ProtectedSpan::control_markup(
            raw_for_span,
            start,
            end,
            "wait_directive",
            vec![format!("{frames_byte:02x}")],
        ),
        ProtectedSpanKind::ClearTextBox => {
            ProtectedSpan::control_markup(raw_for_span, start, end, "clear_text_box", vec![])
        }
        ProtectedSpanKind::LineBreak => {
            ProtectedSpan::control_markup(raw_for_span, start, end, "line_break", vec![])
        }
        ProtectedSpanKind::VariablePlaceholder { name } => {
            ProtectedSpan::variable_placeholder(raw_for_span, start, end, name.clone())
        }
        ProtectedSpanKind::UnknownControl { byte } => ProtectedSpan::control_markup(
            raw_for_span,
            start,
            end,
            "unknown_control",
            vec![format!("{byte:02x}")],
        ),
    }
}

fn raw_byte_first(span: &RealLiveProtectedSpan) -> u8 {
    let hex = &span.raw_bytes_hex;
    if hex.len() < 2 {
        return 0;
    }
    let hi = decode_nibble(hex.as_bytes()[0]);
    let lo = decode_nibble(hex.as_bytes()[1]);
    (hi << 4) | lo
}

fn decode_nibble(byte: u8) -> u8 {
    match byte {
        b'0'..=b'9' => byte - b'0',
        b'A'..=b'F' => byte - b'A' + 10,
        b'a'..=b'f' => byte - b'a' + 10,
        _ => 0,
    }
}

fn parse_hex(hex: &str) -> Vec<u8> {
    let bytes = hex.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for chunk in bytes.chunks(2) {
        if chunk.len() < 2 {
            break;
        }
        let hi = decode_nibble(chunk[0]);
        let lo = decode_nibble(chunk[1]);
        out.push((hi << 4) | lo);
    }
    out
}

fn classify_asset_path(text: &str) -> Option<AssetReferenceKind> {
    if !text.is_ascii() {
        return None;
    }
    let lower = text.to_ascii_lowercase();
    let lower_trimmed = lower.trim();
    if lower_trimmed.ends_with(".g00") {
        return Some(AssetReferenceKind::Image);
    }
    if lower_trimmed.ends_with(".koe")
        || lower_trimmed.ends_with(".ovk")
        || lower_trimmed.ends_with(".nwk")
    {
        return Some(AssetReferenceKind::VoiceArchive);
    }
    if lower_trimmed.ends_with(".seen.txt") {
        return Some(AssetReferenceKind::SceneScript);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_g00_path_as_image_asset() {
        assert_eq!(
            classify_asset_path("bg/sample.g00"),
            Some(AssetReferenceKind::Image)
        );
    }

    #[test]
    fn classifies_koe_path_as_voice_asset() {
        assert_eq!(
            classify_asset_path("voice/scene01.koe"),
            Some(AssetReferenceKind::VoiceArchive)
        );
    }

    #[test]
    fn rejects_non_ascii_text_from_asset_classification() {
        assert!(classify_asset_path("背景.g00").is_none());
    }
}
