//! Validation helpers for snapshot metadata.

use super::super::diagnostics::SnapshotError;

/// Inspectable surface identifier. Lowercase ASCII kebab matches the
/// adapter id shape used by [`crate::conformance::ConformanceManifest`].
pub(super) fn validate_inspectable_id(raw: &str) -> Result<(), SnapshotError> {
    if raw.is_empty() {
        return Err(SnapshotError::InvalidInspectableId {
            raw: raw.to_string(),
            reason: "inspectable id must not be empty".to_string(),
        });
    }
    if raw.len() > 128 {
        return Err(SnapshotError::InvalidInspectableId {
            raw: raw.to_string(),
            reason: "inspectable id exceeds 128 bytes".to_string(),
        });
    }
    for byte in raw.as_bytes() {
        if !(byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-') {
            return Err(SnapshotError::InvalidInspectableId {
                raw: raw.to_string(),
                reason: format!(
                    "inspectable id contains disallowed character {:?}",
                    *byte as char
                ),
            });
        }
    }
    Ok(())
}

pub(super) fn validate_generated_at(raw: &str) -> Result<(), SnapshotError> {
    if raw.is_empty() {
        return Err(SnapshotError::InvalidGeneratedAt {
            raw: raw.to_string(),
            reason: "generated_at must not be empty".to_string(),
        });
    }
    if !is_valid_rfc3339_instant(raw) {
        return Err(SnapshotError::InvalidGeneratedAt {
            raw: raw.to_string(),
            reason: "generated_at must be RFC3339".to_string(),
        });
    }
    Ok(())
}

/// Local copy of the RFC3339 instant validator (mirrors the helper used
/// by observation hook events). Kept module-private so the substrate has
/// no implicit dependency on the lib.rs internal validator.
fn is_valid_rfc3339_instant(value: &str) -> bool {
    let Some((date, time_and_offset)) = value.split_once('T') else {
        return false;
    };
    if date.len() != 10
        || date.as_bytes().get(4) != Some(&b'-')
        || date.as_bytes().get(7) != Some(&b'-')
    {
        return false;
    }
    let Some(year) = parse_u32(&date[0..4]) else {
        return false;
    };
    let Some(month) = parse_u32(&date[5..7]) else {
        return false;
    };
    let Some(day) = parse_u32(&date[8..10]) else {
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
    let Some(hour) = parse_u32(&time[0..2]) else {
        return false;
    };
    let Some(minute) = parse_u32(&time[3..5]) else {
        return false;
    };
    let second_text = &time[6..];
    let (second_text, fraction) = second_text
        .split_once('.')
        .map_or((second_text, None), |(second, fraction)| {
            (second, Some(fraction))
        });
    let Some(second) = parse_u32(second_text) else {
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
    let Some(offset_hour) = parse_u32(&offset[1..3]) else {
        return false;
    };
    let Some(offset_minute) = parse_u32(&offset[4..6]) else {
        return false;
    };
    offset_hour <= 23 && offset_minute <= 59
}

fn parse_u32(value: &str) -> Option<u32> {
    if value.is_empty() || !value.as_bytes().iter().all(u8::is_ascii_digit) {
        return None;
    }
    value.parse().ok()
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

fn is_leap_year(year: u32) -> bool {
    year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400))
}
