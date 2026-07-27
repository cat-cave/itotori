use super::*;

impl GoldenRoundTripReport {
    pub fn redacted_for_report(&self) -> Self {
        let mut report = self.clone();
        report.report_id = redact_for_log_or_report(&report.report_id);
        report.adapter_id = redact_for_log_or_report(&report.adapter_id);
        report.adapter_name = redact_for_log_or_report(&report.adapter_name);
        report.phases = report
            .phases
            .iter()
            .map(GoldenPhaseReport::redacted_for_report)
            .collect();
        report.failures = report
            .failures
            .iter()
            .map(GoldenFailure::redacted_for_report)
            .collect();
        report
    }
}

impl GoldenPhaseReport {
    pub(crate) fn redacted_for_report(&self) -> Self {
        Self {
            phase: redact_for_log_or_report(&self.phase),
            status: self.status.clone(),
            details: redact_for_log_or_report(&self.details),
            asset_ref: self.asset_ref.as_deref().map(redact_asset_ref_for_report),
            source_unit_key: self
                .source_unit_key
                .as_deref()
                .map(redact_for_log_or_report),
            support_boundary: self
                .support_boundary
                .as_deref()
                .map(redact_for_log_or_report),
            expected: self.expected.as_deref().map(redact_for_log_or_report),
            actual: self.actual.as_deref().map(redact_for_log_or_report),
            required_capability: self.required_capability.clone(),
        }
    }
}

impl GoldenFailure {
    pub(crate) fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            phase: redact_for_log_or_report(&self.phase),
            adapter_id: redact_for_log_or_report(&self.adapter_id),
            message: redact_for_log_or_report(&self.message),
            asset_ref: self.asset_ref.as_deref().map(redact_asset_ref_for_report),
            source_unit_key: self
                .source_unit_key
                .as_deref()
                .map(redact_for_log_or_report),
            support_boundary: self
                .support_boundary
                .as_deref()
                .map(redact_for_log_or_report),
            expected: self.expected.as_deref().map(redact_for_log_or_report),
            actual: self.actual.as_deref().map(redact_for_log_or_report),
            required_capability: self.required_capability.clone(),
        }
    }
}

pub(crate) fn assert_schema_version_v02(value: &str, label: &str) -> BridgeContractResult<()> {
    if value == BRIDGE_SCHEMA_VERSION_V02 {
        return Ok(());
    }
    if value == "0.1.0" {
        return Err(BridgeContractValidationError::new(format!(
            "{label} must be {BRIDGE_SCHEMA_VERSION_V02}; 0.1.0 is the legacy fixture contract"
        )));
    }
    Err(BridgeContractValidationError::new(format!(
        "{label} must be {BRIDGE_SCHEMA_VERSION_V02}"
    )))
}

pub(crate) fn assert_required_string(value: Option<&str>, label: &str) -> BridgeContractResult<()> {
    match value {
        Some(value) => assert_non_empty(value, label),
        None => Err(BridgeContractValidationError::new(format!(
            "{label} must be a non-empty string"
        ))),
    }
}

pub(crate) fn assert_required_uuid7(value: Option<&str>, label: &str) -> BridgeContractResult<()> {
    match value {
        Some(value) => assert_uuid7(value, label),
        None => Err(BridgeContractValidationError::new(format!(
            "{label} must be a UUID7 string"
        ))),
    }
}

pub(crate) fn assert_non_empty(value: &str, label: &str) -> BridgeContractResult<()> {
    if value.is_empty() {
        Err(BridgeContractValidationError::new(format!(
            "{label} must be a non-empty string"
        )))
    } else {
        Ok(())
    }
}

pub(crate) fn assert_equals(value: &str, expected: &str, label: &str) -> BridgeContractResult<()> {
    if value == expected {
        Ok(())
    } else {
        Err(BridgeContractValidationError::new(format!(
            "{label} must be {expected}"
        )))
    }
}

