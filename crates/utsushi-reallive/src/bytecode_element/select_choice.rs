//! SelectElement option-block walking and choice-text extraction.
//!
//! Length-walker ([`walk_select_block`]) and text-capturer
//! ([`extract_select_choice_texts`]) for the `module_sel` SelectElement
//! `{ ... }` option block, plus the `NextString` option-token length
//! helper they share. Both mirror the proven `kaifuu-reallive`
//! `decode_select` framing (rlvm `SelectElement`).

use super::{
    BytecodeDecodeError, COMMA_LEAD_BYTE_ALT, COMMAND_HEADER_BYTE_LEN, META_LINE_LEAD_BYTE,
    SELECT_BLOCK_CLOSE, SELECT_BLOCK_OPEN, next_expression,
};

/// Walk a `module_sel` SelectElement command's framing starting at
/// `header_start` (the first byte past the 8-byte command header):
/// the optional leading `(param)` expression, then the mandatory
/// `{... }` option block. Returns the index immediately past the
/// matching `}` (plus any trailing `\n`+i16 line markers).
///
/// This is a faithful restatement of the proven `kaifuu-reallive`
/// `decode_select` (rlvm `SelectElement`): the option block is a
/// sequence of options, each an optional condition group `( <effect…> )`
/// followed by the option's `NextString` text and a trailing `\n`+i16
/// line marker. `\n`+i16 MetaLine markers, `,` separators and the
/// condition group are recognised structurally — a length-only byte scan
/// (which the previous implementation used) misreads a MetaLine
/// line-number byte that happens to equal `0x28` (`'('`) as an
/// argument-list opener and desyncs.
pub(super) fn walk_select_block(
    bytes: &[u8],
    pos: usize,
    header_start: usize,
) -> Result<usize, BytecodeDecodeError> {
    let truncated = |cursor: usize| BytecodeDecodeError::Truncated {
        observed_len: bytes.len(),
        position: cursor,
        needed: 1,
        message: format!("select command at position {pos} truncated mid option-block"),
    };
    let mut cursor = header_start;

    // Optional window / parameter expression `( … )` (mirrors kaifuu
    // `parse_expression` over the leading group).
    if bytes.get(cursor) == Some(&b'(') {
        cursor += next_expression(bytes, cursor, 0)?;
    }
    // Mandatory `{` block open.
    if bytes.get(cursor) != Some(&SELECT_BLOCK_OPEN) {
        return Err(BytecodeDecodeError::MalformedElement {
            position: cursor,
            message: format!(
                "select command at position {pos}: expected '{{' opening the option block; \
                 observed {:?}",
                bytes.get(cursor),
            ),
        });
    }
    cursor += 1;
    // Optional first-line `\n`+i16 marker.
    if bytes.get(cursor) == Some(&META_LINE_LEAD_BYTE) {
        cursor += 3;
    }

    loop {
        match bytes.get(cursor) {
            None => return Err(truncated(cursor)),
            Some(&SELECT_BLOCK_CLOSE) => {
                cursor += 1;
                break;
            }
            _ => {}
        }
        // Skip inter-option separators (`,`) and stray line markers.
        while bytes.get(cursor) == Some(&COMMA_LEAD_BYTE_ALT) {
            cursor += 1;
        }
        if bytes.get(cursor) == Some(&META_LINE_LEAD_BYTE) {
            cursor += 3;
        }
        if bytes.get(cursor) == Some(&SELECT_BLOCK_CLOSE) {
            cursor += 1;
            break;
        }
        // Optional condition group `( … )`.
        if bytes.get(cursor) == Some(&b'(') {
            cursor += 1; // '('
            loop {
                match bytes.get(cursor) {
                    None => return Err(truncated(cursor)),
                    Some(&b')') => {
                        cursor += 1;
                        break;
                    }
                    Some(&b'(') => {
                        cursor += next_expression(bytes, cursor, 0)?;
                    }
                    Some(&effect) => {
                        cursor += 1; // the single effect-code byte
                        // The `'2'`/`'3'` effect codes take no operand;
                        // any other effect code that is not immediately
                        // followed by `)` or a digit introduces a `\`/`$`
                        // expression operand.
                        if effect != b'2' && effect != b'3' {
                            let next = bytes.get(cursor).copied();
                            let stop =
                                next == Some(b')') || next.is_some_and(|b| b.is_ascii_digit());
                            if !stop && next.is_some() {
                                cursor += next_expression(bytes, cursor, 0)?;
                            }
                        }
                    }
                }
            }
        }
        // Option text (a `NextString` token).
        let text_len = next_select_string_len(bytes, cursor);
        cursor += text_len;
        // Trailing `\n`+i16 line marker for this option.
        if bytes.get(cursor) == Some(&META_LINE_LEAD_BYTE) {
            cursor += 3;
        } else if text_len == 0 {
            // No text and no line marker — the cursor would not advance
            // and the loop would spin. Surface a typed framing error.
            return Err(truncated(cursor));
        }
    }
    // Trailing junk: `\n`+i16 markers after the closing brace.
    while bytes.get(cursor) == Some(&META_LINE_LEAD_BYTE) {
        cursor += 3;
    }
    Ok(cursor)
}

