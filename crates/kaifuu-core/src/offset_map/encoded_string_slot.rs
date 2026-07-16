use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde::{Deserialize, Serialize};

use crate::{
    OperationStatus, ProtectedSpanMapping, RedactedContentSummary, STRING_SLOT_INVALID_ENCODING,
    STRING_SLOT_OVERFLOW, STRING_SLOT_PROTECTED_SPAN_MUTATION, STRING_SLOT_TERMINATOR_LOSS,
};

use super::{ByteSpan, SourceEncoding};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodedStringSlot {
    pub slot_id: String,
    pub encoding: SourceEncoding,
    pub byte_range: ByteSpan,
    pub layout: EncodedStringSlotLayout,
    #[serde(default)]
    pub protected_spans: Vec<EncodedStringSlotProtectedSpan>,
}

impl EncodedStringSlot {
    pub fn preflight(
        &self,
        target_text: &str,
        protected_span_mappings: &[ProtectedSpanMapping],
        current_slot_bytes: Option<&[u8]>,
    ) -> EncodedStringSlotPreflightReport {
        let mut diagnostics = Vec::new();
        let encoded = match encode_string(target_text, self.encoding) {
            Ok(encoded) => encoded,
            Err(message) => {
                diagnostics.push(self.diagnostic(
                    STRING_SLOT_INVALID_ENCODING,
                    message,
                    "replace_unencodable_character",
                    "replace characters unsupported by the slot encoding before patching",
                ));
                return EncodedStringSlotPreflightReport::from_diagnostics(diagnostics);
            }
        };

        match &self.layout {
            EncodedStringSlotLayout::FixedWidth => {
                if encoded.len() as u64 > self.byte_range.len() {
                    diagnostics.push(self.diagnostic(
                        STRING_SLOT_OVERFLOW,
                        format!(
                            "encoded target is {} byte(s), exceeding fixed-width budget {}",
                            encoded.len(),
                            self.byte_range.len()
                        ),
                        "shorten_translation",
                        "shorten the translation or move it to a wider slot before patching",
                    ));
                }
            }
            EncodedStringSlotLayout::NullTerminated { terminator_hex } => {
                let terminator = match parse_hex_bytes(terminator_hex) {
                    Ok(terminator) if !terminator.is_empty() => terminator,
                    Ok(_) => {
                        diagnostics.push(self.diagnostic(
                            STRING_SLOT_TERMINATOR_LOSS,
                            "null-terminated slot declared an empty terminator",
                            "preserve_terminator",
                            "declare the terminator bytes required by this slot layout",
                        ));
                        Vec::new()
                    }
                    Err(message) => {
                        diagnostics.push(self.diagnostic(
                            STRING_SLOT_TERMINATOR_LOSS,
                            message,
                            "preserve_terminator",
                            "declare a valid hexadecimal terminator for this slot layout",
                        ));
                        Vec::new()
                    }
                };
                if !terminator.is_empty() {
                    if let Some(current_slot_bytes) = current_slot_bytes
                        && !contains_bytes(current_slot_bytes, &terminator)
                    {
                        diagnostics.push(self.diagnostic(
                            STRING_SLOT_TERMINATOR_LOSS,
                            "current slot bytes do not contain the declared terminator",
                            "preserve_terminator",
                            "re-extract the source bytes or repair the slot terminator before patching",
                        ));
                    }
                    if contains_bytes(&encoded, &terminator) {
                        diagnostics.push(self.diagnostic(
                            STRING_SLOT_TERMINATOR_LOSS,
                            "encoded target contains the terminator byte sequence before the slot terminator",
                            "preserve_terminator",
                            "remove embedded terminator bytes from the replacement text",
                        ));
                    }
                    let required_bytes = encoded.len() as u64 + terminator.len() as u64;
                    if required_bytes > self.byte_range.len() {
                        let code = if encoded.len() as u64 <= self.byte_range.len() {
                            STRING_SLOT_TERMINATOR_LOSS
                        } else {
                            STRING_SLOT_OVERFLOW
                        };
                        let remediation_code = if code == STRING_SLOT_TERMINATOR_LOSS {
                            "preserve_terminator"
                        } else {
                            "shorten_translation"
                        };
                        diagnostics.push(self.diagnostic(
                            code,
                            format!(
                                "encoded target plus terminator requires {required_bytes} byte(s), exceeding slot budget {}",
                                self.byte_range.len()
                            ),
                            remediation_code,
                            "shorten the replacement so the encoded text and terminator both fit",
                        ));
                    }
                }
            }
        }

        self.validate_protected_spans(target_text, protected_span_mappings, &mut diagnostics);

        EncodedStringSlotPreflightReport::from_diagnostics(diagnostics)
    }

