use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperResultValidationResult {
    pub schema_version: String,
    pub fixture_id: Option<String>,
    pub status: OperationStatus,
    pub failures: Vec<HelperResultValidationFailure>,
}

impl HelperResultValidationResult {
    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            fixture_id: self.fixture_id.as_deref().map(redact_for_log_or_report),
            status: self.status.clone(),
            failures: self
                .failures
                .iter()
                .map(HelperResultValidationFailure::redacted_for_report)
                .collect(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperResultValidationFailure {
    pub fixture_id: Option<String>,
    pub code: String,
    pub field: String,
    pub message: String,
}

impl HelperResultValidationFailure {
    fn redacted_for_report(&self) -> Self {
        Self {
            fixture_id: self.fixture_id.as_deref().map(redact_for_log_or_report),
            code: redact_for_log_or_report(&self.code),
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
        }
    }
}

pub fn validate_helper_result_value(value: &Value) -> HelperResultValidationResult {
    let fixture_id = value
        .get("fixtureId")
        .and_then(Value::as_str)
        .map(redact_for_log_or_report);
    let mut failures = Vec::new();
    if !value.is_object() {
        helper_result_failure(
            &mut failures,
            fixture_id.as_deref(),
            "invalid_helper_result_shape",
            "$",
            "helper result must be a JSON object",
        );
        return helper_result_validation_result(fixture_id, failures);
    }

    validate_helper_result_allowed_object_keys(
        &mut failures,
        fixture_id.as_deref(),
        value,
        "$",
        &[
            "schemaVersion",
            "fixtureId",
            "helperResultId",
            "profileId",
            "helper",
            "capabilityLevel",
            "execution",
            "diagnostic",
            "redaction",
            "secretRefs",
            "proofHashes",
        ],
    );
    validate_helper_result_forbidden_metadata_fields(
        &mut failures,
        fixture_id.as_deref(),
        value,
        "$",
    );
    add_helper_result_redaction_failures(&mut failures, fixture_id.as_deref(), value);
    validate_helper_result_schema_version(&mut failures, fixture_id.as_deref(), value);
    let fixture_id_value =
        required_helper_result_string(&mut failures, fixture_id.as_deref(), value, "fixtureId");
    if let Some(fixture_id_value) = fixture_id_value.as_deref() {
        validate_public_fixture_label(
            &mut failures,
            fixture_id.as_deref(),
            "fixtureId",
            fixture_id_value,
        );
    }
    for field in ["helperResultId", "profileId"] {
        if let Some(text) =
            required_helper_result_string(&mut failures, fixture_id.as_deref(), value, field)
        {
            validate_helper_result_identifier(&mut failures, fixture_id.as_deref(), field, &text);
            validate_helper_result_safe_text(&mut failures, fixture_id.as_deref(), field, &text);
        }
    }
    let helper_kind = validate_helper_result_provenance(
        &mut failures,
        fixture_id.as_deref(),
        value.get("helper"),
    );
    let capability_level = validate_helper_result_capability_level(
        &mut failures,
        fixture_id.as_deref(),
        value.get("capabilityLevel"),
    );
    let execution_mode = validate_helper_result_execution(
        &mut failures,
        fixture_id.as_deref(),
        value.get("execution"),
    );
    let diagnostic = validate_helper_result_diagnostic(
        &mut failures,
        fixture_id.as_deref(),
        value.get("diagnostic"),
    );
    let redaction = validate_helper_result_redaction(
        &mut failures,
        fixture_id.as_deref(),
        value.get("redaction"),
    );
    let secret_ref_count = validate_helper_result_secret_refs(
        &mut failures,
        fixture_id.as_deref(),
        value.get("secretRefs"),
    );
    let proof_hash_count = validate_helper_result_proof_hashes(
        &mut failures,
        fixture_id.as_deref(),
        value.get("proofHashes"),
    );
    let semantic_context = HelperResultSemanticContext {
        helper_kind,
        capability_level,
        execution_mode,
        diagnostic,
        secret_ref_count,
        proof_hash_count,
    };
    validate_helper_result_semantic_matrix(&mut failures, fixture_id.as_deref(), semantic_context);

    if diagnostic == Some(HelperDiagnosticCode::Success)
        && redaction == Some(HelperRedactionStatus::Failed)
    {
        helper_result_failure(
            &mut failures,
            fixture_id.as_deref(),
            "inconsistent_redaction_status",
            "redaction.status",
            "successful helper results must not carry failed redaction status",
        );
    }
    if diagnostic == Some(HelperDiagnosticCode::RedactionFailure)
        && redaction != Some(HelperRedactionStatus::Failed)
    {
        helper_result_failure(
            &mut failures,
            fixture_id.as_deref(),
            "inconsistent_redaction_status",
            "redaction.status",
            "redaction_failure diagnostics must carry failed redaction status",
        );
    }

    helper_result_validation_result(fixture_id, failures)
}

pub fn normalize_helper_result_value(
    value: &Value,
) -> Result<HelperResult, HelperResultValidationResult> {
    let mut normalized = value.clone();
    let helper_kind = normalized
        .pointer("/helper/helperKind")
        .and_then(Value::as_str)
        .and_then(default_helper_capability_and_execution);
    if let Some((capability_level, execution)) = helper_kind
        && let Some(object) = normalized.as_object_mut()
    {
        object
            .entry("capabilityLevel".to_string())
            .or_insert_with(|| Value::String(capability_level.to_string()));
        object
            .entry("execution".to_string())
            .or_insert_with(|| execution);
    }

    let validation = validate_helper_result_value(&normalized).redacted_for_report();
    if validation.status == OperationStatus::Failed {
        return Err(validation);
    }

    match serde_json::from_value::<HelperResult>(normalized) {
        Ok(mut result) => {
            result.normalize();
            Ok(result.redacted_for_report())
        }
        Err(error) => {
            let fixture_id = value
                .get("fixtureId")
                .and_then(Value::as_str)
                .map(redact_for_log_or_report);
            Err(helper_result_validation_result(
                fixture_id.clone(),
                vec![HelperResultValidationFailure {
                    fixture_id,
                    code: "helper_result_deserialization_failed".to_string(),
                    field: "$".to_string(),
                    message: redact_for_log_or_report(&error.to_string()),
                }],
            )
            .redacted_for_report())
        }
    }
}

fn default_helper_capability_and_execution(helper_kind: &str) -> Option<(&'static str, Value)> {
    let (capability_level, mode, platform, timeout_ms, filesystem_access) = match helper_kind {
        "staticParser" => (
            "staticAnalysis",
            "inProcess",
            "fixture-static",
            1000_u32,
            "readOnlyWorkspace",
        ),
        "knownKeyDatabaseImport" => (
            "localKeyImport",
            "notExecuted",
            "fixture-local",
            1000_u32,
            "none",
        ),
        "manualKeyEntry" => (
            "manualEntry",
            "notExecuted",
            "fixture-local",
            1000_u32,
            "none",
        ),
        "wineLocalWindowsHelper" => (
            "wineLocal",
            "platformHelper",
            "wine-fixture",
            5000_u32,
            "localGameReadOnly",
        ),
        "remoteWindowsHelper" => (
            "remoteWindows",
            "remoteHelper",
            "windows-fixture",
            5000_u32,
            "localGameReadOnly",
        ),
        _ => return None,
    };
    Some((
        capability_level,
        serde_json::json!({
            "mode": mode,
            "platform": platform,
            "bounded": true,
            "timeoutMs": timeout_ms,
            "durationMs": 0,
            "networkAccess": false,
            "filesystemAccess": filesystem_access
        }),
    ))
}

pub(super) fn validate_helper_result_allowed_object_keys(
    failures: &mut Vec<HelperResultValidationFailure>,
    fixture_id: Option<&str>,
    value: &Value,
    field: &str,
    allowed: &[&str],
) {
    let Some(object) = value.as_object() else {
        return;
    };
    for key in object.keys() {
        if !allowed.contains(&key.as_str()) {
            let child_field = if field == "$" {
                key.clone()
            } else {
                format!("{field}.{key}")
            };
            helper_result_failure(
                failures,
                fixture_id,
                "unknown_helper_result_field",
                &child_field,
                "helper result field is not allowed by the public contract",
            );
        }
    }
}

fn validate_helper_result_forbidden_metadata_fields(
    failures: &mut Vec<HelperResultValidationFailure>,
    fixture_id: Option<&str>,
    value: &Value,
    field: &str,
) {
    let Some(object) = value.as_object() else {
        return;
    };
    for (key, child) in object {
        let child_field = if field == "$" {
            key.clone()
        } else {
            format!("{field}.{key}")
        };
        if helper_execution_config_field_is_forbidden(key) && !child_field.starts_with("execution.")
        {
            helper_result_failure(
                failures,
                fixture_id,
                "forbidden_helper_metadata_field",
                &child_field,
                "helper result metadata must not serialize arbitrary commands, args, env, or executable paths",
            );
        }
        if child.is_object() {
            validate_helper_result_forbidden_metadata_fields(
                failures,
                fixture_id,
                child,
                &child_field,
            );
        } else if let Some(array) = child.as_array() {
            for (index, item) in array.iter().enumerate() {
                validate_helper_result_forbidden_metadata_fields(
                    failures,
                    fixture_id,
                    item,
                    &format!("{child_field}.{index}"),
                );
            }
        }
    }
}