pub(crate) fn assert_one_of(
    value: &str,
    allowed: &[&str],
    label: &str,
) -> BridgeContractResult<()> {
    if allowed.contains(&value) {
        Ok(())
    } else {
        Err(BridgeContractValidationError::new(format!(
            "{label} must be one of: {}",
            allowed.join(", ")
        )))
    }
}

pub(crate) fn assert_surface_kind(value: &str, label: &str) -> BridgeContractResult<()> {
    assert_one_of(
        value,
        &[
            "dialogue",
            "narration",
            "speaker_name",
            "choice_label",
            "ui_label",
            "tutorial_text",
            "database_entry",
            "song_title",
            "image_text",
            "metadata_text",
        ],
        label,
    )
}

pub(crate) fn assert_known_asset_id(
    asset_id: &str,
    label: &str,
    asset_ids: &HashSet<String>,
) -> BridgeContractResult<()> {
    if asset_ids.contains(asset_id) {
        Ok(())
    } else {
        Err(BridgeContractValidationError::new(format!(
            "{label} must reference an asset in BridgeBundleV02.assets"
        )))
    }
}

pub(crate) fn as_record<'a>(
    value: &'a Value,
    label: &str,
) -> BridgeContractResult<&'a serde_json::Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| BridgeContractValidationError::new(format!("{label} must be an object")))
}

pub(crate) fn assert_required_value_string<'a>(
    value: Option<&'a Value>,
    label: &str,
) -> BridgeContractResult<&'a str> {
    match value {
        Some(value) => assert_value_string(value, label),
        None => Err(BridgeContractValidationError::new(format!(
            "{label} must be a non-empty string"
        ))),
    }
}

pub(crate) fn assert_optional_value_string(
    value: Option<&Value>,
    label: &str,
) -> BridgeContractResult<()> {
    if let Some(value) = value {
        assert_value_string(value, label)?;
    }
    Ok(())
}

pub(crate) fn assert_value_string<'a>(
    value: &'a Value,
    label: &str,
) -> BridgeContractResult<&'a str> {
    match value.as_str() {
        Some(value) if !value.is_empty() => Ok(value),
        _ => Err(BridgeContractValidationError::new(format!(
            "{label} must be a non-empty string"
        ))),
    }
}

pub(crate) fn assert_value_string_array(value: &Value, label: &str) -> BridgeContractResult<()> {
    let array = value
        .as_array()
        .ok_or_else(|| BridgeContractValidationError::new(format!("{label} must be an array")))?;
    for (index, item) in array.iter().enumerate() {
        assert_value_string(item, &format!("{label}[{index}]"))?;
    }
    Ok(())
}

pub(crate) fn assert_required_value_uuid7<'a>(
    value: Option<&'a Value>,
    label: &str,
) -> BridgeContractResult<&'a str> {
    let value = assert_required_value_string(value, label)?;
    assert_uuid7(value, label)?;
    Ok(value)
}

pub(crate) fn assert_optional_value_uuid7(
    value: Option<&Value>,
    label: &str,
) -> BridgeContractResult<()> {
    if let Some(value) = value {
        let value = assert_value_string(value, label)?;
        assert_uuid7(value, label)?;
    }
    Ok(())
}

pub(crate) fn assert_value_one_of(
    value: Option<&Value>,
    allowed: &[&str],
    label: &str,
) -> BridgeContractResult<()> {
    let value = assert_required_value_string(value, label)?;
    assert_one_of(value, allowed, label)
}

pub(crate) fn assert_non_negative_integer_value(
    value: Option<&Value>,
    label: &str,
) -> BridgeContractResult<u64> {
    match value.and_then(Value::as_u64) {
        Some(value) => Ok(value),
        None => Err(BridgeContractValidationError::new(format!(
            "{label} must be a non-negative integer"
        ))),
    }
}

