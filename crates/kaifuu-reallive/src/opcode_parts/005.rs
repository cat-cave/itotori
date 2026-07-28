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
/// FAILS the semantic-zero gate. On the proven observed / Kanon corpora
/// every real tuple is enumerated and lands in a named family.
/// `module_id` keys are restated from the rlvm `src/modules/module_*.cc`
/// registrations (`RLModule(name, type, id)`) and `libreallive/bytecode.cc`
/// dispatch — reference, not vendored.
fn classify_command(
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
        // proven observed / Kanon corpora).
        _ => generic(),
    };
    Some(mapped)
}

/// Reduce an [`Expr`] to a constant `i32` when it is (or wraps) an
/// integer literal. Used to decorate `Wait` / `Background` / `VoicePlay`
/// with their first scalar argument.
fn expr_as_i32(expr: &Expr) -> Option<i32> {
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
fn first_arg_as_i32(args_bytes: &[CommandArg]) -> Option<i32> {
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
fn first_arg_as_u32(args_bytes: &[CommandArg]) -> Option<u32> {
    first_arg_as_i32(args_bytes).map(|value| value as u32)
}

/// Decode the full real-bytecode stream into a [`RealLiveOpcode`] sequence.
/// `bytes` is the **decompressed** scene bytecode (post-AVG32 LZSS + XOR
/// first-level transform per
/// the encryption-mechanism research note). The
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
/// (e.g. the observed corpus's binary catch-all runs).
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


