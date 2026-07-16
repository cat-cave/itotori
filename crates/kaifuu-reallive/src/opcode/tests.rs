use super::*;
use super::{classification::*, command::*, expression::*};

#[test]
fn empty_input_surfaces_truncated_bytecode_not_silent_ok() {
    let err = parse_real_bytecode(&[]).expect_err("empty input must error");
    assert!(matches!(
        err,
        RealLiveParseError::TruncatedBytecode { input_len: 0 }
    ));
}

#[test]
fn decodes_sweetie_hd_scene_1_prologue_into_documented_meta_run() {
    // First 16 bytes of decompressed Sweetie HD scene 1 per
    // docs/research/reallive-sweetie-hd-encryption-mechanism.md §4.2.
    let bytes: &[u8] = &[
        0x0a, 0x02, 0x00, 0x0a, 0x03, 0x00, 0x21, 0x00, 0x00, 0x0a, 0x04, 0x00, 0x0a, 0x05, 0x00,
        0x0a,
    ];
    let _ = parse_real_bytecode(bytes); // 16-byte feed runs into a partial MetaLine
    // Documented: MetaLine(2), MetaLine(3), MetaEntrypoint(0),
    // MetaLine(4), MetaLine(5), then a partial MetaLine that runs
    // off the end → TruncatedMetaHeader. We pass only the 15 bytes
    // that align to a clean element boundary:
    let bytes = &bytes[..15];
    let opcodes = parse_real_bytecode(bytes).expect("decode must succeed");
    assert_eq!(opcodes.len(), 5);
    assert!(matches!(opcodes[0], RealLiveOpcode::MetaLine { line: 2 }));
    assert!(matches!(opcodes[1], RealLiveOpcode::MetaLine { line: 3 }));
    assert!(matches!(
        opcodes[2],
        RealLiveOpcode::MetaEntrypoint { entrypoint: 0 }
    ));
    assert!(matches!(opcodes[3], RealLiveOpcode::MetaLine { line: 4 }));
    assert!(matches!(opcodes[4], RealLiveOpcode::MetaLine { line: 5 }));
}

#[test]
fn truncated_meta_header_is_typed_error_not_panic() {
    let bytes = &[opener::META_LINE, 0x02]; // truncated line marker
    let err = parse_real_bytecode(bytes).expect_err("must reject truncated header");
    assert!(matches!(
        err,
        RealLiveParseError::TruncatedMetaHeader { opener: 0x0A, .. }
    ));
}

#[test]
fn non_structural_lead_byte_decodes_as_textout_not_unknown() {
    // `0x55` is not a structural opener, so it begins a Textout run
    // (the catch-all per rlvm `BytecodeElement::Read`) that ends at
    // the following MetaLine opener. No byte is dropped or marked
    // Unknown — every byte partitions into a typed element.
    let bytes = &[0x55, opener::META_LINE, 0x07, 0x00];
    let opcodes = parse_real_bytecode(bytes).expect("non-structural lead tolerated");
    assert_eq!(opcodes.len(), 2);
    match &opcodes[0] {
        RealLiveOpcode::Textout { raw_bytes, .. } => assert_eq!(raw_bytes, &vec![0x55]),
        other => panic!("expected Textout, got {other:?}"),
    }
    assert!(opcodes.iter().all(RealLiveOpcode::is_recognized));
    assert!(matches!(opcodes[1], RealLiveOpcode::MetaLine { line: 7 }));
}

#[test]
fn unrecognized_signature_names_uncatalogued_command_tuple() {
    // 8-byte CommandElement header + MetaLine terminator. module_type 1
    // (in-space) with an UNCATALOGUED (module_id 99, opcode 999) → the
    // generic `Command` blob that fails `is_recognized`.
    let bytes = &[
        opener::COMMAND,
        1,
        99,
        0xE7,
        0x03, // opcode 999 (0x03E7) little-endian
        0,
        0, // argc = 0
        0, // overload
        opener::META_LINE,
        0x05,
        0x00,
    ];
    let opcodes = parse_real_bytecode(bytes).expect("decode must succeed");
    assert!(matches!(
        opcodes[0],
        RealLiveOpcode::Command {
            module_type: 1,
            module_id: 99,
            opcode: 999,
            ..
        }
    ));
    assert!(!opcodes[0].is_recognized());
    assert_eq!(opcodes[0].unrecognized_signature(), Some((1, 99, 999)));

    let histogram = unrecognized_opcode_histogram(&opcodes);
    assert_eq!(histogram.get(&(1, 99, 999)), Some(&1));
    assert_eq!(histogram.len(), 1);
}

