//! UTSUSHI-205 synthetic round-trip suite.
//!
//! 50 hand-built byte streams covering every operator at least once
//! (per acceptance criterion #0) plus the three documented specific
//! cases (acceptance criterion #1) and the unknown-operator partial
//! recovery path (acceptance criterion #2).
//!
//! Every test is a single `#[test]` so a regression surfaces with the
//! specific case-name in `cargo test` output rather than a generic
//! "case 17 of 50 failed" message.

use utsushi_reallive::{
    AssignOp, ExprNode, ExprOp, ExpressionParseError, ExpressionWarning, VarBanks, evaluate,
    evaluate_assignment, parse_expression, parse_expression_with_warnings,
};

// ----- Encoding helpers --------------------------------------------

/// `$ FF <i32 LE>` — int-literal token.
fn lit(value: i32) -> Vec<u8> {
    let mut bytes = vec![0x24, 0xFF];
    bytes.extend_from_slice(&value.to_le_bytes());
    bytes
}

/// `\ <op>` binary op continuation.
fn op(op: ExprOp) -> [u8; 2] {
    [0x5C, op.as_byte()]
}

/// `\ <assign_op>` assignment continuation.
fn assign(op: AssignOp) -> [u8; 2] {
    [0x5C, op.as_byte()]
}

/// `$ <bank> [ <idx_bytes> ]` memory ref.
fn mem(bank: u8, idx_bytes: &[u8]) -> Vec<u8> {
    let mut bytes = vec![0x24, bank, b'['];
    bytes.extend_from_slice(idx_bytes);
    bytes.push(b']');
    bytes
}

/// `( <inner> )` grouping.
fn group(inner: &[u8]) -> Vec<u8> {
    let mut bytes = vec![b'('];
    bytes.extend_from_slice(inner);
    bytes.push(b')');
    bytes
}

/// `$ C8` store register token.
fn store_ref() -> Vec<u8> {
    vec![0x24, 0xC8]
}

/// Concatenate a `lhs <op> rhs` binary expression.
fn binary(lhs: &[u8], op_bytes: [u8; 2], rhs: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(lhs.len() + 2 + rhs.len());
    bytes.extend_from_slice(lhs);
    bytes.extend_from_slice(&op_bytes);
    bytes.extend_from_slice(rhs);
    bytes
}

/// Parse the bytes, evaluate against a zeroed `VarBanks`, and assert
/// the result equals `expected`. Returns the AST node so callers can
/// inspect the shape further if needed.
fn parse_and_eval(bytes: &[u8], expected: i32) -> ExprNode {
    let (node, consumed) = parse_expression(bytes)
        .unwrap_or_else(|err| panic!("parse failed on {bytes:02X?}: {err:?}"));
    assert_eq!(
        consumed,
        bytes.len(),
        "parse must consume every byte; consumed {consumed} of {} on {bytes:02X?}",
        bytes.len(),
    );
    let banks = VarBanks::zeroed();
    let result = evaluate(&node, &banks)
        .unwrap_or_else(|err| panic!("eval failed on {bytes:02X?}: {err:?}"));
    assert_eq!(
        result, expected,
        "eval result mismatch on {bytes:02X?}: got {result}, expected {expected}",
    );
    node
}

// ===================================================================
// Spec-node acceptance criterion #1: three specific case evaluations.
// ===================================================================

#[test]
fn ac1_one_plus_two_equals_three() {
    // $ FF 01 00 00 00 \ 02 $ FF 02 00 00 00 — 1 + 2 = 3
    let bytes = binary(&lit(1), op(ExprOp::Add), &lit(2));
    let node = parse_and_eval(&bytes, 3);
    assert!(matches!(
        node,
        ExprNode::BinaryOp {
            op: ExprOp::Add,
            ..
        }
    ));
}

#[test]
fn ac1_five_lt_five_equals_zero() {
    // $ FF 05 00 00 00 \ 2A $ FF 05 00 00 00 — (5 < 5) = 0
    let bytes = binary(&lit(5), op(ExprOp::Lt), &lit(5));
    let node = parse_and_eval(&bytes, 0);
    assert!(matches!(node, ExprNode::BinaryOp { op: ExprOp::Lt, .. }));
}

