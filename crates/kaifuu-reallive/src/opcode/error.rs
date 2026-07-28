use std::fmt;

use kaifuu_core::RedactedContentSummary;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::COMMAND_HEADER_LEN;

/// Decoder error surface. Typed; no `unwrap` clusters in production.
#[derive(Clone, PartialEq, Eq, Error, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum RealLiveParseError {
    /// The bytecode stream was empty or produced no opcodes — silent
    /// zero-state is never accepted.
    #[error(
        "kaifuu.reallive.truncated_bytecode: scene stream produced no opcodes (input_len={input_len})"
    )]
    TruncatedBytecode { input_len: usize },
    /// A Meta element header ran past the end of the stream.
    #[error(
        "kaifuu.reallive.truncated_meta_header: meta header at offset {offset} needs {needed} bytes, {available} available"
    )]
    TruncatedMetaHeader {
        opener: u8,
        offset: u64,
        needed: usize,
        available: usize,
    },
    /// A Command element's 8-byte header ran past the end of the stream.
    #[error(
        "kaifuu.reallive.truncated_command_header: command at offset {offset} needs {COMMAND_HEADER_LEN} bytes, {available} available"
    )]
    TruncatedCommandHeader { offset: u64, available: usize },
    /// A Command element's argument list ran past the end of the stream.
    #[error(
        "kaifuu.reallive.truncated_command_args: command at offset {offset} declared argc={argc} but argument bytes ran out"
    )]
    TruncatedCommandArgs { offset: u64, argc: u16 },
    /// A Shift-JIS Textout run failed length-prefix validation. Surfaced
    /// for malformed length-prefixed strings; inline Textout runs that
    /// run to the next opener byte cannot produce this.
    #[error(
        "kaifuu.reallive.invalid_length_prefix: length-prefixed string at offset {offset} declares len={declared} but only {available} bytes remain"
    )]
    InvalidLengthPrefix {
        offset: u64,
        declared: usize,
        available: usize,
    },
    /// An ExpressionPiece ran past the end of the stream mid-token.
    #[error(
        "kaifuu.reallive.truncated_expression: expression token at offset {offset} ran past end of stream"
    )]
    TruncatedExpression { offset: u64 },
    /// An ExpressionPiece byte did not match any documented token /
    /// operator form (a structurally invalid expression, not merely an
    /// unrecognised opcode).
    #[error(
        "kaifuu.reallive.malformed_expression: invalid ExpressionPiece token at offset {offset}"
    )]
    MalformedExpression { offset: u64, byte: u8 },
}

impl fmt::Debug for RealLiveParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TruncatedBytecode { input_len } => formatter
                .debug_struct("TruncatedBytecode")
                .field("input_len", input_len)
                .finish(),
            Self::TruncatedMetaHeader {
                opener,
                offset,
                needed,
                available,
            } => formatter
                .debug_struct("TruncatedMetaHeader")
                .field("opener", &RedactedContentSummary::from_bytes(&[*opener]))
                .field("offset", offset)
                .field("needed", needed)
                .field("available", available)
                .finish(),
            Self::TruncatedCommandHeader { offset, available } => formatter
                .debug_struct("TruncatedCommandHeader")
                .field("offset", offset)
                .field("available", available)
                .finish(),
            Self::TruncatedCommandArgs { offset, argc } => formatter
                .debug_struct("TruncatedCommandArgs")
                .field("offset", offset)
                .field("argc", argc)
                .finish(),
            Self::InvalidLengthPrefix {
                offset,
                declared,
                available,
            } => formatter
                .debug_struct("InvalidLengthPrefix")
                .field("offset", offset)
                .field("declared", declared)
                .field("available", available)
                .finish(),
            Self::TruncatedExpression { offset } => formatter
                .debug_struct("TruncatedExpression")
                .field("offset", offset)
                .finish(),
            Self::MalformedExpression { offset, byte } => formatter
                .debug_struct("MalformedExpression")
                .field("offset", offset)
                .field("byte", &RedactedContentSummary::from_bytes(&[*byte]))
                .finish(),
        }
    }
}
