use super::*;

pub fn validate_profile_value(value: &Value) -> ProfileValidationResult {
    let mut failures = Vec::new();
    if !value.is_object() {
        failures.push(ProfileValidationFailure {
            code: "invalid_profile_shape".to_string(),
            field: "$".to_string(),
            message: "profile must be a JSON object".to_string(),
        });
        return profile_validation_result(None, failures, vec![]);
    }
    add_redaction_failures(&mut failures, value);
    add_profile_helper_execution_field_failures(&mut failures, value);

    let profile_id = required_string_value(&mut failures, value, "profileId");
    validate_schema_version(&mut failures, value);
    required_string_value(&mut failures, value, "gameId");
    required_string_value(&mut failures, value, "title");
    validate_locale_field(&mut failures, value, "sourceLocale");
    validate_engine(&mut failures, value.get("engine"));
    validate_source_fingerprint(&mut failures, value.get("sourceFingerprint"));
    let key_requirements = validate_key_requirements(&mut failures, value.get("keyRequirements"));
    validate_archive_parameters(&mut failures, value.get("archiveParameters"));
    validate_helper_evidence(&mut failures, value.get("helperEvidence"));
    let validated_assets = validate_assets(&mut failures, value.get("assets"));
    validate_layered_access_profile(
        &mut failures,
        value.get("layeredAccess"),
        &validated_assets.asset_ids,
        &key_requirements,
    );
    let profile_capabilities =
        validate_capabilities(&mut failures, value.get("capabilities"), "capabilities");
    for (field, capability) in validated_assets.patching_capabilities {
        if !profile_capabilities.contains(&capability) {
            failures.push(ProfileValidationFailure {
                code: "inconsistent_capability".to_string(),
                field,
                message: format!(
                    "asset patching capability {capability} must also appear in profile capabilities"
                ),
            });
        }
    }
    let requirements = validate_requirements(&mut failures, value.get("requirements"));
    validate_required_key_requirement_matches(&mut failures, &requirements, &key_requirements);

    profile_validation_result(profile_id, failures, requirements)
}

fn profile_validation_result(
    profile_id: Option<String>,
    failures: Vec<ProfileValidationFailure>,
    requirements: Vec<ProfileRequirement>,
) -> ProfileValidationResult {
    ProfileValidationResult {
        schema_version: PROFILE_SCHEMA_VERSION.to_string(),
        profile_id,
        status: if failures.is_empty() {
            OperationStatus::Passed
        } else {
            OperationStatus::Failed
        },
        failures,
        requirements,
    }
}

fn validate_schema_version(failures: &mut Vec<ProfileValidationFailure>, value: &Value) {
    match value.get("schemaVersion").and_then(Value::as_str) {
        Some(PROFILE_SCHEMA_VERSION) => {}
        Some(version) if version.trim().is_empty() => failures.push(ProfileValidationFailure {
            code: "missing_required_field".to_string(),
            field: "schemaVersion".to_string(),
            message: "schemaVersion must not be empty".to_string(),
        }),
        Some(version) => failures.push(ProfileValidationFailure {
            code: "unsupported_schema_version".to_string(),
            field: "schemaVersion".to_string(),
            message: format!("schemaVersion must be {PROFILE_SCHEMA_VERSION}, got {version}"),
        }),
        None => failures.push(ProfileValidationFailure {
            code: "missing_required_field".to_string(),
            field: "schemaVersion".to_string(),
            message: "schemaVersion must not be empty".to_string(),
        }),
    }
}

fn validate_engine(failures: &mut Vec<ProfileValidationFailure>, engine: Option<&Value>) {
    let Some(engine) = engine else {
        failures.push(ProfileValidationFailure {
            code: "missing_required_field".to_string(),
            field: "engine".to_string(),
            message: "engine must be a JSON object".to_string(),
        });
        return;
    };
    if !engine.is_object() {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: "engine".to_string(),
            message: "engine must be a JSON object".to_string(),
        });
        return;
    }
    let _ = required_string_value(failures, engine, "engine.adapterId");
    let _ = required_string_value(failures, engine, "engine.engineFamily");
    let _ = required_string_value(failures, engine, "engine.detectedVariant");
    if let Some(engine_version) = engine.get("engineVersion")
        && !engine_version.is_null()
        && engine_version
            .as_str()
            .is_none_or(|version| version.trim().is_empty())
    {
        failures.push(ProfileValidationFailure {
            code: "invalid_engine_version".to_string(),
            field: "engine.engineVersion".to_string(),
            message: "engine.engineVersion must be null or a non-empty string".to_string(),
        });
    }
}

fn add_redaction_failures(failures: &mut Vec<ProfileValidationFailure>, value: &Value) {
    for finding in validate_secret_redaction_boundary(value) {
        failures.push(ProfileValidationFailure {
            code: finding.code,
            field: finding.field,
            message: finding.reason,
        });
    }
}

fn add_profile_helper_execution_field_failures(
    failures: &mut Vec<ProfileValidationFailure>,
    value: &Value,
) {
    add_profile_helper_execution_field_failures_at(failures, value, "$");
}

fn add_profile_helper_execution_field_failures_at(
    failures: &mut Vec<ProfileValidationFailure>,
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
            failures.push(ProfileValidationFailure {
                code: SEMANTIC_HELPER_PROFILE_FORBIDDEN_EXECUTION_FIELD.to_string(),
                field: child_field.clone(),
                message: "profile data must not serialize arbitrary helper commands, args, env, shell, or executable paths".to_string(),
            });
        }
        if child.is_object() {
            add_profile_helper_execution_field_failures_at(failures, child, &child_field);
        } else if let Some(array) = child.as_array() {
            for (index, item) in array.iter().enumerate() {
                add_profile_helper_execution_field_failures_at(
                    failures,
                    item,
                    &format!("{child_field}.{index}"),
                );
            }
        }
    }
}
