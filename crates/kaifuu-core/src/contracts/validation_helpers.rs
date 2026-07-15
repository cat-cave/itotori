use serde_json::{Map, Value};

use crate::{BRIDGE_SCHEMA_VERSION_V02, BridgeContractResult, BridgeContractValidationError};

pub(super) fn assert_schema_version(
    value: &Map<String, Value>,
    label: &str,
) -> BridgeContractResult<()> {
    let schema_version =
        assert_required_string(value, "schemaVersion", &format!("{label}.schemaVersion"))?;
    if schema_version == BRIDGE_SCHEMA_VERSION_V02 {
        Ok(())
    } else if schema_version == "0.1.0" {
        super::error(format!(
            "{label}.schemaVersion must be {BRIDGE_SCHEMA_VERSION_V02}; 0.1.0 is the legacy fixture contract"
        ))
    } else {
        super::error(format!(
            "{label}.schemaVersion must be {BRIDGE_SCHEMA_VERSION_V02}"
        ))
    }
}

pub(super) fn required<'a>(
    record: &'a Map<String, Value>,
    key: &str,
    label: &str,
) -> BridgeContractResult<&'a Value> {
    record
        .get(key)
        .ok_or_else(|| BridgeContractValidationError::new(format!("{label} is required")))
}

pub(super) fn assert_record_keys(
    record: &Map<String, Value>,
    allowed_keys: &[&str],
    label: &str,
) -> BridgeContractResult<()> {
    for key in record.keys() {
        if !allowed_keys.contains(&key.as_str()) {
            return super::error(format!("{label}.{key} is not allowed"));
        }
    }
    Ok(())
}

pub(super) fn required_record<'a>(
    record: &'a Map<String, Value>,
    key: &str,
    label: &str,
) -> BridgeContractResult<&'a Map<String, Value>> {
    as_record(required(record, key, label)?, label)
}

pub(super) fn required_array<'a>(
    record: &'a Map<String, Value>,
    key: &str,
    label: &str,
) -> BridgeContractResult<&'a Vec<Value>> {
    array_value(required(record, key, label)?, label)
}

pub(super) fn optional_array<'a>(
    record: &'a Map<String, Value>,
    key: &str,
    label: &str,
) -> BridgeContractResult<Vec<&'a Value>> {
    match record.get(key) {
        Some(value) => Ok(array_value(value, label)?.iter().collect()),
        None => Ok(vec![]),
    }
}

pub(super) fn as_record<'a>(
    value: &'a Value,
    label: &str,
) -> BridgeContractResult<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| BridgeContractValidationError::new(format!("{label} must be an object")))
}

pub(super) fn array_value<'a>(
    value: &'a Value,
    label: &str,
) -> BridgeContractResult<&'a Vec<Value>> {
    value
        .as_array()
        .ok_or_else(|| BridgeContractValidationError::new(format!("{label} must be an array")))
}

pub(super) fn string_value<'a>(value: &'a Value, label: &str) -> BridgeContractResult<&'a str> {
    match value.as_str() {
        Some(value) if !value.is_empty() => Ok(value),
        _ => super::error(format!("{label} must be a non-empty string")),
    }
}

pub(super) fn non_blank_string_value<'a>(
    value: &'a Value,
    label: &str,
) -> BridgeContractResult<&'a str> {
    let value = string_value(value, label)?;
    if value.trim().is_empty() {
        super::error(format!("{label} must be a non-empty string"))
    } else {
        Ok(value)
    }
}

pub(super) fn optional_string<'a>(
    record: &'a Map<String, Value>,
    key: &str,
    label: &str,
) -> BridgeContractResult<Option<&'a str>> {
    match record.get(key) {
        Some(value) => string_value(value, label).map(Some),
        None => Ok(None),
    }
}

pub(super) fn is_blank_string(value: Option<&str>) -> bool {
    value.is_none_or(|value| value.trim().is_empty())
}

pub(super) fn string_field<'a>(
    record: &'a Map<String, Value>,
    key: &str,
) -> BridgeContractResult<&'a str> {
    string_value(
        record
            .get(key)
            .ok_or_else(|| BridgeContractValidationError::new(format!("{key} is required")))?,
        key,
    )
}

pub(super) fn assert_required_string<'a>(
    record: &'a Map<String, Value>,
    key: &str,
    label: &str,
) -> BridgeContractResult<&'a str> {
    string_value(required(record, key, label)?, label)
}

pub(super) fn assert_public_fixture_id(value: &str, label: &str) -> BridgeContractResult<()> {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return super::error(format!("{label} must be a public fixture id"));
    };
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return super::error(format!("{label} must be a public fixture id"));
    }
    if chars
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '.' | '_' | '-'))
    {
        Ok(())
    } else {
        super::error(format!("{label} must be a public fixture id"))
    }
}

