use super::{
    COMMAND_HEADER_LEN, CommandArg, RealLiveOpcode, RealLiveParseError,
    classification::classify_command,
    expression::{EXPR_PAREN_CLOSE, EXPR_PAREN_OPEN, parse_data},
    goto::{GOTO_POINTER_LEN, GotoKind, GotoPointerSite, goto_kind},
    opener,
    selection::{SELECT_BLOCK_CLOSE, SELECT_BLOCK_OPEN, decode_select, is_select_command},
};

/// Parse a bracketed argument list `'(' (arg (',' arg)*)? ')'` beginning
/// at `pos` (which must point at the `(`).
/// The list is split into comma-delimited **slots**; each slot's bytes
/// are the concatenation of its ExpressionPiece / string data items. A
/// `,` immediately followed by another `,` yields an empty interior
/// slot — this preserves the one-slot-per-option contract the Choice /
/// select surface walk relies on. A trailing `,` immediately before
/// `)` does NOT yield a final empty slot, and an empty `` yields zero
/// slots: the close arm only pushes the final slot when it is non-empty
/// (`cursor > slot_start`). Top-level commas are the only separators;
/// commas buried inside an integer-literal payload or a parenthesised
/// sub-expression are consumed as part of that data item by the grammar
/// and never split a slot. Returns the per-slot raw bytes plus the total
/// bytes consumed (both parentheses included).
pub(super) fn parse_arg_list(
    bytes: &[u8],
    pos: usize,
) -> Result<(Vec<CommandArg>, usize), RealLiveParseError> {
    let mut cursor = pos + 1; // skip '('
    let mut args: Vec<CommandArg> = Vec::new();
    let mut slot_start = cursor;
    loop {
        let Some(&b) = bytes.get(cursor) else {
            return Err(RealLiveParseError::TruncatedCommandArgs {
                offset: pos as u64,
                argc: 0,
            });
        };
        match b {
            EXPR_PAREN_CLOSE => {
                if cursor > slot_start {
                    args.push(CommandArg {
                        byte_offset: slot_start as u64,
                        bytes: bytes[slot_start..cursor].to_vec(),
                    });
                }
                cursor += 1;
                break;
            }
            // Top-level separator: close the current slot (possibly
            // empty) and open the next.
            opener::COMMA => {
                args.push(CommandArg {
                    byte_offset: slot_start as u64,
                    bytes: bytes[slot_start..cursor].to_vec(),
                });
                cursor += 1;
                slot_start = cursor;
            }
            // A `\n` + i16 line marker can appear between arguments
            // (rlvm `GetData`); skip its 3 bytes as part of the slot.
            opener::META_LINE => cursor += 3,
            _ => {
                // One data item (rlvm `GetData`): an arithmetic expression,
                // a string constant, or a complex / special parameter. The
                // grammar — not a delimiter scan — computes its exact width.
                let (_item, len) = parse_data(bytes, cursor)?;
                if len == 0 {
                    // No forward progress — a byte that is neither a
                    // valid expression token nor a string char. Surface a
                    // typed error rather than spin.
                    return Err(RealLiveParseError::MalformedExpression {
                        offset: cursor as u64,
                        byte: b,
                    });
                }
                cursor = (cursor + len).min(bytes.len());
            }
        }
    }
    Ok((args, cursor - pos))
}

