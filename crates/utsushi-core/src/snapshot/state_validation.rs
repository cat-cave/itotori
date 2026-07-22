use super::*;

pub(super) fn validate_nested_segment(
    field_path: &str,
    segment: &str,
) -> Result<(), SnapshotError> {
    if segment.is_empty() {
        return Err(SnapshotError::InvalidStatePath {
            raw: field_path.to_string(),
            reason: "nested segment must not be empty".to_string(),
        });
    }
    let bytes = segment.as_bytes();
    let first = bytes[0];
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return Err(SnapshotError::InvalidStatePath {
            raw: field_path.to_string(),
            reason: format!(
                "nested segment {segment:?} must start with lowercase ascii letter or digit"
            ),
        });
    }
    for byte in bytes {
        if !(byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_' || *byte == b'-') {
            return Err(SnapshotError::InvalidStatePath {
                raw: field_path.to_string(),
                reason: format!(
                    "nested segment {segment:?} contains disallowed character {:?}",
                    *byte as char
                ),
            });
        }
    }
    Ok(())
}
