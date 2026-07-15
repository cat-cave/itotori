use std::collections::{BTreeMap, BTreeSet};

use crate::{
    RedactedContentSummary, STRING_RELOCATION_OVERLAPPING_WRITES,
    STRING_RELOCATION_POINTER_PROVENANCE_MISMATCH, STRING_RELOCATION_UNRESOLVED_REFERENCE,
    STRING_RELOCATION_UNSUPPORTED_POINTER_FORMAT, STRING_SLOT_INVALID_ENCODING,
    STRING_SLOT_PROTECTED_SPAN_MUTATION, STRING_SLOT_TERMINATOR_LOSS,
};

use super::{
    ByteSpan, EncodedStringSlotDiagnostic, EncodedStringSlotLayout, EncodedStringSlotProtectedSpan,
    RelocatedString, StringReferenceFormat, StringRelocationDiagnostic, StringRelocationReference,
    StringRelocationSlot, StringRelocationTarget, contains_bytes,
    count_protected_token_occurrences, encode_string, parse_hex_bytes,
    protected_span_source_identity_matches,
};

pub(crate) type EncodedStringSlotResult<T> = Result<T, Box<EncodedStringSlotDiagnostic>>;
pub(crate) type StringRelocationResult<T> = Result<T, Box<StringRelocationDiagnostic>>;

pub(crate) struct RebuiltSlot<'a> {
    pub(crate) slot: &'a StringRelocationSlot,
    pub(crate) encoded_bytes: Vec<u8>,
    pub(crate) new_range: ByteSpan,
}

pub(crate) struct RangeMapping {
    pub(crate) old_range: ByteSpan,
    pub(crate) new_range: ByteSpan,
}

pub(crate) struct ReferenceWrite<'a> {
    pub(crate) reference: &'a StringRelocationReference,
    pub(crate) new_range: ByteSpan,
    pub(crate) bytes: Vec<u8>,
    pub(crate) target_old_range: ByteSpan,
    pub(crate) target_new_range: ByteSpan,
}

pub(crate) fn encode_relocated_slot(
    slot: &StringRelocationSlot,
    replacement: &StringRelocationTarget,
    source_bytes: &[u8],
) -> EncodedStringSlotResult<Vec<u8>> {
    let encoded = encode_string(&replacement.target_text, slot.encoding).map_err(|message| {
        Box::new(relocated_slot_diagnostic(
            slot,
            STRING_SLOT_INVALID_ENCODING,
            message,
            "replace_unencodable_character",
            "replace characters unsupported by the slot encoding before patching",
        ))
    })?;

    let mut required_spans = BTreeMap::<&str, Vec<&EncodedStringSlotProtectedSpan>>::new();
    for protected_span in &slot.protected_spans {
        if !protected_span.raw.is_empty() {
            required_spans
                .entry(protected_span.raw.as_str())
                .or_default()
                .push(protected_span);
        }
    }
    let mut matching_ranges = BTreeMap::<&str, BTreeSet<(u64, u64)>>::new();
    let mut matched_source_identities = BTreeSet::<String>::new();
    for mapping in &replacement.protected_span_mappings {
        let Some(source_spans) = required_spans.get(mapping.raw.as_str()) else {
            continue;
        };
        if !mapping.matches_target_text(&replacement.target_text) {
            continue;
        }
        if !protected_span_source_identity_matches(
            mapping,
            source_spans,
            &mut matched_source_identities,
        ) {
            continue;
        }
        matching_ranges
            .entry(mapping.raw.as_str())
            .or_default()
            .insert((mapping.target_start, mapping.target_end));
    }
    for (raw, source_spans) in required_spans {
        let required_count = source_spans.len();
        let mapped_count = matching_ranges.get(raw).map_or(0, BTreeSet::len);
        let actual_count = count_protected_token_occurrences(&replacement.target_text, raw);
        let raw_summary = RedactedContentSummary::from_text(raw);
        // Exact multiplicity both directions (under- and over-count).
        if mapped_count != required_count || actual_count != required_count {
            return Err(Box::new(relocated_slot_diagnostic(
                slot,
                STRING_SLOT_PROTECTED_SPAN_MUTATION,
                format!(
                    "protected span {raw_summary} has {mapped_count} target mapping(s) and {actual_count} target occurrence(s), expected {required_count}"
                ),
                "restore_protected_span",
                "preserve protected tokens and align protectedSpanMappings before relocation",
            )));
        }
    }

    match &slot.layout {
        EncodedStringSlotLayout::FixedWidth => Ok(encoded),
        EncodedStringSlotLayout::NullTerminated { terminator_hex } => {
            let terminator = parse_hex_bytes(terminator_hex).map_err(|message| {
                Box::new(relocated_slot_diagnostic(
                    slot,
                    STRING_SLOT_TERMINATOR_LOSS,
                    message,
                    "preserve_terminator",
                    "declare a valid hexadecimal terminator for this slot layout",
                ))
            })?;
            if terminator.is_empty() {
                return Err(Box::new(relocated_slot_diagnostic(
                    slot,
                    STRING_SLOT_TERMINATOR_LOSS,
                    "null-terminated slot declared an empty terminator",
                    "preserve_terminator",
                    "declare the terminator bytes required by this slot layout",
                )));
            }
            let start = slot.old_byte_range.start() as usize;
            let end = slot.old_byte_range.end() as usize;
            if end <= source_bytes.len() && !contains_bytes(&source_bytes[start..end], &terminator)
            {
                return Err(Box::new(relocated_slot_diagnostic(
                    slot,
                    STRING_SLOT_TERMINATOR_LOSS,
                    "current slot bytes do not contain the declared terminator",
                    "preserve_terminator",
                    "re-extract the source bytes or repair the slot terminator before relocation",
                )));
            }
            if contains_bytes(&encoded, &terminator) {
                return Err(Box::new(relocated_slot_diagnostic(
                    slot,
                    STRING_SLOT_TERMINATOR_LOSS,
                    "encoded target contains the terminator byte sequence before the slot terminator",
                    "preserve_terminator",
                    "remove embedded terminator bytes from the replacement text",
                )));
            }
            let mut bytes = encoded;
            bytes.extend(terminator);
            Ok(bytes)
        }
    }
}

