use std::collections::BTreeMap;

use kaifuu_core::sha256_hash_bytes;

use crate::archive::SiglusSceneIndex;
use crate::compress::compress_siglus_lzss;
use crate::decrypt::apply_xor_table;
use crate::flow::decode_scene_flow;
use crate::opcode::partition_scene;
use crate::scene_decode::decode_scene_chunk;

use super::provenance::{parse_location, parse_source_key, scene_identity};
use super::sections::{SceneSections, SectionSplice};
use super::strings::{
    StringSlot, decode as decode_slot, encode as encode_target, layout as string_table_layout,
    parse_slots as parse_string_slots,
};
use super::{PatchbackEncoding, PatchbackError, PatchbackOpts, TranslatedBundleV02};

#[derive(Debug, Clone)]
pub(super) struct ScenePlan {
    pub(super) entry_index: usize,
    pub(super) scene_id: u32,
    pub(super) packed_chunk: Vec<u8>,
    baseline_unknowns: usize,
    baseline_flow_unknowns: usize,
    edits: Vec<AppliedEdit>,
}

#[derive(Debug, Clone)]
struct ResolvedUnit {
    source_unit_key: String,
    surface_kind: String,
    string_index: i32,
    range_start: usize,
    range_end: usize,
    expected_hash: String,
    source_text: String,
    target_text: String,
}

#[derive(Debug, Clone)]
struct AppliedEdit {
    source_unit_key: String,
    surface_kind: String,
    string_index: i32,
    target_text: String,
}

#[derive(Debug, Clone)]
struct Replacement {
    edit: AppliedEdit,
    start: usize,
    end: usize,
    bytes: Vec<u8>,
    char_len: i32,
}

/// Decode, freshness-gate, splice, and re-encode every scene that has a
/// non-identity target. Identity units are deliberately decoded and checked,
/// but never cause a scene re-emission.
pub(super) fn prepare_scene_plans(
    archive: &[u8],
    index: &SiglusSceneIndex,
    bundle: &TranslatedBundleV02,
    opts: &PatchbackOpts<'_>,
) -> Result<Vec<ScenePlan>, PatchbackError> {
    let mut units_by_scene: BTreeMap<usize, Vec<ResolvedUnit>> = BTreeMap::new();
    for (target, unit) in bundle.targets.iter().zip(&bundle.source.units) {
        if target.bridge_unit_id != unit.bridge_unit_id {
            return Err(PatchbackError::BundleSchemaInvalid {
                message: format!(
                    "target bridgeUnitId {:?} does not match source unit {:?}",
                    target.bridge_unit_id, unit.bridge_unit_id
                ),
            });
        }
        let (scene_name, _site) = parse_source_key(&unit.source_unit_key)?;
        let entry_index = index
            .entries
            .iter()
            .enumerate()
            .find(|(_, entry)| scene_identity(entry) == scene_name)
            .map(|(entry_index, _)| entry_index)
            .ok_or_else(|| PatchbackError::ProvenanceMismatch {
                source_unit_key: unit.source_unit_key.clone(),
                reason: format!("SceneList has no scene named {scene_name:?}"),
            })?;
        let (string_index, range_start, range_end) = parse_location(unit, &scene_name)?;
        units_by_scene
            .entry(entry_index)
            .or_default()
            .push(ResolvedUnit {
                source_unit_key: unit.source_unit_key.clone(),
                surface_kind: unit.surface_kind.clone(),
                string_index,
                range_start,
                range_end,
                expected_hash: unit.source_hash.clone(),
                source_text: unit.source_text.clone(),
                target_text: target.target_text.clone(),
            });
    }

    let mut plans = Vec::new();
    for (entry_index, units) in units_by_scene {
        let entry = &index.entries[entry_index];
        let chunk = scene_chunk(archive, entry.byte_offset, entry.byte_len, entry.scene_id)?;
        let decoded = decode_scene_chunk(
            entry.scene_id,
            chunk,
            index.extra_key_use,
            opts.second_layer,
        )
        .map_err(|error| scene_error(entry.scene_id, format!("decode: {error}")))?;
        let slots = parse_string_slots(&decoded, entry.scene_id)?;
        let changed = verify_and_collect_changes(&decoded, &slots, &units)?;
        if changed.is_empty() {
            continue;
        }

        let baseline = partition_scene(&decoded)
            .map_err(|error| scene_error(entry.scene_id, format!("siglus-08 baseline: {error}")))?;
        let baseline_flow = decode_scene_flow(&decoded)
            .map_err(|error| scene_error(entry.scene_id, format!("siglus-10 baseline: {error}")))?;
        let patched =
            patch_string_table(&decoded, &slots, &changed, opts.encoding, entry.scene_id)?;
        let checked = partition_scene(&patched)
            .map_err(|error| self_check(entry.scene_id, format!("siglus-08: {error}")))?;
        let checked_flow = decode_scene_flow(&patched)
            .map_err(|error| self_check(entry.scene_id, format!("siglus-10: {error}")))?;
        ensure_no_new_unknowns(
            entry.scene_id,
            baseline.histogram.unknown_count,
            baseline_flow.unknown_family_count(),
            checked.histogram.unknown_count,
            checked_flow.unknown_family_count(),
        )?;
        verify_targets(entry.scene_id, &patched, &checked_flow, &changed)?;

        let compressed = compress_siglus_lzss(&patched)
            .map_err(|error| scene_error(entry.scene_id, format!("LZSS encode: {error}")))?;
        let packed_len = compressed
            .len()
            .checked_add(8)
            .and_then(|len| u32::try_from(len).ok())
            .ok_or_else(|| scene_error(entry.scene_id, "packed chunk length exceeds u32"))?;
        let plain_len = u32::try_from(patched.len())
            .map_err(|_| scene_error(entry.scene_id, "decoded scene length exceeds u32"))?;
        let mut plaintext_chunk = Vec::with_capacity(compressed.len() + 8);
        plaintext_chunk.extend_from_slice(&packed_len.to_le_bytes());
        plaintext_chunk.extend_from_slice(&plain_len.to_le_bytes());
        plaintext_chunk.extend_from_slice(&compressed);
        plans.push(ScenePlan {
            entry_index,
            scene_id: entry.scene_id,
            packed_chunk: apply_xor_table(&plaintext_chunk, opts.second_layer),
            baseline_unknowns: baseline.histogram.unknown_count,
            baseline_flow_unknowns: baseline_flow.unknown_family_count(),
            edits: changed,
        });
    }
    Ok(plans)
}

