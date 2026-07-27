use super::*;

#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerContextV02 {
    pub knowledge_state: String,
    pub speaker_id: Option<String>,
    pub display_name: Option<String>,
    pub canonical_name_ref: Option<String>,
    pub raw_speaker_text: Option<String>,
    pub evidence: Option<String>,
    pub reader_label: Option<String>,
    /// Additive: reader-reveal state (`revealed` / `concealed`) derived from
    /// the matched `#NAMAE` row. Typed so it survives a round-trip through
    /// this contract rather than being dropped as an unknown field.
    pub reveal_state: Option<String>,
    /// Additive: resolved dialogue-text RGB triple. Typed + range-validated
    /// (`0..=255` per channel) so a fabricated colour cannot slip through.
    pub text_color: Option<Value>,
}

impl fmt::Debug for SpeakerContextV02 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SpeakerContextV02")
            .field("knowledge_state", &self.knowledge_state)
            .field("speaker_id", &self.speaker_id)
            .field(
                "display_name",
                &self
                    .display_name
                    .as_deref()
                    .map(RedactedContentSummary::from_text),
            )
            .field("canonical_name_ref", &self.canonical_name_ref)
            .field(
                "raw_speaker_text",
                &self
                    .raw_speaker_text
                    .as_deref()
                    .map(RedactedContentSummary::from_text),
            )
            .field(
                "evidence",
                &self
                    .evidence
                    .as_deref()
                    .map(RedactedContentSummary::from_text),
            )
            .field(
                "reader_label",
                &self
                    .reader_label
                    .as_deref()
                    .map(RedactedContentSummary::from_text),
            )
            .field("reveal_state", &self.reveal_state)
            .field("text_color", &self.text_color)
            .finish()
    }
}

impl SpeakerContextV02 {
    pub(crate) fn validate(&self, label: &str) -> BridgeContractResult<()> {
        assert_one_of(
            &self.knowledge_state,
            &[
                "known",
                "parser_unknown",
                "reader_unknown",
                "not_applicable",
            ],
            &format!("{label}.knowledgeState"),
        )?;
        match self.knowledge_state.as_str() {
            "known" => {
                assert_required_uuid7(self.speaker_id.as_deref(), &format!("{label}.speakerId"))?;
                assert_required_string(
                    self.display_name.as_deref(),
                    &format!("{label}.displayName"),
                )?;
            }
            "reader_unknown" => {
                assert_required_uuid7(self.speaker_id.as_deref(), &format!("{label}.speakerId"))?;
                assert_required_string(
                    self.display_name.as_deref(),
                    &format!("{label}.displayName"),
                )?;
                assert_required_string(
                    self.reader_label.as_deref(),
                    &format!("{label}.readerLabel"),
                )?;
            }
            "parser_unknown" => {
                if let Some(raw) = &self.raw_speaker_text {
                    assert_non_empty(raw, &format!("{label}.rawSpeakerText"))?;
                }
                if let Some(evidence) = &self.evidence {
                    assert_non_empty(evidence, &format!("{label}.evidence"))?;
                }
            }
            "not_applicable" => {}
            _ => unreachable!(),
        }
        if let Some(canonical_name_ref) = &self.canonical_name_ref {
            assert_non_empty(canonical_name_ref, &format!("{label}.canonicalNameRef"))?;
        }
        if let Some(reveal_state) = &self.reveal_state {
            assert_one_of(
                reveal_state,
                &["revealed", "concealed"],
                &format!("{label}.revealState"),
            )?;
        }
        if let Some(text_color) = &self.text_color {
            validate_speaker_text_color(text_color, &format!("{label}.textColor"))?;
        }
        Ok(())
    }
}

/// Validate the additive speaker `textColor`: exactly three 8-bit RGB
/// channels (`0..=255`). Typed + range-checked so a fabricated / out-of-range
/// colour cannot survive this contract as an ignored unknown field.
pub(crate) fn validate_speaker_text_color(value: &Value, label: &str) -> BridgeContractResult<()> {
    let channels = value.as_array().ok_or_else(|| {
        BridgeContractValidationError::new(format!("{label} must be an [r, g, b] array"))
    })?;
    if channels.len() != 3 {
        return Err(BridgeContractValidationError::new(format!(
            "{label} must have exactly 3 channels, got {}",
            channels.len()
        )));
    }
    for (index, channel) in channels.iter().enumerate() {
        let component = channel.as_u64().ok_or_else(|| {
            BridgeContractValidationError::new(format!(
                "{label}[{index}] must be a non-negative integer"
            ))
        })?;
        if component > 255 {
            return Err(BridgeContractValidationError::new(format!(
                "{label}[{index}] must be in 0..=255, got {component}"
            )));
        }
    }
    Ok(())
}

#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeSpanV02 {
    pub span_id: String,
    pub span_kind: String,
    pub raw: String,
    pub start_byte: u64,
    pub end_byte: u64,
    pub preserve_mode: String,
    pub parsed_name: Option<Value>,
    pub arguments: Option<Value>,
    pub variable_name: Option<Value>,
    pub format_hint: Option<Value>,
    pub example_values: Option<Value>,
    pub base_start_byte: Option<Value>,
    pub base_end_byte: Option<Value>,
    pub annotation_start_byte: Option<Value>,
    pub annotation_end_byte: Option<Value>,
    pub annotation_text: Option<Value>,
    pub annotation_locale: Option<Value>,
    pub display_mode: Option<Value>,
    pub policy: Option<Value>,
}

