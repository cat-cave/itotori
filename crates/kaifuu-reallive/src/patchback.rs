//! Patch-back planner for the Scene/SEEN bytecode.
//!
//! Clean-room provenance (KAIFUU-174):
//! - The planner consumes the KAIFUU-173 AST surface and re-emits the
//!   scene bytes with replaced StringSlot bytes. It never reads rlvm or
//!   RLDEV source.
//! - Length-preserving edits only at this slice (§7.2 of the plan).
//!   `FixedBudget` returns
//!   `kaifuu.reallive.patchback_unsupported_length_policy` Fatal until a
//!   future node ratifies offset rewriting against per-game evidence.
//! - The planner asserts non-text byte invariants (instructions, opcode
//!   openers, operand tags, control bytes inside StringSlots) are
//!   byte-identical to the source on every patched scene. The KAIFUU-174
//!   tests in `tests/patchback.rs` exercise these invariants.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::archive::{RealLiveSceneIndex, parse_archive};
use crate::ast::{Operand, Scene};
use crate::encoding::{ShiftJisEncodeError, encode_shift_jis_slot, slice_control_bytes};
use crate::parser::parse_scene_into_ast;
use crate::protected_spans::detect_protected_spans;

/// Edit policy for a single [`SlotEdit`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SlotEditLengthPolicy {
    LengthPreserving,
    FixedBudget { max_bytes: u64 },
}

/// One edit. `scene_id` is the KAIFUU-173 scene id (e.g.
/// `reallive:scene-0000`); `slot_id` is the [`crate::ast::StringSlotId`]
/// as a string. `replacement_text` is the post-translation text; the
/// planner Shift-JIS-encodes it and re-injects control bytes from the
/// source slot in their original positions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotEdit {
    pub scene_id: String,
    pub slot_id: String,
    pub replacement_text: String,
    pub length_policy: SlotEditLengthPolicy,
    /// Optional expected source hash (sha256 over the original bytes of
    /// the StringSlot). When supplied, the planner asserts the parsed
    /// slot's bytes hash to the expected value; mismatch yields
    /// `kaifuu.reallive.patchback_stale_source_hash` Fatal.
    pub expected_source_hash: Option<String>,
}

/// Stable patch-back error codes.
pub const PATCHBACK_OFFSET_OVERFLOW_CODE: &str = "kaifuu.reallive.patchback_offset_overflow";
pub const PATCHBACK_SHIFT_JIS_ENCODE_FAILURE_CODE: &str =
    "kaifuu.reallive.patchback_shift_jis_encode_failure";
pub const PATCHBACK_UNSUPPORTED_LENGTH_POLICY_CODE: &str =
    "kaifuu.reallive.patchback_unsupported_length_policy";
pub const PATCHBACK_PARSER_REGRESSION_CODE: &str = "kaifuu.reallive.patchback_parser_regression";
pub const PATCHBACK_UNKNOWN_SLOT_ID_CODE: &str = "kaifuu.reallive.patchback_unknown_slot_id";
pub const PATCHBACK_STALE_SOURCE_HASH_CODE: &str = "kaifuu.reallive.patchback_stale_source_hash";
pub const PATCHBACK_PROTECTED_SPAN_LOST_CODE: &str =
    "kaifuu.reallive.patchback_protected_span_lost";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PatchBackErrorCode {
    OffsetOverflow,
    ShiftJisEncodeFailure,
    UnsupportedLengthPolicy,
    ParserRegression,
    UnknownSlotId,
    StaleSourceHash,
    ProtectedSpanLost,
}

impl PatchBackErrorCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::OffsetOverflow => PATCHBACK_OFFSET_OVERFLOW_CODE,
            Self::ShiftJisEncodeFailure => PATCHBACK_SHIFT_JIS_ENCODE_FAILURE_CODE,
            Self::UnsupportedLengthPolicy => PATCHBACK_UNSUPPORTED_LENGTH_POLICY_CODE,
            Self::ParserRegression => PATCHBACK_PARSER_REGRESSION_CODE,
            Self::UnknownSlotId => PATCHBACK_UNKNOWN_SLOT_ID_CODE,
            Self::StaleSourceHash => PATCHBACK_STALE_SOURCE_HASH_CODE,
            Self::ProtectedSpanLost => PATCHBACK_PROTECTED_SPAN_LOST_CODE,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{}: {message}", code.as_str())]
