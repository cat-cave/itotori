use super::{
    COMMAND_HEADER_LEN, CommandArg, RealLiveParseError,
    expression::{EXPR_PAREN_CLOSE, EXPR_PAREN_OPEN, parse_expression},
    opener,
};

/// Select-block open / close braces (`{` `}`) and the option-text
/// boundary bytes used by the [`decode_select`] `{ … }` framing.
pub(super) const SELECT_BLOCK_OPEN: u8 = 0x7B;
pub(super) const SELECT_BLOCK_CLOSE: u8 = 0x7D;

/// `true` if `command_id` is a `module_sel` selection command that the
/// compiler emits with the `SelectElement` `{ … }` block framing rather
/// than a plain `(…)` argument list — `select_w`/`select`/`select_s2`/
/// `select_s` (`(0, 2, 0..=3)`) plus the `0x10` selection variant
/// (`(0, 2, 16)`). Restated from rlvm `libreallive/bytecode.cc`'s
/// `BytecodeElement::Read` dispatch (the `SelectElement` opcode set), NOT
/// vendored. The remaining `module_sel` opcodes (`select_objbtn`,
/// `objbtn_init`, …) use the ordinary function-call framing and are
/// decoded by the generic argument-list path.
pub(super) fn is_select_command(command_id: u32) -> bool {
    matches!(
        command_id,
        0x0002_0000 | 0x0002_0001 | 0x0002_0002 | 0x0002_0003 | 0x0002_0010
    )
}

/// `true` if `byte` continues a RealLive **string token** in the
/// unquoted state (rlvm `libreallive` `NextString`): a Shift-JIS lead
/// byte (`0x81..=0x9F` / `0xE0..=0xEF`), an ASCII alphanumeric, space,
/// `?`, `_`, `"` or `\`. Any other byte ends the token. Restated from the
/// rlvm reference, not vendored.
fn is_next_string_byte(byte: u8) -> bool {
    matches!(byte, 0x81..=0x9F | 0xE0..=0xEF)
        || byte.is_ascii_alphanumeric()
        || matches!(byte, b' ' | b'?' | b'_' | b'"' | b'\\')
}

