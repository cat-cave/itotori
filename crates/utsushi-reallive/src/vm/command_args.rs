use super::*;

impl Vm {
    /// Evaluate a complete parenthesized command expression, retaining other
    /// complex parameter shapes as opaque bytes.
    pub(super) fn decode_parenthesized_command_arg(&mut self, bytes: Vec<u8>) -> ExprValue {
        match parse_expression(&bytes) {
            Ok((node, consumed)) if consumed == bytes.len() => self
                .eval_command_arg_node(&node)
                .map_or(ExprValue::Bytes(bytes.clone()), ExprValue::Int),
            Ok(_) | Err(_) => ExprValue::Bytes(bytes),
        }
    }

    /// Evaluate one of a command's OWN arguments.
    ///
    /// Identical to the standalone-expression path except in one respect: the
    /// result does not land in the store register. An argument is something
    /// the command reads, not a result the command produced, and the store
    /// register is live data — a script may perfectly well keep a loop counter
    /// there and branch on `store <= N`. Letting the condition's own boolean
    /// overwrite the register pins that counter at 0 or 1 forever, so a loop
    /// written to run seven times instead runs until whatever step budget the
    /// caller set runs out. A proven archive does exactly this.
    pub(super) fn eval_command_arg_node(
        &mut self,
        node: &ExprNode,
    ) -> Result<i32, ExpressionWrapError> {
        match node {
            // An assignment argument still performs its write: that IS its
            // effect, and it names the bank it targets.
            ExprNode::Assignment { .. } => {
                evaluate_assignment(node, &mut self.banks).map_err(ExpressionWrapError::Eval)
            }
            _ => evaluate(node, &self.banks).map_err(ExpressionWrapError::Eval),
        }
    }
}