pub(super) fn assert_required_uuid7<'a>(
    record: &'a Map<String, Value>,
    key: &str,
    label: &str,
) -> BridgeContractResult<&'a str> {
    let value = assert_required_string(record, key, label)?;
    assert_uuid7(value, label)?;
    Ok(value)
}

pub(super) fn assert_uuid7_value(value: &Value, label: &str) -> BridgeContractResult<()> {
    let value = string_value(value, label)?;
    assert_uuid7(value, label)
}

pub(super) fn assert_uuid7(value: &str, label: &str) -> BridgeContractResult<()> {
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
        super::error(format!("{label} must be a UUID7 string"))
    }
}

pub(super) fn assert_required_hash<'a>(
    record: &'a Map<String, Value>,
    key: &str,
    label: &str,
) -> BridgeContractResult<&'a str> {
    let value = assert_required_string(record, key, label)?;
    assert_hash(value, label)?;
    Ok(value)
}

pub(super) fn assert_hash_value(value: &Value, label: &str) -> BridgeContractResult<()> {
    let value = string_value(value, label)?;
    assert_hash(value, label)
}

pub(super) fn assert_hash(value: &str, label: &str) -> BridgeContractResult<()> {
    if value.len() != 71 || !value.starts_with("sha256:") {
        return super::error(format!("{label} must be a canonical sha256 hash string"));
    }
    if value[7..]
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        super::error(format!("{label} must be a canonical sha256 hash string"))
    }
}

pub(super) fn assert_required_one_of<'a>(
    record: &'a Map<String, Value>,
    key: &str,
    allowed: &[&str],
    label: &str,
) -> BridgeContractResult<&'a str> {
    let value = assert_required_string(record, key, label)?;
    assert_one_of(value, allowed, label)?;
    Ok(value)
}

pub(super) fn assert_one_of(
    value: &str,
    allowed: &[&str],
    label: &str,
) -> BridgeContractResult<()> {
    if allowed.contains(&value) {
        Ok(())
    } else {
        super::error(format!("{label} must be one of: {}", allowed.join(", ")))
    }
}

pub(super) fn assert_literal(
    record: &Map<String, Value>,
    key: &str,
    expected: &str,
    label: &str,
) -> BridgeContractResult<()> {
    let value = assert_required_string(record, key, label)?;
    if value == expected {
        Ok(())
    } else {
        super::error(format!("{label} must be {expected}"))
    }
}

pub(super) fn assert_required_rfc3339<'a>(
    record: &'a Map<String, Value>,
    key: &str,
    label: &str,
) -> BridgeContractResult<&'a str> {
    assert_rfc3339_value(required(record, key, label)?, label)
}

pub(super) fn assert_rfc3339_value<'a>(
    value: &'a Value,
    label: &str,
) -> BridgeContractResult<&'a str> {
    let value = string_value(value, label)?;
    validate_rfc3339_instant(value, label)?;
    Ok(value)
}

/// Validate a bare RFC3339 date-time instant string against the canonical
/// cross-language acceptance rule shared with the TypeScript contract validator
/// (`assertRfc3339Instant` in
/// `packages/localization-bridge-schema/src/index.ts`).
/// Both validators are locked to the same accept/reject boundary by the shared
/// parity matrix in
/// `packages/localization-bridge-schema/test/rfc3339-instant-parity-matrix.v0.2.json`.
/// Rejections carry the shared semantic code
/// [`crate::SEMANTIC_RFC3339_INSTANT_MALFORMED`]. See
/// `docs/contracts/rfc3339-instant-acceptance.md` for the canonical rule.
pub fn validate_rfc3339_instant(value: &str, label: &str) -> BridgeContractResult<()> {
    if is_valid_rfc3339_instant(value) {
        Ok(())
    } else {
        Err(BridgeContractValidationError::with_code(
            crate::SEMANTIC_RFC3339_INSTANT_MALFORMED,
            format!("{label} must be a valid RFC3339 timestamp instant"),
        ))
    }
}

