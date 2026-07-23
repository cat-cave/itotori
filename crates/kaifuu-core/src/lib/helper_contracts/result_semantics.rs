use super::*;

#[derive(Clone, Copy)]
pub(super) struct HelperResultSemanticContext {
    pub(super) helper_kind: Option<HelperKind>,
    pub(super) capability_level: Option<HelperCapabilityLevel>,
    pub(super) execution_mode: Option<HelperResultExecutionMode>,
    pub(super) diagnostic: Option<HelperDiagnosticCode>,
    pub(super) secret_ref_count: Option<usize>,
    pub(super) proof_hash_count: Option<usize>,
}

pub(super) fn validate_helper_result_semantic_matrix(
    failures: &mut Vec<HelperResultValidationFailure>,
    fixture_id: Option<&str>,
    context: HelperResultSemanticContext,
) {
    if let (Some(helper_kind), Some(capability_level), Some(execution_mode)) = (
        context.helper_kind,
        context.capability_level,
        context.execution_mode,
    ) {
        let valid = match helper_kind {
            HelperKind::StaticParser => {
                capability_level == HelperCapabilityLevel::StaticAnalysis
                    && execution_mode == HelperResultExecutionMode::InProcess
            }
            HelperKind::KnownKeyDatabaseImport => {
                capability_level == HelperCapabilityLevel::LocalKeyImport
                    && execution_mode == HelperResultExecutionMode::NotExecuted
            }
            HelperKind::ManualKeyEntry => {
                capability_level == HelperCapabilityLevel::ManualEntry
                    && execution_mode == HelperResultExecutionMode::NotExecuted
            }
            HelperKind::WineLocalWindowsHelper => {
                matches!(
                    capability_level,
                    HelperCapabilityLevel::WineLocal | HelperCapabilityLevel::WindowsLocal
                ) && execution_mode == HelperResultExecutionMode::PlatformHelper
            }
            HelperKind::RemoteWindowsHelper => {
                capability_level == HelperCapabilityLevel::RemoteWindows
                    && execution_mode == HelperResultExecutionMode::RemoteHelper
            }
        };

        if !valid {
            helper_result_failure(
                failures,
                fixture_id,
                "invalid_helper_semantics",
                "helper",
                "helperKind, capabilityLevel, and execution.mode must describe the same bounded helper path",
            );
        }
    }

    if context.diagnostic == Some(HelperDiagnosticCode::Success) {
        if context.secret_ref_count == Some(0) {
            helper_result_failure(
                failures,
                fixture_id,
                "missing_success_secret_ref",
                "secretRefs",
                "success diagnostics must include at least one redacted secretRef",
            );
        }
        if context.proof_hash_count == Some(0) {
            helper_result_failure(
                failures,
                fixture_id,
                "missing_success_proof_hash",
                "proofHashes",
                "success diagnostics must include at least one validation proof hash",
            );
        }
    }
    if context.diagnostic == Some(HelperDiagnosticCode::MissingKey)
        && context.secret_ref_count == Some(0)
    {
        helper_result_failure(
            failures,
            fixture_id,
            "missing_key_requires_secret_ref",
            "secretRefs",
            "missing_key diagnostics must identify at least one concrete key requirement id",
        );
    }
}

pub(super) fn helper_result_validation_result(
    fixture_id: Option<String>,
    failures: Vec<HelperResultValidationFailure>,
) -> HelperResultValidationResult {
    HelperResultValidationResult {
        schema_version: HELPER_RESULT_SCHEMA_VERSION.to_string(),
        fixture_id,
        status: if failures.is_empty() {
            OperationStatus::Passed
        } else {
            OperationStatus::Failed
        },
        failures,
    }
}

pub(super) fn add_helper_result_redaction_failures(
    failures: &mut Vec<HelperResultValidationFailure>,
    fixture_id: Option<&str>,
    value: &Value,
) {
    for finding in validate_secret_redaction_boundary(value) {
        helper_result_failure(
            failures,
            fixture_id,
            &finding.code,
            &finding.field,
            &finding.reason,
        );
    }
}

pub(super) fn validate_helper_result_schema_version(
    failures: &mut Vec<HelperResultValidationFailure>,
    fixture_id: Option<&str>,
    value: &Value,
) {
    match value.get("schemaVersion").and_then(Value::as_str) {
        Some(HELPER_RESULT_SCHEMA_VERSION) => {}
        Some(version) if version.trim().is_empty() => helper_result_failure(
            failures,
            fixture_id,
            "missing_required_field",
            "schemaVersion",
            "schemaVersion must not be empty",
        ),
        Some(version) => helper_result_failure(
            failures,
            fixture_id,
            "unsupported_schema_version",
            "schemaVersion",
            &format!("schemaVersion must be {HELPER_RESULT_SCHEMA_VERSION}, got {version}"),
        ),
        None => helper_result_failure(
            failures,
            fixture_id,
            "missing_required_field",
            "schemaVersion",
            "schemaVersion must not be empty",
        ),
    }
}

