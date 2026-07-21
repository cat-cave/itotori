use super::*;

#[test]
fn scalar_command_parse_absence_is_distinct_from_a_literal_zero() {
    let command_with_arg = |module_id, opcode, arg: &[u8]| {
        let mut bytes = vec![opener::COMMAND, 1, module_id, opcode, 0, 1, 0, 0, b'('];
        bytes.extend_from_slice(arg);
        bytes.push(b')');
        bytes
    };

    // A bare string is a valid Command argument but not an
    // ExpressionPiece scalar, so diagnostic scalar decoding fails while
    // the typed opcode remains intact.
    let malformed = command_with_arg(module_id::SYS, 100, b"not-a-scalar");
    let opcodes = parse_real_bytecode(&malformed).expect("command framing must decode");
    assert!(matches!(
        opcodes[0],
        RealLiveOpcode::Wait { duration_ms: None }
    ));

    let zero = command_with_arg(module_id::SYS, 100, &[EXPR_INT_LITERAL, 0, 0, 0, 0]);
    let opcodes = parse_real_bytecode(&zero).expect("literal-zero command must decode");
    assert!(matches!(
        opcodes[0],
        RealLiveOpcode::Wait {
            duration_ms: Some(0)
        }
    ));

    let malformed = command_with_arg(module_id::GRP, 73, b"not-a-scalar");
    let opcodes = parse_real_bytecode(&malformed).expect("command framing must decode");
    assert!(matches!(
        opcodes[0],
        RealLiveOpcode::Background { sprite_id: None }
    ));

    let malformed = command_with_arg(module_id::KOE, 0, b"not-a-scalar");
    let opcodes = parse_real_bytecode(&malformed).expect("command framing must decode");
    assert!(matches!(
        opcodes[0],
        RealLiveOpcode::VoicePlay { voice_id: None }
    ));
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
    // `$06[401] = 1` — a recurrent scene-1 idiom:
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
