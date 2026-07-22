use super::*;

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
