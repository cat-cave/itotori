use super::*;
use std::fmt::Write;

use crate::encoding::{SliceSegment, slice_control_bytes};

/// Detect protected spans in a single Shift-JIS `StringSlot`.
/// `raw_bytes` is the verbatim slot bytes (including control bytes);
/// `decoded_text` is the result of [`crate::encoding::decode_shift_jis_slot`]
/// on the same bytes. The caller is responsible for keeping the two
/// arguments aligned.
pub fn detect_protected_spans(
    raw_bytes: &[u8],
    decoded_text: &str,
) -> Result<ProtectedSpanReport, ProtectedSpanError> {
    let mut spans = Vec::new();
    let mut warnings = Vec::new();

    // Step 1: ASCII placeholders that appear inside text runs (the
    // RLDEV-documented `\{<digits>\}` name placeholder and the `\\<name>`
    // variable placeholder). These are detected against the raw bytes
    // because they are ASCII; the decoded text byte offsets are computed
    // alongside.
    detect_ascii_placeholders(raw_bytes, decoded_text, &mut spans)?;

    // Step 2: Control bytes. Walk the control byte segments and emit one
    // span per documented kind, or an `unknown_control` warning for any
    // byte not in the catalogue. We skip bytes already consumed as
    // argument bytes by an earlier control code (e.g. `0x1f 0x03`
    // is one color_code span covering both bytes, so the `0x03` byte
    // must not trigger another detection).
    let segments = slice_control_bytes(raw_bytes);
    let mut consumed_through: usize = 0;
    for window_index in 0..segments.len() {
        let SliceSegment::Control { byte_offset, byte } = segments[window_index] else {
            continue;
        };
        if byte_offset < consumed_through {
            continue;
        }
        let span = match byte {
            // Color code: 0x1f <index>
            0x1f => {
                let (consumed, index) = consume_byte_arg(&segments, window_index, byte_offset);
                let end = byte_offset + 1 + consumed;
                let raw = &raw_bytes[byte_offset..end];
                let decoded_offset = decoded_byte_offset_for_raw_offset(raw_bytes, byte_offset);
                let decoded_end = decoded_byte_offset_for_raw_offset(raw_bytes, end);
                Some(RealLiveProtectedSpan {
                    kind: ProtectedSpanKind::ColorCode { color_index: index },
                    raw_bytes_hex: hex_upper(raw),
                    raw_text: decoded_slice(decoded_text, decoded_offset, decoded_end)?,
                    byte_range_start: byte_offset as u64,
                    byte_range_end: end as u64,
                    decoded_range_start: decoded_offset as u64,
                    decoded_range_end: decoded_end as u64,
                })
            }
            // Ruby annotation: 0x0d <base bytes> 0x0a <ruby bytes> 0x09.
            // Search forward for the matching 0x0a and 0x09 within the
            // raw_bytes.
            0x0d => {
                if let Some((base, ruby, end)) = parse_ruby(raw_bytes, byte_offset) {
                    let raw = &raw_bytes[byte_offset..end];
                    let decoded_offset = decoded_byte_offset_for_raw_offset(raw_bytes, byte_offset);
                    let decoded_end = decoded_byte_offset_for_raw_offset(raw_bytes, end);
                    Some(RealLiveProtectedSpan {
                        kind: ProtectedSpanKind::Ruby { base, ruby },
                        raw_bytes_hex: hex_upper(raw),
                        raw_text: decoded_slice(decoded_text, decoded_offset, decoded_end)?,
                        byte_range_start: byte_offset as u64,
                        byte_range_end: end as u64,
                        decoded_range_start: decoded_offset as u64,
                        decoded_range_end: decoded_end as u64,
                    })
                } else {
                    warnings.push(ProtectedSpanWarning {
                        code: PROTECTED_SPAN_UNKNOWN_CONTROL_CODE.to_string(),
                        message: format!(
                            "ruby-open at byte offset {byte_offset} did not match the documented \
                         base-and-annotation shape; preserving as unknown control"
                        ),
                        byte_offset: byte_offset as u64,
                        byte_len: 1,
                    });
                    Some(simple_control_span(
                        raw_bytes,
                        decoded_text,
                        byte_offset,
                        ProtectedSpanKind::UnknownControl { byte: 0x0d },
                    )?)
                }
            }
            // Choice token: 0x02 <index>
            0x02 => {
                let (consumed, index) = consume_byte_arg(&segments, window_index, byte_offset);
                let end = byte_offset + 1 + consumed;
                let raw = &raw_bytes[byte_offset..end];
                let decoded_offset = decoded_byte_offset_for_raw_offset(raw_bytes, byte_offset);
                let decoded_end = decoded_byte_offset_for_raw_offset(raw_bytes, end);
                Some(RealLiveProtectedSpan {
                    kind: ProtectedSpanKind::ChoiceToken {
                        choice_index: index,
                    },
                    raw_bytes_hex: hex_upper(raw),
                    raw_text: decoded_slice(decoded_text, decoded_offset, decoded_end)?,
                    byte_range_start: byte_offset as u64,
                    byte_range_end: end as u64,
                    decoded_range_start: decoded_offset as u64,
                    decoded_range_end: decoded_end as u64,
                })
            }
            // Text size directive: 0x1e <size>
            0x1e => {
                let (consumed, size_byte) = consume_byte_arg(&segments, window_index, byte_offset);
                let end = byte_offset + 1 + consumed;
                let raw = &raw_bytes[byte_offset..end];
                let decoded_offset = decoded_byte_offset_for_raw_offset(raw_bytes, byte_offset);
                let decoded_end = decoded_byte_offset_for_raw_offset(raw_bytes, end);
                Some(RealLiveProtectedSpan {
                    kind: ProtectedSpanKind::TextSizeDirective { size_byte },
                    raw_bytes_hex: hex_upper(raw),
                    raw_text: decoded_slice(decoded_text, decoded_offset, decoded_end)?,
                    byte_range_start: byte_offset as u64,
                    byte_range_end: end as u64,
                    decoded_range_start: decoded_offset as u64,
                    decoded_range_end: decoded_end as u64,
                })
            }
            // Wait directive: 0x10 <frames>
            0x10 => {
                let (consumed, frames_byte) =
                    consume_byte_arg(&segments, window_index, byte_offset);
                let end = byte_offset + 1 + consumed;
                let raw = &raw_bytes[byte_offset..end];
                let decoded_offset = decoded_byte_offset_for_raw_offset(raw_bytes, byte_offset);
                let decoded_end = decoded_byte_offset_for_raw_offset(raw_bytes, end);
                Some(RealLiveProtectedSpan {
                    kind: ProtectedSpanKind::WaitDirective { frames_byte },
                    raw_bytes_hex: hex_upper(raw),
                    raw_text: decoded_slice(decoded_text, decoded_offset, decoded_end)?,
                    byte_range_start: byte_offset as u64,
                    byte_range_end: end as u64,
                    decoded_range_start: decoded_offset as u64,
                    decoded_range_end: decoded_end as u64,
                })
            }
            // Clear text box (page break): 0x0c
            0x0c => Some(simple_control_span(
                raw_bytes,
                decoded_text,
                byte_offset,
                ProtectedSpanKind::ClearTextBox,
            )?),
            // Line break: 0x0a (when not consumed by ruby).
            0x0a => Some(simple_control_span(
                raw_bytes,
                decoded_text,
                byte_offset,
                ProtectedSpanKind::LineBreak,
            )?),
            // Anything else `< 0x20`: unknown control byte. Preserve.
            other if other < 0x20 => {
                let byte_summary = RedactedContentSummary::from_bytes(&[other]);
                warnings.push(ProtectedSpanWarning {
                    code: PROTECTED_SPAN_UNKNOWN_CONTROL_CODE.to_string(),
                    message: format!(
                        "unrecognized control byte {byte_summary} at byte offset \
                         {byte_offset}; preserving verbatim per no-silent-skip policy"
                    ),
                    byte_offset: byte_offset as u64,
                    byte_len: 1,
                });
                Some(simple_control_span(
                    raw_bytes,
                    decoded_text,
                    byte_offset,
                    ProtectedSpanKind::UnknownControl { byte: other },
                )?)
            }
            _ => None,
        };
        if let Some(span) = span {
            // Suppress duplicates that may arise when a ruby span has
            // already consumed an inner 0x0a line-break byte: drop spans
            // whose byte range is fully covered by an earlier ruby.
            let already_covered = spans.iter().any(|existing: &RealLiveProtectedSpan| {
                matches!(existing.kind, ProtectedSpanKind::Ruby { .. })
                    && existing.byte_range_start <= span.byte_range_start
                    && existing.byte_range_end >= span.byte_range_end
            });
            if !already_covered {
                consumed_through = span.byte_range_end as usize;
                spans.push(span);
            }
        }
    }

    // Re-sort spans by byte_range_start so the bridge output is stable.
    spans.sort_by_key(|span| (span.byte_range_start, span.byte_range_end));
    Ok(ProtectedSpanReport { spans, warnings })
}

