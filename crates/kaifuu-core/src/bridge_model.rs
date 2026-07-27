use super::*;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractionResult {
    pub adapter_id: String,
    pub profile: GameProfile,
    pub bridge: BridgeBundle,
    pub warnings: Vec<AdapterWarning>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeBundle {
    pub schema_version: String,
    pub bridge_id: String,
    pub source_bundle_hash: String,
    pub source_locale: String,
    pub extractor_name: String,
    pub extractor_version: String,
    pub units: Vec<BridgeUnit>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeUnit {
    pub bridge_unit_id: String,
    pub source_unit_key: String,
    pub occurrence_id: String,
    pub source_hash: String,
    pub source_locale: String,
    pub source_text: String,
    pub speaker: String,
    pub text_surface: String,
    pub protected_spans: Vec<ProtectedSpan>,
    pub patch_ref: PatchRef,
}

impl fmt::Debug for BridgeUnit {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BridgeUnit")
            .field("bridge_unit_id", &self.bridge_unit_id)
            .field("source_unit_key", &self.source_unit_key)
            .field("occurrence_id", &self.occurrence_id)
            .field("source_hash", &self.source_hash)
            .field("source_locale", &self.source_locale)
            .field(
                "source_text",
                &RedactedContentSummary::from_text(&self.source_text),
            )
            .field("speaker", &RedactedContentSummary::from_text(&self.speaker))
            .field("text_surface", &self.text_surface)
            .field("protected_spans", &self.protected_spans)
            .field("patch_ref", &self.patch_ref)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectedSpan {
    #[serde(skip)]
    pub span_id: Option<String>,
    pub kind: String,
    pub raw: String,
    pub start: u64,
    pub end: u64,
    pub preserve_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parsed_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arguments: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variable_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format_hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub example_values: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_start_byte: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_end_byte: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub annotation_start_byte: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub annotation_end_byte: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub annotation_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub annotation_locale: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_mode: Option<String>,
}

impl fmt::Debug for ProtectedSpan {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let arguments = self
            .arguments
            .as_ref()
            .map(|arguments| RedactedContentSummary::from_text(&arguments.join("\u{1f}")));
        let example_values = self
            .example_values
            .as_ref()
            .map(|values| RedactedContentSummary::from_text(&values.join("\u{1f}")));
        formatter
            .debug_struct("ProtectedSpan")
            .field("span_id", &self.span_id)
            .field("kind", &self.kind)
            .field("raw", &RedactedContentSummary::from_text(&self.raw))
            .field("start", &self.start)
            .field("end", &self.end)
            .field("preserve_mode", &self.preserve_mode)
            .field("parsed_name", &self.parsed_name)
            .field("arguments", &arguments)
            .field(
                "variable_name",
                &self
                    .variable_name
                    .as_deref()
                    .map(RedactedContentSummary::from_text),
            )
            .field(
                "format_hint",
                &self
                    .format_hint
                    .as_deref()
                    .map(RedactedContentSummary::from_text),
            )
            .field("example_values", &example_values)
            .field("base_start_byte", &self.base_start_byte)
            .field("base_end_byte", &self.base_end_byte)
            .field("annotation_start_byte", &self.annotation_start_byte)
            .field("annotation_end_byte", &self.annotation_end_byte)
            .field(
                "annotation_text",
                &self
                    .annotation_text
                    .as_deref()
                    .map(RedactedContentSummary::from_text),
            )
            .field(
                "annotation_locale",
                &self
                    .annotation_locale
                    .as_deref()
                    .map(RedactedContentSummary::from_text),
            )
            .field(
                "display_mode",
                &self
                    .display_mode
                    .as_deref()
                    .map(RedactedContentSummary::from_text),
            )
            .finish()
    }
}

impl ProtectedSpan {
    pub fn new(
        kind: impl Into<String>,
        raw: impl Into<String>,
        start: u64,
        end: u64,
        preserve_mode: impl Into<String>,
    ) -> Self {
        Self {
            span_id: None,
            kind: kind.into(),
            raw: raw.into(),
            start,
            end,
            preserve_mode: preserve_mode.into(),
            parsed_name: None,
            arguments: None,
            variable_name: None,
            format_hint: None,
            example_values: None,
            base_start_byte: None,
            base_end_byte: None,
            annotation_start_byte: None,
            annotation_end_byte: None,
            annotation_text: None,
            annotation_locale: None,
            display_mode: None,
        }
    }

    pub fn variable_placeholder(
        raw: impl Into<String>,
        start: u64,
        end: u64,
        variable_name: impl Into<String>,
    ) -> Self {
        let variable_name = variable_name.into();
        let mut span = Self::new("variable_placeholder", raw, start, end, "map");
        span.variable_name = Some(variable_name);
        span
    }

    pub fn control_markup(
        raw: impl Into<String>,
        start: u64,
        end: u64,
        parsed_name: impl Into<String>,
        arguments: Vec<String>,
    ) -> Self {
        let mut span = Self::new("control_markup", raw, start, end, "exact");
        span.parsed_name = Some(parsed_name.into());
        if !arguments.is_empty() {
            span.arguments = Some(arguments);
        }
        span
    }

    pub fn with_span_id(mut self, span_id: impl Into<String>) -> Self {
        self.span_id = Some(span_id.into());
        self
    }

    pub(crate) fn normalized(mut self, source_text: &str) -> KaifuuResult<Self> {
        let original_kind = self.kind.clone();
        self.kind = normalize_protected_span_kind(&self.kind)
            .ok_or_else(|| format!("unsupported protected span kind {}", self.kind))?
            .to_string();
        if self.preserve_mode.trim().is_empty()
            || original_kind == "placeholder"
            || (self.kind == "variable_placeholder" && self.preserve_mode == "exact")
        {
            self.preserve_mode = default_preserve_mode_for_span_kind(&self.kind).to_string();
        }
        if !["exact", "map", "transform", "locale_policy"].contains(&self.preserve_mode.as_str()) {
            return Err(format!(
                "unsupported protected span preserveMode {}",
                self.preserve_mode
            )
            .into());
        }
        self.raw = source_slice_for_span(source_text, self.start, self.end, &self.raw)?.to_string();
        if self.kind == "variable_placeholder" && self.variable_name.is_none() {
            self.variable_name = variable_name_from_raw_placeholder(&self.raw);
        }
        self.arguments = normalize_non_empty_string_vec(self.arguments);
        self.example_values = normalize_non_empty_string_vec(self.example_values);
        Ok(self)
    }

    pub(crate) fn merge_missing_metadata_from(&mut self, other: &Self) {
        if self.parsed_name.is_none() {
            self.parsed_name.clone_from(&other.parsed_name);
        }
        if self.arguments.is_none() {
            self.arguments.clone_from(&other.arguments);
        }
        if self.variable_name.is_none() {
            self.variable_name.clone_from(&other.variable_name);
        }
        if self.format_hint.is_none() {
            self.format_hint.clone_from(&other.format_hint);
        }
        if self.example_values.is_none() {
            self.example_values.clone_from(&other.example_values);
        }
        if self.base_start_byte.is_none() {
            self.base_start_byte = other.base_start_byte;
        }
        if self.base_end_byte.is_none() {
            self.base_end_byte = other.base_end_byte;
        }
        if self.annotation_start_byte.is_none() {
            self.annotation_start_byte = other.annotation_start_byte;
        }
        if self.annotation_end_byte.is_none() {
            self.annotation_end_byte = other.annotation_end_byte;
        }
        if self.annotation_text.is_none() {
            self.annotation_text.clone_from(&other.annotation_text);
        }
        if self.annotation_locale.is_none() {
            self.annotation_locale.clone_from(&other.annotation_locale);
        }
        if self.display_mode.is_none() {
            self.display_mode.clone_from(&other.display_mode);
        }
    }
}

pub fn normalize_protected_spans(
    source_text: &str,
    spans: Vec<ProtectedSpan>,
) -> KaifuuResult<Vec<ProtectedSpan>> {
    let mut normalized = spans
        .into_iter()
        .map(|span| span.normalized(source_text))
        .collect::<KaifuuResult<Vec<_>>>()?;
    normalized.sort_by_key(|span| {
        (
            span.start,
            span.end,
            span.kind.clone(),
            span.raw.clone(),
            span.parsed_name.clone(),
        )
    });

    let mut merged: Vec<ProtectedSpan> = Vec::new();
    for span in normalized {
        if let Some(existing) = merged.last_mut()
            && existing.start == span.start
            && existing.end == span.end
            && existing.kind == span.kind
            && existing.raw == span.raw
        {
            existing.merge_missing_metadata_from(&span);
            continue;
        }
        if let Some(previous) = merged.last()
            && previous.end > span.start
        {
            return Err(format!(
                "protected spans must not overlap: {}..{} overlaps {}..{}",
                previous.start, previous.end, span.start, span.end
            )
            .into());
        }
        merged.push(span);
    }

    Ok(merged)
}

pub(crate) fn normalize_protected_span_kind(kind: &str) -> Option<&'static str> {
    match kind {
        "control_markup" => Some("control_markup"),
        "variable_placeholder" | "placeholder" => Some("variable_placeholder"),
        "ruby_annotation" => Some("ruby_annotation"),
        _ => None,
    }
}

pub(crate) fn default_preserve_mode_for_span_kind(kind: &str) -> &'static str {
    match kind {
        "variable_placeholder" => "map",
        "ruby_annotation" => "locale_policy",
        _ => "exact",
    }
}

