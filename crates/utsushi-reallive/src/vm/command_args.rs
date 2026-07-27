use super::*;

impl Vm {
    /// Preserve a direct integer-bank reference for command operations that
    /// write through their arguments, while exposing its current value to
    /// ordinary read-only operations.
    pub(super) fn decode_command_expr_value(
        &mut self,
        node: &ExprNode,
    ) -> Result<ExprValue, ExpressionWrapError> {
        let value = self.eval_command_arg_node(node)?;
        if let ExprNode::MemoryRef { bank, index } = node {
            let index = self.eval_command_arg_node(index)?;
            return Ok(ExprValue::IntReference {
                bank: *bank,
                index,
                value,
            });
        }
        Ok(ExprValue::Int(value))
    }

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

#[cfg(test)]
mod tests {
    use super::*;

    fn int_reference(bank: u8, index: i32) -> Vec<u8> {
        let mut bytes = vec![0x24, bank, b'[', 0x24, 0xff];
        bytes.extend_from_slice(&index.to_le_bytes());
        bytes.push(b']');
        bytes
    }

    #[test]
    fn direct_integer_reference_command_args_preserve_destinations() {
        let mut raw = vec![0x23, 1, 4, 133, 0, 4, 0, 0, b'('];
        for (slot, index) in [3, 4, 5, 6].into_iter().enumerate() {
            if slot > 0 {
                raw.push(b',');
            }
            raw.extend(int_reference(0, index));
        }
        raw.push(b')');

        let values = Vm::new(1, 0).decode_command_args(&raw);
        assert_eq!(
            values,
            vec![
                ExprValue::IntReference {
                    bank: 0,
                    index: 3,
                    value: 0,
                },
                ExprValue::IntReference {
                    bank: 0,
                    index: 4,
                    value: 0,
                },
                ExprValue::IntReference {
                    bank: 0,
                    index: 5,
                    value: 0,
                },
                ExprValue::IntReference {
                    bank: 0,
                    index: 6,
                    value: 0,
                },
            ]
        );
    }
}
