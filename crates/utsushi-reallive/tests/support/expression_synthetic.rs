use super::*;

/// `$ FF <i32 LE>` — int-literal token.
pub(super) fn lit(value: i32) -> Vec<u8> {
    let mut bytes = vec![0x24, 0xFF];
    bytes.extend_from_slice(&value.to_le_bytes());
    bytes
}

/// `\ <op>` binary op continuation.
pub(super) fn op(op: ExprOp) -> [u8; 2] {
    [0x5C, op.as_byte()]
}

/// `\ <assign_op>` assignment continuation.
pub(super) fn assign(op: AssignOp) -> [u8; 2] {
    [0x5C, op.as_byte()]
}

/// `$ <bank> [ <idx_bytes> ]` memory ref.
pub(super) fn mem(bank: u8, idx_bytes: &[u8]) -> Vec<u8> {
    let mut bytes = vec![0x24, bank, b'['];
    bytes.extend_from_slice(idx_bytes);
    bytes.push(b']');
    bytes
}

/// `( <inner> )` grouping.
pub(super) fn group(inner: &[u8]) -> Vec<u8> {
    let mut bytes = vec![b'('];
    bytes.extend_from_slice(inner);
    bytes.push(b')');
    bytes
}

/// `$ C8` store register token.
pub(super) fn store_ref() -> Vec<u8> {
    vec![0x24, 0xC8]
}

/// Concatenate a `lhs <op> rhs` binary expression.
pub(super) fn binary(lhs: &[u8], op_bytes: [u8; 2], rhs: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(lhs.len() + 2 + rhs.len());
    bytes.extend_from_slice(lhs);
    bytes.extend_from_slice(&op_bytes);
    bytes.extend_from_slice(rhs);
    bytes
}

/// Parse the bytes, evaluate against a zeroed `VarBanks`, and assert
/// the result equals `expected`. Returns the AST node so callers can
/// inspect the shape further if needed.
pub(super) fn parse_and_eval(bytes: &[u8], expected: i32) -> ExprNode {
    let (node, consumed) = parse_expression(bytes)
        .unwrap_or_else(|err| panic!("parse failed on {bytes:02X?}: {err:?}"));
    assert_eq!(
        consumed,
        bytes.len(),
        "parse must consume every byte; consumed {consumed} of {} on {bytes:02X?}",
        bytes.len(),
    );
    let banks = VarBanks::new();
    let result = evaluate(&node, &banks)
        .unwrap_or_else(|err| panic!("eval failed on {bytes:02X?}: {err:?}"));
    assert_eq!(
        result, expected,
        "eval result mismatch on {bytes:02X?}: got {result}, expected {expected}",
    );
    node
}
