use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    OperationStatus, ProtectedSpanMapping, STRING_RELOCATION_INVALID_SOURCE_BYTES,
    STRING_RELOCATION_OVERLAPPING_WRITES, STRING_RELOCATION_POINTER_PROVENANCE_MISMATCH,
    STRING_RELOCATION_UNRESOLVED_REFERENCE, STRING_RELOCATION_UNSUPPORTED_POINTER_FORMAT,
    STRING_SLOT_INVALID_ENCODING, STRING_SLOT_OVERFLOW, STRING_SLOT_PROTECTED_SPAN_MUTATION,
    STRING_SLOT_TERMINATOR_LOSS, content_hash,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ByteSpan {
    start: u64,
    end: u64,
}

impl ByteSpan {
    pub fn new(start: u64, end: u64) -> Result<Self, OffsetMapError> {
        if end < start {
            return Err(OffsetMapError::from_diagnostic(OffsetMapDiagnostic::new(
                "kaifuu.invalid_offset",
                "span.end",
                format!("span end {end} must be greater than or equal to start {start}"),
            )));
        }
        Ok(Self { start, end })
    }

    pub fn non_empty(start: u64, end: u64) -> Result<Self, OffsetMapError> {
        let span = Self::new(start, end)?;
        if span.is_empty() {
            return Err(OffsetMapError::from_diagnostic(OffsetMapDiagnostic::new(
                "kaifuu.invalid_offset",
                "span",
                "span must not be empty",
            )));
        }
        Ok(span)
    }

    pub fn len(self) -> u64 {
        self.end - self.start
    }

    pub fn start(self) -> u64 {
        self.start
    }

    pub fn end(self) -> u64 {
        self.end
    }

    pub fn is_empty(self) -> bool {
        self.start == self.end
    }

    pub fn contains(self, offset: u64) -> bool {
        self.start <= offset && offset < self.end
    }

    pub fn contains_span(self, span: Self) -> bool {
        self.start <= span.start && span.end <= self.end
    }

    pub fn overlaps(self, other: Self) -> bool {
        self.start < other.end && other.start < self.end
    }
}

impl Serialize for ByteSpan {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut state = serializer.serialize_struct("ByteSpan", 2)?;
        state.serialize_field("start", &self.start)?;
        state.serialize_field("end", &self.end)?;
        state.end()
    }
}

impl<'de> Deserialize<'de> for ByteSpan {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct RawByteSpan {
            start: u64,
            end: u64,
        }

        let raw = RawByteSpan::deserialize(deserializer)?;
        Self::new(raw.start, raw.end).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SourceEncoding {
    Utf8,
    ShiftJis,
    BinaryTable,
    Binary,
}

impl SourceEncoding {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Utf8 => "utf_8",
            Self::ShiftJis => "shift_jis",
            Self::BinaryTable => "binary_table",
            Self::Binary => "binary",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "utf_8" | "utf8" | "utf-8" => Some(Self::Utf8),
            "shift_jis" | "shift-jis" | "sjis" => Some(Self::ShiftJis),
            "binary_table" | "binary-table" => Some(Self::BinaryTable),
            "binary" => Some(Self::Binary),
            _ => None,
        }
    }
}

impl Serialize for SourceEncoding {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for SourceEncoding {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value)
            .ok_or_else(|| serde::de::Error::custom(format!("encoding {value} is not supported")))
    }
}

impl fmt::Display for SourceEncoding {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SourceFileId(String);

impl SourceFileId {
    pub fn new(value: impl Into<String>) -> Result<Self, OffsetMapError> {
        let value = value.into();
        validate_identifier_value("sourceFileId", &value)?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SourceFileId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("SourceFileId")
            .field(&self.0)
            .finish()
    }
}

impl Serialize for SourceFileId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for SourceFileId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SourceRevisionId(String);

impl SourceRevisionId {
    pub fn new(value: impl Into<String>) -> Result<Self, OffsetMapError> {
        let value = value.into();
        validate_identifier_value("sourceRevisionId", &value)?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SourceRevisionId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("SourceRevisionId")
            .field(&self.0)
            .finish()
    }
}

impl Serialize for SourceRevisionId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for SourceRevisionId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRange {
    source_file_id: SourceFileId,
    source_revision_id: SourceRevisionId,
    encoding: SourceEncoding,
    bytes: ByteSpan,
}

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

