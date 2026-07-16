use super::{
    BgiBytecodePatchCase, BgiBytecodePatchError, BgiBytecodePatchReport,
    BgiBytecodeStringReference, BgiBytecodeVariant, PatchBackTransform, code_start_for_variant,
    encode_shift_jis, find_code_end, parse_bgi_bytecode, patch_error, proof_hash_for_bytes,
};

pub(super) fn patch_bgi_bytecode(
    source_bytes: &[u8],
    variant: BgiBytecodeVariant,
    patch_cases: &[BgiBytecodePatchCase],
) -> Result<(Vec<u8>, Vec<BgiBytecodePatchReport>), BgiBytecodePatchError> {
    let references =
        parse_bgi_bytecode(source_bytes, variant).map_err(|error| BgiBytecodePatchError {
            diagnostic: error.diagnostic,
        })?;
    let code_start =
        code_start_for_variant(source_bytes, variant).map_err(|error| BgiBytecodePatchError {
            diagnostic: error.diagnostic,
        })?;
    let code_end =
        find_code_end(source_bytes, code_start).map_err(|error| BgiBytecodePatchError {
            diagnostic: error.diagnostic,
        })?;
    let code_size = code_end - code_start;
    let mut patched_prefix = source_bytes[..code_end].to_vec();
    let mut replacement_by_slot = std::collections::BTreeMap::<(u64, u64, u64), Vec<u8>>::new();
    let mut reports = Vec::with_capacity(patch_cases.len());
    let source_hash = proof_hash_for_bytes(source_bytes);

    for patch in patch_cases {
        let reference = references
            .iter()
            .find(|reference| reference.reference_id == patch.reference_id)
            .ok_or_else(|| {
                patch_error(
                    "patch_reference_not_found",
                    format!("patchCases.{}", patch.patch_id),
                    format!(
                        "patch case referenced unknown BGI string reference {}",
                        patch.reference_id
                    ),
                )
            })?;
        let replacement = encode_shift_jis(&patch.replacement_text).map_err(|message| {
            patch_error(
                "patch_replacement_not_shift_jis",
                format!("patchCases.{}", patch.patch_id),
                message,
            )
        })?;
        if replacement.contains(&0) {
            return Err(patch_error(
                "patch_replacement_contains_nul",
                format!("patchCases.{}", patch.patch_id),
                "BGI replacement strings must not contain embedded NUL bytes",
            ));
        }

        let slot = (
            reference.string_start_byte,
            reference.string_end_byte,
            reference.terminator_byte,
        );
        if let Some(previous) = replacement_by_slot.get(&slot)
            && previous != &replacement
        {
            return Err(patch_error(
                "patch_overlaps_previous_patch",
                format!("patchCases.{}", patch.patch_id),
                "BGI patch cases targeting the same string slot must use the same replacement text",
            ));
        }
        replacement_by_slot.insert(slot, replacement.clone());
        reports.push(BgiBytecodePatchReport {
            patch_id: patch.patch_id.clone(),
            reference_id: patch.reference_id.clone(),
            patch_back: PatchBackTransform::RecompileBytecode,
            original_text: reference.decoded_text.clone(),
            replacement_text: patch.replacement_text.clone(),
            original_byte_len: reference.string_end_byte - reference.string_start_byte,
            replacement_byte_len: replacement.len() as u64,
            source_hash: source_hash.clone(),
            patched_hash: source_hash.clone(),
            patched_text_verified: false,
            untouched_bytes_identical: false,
        });
    }

    let mut slots = references
        .iter()
        .map(|reference| {
            (
                reference.string_start_byte,
                reference.string_end_byte,
                reference.terminator_byte,
            )
        })
        .collect::<Vec<_>>();
    slots.sort_unstable();
    slots.dedup();

    let mut cursor = code_end;
    let mut rebuilt_text = Vec::new();
    for (string_start, string_end, terminator) in slots {
        let start = usize::try_from(string_start).map_err(|_| {
            patch_error(
                "patch_range_out_of_bounds",
                "stringReferences",
                "BGI string start offset does not fit in memory",
            )
        })?;
        let end = usize::try_from(string_end).map_err(|_| {
            patch_error(
                "patch_range_out_of_bounds",
                "stringReferences",
                "BGI string end offset does not fit in memory",
            )
        })?;
        let term = usize::try_from(terminator).map_err(|_| {
            patch_error(
                "patch_range_out_of_bounds",
                "stringReferences",
                "BGI string terminator offset does not fit in memory",
            )
        })?;
        if start < cursor || end > term || term >= source_bytes.len() {
            return Err(patch_error(
                "patch_range_out_of_bounds",
                "stringReferences",
                "BGI string-reference byte range is outside the source buffer or overlaps a previous slot",
            ));
        }

        rebuilt_text.extend_from_slice(&source_bytes[cursor..start]);
        let new_relative = rebuilt_text.len();
        let pointer = u32::try_from(code_size + new_relative).map_err(|_| {
            patch_error(
                "patch_pointer_overflow",
                "stringReferences",
                "rebuilt BGI string table exceeds the 32-bit code-size-relative pointer range",
            )
        })?;
        for reference in references.iter().filter(|reference| {
            reference.string_start_byte == string_start
                && reference.string_end_byte == string_end
                && reference.terminator_byte == terminator
        }) {
            let pointer_offset = usize::try_from(reference.pointer_offset_byte).map_err(|_| {
                patch_error(
                    "patch_range_out_of_bounds",
                    "stringReferences",
                    "BGI pointer offset does not fit in memory",
                )
            })?;
            let pointer_end = pointer_offset.checked_add(4).ok_or_else(|| {
                patch_error(
                    "patch_range_out_of_bounds",
                    "stringReferences",
                    "BGI pointer offset overflows",
                )
            })?;
            let Some(slot) = patched_prefix.get_mut(pointer_offset..pointer_end) else {
                return Err(patch_error(
                    "patch_range_out_of_bounds",
                    "stringReferences",
                    "BGI pointer field is outside the code prefix",
                ));
            };
            slot.copy_from_slice(&pointer.to_le_bytes());
        }

        if let Some(replacement) = replacement_by_slot.get(&(string_start, string_end, terminator))
        {
            rebuilt_text.extend_from_slice(replacement);
        } else {
            rebuilt_text.extend_from_slice(&source_bytes[start..end]);
        }
        rebuilt_text.push(0);
        cursor = term + 1;
    }
    rebuilt_text.extend_from_slice(&source_bytes[cursor..]);

    let mut patched = patched_prefix;
    patched.extend_from_slice(&rebuilt_text);

    let reparsed =
        parse_bgi_bytecode(&patched, variant).map_err(|error| BgiBytecodePatchError {
            diagnostic: error.diagnostic,
        })?;
    let patched_hash = proof_hash_for_bytes(&patched);
    for report in &mut reports {
        let reparsed_reference = reparsed
            .iter()
            .find(|reference| reference.reference_id == report.reference_id)
            .ok_or_else(|| {
                patch_error(
                    "patched_reference_missing_after_reparse",
                    format!("patchCases.{}", report.patch_id),
                    "patched BGI bytecode no longer exposes the target string reference",
                )
            })?;
        report.patched_text_verified = reparsed_reference.decoded_text == report.replacement_text;
        report.untouched_bytes_identical = string_table_gaps_identical(
            source_bytes,
            &patched,
            variant,
            &references,
            &reparsed,
            &replacement_by_slot,
        );
        report.patched_hash = patched_hash.clone();
        if !report.patched_text_verified {
            return Err(patch_error(
                "patched_text_not_verified",
                format!("patchCases.{}", report.patch_id),
                "patched BGI bytecode did not reparse to the requested replacement text",
            ));
        }
        if !report.untouched_bytes_identical {
            return Err(patch_error(
                "patch_untouched_bytes_changed",
                format!("patchCases.{}", report.patch_id),
                "BGI patch changed non-string bytes or unpatched string contents",
            ));
        }
    }

    Ok((patched, reports))
}