pub(crate) fn relocated_slot_diagnostic(
    slot: &StringRelocationSlot,
    code: impl Into<String>,
    message: impl Into<String>,
    remediation_code: impl Into<String>,
    remediation: impl Into<String>,
) -> EncodedStringSlotDiagnostic {
    EncodedStringSlotDiagnostic {
        code: code.into(),
        slot_id: slot.slot_id.clone(),
        byte_range: slot.old_byte_range,
        message: message.into(),
        remediation_code: remediation_code.into(),
        remediation: remediation.into(),
    }
}

pub(crate) fn translate_old_range(range: ByteSpan, mappings: &[RangeMapping]) -> Option<ByteSpan> {
    mappings.iter().find_map(|mapping| {
        if mapping.old_range.contains_span(range)
            && mapping.old_range.len() == mapping.new_range.len()
        {
            let offset = range.start() - mapping.old_range.start();
            ByteSpan::new(
                mapping.new_range.start() + offset,
                mapping.new_range.start() + offset + range.len(),
            )
            .ok()
        } else if mapping.old_range == range {
            Some(mapping.new_range)
        } else {
            None
        }
    })
}

pub(crate) fn encode_reference_value(
    reference: &StringRelocationReference,
    rebuilt_slot: &RebuiltSlot<'_>,
) -> StringRelocationResult<Vec<u8>> {
    match &reference.format {
        StringReferenceFormat::PointerLeU32 { base_address } => {
            let pointer = base_address
                .checked_add(rebuilt_slot.new_range.start())
                .ok_or_else(|| {
                    Box::new(relocation_diagnostic(
                        STRING_RELOCATION_UNSUPPORTED_POINTER_FORMAT,
                        Some(&reference.reference_id),
                        Some(&reference.slot_id),
                        Some(reference.byte_range),
                        "pointer relocation overflowed u64 address space",
                        "repair_pointer_base",
                        "choose a pointer base and range representable by the fixture format",
                    ))
                })?;
            let pointer = u32::try_from(pointer).map_err(|_| {
                Box::new(relocation_diagnostic(
                    STRING_RELOCATION_UNSUPPORTED_POINTER_FORMAT,
                    Some(&reference.reference_id),
                    Some(&reference.slot_id),
                    Some(reference.byte_range),
                    "pointer relocation does not fit in u32 little-endian format",
                    "add_pointer_format_support",
                    "use a wider supported pointer format before patching this reference",
                ))
            })?;
            Ok(pointer.to_le_bytes().to_vec())
        }
        StringReferenceFormat::IndexLeU16 => {
            let index = u16::try_from(rebuilt_slot.new_range.start()).map_err(|_| {
                Box::new(relocation_diagnostic(
                    STRING_RELOCATION_UNSUPPORTED_POINTER_FORMAT,
                    Some(&reference.reference_id),
                    Some(&reference.slot_id),
                    Some(reference.byte_range),
                    "index relocation does not fit in u16 little-endian format",
                    "add_pointer_format_support",
                    "use a wider supported index format before patching this reference",
                ))
            })?;
            Ok(index.to_le_bytes().to_vec())
        }
        StringReferenceFormat::Unsupported { .. } => Err(Box::new(relocation_diagnostic(
            STRING_RELOCATION_UNSUPPORTED_POINTER_FORMAT,
            Some(&reference.reference_id),
            Some(&reference.slot_id),
            Some(reference.byte_range),
            "reference uses an unsupported pointer format",
            "add_pointer_format_support",
            "add an explicit supported relocation encoder before patching this reference",
        ))),
    }
}