#[test]
fn ac1_intb_zero_plus_five_with_value_ten_equals_fifteen() {
    // $ 01 [ $ FF 00 00 00 00 ] \ 02 $ FF 05 00 00 00 — intB[0] + 5
    let bytes = binary(&mem(0x01, &lit(0)), op(ExprOp::Add), &lit(5));
    let (node, consumed) = parse_expression(&bytes).expect("parse");
    assert_eq!(consumed, bytes.len());
    let mut banks = VarBanks::zeroed();
    banks.int_b[0] = 10;
    let result = evaluate(&node, &banks).expect("eval");
    assert_eq!(result, 15, "intB[0]=10, +5 must equal 15");
}

// ===================================================================
// Spec-node acceptance criterion #2: unknown-operator partial recovery.
// ===================================================================

#[test]
fn ac2_unknown_operator_byte_emits_warning_and_partial_result() {
    // $ FF 04 00 00 00 \ EE — \xEE is not a documented op byte.
    let mut bytes = lit(4);
    bytes.push(0x5C);
    bytes.push(0xEE);
    let parsed =
        parse_expression_with_warnings(&bytes).expect("partial recovery must not surface as Err");
    assert!(matches!(parsed.node, ExprNode::IntLiteral(4)));
    assert_eq!(parsed.warnings.len(), 1);
    match &parsed.warnings[0] {
        ExpressionWarning::UnknownOperator { byte, offset } => {
            assert_eq!(*byte, 0xEE);
            assert_eq!(*offset, lit(4).len());
        }
    }
    assert_eq!(
        parsed.warnings[0].audit_code(),
        "utsushi.reallive.unknown_expression_operator",
    );
}

#[test]
fn ac2_unknown_operator_inside_chain_partial_result_at_warning_point() {
    // (1 + 2) \ EE  — chain breaks after the recognised 1+2.
    let mut bytes = binary(&lit(1), op(ExprOp::Add), &lit(2));
    bytes.push(0x5C);
    bytes.push(0xEE);
    let parsed = parse_expression_with_warnings(&bytes).expect("partial recovery");
    let banks = VarBanks::zeroed();
    let result = evaluate(&parsed.node, &banks).expect("partial eval");
    assert_eq!(result, 3, "partial result is the in-progress sum (1 + 2)");
    assert_eq!(parsed.warnings.len(), 1);
}

// ===================================================================
// Synthetic 50-case round-trip suite — each operator at least once.
// ===================================================================

// --- Arithmetic ops (Add / Sub / Mul / Div / Mod) ------------------

#[test]
fn synth_01_add_positive_positive() {
    parse_and_eval(&binary(&lit(7), op(ExprOp::Add), &lit(8)), 15);
}

#[test]
fn synth_02_add_negative_positive() {
    parse_and_eval(&binary(&lit(-3), op(ExprOp::Add), &lit(10)), 7);
}

#[test]
fn synth_03_add_large_wraps() {
    parse_and_eval(&binary(&lit(i32::MAX), op(ExprOp::Add), &lit(1)), i32::MIN);
}

#[test]
fn synth_04_sub_positive() {
    parse_and_eval(&binary(&lit(20), op(ExprOp::Sub), &lit(8)), 12);
}

#[test]
fn synth_05_sub_underflow_wraps() {
    parse_and_eval(&binary(&lit(i32::MIN), op(ExprOp::Sub), &lit(1)), i32::MAX);
}

#[test]
fn synth_06_mul_positive() {
    parse_and_eval(&binary(&lit(6), op(ExprOp::Mul), &lit(7)), 42);
}

#[test]
fn synth_07_mul_by_zero() {
    parse_and_eval(&binary(&lit(123), op(ExprOp::Mul), &lit(0)), 0);
}

#[test]
fn synth_08_mul_negative() {
    parse_and_eval(&binary(&lit(-3), op(ExprOp::Mul), &lit(4)), -12);
}

#[test]
fn synth_09_div_exact() {
    parse_and_eval(&binary(&lit(20), op(ExprOp::Div), &lit(5)), 4);
}

#[test]
fn synth_10_div_truncates_toward_zero() {
    parse_and_eval(&binary(&lit(7), op(ExprOp::Div), &lit(2)), 3);
}

#[test]
fn synth_11_div_by_zero_is_typed_error() {
    let bytes = binary(&lit(7), op(ExprOp::Div), &lit(0));
    let (node, _) = parse_expression(&bytes).expect("parse");
    let banks = VarBanks::zeroed();
    let err = evaluate(&node, &banks).expect_err("div by zero must fail typed-error");
    assert_eq!(format!("{err}"), "expression evaluator: division by zero",);
}

