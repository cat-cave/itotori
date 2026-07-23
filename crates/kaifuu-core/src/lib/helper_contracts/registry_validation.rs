use super::*;

pub fn validate_helper_registry_entry_value(value: &Value) -> HelperRegistryValidationResult {
    let helper_id = value
        .get("helperId")
        .and_then(Value::as_str)
        .map(redact_for_log_or_report);
    let mut diagnostics = Vec::new();
    if !value.is_object() {
        helper_registry_failure(
            &mut diagnostics,
            helper_id.as_deref(),
            "invalid_helper_registry_shape",
            "$",
            "helper registry entry must be a JSON object",
        );
        return helper_registry_validation_result(helper_id, diagnostics);
    }
    validate_helper_registry_allowed_object_keys(
        &mut diagnostics,
        helper_id.as_deref(),
        value,
        "$",
        &[
            "schemaVersion",
            "helperId",
            "helperVersion",
            "capabilities",
            "inputSchemaId",
            "outputSchemaId",
            "redactionClass",
            "executionPolicy",
            "binaryAllowlist",
        ],
    );
    validate_helper_registry_forbidden_execution_fields(
        &mut diagnostics,
        helper_id.as_deref(),
        value,
        "$",
    );

    validate_helper_registry_schema_version(&mut diagnostics, helper_id.as_deref(), value);
    for field in ["helperId", "helperVersion"] {
        if let Some(text) =
            required_helper_registry_string(&mut diagnostics, helper_id.as_deref(), value, field)
        {
            validate_helper_registry_identifier(
                &mut diagnostics,
                helper_id.as_deref(),
                field,
                &text,
            );
        }
    }
    validate_helper_registry_capabilities(&mut diagnostics, helper_id.as_deref(), value);
    validate_helper_registry_schema_id(
        &mut diagnostics,
        helper_id.as_deref(),
        value,
        "inputSchemaId",
        &[HELPER_REGISTRY_INPUT_SCHEMA_FIXTURE_REQUEST],
    );
    let output_schema = validate_helper_registry_schema_id(
        &mut diagnostics,
        helper_id.as_deref(),
        value,
        "outputSchemaId",
        &[HELPER_REGISTRY_OUTPUT_SCHEMA_HELPER_RESULT],
    );
    if let Some(output_schema) = output_schema
        && output_schema != HELPER_REGISTRY_OUTPUT_SCHEMA_HELPER_RESULT
    {
        helper_registry_failure(
            &mut diagnostics,
            helper_id.as_deref(),
            SEMANTIC_HELPER_REGISTRY_INCOMPATIBLE_OUTPUT_SCHEMA,
            "outputSchemaId",
            "helper registry outputSchemaId must be compatible with KAIFUU helper results",
        );
    }
    validate_helper_registry_redaction_class(&mut diagnostics, helper_id.as_deref(), value);
    validate_helper_registry_execution_policy(&mut diagnostics, helper_id.as_deref(), value);
    validate_helper_registry_binary_allowlist(&mut diagnostics, helper_id.as_deref(), value);

    helper_registry_validation_result(helper_id, diagnostics)
}

fn validate_helper_registry_schema_version(
    diagnostics: &mut Vec<HelperRegistryDiagnostic>,
    helper_id: Option<&str>,
    value: &Value,
) {
    match value.get("schemaVersion").and_then(Value::as_str) {
        Some(HELPER_REGISTRY_SCHEMA_VERSION) => {}
        Some(version) if version.trim().is_empty() => helper_registry_failure(
            diagnostics,
            helper_id,
            "missing_required_field",
            "schemaVersion",
            "schemaVersion must not be empty",
        ),
        Some(version) => helper_registry_failure(
            diagnostics,
            helper_id,
            "unsupported_schema_version",
            "schemaVersion",
            &format!("schemaVersion must be {HELPER_REGISTRY_SCHEMA_VERSION}, got {version}"),
        ),
        None => helper_registry_failure(
            diagnostics,
            helper_id,
            "missing_required_field",
            "schemaVersion",
            "schemaVersion must not be empty",
        ),
    }
}