/// Decode a single Command at `pos` into a `RealLiveOpcode` plus the
/// number of bytes consumed. `pos` points at the `0x23` opener byte.
pub(super) fn decode_command(
    bytes: &[u8],
    pos: usize,
    goto_sites: &mut Vec<GotoPointerSite>,
) -> Result<(RealLiveOpcode, usize), RealLiveParseError> {
    if bytes.len() - pos < COMMAND_HEADER_LEN {
        return Err(RealLiveParseError::TruncatedCommandHeader {
            offset: pos as u64,
            available: bytes.len() - pos,
        });
    }
    let module_type = bytes[pos + 1];
    let module_id = bytes[pos + 2];
    let opcode_u16 = u16::from_le_bytes([bytes[pos + 3], bytes[pos + 4]]);
    // The header `argc` is a `u16 LE` (bytes 5-6); byte 7 is the overload
    // selector (rlvm `bytecode.h:CommandElement`). For goto_on / goto_case
    // it is the number of trailing jump targets / cases.
    let argc = u16::from_le_bytes([bytes[pos + 5], bytes[pos + 6]]);
    let overload = bytes[pos + 7];
    let command_id =
        (u32::from(module_type) << 24) | (u32::from(module_id) << 16) | u32::from(opcode_u16);

    // `module_sel` selection commands carry a `SelectElement` `{ … }`
    // option block rather than a plain `(…)` argument list, so they are
    // framed by their own decoder before the generic paths below.
    if is_select_command(command_id) {
        let (choices, consumed) = decode_select(bytes, pos)?;
        return Ok((RealLiveOpcode::Choice { choices }, consumed));
    }

    let mut consumed = COMMAND_HEADER_LEN;
    let mut args_bytes: Vec<CommandArg> = Vec::new();

    // Helper: consume `count` trailing `i32` jump-target pointers, recording
    // each pointer's absolute byte offset + current target value so the
    // patchback can re-base it after a length-changing splice.
    let mut consume_pointers = |consumed: &mut usize,
                                count: usize|
     -> Result<(), RealLiveParseError> {
        let need = count * GOTO_POINTER_LEN;
        if pos + *consumed + need > bytes.len() {
            return Err(RealLiveParseError::TruncatedCommandArgs {
                offset: pos as u64,
                argc,
            });
        }
        for k in 0..count {
            let ptr = pos + *consumed + k * GOTO_POINTER_LEN;
            let target =
                i32::from_le_bytes([bytes[ptr], bytes[ptr + 1], bytes[ptr + 2], bytes[ptr + 3]]);
            goto_sites.push(GotoPointerSite {
                pointer_offset: ptr,
                target,
            });
        }
        *consumed += need;
        Ok(())
    };
    // Helper: consume a bracketed `(...)` arg list if one is present.
    let parse_optional_args =
        |consumed: &mut usize, args: &mut Vec<CommandArg>| -> Result<(), RealLiveParseError> {
            if bytes.get(pos + *consumed) == Some(&EXPR_PAREN_OPEN) {
                let (parsed, len) = parse_arg_list(bytes, pos + *consumed)?;
                *args = parsed;
                *consumed += len;
            }
            Ok(())
        };

    match goto_kind(command_id) {
        GotoKind::Goto => {
            // 8-byte header + one i32 target; no argument list.
            consume_pointers(&mut consumed, 1)?;
        }
        GotoKind::GotoIf | GotoKind::GosubWith => {
            parse_optional_args(&mut consumed, &mut args_bytes)?;
            consume_pointers(&mut consumed, 1)?;
        }
        GotoKind::GotoOn => {
            // `goto_on(expr) { @t0 @t1 … }` — the discriminant expression,
            // then a `{`-delimited block of `argc` raw i32 jump targets
            // (rlvm `GotoOnElement`). The braces wrap the target list.
            parse_optional_args(&mut consumed, &mut args_bytes)?;
            let braced = bytes.get(pos + consumed) == Some(&SELECT_BLOCK_OPEN);
            if braced {
                consumed += 1;
            }
            consume_pointers(&mut consumed, argc as usize)?;
            if braced {
                if bytes.get(pos + consumed) != Some(&SELECT_BLOCK_CLOSE) {
                    return Err(RealLiveParseError::TruncatedCommandArgs {
                        offset: pos as u64,
                        argc,
                    });
                }
                consumed += 1;
            }
        }
        GotoKind::GotoCase => {
            // `goto_case(expr) { (case0) @t0 (case1) @t1 … }` — the
            // discriminant expression, then a `{`-delimited block of `argc`
            // entries, each a bracketed `(case-expr)` (the default case is
            // the empty ``) followed by an i32 target (rlvm
            // `GotoCaseElement`). The braces wrap the case list.
            parse_optional_args(&mut consumed, &mut args_bytes)?;
            let braced = bytes.get(pos + consumed) == Some(&SELECT_BLOCK_OPEN);
            if braced {
                consumed += 1;
            }
            for _ in 0..argc {
                if bytes.get(pos + consumed) != Some(&EXPR_PAREN_OPEN) {
                    return Err(RealLiveParseError::TruncatedCommandArgs {
                        offset: pos as u64,
                        argc,
                    });
                }
                let (_case, len) = parse_arg_list(bytes, pos + consumed)?;
                consumed += len;
                consume_pointers(&mut consumed, 1)?;
            }
            if braced {
                if bytes.get(pos + consumed) != Some(&SELECT_BLOCK_CLOSE) {
                    return Err(RealLiveParseError::TruncatedCommandArgs {
                        offset: pos as u64,
                        argc,
                    });
                }
                consumed += 1;
            }
        }
        GotoKind::None => {
            // Ordinary function command: an optional bracketed arg list.
            parse_optional_args(&mut consumed, &mut args_bytes)?;
        }
    }

    let opcode = classify_command(module_type, module_id, opcode_u16, overload, &args_bytes)
        .unwrap_or_else(|| {
            // `classify_command` only declines a command whose
            // `module_type` is outside RealLive's documented `{0, 1, 2}`
            // space — i.e. a desync tripwire. In-space commands whose
            // `(module_id, opcode)` tuple is not catalogued decode to the
            // generic `Command` variant inside `classify_command` instead.
            RealLiveOpcode::Unknown {
                opcode: opener::COMMAND,
                raw_bytes: bytes[pos..pos + consumed].to_vec(),
            }
        });
    Ok((opcode, consumed))
}
