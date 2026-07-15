use std::collections::{BTreeMap, BTreeSet};

use crate::{
    STRING_RELOCATION_INVALID_SOURCE_BYTES, STRING_RELOCATION_OVERLAPPING_WRITES,
    STRING_RELOCATION_UNRESOLVED_REFERENCE, STRING_RELOCATION_UNSUPPORTED_POINTER_FORMAT,
    content_hash,
};

use super::string_relocation_encode::{
    RangeMapping, RebuiltSlot, ReferenceWrite, decode_reference_old_target, encode_reference_value,
    encode_relocated_slot, reference_provenance_mismatch_diagnostic, relocation_diagnostic,
    translate_old_range, validate_reference_write_overlaps,
};
use super::string_relocation_types::bytes_to_hex;
use super::{
    ByteSpan, RelocatedString, RelocatedStringReference, StringReferenceFormat,
    StringRelocationDiagnostic, StringRelocationPlanReport, StringTableRebuildRequest,
    parse_hex_bytes,
};

pub fn plan_string_table_rebuild(
    request: &StringTableRebuildRequest,
) -> StringRelocationPlanReport {
    let mut diagnostics = request.string_slot_diagnostics.clone();
    let mut relocation_diagnostics = validate_relocation_request(request);
    if !diagnostics.is_empty() || !relocation_diagnostics.is_empty() {
        return StringRelocationPlanReport::failed(
            request.fixture_id.clone(),
            diagnostics,
            relocation_diagnostics,
        );
    }

    // `validate_relocation_request` already rejects an unparseable source
    // (returning above), so this re-parse normally succeeds; the Err arm
    // remains as a typed defensive guard that never panics.
    let source_bytes = match parse_hex_bytes(&request.source_bytes_hex) {
        Ok(bytes) => bytes,
        Err(message) => {
            relocation_diagnostics.push(relocation_diagnostic(
                STRING_RELOCATION_INVALID_SOURCE_BYTES,
                None,
                None,
                None,
                format!("source bytes are not valid hex: {message}"),
                "repair_fixture_source_bytes",
                "provide deterministic hexadecimal fixture bytes before rebuilding",
            ));
            return StringRelocationPlanReport::failed(
                request.fixture_id.clone(),
                diagnostics,
                relocation_diagnostics,
            );
        }
    };

    let replacements = request
        .replacements
        .iter()
        .map(|replacement| (replacement.slot_id.as_str(), replacement))
        .collect::<BTreeMap<_, _>>();
    let mut rebuilt_slots = Vec::new();
    for slot in &request.slots {
        let Some(replacement) = replacements.get(slot.slot_id.as_str()) else {
            relocation_diagnostics.push(relocation_diagnostic(
                STRING_RELOCATION_UNRESOLVED_REFERENCE,
                None,
                Some(&slot.slot_id),
                Some(slot.old_byte_range),
                "slot has no replacement target",
                "provide_slot_replacement",
                "include a deterministic targetText for every rebuilt slot",
            ));
            continue;
        };
        match encode_relocated_slot(slot, replacement, &source_bytes) {
            Ok(encoded_bytes) => rebuilt_slots.push(RebuiltSlot {
                slot,
                encoded_bytes,
                new_range: ByteSpan::new(0, 0).unwrap(),
            }),
            Err(diagnostic) => diagnostics.push(*diagnostic),
        }
    }

    if !diagnostics.is_empty() || !relocation_diagnostics.is_empty() {
        return StringRelocationPlanReport::failed(
            request.fixture_id.clone(),
            diagnostics,
            relocation_diagnostics,
        );
    }

    rebuilt_slots.sort_by_key(|slot| {
        (
            slot.slot.old_byte_range.start(),
            slot.slot.old_byte_range.end(),
        )
    });
    let mut output = Vec::new();
    let mut cursor = 0_u64;
    let mut mappings = Vec::new();
    for rebuilt_slot in &mut rebuilt_slots {
        if cursor < rebuilt_slot.slot.old_byte_range.start() {
            let gap_start = cursor as usize;
            let gap_end = rebuilt_slot.slot.old_byte_range.start() as usize;
            let new_start = output.len() as u64;
            output.extend_from_slice(&source_bytes[gap_start..gap_end]);
            let new_end = output.len() as u64;
            mappings.push(RangeMapping {
                old_range: ByteSpan::new(cursor, rebuilt_slot.slot.old_byte_range.start()).unwrap(),
                new_range: ByteSpan::new(new_start, new_end).unwrap(),
            });
        }

        let new_start = output.len() as u64;
        output.extend_from_slice(&rebuilt_slot.encoded_bytes);
        let new_end = output.len() as u64;
        rebuilt_slot.new_range = ByteSpan::new(new_start, new_end).unwrap();
        mappings.push(RangeMapping {
            old_range: rebuilt_slot.slot.old_byte_range,
            new_range: rebuilt_slot.new_range,
        });
        cursor = rebuilt_slot.slot.old_byte_range.end();
    }

    if cursor < source_bytes.len() as u64 {
        let new_start = output.len() as u64;
        output.extend_from_slice(&source_bytes[cursor as usize..]);
        let new_end = output.len() as u64;
        mappings.push(RangeMapping {
            old_range: ByteSpan::new(cursor, source_bytes.len() as u64).unwrap(),
            new_range: ByteSpan::new(new_start, new_end).unwrap(),
        });
    }

    let relocated_strings = rebuilt_slots
        .iter()
        .map(|rebuilt_slot| {
            let encoded_hash = content_hash(&bytes_to_hex(&rebuilt_slot.encoded_bytes));
            RelocatedString {
                slot_id: rebuilt_slot.slot.slot_id.clone(),
                old_byte_range: rebuilt_slot.slot.old_byte_range,
                new_byte_range: rebuilt_slot.new_range,
                encoded_hash: encoded_hash.clone(),
                output_hash_inputs: vec![
                    format!("fixture={}", request.fixture_id),
                    format!("slot={}", rebuilt_slot.slot.slot_id),
                    format!(
                        "old={}..{}",
                        rebuilt_slot.slot.old_byte_range.start(),
                        rebuilt_slot.slot.old_byte_range.end()
                    ),
                    format!(
                        "new={}..{}",
                        rebuilt_slot.new_range.start(),
                        rebuilt_slot.new_range.end()
                    ),
                    format!("encodedHash={encoded_hash}"),
                ],
            }
        })
        .collect::<Vec<_>>();

    let slots_by_id = rebuilt_slots
        .iter()
        .map(|rebuilt_slot| (rebuilt_slot.slot.slot_id.as_str(), rebuilt_slot))
        .collect::<BTreeMap<_, _>>();
    let mut relocated_references = Vec::new();
    let mut reference_writes = Vec::new();
    for reference in &request.references {
        let Some(rebuilt_slot) = slots_by_id.get(reference.slot_id.as_str()) else {
            relocation_diagnostics.push(relocation_diagnostic(
                STRING_RELOCATION_UNRESOLVED_REFERENCE,
                Some(&reference.reference_id),
                Some(&reference.slot_id),
                Some(reference.byte_range),
                "reference points at a slot that was not rebuilt",
                "repair_reference_slot_id",
                "bind every relocation reference to a rebuilt slot id",
            ));
            continue;
        };
        match decode_reference_old_target(reference, &source_bytes) {
            Ok(decoded_old_target)
                if decoded_old_target == rebuilt_slot.slot.old_byte_range.start() => {}
            Ok(decoded_old_target) => {
                relocation_diagnostics.push(reference_provenance_mismatch_diagnostic(
                    reference,
                    decoded_old_target,
                    rebuilt_slot.slot.old_byte_range.start(),
                ));
                continue;
            }
            Err(diagnostic) => {
                relocation_diagnostics.push(*diagnostic);
                continue;
            }
        }
        let Some(new_reference_range) = translate_old_range(reference.byte_range, &mappings) else {
            relocation_diagnostics.push(relocation_diagnostic(
                STRING_RELOCATION_UNRESOLVED_REFERENCE,
                Some(&reference.reference_id),
                Some(&reference.slot_id),
                Some(reference.byte_range),
                "reference byte range is not represented in the rebuilt output",
                "repair_reference_range",
                "declare reference bytes outside relocated string payload ranges",
            ));
            continue;
        };
        let reference_bytes = match encode_reference_value(reference, rebuilt_slot) {
            Ok(bytes) => bytes,
            Err(diagnostic) => {
                relocation_diagnostics.push(*diagnostic);
                continue;
            }
        };
        reference_writes.push(ReferenceWrite {
            reference,
            new_range: new_reference_range,
            bytes: reference_bytes,
            target_new_range: rebuilt_slot.new_range,
            target_old_range: rebuilt_slot.slot.old_byte_range,
        });
    }

    validate_reference_write_overlaps(
        &mut relocation_diagnostics,
        &reference_writes,
        &relocated_strings,
    );
    if !relocation_diagnostics.is_empty() {
        return StringRelocationPlanReport::failed(
            request.fixture_id.clone(),
            diagnostics,
            relocation_diagnostics,
        );
    }

    for write in &reference_writes {
        let start = write.new_range.start() as usize;
        let end = write.new_range.end() as usize;
        output[start..end].copy_from_slice(&write.bytes);
        let output_hash_inputs = vec![
            format!("fixture={}", request.fixture_id),
            format!("reference={}", write.reference.reference_id),
            format!("slot={}", write.reference.slot_id),
            format!("kind={:?}", write.reference.format.relocation_kind()),
            format!(
                "oldReference={}..{}",
                write.reference.byte_range.start(),
                write.reference.byte_range.end()
            ),
            format!(
                "newReference={}..{}",
                write.new_range.start(),
                write.new_range.end()
            ),
            format!(
                "targetNew={}..{}",
                write.target_new_range.start(),
                write.target_new_range.end()
            ),
            format!("writeHash={}", content_hash(&bytes_to_hex(&write.bytes))),
        ];
        relocated_references.push(RelocatedStringReference {
            reference_id: write.reference.reference_id.clone(),
            slot_id: write.reference.slot_id.clone(),
            old_byte_range: write.reference.byte_range,
            new_byte_range: write.new_range,
            relocation_kind: write.reference.format.relocation_kind(),
            target_old_byte_range: write.target_old_range,
            target_new_byte_range: write.target_new_range,
            output_hash_inputs,
        });
    }

    relocated_references.sort_by_key(|reference| {
        (
            reference.reference_id.clone(),
            reference.slot_id.clone(),
            reference.new_byte_range.start(),
        )
    });

    StringRelocationPlanReport::passed(
        request.fixture_id.clone(),
        relocated_strings,
        relocated_references,
        output,
    )
}

