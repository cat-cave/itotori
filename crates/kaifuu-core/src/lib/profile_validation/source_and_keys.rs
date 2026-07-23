use super::*;

pub(super) fn validate_source_fingerprint(
    failures: &mut Vec<ProfileValidationFailure>,
    source_fingerprint: Option<&Value>,
) {
    let Some(source_fingerprint) = source_fingerprint else {
        return;
    };
    let Some(source_fingerprint) = source_fingerprint.as_object() else {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: "sourceFingerprint".to_string(),
            message: "sourceFingerprint must be a JSON object".to_string(),
        });
        return;
    };

    if let Some(game_root_hash) = source_fingerprint.get("gameRootHash")
        && !game_root_hash.is_null()
    {
        validate_sha256_ref_value(failures, game_root_hash, "sourceFingerprint.gameRootHash");
    }

    let Some(engine_evidence) = source_fingerprint.get("engineEvidence") else {
        failures.push(ProfileValidationFailure {
            code: "missing_required_field".to_string(),
            field: "sourceFingerprint.engineEvidence".to_string(),
            message: "sourceFingerprint.engineEvidence must list local-safe evidence names"
                .to_string(),
        });
        return;
    };
    let Some(engine_evidence) = engine_evidence.as_array() else {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: "sourceFingerprint.engineEvidence".to_string(),
            message: "sourceFingerprint.engineEvidence must be an array".to_string(),
        });
        return;
    };
    if engine_evidence.is_empty() {
        failures.push(ProfileValidationFailure {
            code: "missing_required_field".to_string(),
            field: "sourceFingerprint.engineEvidence".to_string(),
            message: "sourceFingerprint.engineEvidence must not be empty".to_string(),
        });
    }
    for (index, evidence) in engine_evidence.iter().enumerate() {
        let field = format!("sourceFingerprint.engineEvidence.{index}");
        let Some(evidence) = evidence.as_str() else {
            failures.push(ProfileValidationFailure {
                code: "invalid_field_type".to_string(),
                field,
                message: "engine evidence must be a string".to_string(),
            });
            continue;
        };
        if evidence.trim().is_empty() {
            failures.push(ProfileValidationFailure {
                code: "missing_required_field".to_string(),
                field,
                message: "engine evidence must not be empty".to_string(),
            });
            continue;
        }
        validate_profile_relative_path(failures, &field, evidence);
    }
}

pub(super) fn validate_key_requirements(
    failures: &mut Vec<ProfileValidationFailure>,
    key_requirements: Option<&Value>,
) -> Vec<KeyRequirement> {
    let Some(key_requirements) = key_requirements else {
        return vec![];
    };
    let Some(key_requirements) = key_requirements.as_array() else {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: "keyRequirements".to_string(),
            message: "keyRequirements must be an array".to_string(),
        });
        return vec![];
    };

    let mut parsed = Vec::new();
    let mut seen = BTreeSet::new();
    for (index, requirement_value) in key_requirements.iter().enumerate() {
        let field = format!("keyRequirements.{index}");
        let Some(requirement_object) = requirement_value.as_object() else {
            failures.push(ProfileValidationFailure {
                code: "invalid_field_type".to_string(),
                field,
                message: "key requirement must be a JSON object".to_string(),
            });
            continue;
        };

        let requirement_id = required_string_value(
            failures,
            requirement_value,
            &format!("{field}.requirementId"),
        );
        let secret_ref =
            required_string_value(failures, requirement_value, &format!("{field}.secretRef"))
                .and_then(|secret_ref| validate_secret_ref(failures, &field, secret_ref));
        let kind = validate_enum_string(
            failures,
            requirement_value,
            &format!("{field}.kind"),
            &[
                "fixedBytes",
                "hexBytes",
                "utf8String",
                "archivePassword",
                "rpgMakerAssetKey",
            ],
        )
        .and_then(|kind| {
            serde_json::from_value::<KeyMaterialKind>(Value::String(kind.clone()))
                .map_err(|_| kind)
                .ok()
        });
        let bytes = validate_optional_positive_u32(
            failures,
            requirement_object.get("bytes"),
            &format!("{field}.bytes"),
        );
        let validation = requirement_object.get("validation").and_then(|validation| {
            validate_key_validation_proof(failures, validation, &format!("{field}.validation"))
        });

        if let Some(requirement_id) = requirement_id.as_deref() {
            if !seen.insert(requirement_id.to_string()) {
                failures.push(ProfileValidationFailure {
                    code: "duplicate_key_requirement".to_string(),
                    field: "keyRequirements".to_string(),
                    message: format!("key requirement {requirement_id} appears more than once"),
                });
            }
            validate_identifier(failures, &format!("{field}.requirementId"), requirement_id);
        }

        if matches!(
            kind,
            Some(KeyMaterialKind::FixedBytes | KeyMaterialKind::HexBytes)
        ) && bytes.is_none()
        {
            failures.push(ProfileValidationFailure {
                code: "missing_required_field".to_string(),
                field: format!("{field}.bytes"),
                message: "fixed and hex key requirements must declare byte length".to_string(),
            });
        }

        if let (Some(requirement_id), Some(secret_ref), Some(kind)) =
            (requirement_id, secret_ref, kind)
        {
            parsed.push(KeyRequirement {
                requirement_id,
                secret_ref,
                kind,
                bytes,
                validation,
            });
        }
    }
    parsed
}