#[test]
fn unrecognized_signature_is_empty_for_fully_recognized_stream() {
    // module_type 1, module_id 4 (sys), opcode 17 → `End` (catalogued),
    // then a MetaLine. Every element is a recognised family, so the
    // un-recognised histogram is empty (the 100%-decode property).
    let bytes = &[
        opener::COMMAND,
        1,
        4,
        17,
        0,
        0,
        0,
        0,
        opener::META_LINE,
        0x05,
        0x00,
    ];
    let opcodes = parse_real_bytecode(bytes).expect("decode must succeed");
    assert!(opcodes.iter().all(RealLiveOpcode::is_recognized));
    assert!(
        opcodes
            .iter()
            .all(|op| op.unrecognized_signature().is_none())
    );
    assert!(unrecognized_opcode_histogram(&opcodes).is_empty());
}

#[test]
fn command_header_truncation_is_typed_error() {
    let bytes = &[opener::COMMAND, 1, 5]; // only 3 of 8 header bytes
    let err = parse_real_bytecode(bytes).expect_err("must reject truncated command");
    assert!(matches!(
        err,
        RealLiveParseError::TruncatedCommandHeader { .. }
    ));
}

#[test]
fn command_with_recognized_module_classifies_to_named_variant() {
    // Construct a module_msg TextDisplay-shaped command: header
    // (0x23, 1, 3=MSG, 5=opcode_u16_le_lo, 0=opcode_u16_le_hi, 0=argc,
    // 0=overload, 0=reserved) with no argument list. Opcode 5 is in the
    // catalogued message allow-list.
    let bytes = &[opener::COMMAND, 1, module_id::MSG, 5, 0, 0, 0, 0];
    let opcodes = parse_real_bytecode(bytes).expect("must decode");
    assert_eq!(opcodes.len(), 1);
    // MSG opcode 3 is CharacterTextDisplay; this catalogued text opcode
    // classifies as TextDisplay.
    assert!(matches!(opcodes[0], RealLiveOpcode::TextDisplay { .. }));
}

#[test]
fn pcm_wav_loop_is_catalogued_as_recognized_audio() {
    // `module_pcm` is `(module_type=1, module_id=21)`; its opcode 2
    // is `wavLoop`. The semantic catalogue must admit the tuple so the
    // already-typed audio family does not fall back to generic Command.
    let bytes = &[opener::COMMAND, 1, 21, 2, 0, 0, 0, 0];
    let opcodes = parse_real_bytecode(bytes).expect("must decode");
    assert_eq!(opcodes.len(), 1);
    assert!(matches!(
        opcodes[0],
        RealLiveOpcode::Audio {
            module_id: 21,
            opcode: 2
        }
    ));
    assert!(opcodes[0].is_recognized());
}

#[test]
fn out_of_space_module_type_preserved_as_unknown_with_command_opener() {
    // `Unknown` is now reserved for the desync tripwire: a command
    // header whose module_type is outside RealLive's documented
    // `{0, 1, 2}` space. Such a header (module_type=14) is preserved
    // verbatim for audit rather than coalesced into a generic Command.
    let bytes = &[opener::COMMAND, 14, 99, 0xFF, 0xFF, 0, 0, 0];
    let opcodes = parse_real_bytecode(bytes).expect("must decode");
    assert_eq!(opcodes.len(), 1);
    match &opcodes[0] {
        RealLiveOpcode::Unknown { opcode, raw_bytes } => {
            assert_eq!(*opcode, opener::COMMAND);
            assert!(raw_bytes.starts_with(&[opener::COMMAND, 14, 99]));
        }
        other => panic!("expected Unknown, got {other:?}"),
    }
}

#[test]
fn in_space_uncatalogued_module_is_generic_command_and_fails_recognition() {
    // An in-space (module_type <= 2) command at a module_id no semantic
    // family covers (99) decodes to the generic typed Command — NOT
    // `Unknown` (it is structurally framed), but it is NOT recognised:
    // an un-catalogued tuple must fail the semantic-zero gate rather
    // than masquerade as decoded. (Every module_id present on the real
    // Sweetie HD / Kanon corpora lands in a named family, so this never
    // fires there.)
    let bytes = &[opener::COMMAND, 1, 99, 0xFF, 0xFF, 0, 0, 0];
    let opcodes = parse_real_bytecode(bytes).expect("must decode");
    assert_eq!(opcodes.len(), 1);
    assert!(matches!(
        opcodes[0],
        RealLiveOpcode::Command {
            module_type: 1,
            module_id: 99,
            opcode: 0xFFFF,
            ..
        }
    ));
    assert!(
        !opcodes[0].is_recognized(),
        "an un-catalogued in-space tuple must FAIL recognition"
    );
}

