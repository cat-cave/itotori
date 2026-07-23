use super::*;

pub(super) fn validate_helper_registry_binary_signature(
    diagnostics: &mut Vec<HelperRegistryDiagnostic>,
    helper_id: Option<&str>,
    value: Option<&Value>,
    field: &str,
) {
    let Some(signature) = value else {
        helper_registry_failure(
            diagnostics,
            helper_id,
            "missing_required_field",
            field,
            "signature metadata must be a JSON object",
        );
        return;
    };
    let Some(signature) = signature.as_object() else {
        helper_registry_failure(
            diagnostics,
            helper_id,
            "invalid_field_type",
            field,
            "signature metadata must be a JSON object",
        );
        return;
    };
    let signature_value = Value::Object(signature.clone());
    validate_helper_registry_allowed_object_keys(
        diagnostics,
        helper_id,
        &signature_value,
        field,
        &["signatureKind", "signer", "signatureRef"],
    );
    for child in ["signatureKind", "signer", "signatureRef"] {
        let child_field = format!("{field}.{child}");
        if let Some(text) = required_helper_registry_string(
            diagnostics,
            helper_id,
            &Value::Object(signature.clone()),
            &child_field,
        ) {
            validate_helper_registry_identifier(diagnostics, helper_id, &child_field, &text);
        }
    }
}

pub(super) fn validate_helper_registry_binary_capabilities(
    diagnostics: &mut Vec<HelperRegistryDiagnostic>,
    helper_id: Option<&str>,
    value: Option<&Value>,
    field: &str,
    registry_capabilities: &BTreeSet<&str>,
) {
    let Some(capabilities) = value.and_then(Value::as_array) else {
        helper_registry_failure(
            diagnostics,
            helper_id,
            SEMANTIC_HELPER_ALLOWLIST_UNDECLARED_CAPABILITY,
            field,
            "binary allowlist capabilities must be a non-empty array",
        );
        return;
    };
    if capabilities.is_empty() {
        helper_registry_failure(
            diagnostics,
            helper_id,
            SEMANTIC_HELPER_ALLOWLIST_UNDECLARED_CAPABILITY,
            field,
            "binary allowlist capabilities must include at least one capability",
        );
        return;
    }
    let allowed = [
        "fixture_invocation",
        "key_discovery",
        "key_validation",
        "protected_executable_probe",
    ];
    let mut seen = BTreeSet::new();
    for (index, capability) in capabilities.iter().enumerate() {
        let child_field = format!("{field}.{index}");
        let Some(capability) = capability.as_str() else {
            helper_registry_failure(
                diagnostics,
                helper_id,
                "invalid_field_type",
                &child_field,
                "binary allowlist capability must be a string",
            );
            continue;
        };
        if !allowed.contains(&capability) || !registry_capabilities.contains(capability) {
            helper_registry_failure(
                diagnostics,
                helper_id,
                SEMANTIC_HELPER_ALLOWLIST_UNDECLARED_CAPABILITY,
                &child_field,
                "binary allowlist capability must be declared by the helper registry entry",
            );
        }
        if !seen.insert(capability.to_string()) {
            helper_registry_failure(
                diagnostics,
                helper_id,
                "duplicate_helper_capability",
                field,
                "binary allowlist capabilities must not contain duplicate values",
            );
        }
    }
}

pub(super) fn validate_helper_registry_allowed_object_keys(
    diagnostics: &mut Vec<HelperRegistryDiagnostic>,
    helper_id: Option<&str>,
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
            helper_registry_failure(
                diagnostics,
                helper_id,
                "unknown_helper_registry_field",
                &child_field,
                "helper registry field is not allowed by the public contract",
            );
        }
    }
}

pub(super) fn validate_helper_registry_forbidden_execution_fields(
    diagnostics: &mut Vec<HelperRegistryDiagnostic>,
    helper_id: Option<&str>,
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
        if helper_execution_config_field_is_forbidden_at(key, &child_field) {
            helper_registry_failure(
                diagnostics,
                helper_id,
                SEMANTIC_HELPER_REGISTRY_FORBIDDEN_EXECUTION_FIELD,
                &child_field,
                "helper registry data must not serialize arbitrary commands, args, env, shell, or executable paths",
            );
        }
        if child.is_object() {
            validate_helper_registry_forbidden_execution_fields(
                diagnostics,
                helper_id,
                child,
                &child_field,
            );
        } else if let Some(array) = child.as_array() {
            for (index, item) in array.iter().enumerate() {
                validate_helper_registry_forbidden_execution_fields(
                    diagnostics,
                    helper_id,
                    item,
                    &format!("{child_field}.{index}"),
                );
            }
        }
    }
}

