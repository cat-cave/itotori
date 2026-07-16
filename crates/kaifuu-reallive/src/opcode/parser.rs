use super::{
    RealLiveOpcode, RealLiveParseError, TextEncoding, command::decode_command,
    expression::parse_expression, is_shift_jis_textout_lead, is_structural_opener, opener,
};

/// Decode the full real-bytecode stream into a [`RealLiveOpcode`] sequence.
/// `bytes` is the **decompressed** scene bytecode (post-AVG32 LZSS + XOR
/// first-level transform per
/// `docs/research/reallive-sweetie-hd-encryption-mechanism.md`). The
/// caller owns decompression — this function operates on plaintext
/// bytecode bytes.
/// An empty input is rejected with
/// [`RealLiveParseError::TruncatedBytecode`]; the function never returns
/// `Ok(vec!)` on a non-empty input either. Every byte is partitioned
/// into a typed [`RealLiveOpcode`] element — a well-formed stream
/// produces **zero** [`RealLiveOpcode::Unknown`] spans because any byte
/// outside a structural element is a Textout (the catch-all per rlvm
/// `BytecodeElement::Read`).
pub fn parse_real_bytecode(bytes: &[u8]) -> Result<Vec<RealLiveOpcode>, RealLiveParseError> {
    Ok(parse_real_bytecode_spans(bytes)?
        .into_iter()
        .map(|(opcode, _consumed)| opcode)
        .collect())
}

/// Decode the full real-bytecode stream into `(opcode, consumed_width)`
/// pairs — the **authoritative**, width-carrying decode.
/// Each pair's `consumed_width` is exactly the number of bytes
/// [`decode_element`] (the single source of truth that `decode_command`
/// drives) consumed for that element, including any bracketed argument
/// list and trailing goto-family jump pointers. Every downstream surface
/// that needs per-element byte widths — the Scene-AST projection in
/// `parser.rs` and the bridge provenance cursor in `bridge.rs` — derives
/// its widths from this function rather than re-deriving them from a
/// hand-maintained table that could silently drift from the decoder.
/// [`parse_real_bytecode`] is a thin width-dropping wrapper over this.
pub fn parse_real_bytecode_spans(
    bytes: &[u8],
) -> Result<Vec<(RealLiveOpcode, usize)>, RealLiveParseError> {
    if bytes.is_empty() {
        return Err(RealLiveParseError::TruncatedBytecode { input_len: 0 });
    }

    let mut out: Vec<(RealLiveOpcode, usize)> = Vec::new();
    let mut pos: usize = 0;

    while pos < bytes.len() {
        let (opcode, consumed) = decode_element(bytes, pos)?;
        debug_assert!(consumed > 0, "decode_element must make forward progress");
        out.push((opcode, consumed));
        pos += consumed;
    }

    if out.is_empty() {
        return Err(RealLiveParseError::TruncatedBytecode {
            input_len: bytes.len(),
        });
    }
    Ok(out)
}

/// Decode exactly one BytecodeElement at `pos`, returning the typed
/// [`RealLiveOpcode`] and the number of bytes it consumed.
/// This is the single source of truth for element boundaries — both
/// [`parse_real_bytecode`] and the patchback re-walk drive off it so
/// their cursors never drift. The dispatch is the documented opener-byte
/// switch (`docs/research/reallive-engine.md` §D): structural openers
/// `{0x00, 0x0A, 0x21, 0x23, 0x24, 0x2C, 0x40}` decode their element;
/// every other byte begins a Textout run that extends to the next
/// structural opener (Shift-JIS pairs consumed whole).
pub(crate) fn decode_element(
    bytes: &[u8],
    pos: usize,
) -> Result<(RealLiveOpcode, usize), RealLiveParseError> {
    let lead = bytes[pos];
    match lead {
        opener::META_COMMA | opener::COMMA => Ok((RealLiveOpcode::Comma, 1)),
        opener::META_LINE => {
            let value = read_meta_u16(bytes, pos)?;
            Ok((RealLiveOpcode::MetaLine { line: value }, 3))
        }
        opener::META_ENTRYPOINT => {
            let value = read_meta_u16(bytes, pos)?;
            Ok((RealLiveOpcode::MetaEntrypoint { entrypoint: value }, 3))
        }
        opener::META_KIDOKU => {
            let value = read_meta_u16(bytes, pos)?;
            Ok((RealLiveOpcode::MetaKidoku { mark: value }, 3))
        }
        opener::EXPRESSION => {
            // The `0x24` element opener doubles as the `$` of the first
            // ExpressionPiece token; parse from `pos` so the real
            // evaluator computes the exact span (it stops precisely at
            // the expression's true end, never absorbing a following
            // Textout).
            let (_expr, len) = parse_expression(bytes, pos)?;
            let raw_bytes = bytes[pos + 1..pos + len].to_vec();
            Ok((RealLiveOpcode::Expression { raw_bytes }, len))
        }
        opener::COMMAND => {
            // The single-element decode path discards goto-pointer sites;
            // `collect_goto_pointer_sites` is the accumulating walker.
            let mut goto_sites = Vec::new();
            decode_command(bytes, pos, &mut goto_sites)
        }
        _ => {
            let (raw_bytes, consumed) = scan_textout(bytes, pos);
            Ok((
                RealLiveOpcode::Textout {
                    encoding: TextEncoding::ShiftJisInlineRun,
                    raw_bytes,
                },
                consumed,
            ))
        }
    }
}

/// Scan a Textout run beginning at `pos` (a non-structural lead byte),
/// returning its raw bytes and the byte width consumed.
/// This is the catch-all in [`decode_element`]: any byte that is not one
/// of the seven structural BytecodeElement openers
/// ([`is_structural_opener`]) begins a displayable-text (or embedded
/// binary) run that extends to the next structural opener. Shift-JIS
/// double-byte pairs ([`is_shift_jis_textout_lead`]) are consumed whole,
/// so a trail byte whose value equals a structural opener never ends the
/// run early.
/// The run is treated as an opaque byte span — commas and `"` are part of
/// the run, and the producer's surface-selection split
/// ([`decode_dialogue_textout`]) later decides whether a given run is
/// readable Shift-JIS dialogue or embedded binary data. This is the
/// minimal, version-agnostic boundary rule: applying text-only quoting /
/// comma-inlining heuristics here mis-splits embedded binary data blocks
/// (e.g. Sweetie HD's binary catch-all runs).
fn scan_textout(bytes: &[u8], pos: usize) -> (Vec<u8>, usize) {
    let start = pos;
    let mut end = pos;
    while end < bytes.len() {
        let b = bytes[end];
        if is_structural_opener(b) {
            break;
        }
        if is_shift_jis_textout_lead(b) && end + 1 < bytes.len() {
            end += 2;
        } else {
            end += 1;
        }
    }
    (bytes[start..end].to_vec(), end - start)
}

/// Read the `u16 LE` payload of a 3-byte Meta element at `pos`.
fn read_meta_u16(bytes: &[u8], pos: usize) -> Result<u16, RealLiveParseError> {
    if bytes.len() - pos < 3 {
        return Err(RealLiveParseError::TruncatedMetaHeader {
            opener: bytes[pos],
            offset: pos as u64,
            needed: 3,
            available: bytes.len() - pos,
        });
    }
    Ok(u16::from_le_bytes([bytes[pos + 1], bytes[pos + 2]]))
}
