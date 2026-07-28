use crate::command_catalog::{is_catalogued_command_opcode, is_coverage_manifest_opcode};

use super::expression::*;
use super::flow::*;
use super::selection::*;
use super::*;

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
                let (_item, len) = parse_data(bytes, cursor, 0)?;
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

/// Classify a fully-framed Command into a typed [`RealLiveOpcode`].
/// The byte framing (header, argument list, goto pointers, select block)
/// is already resolved by [`decode_command`]; this is purely the
/// *labelling* pass. It returns `None` **only** when `module_type` is
/// outside RealLive's documented `{0, 1, 2}` space — a desync tripwire the
/// caller records as [`RealLiveOpcode::Unknown`]. In-space commands first
/// pass through an enumerated `(module_id, opcode)` allow-list: only
/// catalogued opcodes resolve to a **semantically-typed** operation family
/// keyed on `module_id` (the engine's real semantic key — `module_type` is
/// a compiler-version artifact, so e.g. `Wait` is observed at both
/// `0:4:100` and `1:4:100`). The generic [`RealLiveOpcode::Command`] is
/// reached by either an uncatalogued in-space `module_id` or an
/// uncatalogued opcode inside a known module — it is NOT recognised and
/// FAILS the semantic-zero gate. On the proven observed / second validated corpora
/// every real tuple is enumerated and lands in a named family.
/// `module_id` keys are restated from the rlvm `src/modules/module_*.cc`
/// registrations (`RLModule(name, type, id)`) and `libreallive/bytecode.cc`
/// dispatch — reference, not vendored.
pub(super) fn classify_command(
    module_type: u8,
    module_id: u8,
    opcode_u16: u16,
    overload: u8,
    args_bytes: &[CommandArg],
) -> Option<RealLiveOpcode> {
    if module_type > 2 {
        return None;
    }
    let command_id =
        (u32::from(module_type) << 24) | (u32::from(module_id) << 16) | u32::from(opcode_u16);

    // Un-catalogued fallback: an in-space `module_id` no semantic family
    // covers. Structurally decoded but NOT recognised — fails the
    // semantic-zero gate. Never reached on the proven corpora.
    let generic = || RealLiveOpcode::Command {
        module_type,
        module_id,
        opcode: opcode_u16,
        overload,
        args: args_bytes.to_vec(),
    };

    // Control-flow commands (`module_jmp` and the cross-scene `gosub`/
    // `farcall` module variants) were byte-consumed via their goto framing;
    // label them by family.
    match goto_kind(command_id) {
        GotoKind::Goto => return Some(RealLiveOpcode::Goto),
        GotoKind::GotoIf => return Some(RealLiveOpcode::Branch),
        GotoKind::GotoOn | GotoKind::GotoCase => return Some(RealLiveOpcode::If),
        GotoKind::GosubWith => return Some(RealLiveOpcode::Call),
        GotoKind::None => {}
    }

    if !is_catalogued_command_opcode(module_id, opcode_u16)
        && !is_coverage_manifest_opcode(module_id, opcode_u16)
    {
        return Some(generic());
    }

    let mapped = match module_id {
        // module_jmp (rlvm `module_jmp.cc`, id 1) — the non-pointer opcodes
        // (the pointer-carrying ones are handled by goto framing above).
        // Module 1 is the control-flow namespace, so any residual opcode is a
        // jump/computed-flow form rather than a generic blob.
        module_id::JMP => match opcode_u16 {
            0 | 1 => RealLiveOpcode::Goto,
            2 | 3 => RealLiveOpcode::Branch,
            4 | 5 => RealLiveOpcode::If,
            10..=13 => RealLiveOpcode::Call,
            20..=22 => RealLiveOpcode::Return,
            _ => RealLiveOpcode::Jump,
        },
        // module_sel (rlvm `module_sel.cc`, id 2) — the translatable
        // `select*` option blocks were decoded to `Choice` before classify;
        // every other opcode is selection-button setup / state.
        module_id::SEL => RealLiveOpcode::SelectionControl { opcode: opcode_u16 },
        // module_msg (rlvm `module_msg.cc`, id 3) — opcode 3 is the character
        // speaker text op; catalogued opcodes in the text-display range
        // decode to `TextDisplay`; the remaining catalogued opcodes are
        // non-dialogue window directives.
        module_id::MSG => match opcode_u16 {
            3 => RealLiveOpcode::CharacterTextDisplay,
            x if (1..=200).contains(&x) => RealLiveOpcode::TextDisplay {
                encoding: TextEncoding::ShiftJisLengthPrefixed,
            },
            _ => RealLiveOpcode::MessageControl { opcode: opcode_u16 },
        },
        // module_sys (rlvm `module_sys.cc`, id 4) — `end` / `wait` keep their
        // named variants; the long control / query tail is system control.
        module_id::SYS => match opcode_u16 {
            17 => RealLiveOpcode::End,
            100 | 101 => RealLiveOpcode::Wait {
                duration_ms: first_arg_as_i32(args_bytes),
            },
            _ => RealLiveOpcode::SystemControl { opcode: opcode_u16 },
        },
        // module_sys second registration id (5) — system-class control.
        module_id::SYS2 => RealLiveOpcode::SystemControl { opcode: opcode_u16 },
        // module_str-class indexed variable / flag module (id 10) — uniform
        // single integer memory-bank reference operand.
        module_id::STR => RealLiveOpcode::VariableOp { opcode: opcode_u16 },
        // module_mem (rlvm `module_mem.cc`, id 11) — any variable-bank write.
        module_id::MEM => RealLiveOpcode::SetVariable,
        // Audio channels (module_bgm / module_se / module_pcm, ids 20/21/22)
        // — play (by filename) / stop / fade / volume.
        module_id::AUDIO_BGM | module_id::AUDIO_SE | module_id::AUDIO_PCM => {
            RealLiveOpcode::Audio {
                module_id,
                opcode: opcode_u16,
            }
        }
        // module_koe (rlvm `module_koe.cc`, id 23) — voice playback.
        module_id::KOE => RealLiveOpcode::VoicePlay {
            voice_id: first_arg_as_u32(args_bytes),
        },
        // module_grp (rlvm `module_grp.cc`, id 33) — background / sprite load
        // (first arg is the sprite id).
        module_id::GRP => RealLiveOpcode::Background {
            sprite_id: first_arg_as_u32(args_bytes),
        },
        // Screen / frame / weather / animation-layer control (ids
        // 30/31/40/60/61/62) — whole-screen / effect-layer graphics ops.
        30 | 31 | 40 | 60 | 61 | 62 => RealLiveOpcode::ScreenControl {
            module_id,
            opcode: opcode_u16,
        },
        // Display-object (sprite-plane) modules — foreground / background /
        // child object planes and their range (`module_type = 2`) forms.
        71 | 72 | 73 | 81 | 82 | 84 | 85 | 90 | 91 => RealLiveOpcode::GraphicsObject {
            module_id,
            opcode: opcode_u16,
        },
        // An in-space module id the catalogue has not reached: the typed
        // fallback that FAILS the semantic-zero gate (never occurs on the
        // proven observed / second validated corpora).
        _ => generic(),
    };
    Some(mapped)
}

