use super::*;

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

    pub(super) fn new_unchecked(
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