    /// Multiset protected-token validation.
    /// Source `protected_spans` are grouped by raw token. Each raw is a multiset
    /// entry: N identical source tokens require EXACTLY N distinct valid target
    /// mappings (distinct `(target_start, target_end)` ranges that match
    /// `target_text` and bind source identity when the raw is duplicated) AND
    /// EXACTLY N non-overlapping occurrences of that raw in `target_text`.
    /// Collapsing two source tokens onto one target range, omitting a mapping
    /// for a repeated token, or introducing an EXTRA target occurrence (N+1),
    /// fails loudly with `STRING_SLOT_PROTECTED_SPAN_MUTATION`, the slot id, and
    /// protected-span diagnostics — never a silent pass.
    fn validate_protected_spans(
        &self,
        target_text: &str,
        protected_span_mappings: &[ProtectedSpanMapping],
        diagnostics: &mut Vec<EncodedStringSlotDiagnostic>,
    ) {
        let mut required_spans = BTreeMap::<&str, Vec<&EncodedStringSlotProtectedSpan>>::new();
        for protected_span in &self.protected_spans {
            if !protected_span.raw.is_empty() {
                required_spans
                    .entry(protected_span.raw.as_str())
                    .or_default()
                    .push(protected_span);
            }
        }

        let mut matching_ranges = BTreeMap::<&str, BTreeSet<(u64, u64)>>::new();
        let mut matched_source_identities = BTreeSet::<String>::new();
        for mapping in protected_span_mappings {
            let Some(source_spans) = required_spans.get(mapping.raw.as_str()) else {
                continue;
            };
            if !mapping.matches_target_text(target_text) {
                continue;
            }
            if !protected_span_source_identity_matches(
                mapping,
                source_spans,
                &mut matched_source_identities,
            ) {
                continue;
            }
            matching_ranges
                .entry(mapping.raw.as_str())
                .or_default()
                .insert((mapping.target_start, mapping.target_end));
        }

        for (raw, source_spans) in required_spans {
            let required_count = source_spans.len();
            let mapped_count = matching_ranges.get(raw).map_or(0, BTreeSet::len);
            let actual_count = count_protected_token_occurrences(target_text, raw);
            let raw_summary = RedactedContentSummary::from_text(raw);
            if mapped_count == 0 {
                let message = if required_count > 1 {
                    format!(
                        "protected span {raw_summary} is missing from protectedSpanMappings (expected {required_count} distinct target mapping(s) for repeated source token)"
                    )
                } else {
                    format!("protected span {raw_summary} is missing from protectedSpanMappings")
                };
                diagnostics.push(self.diagnostic(
                    STRING_SLOT_PROTECTED_SPAN_MUTATION,
                    message,
                    "restore_protected_span",
                    "preserve the protected token and include a matching protectedSpanMappings entry",
                ));
                continue;
            }
            // Exact multiplicity: reject under-count (collapsed/missing) AND
            // over-count (extra target occurrence or extra distinct mapping).
            if mapped_count != required_count || actual_count != required_count {
                diagnostics.push(self.diagnostic(
                    STRING_SLOT_PROTECTED_SPAN_MUTATION,
                    format!(
                        "protected span {raw_summary} has {mapped_count} target mapping(s) and {actual_count} target occurrence(s), expected {required_count}"
                    ),
                    "restore_protected_span",
                    "map each duplicate protected token to a distinct targetText byte range and preserve exact multiplicity",
                ));
            }
        }
    }