pub(crate) fn normalize_non_empty_string_vec(values: Option<Vec<String>>) -> Option<Vec<String>> {
    let values = values?
        .into_iter()
        .filter(|value| !value.trim().is_empty())
        .collect::<Vec<_>>();
    if values.is_empty() {
        None
    } else {
        Some(values)
    }
}

pub(crate) fn source_slice_for_span<'a>(
    source_text: &'a str,
    start: u64,
    end: u64,
    expected_raw: &str,
) -> KaifuuResult<&'a str> {
    if end <= start {
        return Err("protected span end must be greater than start".into());
    }
    let start = usize::try_from(start).map_err(|_| "protected span start is too large")?;
    let end = usize::try_from(end).map_err(|_| "protected span end is too large")?;
    if end > source_text.len() {
        return Err("protected span end must be within sourceText bytes".into());
    }
    if !source_text.is_char_boundary(start) || !source_text.is_char_boundary(end) {
        return Err("protected span boundaries must align to UTF-8 character boundaries".into());
    }
    let actual = &source_text[start..end];
    if actual != expected_raw {
        let expected = RedactedContentSummary::from_text(expected_raw);
        let observed = RedactedContentSummary::from_text(actual);
        return Err(format!(
            "protected span raw {expected} must match sourceText byte range {start}..{end} ({observed})"
        )
        .into());
    }
    Ok(actual)
}