#[test]
fn synth_12_mod_positive() {
    parse_and_eval(&binary(&lit(17), op(ExprOp::Mod), &lit(5)), 2);
}

#[test]
fn synth_13_mod_by_zero_is_typed_error() {
    let bytes = binary(&lit(7), op(ExprOp::Mod), &lit(0));
    let (node, _) = parse_expression(&bytes).expect("parse");
    let banks = VarBanks::zeroed();
    assert!(evaluate(&node, &banks).is_err());
}

// --- Bitwise ops (And / Or / Xor) ----------------------------------

#[test]
fn synth_14_bitwise_and() {
    parse_and_eval(&binary(&lit(0xF0), op(ExprOp::And), &lit(0x0F)), 0x00);
}

#[test]
fn synth_15_bitwise_and_overlap() {
    parse_and_eval(&binary(&lit(0xFF), op(ExprOp::And), &lit(0x0F)), 0x0F);
}

#[test]
fn synth_16_bitwise_or() {
    parse_and_eval(&binary(&lit(0xF0), op(ExprOp::Or), &lit(0x0F)), 0xFF);
}

#[test]
fn synth_17_bitwise_xor() {
    parse_and_eval(&binary(&lit(0xFF), op(ExprOp::Xor), &lit(0x0F)), 0xF0);
}

// --- Comparison ops (Equ / Neq / Lt / Le / Gt / Ge) ----------------

#[test]
fn synth_18_equ_true() {
    parse_and_eval(&binary(&lit(7), op(ExprOp::Equ), &lit(7)), 1);
}

#[test]
fn synth_19_equ_false() {
    parse_and_eval(&binary(&lit(7), op(ExprOp::Equ), &lit(8)), 0);
}

#[test]
fn synth_20_neq_true() {
    parse_and_eval(&binary(&lit(7), op(ExprOp::Neq), &lit(8)), 1);
}

#[test]
fn synth_21_lt_true() {
    parse_and_eval(&binary(&lit(3), op(ExprOp::Lt), &lit(5)), 1);
}

#[test]
fn synth_22_lt_false_on_equal() {
    parse_and_eval(&binary(&lit(5), op(ExprOp::Lt), &lit(5)), 0);
}

#[test]
fn synth_23_le_true_on_equal() {
    parse_and_eval(&binary(&lit(5), op(ExprOp::Le), &lit(5)), 1);
}

#[test]
fn synth_24_gt_true() {
    parse_and_eval(&binary(&lit(9), op(ExprOp::Gt), &lit(5)), 1);
}

#[test]
fn synth_25_ge_true_on_equal() {
    parse_and_eval(&binary(&lit(5), op(ExprOp::Ge), &lit(5)), 1);
}

// --- Logical ops (LogicAnd / LogicOr, short-circuit) --------------

#[test]
fn synth_26_logic_and_true_true() {
    parse_and_eval(&binary(&lit(1), op(ExprOp::LogicAnd), &lit(2)), 1);
}

#[test]
fn synth_27_logic_and_false_short_circuit() {
    // RHS would div-by-zero; short-circuit must skip it.
    let rhs = binary(&lit(1), op(ExprOp::Div), &lit(0));
    parse_and_eval(&binary(&lit(0), op(ExprOp::LogicAnd), &rhs), 0);
}

#[test]
fn synth_28_logic_or_true_short_circuit() {
    let rhs = binary(&lit(1), op(ExprOp::Div), &lit(0));
    parse_and_eval(&binary(&lit(1), op(ExprOp::LogicOr), &rhs), 1);
}

#[test]
fn synth_29_logic_or_false_false() {
    parse_and_eval(&binary(&lit(0), op(ExprOp::LogicOr), &lit(0)), 0);
}

// --- Tokens (IntLiteral, StoreRegister, MemoryRef) ----------------

#[test]
fn synth_30_int_literal_min() {
    parse_and_eval(&lit(i32::MIN), i32::MIN);
}

#[test]
fn synth_31_int_literal_max() {
    parse_and_eval(&lit(i32::MAX), i32::MAX);
}

#[test]
fn synth_32_int_literal_zero() {
    parse_and_eval(&lit(0), 0);
}

#[test]
fn synth_33_store_register_read() {
    let mut banks = VarBanks::zeroed();
    banks.store = 99;
    let (node, _) = parse_expression(&store_ref()).expect("parse");
    assert_eq!(evaluate(&node, &banks).unwrap(), 99);
}