#[test]
fn unknown_opcode_inside_known_module_is_generic_command_and_fails_recognition() {
    // RealLive command opcodes are u16; 0xffff is the synthetic stand-in
    // property is that a plausible module id no longer buckets every
    // opcode to SystemControl.
    let bytes = &[opener::COMMAND, 1, module_id::SYS2, 0xFF, 0xFF, 0, 0, 0];
    let opcodes = parse_real_bytecode(bytes).expect("must decode");
    assert_eq!(opcodes.len(), 1);
    assert!(matches!(
        opcodes[0],
        RealLiveOpcode::Command {
            module_type: 1,
            module_id: module_id::SYS2,
            opcode: 0xFFFF,
            ..
        }
    ));
    assert!(
        !opcodes[0].is_recognized(),
        "an unknown opcode inside a known module must FAIL recognition"
    );
}

#[test]
fn catalogued_modules_classify_to_named_semantic_families() {
    // Spot-check the new semantic families across the module space so a
    // real-game tuple can never silently fall back to generic Command.
    type Case = (u8, u8, u16, fn(&RealLiveOpcode) -> bool);
    let cases: &[Case] = &[
        // module 2 (Sel) non-select op -> SelectionControl.
        (0, 2, 30, |o| {
            matches!(o, RealLiveOpcode::SelectionControl { opcode: 30 })
        }),
        // module 3 (Msg) window directive (>200) -> MessageControl.
        (0, 3, 201, |o| {
            matches!(o, RealLiveOpcode::MessageControl { opcode: 201 })
        }),
        // module 4 (Sys) control tail -> SystemControl.
        (1, 4, 130, |o| {
            matches!(o, RealLiveOpcode::SystemControl { opcode: 130 })
        }),
        // module 5 (Sys2) -> SystemControl.
        (1, 5, 120, |o| {
            matches!(o, RealLiveOpcode::SystemControl { opcode: 120 })
        }),
        // module 10 (variable/flag) -> VariableOp.
        (1, 10, 100, |o| {
            matches!(o, RealLiveOpcode::VariableOp { opcode: 100 })
        }),
        // module 20/21/22 (audio channels) -> Audio.
        (1, 20, 0, |o| {
            matches!(
                o,
                RealLiveOpcode::Audio {
                    module_id: 20,
                    opcode: 0
                }
            )
        }),
        // module 30/60/62 (screen / animation / effect layer) -> ScreenControl.
        (1, 62, 10, |o| {
            matches!(
                o,
                RealLiveOpcode::ScreenControl {
                    module_id: 62,
                    opcode: 10
                }
            )
        }),
        // module 72/81/82 (display object planes) -> GraphicsObject.
        (1, 82, 1000, |o| {
            matches!(
                o,
                RealLiveOpcode::GraphicsObject {
                    module_id: 82,
                    opcode: 1000
                }
            )
        }),
        // module_type 2 range form of an object module -> GraphicsObject.
        (2, 81, 1064, |o| {
            matches!(
                o,
                RealLiveOpcode::GraphicsObject {
                    module_id: 81,
                    opcode: 1064
                }
            )
        }),
    ];
    for &(mt, mid, op, pred) in cases {
        let bytes = &[
            opener::COMMAND,
            mt,
            mid,
            (op & 0xFF) as u8,
            (op >> 8) as u8,
            0,
            0,
            0,
        ];
        let opcodes = parse_real_bytecode(bytes).expect("must decode");
        assert_eq!(opcodes.len(), 1, "{mt}:{mid}:{op}");
        assert!(
            pred(&opcodes[0]),
            "{mt}:{mid}:{op} did not classify to its semantic family: {:?}",
            opcodes[0]
        );
        assert!(
            opcodes[0].is_recognized(),
            "{mt}:{mid}:{op} semantic family must be recognised"
        );
    }
}

#[test]
fn comma_opener_is_recognized() {
    let bytes = &[opener::META_COMMA, opener::COMMA];
    let opcodes = parse_real_bytecode(bytes).expect("must decode");
    assert_eq!(opcodes.len(), 2);
    assert!(matches!(opcodes[0], RealLiveOpcode::Comma));
    assert!(matches!(opcodes[1], RealLiveOpcode::Comma));
}

#[test]
fn shift_jis_textout_run_is_recognized_and_byte_equal() {
    // Shift-JIS string for "ハ" (0x83 0x6E) followed by MetaLine.
    // The Textout run extends across one SJIS double-byte.
    let bytes = &[0x83, 0x6E, opener::META_LINE, 0x05, 0x00];
    let opcodes = parse_real_bytecode(bytes).expect("must decode");
    assert_eq!(opcodes.len(), 2);
    match &opcodes[0] {
        RealLiveOpcode::Textout { raw_bytes, .. } => {
            assert_eq!(raw_bytes, &vec![0x83, 0x6E]);
        }
        other => panic!("expected Textout, got {other:?}"),
    }
    assert!(matches!(opcodes[1], RealLiveOpcode::MetaLine { line: 5 }));
}

