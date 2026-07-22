#[cfg(unix)]
#[test]
fn local_secret_directory_store_rejects_final_and_intermediate_symlinks() {
    use std::os::unix::fs::symlink;

    let root = temp_dir("local-secret-store-symlink");
    let outside = temp_dir("local-secret-store-symlink-outside");
    fs::create_dir_all(root.join("fixture")).unwrap();
    fs::create_dir_all(outside.join("escape")).unwrap();
    fs::write(
        outside.join("escape").join("secondary-key"),
        (0_u8..16).collect::<Vec<_>>(),
    )
    .unwrap();
    fs::write(
        root.join("fixture").join("real-key"),
        (0_u8..16).collect::<Vec<_>>(),
    )
    .unwrap();
    symlink(
        outside.join("escape"),
        root.join("fixture").join("linked-dir"),
    )
    .unwrap();
    symlink(
        root.join("fixture").join("real-key"),
        root.join("fixture").join("linked-key"),
    )
    .unwrap();

    let store = LocalSecretDirectoryStore::new(&root);
    assert_key_resolver_error(
        store.read_secret("fixture/linked-dir/secondary-key"),
        KeyResolverErrorKind::OutOfPolicy,
        SemanticErrorCode::SecretRefOutOfPolicy,
    );
    assert_key_resolver_error(
        store.read_secret("fixture/linked-key"),
        KeyResolverErrorKind::OutOfPolicy,
        SemanticErrorCode::SecretRefOutOfPolicy,
    );
    assert!(store.support_boundary().contains("device/inode"));
}

#[cfg(not(unix))]
#[test]
fn local_secret_directory_store_documents_non_unix_final_open_boundary() {
    let store = LocalSecretDirectoryStore::new("ignored");

    assert!(
        store
            .support_boundary()
            .contains("unavailable on this platform")
    );
}

#[test]
fn profile_validation_rejects_account_shaped_secret_ref_names() {
    for secret_ref in [
        "local-secret:provider:customer/key",
        "local-secret:customer@example/key",
    ] {
        let mut profile = valid_key_profile_value();
        profile["keyRequirements"][0]["secretRef"] = serde_json::json!(secret_ref);
        let validation = validate_profile_value(&profile);

        assert_eq!(validation.status, OperationStatus::Failed);
        assert!(
            validation.failures.iter().any(|failure| {
                failure.code == "invalid_secret_ref"
                    && failure.field == "keyRequirements.0.secretRef"
            }),
            "missing account-shaped secretRef failure for {secret_ref}: {:#?}",
            validation.failures
        );
    }
}

#[test]
fn profile_validation_requires_matching_key_requirement_ids() {
    let mut profile = valid_key_profile_value();
    profile["keyRequirements"][0]["requirementId"] = serde_json::json!("siglus-unrelated-key");

    let validation = validate_profile_value(&profile);

    assert_eq!(validation.status, OperationStatus::Failed);
    assert!(
        validation.failures.iter().any(|failure| {
            failure.code == SEMANTIC_MISSING_KEY_PROFILE
                && failure.field == "keyRequirements"
                && failure.message.contains("siglus-secondary-key")
        }),
        "missing strict key requirement match failure: {:#?}",
        validation.failures
    );
}

#[test]
fn profile_validation_rejects_base64url_raw_secret_refs() {
    let mut profile = valid_key_profile_value();
    let raw_base64url = "local-secret:mP9xZpQ2rS7vLj4N8aW_KtYd0hF3uC6b";
    profile["keyRequirements"][0]["secretRef"] = serde_json::json!(raw_base64url);

    let validation = validate_profile_value(&profile);

    assert_eq!(validation.status, OperationStatus::Failed);
    assert!(
        validation.failures.iter().any(|failure| {
            failure.code == "invalid_secret_ref" && failure.field == "keyRequirements.0.secretRef"
        }),
        "missing raw secretRef failure: {:#?}",
        validation.failures
    );
    assert!(SecretRef::new("local-secret:siglus-primary-key").is_ok());
}

#[test]
fn profile_validation_rejects_all_letter_base64url_raw_secret_refs() {
    let mut profile = valid_key_profile_value();
    profile["keyRequirements"][0]["secretRef"] =
        serde_json::json!(format!("local-secret:{ALL_LETTER_RAW_KEY_MATERIAL}"));

    let validation = validate_profile_value(&profile);

    assert_eq!(validation.status, OperationStatus::Failed);
    assert!(
        validation.failures.iter().any(|failure| {
            failure.code == "invalid_secret_ref" && failure.field == "keyRequirements.0.secretRef"
        }),
        "missing all-letter raw secretRef failure: {:#?}",
        validation.failures
    );
    assert!(SecretRef::new("local-secret:siglus-primary-key").is_ok());
    assert!(SecretRef::new("local-secret:rpgmaker-mv-key").is_ok());
}