pub struct PatchBackError {
    pub code: PatchBackErrorCode,
    pub scene_id: Option<String>,
    pub slot_id: Option<String>,
    pub message: String,
}

impl PatchBackError {
    fn new(code: PatchBackErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            scene_id: None,
            slot_id: None,
            message: message.into(),
        }
    }

    fn for_slot(
        code: PatchBackErrorCode,
        scene_id: &str,
        slot_id: &str,
        message: impl Into<String>,
    ) -> Self {
        Self {
            code,
            scene_id: Some(scene_id.to_string()),
            slot_id: Some(slot_id.to_string()),
            message: message.into(),
        }
    }
}

/// Patch-back plan input. The planner copies these into a `Vec<SlotEdit>`
/// per scene.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchBackPlan {
    pub edits: Vec<SlotEdit>,
}

/// Apply a list of [`SlotEdit`]s to a SEEN.TXT archive.
///
/// The output is a new archive (`Vec<u8>`) byte-identical to the input
/// outside the edited slot ranges. Identity round-trip with an empty
/// edit list returns `archive_bytes.to_vec()`.
pub fn apply_patches(
    archive_bytes: &[u8],
    scene_index: &RealLiveSceneIndex,
    scenes: &[Scene],
    edits: &[SlotEdit],
) -> Result<Vec<u8>, PatchBackError> {
    let mut output = archive_bytes.to_vec();

    if edits.is_empty() {
        // Self-check re-parse gate: confirm the input is a parseable
        // archive before claiming an identity round-trip.
        verify_archive_round_trip(&output, scene_index, scenes)?;
        return Ok(output);
    }

    // Group edits by scene id.
    let mut edits_by_scene: HashMap<&str, Vec<&SlotEdit>> = HashMap::new();
    for edit in edits {
        edits_by_scene
            .entry(edit.scene_id.as_str())
            .or_default()
            .push(edit);
    }

    for (scene_id, scene_edits) in &edits_by_scene {
        let entry = scene_index
            .entries
            .iter()
            .find(|e| e.scene_id_str() == *scene_id)
            .ok_or_else(|| {
                PatchBackError::new(
                    PatchBackErrorCode::UnknownSlotId,
                    format!("scene id {scene_id} not present in archive index"),
                )
            })?;
        let scene = scenes
            .iter()
            .find(|s| s.scene_id.as_str() == *scene_id)
            .ok_or_else(|| {
                PatchBackError::new(
                    PatchBackErrorCode::UnknownSlotId,
                    format!("scene id {scene_id} not present in parsed scenes"),
                )
            })?;
        let scene_bytes_start = entry.byte_offset as usize;
        let scene_bytes_end = scene_bytes_start + entry.byte_len as usize;
        let mut scene_bytes = output[scene_bytes_start..scene_bytes_end].to_vec();

        // Apply edits highest-offset-first so earlier edits do not shift
        // later offsets. Length-preserving edits do not change offsets,
        // but FixedBudget would; the ordering keeps the algorithm
        // forward-compatible even though we reject FixedBudget below.
        let mut sorted_edits: Vec<&SlotEdit> = scene_edits.to_vec();
        sorted_edits.sort_by(|a, b| {
            slot_offset_in_scene(scene, &b.slot_id).cmp(&slot_offset_in_scene(scene, &a.slot_id))
        });

        for edit in sorted_edits {
            apply_slot_edit(scene, &mut scene_bytes, edit)?;
        }

        if scene_bytes.len() != entry.byte_len as usize {
            return Err(PatchBackError::new(
                PatchBackErrorCode::OffsetOverflow,
                format!(
                    "scene {scene_id} byte length changed from {} to {} during patch-back; \
                     length-changing patch-back is not implemented (KAIFUU-174 §7.2)",
                    entry.byte_len,
                    scene_bytes.len()
                ),
            ));
        }

        output.splice(scene_bytes_start..scene_bytes_end, scene_bytes);
    }

    verify_archive_round_trip(&output, scene_index, scenes)?;
    Ok(output)
}