/// `true` if `byte` continues a RealLive **string token** in the
/// unquoted state (rlvm `NextString`): a Shift-JIS lead byte, an ASCII
/// alphanumeric, space, `?`, `_`, `"` or `\`. Restated from
/// `kaifuu-reallive` `is_next_string_byte`.
fn is_next_string_byte(byte: u8) -> bool {
    matches!(byte, 0x81..=0x9F | 0xE0..=0xEF)
        || byte.is_ascii_alphanumeric()
        || matches!(byte, b' ' | b'?' | b'_' | b'"' | b'\\')
}

/// Length in bytes of the `NextString` option token beginning at `pos`
/// a faithful restatement of `kaifuu-reallive` `next_string_len`: a run
/// of [`is_next_string_byte`] bytes with Shift-JIS pairs consumed whole
/// `"`-quoted spans (backslash-escaped) that ignore the boundary set
/// until the closing quote, and the embedded `###PRINT(<expr>)`
/// interpolation form. Returns `0` when `pos` does not begin a string
/// token. Used only by the SelectElement option walker so the two
/// decoders frame choice options identically.
fn next_select_string_len(bytes: &[u8], pos: usize) -> usize {
    const PRINT_TAG: &[u8] = b"###PRINT(";
    let mut end = pos;
    let mut quoted = false;
    while end < bytes.len() {
        let b = bytes[end];
        if quoted {
            if b == b'\\' {
                end += if end + 1 < bytes.len() { 2 } else { 1 };
                continue;
            }
            if b == b'"' {
                end += 1; // closing quote
                break;
            }
            if matches!(b, 0x81..=0x9F | 0xE0..=0xEF) && end + 1 < bytes.len() {
                end += 2;
            } else {
                end += 1;
            }
            continue;
        }
        if bytes[end..].starts_with(PRINT_TAG) {
            end += PRINT_TAG.len();
            match next_expression(bytes, end, 0) {
                // `+ 1` consumes the closing `)` of the interpolation.
                Ok(len) => end += len + 1,
                Err(_) => break,
            }
            continue;
        }
        if b == b'"' {
            quoted = true;
            end += 1;
            continue;
        }
        if !is_next_string_byte(b) {
            break;
        }
        if matches!(b, 0x81..=0x9F | 0xE0..=0xEF) && end + 1 < bytes.len() {
            end += 2;
        } else {
            end += 1;
        }
    }
    end - pos
}