pub(crate) fn assert_positive_integer_value(
    value: Option<&Value>,
    label: &str,
) -> BridgeContractResult<u64> {
    match value.and_then(Value::as_u64) {
        Some(value) if value > 0 => Ok(value),
        _ => Err(BridgeContractValidationError::new(format!(
            "{label} must be a positive integer"
        ))),
    }
}

pub(crate) fn assert_required_boolean(
    value: Option<&Value>,
    label: &str,
) -> BridgeContractResult<()> {
    if value.and_then(Value::as_bool).is_some() {
        Ok(())
    } else {
        Err(BridgeContractValidationError::new(format!(
            "{label} must be a boolean"
        )))
    }
}

pub(crate) fn assert_byte_range_v02(value: &Value, label: &str) -> BridgeContractResult<()> {
    let range = as_record(value, label)?;
    let start_byte =
        assert_non_negative_integer_value(range.get("startByte"), &format!("{label}.startByte"))?;
    let end_byte =
        assert_non_negative_integer_value(range.get("endByte"), &format!("{label}.endByte"))?;
    if end_byte <= start_byte {
        return Err(BridgeContractValidationError::new(format!(
            "{label}.endByte must be greater than {label}.startByte"
        )));
    }
    Ok(())
}

pub(crate) fn assert_value_byte_range(
    start_byte: Option<&Value>,
    end_byte: Option<&Value>,
    label: &str,
) -> BridgeContractResult<()> {
    let start_byte = assert_non_negative_integer_value(start_byte, &format!("{label}.startByte"))?;
    let end_byte = assert_non_negative_integer_value(end_byte, &format!("{label}.endByte"))?;
    if end_byte <= start_byte {
        return Err(BridgeContractValidationError::new(format!(
            "{label}.endByte must be greater than {label}.startByte"
        )));
    }
    Ok(())
}

pub(crate) fn assert_required_pixel_region_v02(
    value: Option<&Value>,
    label: &str,
) -> BridgeContractResult<()> {
    match value {
        Some(value) => assert_pixel_region_v02(value, label),
        None => Err(BridgeContractValidationError::new(format!(
            "{label} must be an object"
        ))),
    }
}

pub(crate) fn assert_pixel_region_v02(value: &Value, label: &str) -> BridgeContractResult<()> {
    let region = as_record(value, label)?;
    assert_non_negative_integer_value(region.get("x"), &format!("{label}.x"))?;
    assert_non_negative_integer_value(region.get("y"), &format!("{label}.y"))?;
    assert_positive_integer_value(region.get("width"), &format!("{label}.width"))?;
    assert_positive_integer_value(region.get("height"), &format!("{label}.height"))?;
    Ok(())
}

pub(crate) fn assert_revision_hash_matches_v02(
    revision: &SourceRevisionV02,
    hash: &str,
    label: &str,
) -> BridgeContractResult<()> {
    if revision.revision_kind == "content_hash" && revision.value != hash {
        Err(BridgeContractValidationError::new(format!(
            "{label}.value must equal the matching content hash"
        )))
    } else {
        Ok(())
    }
}

pub(crate) fn assert_hash_string_v02(value: &str, label: &str) -> BridgeContractResult<()> {
    if value.len() != 71 || !value.starts_with("sha256:") {
        return Err(BridgeContractValidationError::new(format!(
            "{label} must be a canonical sha256 hash string"
        )));
    }
    if value[7..]
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(BridgeContractValidationError::new(format!(
            "{label} must be a canonical sha256 hash string"
        )))
    }
}

pub(crate) fn assert_uuid7(value: &str, label: &str) -> BridgeContractResult<()> {
    let bytes = value.as_bytes();
    let valid = bytes.len() == 36
        && bytes[8] == b'-'
        && bytes[13] == b'-'
        && bytes[18] == b'-'
        && bytes[23] == b'-'
        && bytes[14] == b'7'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 8 | 13 | 18 | 23) || byte.is_ascii_hexdigit());
    if valid {
        Ok(())
    } else {
        Err(BridgeContractValidationError::new(format!(
            "{label} must be a UUID7 string"
        )))
    }
}