/// Re-decode each emitted chunk from the final, re-parsed directory. This
/// catches directory errors as well as bytecode/string-table regressions.
pub(super) fn verify_scene_plans(
    archive: &[u8],
    index: &SiglusSceneIndex,
    plans: &[ScenePlan],
    opts: &PatchbackOpts<'_>,
) -> Result<(), PatchbackError> {
    for plan in plans {
        let entry = index.entries.get(plan.entry_index).ok_or_else(|| {
            self_check(
                plan.scene_id,
                "patched SceneList no longer contains edited scene",
            )
        })?;
        if entry.scene_id != plan.scene_id {
            return Err(self_check(
                plan.scene_id,
                "patched SceneList changed edited scene identity",
            ));
        }
        let chunk = scene_chunk(archive, entry.byte_offset, entry.byte_len, entry.scene_id)?;
        let decoded = decode_scene_chunk(
            entry.scene_id,
            chunk,
            index.extra_key_use,
            opts.second_layer,
        )
        .map_err(|error| self_check(entry.scene_id, format!("re-decode: {error}")))?;
        let partition = partition_scene(&decoded)
            .map_err(|error| self_check(entry.scene_id, format!("siglus-08 re-decode: {error}")))?;
        let flow = decode_scene_flow(&decoded)
            .map_err(|error| self_check(entry.scene_id, format!("siglus-10 re-decode: {error}")))?;
        ensure_no_new_unknowns(
            entry.scene_id,
            plan.baseline_unknowns,
            plan.baseline_flow_unknowns,
            partition.histogram.unknown_count,
            flow.unknown_family_count(),
        )?;
        verify_targets(entry.scene_id, &decoded, &flow, &plan.edits)?;
    }
    Ok(())
}

