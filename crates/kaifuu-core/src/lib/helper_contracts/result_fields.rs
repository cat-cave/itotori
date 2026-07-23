use super::*;

pub(super) fn validate_helper_result_key_validation_proof(
    failures: &mut Vec<HelperResultValidationFailure>,
    fixture_id: Option<&str>,
    validation: &Value,
    field: &str,
) {
    if !validation.is_object() {
        helper_result_failure(
            failures,
            fixture_id,
            "invalid_field_type",
            field,
            "validation proof must be a JSON object",
        );
        return;
    }
    validate_helper_result_allowed_object_keys(
        failures,
        fixture_id,
        validation,
        field,
        &["method", "proofHash"],
    );
    validate_helper_result_enum_string(
        failures,
        fixture_id,
        validation,
        &format!("{field}.method"),
        &[
            "decryptHeaderProof",
            "archiveIndexProof",
            "knownPlaintextProof",
            "fixtureRoundTripProof",
        ],
    );
    required_helper_result_string(
        failures,
        fixture_id,
        validation,
        &format!("{field}.proofHash"),
    )
    .and_then(|hash| {
        validate_helper_result_proof_hash_string(
            failures,
            fixture_id,
            &format!("{field}.proofHash"),
            hash,
        )
    });
}

pub(super) fn required_helper_result_string(
    failures: &mut Vec<HelperResultValidationFailure>,
    fixture_id: Option<&str>,
    value: &Value,
    field: &str,
) -> Option<String> {
    let key = field.rsplit('.').next().unwrap_or(field);
    match value.get(key).and_then(Value::as_str) {
        Some(text) if !text.trim().is_empty() => Some(text.to_string()),
        Some(_) | None => {
            helper_result_failure(
                failures,
                fixture_id,
                "missing_required_field",
                field,
                &format!("{field} must not be empty"),
            );
            None
        }
    }
}

pub(super) fn validate_helper_result_enum_string(
    failures: &mut Vec<HelperResultValidationFailure>,
    fixture_id: Option<&str>,
    value: &Value,
    field: &str,
    allowed: &[&str],
) -> Option<String> {
    let key = field.rsplit('.').next().unwrap_or(field);
    let Some(text) = value.get(key).and_then(Value::as_str) else {
        helper_result_failure(
            failures,
            fixture_id,
            "invalid_enum_value",
            field,
            &format!("{field} must be one of {}", allowed.join(", ")),
        );
        return None;
    };
    if !allowed.contains(&text) {
        helper_result_failure(
            failures,
            fixture_id,
            "invalid_enum_value",
            field,
            &format!("{field} must be one of {}", allowed.join(", ")),
        );
        return None;
    }
    Some(text.to_string())
}

pub(super) fn validate_helper_result_optional_positive_u32(
    failures: &mut Vec<HelperResultValidationFailure>,
    fixture_id: Option<&str>,
    value: Option<&Value>,
    field: &str,
) -> Option<u32> {
    let value = value?;
    let Some(value) = value.as_u64() else {
        helper_result_failure(
            failures,
            fixture_id,
            "invalid_field_type",
            field,
            &format!("{field} must be a positive integer"),
        );
        return None;
    };
    if value == 0 || value > u32::MAX as u64 {
        helper_result_failure(
            failures,
            fixture_id,
            "invalid_field_value",
            field,
            &format!("{field} must be a positive 32-bit integer"),
        );
        return None;
    }
    Some(value as u32)
}

pub(super) fn validate_helper_result_bounded_u32(
    failures: &mut Vec<HelperResultValidationFailure>,
    fixture_id: Option<&str>,
    value: Option<&Value>,
    field: &str,
    min: u64,
    max: u64,
) -> Option<u32> {
    let Some(value) = value else {
        helper_result_failure(
            failures,
            fixture_id,
            "missing_required_field",
            field,
            &format!("{field} must be between {min} and {max}"),
        );
        return None;
    };
    let Some(value) = value.as_u64() else {
        helper_result_failure(
            failures,
            fixture_id,
            "invalid_field_type",
            field,
            &format!("{field} must be an integer"),
        );
        return None;
    };
    if value < min || value > max || value > u32::MAX as u64 {
        helper_result_failure(
            failures,
            fixture_id,
            "invalid_field_value",
            field,
            &format!("{field} must be between {min} and {max}"),
        );
        return None;
    }
    Some(value as u32)
}

pub(super) fn validate_helper_result_proof_hash_string(
    failures: &mut Vec<HelperResultValidationFailure>,
    fixture_id: Option<&str>,
    field: &str,
    hash: String,
) -> Option<ProofHash> {
    match ProofHash::new(hash) {
        Ok(hash) => Some(hash),
        Err(message) => {
            helper_result_failure(failures, fixture_id, "invalid_proof_hash", field, &message);
            None
        }
    }
}

pub(super) fn validate_helper_result_identifier(
    failures: &mut Vec<HelperResultValidationFailure>,
    fixture_id: Option<&str>,
    field: &str,
    value: &str,
) {
    if value.chars().any(char::is_whitespace) || value.contains('\0') {
        helper_result_failure(
            failures,
            fixture_id,
            "invalid_identifier",
            field,
            &format!("{field} must not contain whitespace or null bytes"),
        );
    }
}

pub(super) fn validate_public_fixture_label(
    failures: &mut Vec<HelperResultValidationFailure>,
    fixture_id: Option<&str>,
    field: &str,
    value: &str,
) {
    let valid = value.chars().all(|character| {
        character.is_ascii_lowercase()
            || character.is_ascii_digit()
            || matches!(character, '-' | '_' | '.')
    }) && value
        .chars()
        .next()
        .is_some_and(|character| character.is_ascii_lowercase() || character.is_ascii_digit());
    if !valid {
        helper_result_failure(
            failures,
            fixture_id,
            "invalid_fixture_id",
            field,
            "fixtureId must be a public fixture id",
        );
    }
}

pub(super) fn validate_helper_result_safe_text(
    failures: &mut Vec<HelperResultValidationFailure>,
    fixture_id: Option<&str>,
    field: &str,
    value: &str,
) {
    if redact_for_log_or_report(value) != value {
        helper_result_failure(
            failures,
            fixture_id,
            SEMANTIC_SECRET_REDACTED,
            field,
            "helper result text must be redacted before persistence",
        );
    }
}

pub(super) fn helper_result_failure(
    failures: &mut Vec<HelperResultValidationFailure>,
    fixture_id: Option<&str>,
    code: &str,
    field: &str,
    message: &str,
) {
    failures.push(HelperResultValidationFailure {
        fixture_id: fixture_id.map(redact_for_log_or_report),
        code: code.to_string(),
        field: field.to_string(),
        message: redact_for_log_or_report(message),
    });
}
