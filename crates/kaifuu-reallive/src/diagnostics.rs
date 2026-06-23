//! Semantic diagnostic codes for the KAIFUU-173 parser.
//!
//! Diagnostics are a parser-local namespace (`kaifuu.reallive.*`) so the
//! parser can be called from multiple sites with different error-routing
//! needs. The mapping to `kaifuu_core::SemanticErrorCode` is documented
//! below and exists as `pub const` strings so KAIFUU-174 (the adapter
//! that will call this crate) can hard-code the contract.

use kaifuu_core::SemanticErrorCode;
use serde::{Deserialize, Serialize};

use crate::ast::DiagnosticSeverity;

/// Stable parser-local diagnostic code namespace.
pub const SEMANTIC_REALLIVE_INVALID_ARCHIVE_ENVELOPE: &str =
    "kaifuu.reallive.invalid_archive_envelope";
pub const SEMANTIC_REALLIVE_TRUNCATED_SCENE: &str = "kaifuu.reallive.truncated_scene";
pub const SEMANTIC_REALLIVE_TRUNCATED_INSTRUCTION: &str = "kaifuu.reallive.truncated_instruction";
pub const SEMANTIC_REALLIVE_UNRECOGNIZED_INSTRUCTION: &str =
    "kaifuu.reallive.unrecognized_instruction";
pub const SEMANTIC_REALLIVE_UNRECOGNIZED_OPERAND_SHAPE: &str =
    "kaifuu.reallive.unrecognized_operand_shape";
pub const SEMANTIC_REALLIVE_INVALID_STRING_SLOT: &str = "kaifuu.reallive.invalid_string_slot";
pub const SEMANTIC_REALLIVE_OUT_OF_PROFILE_INPUT: &str = "kaifuu.reallive.out_of_profile_input";

/// Stable diagnostic envelope. Carries the byte position of the offending
/// span so callers can surface it in audit reports without re-parsing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseDiagnostic {
    pub code: ParseDiagnosticCode,
    pub severity: DiagnosticSeverity,
    /// Offset within the scene blob, or within the archive for envelope
    /// diagnostics.
    pub byte_offset: u64,
    /// Covered byte run if known.
    pub byte_len: Option<u64>,
    /// Up to first 16 bytes of the offending span as uppercase hex.
    pub raw_bytes_hex: Option<String>,
    pub message: String,
    pub remediation: Option<String>,
}

impl ParseDiagnostic {
    pub(crate) fn warning(
        code: ParseDiagnosticCode,
        byte_offset: u64,
        byte_len: Option<u64>,
        raw_bytes_hex: Option<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            code,
            severity: DiagnosticSeverity::Warning,
            byte_offset,
            byte_len,
            raw_bytes_hex,
            message: message.into(),
            remediation: None,
        }
    }

    pub(crate) fn fatal(
        code: ParseDiagnosticCode,
        byte_offset: u64,
        byte_len: Option<u64>,
        raw_bytes_hex: Option<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            code,
            severity: DiagnosticSeverity::Fatal,
            byte_offset,
            byte_len,
            raw_bytes_hex,
            message: message.into(),
            remediation: None,
        }
    }

    pub(crate) fn with_remediation(mut self, remediation: impl Into<String>) -> Self {
        self.remediation = Some(remediation.into());
        self
    }
}

/// Stable enum of parser-local diagnostic codes. The serde representation
/// matches the `kaifuu.reallive.*` string namespace.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum ParseDiagnosticCode {
    #[serde(rename = "kaifuu.reallive.invalid_archive_envelope")]
    InvalidArchiveEnvelope,
    #[serde(rename = "kaifuu.reallive.truncated_scene")]
    TruncatedScene,
    #[serde(rename = "kaifuu.reallive.truncated_instruction")]
    TruncatedInstruction,
    #[serde(rename = "kaifuu.reallive.unrecognized_instruction")]
    UnrecognizedInstruction,
    #[serde(rename = "kaifuu.reallive.unrecognized_operand_shape")]
    UnrecognizedOperandShape,
    #[serde(rename = "kaifuu.reallive.invalid_string_slot")]
    InvalidStringSlot,
    #[serde(rename = "kaifuu.reallive.out_of_profile_input")]
    OutOfProfileInput,
}

impl ParseDiagnosticCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidArchiveEnvelope => SEMANTIC_REALLIVE_INVALID_ARCHIVE_ENVELOPE,
            Self::TruncatedScene => SEMANTIC_REALLIVE_TRUNCATED_SCENE,
            Self::TruncatedInstruction => SEMANTIC_REALLIVE_TRUNCATED_INSTRUCTION,
            Self::UnrecognizedInstruction => SEMANTIC_REALLIVE_UNRECOGNIZED_INSTRUCTION,
            Self::UnrecognizedOperandShape => SEMANTIC_REALLIVE_UNRECOGNIZED_OPERAND_SHAPE,
            Self::InvalidStringSlot => SEMANTIC_REALLIVE_INVALID_STRING_SLOT,
            Self::OutOfProfileInput => SEMANTIC_REALLIVE_OUT_OF_PROFILE_INPUT,
        }
    }
}

impl std::fmt::Display for ParseDiagnosticCode {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Mapping rule used by the (future) KAIFUU-174 text-inventory adapter to
/// route parser diagnostics into the `kaifuu_core::SemanticErrorCode`
/// namespace at the adapter boundary. Recoverable diagnostics return
/// `None` (they surface in the inventory output, not the adapter error
/// surface).
pub fn semantic_error_code_for_parser_diagnostic(
    code: ParseDiagnosticCode,
) -> Option<SemanticErrorCode> {
    match code {
        ParseDiagnosticCode::InvalidArchiveEnvelope => {
            Some(SemanticErrorCode::UnknownEngineVariant)
        }
        ParseDiagnosticCode::TruncatedScene => Some(SemanticErrorCode::UnknownEngineVariant),
        ParseDiagnosticCode::TruncatedInstruction => {
            Some(SemanticErrorCode::UnsupportedLayeredTransform)
        }
        ParseDiagnosticCode::UnrecognizedInstruction => None,
        ParseDiagnosticCode::UnrecognizedOperandShape => None,
        ParseDiagnosticCode::InvalidStringSlot => {
            Some(SemanticErrorCode::UnsupportedLayeredTransform)
        }
        ParseDiagnosticCode::OutOfProfileInput => Some(SemanticErrorCode::UnsupportedEngineVariant),
    }
}