pub(crate) fn decode_reference_old_target(
    reference: &StringRelocationReference,
    source_bytes: &[u8],
) -> StringRelocationResult<u64> {
    let start = usize::try_from(reference.byte_range.start()).map_err(|_| {
        Box::new(relocation_diagnostic(
            STRING_RELOCATION_UNRESOLVED_REFERENCE,
            Some(&reference.reference_id),
            Some(&reference.slot_id),
            Some(reference.byte_range),
            "reference byte range start is not addressable on this platform",
            "repair_reference_range",
            "declare reference ranges within the fixture source bytes",
        ))
    })?;
    let end = usize::try_from(reference.byte_range.end()).map_err(|_| {
        Box::new(relocation_diagnostic(
            STRING_RELOCATION_UNRESOLVED_REFERENCE,
            Some(&reference.reference_id),
            Some(&reference.slot_id),
            Some(reference.byte_range),
            "reference byte range end is not addressable on this platform",
            "repair_reference_range",
            "declare reference ranges within the fixture source bytes",
        ))
    })?;
    let bytes = source_bytes.get(start..end).ok_or_else(|| {
        Box::new(relocation_diagnostic(
            STRING_RELOCATION_UNRESOLVED_REFERENCE,
            Some(&reference.reference_id),
            Some(&reference.slot_id),
            Some(reference.byte_range),
            "reference byte range exceeds source bytes",
            "repair_reference_range",
            "declare reference ranges within the fixture source bytes",
        ))
    })?;

    match &reference.format {
        StringReferenceFormat::PointerLeU32 { base_address } => {
            let bytes: [u8; 4] = bytes.try_into().map_err(|_| {
                Box::new(relocation_diagnostic(
                    STRING_RELOCATION_UNSUPPORTED_POINTER_FORMAT,
                    Some(&reference.reference_id),
                    Some(&reference.slot_id),
                    Some(reference.byte_range),
                    "reference byte range width does not match u32 little-endian pointer format",
                    "repair_reference_width",
                    "declare a byte range matching the supported reference format width",
                ))
            })?;
            let pointer = u32::from_le_bytes(bytes) as u64;
            pointer.checked_sub(*base_address).ok_or_else(|| {
                Box::new(relocation_diagnostic(
                    STRING_RELOCATION_POINTER_PROVENANCE_MISMATCH,
                    Some(&reference.reference_id),
                    Some(&reference.slot_id),
                    Some(reference.byte_range),
                    format!(
                        "source pointer decodes to absolute address {pointer}, before base address {base_address}"
                    ),
                    "repair_reference_provenance",
                    "re-extract the pointer table or bind this reference to the slot currently targeted by the source bytes",
                ))
            })
        }
        StringReferenceFormat::IndexLeU16 => {
            let bytes: [u8; 2] = bytes.try_into().map_err(|_| {
                Box::new(relocation_diagnostic(
                    STRING_RELOCATION_UNSUPPORTED_POINTER_FORMAT,
                    Some(&reference.reference_id),
                    Some(&reference.slot_id),
                    Some(reference.byte_range),
                    "reference byte range width does not match u16 little-endian index format",
                    "repair_reference_width",
                    "declare a byte range matching the supported reference format width",
                ))
            })?;
            Ok(u16::from_le_bytes(bytes) as u64)
        }
        StringReferenceFormat::Unsupported { .. } => Err(Box::new(relocation_diagnostic(
            STRING_RELOCATION_UNSUPPORTED_POINTER_FORMAT,
            Some(&reference.reference_id),
            Some(&reference.slot_id),
            Some(reference.byte_range),
            "reference uses an unsupported pointer format",
            "add_pointer_format_support",
            "add an explicit supported relocation encoder before patching this reference",
        ))),
    }
}

