use super::*;

pub(super) fn validate_helper_result_execution_forbidden_fields(
    failures: &mut Vec<HelperResultValidationFailure>,
    fixture_id: Option<&str>,
    value: &Value,
    field: &str,
) {
    let Some(object) = value.as_object() else {
        return;
    };
    for (key, child) in object {
        let child_field = format!("{field}.{key}");
        if helper_execution_config_field_is_forbidden(key) {
            helper_result_failure(
                failures,
                fixture_id,
                "forbidden_helper_execution_field",
                &child_field,
                "helper result execution metadata must not serialize arbitrary commands, args, env, or executable paths",
            );
        }
        if child.is_object() {
            validate_helper_result_execution_forbidden_fields(
                failures,
                fixture_id,
                child,
                &child_field,
            );
        } else if let Some(array) = child.as_array() {
            for (index, item) in array.iter().enumerate() {
                validate_helper_result_execution_forbidden_fields(
                    failures,
                    fixture_id,
                    item,
                    &format!("{child_field}.{index}"),
                );
            }
        }
    }
}

pub(super) fn validate_helper_result_diagnostic(
    failures: &mut Vec<HelperResultValidationFailure>,
    fixture_id: Option<&str>,
    diagnostic: Option<&Value>,
) -> Option<HelperDiagnosticCode> {
    let Some(diagnostic) = diagnostic else {
        helper_result_failure(
            failures,
            fixture_id,
            "missing_required_field",
            "diagnostic",
            "diagnostic must be a JSON object",
        );
        return None;
    };
    if !diagnostic.is_object() {
        helper_result_failure(
            failures,
            fixture_id,
            "invalid_field_type",
            "diagnostic",
            "diagnostic must be a JSON object",
        );
        return None;
    }
    validate_helper_result_allowed_object_keys(
        failures,
        fixture_id,
        diagnostic,
        "diagnostic",
        &["code", "message"],
    );
    let code = validate_helper_result_enum_string(
        failures,
        fixture_id,
        diagnostic,
        "diagnostic.code",
        &[
            "success",
            "missing_key",
            "wrong_key",
            "helper_required",
            "helper_unavailable",
            "helper_authorization_denied",
            "helper_timeout",
            "validation_failed",
            "unsupported_protected_executable",
            "redaction_failure",
        ],
    )
    .and_then(|code| serde_json::from_value::<HelperDiagnosticCode>(Value::String(code)).ok());
    if let Some(message) =
        required_helper_result_string(failures, fixture_id, diagnostic, "diagnostic.message")
    {
        validate_helper_result_safe_text(failures, fixture_id, "diagnostic.message", &message);
    }
    code
}

pub(super) fn validate_helper_result_redaction(
    failures: &mut Vec<HelperResultValidationFailure>,
    fixture_id: Option<&str>,
    redaction: Option<&Value>,
) -> Option<HelperRedactionStatus> {
    let Some(redaction) = redaction else {
        helper_result_failure(
            failures,
            fixture_id,
            "missing_required_field",
            "redaction",
            "redaction must be a JSON object",
        );
        return None;
    };
    if !redaction.is_object() {
        helper_result_failure(
            failures,
            fixture_id,
            "invalid_field_type",
            "redaction",
            "redaction must be a JSON object",
        );
        return None;
    }
    validate_helper_result_allowed_object_keys(
        failures,
        fixture_id,
        redaction,
        "redaction",
        &["status", "redactedLogHash"],
    );
    let status = validate_helper_result_enum_string(
        failures,
        fixture_id,
        redaction,
        "redaction.status",
        &["not_required", "redacted", "failed"],
    )
    .and_then(|status| serde_json::from_value::<HelperRedactionStatus>(Value::String(status)).ok());
    required_helper_result_string(failures, fixture_id, redaction, "redaction.redactedLogHash")
        .and_then(|hash| {
            validate_helper_result_proof_hash_string(
                failures,
                fixture_id,
                "redaction.redactedLogHash",
                hash,
            )
        });
    status
}

