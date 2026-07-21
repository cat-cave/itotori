//! Unknown-operator recovery cases for synthetic expression streams.

use utsushi_reallive::{
    ExprNode, ExprOp, ExpressionParseError, ExpressionWarning, VarBanks, evaluate,
    parse_expression, parse_expression_with_warnings,
};

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

/// Concatenate a `lhs <op> rhs` binary expression.
fn binary(lhs: &[u8], op_bytes: [u8; 2], rhs: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(lhs.len() + 2 + rhs.len());
    bytes.extend_from_slice(lhs);
    bytes.extend_from_slice(&op_bytes);
    bytes.extend_from_slice(rhs);
    bytes
}

/// Build a framed `<lhs> \<unknown-op-byte> <rhs>` stream the way a real
/// Expression element is length-walked: any `\<op>` is followed by a RHS
/// term (`next_arith` requires it). Truncating after the unknown byte
/// would never reach operator classification on a framed walk.
fn framed_unknown_binary_op(lhs: &[u8], unknown_op: u8, rhs: &[u8]) -> (Vec<u8>, usize) {
    let mut bytes = Vec::with_capacity(lhs.len() + 2 + rhs.len());
    bytes.extend_from_slice(lhs);
    bytes.push(0x5C);
    // Offset of the unknown operator byte (not the backslash).
    let unknown_offset = bytes.len();
    bytes.push(unknown_op);
    bytes.extend_from_slice(rhs);
    (bytes, unknown_offset)
}

// Spec-node acceptance criterion #2: unknown-operator partial recovery.

#[test]
fn ac2_unknown_operator_byte_emits_warning_and_partial_result() {
    // $ FF 04 00 00 00 \ EE $ FF 00 00 00 00 — \xEE is not documented.
    let (bytes, unknown_offset) = framed_unknown_binary_op(&lit(4), 0xEE, &lit(0));
    let parsed =
        parse_expression_with_warnings(&bytes).expect("partial recovery must not surface as Err");
    assert!(matches!(parsed.node, ExprNode::IntLiteral(4)));
    assert_eq!(parsed.warnings.len(), 1);
    match &parsed.warnings[0] {
        ExpressionWarning::UnknownOperator { byte, offset } => {
            assert_eq!(*byte, 0xEE);
            assert_eq!(
                *offset, unknown_offset,
                "offset must be the unknown op byte, not `\\`"
            );
        }
    }
    assert_eq!(
        parsed.warnings[0].audit_code(),
        "utsushi.reallive.unknown_expression_operator",
    );
}

/// Decompile / strict path must fail-closed on an unknown operator
/// byte — no fabricated `+ 0` partial AST that masks coverage gaps.
#[test]
fn decompile_path_unknown_operator_yields_typed_error() {
    // Same framed fixture as the emulator recover-path AC2 test above.
    let (bytes, unknown_offset) = framed_unknown_binary_op(&lit(4), 0xEE, &lit(0));
    let err = parse_expression(&bytes).expect_err("decompile path must fail-closed");
    match err {
        ExpressionParseError::UnknownOperator { byte, position } => {
            assert_eq!(byte, 0xEE);
            assert_eq!(
                position, unknown_offset,
                "position must be the unknown op byte, not `\\`"
            );
        }
        other => panic!("expected UnknownOperator, got {other:?}"),
    }
}

#[test]
fn ac2_unknown_operator_inside_chain_partial_result_at_warning_point() {
    // (1 + 2) \ EE <rhs> — chain breaks after the recognised 1+2; framed
    // with a valid RHS so this is not a truncated stream.
    let lhs = binary(&lit(1), op(ExprOp::Add), &lit(2));
    let (bytes, _) = framed_unknown_binary_op(&lhs, 0xEE, &lit(0));
    let parsed = parse_expression_with_warnings(&bytes).expect("partial recovery");
    let banks = VarBanks::new();
    let result = evaluate(&parsed.node, &banks).expect("partial eval");
    assert_eq!(result, 3, "partial result is the in-progress sum (1 + 2)");
    assert_eq!(parsed.warnings.len(), 1);
}