    fn diagnostic(
        &self,
        code: impl Into<String>,
        message: impl Into<String>,
        remediation_code: impl Into<String>,
        remediation: impl Into<String>,
    ) -> EncodedStringSlotDiagnostic {
        EncodedStringSlotDiagnostic {
            code: code.into(),
            slot_id: self.slot_id.clone(),
            byte_range: self.byte_range,
            message: message.into(),
            remediation_code: remediation_code.into(),
            remediation: remediation.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum EncodedStringSlotLayout {
    #[serde(rename = "fixed_width")]
    FixedWidth,
    #[serde(rename = "null_terminated", rename_all = "camelCase")]
    NullTerminated { terminator_hex: String },
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodedStringSlotProtectedSpan {
    pub raw: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_span_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_start_byte: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_end_byte: Option<u64>,
}

impl fmt::Debug for EncodedStringSlotProtectedSpan {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EncodedStringSlotProtectedSpan")
            .field("raw", &RedactedContentSummary::from_text(&self.raw))
            .field("source_span_id", &self.source_span_id)
            .field("source_start_byte", &self.source_start_byte)
            .field("source_end_byte", &self.source_end_byte)
            .finish()
    }
}

impl EncodedStringSlotProtectedSpan {
    pub fn new(raw: impl Into<String>) -> Self {
        Self {
            raw: raw.into(),
            source_span_id: None,
            source_start_byte: None,
            source_end_byte: None,
        }
    }

    pub fn with_source_identity(
        mut self,
        source_span_id: Option<impl Into<String>>,
        source_start_byte: u64,
        source_end_byte: u64,
    ) -> Self {
        self.source_span_id = source_span_id.map(Into::into);
        self.source_start_byte = Some(source_start_byte);
        self.source_end_byte = Some(source_end_byte);
        self
    }
}

/// Count non-overlapping literal occurrences of `raw` in `target_text`.
/// Empty needles contribute zero (callers already skip empty protected spans).
pub(crate) fn count_protected_token_occurrences(target_text: &str, raw: &str) -> usize {
    if raw.is_empty() {
        return 0;
    }
    target_text.match_indices(raw).count()
}

pub(crate) fn protected_span_source_identity_matches(
    mapping: &ProtectedSpanMapping,
    source_spans: &[&EncodedStringSlotProtectedSpan],
    matched_source_identities: &mut BTreeSet<String>,
) -> bool {
    let duplicate_raw = source_spans.len() > 1;
    if duplicate_raw && !mapping.has_source_identity() {
        return false;
    }

    if !mapping.has_source_identity() {
        return true;
    }

    let Some(source_span) = source_spans.iter().find(|source_span| {
        mapping.matches_source_span(
            &source_span.raw,
            source_span.source_start_byte,
            source_span.source_end_byte,
            source_span.source_span_id.as_deref(),
        )
    }) else {
        return false;
    };

    let Some(source_identity_key) = protected_span_source_identity_key(source_span) else {
        return false;
    };
    matched_source_identities.insert(source_identity_key)
}

fn protected_span_source_identity_key(span: &EncodedStringSlotProtectedSpan) -> Option<String> {
    if let Some(source_span_id) = span.source_span_id.as_deref() {
        return Some(format!(
            "{source_span_id}:{}:{}",
            span.source_start_byte?, span.source_end_byte?
        ));
    }
    Some(format!(
        "{}:{}",
        span.source_start_byte?, span.source_end_byte?
    ))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodedStringSlotPreflightReport {
    pub schema_version: String,
    pub status: OperationStatus,
    pub diagnostics: Vec<EncodedStringSlotDiagnostic>,
}

impl EncodedStringSlotPreflightReport {
    pub fn from_diagnostics(diagnostics: Vec<EncodedStringSlotDiagnostic>) -> Self {
        Self {
            schema_version: "0.1.0".to_string(),
            status: if diagnostics.is_empty() {
                OperationStatus::Passed
            } else {
                OperationStatus::Failed
            },
            diagnostics,
        }
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodedStringSlotDiagnostic {
    pub code: String,
    pub slot_id: String,
    pub byte_range: ByteSpan,
    pub message: String,
    pub remediation_code: String,
    pub remediation: String,
}

impl fmt::Debug for EncodedStringSlotDiagnostic {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EncodedStringSlotDiagnostic")
            .field("code", &self.code)
            .field("slot_id", &self.slot_id)
            .field("byte_range", &self.byte_range)
            .field("message", &RedactedContentSummary::from_text(&self.message))
            .field("remediation_code", &self.remediation_code)
            .field(
                "remediation",
                &RedactedContentSummary::from_text(&self.remediation),
            )
            .finish()
    }
}

pub(crate) fn encode_string(value: &str, encoding: SourceEncoding) -> Result<Vec<u8>, String> {
    match encoding {
        SourceEncoding::Utf8 | SourceEncoding::Binary | SourceEncoding::BinaryTable => {
            Ok(value.as_bytes().to_vec())
        }
        SourceEncoding::ShiftJis => encode_shift_jis(value),
    }
}

/// Encode `value` as Shift-JIS bytes for encoded string-slot preflight.
/// # Shift-JIS codec contract
/// This uses the WHATWG Shift_JIS encoder from `encoding_rs` (the same codec
/// the runtime crates decode/encode with), which is a *complete* Shift-JIS
/// encoder covering the full mappable repertoire: ASCII, halfwidth katakana
/// (JIS X 0201), and every JIS X 0208 double-byte character (common kanji,
/// fullwidth latin/digits, fullwidth punctuation, hiragana, katakana). It
/// supersedes the hand-coded subset, which only mapped ASCII
/// halfwidth katakana, hiragana, katakana, and a handful of punctuation marks
/// and therefore wrongly rejected common kanji and most fullwidth text.
/// The contract is *predictable*: any character in the Shift-JIS repertoire is
/// accepted and encoded to its canonical byte sequence; any character outside
/// it (emoji, rare CJK extension, etc.) is rejected with `Err`. Callers surface
/// that as a typed [`STRING_SLOT_INVALID_ENCODING`] diagnostic naming the slot
/// id and byte range, so there is no silent pass or wrong-size result.
pub(crate) fn encode_shift_jis(value: &str) -> Result<Vec<u8>, String> {
    let (encoded, _encoding, had_unmappable) = encoding_rs::SHIFT_JIS.encode(value);
    if had_unmappable {
        let (char_index, encoded_byte_offset, offending) = locate_first_unmappable_shift_jis(value);
        return Err(format!(
            "character U+{codepoint:04X} at char index {char_index} \
             (encoded byte offset {encoded_byte_offset}) is not representable in Shift-JIS",
            codepoint = offending as u32,
        ));
    }
    Ok(encoded.into_owned())
}

/// Locate the first character the Shift-JIS encoder cannot map, returning its
/// char index, the byte offset it would occupy in the encoded output, and the
/// offending character itself. Used to build a precise reject diagnostic.
fn locate_first_unmappable_shift_jis(value: &str) -> (usize, usize, char) {
    let mut encoded_byte_offset = 0usize;
    for (char_index, character) in value.chars().enumerate() {
        let mut buffer = [0u8; 4];
        let single = character.encode_utf8(&mut buffer);
        let (bytes, _encoding, had_unmappable) = encoding_rs::SHIFT_JIS.encode(single);
        if had_unmappable {
            return (char_index, encoded_byte_offset, character);
        }
        encoded_byte_offset += bytes.len();
    }
    (0, 0, '\u{0}')
}

pub(crate) fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

pub fn parse_hex_bytes(value: &str) -> Result<Vec<u8>, String> {
    let compact = value
        .chars()
        .filter(|character| !character.is_whitespace() && *character != '_')
        .collect::<String>();
    if compact.len() % 2 != 0 {
        return Err("hex byte string must contain an even number of digits".to_string());
    }
    let mut bytes = Vec::with_capacity(compact.len() / 2);
    for pair in compact.as_bytes().chunks_exact(2) {
        let high = hex_nibble(pair[0])
            .ok_or_else(|| "hex byte string contains a non-hex digit".to_string())?;
        let low = hex_nibble(pair[1])
            .ok_or_else(|| "hex byte string contains a non-hex digit".to_string())?;
        bytes.push((high << 4) | low);
    }
    Ok(bytes)
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}