#[test]
fn command_arglist_int_literal_payload_with_delimiter_bytes_does_not_misterminate() {
    // Bug: the arglist scanner split on raw 0x28 '(' / 0x29 ')' /
    // 0x2C ',' without honoring the 0xFF int-literal introducer.
    // Here a single argument is a 0xFF int literal whose 4 LE payload
    // bytes are exactly [0x29 ')', 0x2C ',', 0x28 '(', 0x00] — every
    // delimiter value. The literal must be consumed whole so the
    // arglist closes at the REAL trailing ')', and the following
    // MetaLine decodes aligned with zero unknown opcodes.
    // module_sys (id=4) opcode 100 == Wait, argc=1; first_arg_as_i32
    // decodes the int literal, so asserting duration_ms proves all 4
    // payload bytes (incl. the delimiter-valued ones) landed in the
    // argument rather than splitting it.
    let bytes = &[
        opener::COMMAND,
        1,
        module_id::SYS,
        100,
        0, // opcode_u16 = 100 (Wait)
        1, // argc
        0, // overload
        0, // reserved
        b'(',
        0xFF,
        0x29,
        0x2C,
        0x28,
        0x00, // i32 LE literal = 0x00282C29
        b')',
        opener::META_LINE,
        0x07,
        0x00,
    ];
    let opcodes = parse_real_bytecode(bytes).expect("must decode");
    assert!(
        opcodes.iter().all(RealLiveOpcode::is_recognized),
        "no element may misalign into Unknown: {opcodes:?}"
    );
    assert_eq!(
        opcodes.len(),
        2,
        "arglist must close at the real ')': {opcodes:?}"
    );
    // The full i32 literal 0x00282C29 is surfaced verbatim (no u16
    // truncation) — proves the full 5-byte literal (incl.
    // 0x29/0x2C/0x28) was captured as one arg.
    assert!(
        matches!(
            opcodes[0],
            RealLiveOpcode::Wait {
                duration_ms: 0x0028_2C29
            }
        ),
        "expected Wait with full-range literal-derived duration, got {:?}",
        opcodes[0]
    );
    assert!(
        matches!(opcodes[1], RealLiveOpcode::MetaLine { line: 7 }),
        "stream must stay aligned after the arglist: {:?}",
        opcodes[1]
    );
}

#[test]
fn wait_and_id_operands_preserve_full_magnitude_and_sign_no_unsigned_abs() {
    // 007 regression: operand literals were narrowed via
    // `unsigned_abs as u16/u32`, silently truncating any value above
    // u16::MAX and flipping the sign of negative literals. The decoded
    // surface must now carry the literal's real range.

    // Wait with a 100000 ms duration (> u16::MAX = 65535). Old code
    // truncated to (100000 & 0xFFFF) = 34464; the i32 surface keeps it.
    let mut wait = vec![opener::COMMAND, 1, module_id::SYS, 100, 0, 1, 0, 0];
    wait.extend_from_slice(&[b'(', EXPR_INT_LITERAL]);
    wait.extend_from_slice(&100_000i32.to_le_bytes());
    wait.push(b')');
    let opcodes = parse_real_bytecode(&wait).expect("wait decodes");
    assert!(
        matches!(
            opcodes[0],
            RealLiveOpcode::Wait {
                duration_ms: 100_000
            }
        ),
        "duration must survive above u16::MAX, got {:?}",
        opcodes[0]
    );

    // Background (module_grp) sprite id carrying a negative literal
    // -5 (= 0xFFFF_FFFB). Old code's unsigned_abs flipped it to 5; the
    // bit-reinterpreting `as u32` preserves the literal's bit pattern.
    let mut bg = vec![opener::COMMAND, 1, module_id::GRP, 0x49, 0, 1, 0, 0];
    bg.extend_from_slice(&[b'(', EXPR_INT_LITERAL]);
    bg.extend_from_slice(&(-5i32).to_le_bytes());
    bg.push(b')');
    let opcodes = parse_real_bytecode(&bg).expect("background decodes");
    assert!(
        matches!(
            opcodes[0],
            RealLiveOpcode::Background {
                sprite_id: 0xFFFF_FFFB
            }
        ),
        "negative id literal must keep its bit pattern (no unsigned_abs flip), got {:?}",
        opcodes[0]
    );
}

