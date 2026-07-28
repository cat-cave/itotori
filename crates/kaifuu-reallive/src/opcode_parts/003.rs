/// Parse an ExpressionPiece **term** at `pos`: a parenthesised group /
/// complex parameter, a `\<op>` unary-prefixed term, or a bare token.
fn parse_term(bytes: &[u8], pos: usize, depth: usize) -> Result<(Expr, usize), RealLiveParseError> {
    ensure_expression_depth(bytes, pos, depth)?;
    match bytes.get(pos) {
        Some(&EXPR_PAREN_OPEN) => parse_complex(bytes, pos, depth + 1),
        Some(&EXPR_OP_PREFIX) => {
            let Some(&op) = bytes.get(pos + 1) else {
                return Err(RealLiveParseError::TruncatedExpression { offset: pos as u64 });
            };
            let (operand, operand_len) = parse_term(bytes, pos + 2, depth + 1)?;
            Ok((
                Expr::Unary {
                    op,
                    operand: Box::new(operand),
                },
                operand_len + 2,
            ))
        }
        _ => parse_token(bytes, pos, depth),
    }
}

/// Parse a full ExpressionPiece at `pos`, returning the typed [`Expr`]
/// tree and the exact number of bytes consumed.
/// Operator precedence is collapsed into a single left-to-right chain:
/// the byte length of an expression is independent of the precedence
/// grouping (every binary operator is encoded `\<op>` and joins two
/// terms), so a flat fold yields both the correct length and a faithful
/// operator tree. This is the real ExpressionPiece evaluator that drives
/// the decompiler's byte alignment — there is no heuristic body scan.
pub fn parse_expression(bytes: &[u8], pos: usize) -> Result<(Expr, usize), RealLiveParseError> {
    parse_expression_at_depth(bytes, pos, 0)
}

/// Parse an expression while carrying the current recursive grammar depth.
/// The public entry point always starts at zero; recursive callers advance it
/// before re-entering an expression through a nesting construct.
fn parse_expression_at_depth(
    bytes: &[u8],
    pos: usize,
    depth: usize,
) -> Result<(Expr, usize), RealLiveParseError> {
    ensure_expression_depth(bytes, pos, depth)?;
    let (mut node, mut len) = parse_term(bytes, pos, depth)?;
    loop {
        let cursor = pos + len;
        if bytes.get(cursor) == Some(&EXPR_OP_PREFIX) {
            let Some(&op) = bytes.get(cursor + 1) else {
                return Err(RealLiveParseError::TruncatedExpression {
                    offset: cursor as u64,
                });
            };
            let (rhs, rhs_len) = parse_term(bytes, cursor + 2, depth)?;
            node = Expr::Binary {
                op,
                lhs: Box::new(node),
                rhs: Box::new(rhs),
            };
            len += 2 + rhs_len;
        } else {
            break;
        }
    }
    Ok((node, len))
}

/// Return the existing malformed-expression error before recursive decoder
/// descent can consume enough native stack to abort the process.
fn ensure_expression_depth(
    bytes: &[u8],
    pos: usize,
    depth: usize,
) -> Result<(), RealLiveParseError> {
    if depth > MAX_EXPRESSION_DEPTH {
        return Err(RealLiveParseError::MalformedExpression {
            offset: pos as u64,
            byte: bytes.get(pos).copied().unwrap_or(0),
        });
    }
    Ok(())
}

/// Length of a string operand (bare identifier or `"`-quoted) at `pos`.
/// Bare strings run until a structural / expression delimiter; quoted
/// strings run to the closing `"`. Shift-JIS double-byte pairs are
/// consumed whole so a trail byte equal to a delimiter value does not end
/// the string early.
fn string_operand_len(bytes: &[u8], pos: usize) -> usize {
    let mut i = pos;
    if bytes.get(pos) == Some(&b'"') {
        i += 1;
        while let Some(&b) = bytes.get(i) {
            if b == b'"' {
                i += 1;
                break;
            }
            if is_shift_jis_textout_lead(b) && i + 1 < bytes.len() {
                i += 2;
            } else {
                i += 1;
            }
        }
    } else {
        while let Some(&b) = bytes.get(i) {
            if is_string_operand_delimiter(b) {
                break;
            }
            if is_shift_jis_textout_lead(b) && i + 1 < bytes.len() {
                i += 2;
            } else {
                i += 1;
            }
        }
    }
    i - pos
}

/// `true` if `byte` ends a bare (unquoted) string operand.
fn is_string_operand_delimiter(byte: u8) -> bool {
    matches!(
        byte,
        opener::META_COMMA
            | opener::META_LINE
            | opener::META_ENTRYPOINT
            | b'"'
            | opener::COMMAND
            | EXPR_DOLLAR
            | EXPR_PAREN_OPEN
            | EXPR_PAREN_CLOSE
            | opener::COMMA
            | opener::META_KIDOKU
            | EXPR_OP_PREFIX
    )
}

/// True if `byte` is a recognised BytecodeElement opener (per opcode-table
/// in `docs/research/reallive-engine.md` §D + Shift-JIS Textout leads).
pub fn is_recognized_opener(byte: u8) -> bool {
    matches!(
        byte,
        opener::META_COMMA
            | opener::META_LINE
            | opener::META_ENTRYPOINT
            | opener::COMMAND
            | opener::EXPRESSION
            | opener::COMMA
            | opener::META_KIDOKU
    ) || is_shift_jis_textout_lead(byte)
}

/// Width of a goto-family jump-target pointer (`i32` LE).
const GOTO_POINTER_LEN: usize = 4;