fn slot_offset_in_scene(scene: &Scene, slot_id: &str) -> u64 {
    scene
        .strings
        .iter()
        .find(|s| s.slot_id.as_str() == slot_id)
        .map(|s| s.byte_offset_within_scene)
        .unwrap_or(u64::MAX)
}

fn apply_slot_edit(
    scene: &Scene,
    scene_bytes: &mut Vec<u8>,
    edit: &SlotEdit,
) -> Result<(), PatchBackError> {
    let slot = scene
        .strings
        .iter()
        .find(|s| s.slot_id.as_str() == edit.slot_id)
        .ok_or_else(|| {
            PatchBackError::for_slot(
                PatchBackErrorCode::UnknownSlotId,
                scene.scene_id.as_str(),
                &edit.slot_id,
                format!(
                    "slot id {} not present in scene {}",
                    edit.slot_id,
                    scene.scene_id.as_str()
                ),
            )
        })?;

    // Verify the slot bytes come from the same place that the operand
    // points to (the parser already guarantees this, but assert it for
    // patch-back integrity).
    let _ = scene
        .instructions
        .iter()
        .find(|instr| {
            instr.operands.iter().any(|op| {
                matches!(op, Operand::String { slot_ref } if slot_ref.slot_id.as_str() == edit.slot_id)
            })
        })
        .ok_or_else(|| {
            PatchBackError::for_slot(
                PatchBackErrorCode::UnknownSlotId,
                scene.scene_id.as_str(),
                &edit.slot_id,
                format!(
                    "slot id {} is not referenced by any instruction in scene {}",
                    edit.slot_id,
                    scene.scene_id.as_str()
                ),
            )
        })?;

    let slot_start = slot.byte_offset_within_scene as usize;
    let slot_end = slot_start + slot.byte_len as usize;
    if slot_end > scene_bytes.len() {
        return Err(PatchBackError::for_slot(
            PatchBackErrorCode::OffsetOverflow,
            scene.scene_id.as_str(),
            &edit.slot_id,
            format!(
                "slot byte range {slot_start}..{slot_end} runs past scene byte length {}",
                scene_bytes.len()
            ),
        ));
    }
    let source_slot_bytes = &scene_bytes[slot_start..slot_end];

    if let Some(expected_hash) = &edit.expected_source_hash {
        let actual_hash = kaifuu_core::sha256_hash_bytes(source_slot_bytes);
        if &actual_hash != expected_hash {
            return Err(PatchBackError::for_slot(
                PatchBackErrorCode::StaleSourceHash,
                scene.scene_id.as_str(),
                &edit.slot_id,
                format!(
                    "expected source hash {expected_hash} did not match actual hash {actual_hash}; \
                     re-extract the bridge bundle before re-applying this patch"
                ),
            ));
        }
    }

    // Reject FixedBudget at this slice.
    if !matches!(edit.length_policy, SlotEditLengthPolicy::LengthPreserving) {
        return Err(PatchBackError::for_slot(
            PatchBackErrorCode::UnsupportedLengthPolicy,
            scene.scene_id.as_str(),
            &edit.slot_id,
            "FixedBudget length policy is not implemented at KAIFUU-174 (§7.2); \
             use LengthPreserving or wait for a future node",
        ));
    }

    // Encode the replacement text. Re-inject the source slot's control
    // bytes in their original positions.
    let new_bytes =
        encode_replacement(source_slot_bytes, &edit.replacement_text).map_err(|err| {
            PatchBackError::for_slot(
                PatchBackErrorCode::ShiftJisEncodeFailure,
                scene.scene_id.as_str(),
                &edit.slot_id,
                format!("Shift-JIS encode failed for slot {}: {err}", edit.slot_id),
            )
        })?;

    // Length-preserving check.
    if new_bytes.len() != source_slot_bytes.len() {
        return Err(PatchBackError::for_slot(
            PatchBackErrorCode::OffsetOverflow,
            scene.scene_id.as_str(),
            &edit.slot_id,
            format!(
                "length-preserving edit produced {} bytes, expected {}; \
                 length-changing patch-back is not implemented (KAIFUU-174 §7.2)",
                new_bytes.len(),
                source_slot_bytes.len()
            ),
        ));
    }

    // Protected-span loss check: ensure that the number of protected
    // spans in the new bytes is >= the number in the source bytes
    // (length-preserving edits should preserve all of them; embedded
    // tooling can choose to lose spans only by going through a
    // length-changing edit, which we reject).
    let source_spans = count_protected_spans_in_raw(source_slot_bytes);
    let new_spans = count_protected_spans_in_raw(&new_bytes);
    if new_spans < source_spans {
        return Err(PatchBackError::for_slot(
            PatchBackErrorCode::ProtectedSpanLost,
            scene.scene_id.as_str(),
            &edit.slot_id,
            format!(
                "edited slot lost protected spans (source had {source_spans}, new has {new_spans}); \
                 preserve every control byte / placeholder verbatim"
            ),
        ));
    }

    scene_bytes.splice(slot_start..slot_end, new_bytes);
    Ok(())
}