#[test]
fn expression_immediately_followed_by_textout_decodes_as_two_elements() {
    // An Expression element whose value is a `$ 0xFF` int literal
    // (`0x24 0xFF` + i32) carries a payload byte `0x83` with a
    // Shift-JIS lead VALUE. The literal must be consumed whole (its
    // payload is not mistaken for a Textout start), and the
    // expression must terminate at its true 6-byte boundary so the
    // REAL Textout that follows surfaces as its own translatable
    // unit instead of being buried in `Expression.raw_bytes`.
    let bytes = &[
        opener::EXPRESSION,
        0xFF,
        0x83,
        0x6E,
        0x01,
        0x00, // $ 0xFF int literal = 0x00016E83; 0x83 has an SJIS-lead value
        0x83,
        0x6E, // Textout "ハ" — the translatable dialogue
        opener::META_LINE,
        0x05,
        0x00,
    ];
    let opcodes = parse_real_bytecode(bytes).expect("must decode");
    assert_eq!(
        opcodes.len(),
        3,
        "Expression + Textout + MetaLine must be THREE elements: {opcodes:?}"
    );
    match &opcodes[0] {
        RealLiveOpcode::Expression { raw_bytes } => {
            // Body is the 5 bytes after the `0x24` opener — the whole
            // int literal, nothing more.
            assert_eq!(
                raw_bytes,
                &vec![0xFF, 0x83, 0x6E, 0x01, 0x00],
                "Expression must not swallow the following Textout"
            );
        }
        other => panic!("expected Expression, got {other:?}"),
    }
    match &opcodes[1] {
        RealLiveOpcode::Textout { raw_bytes, .. } => {
            // The dialogue text is recovered as its own unit.
            assert_eq!(raw_bytes, &vec![0x83, 0x6E]);
        }
        other => panic!("expected Textout (recovered dialogue), got {other:?}"),
    }
    assert!(matches!(opcodes[2], RealLiveOpcode::MetaLine { line: 5 }));
}

#[test]
fn parses_assignment_expression_into_typed_tree() {
    // `$06[401] = 1` — the pervasive Sweetie HD scene-1 idiom:
    // memory-ref LHS, `\0x1e` assignment op, `$ 0xFF` int-literal
    // RHS. The evaluator must consume exactly 18 bytes and produce a
    // typed Binary(MemoryRef, IntLiteral) tree.
    let body = [
        0x24, 0x06, 0x5B, 0x24, 0xFF, 0x91, 0x01, 0x00, 0x00, 0x5D, 0x5C, 0x1E, 0x24, 0xFF, 0x01,
        0x00, 0x00, 0x00,
    ];
    let (expr, len) = parse_expression(&body, 0).expect("assignment must parse");
    assert_eq!(len, 18, "must consume the whole expression");
    match expr {
        Expr::Binary { op, lhs, rhs } => {
            assert_eq!(op, 0x1E, "assignment operator");
            assert!(matches!(
                *lhs,
                Expr::MemoryRef { bank: 0x06, ref index }
                    if matches!(**index, Expr::IntLiteral { value: 401 })
            ));
            assert!(matches!(*rhs, Expr::IntLiteral { value: 1 }));
        }
        other => panic!("expected Binary assignment, got {other:?}"),
    }
}

#[test]
fn goto_if_consumes_trailing_jump_pointer() {
    // module_jmp goto_if (modtype=0, module=1, opcode=2) carries a
    // `(cond)` arg list followed by a 4-byte i32 jump target. The
    // decoder must consume header + arglist + pointer so the stream
    // stays aligned (the trailing pointer is not left as Unknown).
    let mut bytes = vec![
        opener::COMMAND,
        0,
        1,
        2,
        0, // opcode_u16 = 2 (goto_if)
        0,
        0,
        0, // argc=0, overload=0
    ];
    // arg list: `($ 0xFF 0)`
    bytes.extend_from_slice(&[b'(', 0x24, 0xFF, 0x00, 0x00, 0x00, 0x00, b')']);
    // trailing i32 jump target = 0x0461
    bytes.extend_from_slice(&[0x61, 0x04, 0x00, 0x00]);
    // a following MetaLine to prove alignment
    bytes.extend_from_slice(&[opener::META_LINE, 0x07, 0x00]);
    let opcodes = parse_real_bytecode(&bytes).expect("must decode");
    assert!(
        opcodes.iter().all(RealLiveOpcode::is_recognized),
        "no element may misalign into Unknown: {opcodes:?}"
    );
    assert_eq!(opcodes.len(), 2, "goto_if + MetaLine: {opcodes:?}");
    assert!(matches!(opcodes[0], RealLiveOpcode::Branch));
    assert!(matches!(opcodes[1], RealLiveOpcode::MetaLine { line: 7 }));
}

#[test]
fn plain_goto_consumes_twelve_bytes_with_pointer() {
    // module_jmp goto (modtype=0, module=1, opcode=0): 8-byte header
    // + 4-byte i32 target, no arg list (rlvm GotoElement == 12 bytes).
    let mut bytes = vec![opener::COMMAND, 0, 1, 0, 0, 0, 0, 0];
    bytes.extend_from_slice(&[0x0F, 0x06, 0x00, 0x00]); // i32 target
    bytes.extend_from_slice(&[opener::META_LINE, 0x86, 0x00]);
    let opcodes = parse_real_bytecode(&bytes).expect("must decode");
    assert_eq!(opcodes.len(), 2, "goto + MetaLine: {opcodes:?}");
    assert!(matches!(opcodes[0], RealLiveOpcode::Goto));
    assert!(matches!(
        opcodes[1],
        RealLiveOpcode::MetaLine { line: 0x86 }
    ));
}

