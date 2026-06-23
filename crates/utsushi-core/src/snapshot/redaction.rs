//! Snapshot-substrate redaction helpers.
//!
//! The substrate enforces redaction at three layers:
//!
//! 1. `StatePath::parse` rejects any path whose serialized form would match
//!    `looks_like_local_path`.
//! 2. `StateTree::insert` runs the local-path filter on every freshly
//!    inserted leaf so a host string cannot live in the tree.
//! 3. `Snapshot::validate` / `StateDiff::validate` runs the same filter on
//!    the fully serialized JSON form before returning.
//!
//! All three layers route through this module so the filter is identical at
//! every layer (no drift). The substrate never silently strips a leaking
//! value; it returns `SnapshotError::RedactionViolation` with the offending
//! field path.

use serde_json::Value;

use crate::looks_like_local_path;

use super::diagnostics::SnapshotError;

/// Walk a JSON value and reject any string that matches
/// `looks_like_local_path`. The returned error names the offending
/// `field_path` (JSON object key path, e.g. `"stateTree.port.cache_dir"`).
pub(crate) fn reject_unredacted_local_paths_in_value(
    field_path: &str,
    value: &Value,
) -> Result<(), SnapshotError> {
    match value {
        Value::String(text) if looks_like_local_path(text) => {
            Err(SnapshotError::RedactionViolation {
                field_path: field_path.to_string(),
            })
        }
        Value::Array(values) => {
            for (index, value) in values.iter().enumerate() {
                let child = format!("{field_path}[{index}]");
                reject_unredacted_local_paths_in_value(&child, value)?;
            }
            Ok(())
        }
        Value::Object(map) => {
            for (key, value) in map {
                let child = if field_path.is_empty() {
                    key.clone()
                } else {
                    format!("{field_path}.{key}")
                };
                reject_unredacted_local_paths_in_value(&child, value)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Reject a raw string value if it matches the local-path heuristic. Used by
/// `StateValue::String` validators and by `StatePath::parse` so the same
/// filter is applied at insert time and at parse time.
pub(crate) fn reject_unredacted_local_path_string(
    field_path: &str,
    text: &str,
) -> Result<(), SnapshotError> {
    if looks_like_local_path(text) {
        Err(SnapshotError::RedactionViolation {
            field_path: field_path.to_string(),
        })
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reject_unredacted_local_paths_in_value_passes_clean_payload() {
        let payload = json!({
            "stateTree": {
                "port.frame": {"valueKind": "int", "value": 12},
                "vfs.www": {"valueKind": "assetId", "value": "vfs://www/script.txt"}
            }
        });
        reject_unredacted_local_paths_in_value("", &payload).expect("clean payload");
    }

    #[test]
    fn reject_unredacted_local_paths_in_value_rejects_home_path() {
        let payload = json!({
            "stateTree": {
                "port.cache_dir": {"valueKind": "string", "value": "/home/trevor/cache"}
            }
        });
        let err = reject_unredacted_local_paths_in_value("", &payload)
            .expect_err("must reject home path");
        match err {
            SnapshotError::RedactionViolation { field_path } => {
                assert!(field_path.contains("port.cache_dir"));
            }
            other => panic!("unexpected error variant: {other:?}"),
        }
    }

    #[test]
    fn reject_unredacted_local_paths_in_value_rejects_tmp_path_in_array() {
        let payload = json!([{"value": "/tmp/x"}]);
        let err =
            reject_unredacted_local_paths_in_value("root", &payload).expect_err("must reject");
        match err {
            SnapshotError::RedactionViolation { field_path } => {
                assert!(field_path.starts_with("root[0]"));
            }
            other => panic!("unexpected error variant: {other:?}"),
        }
    }

    #[test]
    fn reject_unredacted_local_path_string_rejects_file_scheme() {
        let err = reject_unredacted_local_path_string("field", "file:///etc/passwd")
            .expect_err("must reject file://");
        assert!(matches!(err, SnapshotError::RedactionViolation { .. }));
    }

    #[test]
    fn reject_unredacted_local_path_string_accepts_neutral_string() {
        reject_unredacted_local_path_string("field", "deterministic-fixture")
            .expect("clean string");
    }
}