#[test]
fn profile_validation_rejects_raw_archive_parameter_key_values() {
    let mut profile = valid_key_profile_value();
    let raw_base64url = "mP9xZpQ2rS7vLj4N8aW_KtYd0hF3uC6b";
    profile["archiveParameters"][0]["name"] = serde_json::json!("cipherKey");
    profile["archiveParameters"][0]["kind"] = serde_json::json!("cipherScheme");
    profile["archiveParameters"][0]["value"] = serde_json::json!(raw_base64url);

    let validation = validate_profile_value(&profile);

    assert_eq!(validation.status, OperationStatus::Failed);
    assert!(
        validation.failures.iter().any(|failure| {
            failure.code == SEMANTIC_SECRET_REDACTED && failure.field == "archiveParameters.0.value"
        }),
        "missing raw archive parameter redaction failure: {:#?}",
        validation.failures
    );

    let redacted = redact_secret_bearing_value(&profile);
    assert_eq!(
        redacted.value["archiveParameters"][0]["value"],
        format!("[REDACTED:{SEMANTIC_SECRET_REDACTED}]")
    );
    assert!(
        !serde_json::to_string(&redacted.value)
            .unwrap()
            .contains(raw_base64url)
    );
}

#[test]
fn profile_validation_rejects_all_letter_raw_archive_parameter_key_values() {
    for parameter_name in ["archiveKey", "cipherMaterial", "secretMaterial"] {
        let mut profile = valid_key_profile_value();
        profile["archiveParameters"][0]["name"] = serde_json::json!(parameter_name);
        profile["archiveParameters"][0]["kind"] = serde_json::json!("cipherScheme");
        profile["archiveParameters"][0]["value"] = serde_json::json!(ALL_LETTER_RAW_KEY_MATERIAL);
        profile["archiveParameters"][0]["source"] = serde_json::json!("manual");

        let validation = validate_profile_value(&profile);

        assert_eq!(validation.status, OperationStatus::Failed);
        assert!(
            validation.failures.iter().any(|failure| {
                failure.code == SEMANTIC_SECRET_REDACTED
                    && failure.field == "archiveParameters.0.value"
            }),
            "missing all-letter raw archive parameter redaction failure for {parameter_name}: {:#?}",
            validation.failures
        );

        let redacted = redact_secret_bearing_value(&profile);
        assert_eq!(
            redacted.value["archiveParameters"][0]["value"],
            format!("[REDACTED:{SEMANTIC_SECRET_REDACTED}]")
        );
        assert!(
            !serde_json::to_string(&redacted.value)
                .unwrap()
                .contains(ALL_LETTER_RAW_KEY_MATERIAL)
        );
    }
}

#[test]
fn profile_validation_rejects_raw_key_material_and_private_evidence() {
    let mut profile = valid_key_profile_value();
    profile["keyRequirements"][0]["rawKey"] = serde_json::json!("00112233445566778899aabbccddeeff");
    profile["helperEvidence"]["helperDump"] = serde_json::json!("register dump with key bytes");
    profile["metadata"]["localPath"] = serde_json::json!("/home/dev/private-game");
    profile["metadata"]["decryptedText"] = serde_json::json!("private translated script line");

    let validation = validate_profile_value(&profile);

    assert_eq!(validation.status, OperationStatus::Failed);
    for field in [
        "keyRequirements.0.rawKey",
        "helperEvidence.helperDump",
        "metadata.localPath",
        "metadata.decryptedText",
    ] {
        assert!(
            validation.failures.iter().any(|failure| {
                failure.code == SEMANTIC_SECRET_REDACTED && failure.field == field
            }),
            "missing redaction failure for {field}: {:#?}",
            validation.failures
        );
    }

    let redacted = redact_secret_bearing_value(&profile);
    assert_eq!(
        redacted.value["keyRequirements"][0]["secretRef"],
        "local-secret:siglus/example/secondary-key"
    );
    let serialized = serde_json::to_string(&redacted.value).unwrap();
    assert!(!serialized.contains("00112233445566778899aabbccddeeff"));
    assert!(!serialized.contains("/home/dev/private-game"));
    assert!(!serialized.contains("private translated script line"));
}