/// Reduce an [`Expr`] to a constant `i32` when it is (or wraps) an
/// integer literal. Used to decorate `Wait` / `Background` / `VoicePlay`
/// with their first scalar argument.
pub(super) fn expr_as_i32(expr: &Expr) -> Option<i32> {
    match expr {
        Expr::IntLiteral { value } => Some(*value),
        // A single-item complex parameter is a parenthesised value `(lit)`.
        Expr::Complex { items } if items.len() == 1 => expr_as_i32(&items[0]),
        _ => None,
    }
}

/// Parse the first argument's bytes as an ExpressionPiece and return its
/// integer value when it is a constant literal. The argument bytes are a
/// full expression (e.g. `$ 0xFF` + i32), decoded by the real
/// [`parse_expression`] evaluator rather than a byte-prefix guess.
pub(super) fn first_arg_as_i32(args_bytes: &[CommandArg]) -> Option<i32> {
    args_bytes
        .first()
        .and_then(|arg| parse_expression(&arg.bytes, 0).ok())
        .and_then(|(expr, _)| expr_as_i32(&expr))
}

/// Surface the first argument literal as a `u32` **id** without losing
/// magnitude or sign information. Asset / voice ids are bit-packed `u32`
/// values (e.g. `voice_id = (archive_id << 16) | sample_id`), so the raw
/// `i32` bit pattern is reinterpreted (`as u32`) rather than passed
/// through `unsigned_abs`, which would flip a negative literal to its
/// absolute value and corrupt the id.
pub(super) fn first_arg_as_u32(args_bytes: &[CommandArg]) -> Option<u32> {
    first_arg_as_i32(args_bytes).map(|value| value as u32)
}
