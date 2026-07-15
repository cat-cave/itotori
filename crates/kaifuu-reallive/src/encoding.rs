//! Shift-JIS decode/encode plus RealLive control-byte slicing.
//! Clean-room provenance
//! - Shift-JIS conversion is performed by `encoding_rs`, the WHATWG-spec
//!   implementation used elsewhere in the Rust ecosystem. No expression is
//!   copied from rlvm or RLDEV.
//! - The control-byte slicing rule (split `StringSlot` bytes around bytes
//!   `< 0x20` so the codec never sees them) is derived from public RLDEV
//!   documentation that catalogues every byte `< 0x20` as a control
//!   directive (color/ruby/wait/etc.). The catalogue lives in
//!   [`crate::protected_spans`].
//!   Surface:
//! - [`decode_shift_jis_slot`] — decodes a `&[u8]` slice as Shift-JIS,
//!   returning the decoded `String`, a `had_replacement` flag, and per-
//!   range diagnostics that flag bytes the decoder could not map.
//! - [`encode_shift_jis_slot`] — encodes a `&str` as Shift-JIS,
//!   returning an error with a byte position if any character is
//!   unmappable.
//! - [`slice_control_bytes`] — segments a byte slice into runs of
//!   text bytes (`>= 0x20`) and individual control bytes (`< 0x20`).
//!   Used by [`crate::protected_spans`] and [`crate::patchback`].

use encoding_rs::SHIFT_JIS;
use std::fmt;

use kaifuu_core::RedactedContentSummary;
use serde::{Deserialize, Serialize};

/// Output of [`decode_shift_jis_slot`].
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftJisDecode {
    pub text: String,
    pub had_replacement: bool,
    pub diagnostics: Vec<ShiftJisDecodeDiagnostic>,
}

impl fmt::Debug for ShiftJisDecode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = RedactedContentSummary::from_text(&self.text);
        formatter
            .debug_struct("ShiftJisDecode")
            .field("text", &text)
            .field("had_replacement", &self.had_replacement)
            .field("diagnostics", &self.diagnostics)
            .finish()
    }
}

/// Per-byte diagnostic emitted when the Shift-JIS decoder substitutes
/// U+FFFD for an unmappable byte sequence. The byte range refers to the
/// input slice, not the decoded `String`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftJisDecodeDiagnostic {
    /// Stable error code carried into the inventory warnings list.
    pub code: String,
    /// Byte offset within the input slice.
    pub byte_offset: u64,
    /// Number of input bytes covered by this diagnostic.
    pub byte_len: u64,
}

/// Error returned by [`encode_shift_jis_slot`].
#[derive(Clone, PartialEq, Eq)]
pub struct ShiftJisEncodeError {
    /// 0-based char index of the first character the encoder could not map.
    pub first_unmappable_char_index: usize,
    /// Lossy-encoded bytes (the substitute bytes used by `encoding_rs` for
    /// the unmappable characters). Preserved here for diagnostics only —
    /// patch-back rejects edits that yield this error.
    pub partial_bytes: Vec<u8>,
    pub message: String,
}

impl fmt::Debug for ShiftJisEncodeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let partial_bytes = RedactedContentSummary::from_bytes(&self.partial_bytes);
        formatter
            .debug_struct("ShiftJisEncodeError")
            .field(
                "first_unmappable_char_index",
                &self.first_unmappable_char_index,
            )
            .field("partial_bytes", &partial_bytes)
            .field("message", &self.message)
            .finish()
    }
}

impl std::fmt::Display for ShiftJisEncodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ShiftJisEncodeError {}

/// Stable diagnostic code emitted by [`decode_shift_jis_slot`] when the
/// decoder substitutes U+FFFD.
pub const SHIFT_JIS_DECODE_FAILURE_CODE: &str = "kaifuu.reallive.shift_jis_decode_failure";

/// Decode a Shift-JIS byte slice.
/// Control bytes (`< 0x20`) are decoded by `encoding_rs` to their
/// equivalent C0 control characters; patch-back never re-encodes them
/// (see [`slice_control_bytes`] for the splitting rule used at the
/// inventory layer).
pub fn decode_shift_jis_slot(bytes: &[u8]) -> ShiftJisDecode {
    let (cow, had_replacement) = SHIFT_JIS.decode_without_bom_handling(bytes);
    let text = cow.into_owned();
    let mut diagnostics = Vec::new();
    if had_replacement {
        // encoding_rs does not surface per-byte positions for replacement
        // bytes; emit a single coarse-range diagnostic covering the slot.
        diagnostics.push(ShiftJisDecodeDiagnostic {
            code: SHIFT_JIS_DECODE_FAILURE_CODE.to_string(),
            byte_offset: 0,
            byte_len: bytes.len() as u64,
        });
    }
    ShiftJisDecode {
        text,
        had_replacement,
        diagnostics,
    }
}

/// Encode a string as Shift-JIS bytes. Returns `Err` if any character is
/// unmappable (Patch-back routes this into a
/// `kaifuu.reallive.patchback_shift_jis_encode_failure` Fatal).
pub fn encode_shift_jis_slot(text: &str) -> Result<Vec<u8>, ShiftJisEncodeError> {
    let (cow, _encoding, had_unmappable) = SHIFT_JIS.encode(text);
    if had_unmappable {
        // Locate the first character that `encoding_rs` would substitute.
        let first_unmappable_char_index = locate_first_unmappable_char(text);
        return Err(ShiftJisEncodeError {
            first_unmappable_char_index,
            partial_bytes: cow.into_owned(),
            message: format!(
                "character at char index {first_unmappable_char_index} is not representable \
                 in Shift-JIS; encoder reported had_unmappable_characters"
            ),
        });
    }
    Ok(cow.into_owned())
}