pub(crate) fn reference_provenance_mismatch_diagnostic(
    reference: &StringRelocationReference,
    decoded_old_target: u64,
    expected_old_target: u64,
) -> StringRelocationDiagnostic {
    let table_semantic = match reference.format {
        StringReferenceFormat::PointerLeU32 { base_address } => format!(
            "pointer_le_u32 entries encode baseAddress + slot oldByteRange.start; baseAddress={base_address}"
        ),
        StringReferenceFormat::IndexLeU16 => {
            "index_le_u16 table entries encode slot oldByteRange.start as a source byte offset"
                .to_string()
        }
        StringReferenceFormat::Unsupported { .. } => {
            "unsupported relocation formats have no validated source table semantic".to_string()
        }
    };
    relocation_diagnostic(
        STRING_RELOCATION_POINTER_PROVENANCE_MISMATCH,
        Some(&reference.reference_id),
        Some(&reference.slot_id),
        Some(reference.byte_range),
        format!(
            "source reference decodes to old target {decoded_old_target}, but slot {} starts at {expected_old_target}; {table_semantic}",
            reference.slot_id
        ),
        "repair_reference_provenance",
        "re-extract the pointer or index table, or bind this reference to the slot currently targeted by the source bytes",
    )
}

pub(crate) fn validate_reference_write_overlaps(
    diagnostics: &mut Vec<StringRelocationDiagnostic>,
    writes: &[ReferenceWrite<'_>],
    relocated_strings: &[RelocatedString],
) {
    let mut ranges = writes
        .iter()
        .map(|write| {
            (
                write.reference.reference_id.as_str(),
                write.reference.slot_id.as_str(),
                write.new_range,
            )
        })
        .collect::<Vec<_>>();
    ranges.sort_by_key(|(_, _, range)| (range.start(), range.end()));
    for window in ranges.windows(2) {
        if window[0].2.overlaps(window[1].2) {
            diagnostics.push(relocation_diagnostic(
                STRING_RELOCATION_OVERLAPPING_WRITES,
                Some(window[1].0),
                Some(window[1].1),
                Some(window[1].2),
                "relocation reference writes overlap each other",
                "repair_reference_ranges",
                "declare non-overlapping pointer or index table reference ranges",
            ));
        }
    }

    for (reference_id, slot_id, reference_range) in ranges {
        for relocated_string in relocated_strings {
            if reference_range.overlaps(relocated_string.new_byte_range) {
                diagnostics.push(relocation_diagnostic(
                    STRING_RELOCATION_OVERLAPPING_WRITES,
                    Some(reference_id),
                    Some(slot_id),
                    Some(reference_range),
                    "reference write overlaps rebuilt string bytes",
                    "separate_reference_table",
                    "keep relocation references outside rebuilt string payload byte ranges",
                ));
            }
        }
    }
}

pub(crate) fn relocation_diagnostic(
    code: impl Into<String>,
    reference_id: Option<&str>,
    slot_id: Option<&str>,
    byte_range: Option<ByteSpan>,
    message: impl Into<String>,
    remediation_code: impl Into<String>,
    remediation: impl Into<String>,
) -> StringRelocationDiagnostic {
    StringRelocationDiagnostic {
        code: code.into(),
        reference_id: reference_id.map(str::to_string),
        slot_id: slot_id.map(str::to_string),
        byte_range,
        message: message.into(),
        remediation_code: remediation_code.into(),
        remediation: remediation.into(),
    }
}
