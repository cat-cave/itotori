//! Siglus stack-machine expression decoder — **skeleton** (siglus-05).
//! Siglus operands are encoded as a postfix expression stream the scene
//! VM evaluates against an operand stack (integer/string literals,
//! variable refs, operators, and call forms). [`crate::opcode`] calls
//! [`decode_expression`] to recover each instruction's operands.
//! Skeleton status: [`decode_expression`] returns
//! [`SiglusExpressionError::NotImplemented`], and [`SiglusExpr`] carries
//! only the `Unknown` catch-all today.

use thiserror::Error;

/// A decoded Siglus operand expression.
/// Skeleton: only the `Unknown` catch-all exists. The real expression
/// grammar (int/string literals, variable refs, operators, calls) is
/// populated against real bytes downstream.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum SiglusExpr {
    /// An expression token the skeleton cannot yet classify. Carries the
    /// raw lead byte and absolute offset for downstream validation.
    Unknown { lead: u8, byte_offset: usize },
}

/// Fatal errors raised by the Siglus expression decoder.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SiglusExpressionError {
    /// The expression decoder is not implemented in the skeleton.
    #[error(
        "kaifuu.siglus.expression.not_implemented: Siglus stack-machine expression decoder is a \
         siglus-05 skeleton stub; the real postfix-expression grammar lands against real bytes \
         downstream"
    )]
    NotImplemented,
    /// The expression stream ended before a complete token was read.
    #[error(
        "kaifuu.siglus.expression.truncated: expression stream ended at byte {byte_offset} \
         needing {needed} more bytes"
    )]
    Truncated { byte_offset: usize, needed: usize },
}

/// Decode a single Siglus operand expression starting at `pos`.
/// Returns the decoded [`SiglusExpr`] and the byte position immediately
/// after it (mirroring the `kaifuu-reallive`
/// `parse_expression(bytes, pos) -> (Expr, usize)` shape). Skeleton:
/// always returns [`SiglusExpressionError::NotImplemented`].
pub fn decode_expression(
    _bytes: &[u8],
    _pos: usize,
) -> Result<(SiglusExpr, usize), SiglusExpressionError> {
    Err(SiglusExpressionError::NotImplemented)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skeleton_expression_returns_typed_not_implemented_not_fake_expr() {
        let err = decode_expression(&[0x10, 0x20], 0)
            .expect_err("skeleton must not fabricate a decoded expression");
        assert!(matches!(err, SiglusExpressionError::NotImplemented));
        assert!(
            err.to_string()
                .starts_with(crate::SIGLUS_UNIMPLEMENTED_MARKER)
        );
    }
}