#[test]
fn profile_validation_rejects_arbitrary_helper_command_metadata() {
    let mut profile = valid_key_profile_value();
    profile["metadata"]["command"] = serde_json::json!("sh -c helper");
    profile["metadata"]["args"] = serde_json::json!("--dump");
    profile["helperEvidence"]["executable"] = serde_json::json!("helper.exe");
    profile["helperEvidence"]["path"] = serde_json::json!("helpers/key-helper.exe");
    profile["helperEvidence"]["config"] = serde_json::json!({"path": "helpers/key-helper.exe"});

    let validation = validate_profile_value(&profile).redacted_for_report();

    assert_eq!(validation.status, OperationStatus::Failed);
    for field in [
        "metadata.command",
        "metadata.args",
        "helperEvidence.executable",
        "helperEvidence.path",
        "helperEvidence.config",
        "helperEvidence.config.path",
    ] {
        assert!(
            validation.failures.iter().any(|failure| {
                failure.code == SEMANTIC_HELPER_PROFILE_FORBIDDEN_EXECUTION_FIELD
                    && failure.field == field
            }),
            "missing forbidden profile helper execution diagnostic for {field}: {:#?}",
            validation.failures
        );
    }
    let serialized = serde_json::to_string(&validation).unwrap();
    assert!(!serialized.contains("sh -c helper"));
}

#[test]
fn profile_validation_scans_requirement_and_capability_free_text_fields() {
    let mut profile = valid_key_profile_value();
    profile["requirements"][0]["status"] = serde_json::json!("missing");
    profile["requirements"][0]["description"] = serde_json::json!(
        "helper dump source:/home/dev/game/private-route-ending.ks included raw key 00112233445566778899aabbccddeeff"
    );
    profile["requirements"][0]["placeholder"] =
        serde_json::json!("file=C:\\Games\\SecretRoute\\key.bin");
    profile["capabilities"][1]["limitation"] =
        serde_json::json!("decrypted text from private-route-ending.ks requires local review");

    let validation = validate_profile_value(&profile);

    assert_eq!(validation.status, OperationStatus::Failed);
    for field in [
        "requirements.0.description",
        "requirements.0.placeholder",
        "capabilities.1.limitation",
    ] {
        assert!(
            validation.failures.iter().any(|failure| {
                failure.code == SEMANTIC_SECRET_REDACTED && failure.field == field
            }),
            "missing free-text redaction failure for {field}: {:#?}",
            validation.failures
        );
    }

    let redacted = validation.redacted_for_report();
    let serialized = serde_json::to_string(&redacted).unwrap();
    assert!(!serialized.contains("/home/dev/game"));
    assert!(!serialized.contains("C:\\Games"));
    assert!(!serialized.contains("helper dump"));
    assert!(!serialized.contains("decrypted text"));
    assert!(!serialized.contains("00112233445566778899aabbccddeeff"));
    assert!(!serialized.contains("private-route-ending.ks"));
}

#[test]
fn log_report_redaction_catches_embedded_local_path_formats() {
    for text in [
        "helper failed path=/home/dev/game",
        "helper failed source:/home/dev/game",
        "helper failed file=C:\\Games\\SecretRoute\\game.exe",
        "helper failed path=~/games/private/key.bin",
        "helper failed path=$HOME/games/key.bin",
        "helper failed path=%USERPROFILE%\\Games\\key.bin",
    ] {
        let redacted = redact_for_log_or_report(text);
        assert_eq!(
            redacted,
            format!("[REDACTED:{SEMANTIC_SECRET_REDACTED}]"),
            "{text} should be redacted"
        );
    }
}

#[test]
fn report_value_redaction_covers_secret_keys_paths_and_nested_payload_text() {
    let value = serde_json::json!({
        "adapterId": "kaifuu.fixture",
        "rawKey": "actual-secret",
        "metadata": {
            "localPath": "~/Private Route Spoiler Game",
            "safeRelativePath": "scripts/common.ks",
            "diagnostic": "source=$HOME/games/private-key.bin"
        },
        "failures": [
            {
                "message": "decrypted text included 00112233445566778899aabbccddeeff",
                "assetRef": "%USERPROFILE%\\Games\\private-key.bin"
            }
        ]
    });

    let redacted = redact_report_value(&value);
    let serialized = serde_json::to_string(&redacted).unwrap();

    assert_eq!(redacted["adapterId"], "kaifuu.fixture");
    assert_eq!(
        redacted["metadata"]["safeRelativePath"],
        "scripts/common.ks"
    );
    assert!(serialized.contains(SEMANTIC_SECRET_REDACTED));
    for forbidden in [
        "actual-secret",
        "~/Private Route Spoiler Game",
        "$HOME/games",
        "%USERPROFILE%",
        "Private Route Spoiler Game",
        "private-key.bin",
        "decrypted text",
        "00112233445566778899aabbccddeeff",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "redacted report value leaked {forbidden}: {serialized}"
        );
    }
}

