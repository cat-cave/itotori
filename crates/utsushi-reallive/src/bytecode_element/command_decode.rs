//! CommandElement framing: header decode, goto-family targets, and arg-list walk.
//!
//! Owns [`decode_command`] and the helpers it needs to length-walk a `0x23`
//! command (optional `(...)` argument list, goto-family trailing pointers,
//! `module_sel` SelectElement option block via [`super::select_choice`]).

use super::{
    BytecodeDecodeError, BytecodeElement, COMMAND_HEADER_BYTE_LEN, GOTO_POINTER_BYTE_LEN,
    SELECT_BLOCK_CLOSE, SELECT_BLOCK_OPEN, next_data, select_choice,
};

/// Decode a `0x23` CommandElement at `bytes[pos]`. Reads the fixed
/// 8-byte header and, when the next byte is `(` (`0x28`), walks the
/// `(`-delimited argument list that follows.
///
/// **Note on `arg_count` versus the `(...)` opener.** The 8-byte
/// header's byte 5 is the *declared* argument count; the runtime
/// dispatcher (e.g. rlvm `bytecode.cc::ReadFunction` →
/// `BuildFunctionElement`) decides whether an argument list is
/// present by checking `*ptr == '('` after the header, not by
/// branching on `arg_count`. We mirror that policy here so commands
/// whose declared `arg_count == 0` but whose body still includes
/// `()` are walked correctly (and vice versa).
pub(super) fn decode_command(
    bytes: &[u8],
    pos: usize,
) -> Result<BytecodeElement, BytecodeDecodeError> {
    let header_end = pos.checked_add(COMMAND_HEADER_BYTE_LEN).ok_or_else(|| {
        BytecodeDecodeError::MalformedElement {
            position: pos,
            message: "command header end offset overflowed usize".to_string(),
        }
    })?;
    if header_end > bytes.len() {
        return Err(BytecodeDecodeError::Truncated {
            observed_len: bytes.len(),
            position: pos,
            needed: header_end - bytes.len(),
            message: format!(
                "command at position {pos} requires {COMMAND_HEADER_BYTE_LEN} header bytes",
            ),
        });
    }

    let module_type = bytes[pos + 1];
    let module_id = bytes[pos + 2];
    let opcode = u16::from_le_bytes([bytes[pos + 3], bytes[pos + 4]]);
    // Bytes 5..7 are the `u16 LE` argument / target count; byte 7 is the
    // overload selector (re-derived from rlvm `bytecode.h:CommandElement`
    // research anchor only). For `goto_on`/`goto_case`, `arg_count` is the
    // number of trailing jump targets / cases.
    let arg_count = u16::from_le_bytes([bytes[pos + 5], bytes[pos + 6]]);
    let overload = bytes[pos + 7];
    let command_id =
        (u32::from(module_type) << 24) | (u32::from(module_id) << 16) | u32::from(opcode);

    let mut cursor = header_end;
    let mut goto_targets: Vec<u32> = Vec::new();
    let mut goto_case_exprs: Vec<Vec<u8>> = Vec::new();

    // Walk the optional `(...)` argument list, advancing `cursor` past it.
    let walk_optional_args = |cursor: &mut usize| -> Result<(), BytecodeDecodeError> {
        if *cursor < bytes.len() && bytes[*cursor] == b'(' {
            *cursor = walk_command_arg_list(bytes, *cursor).map_err(|err| match err {
                BytecodeDecodeError::Truncated {
                    observed_len,
                    position,
                    needed,
                    message,
                } => BytecodeDecodeError::Truncated {
                    observed_len,
                    position,
                    needed,
                    message: format!(
                        "command at position {pos} (arg_count={arg_count}) truncated mid arg-list: {message}",
                    ),
                },
                other => other,
            })?;
        }
        Ok(())
    };

    // Consume `count` trailing `i32 LE` jump-target pointers, recording
    // each as an absolute byte offset into `goto_targets`.
    let consume_pointers = |cursor: &mut usize,
                            count: usize,
                            targets: &mut Vec<u32>|
     -> Result<(), BytecodeDecodeError> {
        let need = count.checked_mul(GOTO_POINTER_BYTE_LEN).ok_or_else(|| {
            BytecodeDecodeError::MalformedElement {
                position: pos,
                message: "goto pointer count overflowed usize".to_string(),
            }
        })?;
        let end =
            cursor
                .checked_add(need)
                .ok_or_else(|| BytecodeDecodeError::MalformedElement {
                    position: pos,
                    message: "goto pointer span overflowed usize".to_string(),
                })?;
        if end > bytes.len() {
            return Err(BytecodeDecodeError::Truncated {
                observed_len: bytes.len(),
                position: *cursor,
                needed: end - bytes.len(),
                message: format!(
                    "command at position {pos} truncated before {count} goto pointer(s)",
                ),
            });
        }
        for _ in 0..count {
            let raw = u32::from_le_bytes([
                bytes[*cursor],
                bytes[*cursor + 1],
                bytes[*cursor + 2],
                bytes[*cursor + 3],
            ]);
            targets.push(raw);
            *cursor += GOTO_POINTER_BYTE_LEN;
        }
        Ok(())
    };

    match command_goto_kind(command_id) {
        GotoKind::Goto => {
            // 8-byte header + one i32 target; no argument list.
            consume_pointers(&mut cursor, 1, &mut goto_targets)?;
        }
        GotoKind::GotoIf | GotoKind::GosubWith => {
            walk_optional_args(&mut cursor)?;
            consume_pointers(&mut cursor, 1, &mut goto_targets)?;
        }
        GotoKind::GotoOn => {
            // Discriminant `(expr)`, then a `{`-delimited block of
            // `arg_count` raw i32 jump targets.
            walk_optional_args(&mut cursor)?;
            let braced = bytes.get(cursor) == Some(&SELECT_BLOCK_OPEN);
            if braced {
                cursor += 1;
            }
            consume_pointers(&mut cursor, arg_count as usize, &mut goto_targets)?;
            if braced {
                expect_block_close(bytes, pos, &mut cursor)?;
            }
        }
        GotoKind::GotoCase => {
            // Discriminant `(expr)`, then a `{`-delimited block of
            // `arg_count` entries, each a `(case-expr)` followed by an
            // i32 target.
            walk_optional_args(&mut cursor)?;
            let braced = bytes.get(cursor) == Some(&SELECT_BLOCK_OPEN);
            if braced {
                cursor += 1;
            }
            for _ in 0..arg_count {
                if bytes.get(cursor) != Some(&b'(') {
                    return Err(BytecodeDecodeError::MalformedElement {
                        position: cursor,
                        message: format!(
                            "goto_case at position {pos}: expected '(' opening a case expression",
                        ),
                    });
                }
                let case_open = cursor;
                cursor = walk_command_arg_list(bytes, cursor)?;
                // The case's match expression is the bytes strictly inside
                // the `(…)` (between the `(` at `case_open` and its matching
                // `)` at `cursor - 1`). An empty `()` is the default case and
                // is recorded as an empty `Vec`.
                goto_case_exprs.push(bytes[case_open + 1..cursor - 1].to_vec());
                consume_pointers(&mut cursor, 1, &mut goto_targets)?;
            }
            if braced {
                expect_block_close(bytes, pos, &mut cursor)?;
            }
        }
        GotoKind::Select => {
            // `module_sel` selection commands carry a `{... }` option
            // block (SelectElement framing) rather than a `(...)` list.
            // `walk_select_block` consumes the optional leading `(param)`
            // expression and the whole `{... }` option block, mirroring
            // the proven `kaifuu-reallive` `decode_select`.
            cursor = select_choice::walk_select_block(bytes, pos, cursor)?;
        }
        GotoKind::None => {
            walk_optional_args(&mut cursor)?;
        }
    }

    let end = cursor;
    let raw_bytes = bytes[pos..end].to_vec();
    Ok(BytecodeElement::Command {
        module_type,
        module_id,
        opcode,
        arg_count,
        overload,
        goto_targets,
        goto_case_exprs,
        raw_bytes,
        byte_offset: pos,
        byte_len: end - pos,
    })
}