fn verify_and_collect_changes(
    decoded: &[u8],
    slots: &[StringSlot],
    units: &[ResolvedUnit],
) -> Result<Vec<AppliedEdit>, PatchbackError> {
    let mut changes: BTreeMap<i32, AppliedEdit> = BTreeMap::new();
    let mut requested_targets: BTreeMap<i32, (String, String)> = BTreeMap::new();
    for unit in units {
        let slot = slots.get(unit.string_index as usize).ok_or_else(|| {
            PatchbackError::ProvenanceMismatch {
                source_unit_key: unit.source_unit_key.clone(),
                reason: format!("string-table index {} is absent", unit.string_index),
            }
        })?;
        let end = slot
            .byte_offset
            .checked_add((slot.char_len as usize) * 2)
            .ok_or_else(|| PatchbackError::ProvenanceMismatch {
                source_unit_key: unit.source_unit_key.clone(),
                reason: "string-table range overflows usize".into(),
            })?;
        if unit.range_start != slot.byte_offset || unit.range_end != end {
            return Err(PatchbackError::ProvenanceMismatch {
                source_unit_key: unit.source_unit_key.clone(),
                reason: "sourceLocation range does not equal its indexed string-table span".into(),
            });
        }
        let located =
            decode_slot(decoded, slot).ok_or_else(|| PatchbackError::ProvenanceMismatch {
                source_unit_key: unit.source_unit_key.clone(),
                reason: "indexed string-table span is not readable UTF-16LE".into(),
            })?;
        let actual_hash = sha256_hash_bytes(located.as_bytes());
        if actual_hash != unit.expected_hash {
            return Err(PatchbackError::StaleSource {
                source_unit_key: unit.source_unit_key.clone(),
                expected_hash: unit.expected_hash.clone(),
                actual_hash,
            });
        }
        if located != unit.source_text {
            return Err(PatchbackError::ProvenanceMismatch {
                source_unit_key: unit.source_unit_key.clone(),
                reason: "located literal differs from sourceText despite matching sourceHash"
                    .into(),
            });
        }
        if let Some((target, first_key)) = requested_targets.get(&unit.string_index) {
            if target != &unit.target_text {
                return Err(PatchbackError::ConflictingStringTargets {
                    first: first_key.clone(),
                    second: unit.source_unit_key.clone(),
                });
            }
        } else {
            requested_targets.insert(
                unit.string_index,
                (unit.target_text.clone(), unit.source_unit_key.clone()),
            );
        }
        if unit.target_text == located {
            continue;
        }
        let edit = AppliedEdit {
            source_unit_key: unit.source_unit_key.clone(),
            surface_kind: unit.surface_kind.clone(),
            string_index: unit.string_index,
            target_text: unit.target_text.clone(),
        };
        changes.entry(unit.string_index).or_insert(edit);
    }
    Ok(changes.into_values().collect())
}

fn patch_string_table(
    decoded: &[u8],
    slots: &[StringSlot],
    changes: &[AppliedEdit],
    encoding: PatchbackEncoding,
    scene_id: u32,
) -> Result<Vec<u8>, PatchbackError> {
    let (_index_list, string_base) = string_table_layout(decoded, scene_id)?;
    let sections = SceneSections::parse(decoded, scene_id)?;
    let mut replacements = Vec::with_capacity(changes.len());
    for edit in changes {
        let slot = &slots[edit.string_index as usize];
        let (bytes, char_len) = encode_target(&edit.target_text, slot.index, encoding, scene_id)?;
        replacements.push(Replacement {
            edit: edit.clone(),
            start: slot.byte_offset,
            end: slot.byte_offset + slot.char_len as usize * 2,
            bytes,
            char_len,
        });
    }
    replacements.sort_by_key(|replacement| replacement.start);
    for pair in replacements.windows(2) {
        if pair[0].end > pair[1].start {
            return Err(scene_error(scene_id, "two string-table spans overlap"));
        }
    }
    if replacements
        .iter()
        .any(|replacement| replacement.start < crate::opcode::SCN_HEADER_BYTE_LEN)
    {
        return Err(scene_error(scene_id, "string span overlaps scene header"));
    }

    let mut output = decoded.to_vec();
    for replacement in replacements.iter().rev() {
        output.splice(
            replacement.start..replacement.end,
            replacement.bytes.iter().copied(),
        );
    }
    let splices = replacements
        .iter()
        .map(|replacement| SectionSplice {
            start: replacement.start,
            end: replacement.end,
            replacement_len: replacement.bytes.len(),
        })
        .collect::<Vec<_>>();
    let relocated_sections = sections.relocated(&splices, scene_id)?;
    relocated_sections.write_to(&mut output, scene_id)?;
    let relocated_index_list = relocated_sections.offset(3, scene_id)?;
    let relocated_string_base = relocated_sections.offset(5, scene_id)?;
    if relocated_string_base != string_base {
        return Err(scene_error(
            scene_id,
            "string-data section unexpectedly moved during its own splice",
        ));
    }
    for slot in slots {
        let shift: i64 = replacements
            .iter()
            .filter(|replacement| replacement.end <= slot.byte_offset)
            .map(|replacement| {
                replacement.bytes.len() as i64 - (replacement.end - replacement.start) as i64
            })
            .sum();
        let new_offset = i64::from(slot.char_offset) + shift / 2;
        let replacement = replacements
            .iter()
            .find(|item| item.edit.string_index == slot.index);
        let new_len = replacement.map_or(slot.char_len, |item| item.char_len);
        let new_offset = i32::try_from(new_offset)
            .map_err(|_| scene_error(scene_id, "rebased string offset does not fit i32"))?;
        let entry = relocated_index_list + slot.index as usize * 8;
        let entry_end = entry
            .checked_add(8)
            .filter(|end| *end <= output.len())
            .ok_or_else(|| scene_error(scene_id, "relocated string index runs past scene"))?;
        output[entry..entry + 4].copy_from_slice(&new_offset.to_le_bytes());
        output[entry + 4..entry_end].copy_from_slice(&new_len.to_le_bytes());
    }
    Ok(output)
}

