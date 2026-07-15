use std::fmt;

use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::OperationStatus;

mod encoded_string_slot;
mod string_relocation_encode;
mod string_relocation_plan;
mod string_relocation_types;

pub use encoded_string_slot::{
    EncodedStringSlot, EncodedStringSlotDiagnostic, EncodedStringSlotLayout,
    EncodedStringSlotPreflightReport, EncodedStringSlotProtectedSpan, parse_hex_bytes,
};
// Sibling modules import these helpers via `super::`.
#[cfg(test)]
pub(crate) use encoded_string_slot::encode_shift_jis;
pub(crate) use encoded_string_slot::{
    contains_bytes, count_protected_token_occurrences, encode_string,
    protected_span_source_identity_matches,
};

pub use string_relocation_plan::plan_string_table_rebuild;
pub use string_relocation_types::{
    RelocatedString, RelocatedStringReference, StringReferenceFormat,
    StringReferenceRelocationKind, StringRelocationDiagnostic, StringRelocationPlanReport,
    StringRelocationReference, StringRelocationSlot, StringRelocationTarget,
    StringTableRebuildRequest,
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

#[cfg(test)]
mod tests {
    use super::*;

    use crate::{
        ProtectedSpanMapping, STRING_RELOCATION_INVALID_SOURCE_BYTES,
        STRING_RELOCATION_OVERLAPPING_WRITES, STRING_RELOCATION_POINTER_PROVENANCE_MISMATCH,
        STRING_RELOCATION_UNRESOLVED_REFERENCE, STRING_RELOCATION_UNSUPPORTED_POINTER_FORMAT,
        STRING_SLOT_INVALID_ENCODING, STRING_SLOT_OVERFLOW, STRING_SLOT_PROTECTED_SPAN_MUTATION,
        STRING_SLOT_TERMINATOR_LOSS,
    };

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

    /// two identical source protected tokens require EXACTLY two
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
            collapsed.diagnostics[0].message.contains("sha256"),
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
            missing.diagnostics[0].message.contains("sha256"),
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
        assert!(extra.diagnostics[0].message.contains("sha256"), "{extra:?}");
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
        // Regression: the hand-coded subset had no
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
    /// bounds check (`source_len!= 0`). A positive-offset slot then slipped
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