pub(super) fn validate_required_key_requirement_matches(
    failures: &mut Vec<ProfileValidationFailure>,
    requirements: &[ProfileRequirement],
    key_requirements: &[KeyRequirement],
) {
    let key_requirement_ids = key_requirements
        .iter()
        .map(|requirement| requirement.requirement_id.as_str())
        .collect::<BTreeSet<_>>();
    for requirement in requirements.iter().filter(|requirement| {
        requirement.category == RequirementCategory::SecretKey
            && requirement.status != RequirementStatus::NotRequired
    }) {
        if key_requirement_ids.contains(requirement.key.as_str()) {
            continue;
        }
        failures.push(ProfileValidationFailure {
            code: SemanticErrorCode::MissingKeyProfile.to_string(),
            field: "keyRequirements".to_string(),
            message: format!(
                "required secret key {} must have a matching keyRequirements.requirementId with a valid secretRef",
                requirement.key
            ),
        });
    }
}

pub(super) fn validate_archive_parameters(
    failures: &mut Vec<ProfileValidationFailure>,
    archive_parameters: Option<&Value>,
) -> Vec<ArchiveParameter> {
    let Some(archive_parameters) = archive_parameters else {
        return vec![];
    };
    let Some(archive_parameters) = archive_parameters.as_array() else {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: "archiveParameters".to_string(),
            message: "archiveParameters must be an array".to_string(),
        });
        return vec![];
    };

    let mut parsed = Vec::new();
    let mut seen = BTreeSet::new();
    for (index, parameter) in archive_parameters.iter().enumerate() {
        let field = format!("archiveParameters.{index}");
        let Some(parameter_object) = parameter.as_object() else {
            failures.push(ProfileValidationFailure {
                code: "invalid_field_type".to_string(),
                field,
                message: "archive parameter must be a JSON object".to_string(),
            });
            continue;
        };
        let parameter_id =
            required_string_value(failures, parameter, &format!("{field}.parameterId"));
        let name = required_string_value(failures, parameter, &format!("{field}.name"));
        let kind = validate_enum_string(
            failures,
            parameter,
            &format!("{field}.kind"),
            &[
                "archiveFormat",
                "compression",
                "cipherScheme",
                "encoding",
                "variant",
                "other",
            ],
        )
        .and_then(|kind| {
            serde_json::from_value::<ArchiveParameterKind>(Value::String(kind.clone()))
                .map_err(|_| kind)
                .ok()
        });
        let value = required_string_value(failures, parameter, &format!("{field}.value"));
        let source = parameter_object
            .get("source")
            .and_then(|_| {
                validate_enum_string(
                    failures,
                    parameter,
                    &format!("{field}.source"),
                    &["adapterDefault", "detected", "manual", "helperEvidence"],
                )
            })
            .and_then(|source| {
                serde_json::from_value::<ArchiveParameterSource>(Value::String(source.clone()))
                    .map_err(|_| source)
                    .ok()
            });

        if let Some(parameter_id) = parameter_id.as_deref() {
            if !seen.insert(parameter_id.to_string()) {
                failures.push(ProfileValidationFailure {
                    code: "duplicate_archive_parameter".to_string(),
                    field: "archiveParameters".to_string(),
                    message: format!("archive parameter {parameter_id} appears more than once"),
                });
            }
            validate_identifier(failures, &format!("{field}.parameterId"), parameter_id);
        }

        if let (Some(parameter_id), Some(name), Some(kind), Some(value)) =
            (parameter_id, name, kind, value)
        {
            parsed.push(ArchiveParameter {
                parameter_id,
                name,
                kind,
                value,
                source,
            });
        }
    }
    parsed
}