fn verify_targets(
    scene_id: u32,
    decoded: &[u8],
    flow: &crate::flow::SceneFlowDecode,
    edits: &[AppliedEdit],
) -> Result<(), PatchbackError> {
    let slots = parse_string_slots(decoded, scene_id)?;
    for edit in edits {
        let slot = slots.get(edit.string_index as usize).ok_or_else(|| {
            self_check(
                scene_id,
                format!("patched string {} is absent", edit.string_index),
            )
        })?;
        let actual = decode_slot(decoded, slot)
            .ok_or_else(|| self_check(scene_id, "patched string is unreadable UTF-16LE"))?;
        if actual != edit.target_text {
            return Err(self_check(
                scene_id,
                format!(
                    "patched unit {:?} did not decode to its target",
                    edit.source_unit_key
                ),
            ));
        }
        if matches!(edit.surface_kind.as_str(), "dialogue" | "speaker_name")
            && !flow
                .text_surfaces
                .iter()
                .any(|surface| surface.str_index == Some(edit.string_index))
        {
            return Err(self_check(
                scene_id,
                format!(
                    "patched unit {:?} is absent from siglus-10 surfaces",
                    edit.source_unit_key
                ),
            ));
        }
    }
    Ok(())
}

fn ensure_no_new_unknowns(
    scene_id: u32,
    old_partition: usize,
    old_flow: usize,
    new_partition: usize,
    new_flow: usize,
) -> Result<(), PatchbackError> {
    if new_partition > old_partition || new_flow > old_flow {
        return Err(self_check(
            scene_id,
            format!(
                "new Unknown opcodes appeared (siglus-08 {old_partition}->{new_partition}, siglus-10 {old_flow}->{new_flow})"
            ),
        ));
    }
    Ok(())
}

fn scene_chunk(
    archive: &[u8],
    offset: u64,
    len: u32,
    scene_id: u32,
) -> Result<&[u8], PatchbackError> {
    let start = usize::try_from(offset)
        .map_err(|_| scene_error(scene_id, "scene offset does not fit usize"))?;
    let end = start
        .checked_add(len as usize)
        .filter(|end| *end <= archive.len())
        .ok_or_else(|| scene_error(scene_id, "scene chunk runs past archive"))?;
    Ok(&archive[start..end])
}

fn scene_error(scene_id: u32, message: impl Into<String>) -> PatchbackError {
    PatchbackError::SceneReencode {
        scene_id,
        message: message.into(),
    }
}

fn self_check(scene_id: u32, message: impl Into<String>) -> PatchbackError {
    PatchbackError::SelfCheck {
        scene_id,
        message: message.into(),
    }
}