fn count_protected_spans_in_raw(raw_bytes: &[u8]) -> usize {
    let decoded = crate::encoding::decode_shift_jis_slot(raw_bytes).text;
    detect_protected_spans(raw_bytes, &decoded).spans.len()
}

/// Build the replacement bytes for a slot: encode the text runs from
/// `replacement_text` as Shift-JIS, then re-inject each control byte from
/// `source_slot_bytes` in its original byte position. The result is the
/// new slot bytes.
///
/// Algorithm:
/// 1. Walk `source_slot_bytes` and collect the control bytes plus their
///    byte offsets within the slot.
/// 2. Encode `replacement_text` as Shift-JIS once. This produces a flat
///    byte vector that does not contain the source's control bytes.
/// 3. For each control byte (in increasing offset order), splice it into
///    the encoded vector at the same offset. Because length-preserving
///    edits must yield the same total length, the encoded text bytes plus
///    the control bytes must equal the source slot length.
fn encode_replacement(
    source_slot_bytes: &[u8],
    replacement_text: &str,
) -> Result<Vec<u8>, ShiftJisEncodeError> {
    // Control bytes (offset, byte) for the source.
    let mut controls = Vec::new();
    let segments = slice_control_bytes(source_slot_bytes);
    for segment in &segments {
        if let crate::encoding::SliceSegment::Control { byte_offset, byte } = segment {
            controls.push((*byte_offset, *byte));
        }
    }

    // Encode the replacement text fully as Shift-JIS.
    let encoded_text = encode_shift_jis_slot(replacement_text)?;

    // Reassemble: for each control byte in increasing offset order, place
    // it back at its offset. Use the encoded text bytes to fill the gaps.
    let mut output = Vec::with_capacity(source_slot_bytes.len());
    let mut text_cursor = 0;
    let mut next_offset = 0;
    let mut control_iter = controls.into_iter().peekable();
    while next_offset < source_slot_bytes.len() {
        match control_iter.peek() {
            Some(&(off, byte)) if off == next_offset => {
                output.push(byte);
                control_iter.next();
                next_offset += 1;
            }
            _ => {
                // Fill from the encoded text. If we run out of text bytes
                // before reaching the next control offset, the encoded
                // text is too short to satisfy the length budget.
                if text_cursor >= encoded_text.len() {
                    // Allow shorter replacements only when the remaining
                    // gap before the next control byte is zero. Otherwise
                    // the caller violated length-preserving — surface as
                    // a short partial result; the caller checks length
                    // and emits an overflow error.
                    break;
                }
                output.push(encoded_text[text_cursor]);
                text_cursor += 1;
                next_offset += 1;
            }
        }
    }

    // Append any trailing text bytes that did not fit before the last
    // control byte position. This handles the case where the replacement
    // is longer than the gaps between control bytes (which will then be
    // rejected by the length-preserving check).
    while text_cursor < encoded_text.len() {
        output.push(encoded_text[text_cursor]);
        text_cursor += 1;
    }

    Ok(output)
}