fn locate_first_unmappable_char(text: &str) -> usize {
    for (index, ch) in text.chars().enumerate() {
        let mut probe = [0u8; 4];
        let probe = ch.encode_utf8(&mut probe);
        let (_, _, had_unmappable) = SHIFT_JIS.encode(probe);
        if had_unmappable {
            return index;
        }
    }
    0
}

/// One segment produced by [`slice_control_bytes`].
#[derive(Clone, PartialEq, Eq)]
pub enum SliceSegment<'a> {
    /// A run of "text bytes" (every byte `>= 0x20`).
    Text {
        /// Byte offset within the input slice.
        byte_offset: usize,
        bytes: &'a [u8],
    },
    /// A single control byte (`< 0x20`).
    Control {
        /// Byte offset within the input slice.
        byte_offset: usize,
        byte: u8,
    },
}

impl fmt::Debug for SliceSegment<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Text { byte_offset, bytes } => {
                let bytes = RedactedContentSummary::from_bytes(bytes);
                formatter
                    .debug_struct("SliceSegment::Text")
                    .field("byte_offset", byte_offset)
                    .field("bytes", &bytes)
                    .finish()
            }
            Self::Control { byte_offset, .. } => formatter
                .debug_struct("SliceSegment::Control")
                .field("byte_offset", byte_offset)
                .finish(),
        }
    }
}

/// Split a byte slice into alternating text and control-byte segments.
/// The output preserves byte-for-byte coverage of the input: concatenating
/// segments in order reproduces the input. Used by
/// [`crate::protected_spans::detect_protected_spans`] and
/// [`crate::patchback`] so the Shift-JIS codec never sees a control byte.
pub fn slice_control_bytes(bytes: &[u8]) -> Vec<SliceSegment<'_>> {
    let mut segments = Vec::new();
    let mut cursor = 0;
    while cursor < bytes.len() {
        if bytes[cursor] < 0x20 {
            segments.push(SliceSegment::Control {
                byte_offset: cursor,
                byte: bytes[cursor],
            });
            cursor += 1;
            continue;
        }
        let start = cursor;
        while cursor < bytes.len() && bytes[cursor] >= 0x20 {
            cursor += 1;
        }
        segments.push(SliceSegment::Text {
            byte_offset: start,
            bytes: &bytes[start..cursor],
        });
    }
    segments
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_ascii_text_without_replacement() {
        let decode = decode_shift_jis_slot(b"Aoi");
        assert_eq!(decode.text, "Aoi");
        assert!(!decode.had_replacement);
        assert!(decode.diagnostics.is_empty());
    }

    #[test]
    fn decodes_shift_jis_hiragana_correctly() {
        // Shift-JIS encoding of "あ" is 0x82 0xa0.
        let decode = decode_shift_jis_slot(&[0x82, 0xa0]);
        assert_eq!(decode.text, "あ");
        assert!(!decode.had_replacement);
    }

    #[test]
    fn emits_shift_jis_decode_failure_diagnostic_for_invalid_lead_byte() {
        // 0xFD is in the Shift-JIS undefined range and triggers a
        // replacement on encoding_rs.
        let decode = decode_shift_jis_slot(&[0xFD]);
        assert!(decode.had_replacement);
        assert_eq!(decode.diagnostics.len(), 1);
        assert_eq!(decode.diagnostics[0].code, SHIFT_JIS_DECODE_FAILURE_CODE);
    }

    #[test]
    fn encodes_ascii_round_trip() {
        let bytes = encode_shift_jis_slot("Hello!").expect("ASCII must encode");
        assert_eq!(bytes, b"Hello!");
    }

    #[test]
    fn encodes_hiragana_to_shift_jis_byte_pair() {
        let bytes = encode_shift_jis_slot("あ").expect("hiragana must encode");
        assert_eq!(bytes, &[0x82, 0xa0]);
    }

    #[test]
    fn encode_rejects_character_outside_shift_jis_with_position() {
        // Emoji is well outside JIS X 0208 — encoding_rs reports
        // had_unmappable.
        let err = encode_shift_jis_slot("a😀b").expect_err("emoji must fail");
        assert_eq!(err.first_unmappable_char_index, 1);
    }

    #[test]
    fn slices_control_bytes_into_text_and_control_segments() {
        // "Hi" + 0x0a (line break) + "Bye"
        let bytes = b"Hi\nBye";
        let segments = slice_control_bytes(bytes);
        assert_eq!(segments.len(), 3);
        match &segments[0] {
            SliceSegment::Text { byte_offset, bytes } => {
                assert_eq!(*byte_offset, 0);
                assert_eq!(*bytes, b"Hi");
            }
            SliceSegment::Control { .. } => panic!("expected text segment, got a control segment"),
        }
        match &segments[1] {
            SliceSegment::Control { byte_offset, byte } => {
                assert_eq!(*byte_offset, 2);
                assert_eq!(*byte, 0x0a);
            }
            SliceSegment::Text { .. } => panic!("expected control segment, got a text segment"),
        }
        match &segments[2] {
            SliceSegment::Text { byte_offset, bytes } => {
                assert_eq!(*byte_offset, 3);
                assert_eq!(*bytes, b"Bye");
            }
            SliceSegment::Control { .. } => panic!("expected text segment, got a control segment"),
        }
    }

    #[test]
    fn slices_preserve_byte_for_byte_coverage() {
        let bytes = &[b'a', 0x1f, 0x02, b'b', b'c', 0x0a][..];
        let segments = slice_control_bytes(bytes);
        let mut total_len = 0;
        for segment in &segments {
            match segment {
                SliceSegment::Text { bytes, .. } => total_len += bytes.len(),
                SliceSegment::Control { .. } => total_len += 1,
            }
        }
        assert_eq!(total_len, bytes.len());
    }
}