    /// Multiset protected-token validation (KAIFUU-150).
    ///
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
            if mapped_count == 0 {
                let message = if required_count > 1 {
                    format!(
                        "protected span {raw:?} is missing from protectedSpanMappings (expected {required_count} distinct target mapping(s) for repeated source token)"
                    )
                } else {
                    format!("protected span {raw:?} is missing from protectedSpanMappings")
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
                        "protected span {raw:?} has {mapped_count} target mapping(s) and {actual_count} target occurrence(s), expected {required_count}"
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
fn count_protected_token_occurrences(target_text: &str, raw: &str) -> usize {
    if raw.is_empty() {
        return 0;
    }
    target_text.match_indices(raw).count()
}

fn protected_span_source_identity_matches(
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodedStringSlotDiagnostic {
    pub code: String,
    pub slot_id: String,
    pub byte_range: ByteSpan,
    pub message: String,
    pub remediation_code: String,
    pub remediation: String,
}

impl SourceRange {
    pub fn new(
        source_file_id: impl Into<String>,
        source_revision_id: impl Into<String>,
        encoding: SourceEncoding,
        bytes: ByteSpan,
    ) -> Result<Self, OffsetMapError> {
        Ok(Self {
            source_file_id: SourceFileId::new(source_file_id)?,
            source_revision_id: SourceRevisionId::new(source_revision_id)?,
            encoding,
            bytes,
        })
    }

    pub fn source_file_id(&self) -> &SourceFileId {
        &self.source_file_id
    }

    pub fn source_revision_id(&self) -> &SourceRevisionId {
        &self.source_revision_id
    }

    pub fn encoding(&self) -> SourceEncoding {
        self.encoding
    }

    pub fn bytes(&self) -> ByteSpan {
        self.bytes
    }

    pub fn validate_against(&self, offset_map: &OffsetMap) -> OffsetMapValidationResult {
        let mut diagnostics = Vec::new();
        if self.source_file_id != offset_map.source_file_id {
            diagnostics.push(OffsetMapDiagnostic::new(
                "kaifuu.source_identity_mismatch",
                "sourceFileId",
                "source range file id does not match offset map sourceFileId",
            ));
        }
        if self.source_revision_id != offset_map.source_revision_id {
            diagnostics.push(OffsetMapDiagnostic::new(
                "kaifuu.source_identity_mismatch",
                "sourceRevisionId",
                "source range revision id does not match offset map sourceRevisionId",
            ));
        }
        if self.encoding != offset_map.encoding {
            diagnostics.push(OffsetMapDiagnostic::new(
                "kaifuu.source_identity_mismatch",
                "encoding",
                "source range encoding does not match offset map encoding",
            ));
        }
        if self.bytes.end > offset_map.source_length {
            diagnostics.push(OffsetMapDiagnostic::new(
                "kaifuu.out_of_range_source_range",
                "bytes",
                format!(
                    "source range {}..{} exceeds source length {}",
                    self.bytes.start, self.bytes.end, offset_map.source_length
                ),
            ));
        }
        OffsetMapValidationResult::from_diagnostics(diagnostics)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OffsetMapSegment {
    source_bytes: ByteSpan,
    decoded_text: ByteSpan,
    patched_bytes: ByteSpan,
}

impl OffsetMapSegment {
    pub fn new(
        source_bytes: ByteSpan,
        decoded_text: ByteSpan,
        patched_bytes: ByteSpan,
    ) -> Result<Self, OffsetMapError> {
        let mut diagnostics = Vec::new();
        validate_segment_axes_attached(
            &mut diagnostics,
            "segment",
            source_bytes,
            decoded_text,
            patched_bytes,
        );
        if !diagnostics.is_empty() {
            return Err(OffsetMapError { diagnostics });
        }
        Ok(Self::new_unchecked(
            source_bytes,
            decoded_text,
            patched_bytes,
        ))
    }

    fn new_unchecked(
        source_bytes: ByteSpan,
        decoded_text: ByteSpan,
        patched_bytes: ByteSpan,
    ) -> Self {
        Self {
            source_bytes,
            decoded_text,
            patched_bytes,
        }
    }

    pub fn source_bytes(&self) -> ByteSpan {
        self.source_bytes
    }

    pub fn decoded_text(&self) -> ByteSpan {
        self.decoded_text
    }

    pub fn patched_bytes(&self) -> ByteSpan {
        self.patched_bytes
    }
}

impl<'de> Deserialize<'de> for OffsetMapSegment {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct RawOffsetMapSegment {
            source_bytes: ByteSpan,
            decoded_text: ByteSpan,
            patched_bytes: ByteSpan,
        }

        let raw = RawOffsetMapSegment::deserialize(deserializer)?;
        Self::new(raw.source_bytes, raw.decoded_text, raw.patched_bytes)
            .map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OffsetMap {
    source_file_id: SourceFileId,
    source_revision_id: SourceRevisionId,
    encoding: SourceEncoding,
    source_length: u64,
    decoded_text_length: u64,
    patched_length: u64,
    segments: Vec<OffsetMapSegment>,
}

impl OffsetMap {
    pub fn new(
        source_file_id: impl Into<String>,
        source_revision_id: impl Into<String>,
        encoding: SourceEncoding,
        source_length: u64,
        decoded_text_length: u64,
        patched_length: u64,
        segments: Vec<OffsetMapSegment>,
    ) -> Result<Self, OffsetMapError> {
        Self::from_validated_parts(
            SourceFileId::new(source_file_id)?,
            SourceRevisionId::new(source_revision_id)?,
            encoding,
            source_length,
            decoded_text_length,
            patched_length,
            segments,
        )
    }

    fn from_validated_parts(
        source_file_id: SourceFileId,
        source_revision_id: SourceRevisionId,
        encoding: SourceEncoding,
        source_length: u64,
        decoded_text_length: u64,
        patched_length: u64,
        segments: Vec<OffsetMapSegment>,
    ) -> Result<Self, OffsetMapError> {
        let offset_map = Self {
            source_file_id,
            source_revision_id,
            encoding,
            source_length,
            decoded_text_length,
            patched_length,
            segments,
        };
        offset_map.validate().into_result()?;
        Ok(offset_map)
    }

    pub fn source_file_id(&self) -> &SourceFileId {
        &self.source_file_id
    }

    pub fn source_revision_id(&self) -> &SourceRevisionId {
        &self.source_revision_id
    }

    pub fn encoding(&self) -> SourceEncoding {
        self.encoding
    }

    pub fn source_length(&self) -> u64 {
        self.source_length
    }

    pub fn decoded_text_length(&self) -> u64 {
        self.decoded_text_length
    }

    pub fn patched_length(&self) -> u64 {
        self.patched_length
    }

    pub fn segments(&self) -> &[OffsetMapSegment] {
        &self.segments
    }

    pub fn validate(&self) -> OffsetMapValidationResult {
        let mut diagnostics = Vec::new();
        if self.segments.is_empty() {
            diagnostics.push(OffsetMapDiagnostic::new(
                "kaifuu.missing_offset_segments",
                "segments",
                "offset map must include at least one segment",
            ));
        }

        for (index, segment) in self.segments.iter().enumerate() {
            validate_segment_axes_attached(
                &mut diagnostics,
                format!("segments[{index}]"),
                segment.source_bytes,
                segment.decoded_text,
                segment.patched_bytes,
            );
            validate_segment_span(
                &mut diagnostics,
                index,
                "sourceBytes",
                segment.source_bytes,
                self.source_length,
                "kaifuu.out_of_range_source_range",
            );
            validate_segment_span(
                &mut diagnostics,
                index,
                "decodedText",
                segment.decoded_text,
                self.decoded_text_length,
                "kaifuu.out_of_range_decoded_text_range",
            );
            validate_segment_span(
                &mut diagnostics,
                index,
                "patchedBytes",
                segment.patched_bytes,
                self.patched_length,
                "kaifuu.out_of_range_patched_range",
            );
        }
        validate_non_overlapping_axis(&mut diagnostics, &self.segments, Axis::Source);
        validate_non_overlapping_axis(&mut diagnostics, &self.segments, Axis::Decoded);
        validate_non_overlapping_axis(&mut diagnostics, &self.segments, Axis::Patched);

        OffsetMapValidationResult::from_diagnostics(diagnostics)
    }

    pub fn source_to_decoded(&self, span: ByteSpan) -> Result<ByteSpan, OffsetMapError> {
        self.translate(span, Axis::Source, Axis::Decoded)
    }

    pub fn source_to_patched(&self, span: ByteSpan) -> Result<ByteSpan, OffsetMapError> {
        self.translate(span, Axis::Source, Axis::Patched)
    }

    pub fn decoded_to_source(&self, span: ByteSpan) -> Result<ByteSpan, OffsetMapError> {
        self.translate(span, Axis::Decoded, Axis::Source)
    }

    pub fn decoded_to_patched(&self, span: ByteSpan) -> Result<ByteSpan, OffsetMapError> {
        self.translate(span, Axis::Decoded, Axis::Patched)
    }

    pub fn patched_to_source(&self, span: ByteSpan) -> Result<ByteSpan, OffsetMapError> {
        self.translate(span, Axis::Patched, Axis::Source)
    }

    pub fn patched_to_decoded(&self, span: ByteSpan) -> Result<ByteSpan, OffsetMapError> {
        self.translate(span, Axis::Patched, Axis::Decoded)
    }

    fn translate(
        &self,
        span: ByteSpan,
        from_axis: Axis,
        to_axis: Axis,
    ) -> Result<ByteSpan, OffsetMapError> {
        let mut segments = self.segments.iter().collect::<Vec<_>>();
        segments.sort_by_key(|segment| from_axis.span(segment).start);
        let mut current = span.start;
        let mut translated_start = None;
        let mut translated_end = None;

        for segment in segments {
            let from = from_axis.span(segment);
            let to = to_axis.span(segment);
            if from.end <= current {
                continue;
            }
            if from.start > current {
                break;
            }
            if from.start < current {
                return Err(OffsetMapError::from_diagnostic(OffsetMapDiagnostic::new(
                    "kaifuu.invalid_offset",
                    format!("{}Bytes", from_axis.field_prefix()),
                    format!(
                        "{} offset {current} falls inside mapped span {}..{}; exact segment boundary required",
                        from_axis.label(),
                        from.start,
                        from.end
                    ),
                )));
            }
            if translated_start.is_none() {
                translated_start = Some(to.start);
            }
            if let Some(previous_end) = translated_end
                && previous_end != to.start
            {
                return Err(OffsetMapError::from_diagnostic(OffsetMapDiagnostic::new(
                    "kaifuu.non_contiguous_translation",
                    format!("{}Bytes", to_axis.field_prefix()),
                    format!(
                        "{} spans are not contiguous at exact translation boundary {}",
                        to_axis.label(),
                        previous_end
                    ),
                )));
            }
            translated_end = Some(to.end);
            current = from.end;
            if current == span.end {
                return ByteSpan::new(translated_start.unwrap_or(to.start), to.end);
            }
            if current > span.end {
                return Err(OffsetMapError::from_diagnostic(OffsetMapDiagnostic::new(
                    "kaifuu.invalid_offset",
                    format!("{}Bytes", from_axis.field_prefix()),
                    format!(
                        "{} offset {} falls inside mapped span {}..{}; exact segment boundary required",
                        from_axis.label(),
                        span.end,
                        from.start,
                        from.end
                    ),
                )));
            }
        }

        Err(OffsetMapError::from_diagnostic(OffsetMapDiagnostic::new(
            "kaifuu.invalid_offset",
            format!("{}Bytes", from_axis.field_prefix()),
            format!(
                "{} span {}..{} is not fully represented in the offset map",
                from_axis.label(),
                span.start,
                span.end
            ),
        )))
    }
}

impl<'de> Deserialize<'de> for OffsetMap {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct RawOffsetMap {
            source_file_id: SourceFileId,
            source_revision_id: SourceRevisionId,
            encoding: SourceEncoding,
            source_length: u64,
            decoded_text_length: u64,
            patched_length: u64,
            segments: Vec<OffsetMapSegment>,
        }

        let raw = RawOffsetMap::deserialize(deserializer)?;
        Self::from_validated_parts(
            raw.source_file_id,
            raw.source_revision_id,
            raw.encoding,
            raw.source_length,
            raw.decoded_text_length,
            raw.patched_length,
            raw.segments,
        )
        .map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OffsetMapValidationResult {
    pub schema_version: String,
    pub status: OperationStatus,
    pub diagnostics: Vec<OffsetMapDiagnostic>,
}

impl OffsetMapValidationResult {
    pub fn from_diagnostics(diagnostics: Vec<OffsetMapDiagnostic>) -> Self {
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

    pub fn into_result(self) -> Result<(), OffsetMapError> {
        if self.status == OperationStatus::Passed {
            Ok(())
        } else {
            Err(OffsetMapError {
                diagnostics: self.diagnostics,
            })
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OffsetMapDiagnostic {
    pub code: String,
    pub field: String,
    pub message: String,
}

impl OffsetMapDiagnostic {
    pub fn new(
        code: impl Into<String>,
        field: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            code: code.into(),
            field: field.into(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OffsetMapError {
    diagnostics: Vec<OffsetMapDiagnostic>,
}

impl OffsetMapError {
    pub fn from_diagnostic(diagnostic: OffsetMapDiagnostic) -> Self {
        Self {
            diagnostics: vec![diagnostic],
        }
    }

    pub fn diagnostics(&self) -> &[OffsetMapDiagnostic] {
        &self.diagnostics
    }
}

impl fmt::Display for OffsetMapError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let messages = self
            .diagnostics
            .iter()
            .map(|diagnostic| {
                format!(
                    "{} at {}: {}",
                    diagnostic.code, diagnostic.field, diagnostic.message
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
        formatter.write_str(&messages)
    }
}

impl std::error::Error for OffsetMapError {}

pub fn validate_offset_map_value(value: &Value) -> OffsetMapValidationResult {
    let mut diagnostics = Vec::new();
    let Some(object) = value.as_object() else {
        return OffsetMapValidationResult::from_diagnostics(vec![OffsetMapDiagnostic::new(
            "kaifuu.invalid_offset_map",
            "$",
            "offset map must be a JSON object",
        )]);
    };

    validate_required_identifier_field(
        &mut diagnostics,
        object.get("sourceFileId"),
        "sourceFileId",
    );
    validate_required_identifier_field(
        &mut diagnostics,
        object.get("sourceRevisionId"),
        "sourceRevisionId",
    );
    validate_required_encoding_field(&mut diagnostics, object.get("encoding"), "encoding");
    let source_length =
        validate_required_u64_field(&mut diagnostics, object.get("sourceLength"), "sourceLength");
    let decoded_text_length = validate_required_u64_field(
        &mut diagnostics,
        object.get("decodedTextLength"),
        "decodedTextLength",
    );
    let patched_length = validate_required_u64_field(
        &mut diagnostics,
        object.get("patchedLength"),
        "patchedLength",
    );

    let Some(segments) = object.get("segments").and_then(Value::as_array) else {
        diagnostics.push(OffsetMapDiagnostic::new(
            "kaifuu.missing_offset_segments",
            "segments",
            "segments must be an array",
        ));
        return OffsetMapValidationResult::from_diagnostics(diagnostics);
    };

    let mut typed_segments = Vec::new();
    for (index, segment) in segments.iter().enumerate() {
        let Some(segment_object) = segment.as_object() else {
            diagnostics.push(OffsetMapDiagnostic::new(
                "kaifuu.invalid_offset_segment",
                format!("segments[{index}]"),
                "offset map segment must be an object",
            ));
            continue;
        };
        let source_bytes = read_json_span(
            &mut diagnostics,
            segment_object.get("sourceBytes"),
            index,
            "sourceBytes",
        );
        let decoded_text = read_json_span(
            &mut diagnostics,
            segment_object.get("decodedText"),
            index,
            "decodedText",
        );
        let patched_bytes = read_json_span(
            &mut diagnostics,
            segment_object.get("patchedBytes"),
            index,
            "patchedBytes",
        );
        if let (Some(source_bytes), Some(decoded_text), Some(patched_bytes)) =
            (source_bytes, decoded_text, patched_bytes)
        {
            typed_segments.push(OffsetMapSegment::new_unchecked(
                source_bytes,
                decoded_text,
                patched_bytes,
            ));
        }
    }

    if let (Some(source_length), Some(decoded_text_length), Some(patched_length)) =
        (source_length, decoded_text_length, patched_length)
    {
        let structural_map = OffsetMap {
            source_file_id: SourceFileId("__validated__".to_string()),
            source_revision_id: SourceRevisionId("__validated__".to_string()),
            encoding: SourceEncoding::Binary,
            source_length,
            decoded_text_length,
            patched_length,
            segments: typed_segments,
        };
        diagnostics.extend(structural_map.validate().diagnostics);
    }

    OffsetMapValidationResult::from_diagnostics(diagnostics)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Axis {
    Source,
    Decoded,
    Patched,
}

impl Axis {
    fn span(self, segment: &OffsetMapSegment) -> ByteSpan {
        match self {
            Self::Source => segment.source_bytes,
            Self::Decoded => segment.decoded_text,
            Self::Patched => segment.patched_bytes,
        }
    }

    fn field(self) -> &'static str {
        match self {
            Self::Source => "sourceBytes",
            Self::Decoded => "decodedText",
            Self::Patched => "patchedBytes",
        }
    }

    fn field_prefix(self) -> &'static str {
        match self {
            Self::Source => "source",
            Self::Decoded => "decodedText",
            Self::Patched => "patched",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Source => "source byte",
            Self::Decoded => "decoded text",
            Self::Patched => "patched byte",
        }
    }
}

fn validate_identifier_value(field: &str, value: &str) -> Result<(), OffsetMapError> {
    if value.trim().is_empty() || value.contains('\0') {
        return Err(OffsetMapError::from_diagnostic(OffsetMapDiagnostic::new(
            match field {
                "sourceRevisionId" => "kaifuu.missing_source_revision_id",
                "sourceFileId" => "kaifuu.missing_source_file_id",
                _ => "kaifuu.invalid_identifier",
            },
            field,
            format!("{field} must be a non-empty string without null bytes"),
        )));
    }
    Ok(())
}

fn validate_segment_span(
    diagnostics: &mut Vec<OffsetMapDiagnostic>,
    index: usize,
    field: &str,
    span: ByteSpan,
    upper_bound: u64,
    out_of_range_code: &str,
) {
    if span.end < span.start {
        diagnostics.push(OffsetMapDiagnostic::new(
            "kaifuu.invalid_offset",
            format!("segments[{index}].{field}"),
            format!(
                "span end {} must be greater than or equal to start {}",
                span.end, span.start
            ),
        ));
    }
    if span.end > upper_bound {
        diagnostics.push(OffsetMapDiagnostic::new(
            out_of_range_code,
            format!("segments[{index}].{field}"),
            format!(
                "span {}..{} exceeds declared length {}",
                span.start, span.end, upper_bound
            ),
        ));
    }
}

fn validate_segment_axes_attached(
    diagnostics: &mut Vec<OffsetMapDiagnostic>,
    field: impl Into<String>,
    source_bytes: ByteSpan,
    decoded_text: ByteSpan,
    patched_bytes: ByteSpan,
) {
    let empty_axes = [
        source_bytes.is_empty(),
        decoded_text.is_empty(),
        patched_bytes.is_empty(),
    ]
    .into_iter()
    .filter(|empty| *empty)
    .count();
    if empty_axes != 0 && empty_axes != 3 {
        diagnostics.push(OffsetMapDiagnostic::new(
            "kaifuu.detached_offset_segment",
            field,
            "offset map segment axes must all be empty or all non-empty",
        ));
    }
}

fn validate_non_overlapping_axis(
    diagnostics: &mut Vec<OffsetMapDiagnostic>,
    segments: &[OffsetMapSegment],
    axis: Axis,
) {
    let mut spans = segments
        .iter()
        .enumerate()
        .filter_map(|(index, segment)| {
            let span = axis.span(segment);
            (!span.is_empty()).then_some((index, span))
        })
        .collect::<Vec<_>>();
    spans.sort_by_key(|(_, span)| (span.start, span.end));
    for window in spans.windows(2) {
        let (previous_index, previous) = window[0];
        let (current_index, current) = window[1];
        if previous.overlaps(current) {
            diagnostics.push(OffsetMapDiagnostic::new(
                "kaifuu.overlapping_spans",
                format!("segments[{current_index}].{}", axis.field()),
                format!(
                    "{} span {}..{} overlaps segments[{previous_index}] {}..{}",
                    axis.label(),
                    current.start,
                    current.end,
                    previous.start,
                    previous.end
                ),
            ));
        }
    }
}

fn validate_required_identifier_field(
    diagnostics: &mut Vec<OffsetMapDiagnostic>,
    value: Option<&Value>,
    field: &str,
) {
    match value.and_then(Value::as_str) {
        Some(value) => {
            if let Err(error) = validate_identifier_value(field, value) {
                diagnostics.extend(error.diagnostics);
            }
        }
        None => diagnostics.push(OffsetMapDiagnostic::new(
            match field {
                "sourceRevisionId" => "kaifuu.missing_source_revision_id",
                "sourceFileId" => "kaifuu.missing_source_file_id",
                _ => "kaifuu.missing_identifier",
            },
            field,
            format!("{field} must be a non-empty string"),
        )),
    }
}

fn validate_required_encoding_field(
    diagnostics: &mut Vec<OffsetMapDiagnostic>,
    value: Option<&Value>,
    field: &str,
) {
    match value.and_then(Value::as_str) {
        Some(value) if SourceEncoding::parse(value).is_some() => {}
        Some(value) => diagnostics.push(OffsetMapDiagnostic::new(
            "kaifuu.invalid_encoding",
            field,
            format!("encoding {value} is not supported"),
        )),
        None => diagnostics.push(OffsetMapDiagnostic::new(
            "kaifuu.invalid_encoding",
            field,
            "encoding must be a string",
        )),
    }
}

fn validate_required_u64_field(
    diagnostics: &mut Vec<OffsetMapDiagnostic>,
    value: Option<&Value>,
    field: &str,
) -> Option<u64> {
    if let Some(value) = value.and_then(Value::as_u64) {
        Some(value)
    } else {
        diagnostics.push(OffsetMapDiagnostic::new(
            "kaifuu.invalid_offset",
            field,
            format!("{field} must be a non-negative integer"),
        ));
        None
    }
}

fn read_json_span(
    diagnostics: &mut Vec<OffsetMapDiagnostic>,
    value: Option<&Value>,
    segment_index: usize,
    field: &str,
) -> Option<ByteSpan> {
    let field_path = format!("segments[{segment_index}].{field}");
    let Some(object) = value.and_then(Value::as_object) else {
        diagnostics.push(OffsetMapDiagnostic::new(
            "kaifuu.invalid_offset",
            &field_path,
            format!("{field_path} must be an object"),
        ));
        return None;
    };
    let start = validate_required_u64_field(
        diagnostics,
        object.get("start"),
        &format!("{field_path}.start"),
    );
    let end =
        validate_required_u64_field(diagnostics, object.get("end"), &format!("{field_path}.end"));
    match (start, end) {
        (Some(start), Some(end)) => match ByteSpan::new(start, end) {
            Ok(span) => Some(span),
            Err(error) => {
                diagnostics.extend(error.diagnostics);
                None
            }
        },
        _ => None,
    }
}

fn encode_string(value: &str, encoding: SourceEncoding) -> Result<Vec<u8>, String> {
    match encoding {
        SourceEncoding::Utf8 | SourceEncoding::Binary | SourceEncoding::BinaryTable => {
            Ok(value.as_bytes().to_vec())
        }
        SourceEncoding::ShiftJis => encode_shift_jis(value),
    }
}

/// Encode `value` as Shift-JIS bytes for encoded string-slot preflight.
///
/// # Shift-JIS codec contract
///
/// This uses the WHATWG Shift_JIS encoder from `encoding_rs` (the same codec
/// the runtime crates decode/encode with), which is a *complete* Shift-JIS
/// encoder covering the full mappable repertoire: ASCII, halfwidth katakana
/// (JIS X 0201), and every JIS X 0208 double-byte character (common kanji,
/// fullwidth latin/digits, fullwidth punctuation, hiragana, katakana). It
/// supersedes the KAIFUU-082 hand-coded subset, which only mapped ASCII,
/// halfwidth katakana, hiragana, katakana, and a handful of punctuation marks
/// and therefore wrongly rejected common kanji and most fullwidth text.
///
/// The contract is *predictable*: any character in the Shift-JIS repertoire is
/// accepted and encoded to its canonical byte sequence; any character outside
/// it (emoji, rare CJK extension, etc.) is rejected with `Err`. Callers surface
/// that as a typed [`STRING_SLOT_INVALID_ENCODING`] diagnostic naming the slot
/// id and byte range, so there is no silent pass or wrong-size result.
fn encode_shift_jis(value: &str) -> Result<Vec<u8>, String> {
    let (encoded, _encoding, had_unmappable) = encoding_rs::SHIFT_JIS.encode(value);
    if had_unmappable {
        let (char_index, encoded_byte_offset, offending) = locate_first_unmappable_shift_jis(value);
        return Err(format!(
            "character {offending:?} (U+{codepoint:04X}) at char index {char_index} \
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

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StringTableRebuildRequest {
    pub fixture_id: String,
    pub source_bytes_hex: String,
    pub slots: Vec<StringRelocationSlot>,
    pub replacements: Vec<StringRelocationTarget>,
    pub references: Vec<StringRelocationReference>,
    #[serde(default)]
    pub string_slot_diagnostics: Vec<EncodedStringSlotDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StringRelocationSlot {
    pub slot_id: String,
    pub encoding: SourceEncoding,
    pub old_byte_range: ByteSpan,
    pub layout: EncodedStringSlotLayout,
    #[serde(default)]
    pub protected_spans: Vec<EncodedStringSlotProtectedSpan>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StringRelocationTarget {
    pub slot_id: String,
    pub target_text: String,
    #[serde(default)]
    pub protected_span_mappings: Vec<ProtectedSpanMapping>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StringRelocationReference {
    pub reference_id: String,
    pub slot_id: String,
    pub byte_range: ByteSpan,
    pub format: StringReferenceFormat,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StringReferenceFormat {
    #[serde(rename_all = "camelCase")]
    PointerLeU32 {
        base_address: u64,
    },
    IndexLeU16,
    #[serde(rename_all = "camelCase")]
    Unsupported {
        format_id: String,
    },
}

impl StringReferenceFormat {
    fn relocation_kind(&self) -> StringReferenceRelocationKind {
        match self {
            Self::PointerLeU32 { .. } => StringReferenceRelocationKind::PointerTable,
            Self::IndexLeU16 => StringReferenceRelocationKind::IndexTable,
            Self::Unsupported { .. } => StringReferenceRelocationKind::Unsupported,
        }
    }

    fn width(&self) -> u64 {
        match self {
            Self::PointerLeU32 { .. } => 4,
            Self::IndexLeU16 => 2,
            Self::Unsupported { .. } => 0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StringReferenceRelocationKind {
    PointerTable,
    IndexTable,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StringRelocationPlanReport {
    pub schema_version: String,
    pub status: OperationStatus,
    pub fixture_id: String,
    pub relocated_strings: Vec<RelocatedString>,
    pub relocated_references: Vec<RelocatedStringReference>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub string_slot_diagnostics: Vec<EncodedStringSlotDiagnostic>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub relocation_diagnostics: Vec<StringRelocationDiagnostic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_bytes_hex: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_hash: Option<String>,
}

impl StringRelocationPlanReport {
    fn failed(
        fixture_id: String,
        string_slot_diagnostics: Vec<EncodedStringSlotDiagnostic>,
        relocation_diagnostics: Vec<StringRelocationDiagnostic>,
    ) -> Self {
        Self {
            schema_version: "0.1.0".to_string(),
            status: OperationStatus::Failed,
            fixture_id,
            relocated_strings: vec![],
            relocated_references: vec![],
            string_slot_diagnostics,
            relocation_diagnostics,
            output_bytes_hex: None,
            output_hash: None,
        }
    }

    fn passed(
        fixture_id: String,
        relocated_strings: Vec<RelocatedString>,
        relocated_references: Vec<RelocatedStringReference>,
        output_bytes: Vec<u8>,
    ) -> Self {
        let output_bytes_hex = bytes_to_hex(&output_bytes);
        Self {
            schema_version: "0.1.0".to_string(),
            status: OperationStatus::Passed,
            fixture_id,
            relocated_strings,
            relocated_references,
            string_slot_diagnostics: vec![],
            relocation_diagnostics: vec![],
            output_hash: Some(content_hash(&output_bytes_hex)),
            output_bytes_hex: Some(output_bytes_hex),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelocatedString {
    pub slot_id: String,
    pub old_byte_range: ByteSpan,
    pub new_byte_range: ByteSpan,
    pub encoded_hash: String,
    pub output_hash_inputs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelocatedStringReference {
    pub reference_id: String,
    pub slot_id: String,
    pub old_byte_range: ByteSpan,
    pub new_byte_range: ByteSpan,
    pub relocation_kind: StringReferenceRelocationKind,
    pub target_old_byte_range: ByteSpan,
    pub target_new_byte_range: ByteSpan,
    pub output_hash_inputs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StringRelocationDiagnostic {
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slot_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byte_range: Option<ByteSpan>,
    pub message: String,
    pub remediation_code: String,
    pub remediation: String,
}

type EncodedStringSlotResult<T> = Result<T, Box<EncodedStringSlotDiagnostic>>;
type StringRelocationResult<T> = Result<T, Box<StringRelocationDiagnostic>>;

pub fn plan_string_table_rebuild(
    request: &StringTableRebuildRequest,
) -> StringRelocationPlanReport {
    let mut diagnostics = request.string_slot_diagnostics.clone();
    let mut relocation_diagnostics = validate_relocation_request(request);
    if !diagnostics.is_empty() || !relocation_diagnostics.is_empty() {
        return StringRelocationPlanReport::failed(
            request.fixture_id.clone(),
            diagnostics,
            relocation_diagnostics,
        );
    }

    // `validate_relocation_request` already rejects an unparseable source
    // (returning above), so this re-parse normally succeeds; the Err arm
    // remains as a typed defensive guard that never panics.
    let source_bytes = match parse_hex_bytes(&request.source_bytes_hex) {
        Ok(bytes) => bytes,
        Err(message) => {
            relocation_diagnostics.push(relocation_diagnostic(
                STRING_RELOCATION_INVALID_SOURCE_BYTES,
                None,
                None,
                None,
                format!("source bytes are not valid hex: {message}"),
                "repair_fixture_source_bytes",
                "provide deterministic hexadecimal fixture bytes before rebuilding",
            ));
            return StringRelocationPlanReport::failed(
                request.fixture_id.clone(),
                diagnostics,
                relocation_diagnostics,
            );
        }
    };

    let replacements = request
        .replacements
        .iter()
        .map(|replacement| (replacement.slot_id.as_str(), replacement))
        .collect::<BTreeMap<_, _>>();
    let mut rebuilt_slots = Vec::new();
    for slot in &request.slots {
        let Some(replacement) = replacements.get(slot.slot_id.as_str()) else {
            relocation_diagnostics.push(relocation_diagnostic(
                STRING_RELOCATION_UNRESOLVED_REFERENCE,
                None,
                Some(&slot.slot_id),
                Some(slot.old_byte_range),
                "slot has no replacement target",
                "provide_slot_replacement",
                "include a deterministic targetText for every rebuilt slot",
            ));
            continue;
        };
        match encode_relocated_slot(slot, replacement, &source_bytes) {
            Ok(encoded_bytes) => rebuilt_slots.push(RebuiltSlot {
                slot,
                encoded_bytes,
                new_range: ByteSpan::new(0, 0).unwrap(),
            }),
            Err(diagnostic) => diagnostics.push(*diagnostic),
        }
    }

    if !diagnostics.is_empty() || !relocation_diagnostics.is_empty() {
        return StringRelocationPlanReport::failed(
            request.fixture_id.clone(),
            diagnostics,
            relocation_diagnostics,
        );
    }

    rebuilt_slots.sort_by_key(|slot| {
        (
            slot.slot.old_byte_range.start(),
            slot.slot.old_byte_range.end(),
        )
    });
    let mut output = Vec::new();
    let mut cursor = 0_u64;
    let mut mappings = Vec::new();
    for rebuilt_slot in &mut rebuilt_slots {
        if cursor < rebuilt_slot.slot.old_byte_range.start() {
            let gap_start = cursor as usize;
            let gap_end = rebuilt_slot.slot.old_byte_range.start() as usize;
            let new_start = output.len() as u64;
            output.extend_from_slice(&source_bytes[gap_start..gap_end]);
            let new_end = output.len() as u64;
            mappings.push(RangeMapping {
                old_range: ByteSpan::new(cursor, rebuilt_slot.slot.old_byte_range.start()).unwrap(),
                new_range: ByteSpan::new(new_start, new_end).unwrap(),
            });
        }

        let new_start = output.len() as u64;
        output.extend_from_slice(&rebuilt_slot.encoded_bytes);
        let new_end = output.len() as u64;
        rebuilt_slot.new_range = ByteSpan::new(new_start, new_end).unwrap();
        mappings.push(RangeMapping {
            old_range: rebuilt_slot.slot.old_byte_range,
            new_range: rebuilt_slot.new_range,
        });
        cursor = rebuilt_slot.slot.old_byte_range.end();
    }

    if cursor < source_bytes.len() as u64 {
        let new_start = output.len() as u64;
        output.extend_from_slice(&source_bytes[cursor as usize..]);
        let new_end = output.len() as u64;
        mappings.push(RangeMapping {
            old_range: ByteSpan::new(cursor, source_bytes.len() as u64).unwrap(),
            new_range: ByteSpan::new(new_start, new_end).unwrap(),
        });
    }

    let relocated_strings = rebuilt_slots
        .iter()
        .map(|rebuilt_slot| {
            let encoded_hash = content_hash(&bytes_to_hex(&rebuilt_slot.encoded_bytes));
            RelocatedString {
                slot_id: rebuilt_slot.slot.slot_id.clone(),
                old_byte_range: rebuilt_slot.slot.old_byte_range,
                new_byte_range: rebuilt_slot.new_range,
                encoded_hash: encoded_hash.clone(),
                output_hash_inputs: vec![
                    format!("fixture={}", request.fixture_id),
                    format!("slot={}", rebuilt_slot.slot.slot_id),
                    format!(
                        "old={}..{}",
                        rebuilt_slot.slot.old_byte_range.start(),
                        rebuilt_slot.slot.old_byte_range.end()
                    ),
                    format!(
                        "new={}..{}",
                        rebuilt_slot.new_range.start(),
                        rebuilt_slot.new_range.end()
                    ),
                    format!("encodedHash={encoded_hash}"),
                ],
            }
        })
        .collect::<Vec<_>>();

    let slots_by_id = rebuilt_slots
        .iter()
        .map(|rebuilt_slot| (rebuilt_slot.slot.slot_id.as_str(), rebuilt_slot))
        .collect::<BTreeMap<_, _>>();
    let mut relocated_references = Vec::new();
    let mut reference_writes = Vec::new();
    for reference in &request.references {
        let Some(rebuilt_slot) = slots_by_id.get(reference.slot_id.as_str()) else {
            relocation_diagnostics.push(relocation_diagnostic(
                STRING_RELOCATION_UNRESOLVED_REFERENCE,
                Some(&reference.reference_id),
                Some(&reference.slot_id),
                Some(reference.byte_range),
                "reference points at a slot that was not rebuilt",
                "repair_reference_slot_id",
                "bind every relocation reference to a rebuilt slot id",
            ));
            continue;
        };
        match decode_reference_old_target(reference, &source_bytes) {
            Ok(decoded_old_target)
                if decoded_old_target == rebuilt_slot.slot.old_byte_range.start() => {}
            Ok(decoded_old_target) => {
                relocation_diagnostics.push(reference_provenance_mismatch_diagnostic(
                    reference,
                    decoded_old_target,
                    rebuilt_slot.slot.old_byte_range.start(),
                ));
                continue;
            }
            Err(diagnostic) => {
                relocation_diagnostics.push(*diagnostic);
                continue;
            }
        }
        let Some(new_reference_range) = translate_old_range(reference.byte_range, &mappings) else {
            relocation_diagnostics.push(relocation_diagnostic(
                STRING_RELOCATION_UNRESOLVED_REFERENCE,
                Some(&reference.reference_id),
                Some(&reference.slot_id),
                Some(reference.byte_range),
                "reference byte range is not represented in the rebuilt output",
                "repair_reference_range",
                "declare reference bytes outside relocated string payload ranges",
            ));
            continue;
        };
        let reference_bytes = match encode_reference_value(reference, rebuilt_slot) {
            Ok(bytes) => bytes,
            Err(diagnostic) => {
                relocation_diagnostics.push(*diagnostic);
                continue;
            }
        };
        reference_writes.push(ReferenceWrite {
            reference,
            new_range: new_reference_range,
            bytes: reference_bytes,
            target_new_range: rebuilt_slot.new_range,
            target_old_range: rebuilt_slot.slot.old_byte_range,
        });
    }

    validate_reference_write_overlaps(
        &mut relocation_diagnostics,
        &reference_writes,
        &relocated_strings,
    );
    if !relocation_diagnostics.is_empty() {
        return StringRelocationPlanReport::failed(
            request.fixture_id.clone(),
            diagnostics,
            relocation_diagnostics,
        );
    }

    for write in &reference_writes {
        let start = write.new_range.start() as usize;
        let end = write.new_range.end() as usize;
        output[start..end].copy_from_slice(&write.bytes);
        let output_hash_inputs = vec![
            format!("fixture={}", request.fixture_id),
            format!("reference={}", write.reference.reference_id),
            format!("slot={}", write.reference.slot_id),
            format!("kind={:?}", write.reference.format.relocation_kind()),
            format!(
                "oldReference={}..{}",
                write.reference.byte_range.start(),
                write.reference.byte_range.end()
            ),
            format!(
                "newReference={}..{}",
                write.new_range.start(),
                write.new_range.end()
            ),
            format!(
                "targetNew={}..{}",
                write.target_new_range.start(),
                write.target_new_range.end()
            ),
            format!("writeHash={}", content_hash(&bytes_to_hex(&write.bytes))),
        ];
        relocated_references.push(RelocatedStringReference {
            reference_id: write.reference.reference_id.clone(),
            slot_id: write.reference.slot_id.clone(),
            old_byte_range: write.reference.byte_range,
            new_byte_range: write.new_range,
            relocation_kind: write.reference.format.relocation_kind(),
            target_old_byte_range: write.target_old_range,
            target_new_byte_range: write.target_new_range,
            output_hash_inputs,
        });
    }

    relocated_references.sort_by_key(|reference| {
        (
            reference.reference_id.clone(),
            reference.slot_id.clone(),
            reference.new_byte_range.start(),
        )
    });

    StringRelocationPlanReport::passed(
        request.fixture_id.clone(),
        relocated_strings,
        relocated_references,
        output,
    )
}

struct RebuiltSlot<'a> {
    slot: &'a StringRelocationSlot,
    encoded_bytes: Vec<u8>,
    new_range: ByteSpan,
}

struct RangeMapping {
    old_range: ByteSpan,
    new_range: ByteSpan,
}

struct ReferenceWrite<'a> {
    reference: &'a StringRelocationReference,
    new_range: ByteSpan,
    bytes: Vec<u8>,
    target_old_range: ByteSpan,
    target_new_range: ByteSpan,
}

fn validate_relocation_request(
    request: &StringTableRebuildRequest,
) -> Vec<StringRelocationDiagnostic> {
    let mut diagnostics = Vec::new();
    // Distinguish a *genuinely empty* source (valid hex parsing to a
    // zero-length vector → `Some(0)`) from a *parse failure* (`None`). A
    // parse failure must not collapse to `source_len = 0`, because a length
    // of zero would silently gate OFF every slot bounds check below and let
    // a positive-offset slot reach the rebuild path, where it indexes an
    // empty slice and panics. Both cases now surface a typed diagnostic.
    let source_len = match parse_hex_bytes(&request.source_bytes_hex) {
        Ok(bytes) => Some(bytes.len() as u64),
        Err(message) => {
            diagnostics.push(relocation_diagnostic(
                STRING_RELOCATION_INVALID_SOURCE_BYTES,
                None,
                None,
                None,
                format!("source bytes are not valid hex: {message}"),
                "repair_fixture_source_bytes",
                "provide deterministic hexadecimal fixture bytes before rebuilding",
            ));
            None
        }
    };

    let mut slot_ids = BTreeSet::new();
    let mut slot_ranges = Vec::new();
    for slot in &request.slots {
        if !slot_ids.insert(slot.slot_id.as_str()) {
            diagnostics.push(relocation_diagnostic(
                STRING_RELOCATION_UNRESOLVED_REFERENCE,
                None,
                Some(&slot.slot_id),
                Some(slot.old_byte_range),
                "slot id is declared more than once",
                "deduplicate_slot_ids",
                "declare each rebuilt slot exactly once",
            ));
        }
        // Bounds-check whenever the source length is known — including a
        // genuinely empty source (`Some(0)`), where any positive-offset
        // slot exceeds it and must be rejected rather than bypassed.
        if let Some(source_len) = source_len
            && slot.old_byte_range.end() > source_len
        {
            diagnostics.push(relocation_diagnostic(
                STRING_RELOCATION_UNRESOLVED_REFERENCE,
                None,
                Some(&slot.slot_id),
                Some(slot.old_byte_range),
                "slot byte range exceeds source bytes",
                "repair_slot_range",
                "declare slot ranges within the fixture source bytes",
            ));
        }
        slot_ranges.push((slot.slot_id.as_str(), slot.old_byte_range));
    }

    slot_ranges.sort_by_key(|(_, range)| (range.start(), range.end()));
    for window in slot_ranges.windows(2) {
        if window[0].1.overlaps(window[1].1) {
            diagnostics.push(relocation_diagnostic(
                STRING_RELOCATION_OVERLAPPING_WRITES,
                None,
                Some(window[1].0),
                Some(window[1].1),
                "rebuilt string slot overlaps another slot",
                "repair_slot_ranges",
                "declare non-overlapping string payload ranges before rebuilding",
            ));
        }
    }

    let mut replacement_ids = BTreeSet::new();
    for replacement in &request.replacements {
        if !replacement_ids.insert(replacement.slot_id.as_str()) {
            diagnostics.push(relocation_diagnostic(
                STRING_RELOCATION_UNRESOLVED_REFERENCE,
                None,
                Some(&replacement.slot_id),
                None,
                "replacement target is declared more than once",
                "deduplicate_replacements",
                "provide one replacement target per rebuilt slot",
            ));
        }
        if !slot_ids.contains(replacement.slot_id.as_str()) {
            diagnostics.push(relocation_diagnostic(
                STRING_RELOCATION_UNRESOLVED_REFERENCE,
                None,
                Some(&replacement.slot_id),
                None,
                "replacement target references an unknown slot",
                "repair_replacement_slot_id",
                "bind replacement targets to declared rebuilt slots",
            ));
        }
    }

    let mut reference_ids = BTreeSet::new();
    let mut reference_ranges = Vec::new();
    for reference in &request.references {
        if !reference_ids.insert(reference.reference_id.as_str()) {
            diagnostics.push(relocation_diagnostic(
                STRING_RELOCATION_UNRESOLVED_REFERENCE,
                Some(&reference.reference_id),
                Some(&reference.slot_id),
                Some(reference.byte_range),
                "reference id is declared more than once",
                "deduplicate_reference_ids",
                "declare each relocation reference exactly once",
            ));
        }
        if !slot_ids.contains(reference.slot_id.as_str()) {
            diagnostics.push(relocation_diagnostic(
                STRING_RELOCATION_UNRESOLVED_REFERENCE,
                Some(&reference.reference_id),
                Some(&reference.slot_id),
                Some(reference.byte_range),
                "reference points at an unknown slot id",
                "repair_reference_slot_id",
                "bind every relocation reference to a declared slot",
            ));
        }
        if matches!(reference.format, StringReferenceFormat::Unsupported { .. }) {
            diagnostics.push(relocation_diagnostic(
                STRING_RELOCATION_UNSUPPORTED_POINTER_FORMAT,
                Some(&reference.reference_id),
                Some(&reference.slot_id),
                Some(reference.byte_range),
                "reference uses an unsupported pointer format",
                "add_pointer_format_support",
                "add an explicit supported relocation encoder before patching this reference",
            ));
        }
        if reference.format.width() != 0 && reference.byte_range.len() != reference.format.width() {
            diagnostics.push(relocation_diagnostic(
                STRING_RELOCATION_UNSUPPORTED_POINTER_FORMAT,
                Some(&reference.reference_id),
                Some(&reference.slot_id),
                Some(reference.byte_range),
                "reference byte range width does not match its pointer format",
                "repair_reference_width",
                "declare a byte range matching the supported reference format width",
            ));
        }
        if let Some(source_len) = source_len
            && reference.byte_range.end() > source_len
        {
            diagnostics.push(relocation_diagnostic(
                STRING_RELOCATION_UNRESOLVED_REFERENCE,
                Some(&reference.reference_id),
                Some(&reference.slot_id),
                Some(reference.byte_range),
                "reference byte range exceeds source bytes",
                "repair_reference_range",
                "declare reference ranges within the fixture source bytes",
            ));
        }
        reference_ranges.push((
            reference.reference_id.as_str(),
            reference.slot_id.as_str(),
            reference.byte_range,
        ));
    }

    for (reference_id, slot_id, reference_range) in &reference_ranges {
        for (_, slot_range) in &slot_ranges {
            if reference_range.overlaps(*slot_range) {
                diagnostics.push(relocation_diagnostic(
                    STRING_RELOCATION_OVERLAPPING_WRITES,
                    Some(reference_id),
                    Some(slot_id),
                    Some(*reference_range),
                    "reference write overlaps a relocated string payload",
                    "separate_reference_table",
                    "keep relocation references outside rebuilt string payload byte ranges",
                ));
            }
        }
    }

    diagnostics
}

fn encode_relocated_slot(
    slot: &StringRelocationSlot,
    replacement: &StringRelocationTarget,
    source_bytes: &[u8],
) -> EncodedStringSlotResult<Vec<u8>> {
    let encoded = encode_string(&replacement.target_text, slot.encoding).map_err(|message| {
        Box::new(relocated_slot_diagnostic(
            slot,
            STRING_SLOT_INVALID_ENCODING,
            message,
            "replace_unencodable_character",
            "replace characters unsupported by the slot encoding before patching",
        ))
    })?;

    let mut required_spans = BTreeMap::<&str, Vec<&EncodedStringSlotProtectedSpan>>::new();
    for protected_span in &slot.protected_spans {
        if !protected_span.raw.is_empty() {
            required_spans
                .entry(protected_span.raw.as_str())
                .or_default()
                .push(protected_span);
        }
    }
    let mut matching_ranges = BTreeMap::<&str, BTreeSet<(u64, u64)>>::new();
    let mut matched_source_identities = BTreeSet::<String>::new();
    for mapping in &replacement.protected_span_mappings {
        let Some(source_spans) = required_spans.get(mapping.raw.as_str()) else {
            continue;
        };
        if !mapping.matches_target_text(&replacement.target_text) {
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
        let actual_count = count_protected_token_occurrences(&replacement.target_text, raw);
        // Exact multiplicity both directions (under- and over-count).
        if mapped_count != required_count || actual_count != required_count {
            return Err(Box::new(relocated_slot_diagnostic(
                slot,
                STRING_SLOT_PROTECTED_SPAN_MUTATION,
                format!(
                    "protected span {raw:?} has {mapped_count} target mapping(s) and {actual_count} target occurrence(s), expected {required_count}"
                ),
                "restore_protected_span",
                "preserve protected tokens and align protectedSpanMappings before relocation",
            )));
        }
    }

    match &slot.layout {
        EncodedStringSlotLayout::FixedWidth => Ok(encoded),
        EncodedStringSlotLayout::NullTerminated { terminator_hex } => {
            let terminator = parse_hex_bytes(terminator_hex).map_err(|message| {
                Box::new(relocated_slot_diagnostic(
                    slot,
                    STRING_SLOT_TERMINATOR_LOSS,
                    message,
                    "preserve_terminator",
                    "declare a valid hexadecimal terminator for this slot layout",
                ))
            })?;
            if terminator.is_empty() {
                return Err(Box::new(relocated_slot_diagnostic(
                    slot,
                    STRING_SLOT_TERMINATOR_LOSS,
                    "null-terminated slot declared an empty terminator",
                    "preserve_terminator",
                    "declare the terminator bytes required by this slot layout",
                )));
            }
            let start = slot.old_byte_range.start() as usize;
            let end = slot.old_byte_range.end() as usize;
            if end <= source_bytes.len() && !contains_bytes(&source_bytes[start..end], &terminator)
            {
                return Err(Box::new(relocated_slot_diagnostic(
                    slot,
                    STRING_SLOT_TERMINATOR_LOSS,
                    "current slot bytes do not contain the declared terminator",
                    "preserve_terminator",
                    "re-extract the source bytes or repair the slot terminator before relocation",
                )));
            }
            if contains_bytes(&encoded, &terminator) {
                return Err(Box::new(relocated_slot_diagnostic(
                    slot,
                    STRING_SLOT_TERMINATOR_LOSS,
                    "encoded target contains the terminator byte sequence before the slot terminator",
                    "preserve_terminator",
                    "remove embedded terminator bytes from the replacement text",
                )));
            }
            let mut bytes = encoded;
            bytes.extend(terminator);
            Ok(bytes)
        }
    }
}

fn relocated_slot_diagnostic(
    slot: &StringRelocationSlot,
    code: impl Into<String>,
    message: impl Into<String>,
    remediation_code: impl Into<String>,
    remediation: impl Into<String>,
) -> EncodedStringSlotDiagnostic {
    EncodedStringSlotDiagnostic {
        code: code.into(),
        slot_id: slot.slot_id.clone(),
        byte_range: slot.old_byte_range,
        message: message.into(),
        remediation_code: remediation_code.into(),
        remediation: remediation.into(),
    }
}

fn translate_old_range(range: ByteSpan, mappings: &[RangeMapping]) -> Option<ByteSpan> {
    mappings.iter().find_map(|mapping| {
        if mapping.old_range.contains_span(range)
            && mapping.old_range.len() == mapping.new_range.len()
        {
            let offset = range.start() - mapping.old_range.start();
            ByteSpan::new(
                mapping.new_range.start() + offset,
                mapping.new_range.start() + offset + range.len(),
            )
            .ok()
        } else if mapping.old_range == range {
            Some(mapping.new_range)
        } else {
            None
        }
    })
}

fn encode_reference_value(
    reference: &StringRelocationReference,
    rebuilt_slot: &RebuiltSlot<'_>,
) -> StringRelocationResult<Vec<u8>> {
    match &reference.format {
        StringReferenceFormat::PointerLeU32 { base_address } => {
            let pointer = base_address
                .checked_add(rebuilt_slot.new_range.start())
                .ok_or_else(|| {
                    Box::new(relocation_diagnostic(
                        STRING_RELOCATION_UNSUPPORTED_POINTER_FORMAT,
                        Some(&reference.reference_id),
                        Some(&reference.slot_id),
                        Some(reference.byte_range),
                        "pointer relocation overflowed u64 address space",
                        "repair_pointer_base",
                        "choose a pointer base and range representable by the fixture format",
                    ))
                })?;
            let pointer = u32::try_from(pointer).map_err(|_| {
                Box::new(relocation_diagnostic(
                    STRING_RELOCATION_UNSUPPORTED_POINTER_FORMAT,
                    Some(&reference.reference_id),
                    Some(&reference.slot_id),
                    Some(reference.byte_range),
                    "pointer relocation does not fit in u32 little-endian format",
                    "add_pointer_format_support",
                    "use a wider supported pointer format before patching this reference",
                ))
            })?;
            Ok(pointer.to_le_bytes().to_vec())
        }
        StringReferenceFormat::IndexLeU16 => {
            let index = u16::try_from(rebuilt_slot.new_range.start()).map_err(|_| {
                Box::new(relocation_diagnostic(
                    STRING_RELOCATION_UNSUPPORTED_POINTER_FORMAT,
                    Some(&reference.reference_id),
                    Some(&reference.slot_id),
                    Some(reference.byte_range),
                    "index relocation does not fit in u16 little-endian format",
                    "add_pointer_format_support",
                    "use a wider supported index format before patching this reference",
                ))
            })?;
            Ok(index.to_le_bytes().to_vec())
        }
        StringReferenceFormat::Unsupported { .. } => Err(Box::new(relocation_diagnostic(
            STRING_RELOCATION_UNSUPPORTED_POINTER_FORMAT,
            Some(&reference.reference_id),
            Some(&reference.slot_id),
            Some(reference.byte_range),
            "reference uses an unsupported pointer format",
            "add_pointer_format_support",
            "add an explicit supported relocation encoder before patching this reference",
        ))),
    }
}

fn decode_reference_old_target(
    reference: &StringRelocationReference,
    source_bytes: &[u8],
) -> StringRelocationResult<u64> {
    let start = usize::try_from(reference.byte_range.start()).map_err(|_| {
        Box::new(relocation_diagnostic(
            STRING_RELOCATION_UNRESOLVED_REFERENCE,
            Some(&reference.reference_id),
            Some(&reference.slot_id),
            Some(reference.byte_range),
            "reference byte range start is not addressable on this platform",
            "repair_reference_range",
            "declare reference ranges within the fixture source bytes",
        ))
    })?;
    let end = usize::try_from(reference.byte_range.end()).map_err(|_| {
        Box::new(relocation_diagnostic(
            STRING_RELOCATION_UNRESOLVED_REFERENCE,
            Some(&reference.reference_id),
            Some(&reference.slot_id),
            Some(reference.byte_range),
            "reference byte range end is not addressable on this platform",
            "repair_reference_range",
            "declare reference ranges within the fixture source bytes",
        ))
    })?;
    let bytes = source_bytes.get(start..end).ok_or_else(|| {
        Box::new(relocation_diagnostic(
            STRING_RELOCATION_UNRESOLVED_REFERENCE,
            Some(&reference.reference_id),
            Some(&reference.slot_id),
            Some(reference.byte_range),
            "reference byte range exceeds source bytes",
            "repair_reference_range",
            "declare reference ranges within the fixture source bytes",
        ))
    })?;

    match &reference.format {
        StringReferenceFormat::PointerLeU32 { base_address } => {
            let bytes: [u8; 4] = bytes.try_into().map_err(|_| {
                Box::new(relocation_diagnostic(
                    STRING_RELOCATION_UNSUPPORTED_POINTER_FORMAT,
                    Some(&reference.reference_id),
                    Some(&reference.slot_id),
                    Some(reference.byte_range),
                    "reference byte range width does not match u32 little-endian pointer format",
                    "repair_reference_width",
                    "declare a byte range matching the supported reference format width",
                ))
            })?;
            let pointer = u32::from_le_bytes(bytes) as u64;
            pointer.checked_sub(*base_address).ok_or_else(|| {
                Box::new(relocation_diagnostic(
                    STRING_RELOCATION_POINTER_PROVENANCE_MISMATCH,
                    Some(&reference.reference_id),
                    Some(&reference.slot_id),
                    Some(reference.byte_range),
                    format!(
                        "source pointer decodes to absolute address {pointer}, before base address {base_address}"
                    ),
                    "repair_reference_provenance",
                    "re-extract the pointer table or bind this reference to the slot currently targeted by the source bytes",
                ))
            })
        }
        StringReferenceFormat::IndexLeU16 => {
            let bytes: [u8; 2] = bytes.try_into().map_err(|_| {
                Box::new(relocation_diagnostic(
                    STRING_RELOCATION_UNSUPPORTED_POINTER_FORMAT,
                    Some(&reference.reference_id),
                    Some(&reference.slot_id),
                    Some(reference.byte_range),
                    "reference byte range width does not match u16 little-endian index format",
                    "repair_reference_width",
                    "declare a byte range matching the supported reference format width",
                ))
            })?;
            Ok(u16::from_le_bytes(bytes) as u64)
        }
        StringReferenceFormat::Unsupported { .. } => Err(Box::new(relocation_diagnostic(
            STRING_RELOCATION_UNSUPPORTED_POINTER_FORMAT,
            Some(&reference.reference_id),
            Some(&reference.slot_id),
            Some(reference.byte_range),
            "reference uses an unsupported pointer format",
            "add_pointer_format_support",
            "add an explicit supported relocation encoder before patching this reference",
        ))),
    }
}

fn reference_provenance_mismatch_diagnostic(
    reference: &StringRelocationReference,
    decoded_old_target: u64,
    expected_old_target: u64,
) -> StringRelocationDiagnostic {
    let table_semantic = match reference.format {
        StringReferenceFormat::PointerLeU32 { base_address } => format!(
            "pointer_le_u32 entries encode baseAddress + slot oldByteRange.start; baseAddress={base_address}"
        ),
        StringReferenceFormat::IndexLeU16 => {
            "index_le_u16 table entries encode slot oldByteRange.start as a source byte offset"
                .to_string()
        }
        StringReferenceFormat::Unsupported { .. } => {
            "unsupported relocation formats have no validated source table semantic".to_string()
        }
    };
    relocation_diagnostic(
        STRING_RELOCATION_POINTER_PROVENANCE_MISMATCH,
        Some(&reference.reference_id),
        Some(&reference.slot_id),
        Some(reference.byte_range),
        format!(
            "source reference decodes to old target {decoded_old_target}, but slot {} starts at {expected_old_target}; {table_semantic}",
            reference.slot_id
        ),
        "repair_reference_provenance",
        "re-extract the pointer or index table, or bind this reference to the slot currently targeted by the source bytes",
    )
}

fn validate_reference_write_overlaps(
    diagnostics: &mut Vec<StringRelocationDiagnostic>,
    writes: &[ReferenceWrite<'_>],
    relocated_strings: &[RelocatedString],
) {
    let mut ranges = writes
        .iter()
        .map(|write| {
            (
                write.reference.reference_id.as_str(),
                write.reference.slot_id.as_str(),
                write.new_range,
            )
        })
        .collect::<Vec<_>>();
    ranges.sort_by_key(|(_, _, range)| (range.start(), range.end()));
    for window in ranges.windows(2) {
        if window[0].2.overlaps(window[1].2) {
            diagnostics.push(relocation_diagnostic(
                STRING_RELOCATION_OVERLAPPING_WRITES,
                Some(window[1].0),
                Some(window[1].1),
                Some(window[1].2),
                "relocation reference writes overlap each other",
                "repair_reference_ranges",
                "declare non-overlapping pointer or index table reference ranges",
            ));
        }
    }

    for (reference_id, slot_id, reference_range) in ranges {
        for relocated_string in relocated_strings {
            if reference_range.overlaps(relocated_string.new_byte_range) {
                diagnostics.push(relocation_diagnostic(
                    STRING_RELOCATION_OVERLAPPING_WRITES,
                    Some(reference_id),
                    Some(slot_id),
                    Some(reference_range),
                    "reference write overlaps rebuilt string bytes",
                    "separate_reference_table",
                    "keep relocation references outside rebuilt string payload byte ranges",
                ));
            }
        }
    }
}

fn relocation_diagnostic(
    code: impl Into<String>,
    reference_id: Option<&str>,
    slot_id: Option<&str>,
    byte_range: Option<ByteSpan>,
    message: impl Into<String>,
    remediation_code: impl Into<String>,
    remediation: impl Into<String>,
) -> StringRelocationDiagnostic {
    StringRelocationDiagnostic {
        code: code.into(),
        reference_id: reference_id.map(str::to_string),
        slot_id: slot_id.map(str::to_string),
        byte_range,
        message: message.into(),
        remediation_code: remediation_code.into(),
        remediation: remediation.into(),
    }
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut acc, byte| {
        let _ = write!(acc, "{byte:02x}");
        acc
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Value {
        serde_json::from_str(match name {
            "utf8" => include_str!("../fixtures/offset-map/utf8.json"),
            "shift_jis" => include_str!("../fixtures/offset-map/shift-jis.json"),
            "binary_table" => include_str!("../fixtures/offset-map/binary-table.json"),
            "sliced_buffer" => include_str!("../fixtures/offset-map/sliced-buffer.json"),
            _ => unreachable!(),
        })
        .unwrap()
    }

    fn string_slot_fixture(name: &str) -> Value {
        serde_json::from_str(match name {
            "utf8_fixed" => include_str!("../fixtures/encoded-string-slot/utf8-fixed.json"),
            "utf8_null" => {
                include_str!("../fixtures/encoded-string-slot/utf8-null-terminated.json")
            }
            "shift_jis_fixed" => {
                include_str!("../fixtures/encoded-string-slot/shift-jis-fixed.json")
            }
            "shift_jis_null" => {
                include_str!("../fixtures/encoded-string-slot/shift-jis-null-terminated.json")
            }
            "protected_token" => {
                include_str!("../fixtures/encoded-string-slot/protected-token.json")
            }
            "protected_token_duplicate" => {
                include_str!("../fixtures/encoded-string-slot/protected-token-duplicate.json")
            }
            "protected_token_duplicate_collapsed" => include_str!(
                "../fixtures/encoded-string-slot/protected-token-duplicate-collapsed.json"
            ),
            "protected_token_duplicate_missing" => include_str!(
                "../fixtures/encoded-string-slot/protected-token-duplicate-missing.json"
            ),
            "protected_token_duplicate_extra" => {
                include_str!("../fixtures/encoded-string-slot/protected-token-duplicate-extra.json")
            }
            _ => unreachable!(),
        })
        .unwrap()
    }

    fn string_relocation_fixture(name: &str) -> Value {
        serde_json::from_str(match name {
            "pointer_table" => include_str!("../fixtures/string-relocation/pointer-table.json"),
            "index_table" => include_str!("../fixtures/string-relocation/index-table.json"),
            "pointer_table_wrong_target" => {
                include_str!("../fixtures/string-relocation/pointer-table-wrong-target.json")
            }
            "index_table_wrong_target" => {
                include_str!("../fixtures/string-relocation/index-table-wrong-target.json")
            }
            _ => unreachable!(),
        })
        .unwrap()
    }

    fn typed_string_relocation_fixture(name: &str) -> (StringTableRebuildRequest, String) {
        let mut value = string_relocation_fixture(name);
        let expected = value
            .as_object_mut()
            .unwrap()
            .remove("expectedOutputBytesHex")
            .unwrap()
            .as_str()
            .unwrap()
            .to_string();
        (serde_json::from_value(value).unwrap(), expected)
    }

    fn invalid_string_relocation_fixture(name: &str) -> StringTableRebuildRequest {
        serde_json::from_value(string_relocation_fixture(name)).unwrap()
    }

    fn run_string_slot_fixture(name: &str) -> EncodedStringSlotPreflightReport {
        let value = string_slot_fixture(name);
        let slot: EncodedStringSlot = serde_json::from_value(value["slot"].clone()).unwrap();
        let mappings = value["protectedSpanMappings"]
            .as_array()
            .map(|mappings| {
                mappings
                    .iter()
                    .cloned()
                    .map(serde_json::from_value)
                    .collect::<Result<Vec<ProtectedSpanMapping>, _>>()
            })
            .transpose()
            .unwrap()
            .unwrap_or_default();
        let current_slot_bytes = value["currentSlotBytesHex"]
            .as_str()
            .map(parse_hex_bytes)
            .transpose()
            .unwrap();
        slot.preflight(
            value["targetText"].as_str().unwrap(),
            &mappings,
            current_slot_bytes.as_deref(),
        )
    }

    fn typed_fixture(name: &str) -> OffsetMap {
        let value = fixture(name);
        let validation = validate_offset_map_value(&value);
        assert_eq!(validation.status, OperationStatus::Passed, "{validation:?}");
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn byte_span_rejects_inverted_offsets() {
        let error = ByteSpan::new(10, 9).unwrap_err();
        assert_eq!(error.diagnostics()[0].code, "kaifuu.invalid_offset");
    }

    #[test]
    fn byte_span_deserialization_rejects_inverted_offsets() {
        let error = serde_json::from_value::<ByteSpan>(serde_json::json!({
            "start": 10,
            "end": 9
        }))
        .unwrap_err();
        assert!(error.to_string().contains("kaifuu.invalid_offset"));
    }

    #[test]
    fn validates_utf8_shift_jis_binary_table_and_sliced_buffer_fixtures() {
        for name in ["utf8", "shift_jis", "binary_table", "sliced_buffer"] {
            let value = fixture(name);
            assert_eq!(
                validate_offset_map_value(&value).status,
                OperationStatus::Passed,
                "{name}"
            );
        }
    }

    #[test]
    fn translates_variable_width_source_bytes_without_rounding() {
        let offset_map = typed_fixture("shift_jis");
        assert_eq!(
            offset_map
                .source_to_decoded(ByteSpan::new(0, 2).unwrap())
                .unwrap(),
            ByteSpan::new(0, 3).unwrap()
        );
        let error = offset_map
            .source_to_decoded(ByteSpan::new(1, 2).unwrap())
            .unwrap_err();
        assert_eq!(error.diagnostics()[0].code, "kaifuu.invalid_offset");
    }

    #[test]
    fn translates_source_decoded_and_patched_ranges() {
        let offset_map = typed_fixture("binary_table");
        assert_eq!(
            offset_map
                .source_to_patched(ByteSpan::new(8, 16).unwrap())
                .unwrap(),
            ByteSpan::new(10, 21).unwrap()
        );
        assert_eq!(
            offset_map
                .patched_to_decoded(ByteSpan::new(10, 21).unwrap())
                .unwrap(),
            ByteSpan::new(5, 10).unwrap()
        );
    }

    #[test]
    fn source_range_validation_checks_identity_and_bounds() {
        let offset_map = typed_fixture("sliced_buffer");
        let range = SourceRange::new(
            "script.ks",
            "rev-2026-06-18",
            SourceEncoding::ShiftJis,
            ByteSpan::new(100, 108).unwrap(),
        )
        .unwrap();
        assert_eq!(
            range.validate_against(&offset_map).status,
            OperationStatus::Passed
        );

        let out_of_range = SourceRange::new(
            "script.ks",
            "rev-2026-06-18",
            SourceEncoding::ShiftJis,
            ByteSpan::new(196, 208).unwrap(),
        )
        .unwrap();
        let validation = out_of_range.validate_against(&offset_map);
        assert_eq!(validation.status, OperationStatus::Failed);
        assert_eq!(
            validation.diagnostics[0].code,
            "kaifuu.out_of_range_source_range"
        );
    }

    #[test]
    fn validator_reports_missing_revision_overlap_and_out_of_range_semantics() {
        let mut value = fixture("utf8");
        value.as_object_mut().unwrap().remove("sourceRevisionId");
        value["segments"][1]["sourceBytes"]["start"] = serde_json::json!(0);
        value["segments"][2]["sourceBytes"]["end"] = serde_json::json!(99);

        let validation = validate_offset_map_value(&value);
        let codes = validation
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.code.as_str())
            .collect::<Vec<_>>();
        assert!(codes.contains(&"kaifuu.missing_source_revision_id"));
        assert!(codes.contains(&"kaifuu.overlapping_spans"));
        assert!(codes.contains(&"kaifuu.out_of_range_source_range"));
    }

    #[test]
    fn validator_rejects_detached_decoded_source_axes() {
        let mut value = fixture("utf8");
        value["segments"][0]["sourceBytes"] = serde_json::json!({ "start": 0, "end": 0 });

        let validation = validate_offset_map_value(&value);
        assert_eq!(validation.status, OperationStatus::Failed);
        let codes = validation
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.code.as_str())
            .collect::<Vec<_>>();
        assert!(codes.contains(&"kaifuu.detached_offset_segment"));
    }

    #[test]
    fn offset_map_deserialization_rejects_detached_decoded_source_axes() {
        let mut value = fixture("utf8");
        value["segments"][0]["sourceBytes"] = serde_json::json!({ "start": 0, "end": 0 });

        let error = serde_json::from_value::<OffsetMap>(value).unwrap_err();
        assert!(
            error.to_string().contains("kaifuu.detached_offset_segment"),
            "{error}"
        );
    }

    #[test]
    fn offset_map_segment_constructor_rejects_detached_axes() {
        let error = OffsetMapSegment::new(
            ByteSpan::new(0, 0).unwrap(),
            ByteSpan::new(0, 1).unwrap(),
            ByteSpan::new(0, 1).unwrap(),
        )
        .unwrap_err();
        assert_eq!(
            error.diagnostics()[0].code,
            "kaifuu.detached_offset_segment"
        );
    }

    #[test]
    fn encoded_string_slot_validates_utf8_and_shift_jis_fixture_budgets() {
        for name in [
            "utf8_fixed",
            "utf8_null",
            "shift_jis_fixed",
            "shift_jis_null",
            "protected_token",
            "protected_token_duplicate",
        ] {
            let report = run_string_slot_fixture(name);
            assert_eq!(report.status, OperationStatus::Passed, "{name}: {report:?}");
        }
    }

    /// KAIFUU-150: two identical source protected tokens require EXACTLY two
    /// valid target mappings and occurrences. Under-count (collapsed/missing)
    /// and over-count (extra target occurrence) both fail loud. Distinct-token
    /// fixture still passes.
    #[test]
    fn encoded_string_slot_duplicate_raw_token_fixture_requires_multiplicity() {
        let pass = run_string_slot_fixture("protected_token_duplicate");
        assert_eq!(pass.status, OperationStatus::Passed, "{pass:?}");

        let distinct = run_string_slot_fixture("protected_token");
        assert_eq!(distinct.status, OperationStatus::Passed, "{distinct:?}");

        let collapsed = run_string_slot_fixture("protected_token_duplicate_collapsed");
        assert_eq!(collapsed.status, OperationStatus::Failed);
        assert_eq!(
            collapsed.diagnostics[0].code,
            STRING_SLOT_PROTECTED_SPAN_MUTATION
        );
        assert_eq!(
            collapsed.diagnostics[0].slot_id,
            "duplicate-raw-token-collapsed"
        );
        assert!(
            collapsed.diagnostics[0].message.contains("expected 2"),
            "{collapsed:?}"
        );
        assert!(
            collapsed.diagnostics[0].message.contains("{name}"),
            "{collapsed:?}"
        );
        assert_eq!(
            collapsed.diagnostics[0].remediation_code,
            "restore_protected_span"
        );

        let missing = run_string_slot_fixture("protected_token_duplicate_missing");
        assert_eq!(missing.status, OperationStatus::Failed);
        assert_eq!(
            missing.diagnostics[0].code,
            STRING_SLOT_PROTECTED_SPAN_MUTATION
        );
        assert_eq!(
            missing.diagnostics[0].slot_id,
            "duplicate-raw-token-missing"
        );
        assert!(
            missing.diagnostics[0].message.contains("expected 2"),
            "{missing:?}"
        );
        assert!(
            missing.diagnostics[0].message.contains("{name}"),
            "{missing:?}"
        );
        assert_eq!(
            missing.diagnostics[0].remediation_code,
            "restore_protected_span"
        );

        // Over-count: two required source tokens, three target occurrences, two
        // otherwise-valid mappings — must fail loud (exact multiplicity).
        let extra = run_string_slot_fixture("protected_token_duplicate_extra");
        assert_eq!(extra.status, OperationStatus::Failed);
        assert_eq!(
            extra.diagnostics[0].code,
            STRING_SLOT_PROTECTED_SPAN_MUTATION
        );
        assert_eq!(extra.diagnostics[0].slot_id, "duplicate-raw-token-extra");
        assert!(
            extra.diagnostics[0].message.contains("expected 2"),
            "{extra:?}"
        );
        assert!(extra.diagnostics[0].message.contains("{name}"), "{extra:?}");
        assert!(
            extra.diagnostics[0]
                .message
                .contains("3 target occurrence(s)"),
            "{extra:?}"
        );
        assert_eq!(
            extra.diagnostics[0].remediation_code,
            "restore_protected_span"
        );
    }

    #[test]
    fn encoded_string_slot_reports_overflow_with_slot_range_and_remediation_code() {
        let mut value = string_slot_fixture("utf8_fixed");
        value["targetText"] = serde_json::json!("this text is too long for the slot");
        let slot: EncodedStringSlot = serde_json::from_value(value["slot"].clone()).unwrap();

        let report = slot.preflight(value["targetText"].as_str().unwrap(), &[], None);

        assert_eq!(report.status, OperationStatus::Failed);
        assert_eq!(report.diagnostics[0].code, STRING_SLOT_OVERFLOW);
        assert_eq!(report.diagnostics[0].slot_id, "utf8-fixed-line");
        assert_eq!(
            report.diagnostics[0].byte_range,
            ByteSpan::new(16, 32).unwrap()
        );
        assert_eq!(
            report.diagnostics[0].remediation_code,
            "shorten_translation"
        );
    }

    #[test]
    fn encoded_string_slot_reports_shift_jis_invalid_character() {
        let value = string_slot_fixture("shift_jis_fixed");
        let slot: EncodedStringSlot = serde_json::from_value(value["slot"].clone()).unwrap();

        let report = slot.preflight("hello 🚀", &[], None);

        assert_eq!(report.status, OperationStatus::Failed);
        let diagnostic = &report.diagnostics[0];
        assert_eq!(diagnostic.code, STRING_SLOT_INVALID_ENCODING);
        assert_eq!(diagnostic.remediation_code, "replace_unencodable_character");
        // Typed diagnostic names the slot id and byte range (the crux).
        assert_eq!(diagnostic.slot_id, "sjis-fixed-line");
        assert_eq!(diagnostic.byte_range, ByteSpan::new(128, 140).unwrap());
        // The message pinpoints the offending character and its encoded offset:
        // "hello " is 6 ASCII bytes, so the emoji is char index 6 at byte offset 6.
        assert!(
            diagnostic.message.contains("char index 6"),
            "message should name the offending char index: {}",
            diagnostic.message
        );
        assert!(
            diagnostic.message.contains("encoded byte offset 6"),
            "message should name the encoded byte offset: {}",
            diagnostic.message
        );
    }

    #[test]
    fn encoded_string_slot_accepts_common_shift_jis_kanji_within_budget() {
        // Regression for KAIFUU-148: the KAIFUU-082 hand-coded subset had no
        // kanji, so common game text like 日本語 was wrongly rejected. The
        // encoding_rs Shift-JIS codec maps it to 6 bytes, which fits the
        // 12-byte (128..140) sjis-fixed-line budget.
        let value = string_slot_fixture("shift_jis_fixed");
        let slot: EncodedStringSlot = serde_json::from_value(value["slot"].clone()).unwrap();

        let report = slot.preflight("日本語", &[], None);

        assert_eq!(report.status, OperationStatus::Passed, "{report:?}");
        assert!(report.diagnostics.is_empty(), "{report:?}");
        assert_eq!(encode_shift_jis("日本語").unwrap().len(), 6);
    }

    #[test]
    fn encoded_string_slot_accepts_fullwidth_shift_jis_within_budget() {
        // Fullwidth punctuation / ideographic space were also outside the
        // hand-coded subset. ！？　 is three double-byte characters (6 bytes),
        // fitting the 12-byte budget.
        let value = string_slot_fixture("shift_jis_fixed");
        let slot: EncodedStringSlot = serde_json::from_value(value["slot"].clone()).unwrap();

        let report = slot.preflight("！？　", &[], None);

        assert_eq!(report.status, OperationStatus::Passed, "{report:?}");
        assert!(report.diagnostics.is_empty(), "{report:?}");
        let encoded = encode_shift_jis("！？　").unwrap();
        assert_eq!(encoded.len(), 6);
        // Canonical JIS X 0208 byte sequences (predictable contract).
        assert_eq!(encoded, vec![0x81, 0x49, 0x81, 0x48, 0x81, 0x40]);
    }

    #[test]
    fn encoded_string_slot_rejects_unmappable_shift_jis_with_slot_id_and_byte_range() {
        // U+20BB7 (𠮷, a CJK Extension B ideograph) is a valid Unicode scalar
        // but is not in the Shift-JIS repertoire, so it must reject with a
        // typed diagnostic naming the slot id + byte range, not silently pass.
        let value = string_slot_fixture("shift_jis_fixed");
        let slot: EncodedStringSlot = serde_json::from_value(value["slot"].clone()).unwrap();

        let report = slot.preflight("日\u{20BB7}", &[], None);

        assert_eq!(report.status, OperationStatus::Failed);
        let diagnostic = &report.diagnostics[0];
        assert_eq!(diagnostic.code, STRING_SLOT_INVALID_ENCODING);
        assert_eq!(diagnostic.slot_id, "sjis-fixed-line");
        assert_eq!(diagnostic.byte_range, ByteSpan::new(128, 140).unwrap());
        // 日 encodes to 2 Shift-JIS bytes, so the offending char is index 1 at
        // encoded byte offset 2.
        assert!(
            diagnostic.message.contains("char index 1"),
            "{}",
            diagnostic.message
        );
        assert!(
            diagnostic.message.contains("encoded byte offset 2"),
            "{}",
            diagnostic.message
        );
    }

    #[test]
    fn encoded_string_slot_distinguishes_over_budget_mappable_from_unmappable() {
        // Mappable-but-over-budget must fail on the *budget* (overflow), which
        // is a distinct failure mode from unmappable (invalid encoding). Seven
        // kanji encode to 14 bytes, exceeding the 12-byte fixed-width budget.
        let value = string_slot_fixture("shift_jis_fixed");
        let slot: EncodedStringSlot = serde_json::from_value(value["slot"].clone()).unwrap();

        let report = slot.preflight("日本語日本語日", &[], None);

        assert_eq!(report.status, OperationStatus::Failed);
        let diagnostic = &report.diagnostics[0];
        assert_eq!(diagnostic.code, STRING_SLOT_OVERFLOW);
        assert_eq!(diagnostic.remediation_code, "shorten_translation");
        assert_eq!(diagnostic.slot_id, "sjis-fixed-line");
        assert_eq!(encode_shift_jis("日本語日本語日").unwrap().len(), 14);
    }

    #[test]
    fn encoded_string_slot_reports_terminator_loss() {
        let value = string_slot_fixture("utf8_null");
        let slot: EncodedStringSlot = serde_json::from_value(value["slot"].clone()).unwrap();

        let report = slot.preflight("1234567890123456", &[], Some(b"unterminated"));

        let codes = report
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.code.as_str())
            .collect::<Vec<_>>();
        assert_eq!(report.status, OperationStatus::Failed);
        assert!(codes.contains(&STRING_SLOT_TERMINATOR_LOSS));
        assert!(
            report
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.remediation_code == "preserve_terminator")
        );
    }

    #[test]
    fn encoded_string_slot_reports_protected_span_mutation() {
        let value = string_slot_fixture("protected_token");
        let slot: EncodedStringSlot = serde_json::from_value(value["slot"].clone()).unwrap();

        let report = slot.preflight("Hello, player.", &[], None);

        assert_eq!(report.status, OperationStatus::Failed);
        assert_eq!(
            report.diagnostics[0].code,
            STRING_SLOT_PROTECTED_SPAN_MUTATION
        );
        assert_eq!(report.diagnostics[0].slot_id, "protected-token-line");
        assert_eq!(
            report.diagnostics[0].remediation_code,
            "restore_protected_span"
        );
    }

    #[test]
    fn encoded_string_slot_allows_reordered_distinct_protected_span_mappings() {
        let slot = EncodedStringSlot {
            slot_id: "reordered-placeholders".to_string(),
            encoding: SourceEncoding::Utf8,
            byte_range: ByteSpan::new(0, 64).unwrap(),
            layout: EncodedStringSlotLayout::FixedWidth,
            protected_spans: vec![
                EncodedStringSlotProtectedSpan::new("{item}"),
                EncodedStringSlotProtectedSpan::new("{player}"),
            ],
        };

        let report = slot.preflight(
            "{player} gets {item}",
            &[
                ProtectedSpanMapping::new("{player}", 0, 8),
                ProtectedSpanMapping::new("{item}", 14, 20),
            ],
            None,
        );

        assert_eq!(report.status, OperationStatus::Passed, "{report:?}");
    }

    #[test]
    fn encoded_string_slot_requires_distinct_target_ranges_for_duplicate_raw_spans() {
        let slot = EncodedStringSlot {
            slot_id: "duplicate-placeholders".to_string(),
            encoding: SourceEncoding::Utf8,
            byte_range: ByteSpan::new(0, 64).unwrap(),
            layout: EncodedStringSlotLayout::FixedWidth,
            protected_spans: vec![
                EncodedStringSlotProtectedSpan::new("{name}").with_source_identity(
                    Some("source-span-1"),
                    0,
                    6,
                ),
                EncodedStringSlotProtectedSpan::new("{name}").with_source_identity(
                    Some("source-span-2"),
                    13,
                    19,
                ),
            ],
        };

        let collapsed = slot.preflight(
            "{name} speaks.",
            &[
                ProtectedSpanMapping::new("{name}", 0, 6).with_source_identity(
                    Some("source-span-1"),
                    0,
                    6,
                ),
                ProtectedSpanMapping::new("{name}", 0, 6).with_source_identity(
                    Some("source-span-2"),
                    13,
                    19,
                ),
            ],
            None,
        );
        let explicit = slot.preflight(
            "{name} and {name}",
            &[
                ProtectedSpanMapping::new("{name}", 0, 6).with_source_identity(
                    Some("source-span-1"),
                    0,
                    6,
                ),
                ProtectedSpanMapping::new("{name}", 11, 17).with_source_identity(
                    Some("source-span-2"),
                    13,
                    19,
                ),
            ],
            None,
        );

        assert_eq!(collapsed.status, OperationStatus::Failed);
        assert!(collapsed.diagnostics[0].message.contains("expected 2"));
        assert_eq!(explicit.status, OperationStatus::Passed, "{explicit:?}");
    }

    #[test]
    fn encoded_string_slot_rejects_duplicate_raw_protected_spans_without_source_identity() {
        let slot = EncodedStringSlot {
            slot_id: "duplicate-placeholders".to_string(),
            encoding: SourceEncoding::Utf8,
            byte_range: ByteSpan::new(0, 64).unwrap(),
            layout: EncodedStringSlotLayout::FixedWidth,
            protected_spans: vec![
                EncodedStringSlotProtectedSpan::new("{name}").with_source_identity(
                    Some("source-span-1"),
                    0,
                    6,
                ),
                EncodedStringSlotProtectedSpan::new("{name}").with_source_identity(
                    Some("source-span-2"),
                    13,
                    19,
                ),
            ],
        };

        let missing_identity = slot.preflight(
            "{name} and {name}",
            &[
                ProtectedSpanMapping::new("{name}", 0, 6),
                ProtectedSpanMapping::new("{name}", 11, 17),
            ],
            None,
        );
        let reused_source_identity = slot.preflight(
            "{name} and {name}",
            &[
                ProtectedSpanMapping::new("{name}", 0, 6).with_source_identity(
                    Some("source-span-1"),
                    0,
                    6,
                ),
                ProtectedSpanMapping::new("{name}", 11, 17).with_source_identity(
                    Some("source-span-1"),
                    0,
                    6,
                ),
            ],
            None,
        );
        let wrong_source_identity = slot.preflight(
            "{name} and {name}",
            &[
                ProtectedSpanMapping::new("{name}", 0, 6).with_source_identity(
                    Some("source-span-1"),
                    0,
                    6,
                ),
                ProtectedSpanMapping::new("{name}", 11, 17).with_source_identity(
                    Some("source-span-2"),
                    20,
                    26,
                ),
            ],
            None,
        );

        assert_eq!(missing_identity.status, OperationStatus::Failed);
        assert_eq!(reused_source_identity.status, OperationStatus::Failed);
        assert_eq!(wrong_source_identity.status, OperationStatus::Failed);
    }

    #[test]
    fn string_relocation_rejects_duplicate_raw_protected_spans_without_source_identity() {
        let request = StringTableRebuildRequest {
            fixture_id: "duplicate-protected-relocation".to_string(),
            source_bytes_hex: "00".repeat(32),
            slots: vec![StringRelocationSlot {
                slot_id: "line-1".to_string(),
                encoding: SourceEncoding::Utf8,
                old_byte_range: ByteSpan::new(0, 32).unwrap(),
                layout: EncodedStringSlotLayout::FixedWidth,
                protected_spans: vec![
                    EncodedStringSlotProtectedSpan::new("{name}").with_source_identity(
                        Some("source-span-1"),
                        0,
                        6,
                    ),
                    EncodedStringSlotProtectedSpan::new("{name}").with_source_identity(
                        Some("source-span-2"),
                        13,
                        19,
                    ),
                ],
            }],
            replacements: vec![StringRelocationTarget {
                slot_id: "line-1".to_string(),
                target_text: "{name} and {name}".to_string(),
                protected_span_mappings: vec![
                    ProtectedSpanMapping::new("{name}", 0, 6),
                    ProtectedSpanMapping::new("{name}", 11, 17),
                ],
            }],
            references: vec![],
            string_slot_diagnostics: vec![],
        };

        let report = plan_string_table_rebuild(&request);

        assert_eq!(report.status, OperationStatus::Failed);
        assert!(report.string_slot_diagnostics.iter().any(|diagnostic| {
            diagnostic.code == STRING_SLOT_PROTECTED_SPAN_MUTATION
                && diagnostic.message.contains("expected 2")
        }));
    }

    #[test]
    fn string_relocation_pointer_table_rebuilds_expanded_shortened_and_shared_slots() {
        let (request, expected_output) = typed_string_relocation_fixture("pointer_table");

        let report = plan_string_table_rebuild(&request);

        assert_eq!(report.status, OperationStatus::Passed, "{report:?}");
        assert_eq!(
            report.output_bytes_hex.as_deref(),
            Some(expected_output.as_str())
        );
        assert_eq!(report.relocated_strings.len(), 2);
        assert_eq!(
            report.relocated_strings[0].old_byte_range,
            ByteSpan::new(16, 20).unwrap()
        );
        assert_eq!(
            report.relocated_strings[0].new_byte_range,
            ByteSpan::new(16, 22).unwrap()
        );
        assert_eq!(
            report.relocated_strings[1].old_byte_range,
            ByteSpan::new(20, 26).unwrap()
        );
        assert_eq!(
            report.relocated_strings[1].new_byte_range,
            ByteSpan::new(22, 25).unwrap()
        );

        let shared_targets = report
            .relocated_references
            .iter()
            .filter(|reference| reference.slot_id == "line.shared")
            .map(|reference| reference.target_new_byte_range)
            .collect::<Vec<_>>();
        assert_eq!(
            shared_targets,
            vec![
                ByteSpan::new(22, 25).unwrap(),
                ByteSpan::new(22, 25).unwrap()
            ]
        );
        assert!(report.relocated_references.iter().all(|reference| {
            reference.relocation_kind == StringReferenceRelocationKind::PointerTable
                && reference
                    .output_hash_inputs
                    .iter()
                    .any(|input| input.starts_with("targetNew="))
        }));
        assert!(report.relocated_strings.iter().all(|relocated| {
            relocated
                .output_hash_inputs
                .iter()
                .any(|input| input.starts_with("encodedHash="))
        }));
    }

    #[test]
    fn string_relocation_index_table_rebuilds_same_size_fixture_deterministically() {
        let (request, expected_output) = typed_string_relocation_fixture("index_table");

        let first = plan_string_table_rebuild(&request);
        let second = plan_string_table_rebuild(&request);

        assert_eq!(first.status, OperationStatus::Passed, "{first:?}");
        assert_eq!(first, second);
        assert_eq!(
            first.output_bytes_hex.as_deref(),
            Some(expected_output.as_str())
        );
        assert_eq!(first.relocated_strings.len(), 2);
        assert!(first.relocated_references.iter().all(
            |reference| reference.relocation_kind == StringReferenceRelocationKind::IndexTable
        ));
    }

    #[test]
    fn string_relocation_unsupported_pointer_format_fails_before_output_materialization() {
        let (mut request, _) = typed_string_relocation_fixture("pointer_table");
        request.references[0].format = StringReferenceFormat::Unsupported {
            format_id: "relative24".to_string(),
        };

        let report = plan_string_table_rebuild(&request);

        assert_eq!(report.status, OperationStatus::Failed);
        assert!(report.output_bytes_hex.is_none());
        assert_eq!(
            report.relocation_diagnostics[0].code,
            STRING_RELOCATION_UNSUPPORTED_POINTER_FORMAT
        );
    }

    #[test]
    fn string_relocation_unresolved_reference_fails_before_output_materialization() {
        let (mut request, _) = typed_string_relocation_fixture("pointer_table");
        request.references[0].slot_id = "missing.slot".to_string();

        let report = plan_string_table_rebuild(&request);

        assert_eq!(report.status, OperationStatus::Failed);
        assert!(report.output_bytes_hex.is_none());
        assert!(
            report
                .relocation_diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == STRING_RELOCATION_UNRESOLVED_REFERENCE)
        );
    }

    #[test]
    fn string_relocation_overlapping_writes_fail_before_output_materialization() {
        let (mut request, _) = typed_string_relocation_fixture("pointer_table");
        request.references[0].byte_range = ByteSpan::new(16, 20).unwrap();

        let report = plan_string_table_rebuild(&request);

        assert_eq!(report.status, OperationStatus::Failed);
        assert!(report.output_bytes_hex.is_none());
        assert!(
            report
                .relocation_diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == STRING_RELOCATION_OVERLAPPING_WRITES)
        );
    }

    /// Regression: a genuinely EMPTY source (`sourceBytesHex == ""`) parses
    /// to a zero-length byte vector, which previously gated OFF the slot
    /// bounds check (`source_len != 0`). A positive-offset slot then slipped
    /// through validation into `plan_string_table_rebuild`, where the gap
    /// copy `source_bytes[gap_start..gap_end]` indexed the empty slice and
    /// panicked (OOB). It must now fail with a typed bounds diagnostic
    /// (`kaifuu-offset-map-empty-source-bypasses-bounds-then-oob-panic`).
    #[test]
    fn string_relocation_empty_source_with_positive_offset_slot_fails_typed_not_oob_panic() {
        let (mut request, _) = typed_string_relocation_fixture("pointer_table");
        // Slots in this fixture start at byte offset 16; an empty source can
        // not contain them.
        request.source_bytes_hex = String::new();

        let report = plan_string_table_rebuild(&request);

        assert_eq!(report.status, OperationStatus::Failed, "{report:?}");
        assert!(report.output_bytes_hex.is_none());
        assert!(
            report
                .relocation_diagnostics
                .iter()
                .any(
                    |diagnostic| diagnostic.code == STRING_RELOCATION_UNRESOLVED_REFERENCE
                        && diagnostic.message == "slot byte range exceeds source bytes"
                ),
            "expected a typed slot-bounds diagnostic, got {:?}",
            report.relocation_diagnostics
        );
    }

    /// Regression: a hex PARSE FAILURE must surface its own typed diagnostic
    /// and must NOT collapse to `source_len = 0` (which would disable bounds
    /// checks and risk the empty-source OOB path above). The parse-failure
    /// case is kept distinct from a genuinely empty source.
    #[test]
    fn string_relocation_unparseable_source_fails_typed_distinct_from_empty() {
        let (mut request, _) = typed_string_relocation_fixture("pointer_table");
        // Odd-length, non-hex garbage: cannot parse as hex bytes.
        request.source_bytes_hex = "zz".to_string();

        let report = plan_string_table_rebuild(&request);

        assert_eq!(report.status, OperationStatus::Failed, "{report:?}");
        assert!(report.output_bytes_hex.is_none());
        assert!(
            report
                .relocation_diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == STRING_RELOCATION_INVALID_SOURCE_BYTES),
            "expected a typed invalid-source-bytes diagnostic, got {:?}",
            report.relocation_diagnostics
        );
        // A parse failure must NOT be reported as an in-bounds-only success,
        // and must NOT masquerade as a genuinely empty source (no spurious
        // bounds bypass).
        assert!(
            report
                .relocation_diagnostics
                .iter()
                .all(|diagnostic| diagnostic.message != "slot byte range exceeds source bytes"),
            "parse failure must not also emit empty-source bounds diagnostics: {:?}",
            report.relocation_diagnostics
        );
    }

    #[test]
    fn string_relocation_pointer_table_wrong_source_target_fails_before_output_materialization() {
        let request = invalid_string_relocation_fixture("pointer_table_wrong_target");

        let report = plan_string_table_rebuild(&request);

        assert_eq!(report.status, OperationStatus::Failed);
        assert!(report.output_bytes_hex.is_none());
        assert!(report.output_hash.is_none());
        assert!(
            report.relocation_diagnostics.iter().any(|diagnostic| {
                diagnostic.code == STRING_RELOCATION_POINTER_PROVENANCE_MISMATCH
                    && diagnostic.reference_id.as_deref() == Some("ptr.line.001")
                    && diagnostic.slot_id.as_deref() == Some("line.001")
                    && diagnostic
                        .message
                        .contains("source reference decodes to old target 20")
            }),
            "{report:?}"
        );
        assert!(report.relocated_references.is_empty());
    }

    #[test]
    fn string_relocation_index_table_wrong_source_target_fails_before_output_materialization() {
        let request = invalid_string_relocation_fixture("index_table_wrong_target");

        let report = plan_string_table_rebuild(&request);

        assert_eq!(report.status, OperationStatus::Failed);
        assert!(report.output_bytes_hex.is_none());
        assert!(report.output_hash.is_none());
        assert!(
            report.relocation_diagnostics.iter().any(|diagnostic| {
                diagnostic.code == STRING_RELOCATION_POINTER_PROVENANCE_MISMATCH
                    && diagnostic.reference_id.as_deref() == Some("idx.menu.001")
                    && diagnostic.slot_id.as_deref() == Some("menu.001")
                    && diagnostic
                        .message
                        .contains("index_le_u16 table entries encode")
            }),
            "{report:?}"
        );
        assert!(report.relocated_references.is_empty());
    }

    #[test]
    fn string_relocation_report_composes_with_encoded_string_slot_preflight_diagnostics() {
        let (mut request, _) = typed_string_relocation_fixture("pointer_table");
        request
            .string_slot_diagnostics
            .push(EncodedStringSlotDiagnostic {
                code: STRING_SLOT_OVERFLOW.to_string(),
                slot_id: "line.001".to_string(),
                byte_range: ByteSpan::new(16, 20).unwrap(),
                message: "encoded target exceeded in-place slot budget".to_string(),
                remediation_code: "shorten_translation".to_string(),
                remediation: "shorten the translation or relocate the string".to_string(),
            });

        let report = plan_string_table_rebuild(&request);

        assert_eq!(report.status, OperationStatus::Failed);
        assert_eq!(report.string_slot_diagnostics.len(), 1);
        assert!(report.output_bytes_hex.is_none());
    }

    #[test]
    fn string_relocation_diagnostic_maps_to_preflight_blocking_adapter_failure() {
        let (mut request, _) = typed_string_relocation_fixture("pointer_table");
        request.references[0].format = StringReferenceFormat::Unsupported {
            format_id: "relative24".to_string(),
        };
        let report = plan_string_table_rebuild(&request);
        let failure = crate::AdapterFailure::string_relocation_preflight(
            "kaifuu.fixture",
            "fixture",
            "string-relocation",
            "asset-redacted",
            report.relocation_diagnostics[0].clone(),
        );

        assert_eq!(
            failure.error_code,
            STRING_RELOCATION_UNSUPPORTED_POINTER_FORMAT
        );
        assert!(failure.is_preflight_blocking());
        assert_eq!(
            failure.required_capability,
            Some(crate::Capability::PatchBack)
        );
    }
}