fn validate_relocation_request(
    request: &StringTableRebuildRequest,
) -> Vec<StringRelocationDiagnostic> {
    let mut diagnostics = Vec::new();
    // Distinguish a *genuinely empty* source (valid hex parsing to a
    // zero-length vector → `Some(0)`) from a *parse failure* (`None`). A
    // parse failure must not collapse to `source_len = 0`, because a length
    // of zero would silently gate OFF every slot bounds check below and let
    // a positive-offset slot reach the rebuild path, where it indexes an
    // empty slice and panics. Both cases now surface a typed diagnostic.
    let source_len = match parse_hex_bytes(&request.source_bytes_hex) {
        Ok(bytes) => Some(bytes.len() as u64),
        Err(message) => {
            diagnostics.push(relocation_diagnostic(
                STRING_RELOCATION_INVALID_SOURCE_BYTES,
                None,
                None,
                None,
                format!("source bytes are not valid hex: {message}"),
                "repair_fixture_source_bytes",
                "provide deterministic hexadecimal fixture bytes before rebuilding",
            ));
            None
        }
    };

    let mut slot_ids = BTreeSet::new();
    let mut slot_ranges = Vec::new();
    for slot in &request.slots {
        if !slot_ids.insert(slot.slot_id.as_str()) {
            diagnostics.push(relocation_diagnostic(
                STRING_RELOCATION_UNRESOLVED_REFERENCE,
                None,
                Some(&slot.slot_id),
                Some(slot.old_byte_range),
                "slot id is declared more than once",
                "deduplicate_slot_ids",
                "declare each rebuilt slot exactly once",
            ));
        }
        // Bounds-check whenever the source length is known — including a
        // genuinely empty source (`Some(0)`), where any positive-offset
        // slot exceeds it and must be rejected rather than bypassed.
        if let Some(source_len) = source_len
            && slot.old_byte_range.end() > source_len
        {
            diagnostics.push(relocation_diagnostic(
                STRING_RELOCATION_UNRESOLVED_REFERENCE,
                None,
                Some(&slot.slot_id),
                Some(slot.old_byte_range),
                "slot byte range exceeds source bytes",
                "repair_slot_range",
                "declare slot ranges within the fixture source bytes",
            ));
        }
        slot_ranges.push((slot.slot_id.as_str(), slot.old_byte_range));
    }

    slot_ranges.sort_by_key(|(_, range)| (range.start(), range.end()));
    for window in slot_ranges.windows(2) {
        if window[0].1.overlaps(window[1].1) {
            diagnostics.push(relocation_diagnostic(
                STRING_RELOCATION_OVERLAPPING_WRITES,
                None,
                Some(window[1].0),
                Some(window[1].1),
                "rebuilt string slot overlaps another slot",
                "repair_slot_ranges",
                "declare non-overlapping string payload ranges before rebuilding",
            ));
        }
    }

    let mut replacement_ids = BTreeSet::new();
    for replacement in &request.replacements {
        if !replacement_ids.insert(replacement.slot_id.as_str()) {
            diagnostics.push(relocation_diagnostic(
                STRING_RELOCATION_UNRESOLVED_REFERENCE,
                None,
                Some(&replacement.slot_id),
                None,
                "replacement target is declared more than once",
                "deduplicate_replacements",
                "provide one replacement target per rebuilt slot",
            ));
        }
        if !slot_ids.contains(replacement.slot_id.as_str()) {
            diagnostics.push(relocation_diagnostic(
                STRING_RELOCATION_UNRESOLVED_REFERENCE,
                None,
                Some(&replacement.slot_id),
                None,
                "replacement target references an unknown slot",
                "repair_replacement_slot_id",
                "bind replacement targets to declared rebuilt slots",
            ));
        }
    }

    let mut reference_ids = BTreeSet::new();
    let mut reference_ranges = Vec::new();
    for reference in &request.references {
        if !reference_ids.insert(reference.reference_id.as_str()) {
            diagnostics.push(relocation_diagnostic(
                STRING_RELOCATION_UNRESOLVED_REFERENCE,
                Some(&reference.reference_id),
                Some(&reference.slot_id),
                Some(reference.byte_range),
                "reference id is declared more than once",
                "deduplicate_reference_ids",
                "declare each relocation reference exactly once",
            ));
        }
        if !slot_ids.contains(reference.slot_id.as_str()) {
            diagnostics.push(relocation_diagnostic(
                STRING_RELOCATION_UNRESOLVED_REFERENCE,
                Some(&reference.reference_id),
                Some(&reference.slot_id),
                Some(reference.byte_range),
                "reference points at an unknown slot id",
                "repair_reference_slot_id",
                "bind every relocation reference to a declared slot",
            ));
        }
        if matches!(reference.format, StringReferenceFormat::Unsupported { .. }) {
            diagnostics.push(relocation_diagnostic(
                STRING_RELOCATION_UNSUPPORTED_POINTER_FORMAT,
                Some(&reference.reference_id),
                Some(&reference.slot_id),
                Some(reference.byte_range),
                "reference uses an unsupported pointer format",
                "add_pointer_format_support",
                "add an explicit supported relocation encoder before patching this reference",
            ));
        }
        if reference.format.width() != 0 && reference.byte_range.len() != reference.format.width() {
            diagnostics.push(relocation_diagnostic(
                STRING_RELOCATION_UNSUPPORTED_POINTER_FORMAT,
                Some(&reference.reference_id),
                Some(&reference.slot_id),
                Some(reference.byte_range),
                "reference byte range width does not match its pointer format",
                "repair_reference_width",
                "declare a byte range matching the supported reference format width",
            ));
        }
        if let Some(source_len) = source_len
            && reference.byte_range.end() > source_len
        {
            diagnostics.push(relocation_diagnostic(
                STRING_RELOCATION_UNRESOLVED_REFERENCE,
                Some(&reference.reference_id),
                Some(&reference.slot_id),
                Some(reference.byte_range),
                "reference byte range exceeds source bytes",
                "repair_reference_range",
                "declare reference ranges within the fixture source bytes",
            ));
        }
        reference_ranges.push((
            reference.reference_id.as_str(),
            reference.slot_id.as_str(),
            reference.byte_range,
        ));
    }

    for (reference_id, slot_id, reference_range) in &reference_ranges {
        for (_, slot_range) in &slot_ranges {
            if reference_range.overlaps(*slot_range) {
                diagnostics.push(relocation_diagnostic(
                    STRING_RELOCATION_OVERLAPPING_WRITES,
                    Some(reference_id),
                    Some(slot_id),
                    Some(*reference_range),
                    "reference write overlaps a relocated string payload",
                    "separate_reference_table",
                    "keep relocation references outside rebuilt string payload byte ranges",
                ));
            }
        }
    }

    diagnostics
}