#[test]
fn synth_34_memory_ref_intb_42() {
    let mut banks = VarBanks::zeroed();
    banks.int_b[42] = 1234;
    let bytes = mem(0x01, &lit(42));
    let (node, _) = parse_expression(&bytes).expect("parse");
    assert_eq!(evaluate(&node, &banks).unwrap(), 1234);
}

#[test]
fn synth_35_memory_ref_inta_zero() {
    let mut banks = VarBanks::zeroed();
    banks.int_a[0] = 7;
    let bytes = mem(0x00, &lit(0));
    let (node, _) = parse_expression(&bytes).expect("parse");
    assert_eq!(evaluate(&node, &banks).unwrap(), 7);
}

#[test]
fn synth_36_memory_ref_with_computed_index() {
    // $ 01 [ (2 + 1) ] — intB; index resolves at eval time to 3.
    let mut banks = VarBanks::zeroed();
    banks.int_b[3] = 555;
    let idx = binary(&lit(2), op(ExprOp::Add), &lit(1));
    let bytes = mem(0x01, &group(&idx));
    let (node, _) = parse_expression(&bytes).expect("parse");
    assert_eq!(evaluate(&node, &banks).unwrap(), 555);
}

// --- Grouping ------------------------------------------------------

#[test]
fn synth_37_group_around_int_literal() {
    let bytes = group(&lit(42));
    let (node, consumed) = parse_expression(&bytes).expect("parse");
    assert_eq!(consumed, bytes.len());
    assert!(matches!(node, ExprNode::Group(_)));
    let banks = VarBanks::zeroed();
    assert_eq!(evaluate(&node, &banks).unwrap(), 42);
}

#[test]
fn synth_38_nested_group() {
    let inner = group(&binary(&lit(2), op(ExprOp::Add), &lit(3)));
    let outer = group(&inner);
    parse_and_eval(&outer, 5);
}

// --- Unary ops (Noop / Neg) ---------------------------------------

#[test]
fn synth_39_unary_noop_passthrough() {
    // \ 00 $ FF 09 00 00 00 — \0 followed by literal 9 → 9.
    let mut bytes = vec![0x5C, 0x00];
    bytes.extend_from_slice(&lit(9));
    parse_and_eval(&bytes, 9);
}

#[test]
fn synth_40_unary_neg_simple() {
    // \ 01 $ FF 05 00 00 00 — -5.
    let mut bytes = vec![0x5C, 0x01];
    bytes.extend_from_slice(&lit(5));
    parse_and_eval(&bytes, -5);
}

#[test]
fn synth_41_unary_neg_on_i32_min_wraps() {
    let mut bytes = vec![0x5C, 0x01];
    bytes.extend_from_slice(&lit(i32::MIN));
    parse_and_eval(&bytes, i32::MIN); // wrapping_neg of MIN is MIN.
}

// --- Assignment ops -----------------------------------------------

#[test]
fn synth_42_plain_assign_into_intb() {
    let mut bytes = mem(0x01, &lit(0));
    bytes.extend_from_slice(&assign(AssignOp::Plain));
    bytes.extend_from_slice(&lit(7));
    let (node, consumed) = parse_expression(&bytes).expect("parse");
    assert_eq!(consumed, bytes.len());
    let mut banks = VarBanks::zeroed();
    evaluate_assignment(&node, &mut banks).expect("eval");
    assert_eq!(banks.int_b[0], 7);
}

#[test]
fn synth_43_add_assign_compound() {
    let mut bytes = mem(0x01, &lit(0));
    bytes.extend_from_slice(&assign(AssignOp::AddAssign));
    bytes.extend_from_slice(&lit(3));
    let (node, _) = parse_expression(&bytes).expect("parse");
    let mut banks = VarBanks::zeroed();
    banks.int_b[0] = 5;
    evaluate_assignment(&node, &mut banks).unwrap();
    assert_eq!(banks.int_b[0], 8);
}

#[test]
fn synth_44_sub_assign_compound() {
    let mut bytes = mem(0x01, &lit(0));
    bytes.extend_from_slice(&assign(AssignOp::SubAssign));
    bytes.extend_from_slice(&lit(3));
    let (node, _) = parse_expression(&bytes).expect("parse");
    let mut banks = VarBanks::zeroed();
    banks.int_b[0] = 10;
    evaluate_assignment(&node, &mut banks).unwrap();
    assert_eq!(banks.int_b[0], 7);
}

