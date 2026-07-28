//! RealLive protected-span detector.
//! Clean-room provenance
//! - The bounded catalogue of control-code shapes (color, ruby, name
//!   placeholder, choice token, text size, wait, clear, line break,
//!   variable placeholder) is derived from publicly archived Haeleth
//!   RLDEV documentation (`https://dev.haeleth.net/rldev.shtml`). No
//!   structure layout is copied from rlvm or RLDEV source.
//! - Any control byte (`< 0x20`) not in the catalogue surfaces as an
//!   `unknown_control` warning and is preserved byte-for-byte in the
//!   bridge schema and through patch-back. No silent skip is permitted.
//!   Surface:
//! - [`ProtectedSpanKind`] — bounded enum of the nine documented kinds
//!   plus the `UnknownControl` catch-all.
//! - [`detect_protected_spans`] — walks raw Shift-JIS bytes plus the
//!   decoded text and emits a list of [`RealLiveProtectedSpan`] (each
//!   carrying `(kind, raw_bytes, raw_string, decoded_start, decoded_end)`)
//!   plus any warnings.

use std::fmt;

use kaifuu_core::RedactedContentSummary;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Stable error code emitted when a protected-span decoded byte range does
/// not line up with the decoded text's char boundaries (or runs past its
/// end). Surfaced instead of a `str` index panic.
pub const PROTECTED_SPAN_DECODED_RANGE_CODE: &str =
    "kaifuu.reallive.protected_span.decoded_range_not_char_boundary";

/// Error returned by [`detect_protected_spans`].
/// Protected-span detection aligns raw Shift-JIS byte offsets to byte
/// offsets inside the *decoded* text by decoding successive prefixes of the
/// raw bytes (see [`decoded_byte_offset_for_raw_offset`]). That alignment
/// assumes the byte length of a decoded prefix equals the byte position of
/// the same boundary inside the whole-slot decode — an invariant that does
/// **not** hold for lossy/replacement Shift-JIS across a split double-byte
/// pair. When it is violated, the computed decoded range can land inside a
/// multi-byte char (or past the end of the decoded text); rather than panic
/// on `decoded_text[a..b]`, detection returns this typed error so the
/// inventory walk can record it and continue.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ProtectedSpanError {
    /// A decoded byte range `[start, end)` is not a valid slice of the
    /// decoded text (a bound is not on a char boundary, or is out of range,
    /// or `start > end`).
    #[error(
        "protected-span decoded byte range {start}..{end} is not a valid char-boundary slice \
         of decoded text of byte length {decoded_len}"
    )]
    DecodedRangeNotCharBoundary {
        start: usize,
        end: usize,
        decoded_len: usize,
    },
}

/// Char-boundary- and range-checked slice of the decoded text.
/// Returns [`ProtectedSpanError::DecodedRangeNotCharBoundary`] (never
/// panics) when `[start, end)` is reversed, out of range, or lands inside a
/// multi-byte char.
fn decoded_slice(
    decoded_text: &str,
    start: usize,
    end: usize,
) -> Result<String, ProtectedSpanError> {
    let decoded_len = decoded_text.len();
    if start > end
        || end > decoded_len
        || !decoded_text.is_char_boundary(start)
        || !decoded_text.is_char_boundary(end)
    {
        return Err(ProtectedSpanError::DecodedRangeNotCharBoundary {
            start,
            end,
            decoded_len,
        });
    }
    Ok(decoded_text[start..end].to_string())
}

/// Bounded RealLive protected-span catalogue.
/// The serde label (snake_case) is used verbatim as the
/// `ProtectedSpan.parsed_name` for `control_markup` spans, or as the
/// `variable_name` shape on `variable_placeholder` spans.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProtectedSpanKind {
    ColorCode { color_index: u8 },
    Ruby { base: String, ruby: String },
    NamePlaceholder { index: String },
    ChoiceToken { choice_index: u8 },
    TextSizeDirective { size_byte: u8 },
    WaitDirective { frames_byte: u8 },
    ClearTextBox,
    LineBreak,
    VariablePlaceholder { name: String },
    UnknownControl { byte: u8 },
}