impl fmt::Debug for BridgeSpanV02 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let metadata = [
            ("parsed_name", self.parsed_name.as_ref()),
            ("arguments", self.arguments.as_ref()),
            ("variable_name", self.variable_name.as_ref()),
            ("format_hint", self.format_hint.as_ref()),
            ("example_values", self.example_values.as_ref()),
            ("base_start_byte", self.base_start_byte.as_ref()),
            ("base_end_byte", self.base_end_byte.as_ref()),
            ("annotation_start_byte", self.annotation_start_byte.as_ref()),
            ("annotation_end_byte", self.annotation_end_byte.as_ref()),
            ("annotation_text", self.annotation_text.as_ref()),
            ("annotation_locale", self.annotation_locale.as_ref()),
            ("display_mode", self.display_mode.as_ref()),
            ("policy", self.policy.as_ref()),
        ]
        .into_iter()
        .map(|(name, value)| {
            (
                name,
                value.map(|value| RedactedContentSummary::from_text(&value.to_string())),
            )
        })
        .collect::<BTreeMap<_, _>>();
        formatter
            .debug_struct("BridgeSpanV02")
            .field("span_id", &self.span_id)
            .field("span_kind", &self.span_kind)
            .field("raw", &RedactedContentSummary::from_text(&self.raw))
            .field("start_byte", &self.start_byte)
            .field("end_byte", &self.end_byte)
            .field("preserve_mode", &self.preserve_mode)
            .field("metadata", &metadata)
            .finish()
    }
}

impl BridgeSpanV02 {
    pub(crate) fn validate(&self, label: &str, source_text: &str) -> BridgeContractResult<()> {
        assert_uuid7(&self.span_id, &format!("{label}.spanId"))?;
        assert_one_of(
            &self.span_kind,
            &["control_markup", "variable_placeholder", "ruby_annotation"],
            &format!("{label}.spanKind"),
        )?;
        assert_non_empty(&self.raw, &format!("{label}.raw"))?;
        assert_one_of(
            &self.preserve_mode,
            &["exact", "map", "transform", "locale_policy"],
            &format!("{label}.preserveMode"),
        )?;
        assert_optional_value_string(self.parsed_name.as_ref(), &format!("{label}.parsedName"))?;
        if let Some(arguments) = &self.arguments {
            assert_value_string_array(arguments, &format!("{label}.arguments"))?;
        }
        assert_optional_value_string(
            self.variable_name.as_ref(),
            &format!("{label}.variableName"),
        )?;
        assert_optional_value_string(self.format_hint.as_ref(), &format!("{label}.formatHint"))?;
        if let Some(example_values) = &self.example_values {
            assert_value_string_array(example_values, &format!("{label}.exampleValues"))?;
        }
        if self.end_byte <= self.start_byte {
            return Err(BridgeContractValidationError::new(format!(
                "{label}.endByte must be greater than {label}.startByte"
            )));
        }
        let start = self.start_byte as usize;
        let end = self.end_byte as usize;
        let source_bytes = source_text.as_bytes();
        if end > source_bytes.len() {
            return Err(BridgeContractValidationError::new(format!(
                "{label}.endByte must be within sourceText UTF-8 bytes"
            )));
        }
        if &source_bytes[start..end] != self.raw.as_bytes() {
            return Err(BridgeContractValidationError::new(format!(
                "{label}.raw must match sourceText byte range"
            )));
        }
        if let Some(policy) = &self.policy {
            assert_localization_policy_v02(policy, &format!("{label}.policy"))?;
        }
        if self.span_kind == "ruby_annotation" {
            assert_value_byte_range(
                self.base_start_byte.as_ref(),
                self.base_end_byte.as_ref(),
                &format!("{label}.base"),
            )?;
            assert_value_byte_range(
                self.annotation_start_byte.as_ref(),
                self.annotation_end_byte.as_ref(),
                &format!("{label}.annotation"),
            )?;
            assert_required_value_string(
                self.annotation_text.as_ref(),
                &format!("{label}.annotationText"),
            )?;
            assert_optional_value_string(
                self.annotation_locale.as_ref(),
                &format!("{label}.annotationLocale"),
            )?;
            assert_optional_value_string(
                self.display_mode.as_ref(),
                &format!("{label}.displayMode"),
            )?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchRefV02 {
    pub asset_id: String,
    pub write_mode: String,
    pub source_unit_key: String,
    pub source_revision: SourceRevisionV02,
    pub constraints: Option<Vec<String>>,
}

impl PatchRefV02 {
    pub(crate) fn validate(&self, label: &str) -> BridgeContractResult<()> {
        assert_uuid7(&self.asset_id, &format!("{label}.assetId"))?;
        assert_one_of(
            &self.write_mode,
            &[
                "replace",
                "insert",
                "update_region",
                "replace_asset",
                "metadata",
            ],
            &format!("{label}.writeMode"),
        )?;
        assert_non_empty(&self.source_unit_key, &format!("{label}.sourceUnitKey"))?;
        self.source_revision
            .validate(&format!("{label}.sourceRevision"))?;
        if let Some(constraints) = &self.constraints {
            for (index, constraint) in constraints.iter().enumerate() {
                assert_non_empty(constraint, &format!("{label}.constraints[{index}]"))?;
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeExpectationV02 {
    pub expectation_kind: String,
    pub region: Option<Value>,
    pub trace_key: Option<Value>,
}

impl RuntimeExpectationV02 {
    pub(crate) fn validate(&self, label: &str) -> BridgeContractResult<()> {
        assert_one_of(
            &self.expectation_kind,
            &[
                "trace_text",
                "layout_probe",
                "screenshot_region",
                "metadata_only",
            ],
            &format!("{label}.expectationKind"),
        )?;
        if let Some(region) = &self.region {
            assert_pixel_region_v02(region, &format!("{label}.region"))?;
        }
        if let Some(trace_key) = &self.trace_key {
            assert_value_string(trace_key, &format!("{label}.traceKey"))?;
        }
        Ok(())
    }
}