pub(crate) fn variable_name_from_raw_placeholder(raw: &str) -> Option<String> {
    raw.strip_prefix('{')
        .and_then(|value| value.strip_suffix('}'))
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchRef {
    pub asset_id: String,
    pub write_mode: String,
    pub source_unit_key: String,
}

#[derive(Clone, PartialEq, Eq)]
pub struct BridgeContractValidationError {
    message: String,
    code: Option<&'static str>,
}

impl fmt::Debug for BridgeContractValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BridgeContractValidationError")
            .field("message", &RedactedContentSummary::from_text(&self.message))
            .field("code", &self.code)
            .finish()
    }
}

impl BridgeContractValidationError {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: None,
        }
    }

    /// Construct a rejection that carries a stable, cross-language semantic
    /// code so callers can branch on the failure category rather than parsing
    /// the human-readable message.
    pub(crate) fn with_code(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: Some(code),
        }
    }

    /// The stable semantic code for this rejection, when one has been assigned
    /// (for example [`SEMANTIC_RFC3339_INSTANT_MALFORMED`]).
    #[must_use]
    pub fn code(&self) -> Option<&'static str> {
        self.code
    }

    /// The human-readable rejection message.
    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for BridgeContractValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for BridgeContractValidationError {}

pub type BridgeContractResult<T> = Result<T, BridgeContractValidationError>;
