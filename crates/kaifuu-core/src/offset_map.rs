use std::fmt;

use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    OperationStatus, ProtectedSpanMapping, STRING_SLOT_INVALID_ENCODING, STRING_SLOT_OVERFLOW,
    STRING_SLOT_PROTECTED_SPAN_MUTATION, STRING_SLOT_TERMINATOR_LOSS,
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

    fn validate_protected_spans(
        &self,
        target_text: &str,
        protected_span_mappings: &[ProtectedSpanMapping],
        diagnostics: &mut Vec<EncodedStringSlotDiagnostic>,
    ) {
        for protected_span in &self.protected_spans {
            let mapped = protected_span_mappings
                .iter()
                .filter(|mapping| mapping.raw == protected_span.raw)
                .collect::<Vec<_>>();
            if mapped.is_empty() {
                diagnostics.push(self.diagnostic(
                    STRING_SLOT_PROTECTED_SPAN_MUTATION,
                    format!(
                        "protected span {:?} is missing from protectedSpanMappings",
                        protected_span.raw
                    ),
                    "restore_protected_span",
                    "preserve the protected token and include a matching protectedSpanMappings entry",
                ));
                continue;
            }
            if !mapped
                .iter()
                .any(|mapping| mapping.matches_target_text(target_text))
            {
                diagnostics.push(self.diagnostic(
                    STRING_SLOT_PROTECTED_SPAN_MUTATION,
                    format!(
                        "protected span {:?} mapping does not match targetText",
                        protected_span.raw
                    ),
                    "restore_protected_span",
                    "align protectedSpanMappings with the protected token in targetText",
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
}

impl EncodedStringSlotProtectedSpan {
    pub fn new(raw: impl Into<String>) -> Self {
        Self { raw: raw.into() }
    }
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

fn encode_string(value: &str, encoding: SourceEncoding) -> Result<Vec<u8>, String> {
    match encoding {
        SourceEncoding::Utf8 | SourceEncoding::Binary | SourceEncoding::BinaryTable => {
            Ok(value.as_bytes().to_vec())
        }
        SourceEncoding::ShiftJis => encode_shift_jis(value),
    }
}

fn encode_shift_jis(value: &str) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    for character in value.chars() {
        if character.is_ascii() {
            bytes.push(character as u8);
            continue;
        }
        let codepoint = character as u32;
        if (0xff61..=0xff9f).contains(&codepoint) {
            bytes.push((codepoint - 0xff61 + 0xa1) as u8);
            continue;
        }
        if let Some(pair) = shift_jis_common_pair(character) {
            bytes.extend(pair);
            continue;
        }
        return Err(format!(
            "character U+{codepoint:04X} is not representable by the supported Shift-JIS preflight table"
        ));
    }
    Ok(bytes)
}

fn shift_jis_common_pair(character: char) -> Option<[u8; 2]> {
    let pair = match character {
        '　' => [0x81, 0x40],
        '、' => [0x81, 0x41],
        '。' => [0x81, 0x42],
        '，' => [0x81, 0x43],
        '．' => [0x81, 0x44],
        '・' => [0x81, 0x45],
        'ー' => [0x81, 0x5b],
        '「' => [0x81, 0x75],
        '」' => [0x81, 0x76],
        '『' => [0x81, 0x77],
        '』' => [0x81, 0x78],
        'ぁ' => [0x82, 0x9f],
        'あ' => [0x82, 0xa0],
        'ぃ' => [0x82, 0xa1],
        'い' => [0x82, 0xa2],
        'ぅ' => [0x82, 0xa3],
        'う' => [0x82, 0xa4],
        'ぇ' => [0x82, 0xa5],
        'え' => [0x82, 0xa6],
        'ぉ' => [0x82, 0xa7],
        'お' => [0x82, 0xa8],
        'か' => [0x82, 0xa9],
        'が' => [0x82, 0xaa],
        'き' => [0x82, 0xab],
        'ぎ' => [0x82, 0xac],
        'く' => [0x82, 0xad],
        'ぐ' => [0x82, 0xae],
        'け' => [0x82, 0xaf],
        'げ' => [0x82, 0xb0],
        'こ' => [0x82, 0xb1],
        'ご' => [0x82, 0xb2],
        'さ' => [0x82, 0xb3],
        'ざ' => [0x82, 0xb4],
        'し' => [0x82, 0xb5],
        'じ' => [0x82, 0xb6],
        'す' => [0x82, 0xb7],
        'ず' => [0x82, 0xb8],
        'せ' => [0x82, 0xb9],
        'ぜ' => [0x82, 0xba],
        'そ' => [0x82, 0xbb],
        'ぞ' => [0x82, 0xbc],
        'た' => [0x82, 0xbd],
        'だ' => [0x82, 0xbe],
        'ち' => [0x82, 0xbf],
        'ぢ' => [0x82, 0xc0],
        'っ' => [0x82, 0xc1],
        'つ' => [0x82, 0xc2],
        'づ' => [0x82, 0xc3],
        'て' => [0x82, 0xc4],
        'で' => [0x82, 0xc5],
        'と' => [0x82, 0xc6],
        'ど' => [0x82, 0xc7],
        'な' => [0x82, 0xc8],
        'に' => [0x82, 0xc9],
        'ぬ' => [0x82, 0xca],
        'ね' => [0x82, 0xcb],
        'の' => [0x82, 0xcc],
        'は' => [0x82, 0xcd],
        'ば' => [0x82, 0xce],
        'ぱ' => [0x82, 0xcf],
        'ひ' => [0x82, 0xd0],
        'び' => [0x82, 0xd1],
        'ぴ' => [0x82, 0xd2],
        'ふ' => [0x82, 0xd3],
        'ぶ' => [0x82, 0xd4],
        'ぷ' => [0x82, 0xd5],
        'へ' => [0x82, 0xd6],
        'べ' => [0x82, 0xd7],
        'ぺ' => [0x82, 0xd8],
        'ほ' => [0x82, 0xd9],
        'ぼ' => [0x82, 0xda],
        'ぽ' => [0x82, 0xdb],
        'ま' => [0x82, 0xdc],
        'み' => [0x82, 0xdd],
        'む' => [0x82, 0xde],
        'め' => [0x82, 0xdf],
        'も' => [0x82, 0xe0],
        'ゃ' => [0x82, 0xe1],
        'や' => [0x82, 0xe2],
        'ゅ' => [0x82, 0xe3],
        'ゆ' => [0x82, 0xe4],
        'ょ' => [0x82, 0xe5],
        'よ' => [0x82, 0xe6],
        'ら' => [0x82, 0xe7],
        'り' => [0x82, 0xe8],
        'る' => [0x82, 0xe9],
        'れ' => [0x82, 0xea],
        'ろ' => [0x82, 0xeb],
        'ゎ' => [0x82, 0xec],
        'わ' => [0x82, 0xed],
        'を' => [0x82, 0xf0],
        'ん' => [0x82, 0xf1],
        'ァ' => [0x83, 0x40],
        'ア' => [0x83, 0x41],
        'ィ' => [0x83, 0x42],
        'イ' => [0x83, 0x43],
        'ゥ' => [0x83, 0x44],
        'ウ' => [0x83, 0x45],
        'ェ' => [0x83, 0x46],
        'エ' => [0x83, 0x47],
        'ォ' => [0x83, 0x48],
        'オ' => [0x83, 0x49],
        'カ' => [0x83, 0x4a],
        'ガ' => [0x83, 0x4b],
        'キ' => [0x83, 0x4c],
        'ギ' => [0x83, 0x4d],
        'ク' => [0x83, 0x4e],
        'グ' => [0x83, 0x4f],
        'ケ' => [0x83, 0x50],
        'ゲ' => [0x83, 0x51],
        'コ' => [0x83, 0x52],
        'ゴ' => [0x83, 0x53],
        'サ' => [0x83, 0x54],
        'ザ' => [0x83, 0x55],
        'シ' => [0x83, 0x56],
        'ジ' => [0x83, 0x57],
        'ス' => [0x83, 0x58],
        'ズ' => [0x83, 0x59],
        'セ' => [0x83, 0x5a],
        'ゼ' => [0x83, 0x5b],
        'ソ' => [0x83, 0x5c],
        'ゾ' => [0x83, 0x5d],
        'タ' => [0x83, 0x5e],
        'ダ' => [0x83, 0x5f],
        'チ' => [0x83, 0x60],
        'ヂ' => [0x83, 0x61],
        'ッ' => [0x83, 0x62],
        'ツ' => [0x83, 0x63],
        'ヅ' => [0x83, 0x64],
        'テ' => [0x83, 0x65],
        'デ' => [0x83, 0x66],
        'ト' => [0x83, 0x67],
        'ド' => [0x83, 0x68],
        'ナ' => [0x83, 0x69],
        'ニ' => [0x83, 0x6a],
        'ヌ' => [0x83, 0x6b],
        'ネ' => [0x83, 0x6c],
        'ノ' => [0x83, 0x6d],
        'ハ' => [0x83, 0x6e],
        'バ' => [0x83, 0x6f],
        'パ' => [0x83, 0x70],
        'ヒ' => [0x83, 0x71],
        'ビ' => [0x83, 0x72],
        'ピ' => [0x83, 0x73],
        'フ' => [0x83, 0x74],
        'ブ' => [0x83, 0x75],
        'プ' => [0x83, 0x76],
        'ヘ' => [0x83, 0x77],
        'ベ' => [0x83, 0x78],
        'ペ' => [0x83, 0x79],
        'ホ' => [0x83, 0x7a],
        'ボ' => [0x83, 0x7b],
        'ポ' => [0x83, 0x7c],
        'マ' => [0x83, 0x7d],
        'ミ' => [0x83, 0x7e],
        'ム' => [0x83, 0x80],
        'メ' => [0x83, 0x81],
        'モ' => [0x83, 0x82],
        'ャ' => [0x83, 0x83],
        'ヤ' => [0x83, 0x84],
        'ュ' => [0x83, 0x85],
        'ユ' => [0x83, 0x86],
        'ョ' => [0x83, 0x87],
        'ヨ' => [0x83, 0x88],
        'ラ' => [0x83, 0x89],
        'リ' => [0x83, 0x8a],
        'ル' => [0x83, 0x8b],
        'レ' => [0x83, 0x8c],
        'ロ' => [0x83, 0x8d],
        'ヮ' => [0x83, 0x8e],
        'ワ' => [0x83, 0x8f],
        'ヲ' => [0x83, 0x92],
        'ン' => [0x83, 0x93],
        'ヴ' => [0x83, 0x94],
        _ => return None,
    };
    Some(pair)
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
            _ => unreachable!(),
        })
        .unwrap()
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
        ] {
            let report = run_string_slot_fixture(name);
            assert_eq!(report.status, OperationStatus::Passed, "{name}: {report:?}");
        }
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
        assert_eq!(report.diagnostics[0].code, STRING_SLOT_INVALID_ENCODING);
        assert_eq!(
            report.diagnostics[0].remediation_code,
            "replace_unencodable_character"
        );
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
}