/// Length in bytes of the string token beginning at `pos`, mirroring rlvm
/// `NextString`: a run of [`is_next_string_byte`] bytes with Shift-JIS
/// double-byte pairs consumed whole, `"`-quoted spans that ignore the
/// boundary set until the closing quote, and the embedded
/// `###PRINT(<expr>)` interpolation form. Returns `0` when `pos` does not
/// begin a string token.
/// Inside a `"`-quoted span the backslash (`0x5C`) is the general escape
/// introducer (rlvm `NextString` quoted state): `\<byte>` consumes the
/// backslash and the following byte verbatim, whatever that byte is
/// (`\"` → literal quote, `\\` → literal backslash, `\x` → literal `x`).
/// This is what makes a translated choice option NextString-SAFE: the
/// producer ([`encode_choice_option_next_string_safe`]) escapes every
/// interior `"`/`\`, so the only *unescaped* `"` the decoder can reach is
/// the producer's closing quote — no interior byte (`[`, `,`, `!`, a
/// Shift-JIS trail byte equal to `"`, …) can terminate the token early or
/// run it past its close.
fn next_string_len(bytes: &[u8], pos: usize) -> usize {
    const PRINT_TAG: &[u8] = b"###PRINT(";
    let mut end = pos;
    let mut quoted = false;
    while end < bytes.len() {
        let b = bytes[end];
        if quoted {
            if b == b'\\' {
                // General escape: consume the backslash and the escaped
                // byte together. A trailing lone backslash (no following
                // byte) consumes just itself so `end` never exceeds the
                // buffer length.
                end += if end + 1 < bytes.len() { 2 } else { 1 };
                continue;
            }
            if b == b'"' {
                end += 1; // closing quote
                break;
            }
            // Ordinary quoted byte: Shift-JIS double-byte pairs are
            // consumed whole so a trail byte equal to `"`/`\` cannot be
            // misread as a close/escape.
            if matches!(b, 0x81..=0x9F | 0xE0..=0xEF) && end + 1 < bytes.len() {
                end += 2;
            } else {
                end += 1;
            }
            continue;
        }
        if bytes[end..].starts_with(PRINT_TAG) {
            end += PRINT_TAG.len();
            match parse_expression(bytes, end) {
                // `+ 1` consumes the closing `)` of the `###PRINT(…)`
                // interpolation (rlvm `end += 1 + NextExpression(end)`).
                Ok((_expr, len)) => end += len + 1,
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

/// Encode a translated `module_sel` choice option NextString-SAFE.
/// A raw Shift-JIS splice of translated choice text corrupts the
/// `SelectElement` framing: an option is decoded by [`next_string_len`],
/// whose *unquoted* state ends at the first byte that is not an
/// [`is_next_string_byte`] — so a translation carrying `[`, `,`, `.`, `!`,
/// `(`, `-`, … (all outside the unquoted string-token set) truncates the
/// option and lets the trailing bytes be misread as select structure
/// (`\n`+line markers, the `}` close, the next option), structurally
/// corrupting the command.
/// This encoder wraps the whole option in a `"`-quoted NextString and
/// escapes every interior single-byte `"` / `\` with a backslash. In the
/// quoted state [`next_string_len`] consumes ANY byte (arbitrary
/// punctuation, Shift-JIS pairs whose trail byte equals `"`/`\`) verbatim
/// and terminates ONLY at the producer's unescaped closing quote — so the
/// select structure and the option's `NextString` token can never be
/// corrupted, for ANY UTF-8 / Shift-JIS choice text. The escaping is done
/// per Shift-JIS *character* (not per raw byte) so a double-byte glyph
/// whose trail byte happens to equal `0x22`/`0x5C` is never split by a
/// spurious escape.
/// Returns the same [`ShiftJisEncodeError`] as [`encode_shift_jis_slot`]
/// (with the accurate first-unmappable char index) when the target text
/// carries a character outside Shift-JIS.
pub fn encode_choice_option_next_string_safe(
    text: &str,
) -> Result<Vec<u8>, crate::encoding::ShiftJisEncodeError> {
    // Validate mappability once up-front so the error carries the accurate
    // char index; the per-char re-encode below is then guaranteed to
    // succeed.
    crate::encoding::encode_shift_jis_slot(text)?;

    let mut out = Vec::with_capacity(text.len() + 2);
    out.push(b'"'); // opening quote
    let mut ch_buf = [0u8; 4];
    for ch in text.chars() {
        let sjis = crate::encoding::encode_shift_jis_slot(ch.encode_utf8(&mut ch_buf))
            .expect("char validated mappable above");
        // Only single-byte `"` / `\` need escaping; a Shift-JIS lead byte
        // (or its trail byte) is emitted as part of a whole 2-byte pair and
        // is consumed as a pair by the decoder, so it can never be mistaken
        if sjis.len() == 1 && (sjis[0] == b'"' || sjis[0] == b'\\') {
            out.push(b'\\');
        }
        out.extend_from_slice(&sjis);
    }
    out.push(b'"'); // closing quote
    Ok(out)
}

/// Decode a `module_sel` selection Command's `SelectElement` body and
/// return each option's text as a [`CommandArg`] (offset + raw bytes) plus
/// the total bytes the command consumed (8-byte header included). `pos`
/// points at the `0x23` opener.
/// Layout (rlvm `libreallive/bytecode.cc::SelectElement::SelectElement`,
/// restated, not vendored): the 8-byte header, an optional `(…)` window
/// expression, the `{` block open, an optional `\n`+i16 first-line marker,
/// then one entry per option until the matching `}`. Each option is an
/// optional `(…)` condition group (whose interior carries `\`-introduced
/// effect expressions and the single-byte effect codes the compiler emits,
/// e.g. `'2'`/`'3'` that take no operand), the option text
/// ([`next_string_len`]), and a trailing `\n`+i16 line marker. Trailing
/// `\n`+i16 markers after the `}` are consumed as junk. Only options that
/// carry non-empty text become [`CommandArg`] slots (an empty option is
/// not a translatable unit) so the produced `choices` length matches the
/// bridge / patch-back text-unit walk exactly.
pub(super) fn decode_select(
    bytes: &[u8],
    pos: usize,
) -> Result<(Vec<CommandArg>, usize), RealLiveParseError> {
    let argc_offset = pos;
    let mut cursor = pos + COMMAND_HEADER_LEN;
    let truncated = |cursor: usize| RealLiveParseError::TruncatedCommandArgs {
        offset: argc_offset as u64,
        argc: (cursor.min(u16::MAX as usize)) as u16,
    };

    // Optional window/parameter expression `(…)`.
    if bytes.get(cursor) == Some(&EXPR_PAREN_OPEN) {
        let (_expr, len) = parse_expression(bytes, cursor)?;
        cursor += len;
    }
    // Mandatory `{` block open.
    if bytes.get(cursor) != Some(&SELECT_BLOCK_OPEN) {
        return Err(truncated(cursor));
    }
    cursor += 1;
    // Optional first-line `\n`+i16 marker.
    if bytes.get(cursor) == Some(&opener::META_LINE) {
        cursor += 3;
    }

    let mut choices: Vec<CommandArg> = Vec::new();
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
        while bytes.get(cursor) == Some(&opener::COMMA) {
            cursor += 1;
        }
        if bytes.get(cursor) == Some(&opener::META_LINE) {
            cursor += 3;
        }
        if bytes.get(cursor) == Some(&SELECT_BLOCK_CLOSE) {
            cursor += 1;
            break;
        }
        // Optional condition group `(…)`.
        if bytes.get(cursor) == Some(&EXPR_PAREN_OPEN) {
            cursor += 1; // '('
            loop {
                match bytes.get(cursor) {
                    None => return Err(truncated(cursor)),
                    Some(&EXPR_PAREN_CLOSE) => {
                        cursor += 1;
                        break;
                    }
                    Some(&EXPR_PAREN_OPEN) => {
                        let (_e, len) = parse_expression(bytes, cursor)?;
                        cursor += len;
                    }
                    Some(&effect) => {
                        cursor += 1; // the single effect-code byte
                        // The `'2'`/`'3'` effect codes take no operand; any
                        // other effect code that is not immediately followed
                        // by `)` or a digit introduces a `\`/`$` expression
                        // operand.
                        if effect != b'2' && effect != b'3' {
                            let next = bytes.get(cursor).copied();
                            let stop = next == Some(EXPR_PAREN_CLOSE)
                                || next.is_some_and(|b| b.is_ascii_digit());
                            if !stop && next.is_some() {
                                let (_e, len) = parse_expression(bytes, cursor)?;
                                cursor += len;
                            }
                        }
                    }
                }
            }
        }
        // Option text.
        let text_start = cursor;
        let text_len = next_string_len(bytes, cursor);
        let text = bytes[cursor..cursor + text_len].to_vec();
        cursor += text_len;
        if !text.is_empty() {
            choices.push(CommandArg {
                byte_offset: text_start as u64,
                bytes: text,
            });
        }
        // Trailing `\n`+i16 line marker for this option.
        if bytes.get(cursor) == Some(&opener::META_LINE) {
            cursor += 3;
        } else if text_len == 0 {
            // No text and no line marker — the cursor would not advance and
            // the loop would spin. Surface a typed framing error.
            return Err(truncated(cursor));
        }
    }
    // Trailing junk: `\n`+i16 markers after the closing brace.
    while bytes.get(cursor) == Some(&opener::META_LINE) {
        cursor += 3;
    }
    Ok((choices, cursor - pos))
}