/// Framing class of a Command, keyed on its
/// `(module_type << 24) | (module_id << 16) | opcode` id.
///
/// The goto-family commands (`module_jmp` and its cross-scene `0x05`/`0x06`
/// module variants) carry trailing `i32` jump-target pointers after any
/// argument list — a structure a length-only argument scan cannot see.
/// Re-derived from rlvm `libreallive/bytecode.cc`'s `BytecodeElement::Read`
/// dispatch (research anchor only; not vendored).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GotoKind {
    /// `goto` / `gosub`: 8-byte header + one `i32` target, no arglist.
    Goto,
    /// `goto_if` / `goto_unless` / `gosub_if` / `gosub_with`: header
    /// `(cond|args)` + one `i32` target.
    GotoIf,
    /// `goto_on`: header + `(expr)` + `{` + `arg_count` × `i32` + `}`.
    GotoOn,
    /// `goto_case`: header + `(expr)` + `{` + `arg_count` × (`(case)`
    /// `i32`) + `}`.
    GotoCase,
    /// `gosub_with`: header + `(args)` + one `i32` target.
    GosubWith,
    /// `module_sel` selection command with a `{ … }` option block.
    Select,
    /// Not a goto-family / select command — ordinary `(...)` framing.
    None,
}

/// Map a command id to its [`GotoKind`]. Id sets restated from rlvm
/// `libreallive/bytecode.cc` (`BytecodeElement::Read`).
fn command_goto_kind(command_id: u32) -> GotoKind {
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
        0x0002_0000 | 0x0002_0001 | 0x0002_0002 | 0x0002_0003 | 0x0002_0010 => GotoKind::Select,
        _ => GotoKind::None,
    }
}