pub(super) fn validate_helper_registry_enum_string(
    diagnostics: &mut Vec<HelperRegistryDiagnostic>,
    helper_id: Option<&str>,
    value: &Value,
    field: &str,
    allowed: &[&str],
    code: &str,
) -> Option<String> {
    let key = field.rsplit('.').next().unwrap_or(field);
    let Some(text) = value.get(key).and_then(Value::as_str) else {
        helper_registry_failure(
            diagnostics,
            helper_id,
            code,
            field,
            &format!("{field} must be one of {}", allowed.join(", ")),
        );
        return None;
    };
    if !allowed.contains(&text) {
        helper_registry_failure(
            diagnostics,
            helper_id,
            code,
            field,
            &format!("{field} must be one of {}", allowed.join(", ")),
        );
        return None;
    }
    Some(text.to_string())
}

pub(super) fn required_helper_registry_string(
    diagnostics: &mut Vec<HelperRegistryDiagnostic>,
    helper_id: Option<&str>,
    value: &Value,
    field: &str,
) -> Option<String> {
    let key = field.rsplit('.').next().unwrap_or(field);
    match value.get(key).and_then(Value::as_str) {
        Some(text) if !text.trim().is_empty() => Some(text.to_string()),
        Some(_) | None => {
            helper_registry_failure(
                diagnostics,
                helper_id,
                "missing_required_field",
                field,
                &format!("{field} must not be empty"),
            );
            None
        }
    }
}

pub(super) fn validate_helper_registry_identifier(
    diagnostics: &mut Vec<HelperRegistryDiagnostic>,
    helper_id: Option<&str>,
    field: &str,
    value: &str,
) {
    if value.chars().any(char::is_whitespace) || value.contains('\0') {
        helper_registry_failure(
            diagnostics,
            helper_id,
            "invalid_identifier",
            field,
            &format!("{field} must not contain whitespace or null bytes"),
        );
    }
    if redact_for_log_or_report(value) != value {
        helper_registry_failure(
            diagnostics,
            helper_id,
            SEMANTIC_SECRET_REDACTED,
            field,
            "helper registry text must be redacted before persistence",
        );
    }
}