fn validate_helper_registry_capabilities(
    diagnostics: &mut Vec<HelperRegistryDiagnostic>,
    helper_id: Option<&str>,
    value: &Value,
) {
    let Some(capabilities) = value.get("capabilities").and_then(Value::as_array) else {
        helper_registry_failure(
            diagnostics,
            helper_id,
            SEMANTIC_HELPER_REGISTRY_MISSING_CAPABILITY,
            "capabilities",
            "capabilities must be a non-empty array",
        );
        return;
    };
    if capabilities.is_empty() {
        helper_registry_failure(
            diagnostics,
            helper_id,
            SEMANTIC_HELPER_REGISTRY_MISSING_CAPABILITY,
            "capabilities",
            "capabilities must include at least one helper capability",
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
        let field = format!("capabilities.{index}");
        let Some(capability) = capability.as_str() else {
            helper_registry_failure(
                diagnostics,
                helper_id,
                "invalid_field_type",
                &field,
                "helper capability must be a string",
            );
            continue;
        };
        if !allowed.contains(&capability) {
            helper_registry_failure(
                diagnostics,
                helper_id,
                SEMANTIC_HELPER_REGISTRY_MISSING_CAPABILITY,
                &field,
                "helper capability is not supported by this registry schema",
            );
        }
        if !seen.insert(capability.to_string()) {
            helper_registry_failure(
                diagnostics,
                helper_id,
                "duplicate_helper_capability",
                "capabilities",
                "capabilities must not contain duplicate values",
            );
        }
    }
}

fn validate_helper_registry_schema_id(
    diagnostics: &mut Vec<HelperRegistryDiagnostic>,
    helper_id: Option<&str>,
    value: &Value,
    field: &str,
    allowed: &[&str],
) -> Option<String> {
    let schema_id = required_helper_registry_string(diagnostics, helper_id, value, field)?;
    if !allowed.contains(&schema_id.as_str()) {
        helper_registry_failure(
            diagnostics,
            helper_id,
            SEMANTIC_HELPER_REGISTRY_UNSUPPORTED_SCHEMA_ID,
            field,
            &format!("{field} must be one of {}", allowed.join(", ")),
        );
    }
    Some(schema_id)
}

fn validate_helper_registry_redaction_class(
    diagnostics: &mut Vec<HelperRegistryDiagnostic>,
    helper_id: Option<&str>,
    value: &Value,
) {
    validate_helper_registry_enum_string(
        diagnostics,
        helper_id,
        value,
        "redactionClass",
        &["public_fixture", "secret_ref_only", "aggregate_only"],
        SEMANTIC_HELPER_REGISTRY_INVALID_REDACTION_CLASS,
    );
}

fn validate_helper_registry_execution_policy(
    diagnostics: &mut Vec<HelperRegistryDiagnostic>,
    helper_id: Option<&str>,
    value: &Value,
) {
    let Some(policy) = value.get("executionPolicy") else {
        helper_registry_failure(
            diagnostics,
            helper_id,
            "missing_required_field",
            "executionPolicy",
            "executionPolicy must be a JSON object",
        );
        return;
    };
    if !policy.is_object() {
        helper_registry_failure(
            diagnostics,
            helper_id,
            "invalid_field_type",
            "executionPolicy",
            "executionPolicy must be a JSON object",
        );
        return;
    }
    validate_helper_registry_allowed_object_keys(
        diagnostics,
        helper_id,
        policy,
        "executionPolicy",
        &[
            "policyId",
            "mode",
            "allowlistRefId",
            "filesystemAccess",
            "networkAccess",
            "maxRuntimeSeconds",
        ],
    );
    for field in ["executionPolicy.policyId", "executionPolicy.allowlistRefId"] {
        if let Some(text) = required_helper_registry_string(diagnostics, helper_id, policy, field) {
            validate_helper_registry_identifier(diagnostics, helper_id, field, &text);
        }
    }
    validate_helper_registry_enum_string(
        diagnostics,
        helper_id,
        policy,
        "executionPolicy.mode",
        &["fixture_in_process", "disallowed"],
        "invalid_enum_value",
    );
    validate_helper_registry_enum_string(
        diagnostics,
        helper_id,
        policy,
        "executionPolicy.filesystemAccess",
        &["none", "temp_only", "read_only_workspace"],
        "invalid_enum_value",
    );
    if !policy
        .get("networkAccess")
        .is_some_and(serde_json::Value::is_boolean)
    {
        helper_registry_failure(
            diagnostics,
            helper_id,
            "invalid_field_type",
            "executionPolicy.networkAccess",
            "executionPolicy.networkAccess must be a boolean",
        );
    }
    match policy.get("maxRuntimeSeconds").and_then(Value::as_u64) {
        Some(1..=3600) => {}
        _ => helper_registry_failure(
            diagnostics,
            helper_id,
            "invalid_field_value",
            "executionPolicy.maxRuntimeSeconds",
            "executionPolicy.maxRuntimeSeconds must be between 1 and 3600",
        ),
    }
}

fn validate_helper_registry_binary_allowlist(
    diagnostics: &mut Vec<HelperRegistryDiagnostic>,
    helper_id: Option<&str>,
    value: &Value,
) {
    let Some(allowlist) = value.get("binaryAllowlist") else {
        helper_registry_failure(
            diagnostics,
            helper_id,
            "missing_required_field",
            "binaryAllowlist",
            "binaryAllowlist must be a JSON object",
        );
        return;
    };
    let Some(allowlist) = allowlist.as_object() else {
        helper_registry_failure(
            diagnostics,
            helper_id,
            "invalid_field_type",
            "binaryAllowlist",
            "binaryAllowlist must be a JSON object",
        );
        return;
    };
    validate_helper_registry_allowed_object_keys(
        diagnostics,
        helper_id,
        value.get("binaryAllowlist").expect("checked above"),
        "binaryAllowlist",
        &["entries"],
    );
    let Some(entries) = allowlist.get("entries").and_then(Value::as_array) else {
        helper_registry_failure(
            diagnostics,
            helper_id,
            SEMANTIC_HELPER_ALLOWLIST_MISSING_ENTRY,
            "binaryAllowlist.entries",
            "binaryAllowlist.entries must be a non-empty array",
        );
        return;
    };
    if entries.is_empty() {
        helper_registry_failure(
            diagnostics,
            helper_id,
            SEMANTIC_HELPER_ALLOWLIST_MISSING_ENTRY,
            "binaryAllowlist.entries",
            "binaryAllowlist.entries must include at least one helper binary entry",
        );
        return;
    }

    let registry_capabilities = value
        .get("capabilities")
        .and_then(Value::as_array)
        .map(|capabilities| {
            capabilities
                .iter()
                .filter_map(Value::as_str)
                .collect::<BTreeSet<_>>()
        })
        .unwrap_or_default();
    let registry_helper_id = value.get("helperId").and_then(Value::as_str);
    let mut seen_entry_ids = BTreeSet::new();

    for (index, entry) in entries.iter().enumerate() {
        let field = format!("binaryAllowlist.entries.{index}");
        let Some(entry) = entry.as_object() else {
            helper_registry_failure(
                diagnostics,
                helper_id,
                "invalid_field_type",
                &field,
                "binary allowlist entry must be a JSON object",
            );
            continue;
        };
        let entry_value = Value::Object(entry.clone());
        validate_helper_registry_allowed_object_keys(
            diagnostics,
            helper_id,
            &entry_value,
            &field,
            &[
                "allowlistEntryId",
                "helperId",
                "platform",
                "helperVersion",
                "executableName",
                "sha256Hash",
                "signature",
                "capabilities",
            ],
        );

        for child in [
            "allowlistEntryId",
            "helperId",
            "platform",
            "helperVersion",
            "executableName",
        ] {
            let child_field = format!("{field}.{child}");
            if let Some(text) = required_helper_registry_string(
                diagnostics,
                helper_id,
                &Value::Object(entry.clone()),
                &child_field,
            ) {
                validate_helper_registry_identifier(diagnostics, helper_id, &child_field, &text);
                if child == "executableName" && (text.contains('/') || text.contains('\\')) {
                    helper_registry_failure(
                        diagnostics,
                        helper_id,
                        "invalid_executable_name",
                        &child_field,
                        "helper binary executableName must be a filename, not a path",
                    );
                }
            }
        }

        if let Some(entry_id) = entry.get("allowlistEntryId").and_then(Value::as_str)
            && !seen_entry_ids.insert(entry_id.to_string())
        {
            helper_registry_failure(
                diagnostics,
                helper_id,
                "duplicate_helper_allowlist_entry",
                "binaryAllowlist.entries",
                "binary allowlist entry ids must be unique",
            );
        }
        if let (Some(registry_helper_id), Some(entry_helper_id)) = (
            registry_helper_id,
            entry.get("helperId").and_then(Value::as_str),
        ) && registry_helper_id != entry_helper_id
        {
            helper_registry_failure(
                diagnostics,
                helper_id,
                SEMANTIC_HELPER_ALLOWLIST_MISSING_ENTRY,
                &format!("{field}.helperId"),
                "binary allowlist entry helperId must match the registry helperId",
            );
        }

        match entry.get("sha256Hash").and_then(Value::as_str) {
            Some(hash) if is_sha256_ref(hash) => {}
            _ => helper_registry_failure(
                diagnostics,
                helper_id,
                "invalid_helper_binary_hash",
                &format!("{field}.sha256Hash"),
                "helper binary sha256Hash must be sha256:<64 lowercase hex>",
            ),
        }

        validate_helper_registry_binary_signature(
            diagnostics,
            helper_id,
            entry.get("signature"),
            &format!("{field}.signature"),
        );
        validate_helper_registry_binary_capabilities(
            diagnostics,
            helper_id,
            entry.get("capabilities"),
            &format!("{field}.capabilities"),
            &registry_capabilities,
        );
    }
}