#[test]
fn patchback_diagnostic_codes_stay_visible_while_secret_material_redacts() {
    // KAIFUU: exempt typed patchback diagnostic codes/categories/reasons
    // from the free-text secret-redactor so an agent can triage patch
    // failures at scale, WITHOUT weakening raw-key redaction. This is the
    // v0.2 PatchResult `failures` shape emitted by `build_failure_v02` /
    // `map_patchback_error_to_v02_failure` and redacted through
    // `redact_report_value` on the CLI emit path.
    let raw_key = "sk-Ab3xQ9pLmN7rT2vW8yZ4dK6hJ1cF5gB0nP-eR_uS";
    let value = serde_json::json!({
        "schemaVersion": "0.2.0",
        "status": "failed",
        "failureCategories": ["patch_write_failed", "source_incompatible"],
        "failures": [
            {
                // A UUID failure id — must survive verbatim (not a secret).
                "failureId": "019ed011-0000-7000-8000-000000000031",
                "category": "patch_write_failed",
                // The typed diagnostic code false-tripped the raw-key
                // heuristic in prose form before this fix; it MUST be visible.
                "diagnosticCode": "kaifuu.reallive.patchback_target_encode_failure",
                // Free-text cause: the typed code prefix + the human reason
                // (a UUID unit id, a scene id, an offset) stay visible while
                // an embedded raw-key-shaped token is scrubbed in place.
                "cause": format!(
                    "kaifuu.reallive.patchback_target_encode_failure: unit 019ed011-0000-7000-8000-000000000020 target text could not be encoded as Shift-JIS at scene 0031 offset 0x1a2b; leaked key {raw_key}"
                ),
                "bridgeUnitId": "019ed011-0000-7000-8000-000000000020",
                "adapterId": "kaifuu-reallive",
                "command": "patch.write_string_slot",
            },
            {
                "failureId": "019ed011-0000-7000-8000-000000000032",
                "category": "source_incompatible",
                "diagnosticCode": "kaifuu.reallive.patchback_provenance_mismatch",
                "cause": "kaifuu.reallive.patchback_provenance_mismatch: unit u1 byte range 0x1a2b..0x1a3c does not resolve to a scene textout body: offset drift",
                "bridgeUnitId": "019ed011-0000-7000-8000-000000000021",
                "adapterId": "kaifuu-reallive",
                "command": "patch.write_string_slot",
            }
        ],
    });

    let redacted = redact_report_value(&value);

    assert_eq!(
        redacted["failures"][0]["diagnosticCode"],
        "kaifuu.reallive.patchback_target_encode_failure",
        "typed diagnostic code must be visible for triage, not [REDACTED]"
    );
    assert_eq!(
        redacted["failures"][0]["category"], "patch_write_failed",
        "typed failure category must be visible"
    );
    assert_eq!(
        redacted["failures"][1]["diagnosticCode"],
        "kaifuu.reallive.patchback_provenance_mismatch"
    );
    assert_eq!(
        redacted["failures"][0]["failureId"], "019ed011-0000-7000-8000-000000000031",
        "UUID failure id must survive verbatim"
    );
    assert_eq!(
        redacted["failureCategories"][0], "patch_write_failed",
        "failure category vocabulary must survive verbatim"
    );
    // The human-readable reason stays legible: the code, the unit id, the
    // scene id and the offset all remain in the cause string.
    let cause0 = redacted["failures"][0]["cause"].as_str().unwrap();
    for legible in [
        "kaifuu.reallive.patchback_target_encode_failure",
        "could not be encoded as Shift-JIS",
        "scene 0031",
        "offset 0x1a2b",
        "019ed011-0000-7000-8000-000000000020",
    ] {
        assert!(
            cause0.contains(legible),
            "diagnostic reason lost triage detail {legible}: {cause0}"
        );
    }
    // The second, entirely-non-secret cause survives unchanged.
    assert_eq!(
        redacted["failures"][1]["cause"],
        "kaifuu.reallive.patchback_provenance_mismatch: unit u1 byte range 0x1a2b..0x1a3c does not resolve to a scene textout body: offset drift"
    );

    assert!(
        cause0.contains(SEMANTIC_SECRET_REDACTED),
        "the embedded raw-key token must be scrubbed: {cause0}"
    );
    let serialized = serde_json::to_string(&redacted).unwrap();
    assert!(
        !serialized.contains(raw_key),
        "raw key material leaked through the diagnostic exemption: {serialized}"
    );
}