pub(super) fn validate_helper_evidence(
    failures: &mut Vec<ProfileValidationFailure>,
    helper_evidence: Option<&Value>,
) -> Option<HelperEvidence> {
    let helper_evidence = helper_evidence?;
    let Some(helper_object) = helper_evidence.as_object() else {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: "helperEvidence".to_string(),
            message: "helperEvidence must be a JSON object".to_string(),
        });
        return None;
    };
    let helper_kind = validate_enum_string(
        failures,
        helper_evidence,
        "helperEvidence.helperKind",
        &[
            "staticParser",
            "knownKeyDatabaseImport",
            "wineLocalWindowsHelper",
            "remoteWindowsHelper",
            "manualKeyEntry",
        ],
    )
    .and_then(|helper_kind| {
        serde_json::from_value::<HelperKind>(Value::String(helper_kind.clone()))
            .map_err(|_| helper_kind)
            .ok()
    });
    let tool_version =
        required_string_value(failures, helper_evidence, "helperEvidence.toolVersion");
    let redacted_log_hash =
        required_string_value(failures, helper_evidence, "helperEvidence.redactedLogHash")
            .and_then(|hash| {
                validate_sha256_ref_string(failures, "helperEvidence.redactedLogHash", hash)
            });
    let proof_hashes = validate_optional_proof_hashes(
        failures,
        helper_object.get("proofHashes"),
        "helperEvidence.proofHashes",
    );

    if let (Some(helper_kind), Some(tool_version), Some(redacted_log_hash)) =
        (helper_kind, tool_version, redacted_log_hash)
    {
        return Some(HelperEvidence {
            helper_kind,
            tool_version,
            redacted_log_hash,
            proof_hashes,
        });
    }
    None
}

fn validate_optional_proof_hashes(
    failures: &mut Vec<ProfileValidationFailure>,
    proof_hashes: Option<&Value>,
    field: &str,
) -> Vec<KeyValidationProof> {
    let Some(proof_hashes) = proof_hashes else {
        return vec![];
    };
    let Some(proof_hashes) = proof_hashes.as_array() else {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: field.to_string(),
            message: "proofHashes must be an array".to_string(),
        });
        return vec![];
    };
    proof_hashes
        .iter()
        .enumerate()
        .filter_map(|(index, proof)| {
            validate_key_validation_proof(failures, proof, &format!("{field}.{index}"))
        })
        .collect()
}

fn validate_key_validation_proof(
    failures: &mut Vec<ProfileValidationFailure>,
    validation: &Value,
    field: &str,
) -> Option<KeyValidationProof> {
    if !validation.is_object() {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: field.to_string(),
            message: "key validation proof must be a JSON object".to_string(),
        });
        return None;
    }
    let method = validate_enum_string(
        failures,
        validation,
        &format!("{field}.method"),
        &[
            "decryptHeaderProof",
            "archiveIndexProof",
            "knownPlaintextProof",
            "fixtureRoundTripProof",
        ],
    )
    .and_then(|method| {
        serde_json::from_value::<KeyValidationMethod>(Value::String(method.clone()))
            .map_err(|_| method)
            .ok()
    });
    let proof_hash = required_string_value(failures, validation, &format!("{field}.proofHash"))
        .and_then(|hash| validate_sha256_ref_string(failures, &format!("{field}.proofHash"), hash));
    if let (Some(method), Some(proof_hash)) = (method, proof_hash) {
        return Some(KeyValidationProof { method, proof_hash });
    }
    None
}

fn validate_secret_ref(
    failures: &mut Vec<ProfileValidationFailure>,
    parent_field: &str,
    secret_ref: String,
) -> Option<SecretRef> {
    match SecretRef::new(secret_ref) {
        Ok(secret_ref) => Some(secret_ref),
        Err(message) => {
            failures.push(ProfileValidationFailure {
                code: "invalid_secret_ref".to_string(),
                field: format!("{parent_field}.secretRef"),
                message,
            });
            None
        }
    }
}

fn validate_sha256_ref_value(
    failures: &mut Vec<ProfileValidationFailure>,
    value: &Value,
    field: &str,
) -> Option<ProofHash> {
    let Some(hash) = value.as_str() else {
        failures.push(ProfileValidationFailure {
            code: "invalid_proof_hash".to_string(),
            field: field.to_string(),
            message: format!("{field} must be a sha256:<64 lowercase hex> string"),
        });
        return None;
    };
    validate_sha256_ref_string(failures, field, hash.to_string())
}

fn validate_sha256_ref_string(
    failures: &mut Vec<ProfileValidationFailure>,
    field: &str,
    hash: String,
) -> Option<ProofHash> {
    match ProofHash::new(hash) {
        Ok(hash) => Some(hash),
        Err(message) => {
            failures.push(ProfileValidationFailure {
                code: "invalid_proof_hash".to_string(),
                field: field.to_string(),
                message,
            });
            None
        }
    }
}

fn validate_optional_positive_u32(
    failures: &mut Vec<ProfileValidationFailure>,
    value: Option<&Value>,
    field: &str,
) -> Option<u32> {
    let value = value?;
    let Some(value) = value.as_u64() else {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_type".to_string(),
            field: field.to_string(),
            message: format!("{field} must be a positive integer"),
        });
        return None;
    };
    if value == 0 || value > u32::MAX as u64 {
        failures.push(ProfileValidationFailure {
            code: "invalid_field_value".to_string(),
            field: field.to_string(),
            message: format!("{field} must be a positive 32-bit integer"),
        });
        return None;
    }
    Some(value as u32)
}