fn string_table_gaps_identical(
    source_bytes: &[u8],
    patched_bytes: &[u8],
    variant: BgiBytecodeVariant,
    original: &[BgiBytecodeStringReference],
    reparsed: &[BgiBytecodeStringReference],
    replaced_slots: &std::collections::BTreeMap<(u64, u64, u64), Vec<u8>>,
) -> bool {
    let Ok(code_start) = code_start_for_variant(source_bytes, variant) else {
        return false;
    };
    let Ok(code_end) = find_code_end(source_bytes, code_start) else {
        return false;
    };
    if patched_bytes.len() < code_end || source_bytes[..code_start] != patched_bytes[..code_start] {
        return false;
    }
    let pointer_ranges = original
        .iter()
        .filter_map(|reference| {
            let start = usize::try_from(reference.pointer_offset_byte).ok()?;
            Some(start..start + 4)
        })
        .collect::<Vec<_>>();
    for index in code_start..code_end {
        if pointer_ranges.iter().any(|range| range.contains(&index)) {
            continue;
        }
        if source_bytes.get(index) != patched_bytes.get(index) {
            return false;
        }
    }
    original.iter().all(|reference| {
        let slot = (
            reference.string_start_byte,
            reference.string_end_byte,
            reference.terminator_byte,
        );
        if replaced_slots.contains_key(&slot) {
            return true;
        }
        reparsed
            .iter()
            .find(|candidate| candidate.reference_id == reference.reference_id)
            .is_some_and(|candidate| candidate.decoded_text == reference.decoded_text)
    })
}
