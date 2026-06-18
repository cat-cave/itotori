use std::fmt;

use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::OperationStatus;

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
    match value.and_then(Value::as_u64) {
        Some(value) => Some(value),
        None => {
            diagnostics.push(OffsetMapDiagnostic::new(
                "kaifuu.invalid_offset",
                field,
                format!("{field} must be a non-negative integer"),
            ));
            None
        }
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
}
