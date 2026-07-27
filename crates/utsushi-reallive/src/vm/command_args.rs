use super::*;

impl Vm {
    /// Evaluate a complete parenthesized command expression, retaining other
    /// complex parameter shapes as opaque bytes.
    pub(super) fn decode_parenthesized_command_arg(&mut self, bytes: Vec<u8>) -> ExprValue {
        match parse_expression(&bytes) {
            Ok((node, consumed)) if consumed == bytes.len() => self
                .eval_expression_node(&node)
                .map_or(ExprValue::Bytes(bytes.clone()), |(_, value)| {
                    ExprValue::Int(value)
                }),
            Ok(_) | Err(_) => ExprValue::Bytes(bytes),
        }
    }
}