/// Extract the option TEXT byte-strings from a `module_sel`
/// SelectElement command's `{... }` option block.
///
/// `raw_bytes` is the full command element (8-byte header + optional
/// leading `(param)` window/selection expression + the `{ options }`
/// block). Returns each option's raw `NextString` bytes (Shift-JIS), in
/// option order — the selectable choice labels the SelectElement framing
/// carries.
///
/// This is the choice-render / choice-act seam: the VM feeds these
/// byte-strings to the `module_sel` [`crate::rlop::SelectOp`] as the
/// selectable choice labels, so the selection screen renders the REAL
/// options and the resolved index drives the matching branch. It mirrors
/// the framing [`walk_select_block`] length-walks (the proven
/// `kaifuu-reallive` `decode_select` shape), but captures each option's
/// text slice instead of only its length.
///
/// Lenient by construction: a truncated / malformed block returns the
/// options decoded so far rather than an error, matching the fail-soft
/// dispatch loop. Returns an empty `Vec` when `raw_bytes` carries no
/// option block (e.g. a header-only synthetic command, or a non-`sel`
/// command).
pub fn extract_select_choice_texts(raw_bytes: &[u8]) -> Vec<Vec<u8>> {
    let bytes = raw_bytes;
    let mut choices: Vec<Vec<u8>> = Vec::new();
    if bytes.len() <= COMMAND_HEADER_BYTE_LEN {
        return choices;
    }
    let mut cursor = COMMAND_HEADER_BYTE_LEN;
    // Optional leading `(param)` window / selection expression.
    if bytes.get(cursor) == Some(&b'(') {
        match next_expression(bytes, cursor, 0) {
            Ok(len) if len > 0 => cursor += len,
            _ => return choices,
        }
    }
    // Mandatory `{` option-block open.
    if bytes.get(cursor) != Some(&SELECT_BLOCK_OPEN) {
        return choices;
    }
    cursor += 1;
    // Optional first-line `\n`+i16 marker.
    if bytes.get(cursor) == Some(&META_LINE_LEAD_BYTE) {
        cursor += 3;
    }
    loop {
        let progress_start = cursor;
        match bytes.get(cursor) {
            None | Some(&SELECT_BLOCK_CLOSE) => break,
            _ => {}
        }
        // Skip inter-option separators (`,`) and stray line markers.
        while bytes.get(cursor) == Some(&COMMA_LEAD_BYTE_ALT) {
            cursor += 1;
        }
        if bytes.get(cursor) == Some(&META_LINE_LEAD_BYTE) {
            cursor += 3;
        }
        if bytes.get(cursor) == Some(&SELECT_BLOCK_CLOSE) {
            break;
        }
        // Optional condition group `( … )` — recognised structurally so a
        // MetaLine line-number byte that equals `(` cannot desync the walk.
        // The condition is not option TEXT, so it is skipped, not captured.
        if bytes.get(cursor) == Some(&b'(') {
            cursor += 1; // '('
            loop {
                match bytes.get(cursor) {
                    None => return choices,
                    Some(&b')') => {
                        cursor += 1;
                        break;
                    }
                    Some(&b'(') => match next_expression(bytes, cursor, 0) {
                        Ok(len) if len > 0 => cursor += len,
                        _ => return choices,
                    },
                    Some(&effect) => {
                        cursor += 1;
                        if effect != b'2' && effect != b'3' {
                            let next = bytes.get(cursor).copied();
                            let stop =
                                next == Some(b')') || next.is_some_and(|b| b.is_ascii_digit());
                            if !stop && next.is_some() {
                                match next_expression(bytes, cursor, 0) {
                                    Ok(len) if len > 0 => cursor += len,
                                    _ => return choices,
                                }
                            }
                        }
                    }
                }
            }
        }
        // Option text (a `NextString` token).
        let text_len = next_select_string_len(bytes, cursor);
        if text_len > 0 {
            choices.push(bytes[cursor..cursor + text_len].to_vec());
        }
        cursor += text_len;
        // Trailing `\n`+i16 line marker for this option.
        if bytes.get(cursor) == Some(&META_LINE_LEAD_BYTE) {
            cursor += 3;
        } else if text_len == 0 {
            // No text and no marker — cursor cannot advance; stop rather
            // than spin.
            break;
        }
        if cursor <= progress_start {
            // Defensive: guarantee forward progress so a pathological
            // block can never loop unbounded.
            break;
        }
    }
    choices
}
