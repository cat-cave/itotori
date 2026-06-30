//! Siglus scene bytecode stack-VM decompiler — **skeleton** (siglus-05).
//!
//! Unlike RealLive's opener-byte switch, Siglus scene bytecode is a
//! **stack-machine** instruction stream: opcodes push/pop operands
//! (decoded by [`crate::expression`]) and reference interned string /
//! name tables. This module owns the instruction-stream decode; the
//! per-instruction operand expressions are decoded by
//! [`crate::expression::decode_expression`].
//!
//! Skeleton status: [`parse_scene_bytecode`] returns
//! [`SiglusParseError::NotImplemented`], and [`SiglusOpcode`] carries only
//! the `Unknown` catch-all today. The documented opcode catalogue lands
//! against real bytes downstream — and, per the 100%-decompilation
//! contract, a well-formed scene must ultimately produce **zero**
//! `Unknown` spans (no relaxed opcode-recognition floor).

use thiserror::Error;

/// A decoded Siglus scene-bytecode instruction.
///
/// Skeleton: only the `Unknown` catch-all exists. The real opcode
/// catalogue (text-out, name-table push, choice, jump, voice, …) is
/// populated against real bytes downstream. `Unknown` is retained as the
/// honest "not yet classified" marker — the real decompiler must drive it
/// to zero on well-formed input rather than silently swallowing bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum SiglusOpcode {
    /// An instruction at a byte the skeleton cannot yet classify. Carries
    /// the raw lead byte and the absolute stream offset so the real
    /// decompiler can be validated to emit zero of these.
    Unknown { lead: u8, byte_offset: usize },
}

/// Fatal errors raised by the Siglus scene-bytecode decompiler.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SiglusParseError {
    /// The decompiler is not implemented in the skeleton.
    #[error(
        "kaifuu.siglus.opcode.not_implemented: Siglus scene-bytecode stack-VM decompiler is a \
         siglus-05 skeleton stub; the documented opcode catalogue (driving Unknown to zero on \
         well-formed input) lands against real bytes downstream"
    )]
    NotImplemented,
    /// The bytecode stream ended mid-instruction. Empty input is this
    /// error, never a silent `Ok(vec![])`.
    #[error(
        "kaifuu.siglus.opcode.truncated_bytecode: scene bytecode ended at byte {byte_offset} \
         needing {needed} more bytes"
    )]
    TruncatedBytecode { byte_offset: usize, needed: usize },
}

/// Decode a **decompressed** Siglus scene-bytecode stream into a typed
/// [`SiglusOpcode`] sequence.
///
/// Skeleton: always returns [`SiglusParseError::NotImplemented`]. The real
/// implementation walks the stack-VM instruction stream, decodes operand
/// expressions via [`crate::expression`], and partitions every byte into a
/// typed instruction (zero `Unknown` on well-formed input).
pub fn parse_scene_bytecode(_bytes: &[u8]) -> Result<Vec<SiglusOpcode>, SiglusParseError> {
    Err(SiglusParseError::NotImplemented)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skeleton_decompiler_returns_typed_not_implemented_not_fake_opcodes() {
        let err = parse_scene_bytecode(&[0x01, 0x02, 0x03])
            .expect_err("skeleton must not fabricate a decoded opcode stream");
        assert!(matches!(err, SiglusParseError::NotImplemented));
        assert!(
            err.to_string()
                .starts_with(crate::SIGLUS_UNIMPLEMENTED_MARKER)
        );
    }
}
