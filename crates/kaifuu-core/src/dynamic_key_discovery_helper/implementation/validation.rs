use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    OperationStatus, is_local_absolute_path, looks_like_raw_key_material, redact_for_log_or_report,
    validate_helper_result_value, validate_secret_redaction_boundary,
};

use super::super::{
    DYNAMIC_KEY_DISCOVERY_HELPER_SCHEMA_VERSION, SEMANTIC_DYNAMIC_KEY_HELPER_RESULT_INVALID,
    SEMANTIC_DYNAMIC_KEY_HELPER_SECRET_LEAK,
};

// Shared validation plumbing.

/// Serializes `artifact`, deep-scans every string for raw key material / local
/// paths, runs the standard secret-redaction boundary, and returns the JSON
/// value (so callers can reuse it, e.g. to validate a nested helper result).
pub(crate) fn scan_value_for_leaks<T: Serialize>(
    artifact: &T,
    failures: &mut Vec<DynamicKeyDiscoveryFailure>,
) -> Value {
    let Ok(value) = serde_json::to_value(artifact) else {
        failures.push(DynamicKeyDiscoveryFailure {
            code: SEMANTIC_DYNAMIC_KEY_HELPER_RESULT_INVALID.to_string(),
            field: "$".to_string(),
            message: "artifact could not be serialized for validation".to_string(),
        });
        return Value::Null;
    };

    deep_scan_raw_secret_material(&value, "$", failures);

    for finding in validate_secret_redaction_boundary(&value) {
        failures.push(DynamicKeyDiscoveryFailure {
            code: SEMANTIC_DYNAMIC_KEY_HELPER_SECRET_LEAK.to_string(),
            field: finding.field,
            message: finding.reason,
        });
    }

    value
}

/// Validates a nested `helperResult` object (if present) against the schema,
/// folding any failure into the dynamic-key-discovery failures.
pub(crate) fn validate_nested_helper_result(
    value: &Value,
    failures: &mut Vec<DynamicKeyDiscoveryFailure>,
) {
    if let Some(helper_result) = value.get("helperResult") {
        let helper_validation = validate_helper_result_value(helper_result);
        if helper_validation.status == OperationStatus::Failed {
            for failure in helper_validation.failures {
                failures.push(DynamicKeyDiscoveryFailure {
                    code: SEMANTIC_DYNAMIC_KEY_HELPER_RESULT_INVALID.to_string(),
                    field: format!("helperResult.{}", failure.field),
                    message: failure.message,
                });
            }
        }
    }
}

/// Deep-scans every string in `value` for raw key material or a local absolute
/// path, regardless of the field name it hides behind.
fn deep_scan_raw_secret_material(
    value: &Value,
    field: &str,
    failures: &mut Vec<DynamicKeyDiscoveryFailure>,
) {
    match value {
        Value::String(text) => {
            if looks_like_raw_key_material(text) {
                failures.push(DynamicKeyDiscoveryFailure {
                    code: SEMANTIC_DYNAMIC_KEY_HELPER_SECRET_LEAK.to_string(),
                    field: field.to_string(),
                    message: "raw key-like material must be referenced through secretRef, never serialized".to_string(),
                });
            } else if is_local_absolute_path(text) {
                failures.push(DynamicKeyDiscoveryFailure {
                    code: SEMANTIC_DYNAMIC_KEY_HELPER_SECRET_LEAK.to_string(),
                    field: field.to_string(),
                    message: "local absolute paths must be redacted from helper artifacts"
                        .to_string(),
                });
            }
        }
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                deep_scan_raw_secret_material(item, &format!("{field}.{index}"), failures);
            }
        }
        Value::Object(object) => {
            for (key, child) in object {
                let child_field = if field == "$" {
                    key.clone()
                } else {
                    format!("{field}.{key}")
                };
                deep_scan_raw_secret_material(child, &child_field, failures);
            }
        }
        _ => {}
    }
}

/// The outcome of validating a dynamic-key-discovery artifact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamicKeyDiscoveryValidation {
    pub schema_version: String,
    pub fixture_id: Option<String>,
    pub status: OperationStatus,
    pub failures: Vec<DynamicKeyDiscoveryFailure>,
}

impl DynamicKeyDiscoveryValidation {
    pub(crate) fn from_failures(
        fixture_id: &str,
        failures: Vec<DynamicKeyDiscoveryFailure>,
    ) -> Self {
        let status = if failures.is_empty() {
            OperationStatus::Passed
        } else {
            OperationStatus::Failed
        };
        Self {
            schema_version: DYNAMIC_KEY_DISCOVERY_HELPER_SCHEMA_VERSION.to_string(),
            fixture_id: Some(redact_for_log_or_report(fixture_id)),
            status,
            failures: failures
                .iter()
                .map(DynamicKeyDiscoveryFailure::redacted_for_report)
                .collect(),
        }
    }
}

/// A single validation failure for a dynamic-key-discovery artifact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamicKeyDiscoveryFailure {
    pub code: String,
    pub field: String,
    pub message: String,
}

impl DynamicKeyDiscoveryFailure {
    fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
        }
    }
}
