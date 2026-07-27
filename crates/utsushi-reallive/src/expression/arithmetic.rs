use super::*;

pub(super) fn parse_arith(state: &mut ParserState<'_>) -> Result<ExprNode, ExpressionParseError> {
    let mut lhs = parse_high(state)?;
    while let Some(op) = peek_binary_op(state, &[ExprOp::Add, ExprOp::Sub]) {
        state.advance(2);
        let rhs = parse_high(state)?;
        lhs = ExprNode::BinaryOp {
            op,
            lhs: Box::new(lhs),
            rhs: Box::new(rhs),
        };
    }
    Ok(lhs)
}

fn parse_high(state: &mut ParserState<'_>) -> Result<ExprNode, ExpressionParseError> {
    let mut lhs = parse_term(state)?;
    let high = [
        ExprOp::Mul,
        ExprOp::Div,
        ExprOp::Mod,
        ExprOp::And,
        ExprOp::Or,
        ExprOp::Xor,
        ExprOp::Shl,
        ExprOp::Shr,
    ];
    while let Some(op) = peek_binary_op(state, &high) {
        state.advance(2);
        let rhs = parse_term(state)?;
        lhs = ExprNode::BinaryOp {
            op,
            lhs: Box::new(lhs),
            rhs: Box::new(rhs),
        };
    }
    if peek_unknown_binary_op_slot(state) {
        let byte = state.peek(1).unwrap_or(0);
        state.on_unknown_operator(byte, state.pos + 1)?;
        state.advance(2);
    }
    Ok(lhs)
}