#[test]
fn command_string_argument_is_consumed_as_operand() {
    // module_grp open command with a bare string filename followed by
    // an int param: `(_WHITE $ 0xFF 50)`. The string operand must
    // be consumed (stopping at the `$`), and the int param decoded.
    let mut bytes = vec![opener::COMMAND, 1, module_id::GRP, 0x49, 0, 2, 0, 0];
    bytes.push(b'(');
    bytes.extend_from_slice(b"_WHITE");
    bytes.extend_from_slice(&[0x24, 0xFF, 0x32, 0x00, 0x00, 0x00]); // $ 0xFF 50
    bytes.push(b')');
    bytes.extend_from_slice(&[opener::META_LINE, 0x01, 0x00]);
    let opcodes = parse_real_bytecode(&bytes).expect("must decode");
    assert!(opcodes.iter().all(RealLiveOpcode::is_recognized));
    assert_eq!(opcodes.len(), 2, "background + MetaLine: {opcodes:?}");
    assert!(matches!(opcodes[0], RealLiveOpcode::Background { .. }));
    assert!(matches!(opcodes[1], RealLiveOpcode::MetaLine { line: 1 }));
}

#[test]
fn is_recognized_helpers_match_documented_opener_table() {
    for byte in [
        opener::META_COMMA,
        opener::META_LINE,
        opener::META_ENTRYPOINT,
        opener::COMMAND,
        opener::EXPRESSION,
        opener::COMMA,
        opener::META_KIDOKU,
    ] {
        assert!(is_recognized_opener(byte), "byte {byte:#04x}");
    }
    assert!(is_shift_jis_textout_lead(0x81));
    assert!(is_shift_jis_textout_lead(0xE0));
    assert!(!is_recognized_opener(0x55));
}

#[test]
fn parse_arg_list_trailing_comma_drops_final_empty_slot() {
    fn arg_bytes(args: &[CommandArg]) -> Vec<Vec<u8>> {
        args.iter().map(|a| a.bytes.clone()).collect()
    }
    // `` -> zero slots.
    assert_eq!(
        arg_bytes(
            &parse_arg_list(&[EXPR_PAREN_OPEN, EXPR_PAREN_CLOSE], 0)
                .unwrap()
                .0
        ),
        Vec::<Vec<u8>>::new()
    );
    // `(,)` -> one empty interior slot from the comma; the trailing
    // comma before `)` does NOT add a final empty slot.
    assert_eq!(
        arg_bytes(
            &parse_arg_list(&[EXPR_PAREN_OPEN, opener::COMMA, EXPR_PAREN_CLOSE], 0)
                .unwrap()
                .0
        ),
        vec![Vec::<u8>::new()]
    );
    // `(,,)` -> two empty slots (one per comma); still no extra
    // trailing slot.
    assert_eq!(
        arg_bytes(
            &parse_arg_list(
                &[
                    EXPR_PAREN_OPEN,
                    opener::COMMA,
                    opener::COMMA,
                    EXPR_PAREN_CLOSE
                ],
                0
            )
            .unwrap()
            .0
        ),
        vec![Vec::<u8>::new(), Vec::<u8>::new()]
    );
}

#[test]
fn parse_arg_list_stamps_scene_relative_offset_per_option() {
    // `("あ", "い")` starting at byte 0: option 0 begins right after
    // the `(` at offset 1; option 1 begins after the comma at offset 4.
    let bytes = [
        EXPR_PAREN_OPEN, // 0: (
        0x82,
        0xA0,          // 1..3: "あ"
        opener::COMMA, // 3: ,
        0x82,
        0xA2,             // 4..6: "い"
        EXPR_PAREN_CLOSE, // 6: )
    ];
    let (args, consumed) = parse_arg_list(&bytes, 0).unwrap();
    assert_eq!(consumed, bytes.len());
    assert_eq!(args.len(), 2);
    assert_eq!(args[0].byte_offset, 1);
    assert_eq!(args[0].bytes, vec![0x82, 0xA0]);
    assert_eq!(args[1].byte_offset, 4);
    assert_eq!(args[1].bytes, vec![0x82, 0xA2]);
}

#[test]
fn catalogued_msg_control_opcode_decodes_to_message_control() {
    // A catalogued module_msg opcode outside the text-display range is a
    // non-dialogue text-window directive — it classifies to the semantic
    // `MessageControl` family, never the generic blob.
    assert_eq!(
        classify_command(0, module_id::MSG, 201, 0, &[]),
        Some(RealLiveOpcode::MessageControl { opcode: 201 })
    );
}

