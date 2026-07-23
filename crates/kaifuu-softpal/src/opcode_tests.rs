use super::*;

/// Emit one operator token `(opcode id, 0x0001)`.
fn op(id: u16) -> [u8; 4] {
    let mut t = [0u8; 4];
    t[0..2].copy_from_slice(&id.to_le_bytes());
    t[2..4].copy_from_slice(&SV_OPERATOR_TAG.to_le_bytes());
    t
}
/// Emit one raw operand token.
fn val(v: u32) -> [u8; 4] {
    v.to_le_bytes()
}
/// A `Call` first-operand raw value from `(category, function)`.
fn target(category: u16, function: u16) -> u32 {
    (u32::from(category) << 16) | u32::from(function)
}

fn program(tokens: &[[u8; 4]]) -> Vec<u8> {
    let mut s = Vec::new();
    s.extend_from_slice(SCRIPT_MAGIC_PREFIX);
    s.extend_from_slice(b"20");
    s.extend_from_slice(&0x59fa_e876u32.to_le_bytes()); // field1
    s.extend_from_slice(&668u32.to_le_bytes()); // field2
    for t in tokens {
        s.extend_from_slice(t);
    }
    s
}

#[test]
fn header_parses_and_rejects_bad_input() {
    let s = program(&[]);
    let h = SvProgramHeader::parse(&s).unwrap();
    assert_eq!(h.version, *b"20");
    assert_eq!(h.field1, 0x59fa_e876);
    assert_eq!(h.field2, 668);

    assert!(matches!(
        SvProgramHeader::parse(b"XX20\0\0\0\0\0\0\0\0"),
        Err(OpcodeError::BadMagic { .. })
    ));
    assert!(matches!(
        SvProgramHeader::parse(b"Sv2"),
        Err(OpcodeError::TruncatedHeader { observed_len: 3 })
    ));
    // Error strings carry the namespace marker.
    assert!(
        OpcodeError::TruncatedHeader { observed_len: 0 }
            .to_string()
            .starts_with(SOFTPAL_OPCODE_ERROR_MARKER)
    );
}

#[test]
fn opcode_table_covers_full_range_with_known_arities() {
    // Every id in 0x01..=0x21 is known; ids above are Unknown (arity None).
    for id in 0x01..=SV_MAX_OPCODE {
        let o = SvOpcode::from_id(id);
        assert!(o.is_known(), "id {id:#x} must be known");
        assert_eq!(o.id(), id);
        let a = o.arity().expect("known arity");
        assert!(a <= 2, "arity {a} in range");
    }
    assert_eq!(SvOpcode::from_id(0x17), SvOpcode::Call);
    assert!(SvOpcode::Call.is_call());
    // id 0x00 is unobserved: not in the known table (arity unproven).
    assert_eq!(SvOpcode::from_id(0x00), SvOpcode::Unknown(0x00));
    assert!(!SvOpcode::from_id(0x00).is_known());
    assert_eq!(SvOpcode::from_id(0x00).arity(), None);
    let u = SvOpcode::from_id(0x09a0);
    assert_eq!(u, SvOpcode::Unknown(0x09a0));
    assert!(!u.is_known());
    assert_eq!(u.arity(), None);
    assert_eq!(u.id(), 0x09a0);
}