impl fmt::Debug for ProtectedSpanKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ColorCode { color_index } => formatter
                .debug_struct("ColorCode")
                .field("color_index", color_index)
                .finish(),
            Self::Ruby { base, ruby } => formatter
                .debug_struct("Ruby")
                .field("base", &RedactedContentSummary::from_text(base))
                .field("ruby", &RedactedContentSummary::from_text(ruby))
                .finish(),
            Self::NamePlaceholder { index } => formatter
                .debug_struct("NamePlaceholder")
                .field("index", &RedactedContentSummary::from_text(index))
                .finish(),
            Self::ChoiceToken { choice_index } => formatter
                .debug_struct("ChoiceToken")
                .field("choice_index", choice_index)
                .finish(),
            Self::TextSizeDirective { size_byte } => formatter
                .debug_struct("TextSizeDirective")
                .field("size_byte", size_byte)
                .finish(),
            Self::WaitDirective { frames_byte } => formatter
                .debug_struct("WaitDirective")
                .field("frames_byte", frames_byte)
                .finish(),
            Self::ClearTextBox => formatter.write_str("ClearTextBox"),
            Self::LineBreak => formatter.write_str("LineBreak"),
            Self::VariablePlaceholder { name } => formatter
                .debug_struct("VariablePlaceholder")
                .field("name", &RedactedContentSummary::from_text(name))
                .finish(),
            Self::UnknownControl { byte } => formatter
                .debug_struct("UnknownControl")
                .field("byte", &RedactedContentSummary::from_bytes(&[*byte]))
                .finish(),
        }
    }
}

impl ProtectedSpanKind {
    pub fn label(&self) -> &'static str {
        match self {
            Self::ColorCode { .. } => "color_code",
            Self::Ruby { .. } => "ruby",
            Self::NamePlaceholder { .. } => "name_placeholder",
            Self::ChoiceToken { .. } => "choice_token",
            Self::TextSizeDirective { .. } => "text_size_directive",
            Self::WaitDirective { .. } => "wait_directive",
            Self::ClearTextBox => "clear_text_box",
            Self::LineBreak => "line_break",
            Self::VariablePlaceholder { .. } => "variable_placeholder",
            Self::UnknownControl { .. } => "unknown_control",
        }
    }
}

/// Stable warning code emitted for unknown control bytes.
pub const PROTECTED_SPAN_UNKNOWN_CONTROL_CODE: &str =
    "kaifuu.reallive.protected_span.unknown_control";

/// One detected protected span.
/// `byte_range` covers the raw bytes within the source slot (Shift-JIS
/// bytes including the control byte); `decoded_range` covers the
/// equivalent characters within the decoded `String`. Patch-back uses
/// `byte_range`; the bridge schema uses `decoded_range`.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealLiveProtectedSpan {
    pub kind: ProtectedSpanKind,
    /// Verbatim raw bytes for the span (uppercase hex).
    pub raw_bytes_hex: String,
    /// Decoded-text representation that appears in the source text (may be
    /// empty for bare control bytes like `0x0c`).
    pub raw_text: String,
    /// Byte range within the source slot (raw bytes).
    pub byte_range_start: u64,
    pub byte_range_end: u64,
    /// Byte range within the decoded `String`.
    pub decoded_range_start: u64,
    pub decoded_range_end: u64,
}

impl fmt::Debug for RealLiveProtectedSpan {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let raw_bytes_hex = RedactedContentSummary::from_text(&self.raw_bytes_hex);
        let raw_text = RedactedContentSummary::from_text(&self.raw_text);
        formatter
            .debug_struct("RealLiveProtectedSpan")
            .field("kind", &self.kind)
            .field("raw_bytes_hex", &raw_bytes_hex)
            .field("raw_text", &raw_text)
            .field("byte_range_start", &self.byte_range_start)
            .field("byte_range_end", &self.byte_range_end)
            .field("decoded_range_start", &self.decoded_range_start)
            .field("decoded_range_end", &self.decoded_range_end)
            .finish()
    }
}

/// Warning emitted during protected-span detection.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectedSpanWarning {
    pub code: String,
    pub message: String,
    pub byte_offset: u64,
    pub byte_len: u64,
}

impl fmt::Debug for ProtectedSpanWarning {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = RedactedContentSummary::from_text(&self.message);
        formatter
            .debug_struct("ProtectedSpanWarning")
            .field("code", &self.code)
            .field("message", &message)
            .field("byte_offset", &self.byte_offset)
            .field("byte_len", &self.byte_len)
            .finish()
    }
}

/// Detection output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectedSpanReport {
    pub spans: Vec<RealLiveProtectedSpan>,
    pub warnings: Vec<ProtectedSpanWarning>,
}

mod detector;
pub use detector::detect_protected_spans;

#[cfg(test)]
#[path = "protected_spans_tests.rs"]
mod tests;