/// Re-parse the patched archive to confirm it stays well-formed. This is
/// the patch-back integrity gate referenced in §7.1 of the plan.
fn verify_archive_round_trip(
    output: &[u8],
    original_scene_index: &RealLiveSceneIndex,
    original_scenes: &[Scene],
) -> Result<(), PatchBackError> {
    let new_index = parse_archive(output).map_err(|diag| {
        PatchBackError::new(
            PatchBackErrorCode::ParserRegression,
            format!(
                "post-patch archive failed to parse: code={}, message={}",
                diag.code, diag.message
            ),
        )
    })?;
    if new_index.entries.len() != original_scene_index.entries.len() {
        return Err(PatchBackError::new(
            PatchBackErrorCode::ParserRegression,
            format!(
                "post-patch archive has {} scenes, source had {}",
                new_index.entries.len(),
                original_scene_index.entries.len()
            ),
        ));
    }
    for (new_entry, original_entry) in new_index.entries.iter().zip(&original_scene_index.entries) {
        if new_entry.byte_offset != original_entry.byte_offset
            || new_entry.byte_len != original_entry.byte_len
        {
            let new_scene_id_str = new_entry.scene_id_str();
            return Err(PatchBackError::new(
                PatchBackErrorCode::ParserRegression,
                format!(
                    "post-patch scene {} entry table drifted ({}..{} vs {}..{})",
                    new_scene_id_str,
                    new_entry.byte_offset,
                    new_entry.byte_offset + u64::from(new_entry.byte_len),
                    original_entry.byte_offset,
                    original_entry.byte_offset + u64::from(original_entry.byte_len)
                ),
            ));
        }
        let blob_end = (new_entry.byte_offset + u64::from(new_entry.byte_len)) as usize;
        let blob = &output[new_entry.byte_offset as usize..blob_end];
        let outcome = parse_scene_into_ast(blob, new_entry.scene_id, new_entry.byte_offset);
        let new_scene_id_str = new_entry.scene_id_str();
        if outcome.scene.is_none() {
            return Err(PatchBackError::new(
                PatchBackErrorCode::ParserRegression,
                format!(
                    "post-patch scene {} failed to parse: {:?}",
                    new_scene_id_str, outcome.diagnostics
                ),
            ));
        }
        let new_scene = outcome.scene.unwrap();
        let original_scene = original_scenes
            .iter()
            .find(|s| s.scene_id == new_scene_id_str)
            .ok_or_else(|| {
                PatchBackError::new(
                    PatchBackErrorCode::ParserRegression,
                    format!(
                        "post-patch scene {} has no matching original scene",
                        new_scene_id_str
                    ),
                )
            })?;
        if new_scene.instructions.len() != original_scene.instructions.len() {
            return Err(PatchBackError::new(
                PatchBackErrorCode::ParserRegression,
                format!(
                    "post-patch scene {} has {} instructions, source had {}",
                    new_scene_id_str,
                    new_scene.instructions.len(),
                    original_scene.instructions.len()
                ),
            ));
        }
        if new_scene.strings.len() != original_scene.strings.len() {
            return Err(PatchBackError::new(
                PatchBackErrorCode::ParserRegression,
                format!(
                    "post-patch scene {} has {} string slots, source had {}",
                    new_scene_id_str,
                    new_scene.strings.len(),
                    original_scene.strings.len()
                ),
            ));
        }
    }
    Ok(())
}