/// Assert `bytes[*cursor]` is a `}` block-close and step past it.
fn expect_block_close(
    bytes: &[u8],
    pos: usize,
    cursor: &mut usize,
) -> Result<(), BytecodeDecodeError> {
    if bytes.get(*cursor) != Some(&SELECT_BLOCK_CLOSE) {
        return Err(BytecodeDecodeError::MalformedElement {
            position: *cursor,
            message: format!("command at position {pos}: expected '}}' closing the target block"),
        });
    }
    *cursor += 1;
    Ok(())
}

/// Walk a `(...)`-delimited command argument list starting at
/// `bytes[start]` (which must be the `(` byte). Returns the input
/// index immediately past the matching `)`.
///
/// The argument list is a sequence of "data" entries terminated by
/// `)`. Each entry is length-walked by [`next_data`] which mirrors
/// the documented `NextData` reader (re-derived from rlvm
/// `expression.cc`, research anchor only).
fn walk_command_arg_list(bytes: &[u8], start: usize) -> Result<usize, BytecodeDecodeError> {
    if start >= bytes.len() {
        return Err(BytecodeDecodeError::Truncated {
            observed_len: bytes.len(),
            position: start,
            needed: 1,
            message: "command argument list missing opening byte".to_string(),
        });
    }
    if bytes[start] != b'(' {
        return Err(BytecodeDecodeError::MalformedElement {
            position: start,
            message: format!(
                "command argument list must begin with '(' (0x28); observed 0x{:02x}",
                bytes[start],
            ),
        });
    }

    let mut p = start + 1;
    loop {
        if p >= bytes.len() {
            return Err(BytecodeDecodeError::Truncated {
                observed_len: bytes.len(),
                position: p,
                needed: 1,
                message: "command argument list truncated before closing ')'".to_string(),
            });
        }
        if bytes[p] == b')' {
            return Ok(p + 1);
        }
        let consumed = next_data(bytes, p)?;
        if consumed == 0 {
            return Err(BytecodeDecodeError::MalformedElement {
                position: p,
                message: format!(
                    "next_data returned 0 bytes for lead 0x{:02x}; the walker must always \
                     make forward progress to terminate the arg-list loop",
                    bytes[p],
                ),
            });
        }
        p += consumed;
    }
}