/// One captured goto-family jump-target pointer inside a scene's
/// decompressed (and, for `xor_2` titles, decrypted) bytecode.
/// RealLive control-flow commands (`goto`/`goto_if`/`goto_on`/`goto_case`/
/// `gosub*`/`farcall*`) carry trailing `i32 LE` pointers whose value is the
/// **absolute byte offset** of the jump destination within the same scene
/// bytecode stream (rlvm `libreallive` resolves each pointer against the
/// scene's `Pointers` table, which is a byte-offset index). When a
/// length-changing text splice shifts everything after the edit, every
/// pointer whose destination sits at/after the edit must be re-based by the
/// cumulative byte delta — the patchback drives that off this record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GotoPointerSite {
    /// Absolute byte offset (within the scene bytecode) of the 4-byte
    /// `i32 LE` pointer itself — where the recalculated value is written back.
    pub pointer_offset: usize,
    /// The current jump-target byte offset the pointer encodes (its `i32`
    /// value, absolute within the same scene bytecode stream).
    pub target: i32,
}

/// Walk a decompressed (and, for `xor_2` titles, decrypted) scene bytecode
/// stream and collect every goto-family jump-target pointer site.
/// Drives off the single-source-of-truth element decoder ([`decode_element`]
/// [`decode_command`]) so the pointer offsets can never drift from the
/// authoritative command framing: for a Command opener the pointer-recording
/// [`decode_command`] is called; every other element is advanced by
/// [`decode_element`]. The returned offsets/values are absolute within
/// `bytes` (the same coordinate space the text-splice offsets use), so the
/// patchback can re-base each target by the cumulative splice delta and write
/// the new value back at `pointer_offset`.
pub fn collect_goto_pointer_sites(
    bytes: &[u8],
) -> Result<Vec<GotoPointerSite>, RealLiveParseError> {
    if bytes.is_empty() {
        return Err(RealLiveParseError::TruncatedBytecode { input_len: 0 });
    }
    let mut sites: Vec<GotoPointerSite> = Vec::new();
    let mut pos: usize = 0;
    while pos < bytes.len() {
        let consumed = if bytes[pos] == opener::COMMAND {
            let (_op, consumed) = decode_command(bytes, pos, &mut sites)?;
            consumed
        } else {
            let (_op, consumed) = decode_element(bytes, pos)?;
            consumed
        };
        debug_assert!(consumed > 0, "decode must make forward progress");
        pos += consumed;
    }
    Ok(sites)
}

/// Goto-family classification of a Command, keyed on the 32-bit command
/// id `(module_type << 24) | (module_id << 16) | opcode_u16` (rlvm
/// `libreallive/bytecode.cc::BytecodeElement::Read`). These are the
/// commands that carry **trailing jump-target pointers** after the
/// argument list — the structure a length-only argument scan cannot see.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GotoKind {
    /// `goto` / `gosub`: 8-byte header + one `i32` target, no arglist.
    Goto,
    /// `goto_if` / `goto_unless` / `gosub_if`: header + `(cond)` + `i32`.
    GotoIf,
    /// `goto_on`: header + `(expr)` + `argc` × `i32` targets.
    GotoOn,
    /// `goto_case`: header + `(expr)` + `argc` × (`(case)` + `i32`).
    GotoCase,
    /// `gosub_with`: header + `(args)` + `i32` target.
    GosubWith,
    /// Not a goto-family command.
    None,
}

/// Map a command id to its [`GotoKind`]. The id sets are restated from
/// rlvm `libreallive/bytecode.cc`'s `BytecodeElement::Read` dispatch
/// switch (the cross-scene/`farcall` module variants `0x05`/`0x06` are
/// included alongside the intra-scene `0x01` jmp module).
fn goto_kind(command_id: u32) -> GotoKind {
    match command_id {
        0x0001_0000 | 0x0001_0005 | 0x0005_0001 | 0x0005_0005 | 0x0006_0001 | 0x0006_0005 => {
            GotoKind::Goto
        }
        0x0001_0001 | 0x0001_0002 | 0x0001_0006 | 0x0001_0007 | 0x0005_0002 | 0x0005_0006
        | 0x0005_0007 | 0x0006_0000 | 0x0006_0002 | 0x0006_0006 | 0x0006_0007 => GotoKind::GotoIf,
        0x0001_0003 | 0x0001_0008 | 0x0005_0003 | 0x0005_0008 | 0x0006_0003 | 0x0006_0008 => {
            GotoKind::GotoOn
        }
        0x0001_0004 | 0x0001_0009 | 0x0005_0004 | 0x0005_0009 | 0x0006_0004 | 0x0006_0009 => {
            GotoKind::GotoCase
        }
        0x0001_0010 | 0x0006_0010 => GotoKind::GosubWith,
        _ => GotoKind::None,
    }
}

/// Select-block open / close braces (`{` `}`) and the option-text
/// boundary bytes used by the [`decode_select`] `{ … }` framing.
const SELECT_BLOCK_OPEN: u8 = 0x7B;
const SELECT_BLOCK_CLOSE: u8 = 0x7D;

/// `true` if `command_id` is a `module_sel` selection command that the
/// compiler emits with the `SelectElement` `{ … }` block framing rather
/// than a plain `(…)` argument list — `select_w`/`select`/`select_s2`/
/// `select_s` (`(0, 2, 0..=3)`) plus the `0x10` selection variant
/// (`(0, 2, 16)`). Restated from rlvm `libreallive/bytecode.cc`'s
/// `BytecodeElement::Read` dispatch (the `SelectElement` opcode set), NOT
/// vendored. The remaining `module_sel` opcodes (`select_objbtn`,
/// `objbtn_init`, …) use the ordinary function-call framing and are
/// decoded by the generic argument-list path.
fn is_select_command(command_id: u32) -> bool {
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