pub(super) fn validate_helper_registry_output(
    entry: &HelperRegistryEntry,
    output: &Value,
) -> KaifuuResult<()> {
    if entry.output_schema_id != HELPER_REGISTRY_OUTPUT_SCHEMA_HELPER_RESULT {
        return Err(format!(
            "{}: unsupported helper registry output schema {}",
            SEMANTIC_HELPER_REGISTRY_INCOMPATIBLE_OUTPUT_SCHEMA,
            redact_for_log_or_report(&entry.output_schema_id)
        )
        .into());
    }
    let validation = validate_helper_result_value(output).redacted_for_report();
    if validation.status == OperationStatus::Failed {
        return Err(format!(
            "{}: helper output failed helper result validation: {}",
            SEMANTIC_HELPER_REGISTRY_INCOMPATIBLE_OUTPUT_SCHEMA,
            validation
                .failures
                .iter()
                .map(|failure| failure.code.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )
        .into());
    }
    let output_helper_id = output
        .pointer("/helper/helperId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let output_helper_version = output
        .pointer("/helper/helperVersion")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if output_helper_id != entry.helper_id || output_helper_version != entry.helper_version {
        return Err(format!(
            "{SEMANTIC_HELPER_REGISTRY_INCOMPATIBLE_OUTPUT_SCHEMA}: helper output provenance does not match registry entry"
        )
        .into());
    }
    Ok(())
}

pub(super) fn validate_helper_registry_invocation(
    entry: &HelperRegistryEntry,
    request: HelperRegistryInvocationRequest<'_>,
) -> KaifuuResult<()> {
    if entry.helper_id != request.helper_id {
        return Err(format!(
            "{}: helper id {} does not match registered helper",
            SEMANTIC_HELPER_ALLOWLIST_MISSING_ENTRY,
            redact_for_log_or_report(request.helper_id)
        )
        .into());
    }
    if entry.helper_version != request.helper_version {
        return Err(format!(
            "{}: helper {} version does not match registered helper version",
            SEMANTIC_HELPER_ALLOWLIST_STALE_VERSION,
            redact_for_log_or_report(request.helper_id)
        )
        .into());
    }
    if entry.execution_policy.allowlist_ref_id != request.allowlist_entry_id {
        return Err(format!(
            "{}: helper {} must be invoked through its registered allowlist reference",
            SEMANTIC_HELPER_ALLOWLIST_MISSING_ENTRY,
            redact_for_log_or_report(request.helper_id)
        )
        .into());
    }
    if entry.input_schema_id != HELPER_REGISTRY_INPUT_SCHEMA_FIXTURE_REQUEST {
        return Err(format!(
            "{}: unsupported helper registry input schema {}",
            SEMANTIC_HELPER_REGISTRY_UNSUPPORTED_SCHEMA_ID,
            redact_for_log_or_report(&entry.input_schema_id)
        )
        .into());
    }
    if entry.output_schema_id != HELPER_REGISTRY_OUTPUT_SCHEMA_HELPER_RESULT {
        return Err(format!(
            "{}: unsupported helper registry output schema {}",
            SEMANTIC_HELPER_REGISTRY_INCOMPATIBLE_OUTPUT_SCHEMA,
            redact_for_log_or_report(&entry.output_schema_id)
        )
        .into());
    }
    if !entry.supports(request.capability) {
        return Err(format!(
            "{}: helper {} does not provide capability {}",
            SEMANTIC_HELPER_REGISTRY_MISSING_CAPABILITY,
            redact_for_log_or_report(request.helper_id),
            helper_capability_name(request.capability)
        )
        .into());
    }
    let allowlist_entry = entry
        .binary_allowlist
        .entries
        .iter()
        .find(|candidate| candidate.allowlist_entry_id == request.allowlist_entry_id)
        .ok_or_else(|| {
            format!(
                "{}: helper allowlist reference {} is not registered",
                SEMANTIC_HELPER_ALLOWLIST_MISSING_ENTRY,
                redact_for_log_or_report(request.allowlist_entry_id)
            )
        })?;
    if allowlist_entry.helper_id != request.helper_id
        || allowlist_entry.helper_version != request.helper_version
        || !allowlist_entry.capabilities.contains(&request.capability)
        || !is_sha256_ref(&allowlist_entry.sha256_hash)
    {
        return Err(format!(
            "{SEMANTIC_HELPER_ALLOWLIST_UNDECLARED_CAPABILITY}: helper allowlist entry does not match registered id, version, hash, and capability"
        )
        .into());
    }
    Ok(())
}

pub(super) fn helper_registry_validation_result(
    helper_id: Option<String>,
    diagnostics: Vec<HelperRegistryDiagnostic>,
) -> HelperRegistryValidationResult {
    HelperRegistryValidationResult {
        schema_version: HELPER_REGISTRY_SCHEMA_VERSION.to_string(),
        helper_id,
        status: if diagnostics.is_empty() {
            OperationStatus::Passed
        } else {
            OperationStatus::Failed
        },
        diagnostics,
    }
}

pub(super) fn helper_registry_failure(
    diagnostics: &mut Vec<HelperRegistryDiagnostic>,
    helper_id: Option<&str>,
    code: &str,
    field: &str,
    message: &str,
) {
    diagnostics.push(HelperRegistryDiagnostic {
        helper_id: helper_id.map(redact_for_log_or_report),
        code: code.to_string(),
        field: field.to_string(),
        message: redact_for_log_or_report(message),
    });
}

pub(super) fn helper_capability_name(capability: HelperCapability) -> &'static str {
    match capability {
        HelperCapability::FixtureInvocation => "fixture_invocation",
        HelperCapability::KeyDiscovery => "key_discovery",
        HelperCapability::KeyValidation => "key_validation",
        HelperCapability::ProtectedExecutableProbe => "protected_executable_probe",
    }
}

pub fn parse_helper_capability(value: &str) -> Option<HelperCapability> {
    match value {
        "fixture_invocation" => Some(HelperCapability::FixtureInvocation),
        "key_discovery" => Some(HelperCapability::KeyDiscovery),
        "key_validation" => Some(HelperCapability::KeyValidation),
        "protected_executable_probe" => Some(HelperCapability::ProtectedExecutableProbe),
        _ => None,
    }
}