pub(super) fn validate_helper_result_provenance(
    failures: &mut Vec<HelperResultValidationFailure>,
    fixture_id: Option<&str>,
    helper: Option<&Value>,
) -> Option<HelperKind> {
    let Some(helper) = helper else {
        helper_result_failure(
            failures,
            fixture_id,
            "missing_required_field",
            "helper",
            "helper must be a JSON object",
        );
        return None;
    };
    if !helper.is_object() {
        helper_result_failure(
            failures,
            fixture_id,
            "invalid_field_type",
            "helper",
            "helper must be a JSON object",
        );
        return None;
    }
    validate_helper_result_allowed_object_keys(
        failures,
        fixture_id,
        helper,
        "helper",
        &["helperId", "helperVersion", "helperKind"],
    );
    for field in ["helper.helperId", "helper.helperVersion"] {
        if let Some(text) = required_helper_result_string(failures, fixture_id, helper, field) {
            validate_helper_result_identifier(failures, fixture_id, field, &text);
            validate_helper_result_safe_text(failures, fixture_id, field, &text);
        }
    }
    validate_helper_result_enum_string(
        failures,
        fixture_id,
        helper,
        "helper.helperKind",
        &[
            "staticParser",
            "knownKeyDatabaseImport",
            "wineLocalWindowsHelper",
            "remoteWindowsHelper",
            "manualKeyEntry",
        ],
    )
    .and_then(|kind| serde_json::from_value::<HelperKind>(Value::String(kind)).ok())
}

pub(super) fn validate_helper_result_capability_level(
    failures: &mut Vec<HelperResultValidationFailure>,
    fixture_id: Option<&str>,
    capability_level: Option<&Value>,
) -> Option<HelperCapabilityLevel> {
    let Some(capability_level) = capability_level else {
        helper_result_failure(
            failures,
            fixture_id,
            "missing_required_field",
            "capabilityLevel",
            "capabilityLevel must name the helper capability level",
        );
        return None;
    };
    validate_helper_result_enum_string(
        failures,
        fixture_id,
        &serde_json::json!({ "capabilityLevel": capability_level }),
        "capabilityLevel",
        &[
            "staticAnalysis",
            "localKeyImport",
            "manualEntry",
            "wineLocal",
            "windowsLocal",
            "remoteWindows",
        ],
    )
    .and_then(|level| serde_json::from_value::<HelperCapabilityLevel>(Value::String(level)).ok())
}

pub(super) fn validate_helper_result_execution(
    failures: &mut Vec<HelperResultValidationFailure>,
    fixture_id: Option<&str>,
    execution: Option<&Value>,
) -> Option<HelperResultExecutionMode> {
    let Some(execution) = execution else {
        helper_result_failure(
            failures,
            fixture_id,
            "missing_required_field",
            "execution",
            "execution must describe bounded helper execution metadata",
        );
        return None;
    };
    if !execution.is_object() {
        helper_result_failure(
            failures,
            fixture_id,
            "invalid_field_type",
            "execution",
            "execution must be a JSON object",
        );
        return None;
    }

    validate_helper_result_allowed_object_keys(
        failures,
        fixture_id,
        execution,
        "execution",
        &[
            "mode",
            "platform",
            "bounded",
            "timeoutMs",
            "durationMs",
            "networkAccess",
            "filesystemAccess",
        ],
    );
    validate_helper_result_execution_forbidden_fields(failures, fixture_id, execution, "execution");
    let mode = validate_helper_result_enum_string(
        failures,
        fixture_id,
        execution,
        "execution.mode",
        &["notExecuted", "inProcess", "platformHelper", "remoteHelper"],
    )
    .and_then(|mode| serde_json::from_value::<HelperResultExecutionMode>(Value::String(mode)).ok());
    if let Some(platform) =
        required_helper_result_string(failures, fixture_id, execution, "execution.platform")
    {
        validate_helper_result_identifier(failures, fixture_id, "execution.platform", &platform);
        validate_helper_result_safe_text(failures, fixture_id, "execution.platform", &platform);
    }
    match execution.get("bounded").and_then(Value::as_bool) {
        Some(true) => {}
        Some(false) => helper_result_failure(
            failures,
            fixture_id,
            "unbounded_helper_execution",
            "execution.bounded",
            "helper result execution metadata must be explicitly bounded",
        ),
        None => helper_result_failure(
            failures,
            fixture_id,
            "invalid_field_type",
            "execution.bounded",
            "execution.bounded must be true",
        ),
    }
    let timeout_ms = validate_helper_result_bounded_u32(
        failures,
        fixture_id,
        execution.get("timeoutMs"),
        "execution.timeoutMs",
        1,
        3_600_000,
    );
    let duration_ms = validate_helper_result_bounded_u32(
        failures,
        fixture_id,
        execution.get("durationMs"),
        "execution.durationMs",
        0,
        3_600_000,
    );
    if let (Some(timeout_ms), Some(duration_ms)) = (timeout_ms, duration_ms)
        && duration_ms > timeout_ms
    {
        helper_result_failure(
            failures,
            fixture_id,
            "invalid_field_value",
            "execution.durationMs",
            "execution.durationMs must not exceed execution.timeoutMs",
        );
    }
    if !execution
        .get("networkAccess")
        .is_some_and(serde_json::Value::is_boolean)
    {
        helper_result_failure(
            failures,
            fixture_id,
            "invalid_field_type",
            "execution.networkAccess",
            "execution.networkAccess must be a boolean",
        );
    }
    validate_helper_result_enum_string(
        failures,
        fixture_id,
        execution,
        "execution.filesystemAccess",
        &[
            "none",
            "tempOnly",
            "readOnlyWorkspace",
            "localGameReadOnly",
            "hostInherited",
        ],
    );
    mode
}
