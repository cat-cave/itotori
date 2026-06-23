//! Embed-side redaction wrapper.
//!
//! The substrate runs [`reject_unredacted_local_paths`] at four layers (per
//! the UTSUSHI-024 plan §8) with the same defense-in-depth posture as
//! UTSUSHI-021/022/023. This module wraps the
//! `crate::redaction::reject_unredacted_local_paths` helper into the
//! embed-side [`EmbedError::RedactionViolation`] envelope so every embed
//! validator surfaces a typed embed error.
//!
//! The filter itself is **the same** `reject_unredacted_local_paths`
//! re-exported from `utsushi_core::redaction`; no embed-specific filter is
//! introduced.

use serde_json::Value;

use crate::redaction::reject_unredacted_local_paths;

use super::diagnostics::EmbedError;

/// Run the shared host-path filter on a JSON sub-tree and convert the
/// outer-error envelope into a typed [`EmbedError::RedactionViolation`].
///
/// `field_path` is forwarded verbatim to the shared filter as the starting
/// breadcrumb so the embed substrate's per-field path remains stable in the
/// error.
pub(crate) fn reject_redaction_violation(
    field_path: &str,
    value: &Value,
) -> Result<(), EmbedError> {
    match reject_unredacted_local_paths(field_path, value) {
        Ok(()) => Ok(()),
        Err(error) => {
            // The shared filter formats its error message as
            // "...at <field_path>: <value>"; extract the path segment so
            // the embed-side error names the field exactly.
            let rendered = error.to_string();
            let path = rendered
                .split_once(" at ")
                .and_then(|(_, rest)| rest.split_once(": "))
                .map(|(path, _)| path.to_string())
                .unwrap_or_else(|| {
                    if field_path.is_empty() {
                        "<root>".to_string()
                    } else {
                        field_path.to_string()
                    }
                });
            Err(EmbedError::RedactionViolation { field_path: path })
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn embed_redaction_filter_accepts_clean_object() {
        let value = json!({
            "lines": [
                { "text": "hello world", "speaker": "narrator" }
            ]
        });
        reject_redaction_violation("trace", &value).expect("clean payload accepted");
    }

    #[test]
    fn embed_redaction_filter_rejects_home_path_in_string_field() {
        let value = json!({
            "lines": [
                { "text": "see /home/leak/note.md", "speaker": "narrator" }
            ]
        });
        let error = reject_redaction_violation("trace", &value)
            .expect_err("home path in text field rejected");
        match error {
            EmbedError::RedactionViolation { field_path } => {
                assert!(
                    field_path.contains("text"),
                    "redaction error should name text field: {field_path}"
                );
            }
            other => panic!("expected RedactionViolation, got {other:?}"),
        }
    }

    #[test]
    fn embed_redaction_filter_rejects_drive_letter_in_string_field() {
        let value = json!({ "speaker": "C:\\Users\\x" });
        let error = reject_redaction_violation("trace", &value).expect_err("drive letter rejected");
        match error {
            EmbedError::RedactionViolation { field_path } => {
                assert!(
                    field_path.contains("speaker"),
                    "redaction error should name speaker field: {field_path}"
                );
            }
            other => panic!("expected RedactionViolation, got {other:?}"),
        }
    }

    #[test]
    fn embed_redaction_filter_rejects_file_scheme_in_string_field() {
        let value = json!({ "uri": "file:///etc/passwd" });
        let error = reject_redaction_violation("artifact", &value).expect_err("file:// rejected");
        assert!(matches!(
            error,
            EmbedError::RedactionViolation { field_path } if field_path.contains("uri")
        ));
    }
}