#[test]
fn object_plane_module_decodes_to_graphics_object_family() {
    // An object-plane module (id 82, ObjBg) decodes to the semantic
    // `GraphicsObject` family carrying its plane id + opcode — the
    // composited object Utsushi must render, never a generic blob.
    assert_eq!(
        classify_command(1, 82, 1004, 3, &[]),
        Some(RealLiveOpcode::GraphicsObject {
            module_id: 82,
            opcode: 1004,
        })
    );
}

#[test]
fn out_of_space_module_type_is_unknown_desync_tripwire() {
    // module_type > 2 is outside RealLive's documented space; it is the
    // desync tripwire and must NOT be coalesced into a generic Command.
    assert_eq!(classify_command(14, 3, 23243, 0, &[]), None);
}

#[test]
fn truncated_goto_on_reports_full_u16_argc() {
    // goto_on command (module_id JMP, opcode 3) declaring argc=300 with
    // no trailing jump-target bytes must surface the full u16 argc, not
    // 300 truncated to u8 (300 & 0xFF == 44).
    let argc: u16 = 300;
    let bytes = [
        opener::COMMAND,
        0,              // module_type
        module_id::JMP, // module_id
        3,              // opcode_lo (goto_on)
        0,              // opcode_hi
        (argc & 0xFF) as u8,
        (argc >> 8) as u8,
        0, // overload
    ];
    let err =
        decode_command(&bytes, 0, &mut Vec::new()).expect_err("missing jump targets must error");
    assert!(
        matches!(
            err,
            RealLiveParseError::TruncatedCommandArgs { argc: 300, .. }
        ),
        "expected argc=300, got {err:?}"
    );
}

// The byte sequences below are SYNTHETIC: they reproduce the structural
// forms the Kanon + Sweetie HD full-archive recon exposed (integer/string
// bank references, store register, array index, complex / special params,
// bracket-leading quoted strings) WITHOUT embedding any copyrighted game
// text — every string operand here is an ASCII placeholder.

#[test]
fn integer_bank_reference_dollar_prefixed_with_array_index() {
    // `$ 0x02 [ 0x000C ]` — an `intC[12]` bank reference (the `0x42 'B'` /
    // `0x43 'C'` recon class is the *bareword* form; the canonical numeric
    // bank reference rlvm emits is `$ <bank> [ <index> ]`).
    let bytes = [
        EXPR_DOLLAR,
        0x02, // bank selector
        EXPR_INDEX_OPEN,
        EXPR_INT_LITERAL,
        0x0C,
        0x00,
        0x00,
        0x00,
        EXPR_INDEX_CLOSE,
    ];
    let (expr, len) = parse_expression(&bytes, 0).expect("memory ref must parse");
    assert_eq!(len, bytes.len());
    assert!(matches!(
        expr,
        Expr::MemoryRef { bank: 0x02, ref index }
            if matches!(**index, Expr::IntLiteral { value: 12 })
    ));
}

#[test]
fn dollar_prefixed_store_register_is_two_bytes() {
    // `$ 0xC8` — the `$`-typed store-register RHS idiom (`intX[i] = store`).
    // Must consume exactly 2 bytes and NOT be misread as `$ <bank=0xC8> [`.
    let (expr, len) =
        parse_expression(&[EXPR_DOLLAR, EXPR_STORE_REGISTER, 0x0A], 0).expect("$store must parse");
    assert_eq!(len, 2, "$ + 0xC8 store register is two bytes");
    assert!(matches!(expr, Expr::StoreRegister));
}

#[test]
fn bracket_leading_quoted_string_arg_is_not_misread_as_bank_reference() {
    // `("[X]")` — a quoted string whose first content byte is `[`. The
    // old "any byte followed by `[`" heuristic misread the opening `"` as
    // a memory-bank reference and failed on the next byte (the Sweetie HD
    // `0x83` / Kanon `0x53` recon class). A real bank reference is always
    // `$`-prefixed, so the quoted string is consumed whole.
    let bytes = [
        EXPR_PAREN_OPEN,
        b'"',
        b'[',
        b'X',
        b']',
        b'"',
        EXPR_PAREN_CLOSE,
    ];
    let (args, consumed) = parse_arg_list(&bytes, 0).expect("quoted `[`-string must parse");
    assert_eq!(consumed, bytes.len());
    assert_eq!(args.len(), 1);
    assert_eq!(args[0].bytes, b"\"[X]\"".to_vec());
}

