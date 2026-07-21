use super::*;
#[test]
fn empty_input_is_truncated_not_zero_state() {
    match parse_expression(&[]) {
        Err(ExpressionParseError::Truncated { observed_len, .. }) => {
            assert_eq!(observed_len, 0);
        }
        other => panic!("expected Truncated on empty input, got {other:?}"),
    }
}

#[test]
fn deeply_nested_groupings_surface_typed_error_not_stack_overflow() {
    // Regression (audit-3): `parse_term` recursed into `parse_expr`
    // on every `(` with no depth limit, so a hostile expression of
    // deeply nested `(` overflowed the process stack. Past
    // `MAX_EXPRESSION_DEPTH` the parser must instead return the typed
    // `Malformed` error the module guarantees.
    let bytes = vec![PAREN_OPEN; MAX_EXPRESSION_DEPTH + 50];
    match parse_expression(&bytes) {
        Err(ExpressionParseError::Malformed { .. }) => {}
        other => panic!("expected Malformed on over-deep nesting, got {other:?}"),
    }
}

#[test]
fn moderately_nested_groupings_still_parse() {
    // A legitimately nested integer literal `((($FF 5)))` must still
    // parse — the depth bound only trips on pathological nesting.
    let mut bytes = vec![PAREN_OPEN; 3];
    bytes.extend_from_slice(&[EXPRESSION_TOKEN_LEAD, EXPRESSION_INT_LITERAL_TAG]);
    bytes.extend_from_slice(&5_i32.to_le_bytes());
    bytes.extend(std::iter::repeat_n(PAREN_CLOSE, 3));
    parse_expression(&bytes).expect("3-deep grouping must parse");
}

#[test]
fn int_literal_round_trip_positive() {
    // $ FF 2A 00 00 00 → 42
    let bytes = [0x24, 0xFF, 0x2A, 0x00, 0x00, 0x00];
    let (node, consumed) = parse_expression(&bytes).expect("parse");
    assert_eq!(consumed, 6);
    assert_eq!(node, ExprNode::IntLiteral(42));
}

#[test]
fn int_literal_round_trip_negative_sign_extends() {
    // $ FF FF FF FF FF → -1
    let bytes = [0x24, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF];
    let (node, _) = parse_expression(&bytes).expect("parse");
    assert_eq!(node, ExprNode::IntLiteral(-1));
}

#[test]
fn store_register_token() {
    // $ C8
    let bytes = [0x24, 0xC8];
    let (node, consumed) = parse_expression(&bytes).expect("parse");
    assert_eq!(consumed, 2);
    assert_eq!(node, ExprNode::StoreRegister);
}

#[test]
fn memory_ref_bank_b_index_zero() {
    // $ 01 [ $ FF 00 00 00 00 ] — intB[0]
    let bytes = [0x24, 0x01, 0x5B, 0x24, 0xFF, 0x00, 0x00, 0x00, 0x00, 0x5D];
    let (node, consumed) = parse_expression(&bytes).expect("parse");
    assert_eq!(consumed, bytes.len());
    match node {
        ExprNode::MemoryRef { bank, index } => {
            assert_eq!(bank, 0x01);
            assert_eq!(*index, ExprNode::IntLiteral(0));
        }
        other => panic!("expected MemoryRef, got {other:?}"),
    }
}

#[test]
fn add_one_plus_two_builds_binary_op_add() {
    // $ FF 01 00 00 00 \ 02 $ FF 02 00 00 00
    let bytes = [
        0x24, 0xFF, 0x01, 0x00, 0x00, 0x00, 0x5C, 0x02, 0x24, 0xFF, 0x02, 0x00, 0x00, 0x00,
    ];
    let (node, consumed) = parse_expression(&bytes).expect("parse");
    assert_eq!(consumed, bytes.len());
    match node {
        ExprNode::BinaryOp { op, lhs, rhs } => {
            assert_eq!(op, ExprOp::Add);
            assert_eq!(*lhs, ExprNode::IntLiteral(1));
            assert_eq!(*rhs, ExprNode::IntLiteral(2));
        }
        other => panic!("expected BinaryOp(Add), got {other:?}"),
    }
}

#[test]
fn assignment_shape_yields_assignment_node() {
    // $ 01 [ $ FF 00 00 00 00 ] \ 1E $ FF 07 00 00 00 — intB[0] = 7
    // (plain `=` is op 0x1E per rlvm's table).
    let bytes = [
        0x24, 0x01, 0x5B, 0x24, 0xFF, 0x00, 0x00, 0x00, 0x00, 0x5D, 0x5C, 0x1E, 0x24, 0xFF, 0x07,
        0x00, 0x00, 0x00,
    ];
    let (node, consumed) = parse_expression(&bytes).expect("parse");
    assert_eq!(consumed, bytes.len());
    match node {
        ExprNode::Assignment { dest, op, src } => {
            assert_eq!(op, AssignOp::Plain);
            match *dest {
                ExprNode::MemoryRef { bank, .. } => assert_eq!(bank, 0x01),
                other => panic!("expected MemoryRef dest, got {other:?}"),
            }
            assert_eq!(*src, ExprNode::IntLiteral(7));
        }
        other => panic!("expected Assignment, got {other:?}"),
    }
}