pub(super) fn validate_helper_result_secret_refs(
    failures: &mut Vec<HelperResultValidationFailure>,
    fixture_id: Option<&str>,
    secret_refs: Option<&Value>,
) -> Option<usize> {
    let Some(secret_refs) = secret_refs else {
        helper_result_failure(
            failures,
            fixture_id,
            "missing_required_field",
            "secretRefs",
            "secretRefs must be an array",
        );
        return None;
    };
    let Some(secret_refs) = secret_refs.as_array() else {
        helper_result_failure(
            failures,
            fixture_id,
            "invalid_field_type",
            "secretRefs",
            "secretRefs must be an array",
        );
        return None;
    };
    let mut seen = BTreeSet::new();
    for (index, secret_ref) in secret_refs.iter().enumerate() {
        let field = format!("secretRefs.{index}");
        if !secret_ref.is_object() {
            helper_result_failure(
                failures,
                fixture_id,
                "invalid_field_type",
                &field,
                "secretRefs entries must be JSON objects",
            );
            continue;
        }
        validate_helper_result_allowed_object_keys(
            failures,
            fixture_id,
            secret_ref,
            &field,
            &[
                "requirementId",
                "secretRef",
                "materialKind",
                "bytes",
                "validation",
            ],
        );
        if let Some(requirement_id) = required_helper_result_string(
            failures,
            fixture_id,
            secret_ref,
            &format!("{field}.requirementId"),
        ) {
            validate_helper_result_identifier(
                failures,
                fixture_id,
                &format!("{field}.requirementId"),
                &requirement_id,
            );
            if !seen.insert(requirement_id.clone()) {
                helper_result_failure(
                    failures,
                    fixture_id,
                    "duplicate_secret_ref",
                    "secretRefs",
                    &format!("secretRefs contains duplicate requirementId {requirement_id}"),
                );
            }
        }
        if let Some(secret_ref_text) = required_helper_result_string(
            failures,
            fixture_id,
            secret_ref,
            &format!("{field}.secretRef"),
        ) && let Err(message) = SecretRef::new(secret_ref_text)
        {
            helper_result_failure(
                failures,
                fixture_id,
                "invalid_secret_ref",
                &format!("{field}.secretRef"),
                &message,
            );
        }
        validate_helper_result_enum_string(
            failures,
            fixture_id,
            secret_ref,
            &format!("{field}.materialKind"),
            &[
                "fixedBytes",
                "hexBytes",
                "utf8String",
                "archivePassword",
                "rpgMakerAssetKey",
            ],
        );
        validate_helper_result_optional_positive_u32(
            failures,
            fixture_id,
            secret_ref.get("bytes"),
            &format!("{field}.bytes"),
        );
        if let Some(validation) = secret_ref.get("validation") {
            validate_helper_result_key_validation_proof(
                failures,
                fixture_id,
                validation,
                &format!("{field}.validation"),
            );
        }
    }
    Some(secret_refs.len())
}

pub(super) fn validate_helper_result_proof_hashes(
    failures: &mut Vec<HelperResultValidationFailure>,
    fixture_id: Option<&str>,
    proof_hashes: Option<&Value>,
) -> Option<usize> {
    let Some(proof_hashes) = proof_hashes else {
        helper_result_failure(
            failures,
            fixture_id,
            "missing_required_field",
            "proofHashes",
            "proofHashes must be an array",
        );
        return None;
    };
    let Some(proof_hashes) = proof_hashes.as_array() else {
        helper_result_failure(
            failures,
            fixture_id,
            "invalid_field_type",
            "proofHashes",
            "proofHashes must be an array",
        );
        return None;
    };
    for (index, proof) in proof_hashes.iter().enumerate() {
        validate_helper_result_key_validation_proof(
            failures,
            fixture_id,
            proof,
            &format!("proofHashes.{index}"),
        );
    }
    Some(proof_hashes.len())
}