#[test]
fn bareword_string_then_int_then_special_param_in_arg_list() {
    // `("BG" $0 0x61 0x01 ("FG" $0))` — the Kanon `0x42 'B'` recon
    // class: a bareword asset-id string, an int literal, and a special
    // parameter (tag 0x01) wrapping a complex group with its own bareword.
    // Every byte must partition with zero residual.
    let bytes = [
        EXPR_PAREN_OPEN, // (
        b'B',
        b'G', // bareword "BG"
        EXPR_DOLLAR,
        EXPR_INT_LITERAL,
        0,
        0,
        0,
        0, // $0
        EXPR_SPECIAL,
        0x01,            // special param, tag 0x01
        EXPR_PAREN_OPEN, // (  complex
        b'F',
        b'G', // bareword "FG"
        EXPR_DOLLAR,
        EXPR_INT_LITERAL,
        0,
        0,
        0,
        0,                // $0
        EXPR_PAREN_CLOSE, // )  complex
        EXPR_PAREN_CLOSE, // )
    ];
    let (args, consumed) = parse_arg_list(&bytes, 0).expect("special-param arg must parse");
    assert_eq!(consumed, bytes.len(), "whole arg list consumed");
    // One un-split slot (no top-level comma): bareword + int + special.
    assert_eq!(args.len(), 1);
    assert_eq!(args[0].bytes, bytes[1..bytes.len() - 1].to_vec());
}

#[test]
fn special_param_with_memory_ref_content_no_complex_wrapper() {
    // `0x61 0x00 $0x06[7]` — a special parameter (tag 0x00) whose content
    // is a `$`-memory reference directly (no `` wrapper). The Sweetie HD
    // `objBgMulti`-class `0x61 0x00 $…` form: it must be recognised as a
    // special parameter, not a bare string ending at the `0x00` delimiter.
    let bytes = [
        EXPR_SPECIAL,
        0x00, // tag
        EXPR_DOLLAR,
        0x06,
        EXPR_INDEX_OPEN,
        EXPR_INT_LITERAL,
        0x07,
        0x00,
        0x00,
        0x00,
        EXPR_INDEX_CLOSE,
    ];
    let (expr, len) = parse_data(&bytes, 0).expect("special-with-memref must parse");
    assert_eq!(len, bytes.len());
    match expr {
        Expr::SpecialParam { tag: 0, content } => {
            assert!(matches!(
                *content,
                Expr::MemoryRef { bank: 0x06, ref index }
                    if matches!(**index, Expr::IntLiteral { value: 7 })
            ));
        }
        other => panic!("expected SpecialParam{{tag:0}}, got {other:?}"),
    }
}

#[test]
fn leading_0x61_string_is_not_misread_as_special_param() {
    // A bare string that merely begins with `0x61` (`'a'`) — e.g. a
    // `select` option "ab" — is NOT a special parameter: the byte after
    // the would-be tag is a string byte / delimiter, never a complex /
    // expression lead. The synthetic Choice pin depends on this.
    assert!(!is_special_param_lead(&[EXPR_SPECIAL, b'b', b','], 0));
    assert!(is_special_param_lead(
        &[EXPR_SPECIAL, 0x01, EXPR_PAREN_OPEN],
        0
    ));
}

#[test]
fn complex_param_is_a_sequence_of_data_items_not_a_single_expression() {
    // `($0 $0 $1 $0x02[0])` — a complex parameter is a back-to-back
    // sequence of data items (rlvm `ComplexExpressionPiece`), NOT a single
    // operator-chained expression. The old parenthesised-expression path
    // stopped at the second item and failed on the `$` (the Kanon `0x24`
    // recon class).
    let bytes = [
        EXPR_PAREN_OPEN,
        EXPR_DOLLAR,
        EXPR_INT_LITERAL,
        0,
        0,
        0,
        0, // $0
        EXPR_DOLLAR,
        EXPR_INT_LITERAL,
        0,
        0,
        0,
        0, // $0
        EXPR_DOLLAR,
        EXPR_INT_LITERAL,
        1,
        0,
        0,
        0, // $1
        EXPR_DOLLAR,
        0x02,
        EXPR_INDEX_OPEN,
        EXPR_INT_LITERAL,
        0,
        0,
        0,
        0,
        EXPR_INDEX_CLOSE, // $intC[0]
        EXPR_PAREN_CLOSE,
    ];
    let (expr, len) = parse_data(&bytes, 0).expect("complex param must parse");
    assert_eq!(len, bytes.len());
    match expr {
        Expr::Complex { items } => assert_eq!(items.len(), 4, "four data items"),
        other => panic!("expected Complex, got {other:?}"),
    }
}

#[test]
fn bare_token_without_dollar_prefix_is_malformed_not_a_bank_reference() {
    // A bank reference is ONLY `$`-prefixed. A bare `0x02 [ … ]` (no `$`)
    // is not a valid arithmetic token — the evaluator must surface a typed
    // MalformedExpression rather than silently inventing a reference.
    let err = parse_token(&[0x02, EXPR_INDEX_OPEN, EXPR_INT_LITERAL, 0, 0, 0, 0], 0)
        .expect_err("bare bank byte must be malformed");
    assert!(matches!(
        err,
        RealLiveParseError::MalformedExpression { byte: 0x02, .. }
    ));
}