pub(super) fn is_valid_rfc3339_instant(value: &str) -> bool {
    let Some((date, time_and_offset)) = value.split_once('T') else {
        return false;
    };
    if date.len() != 10
        || date.as_bytes().get(4) != Some(&b'-')
        || date.as_bytes().get(7) != Some(&b'-')
    {
        return false;
    }
    let Some(year) = parse_u32_digits(&date[0..4]) else {
        return false;
    };
    let Some(month) = parse_u32_digits(&date[5..7]) else {
        return false;
    };
    let Some(day) = parse_u32_digits(&date[8..10]) else {
        return false;
    };

    let (time, offset) = if let Some(time) = time_and_offset.strip_suffix('Z') {
        (time, "Z")
    } else if let Some((offset_index, _)) = time_and_offset
        .char_indices()
        .rev()
        .find(|(_, c)| *c == '+' || *c == '-')
    {
        if offset_index == 0 {
            return false;
        }
        (
            &time_and_offset[..offset_index],
            &time_and_offset[offset_index..],
        )
    } else {
        return false;
    };

    if time.len() < 8
        || time.as_bytes().get(2) != Some(&b':')
        || time.as_bytes().get(5) != Some(&b':')
    {
        return false;
    }
    let Some(hour) = parse_u32_digits(&time[0..2]) else {
        return false;
    };
    let Some(minute) = parse_u32_digits(&time[3..5]) else {
        return false;
    };
    let second_text = &time[6..];
    let (second_text, fraction) = second_text
        .split_once('.')
        .map_or((second_text, None), |(second, fraction)| {
            (second, Some(fraction))
        });
    let Some(second) = parse_u32_digits(second_text) else {
        return false;
    };
    if second_text.len() != 2
        || fraction.is_some_and(|fraction| {
            fraction.is_empty() || !fraction.as_bytes().iter().all(u8::is_ascii_digit)
        })
    {
        return false;
    }

    if month == 0
        || month > 12
        || day == 0
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return false;
    }

    if offset == "Z" {
        return true;
    }
    if offset.len() != 6 || offset.as_bytes().get(3) != Some(&b':') {
        return false;
    }
    let Some(offset_hour) = parse_u32_digits(&offset[1..3]) else {
        return false;
    };
    let Some(offset_minute) = parse_u32_digits(&offset[4..6]) else {
        return false;
    };
    offset_hour <= 23 && offset_minute <= 59
}

pub(super) fn parse_u32_digits(value: &str) -> Option<u32> {
    if value.is_empty() || !value.as_bytes().iter().all(u8::is_ascii_digit) {
        return None;
    }
    value.parse().ok()
}

pub(super) fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

pub(super) fn is_leap_year(year: u32) -> bool {
    year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400))
}

pub(super) fn assert_required_bool(
    record: &Map<String, Value>,
    key: &str,
    label: &str,
) -> BridgeContractResult<bool> {
    required(record, key, label)?
        .as_bool()
        .ok_or_else(|| BridgeContractValidationError::new(format!("{label} must be a boolean")))
}

pub(super) fn assert_required_non_negative_integer(
    record: &Map<String, Value>,
    key: &str,
    label: &str,
) -> BridgeContractResult<u64> {
    non_negative_integer_value(required(record, key, label)?, label)
}

pub(super) fn non_negative_integer_value(value: &Value, label: &str) -> BridgeContractResult<u64> {
    value.as_u64().ok_or_else(|| {
        BridgeContractValidationError::new(format!("{label} must be a non-negative integer"))
    })
}

pub(super) fn assert_required_positive_integer(
    record: &Map<String, Value>,
    key: &str,
    label: &str,
) -> BridgeContractResult<u64> {
    positive_integer_value(required(record, key, label)?, label)
}

pub(super) fn positive_integer_value(value: &Value, label: &str) -> BridgeContractResult<u64> {
    match value.as_u64() {
        Some(value) if value > 0 => Ok(value),
        _ => super::error(format!("{label} must be a positive integer")),
    }
}

pub(super) fn required_number(
    record: &Map<String, Value>,
    key: &str,
    label: &str,
) -> BridgeContractResult<f64> {
    let value = required(record, key, label)?.as_f64().ok_or_else(|| {
        BridgeContractValidationError::new(format!("{label} must be a non-negative number"))
    })?;
    if value < 0.0 || !value.is_finite() {
        return super::error(format!("{label} must be a non-negative number"));
    }
    Ok(value)
}

pub(super) fn assert_required_ratio(
    record: &Map<String, Value>,
    key: &str,
    label: &str,
) -> BridgeContractResult<f64> {
    ratio_value(required(record, key, label)?, label)
}

pub(super) fn ratio_value(value: &Value, label: &str) -> BridgeContractResult<f64> {
    let value = value.as_f64().ok_or_else(|| {
        BridgeContractValidationError::new(format!("{label} must be a number between 0 and 1"))
    })?;
    if (0.0..=1.0).contains(&value) && value.is_finite() {
        Ok(value)
    } else {
        super::error(format!("{label} must be a number between 0 and 1"))
    }
}
