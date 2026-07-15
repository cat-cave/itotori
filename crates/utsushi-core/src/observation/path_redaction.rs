use serde_json::Value;

use crate::UtsushiResult;

pub(crate) fn reject_unredacted_local_paths(path: &str, value: &Value) -> UtsushiResult<()> {
    match value {
        Value::String(text) if looks_like_local_path(text) => Err(format!(
            "observation hook event contains unredacted local path at {path}: {text}"
        )
        .into()),
        Value::Array(values) => {
            for (index, value) in values.iter().enumerate() {
                reject_unredacted_local_paths(&format!("{path}[{index}]"), value)?;
            }
            Ok(())
        }
        Value::Object(map) => {
            for (key, value) in map {
                let child_path = if path.is_empty() {
                    key.clone()
                } else {
                    format!("{path}.{key}")
                };
                reject_unredacted_local_paths(&child_path, value)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Audit predicate used by `EnvFieldSchema::validate_value` and the
/// observation event redaction filter. Widened from crate-private to
/// `pub` by so engine port crates can apply the same
/// rejection rule when stamping their own diagnostics.
pub fn looks_like_local_path(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.starts_with("file:")
        || lower.contains("file://")
        || lower.starts_with("~/")
        || lower.starts_with("/home/")
        || lower.contains("/home/")
        || lower.starts_with("/users/")
        || lower.contains("/users/")
        || lower.starts_with("/tmp/")
        || lower.contains("/tmp/")
        || lower.starts_with("/var/folders/")
        || lower.contains("/var/folders/")
        || (value.as_bytes().get(1) == Some(&b':')
            && value
                .as_bytes()
                .get(2)
                .is_some_and(|separator| *separator == b'\\' || *separator == b'/'))
}