#[test]
fn walks_each_command_family_exhaustively() {
    // A nullary control op, a Move with a var-ref + typed-nil,
    // a TEXT-SHOW call, a SELECT call, and another engine Call.
    let tokens = [
        op(0x18),         // Control (arity 0)
        op(0x01),         // Move
        val(0x8000_0002), // var-ref operand
        val(0x4000_0000), // typed-nil operand
        op(0x17),         // Call -> TEXT-SHOW
        val(target(CALL_CATEGORY_TEXT, 0x0002)),
        val(0x0000_1234), // text pointer operand (plain)
        op(0x17),         // Call -> SELECT
        val(target(CALL_CATEGORY_SELECT, SELECT_FUNCTION)),
        val(0x4000_0000),            // system immediate
        op(0x17),                    // Call -> other engine built-in
        val(target(0x0011, 0x0008)), // graphics/system dispatch
        val(0x0000_0005),
    ];
    let s = program(&tokens);
    let scan = OpcodeScan::parse(&s).unwrap();

    assert!(scan.is_exhaustive(), "no unknowns/trailing/truncation");
    assert_eq!(scan.unknown_count(), 0);
    assert_eq!(scan.trailing_bytes, 0);
    assert_eq!(scan.instructions.len(), 5);
    assert_eq!(scan.token_count(), tokens.len());
    // Consumed every token: header + all tokens.
    assert_eq!(
        SV_PROGRAM_HEADER_BYTE_LEN + tokens.len() * SV_TOKEN_BYTE_LEN,
        s.len()
    );

    assert_eq!(scan.text_show_count(), 1);
    assert_eq!(scan.select_count(), 1);
    assert_eq!(scan.call_count(), 3);
    assert_eq!(scan.call_target_count(), 3);

    // Families.
    assert!(matches!(
        scan.instructions[0].family,
        CommandFamily::Control
    ));
    assert!(matches!(scan.instructions[1].family, CommandFamily::Expr));
    assert!(matches!(
        scan.instructions[2].family,
        CommandFamily::TextShow { text_type: 0x0002 }
    ));
    assert!(matches!(scan.instructions[3].family, CommandFamily::Select));
    assert!(matches!(
        scan.instructions[4].family,
        CommandFamily::Call {
            target: CallTarget {
                category: 0x0011,
                function: 0x0008
            }
        }
    ));

    // Operand tags + byte-locatable offsets.
    let expr = &scan.instructions[1];
    assert_eq!(expr.operands().len(), 2);
    assert_eq!(expr.operands()[0].tag(), OperandTag::VAR);
    assert_eq!(expr.operands()[1].tag(), OperandTag::TYPED);
    assert!(expr.operands()[0].field_offset + 4 <= s.len());

    // Histograms.
    let oh = scan.opcode_histogram();
    assert_eq!(oh[&0x17], 3);
    assert_eq!(oh[&0x18], 1);
    assert_eq!(oh[&0x01], 1);
    let cc = scan.call_category_histogram();
    assert_eq!(cc[&CALL_CATEGORY_TEXT], 1);
    assert_eq!(cc[&CALL_CATEGORY_SELECT], 1);
    assert_eq!(cc[&0x0011], 1);
}

#[test]
fn operand_that_looks_like_an_operator_is_consumed_not_misread() {
    // op 0x0b (arity 1) followed by a raw immediate whose high word is the
    // operator tag (0x0001_09A0). A naive scan would mistake it for opcode
    // 0x09A0; the arity-driven walk consumes it as op 0x0b's operand.
    let tokens = [
        op(0x0b),
        val(0x0001_09a0), // immediate that *looks* like operator 0x09a0
        op(0x18),         // real operator after it
    ];
    let s = program(&tokens);
    let scan = OpcodeScan::parse(&s).unwrap();
    assert!(scan.is_exhaustive());
    assert_eq!(scan.instructions.len(), 2);
    assert_eq!(scan.instructions[0].opcode, SvOpcode::from_id(0x0b));
    assert_eq!(scan.instructions[0].operands()[0].raw, 0x0001_09a0);
    assert_eq!(scan.instructions[1].opcode, SvOpcode::from_id(0x18));
    assert_eq!(scan.unknown_count(), 0);
}

#[test]
fn unknown_opcode_is_recorded_not_panicked() {
    // An operator token with an out-of-table opcode id (0x00FF). Recorded as
    // an unknown; the walk resyncs on the grid and types the next operator.
    let mut bad_op = [0u8; 4];
    bad_op[0..2].copy_from_slice(&0x00ffu16.to_le_bytes());
    bad_op[2..4].copy_from_slice(&SV_OPERATOR_TAG.to_le_bytes());
    let tokens = [bad_op, op(0x18)];
    let s = program(&tokens);
    let scan = OpcodeScan::parse(&s).unwrap();
    assert!(!scan.is_exhaustive());
    assert_eq!(scan.unknown_count(), 1);
    assert_eq!(scan.unknowns[0].token_lo, 0x00ff);
    assert_eq!(scan.unknowns[0].token_hi, SV_OPERATOR_TAG);
    // The following real operator is still typed.
    assert_eq!(scan.instructions.len(), 1);
    assert_eq!(scan.instructions[0].opcode, SvOpcode::from_id(0x18));
}

#[test]
fn truncated_final_command_is_recorded_not_panicked() {
    // A Call (arity 2) at EOF with only one operand present.
    let tokens = [op(0x17), val(target(CALL_CATEGORY_TEXT, 0x0002))];
    let s = program(&tokens);
    let scan = OpcodeScan::parse(&s).unwrap();
    assert!(scan.truncated_final);
    assert!(!scan.is_exhaustive());
    // The partial instruction is still recorded with the operands it had.
    assert_eq!(scan.instructions.len(), 1);
    assert_eq!(scan.instructions[0].operands().len(), 1);
}

#[test]
fn desync_token_at_operator_position_is_unknown() {
    // A token at an operator position whose high word is not the operator
    // tag (a raw value where an operator was expected).
    let tokens = [val(0x1234_5678), op(0x18)];
    let s = program(&tokens);
    let scan = OpcodeScan::parse(&s).unwrap();
    assert_eq!(scan.unknown_count(), 1);
    assert_eq!(scan.unknowns[0].token_hi, 0x1234);
    assert_eq!(scan.instructions.len(), 1);
}