#[test]
fn synth_45_mul_assign_compound() {
    let mut bytes = mem(0x01, &lit(0));
    bytes.extend_from_slice(&assign(AssignOp::MulAssign));
    bytes.extend_from_slice(&lit(4));
    let (node, _) = parse_expression(&bytes).expect("parse");
    let mut banks = VarBanks::zeroed();
    banks.int_b[0] = 3;
    evaluate_assignment(&node, &mut banks).unwrap();
    assert_eq!(banks.int_b[0], 12);
}

#[test]
fn synth_46_div_assign_compound() {
    let mut bytes = mem(0x01, &lit(0));
    bytes.extend_from_slice(&assign(AssignOp::DivAssign));
    bytes.extend_from_slice(&lit(2));
    let (node, _) = parse_expression(&bytes).expect("parse");
    let mut banks = VarBanks::zeroed();
    banks.int_b[0] = 20;
    evaluate_assignment(&node, &mut banks).unwrap();
    assert_eq!(banks.int_b[0], 10);
}

#[test]
fn synth_47_mod_assign_compound() {
    let mut bytes = mem(0x01, &lit(0));
    bytes.extend_from_slice(&assign(AssignOp::ModAssign));
    bytes.extend_from_slice(&lit(7));
    let (node, _) = parse_expression(&bytes).expect("parse");
    let mut banks = VarBanks::zeroed();
    banks.int_b[0] = 23;
    evaluate_assignment(&node, &mut banks).unwrap();
    assert_eq!(banks.int_b[0], 2);
}

#[test]
fn synth_48_and_assign_compound() {
    let mut bytes = mem(0x01, &lit(0));
    bytes.extend_from_slice(&assign(AssignOp::AndAssign));
    bytes.extend_from_slice(&lit(0x0F));
    let (node, _) = parse_expression(&bytes).expect("parse");
    let mut banks = VarBanks::zeroed();
    banks.int_b[0] = 0xFF;
    evaluate_assignment(&node, &mut banks).unwrap();
    assert_eq!(banks.int_b[0], 0x0F);
}

#[test]
fn synth_49_or_assign_compound() {
    let mut bytes = mem(0x01, &lit(0));
    bytes.extend_from_slice(&assign(AssignOp::OrAssign));
    bytes.extend_from_slice(&lit(0x0F));
    let (node, _) = parse_expression(&bytes).expect("parse");
    let mut banks = VarBanks::zeroed();
    banks.int_b[0] = 0xF0;
    evaluate_assignment(&node, &mut banks).unwrap();
    assert_eq!(banks.int_b[0], 0xFF);
}

#[test]
fn synth_50_xor_assign_compound() {
    let mut bytes = mem(0x01, &lit(0));
    bytes.extend_from_slice(&assign(AssignOp::XorAssign));
    bytes.extend_from_slice(&lit(0xFF));
    let (node, _) = parse_expression(&bytes).expect("parse");
    let mut banks = VarBanks::zeroed();
    banks.int_b[0] = 0x0F;
    evaluate_assignment(&node, &mut banks).unwrap();
    assert_eq!(banks.int_b[0], 0xF0);
}

// --- Negative / hardness cases ------------------------------------

#[test]
fn empty_input_returns_truncated_not_zero_state() {
    match parse_expression(&[]) {
        Err(ExpressionParseError::Truncated { observed_len, .. }) => assert_eq!(observed_len, 0),
        other => panic!("expected Truncated on empty input, got {other:?}"),
    }
}

#[test]
fn truncated_int_literal_is_typed_error() {
    // $ FF 01 02 — only 2 bytes of the 4-byte LE i32.
    let bytes = [0x24, 0xFF, 0x01, 0x02];
    assert!(matches!(
        parse_expression(&bytes),
        Err(ExpressionParseError::Truncated { .. })
    ));
}

#[test]
fn unclosed_memory_ref_is_malformed() {
    // $ 0B [ $ FF 00 00 00 00  — missing ]
    let bytes = [0x24, 0x01, 0x5B, 0x24, 0xFF, 0x00, 0x00, 0x00, 0x00];
    let err = parse_expression(&bytes).expect_err("missing ']' must be typed error");
    assert!(
        matches!(err, ExpressionParseError::Truncated { .. })
            || matches!(err, ExpressionParseError::Malformed { .. }),
        "unexpected error variant on missing ']': {err:?}",
    );
}