fn simple_control_span(
    raw_bytes: &[u8],
    decoded_text: &str,
    byte_offset: usize,
    kind: ProtectedSpanKind,
) -> Result<RealLiveProtectedSpan, ProtectedSpanError> {
    let end = byte_offset + 1;
    let raw = &raw_bytes[byte_offset..end];
    let decoded_offset = decoded_byte_offset_for_raw_offset(raw_bytes, byte_offset);
    let decoded_end = decoded_byte_offset_for_raw_offset(raw_bytes, end);
    Ok(RealLiveProtectedSpan {
        kind,
        raw_bytes_hex: hex_upper(raw),
        raw_text: decoded_slice(decoded_text, decoded_offset, decoded_end)?,
        byte_range_start: byte_offset as u64,
        byte_range_end: end as u64,
        decoded_range_start: decoded_offset as u64,
        decoded_range_end: decoded_end as u64,
    })
}

/// Find the next byte after a one-byte-argument control code. Returns
/// `(consumed_arg_len, arg_byte)`; when the control byte is at end-of-
/// buffer, consumes zero bytes and treats the argument as `0`.
fn consume_byte_arg(
    segments: &[SliceSegment<'_>],
    control_index: usize,
    control_byte_offset: usize,
) -> (usize, u8) {
    // The argument is the byte immediately after the control byte in the
    // raw stream. Because `slice_control_bytes` splits each control byte
    // into its own segment, the next byte may be either (a) the start of a
    // text segment, or (b) another control segment (no argument). We
    // disambiguate based on adjacency to `control_byte_offset + 1`.
    if let Some(next_segment) = segments.get(control_index + 1) {
        match next_segment {
            SliceSegment::Text { byte_offset, bytes }
                if *byte_offset == control_byte_offset + 1 && !bytes.is_empty() =>
            {
                return (1, bytes[0]);
            }
            SliceSegment::Control { byte_offset, byte }
                if *byte_offset == control_byte_offset + 1 =>
            {
                return (1, *byte);
            }
            _ => {}
        }
    }
    (0, 0)
}

fn parse_ruby(raw_bytes: &[u8], start: usize) -> Option<(String, String, usize)> {
    // Find the next 0x0a after `start`.
    let mut base_end = None;
    let mut i = start + 1;
    while i < raw_bytes.len() {
        if raw_bytes[i] == 0x0a {
            base_end = Some(i);
            break;
        }
        i += 1;
    }
    let base_end = base_end?;
    let mut ruby_end = None;
    let mut j = base_end + 1;
    while j < raw_bytes.len() {
        if raw_bytes[j] == 0x09 {
            ruby_end = Some(j);
            break;
        }
        j += 1;
    }
    let ruby_end = ruby_end?;
    let base_bytes = &raw_bytes[start + 1..base_end];
    let ruby_bytes = &raw_bytes[base_end + 1..ruby_end];
    // Decode the inner bytes as Shift-JIS so the bridge sees readable
    // Unicode in `parsed_name`. Lossy decode is acceptable for diagnostics.
    let base = crate::encoding::decode_shift_jis_slot(base_bytes).text;
    let ruby = crate::encoding::decode_shift_jis_slot(ruby_bytes).text;
    Some((base, ruby, ruby_end + 1))
}

fn detect_ascii_placeholders(
    raw_bytes: &[u8],
    decoded_text: &str,
    spans: &mut Vec<RealLiveProtectedSpan>,
) -> Result<(), ProtectedSpanError> {
    // `\{<digits>\}` name placeholders.
    let mut i = 0;
    while i + 1 < raw_bytes.len() {
        if raw_bytes[i] == b'\\' && raw_bytes[i + 1] == b'{' {
            // find matching `\}`
            let mut j = i + 2;
            let mut end = None;
            while j + 1 < raw_bytes.len() {
                if raw_bytes[j] == b'\\' && raw_bytes[j + 1] == b'}' {
                    end = Some(j + 2);
                    break;
                }
                j += 1;
            }
            if let Some(end) = end {
                let inner = &raw_bytes[i + 2..end - 2];
                let inner_str = String::from_utf8_lossy(inner).into_owned();
                let raw = &raw_bytes[i..end];
                let decoded_offset = decoded_byte_offset_for_raw_offset(raw_bytes, i);
                let decoded_end = decoded_byte_offset_for_raw_offset(raw_bytes, end);
                spans.push(RealLiveProtectedSpan {
                    kind: ProtectedSpanKind::NamePlaceholder { index: inner_str },
                    raw_bytes_hex: hex_upper(raw),
                    raw_text: decoded_slice(decoded_text, decoded_offset, decoded_end)?,
                    byte_range_start: i as u64,
                    byte_range_end: end as u64,
                    decoded_range_start: decoded_offset as u64,
                    decoded_range_end: decoded_end as u64,
                });
                i = end;
                continue;
            }
        }
        // `\\<identifier>` variable placeholders (double backslash + ASCII identifier).
        if raw_bytes[i] == b'\\'
            && raw_bytes[i + 1] == b'\\'
            && i + 2 < raw_bytes.len()
            && is_identifier_start(raw_bytes[i + 2])
        {
            let mut j = i + 2;
            while j < raw_bytes.len() && is_identifier_cont(raw_bytes[j]) {
                j += 1;
            }
            let end = j;
            let name_bytes = &raw_bytes[i + 2..end];
            let name = String::from_utf8_lossy(name_bytes).into_owned();
            let raw = &raw_bytes[i..end];
            let decoded_offset = decoded_byte_offset_for_raw_offset(raw_bytes, i);
            let decoded_end = decoded_byte_offset_for_raw_offset(raw_bytes, end);
            spans.push(RealLiveProtectedSpan {
                kind: ProtectedSpanKind::VariablePlaceholder { name },
                raw_bytes_hex: hex_upper(raw),
                raw_text: decoded_slice(decoded_text, decoded_offset, decoded_end)?,
                byte_range_start: i as u64,
                byte_range_end: end as u64,
                decoded_range_start: decoded_offset as u64,
                decoded_range_end: decoded_end as u64,
            });
            i = end;
            continue;
        }
        i += 1;
    }
    Ok(())
}

fn is_identifier_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || byte == b'_'
}

fn is_identifier_cont(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// Compute the byte offset within the decoded text that corresponds to
/// the given raw-byte offset.
/// Implementation: decode the raw bytes up to `raw_offset`, ignoring
/// control bytes (which encoding_rs maps to single-byte C0 control
/// characters). Used to align protected-span byte ranges in the decoded
/// String.
fn decoded_byte_offset_for_raw_offset(raw_bytes: &[u8], raw_offset: usize) -> usize {
    let raw_offset = raw_offset.min(raw_bytes.len());
    let decoded = crate::encoding::decode_shift_jis_slot(&raw_bytes[..raw_offset]).text;
    decoded.len()
}

fn hex_upper(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(out, "{byte:02X}").expect("write to string never fails");
    }
    out
}