#[test]
fn unknown_operator_byte_in_continuation_emits_warning_and_recovers() {
    // Framed like a real Expression element the bytecode walker
    // accepts: <term> \<unknown-op> <rhs_term>. Truncating after the
    // unknown byte would never reach classification on a framed walk
    // (`next_arith` requires a RHS after any `\<op>`).
    // $ FF 01 00 00 00 \ 99 $ FF 00 00 00 00 — \x99 is not documented.
    // offsets: 0..=5 term, 6 `\`, 7 unknown, 8..=13 RHS.
    let bytes = [
        0x24, 0xFF, 0x01, 0x00, 0x00, 0x00, // lit 1
        0x5C, 0x99, // unknown binary op
        0x24, 0xFF, 0x00, 0x00, 0x00, 0x00, // lit 0 RHS
    ];
    let parsed = parse_expression_with_warnings(&bytes).expect("parse with recovery");
    assert!(matches!(parsed.node, ExprNode::IntLiteral(1)));
    assert_eq!(parsed.warnings.len(), 1);
    match &parsed.warnings[0] {
        ExpressionWarning::UnknownOperator { byte, offset } => {
            assert_eq!(*byte, 0x99);
            assert_eq!(*offset, 7, "offset must be the unknown op byte, not `\\`");
        }
    }
}

#[test]
fn decompile_path_unknown_operator_byte_is_typed_error() {
    // Same framed fixture as the recover-path test above: strict path
    // must NOT fabricate a partial AST. Position is the unknown
    // operator byte (offset 7), not the backslash cursor (offset 6).
    let bytes = [
        0x24, 0xFF, 0x01, 0x00, 0x00, 0x00, // lit 1
        0x5C, 0x99, // unknown binary op
        0x24, 0xFF, 0x00, 0x00, 0x00, 0x00, // lit 0 RHS
    ];
    let err = parse_expression(&bytes).expect_err("decompile path must fail-closed");
    match err {
        ExpressionParseError::UnknownOperator { byte, position } => {
            assert_eq!(byte, 0x99);
            assert_eq!(
                position, 7,
                "position must be the unknown op byte, not `\\`"
            );
        }
        other => panic!("expected UnknownOperator, got {other:?}"),
    }
}

#[test]
fn op_byte_table_pins_each_variant() {
    assert_eq!(ExprOp::Add.as_byte(), 0x02);
    assert_eq!(ExprOp::Sub.as_byte(), 0x03);
    assert_eq!(ExprOp::Mul.as_byte(), 0x04);
    assert_eq!(ExprOp::Div.as_byte(), 0x05);
    assert_eq!(ExprOp::Mod.as_byte(), 0x06);
    assert_eq!(ExprOp::And.as_byte(), 0x07);
    assert_eq!(ExprOp::Or.as_byte(), 0x08);
    assert_eq!(ExprOp::Xor.as_byte(), 0x09);
    assert_eq!(ExprOp::Equ.as_byte(), 0x28);
    assert_eq!(ExprOp::Neq.as_byte(), 0x29);
    assert_eq!(ExprOp::Lt.as_byte(), 0x2A);
    assert_eq!(ExprOp::Le.as_byte(), 0x2B);
    assert_eq!(ExprOp::Gt.as_byte(), 0x2C);
    assert_eq!(ExprOp::Ge.as_byte(), 0x2D);
    assert_eq!(ExprOp::LogicAnd.as_byte(), 0x3C);
    assert_eq!(ExprOp::LogicOr.as_byte(), 0x3D);
}

#[test]
fn assign_op_byte_table_pins_each_variant() {
    // rlvm table: 0x14..=0x1D compound, 0x1E plain `=`.
    assert_eq!(AssignOp::AddAssign.as_byte(), 0x14);
    assert_eq!(AssignOp::SubAssign.as_byte(), 0x15);
    assert_eq!(AssignOp::MulAssign.as_byte(), 0x16);
    assert_eq!(AssignOp::DivAssign.as_byte(), 0x17);
    assert_eq!(AssignOp::ModAssign.as_byte(), 0x18);
    assert_eq!(AssignOp::AndAssign.as_byte(), 0x19);
    assert_eq!(AssignOp::OrAssign.as_byte(), 0x1A);
    assert_eq!(AssignOp::XorAssign.as_byte(), 0x1B);
    assert_eq!(AssignOp::ShlAssign.as_byte(), 0x1C);
    assert_eq!(AssignOp::ShrAssign.as_byte(), 0x1D);
    assert_eq!(AssignOp::Plain.as_byte(), 0x1E);
}
