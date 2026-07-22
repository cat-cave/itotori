#[test]
fn diagnostic_free_text_scrub_masks_secret_tokens_but_keeps_reason() {
    // Directly exercise the token scrubber: a free-text reason keeps every
    // safe token while masking each secret-shaped token in place, so the
    // raw-key heuristic is not weakened.
    let raw_hex = "00112233445566778899aabbccddeeff00112233";
    let text = format!(
        "scene 0031 header parse failed at offset 0x40; leaked key {raw_hex} and path /home/dev/private.bin"
    );
    let scrubbed = super::redact_secret_tokens_in_text(&text);
    for legible in [
        "scene", "0031", "header", "parse", "failed", "offset", "0x40",
    ] {
        assert!(
            scrubbed.contains(legible),
            "scrub dropped safe token {legible}: {scrubbed}"
        );
    }
    assert!(
        !scrubbed.contains(raw_hex),
        "raw hex key not scrubbed: {scrubbed}"
    );
    assert!(
        !scrubbed.contains("/home/dev/private.bin"),
        "local path not scrubbed: {scrubbed}"
    );
    assert!(scrubbed.contains(SEMANTIC_SECRET_REDACTED));
}

#[test]
fn typed_diagnostic_field_exemption_is_value_shape_gated_not_name_gated() {
    // The exemption must not ride on the field NAME alone: a secret-shaped
    // value that lands in a diagnosticCode / failureId / category field must
    // STILL redact, while a genuine enum code / category / UUID in the same
    // field stays visible.
    let raw_key_hex = "00112233445566778899aabbccddeeff00112233";
    let raw_key_b64url = "Ab3xQ9pLmN7rT2vW8yZ4dK6hJ1cF5gB0nP-eR_uS0-9";
    let value = serde_json::json!({
        // Safe values — must survive verbatim.
        "diagnosticCode": "kaifuu.reallive.patchback_target_encode_failure",
        "category": "patch_write_failed",
        "failureId": "019ed011-0000-7000-8000-000000000031",
        // Hostile values wearing typed-identifier field NAMES — must redact.
        "failures": [
            { "diagnosticCode": raw_key_hex },
            { "category": raw_key_b64url },
            // A non-UUID secret-shaped value in a failureId field.
            { "failureId": raw_key_hex },
        ],
    });

    let redacted = redact_report_value(&value);
    let serialized = serde_json::to_string(&redacted).unwrap();

    // Common case: real codes/categories/UUIDs stay visible.
    assert_eq!(
        redacted["diagnosticCode"],
        "kaifuu.reallive.patchback_target_encode_failure"
    );
    assert_eq!(redacted["category"], "patch_write_failed");
    assert_eq!(
        redacted["failureId"],
        "019ed011-0000-7000-8000-000000000031"
    );

    // Secret-shaped values in code-named fields must NOT ride through.
    assert_eq!(
        redacted["failures"][0]["diagnosticCode"],
        format!("[REDACTED:{SEMANTIC_SECRET_REDACTED}]"),
        "raw-key-shaped value in a diagnosticCode field must redact"
    );
    assert_eq!(
        redacted["failures"][1]["category"],
        format!("[REDACTED:{SEMANTIC_SECRET_REDACTED}]"),
        "base64url-shaped value in a category field must redact"
    );
    assert_eq!(
        redacted["failures"][2]["failureId"],
        format!("[REDACTED:{SEMANTIC_SECRET_REDACTED}]"),
        "non-UUID secret-shaped value in a failureId field must redact"
    );
    for leaked in [raw_key_hex, raw_key_b64url] {
        assert!(
            !serialized.contains(leaked),
            "secret rode through a code-named field: {serialized}"
        );
    }
}

#[test]
fn patch_and_verify_report_redaction_covers_hostile_top_level_fields() {
    let raw_key = "00112233445566778899aabbccddeeff";
    let patch_result = PatchResult {
        schema_version: PROFILE_SCHEMA_VERSION.to_string(),
        patch_result_id: "patch-result=/home/dev/game/private-route-ending.ks".to_string(),
        patch_export_id: format!("patch-export helper dump raw key {raw_key}"),
        status: OperationStatus::Failed,
        output_hash: "C:\\Games\\SecretRoute\\private-route-ending.ks".to_string(),
        failures: vec![AdapterFailure::secret_redacted(
            "kaifuu.fixture",
            "fixture",
            "private-route",
            "private-route-ending.ks",
            format!("helper dump source:/home/dev/game/private-route-ending.ks raw key {raw_key}"),
        )],
    };
    let verify_result = VerificationResult {
        schema_version: PROFILE_SCHEMA_VERSION.to_string(),
        patch_result_id: "verify-result=/home/dev/game/private-route-ending.ks".to_string(),
        status: OperationStatus::Failed,
        output_hash: format!("helper dump outputHash {raw_key}"),
        failures: vec![AdapterFailure::helper_unavailable(
            "kaifuu.fixture",
            "fixture",
            "private-route",
            "helper unavailable for C:\\Games\\SecretRoute\\private-route-ending.ks",
        )],
    };

    let patch_serialized = serde_json::to_string(&patch_result.redacted_for_report()).unwrap();
    let verify_serialized = serde_json::to_string(&verify_result.redacted_for_report()).unwrap();

    for serialized in [&patch_serialized, &verify_serialized] {
        assert!(serialized.contains(SEMANTIC_SECRET_REDACTED));
        for forbidden in [
            "/home/dev/game",
            "C:\\Games",
            "SecretRoute",
            "helper dump",
            raw_key,
            "private-route-ending.ks",
        ] {
            assert!(
                !serialized.contains(forbidden),
                "report leaked {forbidden}: {serialized}"
            );
        }
    }
}

#[test]
fn profile_validation_accepts_layered_capability_variants() {
    let mut profile = valid_key_profile_value();
    let capabilities = profile["capabilities"].as_array_mut().unwrap();
    for capability in [
        "container_access",
        "crypto_access",
        "codec_access",
        "patch_back",
    ] {
        capabilities.push(serde_json::json!({
            "capability": capability,
            "status": "requires_user_input",
            "limitation": "requires local layered access support"
        }));
    }

    let validation = validate_profile_value(&profile);

    assert_eq!(validation.status, OperationStatus::Passed);
}

#[test]
fn golden_unchanged_patch_preflight_redaction_blocks_before_work_dir_prepare() {
    let game_dir = temp_dir("golden-unchanged-preflight-game");
    let work_dir = temp_dir("golden-unchanged-preflight-work");
    let sentinel = work_dir.join("unchanged-patch").join("sentinel.txt");
    fs::create_dir_all(sentinel.parent().unwrap()).unwrap();
    fs::write(&sentinel, "keep").unwrap();

    let preflight_calls = Arc::new(AtomicUsize::new(0));
    let patch_calls = Arc::new(AtomicUsize::new(0));
    let mut registry = AdapterRegistry::new();
    registry.register(GoldenPreflightBoundaryAdapter {
        block_on_preflight_call: 1,
        preflight_calls: Arc::clone(&preflight_calls),
        patch_calls: Arc::clone(&patch_calls),
    });

    let report = run_round_trip_golden(
        &registry,
        GoldenHarnessRequest {
            game_dir: &game_dir,
            work_dir: &work_dir,
            adapter_id: Some("kaifuu.golden-preflight-boundary"),
            byte_equivalence: GoldenByteEquivalenceMode::Unsupported {
                support_boundary: "byte identity is outside this preflight test".to_string(),
            },
            translated_patch_export: None,
            translated_source_bridge: None,
        },
    )
    .unwrap();

    assert_eq!(report.status, OperationStatus::Failed);
    assert_eq!(preflight_calls.load(Ordering::SeqCst), 1);
    assert_eq!(patch_calls.load(Ordering::SeqCst), 0);
    assert!(
        sentinel.exists(),
        "unchanged work dir should not be removed before preflight"
    );
    assert!(report.failures.iter().any(|failure| {
        failure.phase == "unchanged_patch" && failure.code == SEMANTIC_MISSING_CONTAINER_CAPABILITY
    }));
    let serialized = report.stable_json().unwrap();
    for forbidden in [
        "$HOME",
        "%USERPROFILE%",
        "~/",
        "Private Route Spoiler Game",
        "private-route-name",
        "Scene.pck",
        "helper dump",
        "00112233445566778899aabbccddeeff",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "golden report leaked {forbidden}: {serialized}"
        );
    }
}

#[test]
fn golden_translated_patch_preflight_blocks_before_work_dir_prepare() {
    let game_dir = temp_dir("golden-translated-preflight-game");
    let work_dir = temp_dir("golden-translated-preflight-work");
    let sentinel = work_dir.join("translated-patch").join("sentinel.txt");
    fs::create_dir_all(sentinel.parent().unwrap()).unwrap();
    fs::write(&sentinel, "keep").unwrap();

    let preflight_calls = Arc::new(AtomicUsize::new(0));
    let patch_calls = Arc::new(AtomicUsize::new(0));
    let mut registry = AdapterRegistry::new();
    registry.register(GoldenPreflightBoundaryAdapter {
        block_on_preflight_call: 2,
        preflight_calls: Arc::clone(&preflight_calls),
        patch_calls: Arc::clone(&patch_calls),
    });
    let translated_patch =
        serde_json::to_value(golden_boundary_patch_export("translated-patch-1")).unwrap();

    let report = run_round_trip_golden(
        &registry,
        GoldenHarnessRequest {
            game_dir: &game_dir,
            work_dir: &work_dir,
            adapter_id: Some("kaifuu.golden-preflight-boundary"),
            byte_equivalence: GoldenByteEquivalenceMode::Unsupported {
                support_boundary: "byte identity is outside this preflight test".to_string(),
            },
            translated_patch_export: Some(&translated_patch),
            translated_source_bridge: None,
        },
    )
    .unwrap();

    assert_eq!(report.status, OperationStatus::Failed);
    assert_eq!(preflight_calls.load(Ordering::SeqCst), 2);
    assert_eq!(patch_calls.load(Ordering::SeqCst), 1);
    assert!(
        sentinel.exists(),
        "translated work dir should not be removed before preflight"
    );
    assert!(report.failures.iter().any(|failure| {
        failure.phase == "translated_patch" && failure.code == SEMANTIC_MISSING_CONTAINER_CAPABILITY
    }));
}

#[test]
fn missing_secret_requirements_emit_key_profile_semantic_errors() {
    let mut profile = valid_key_profile_value();
    profile.as_object_mut().unwrap().remove("keyRequirements");
    profile["requirements"][0]["status"] = serde_json::json!("missing");
    profile["requirements"][0]["placeholder"] = serde_json::json!("KAIFUU_SIGLUS_KEY");

    let validation = validate_profile_value(&profile);

    assert_eq!(validation.status, OperationStatus::Failed);
    for expected_code in [SEMANTIC_MISSING_KEY_MATERIAL, SEMANTIC_MISSING_KEY_PROFILE] {
        assert!(
            validation
                .failures
                .iter()
                .any(|failure| failure.code == expected_code),
            "missing {expected_code}: {:#?}",
            validation.failures
        );
    }
}

#[test]
fn adapter_key_declarations_serialize_stable_semantic_errors() {
    let reports = vec![
        CapabilityReport::requires_user_input(
            Capability::KeyProfile,
            "requires local-only key profile secret refs",
        ),
        CapabilityReport::requires_user_input(
            Capability::EncryptedInput,
            "requires caller-provided resolved keys",
        ),
    ];
    // derive explicitly from reports so the registry gate
    // sees Identify Unsupported (no Detection report) rather than a
    // bubbled-up identify-only claim against missing Detection.
    let matrix = AdapterCapabilityMatrix::derive_from_reports("kaifuu.siglus", &reports);
    let capabilities = AdapterCapabilities::new("kaifuu.siglus", reports, matrix)
        .with_key_requirements(vec![AdapterKeyRequirementDeclaration {
            requirement_id: "siglus-secondary-key".to_string(),
            engine_family: "siglus".to_string(),
            material_kind: KeyMaterialKind::FixedBytes,
            bytes: Some(16),
            archive_parameters: vec![ArchiveParameterDeclaration {
                parameter_id: "scene-archive".to_string(),
                name: "sceneArchive".to_string(),
                kind: ArchiveParameterKind::ArchiveFormat,
                required: true,
            }],
            validation: AdapterKeyValidationDeclaration {
                method: KeyValidationMethod::DecryptHeaderProof,
                proof_required: true,
            },
            semantic_errors: vec![
                SemanticErrorCode::MissingKeyProfile,
                SemanticErrorCode::MissingKeyMaterial,
                SemanticErrorCode::HelperUnavailable,
                SemanticErrorCode::HelperRequired,
                SemanticErrorCode::KeyValidationFailed,
                SemanticErrorCode::SecretRedacted,
                SemanticErrorCode::ProtectedExecutableUnsupported,
                SemanticErrorCode::UnsupportedLayeredTransform,
                SemanticErrorCode::MissingContainerCapability,
                SemanticErrorCode::MissingCryptoCapability,
                SemanticErrorCode::MissingCodecCapability,
                SemanticErrorCode::MissingPatchBackCapability,
                SemanticErrorCode::UnsupportedVariantEncrypted,
            ],
        }]);

    let value = serde_json::to_value(capabilities).unwrap();

    assert_eq!(
        value["keyRequirements"][0]["semanticErrors"],
        serde_json::json!([
            "kaifuu.missing_capability.key_profile",
            "kaifuu.missing_key_material",
            "kaifuu.helper_unavailable",
            "kaifuu.helper_required",
            "kaifuu.key_validation_failed",
            "kaifuu.secret_redacted",
            "kaifuu.protected_executable_unsupported",
            "kaifuu.unsupported_layered_transform",
            "kaifuu.missing_capability.container",
            "kaifuu.missing_capability.crypto",
            "kaifuu.missing_capability.codec",
            "kaifuu.missing_capability.patch_back",
            "kaifuu.unsupported_variant.encrypted"
        ])
    );
}

#[test]
fn adapter_capabilities_redacts_key_requirement_declaration_strings() {
    let adapter_id = "kaifuu.path=/home/dev/game/private-route-ending.ks";
    let reports = vec![CapabilityReport::requires_user_input(
        Capability::KeyProfile,
        "helper dump source:/home/dev/game/private-route-ending.ks exposed raw key 00112233445566778899aabbccddeeff",
    )];
    // redaction-pipeline fixture — derive explicitly so
    // the matrix matches the (fully unsupported at Identify) reports.
    let matrix = AdapterCapabilityMatrix::derive_from_reports(adapter_id, &reports);
    let capabilities =
        AdapterCapabilities::new(adapter_id, reports, matrix).with_key_requirements(vec![
            AdapterKeyRequirementDeclaration {
                requirement_id:
                    "source:/home/dev/game/private-route-ending.ks:00112233445566778899aabbccddeeff"
                        .to_string(),
                engine_family: "helper dump C:\\Games\\SecretRoute\\engine.exe".to_string(),
                material_kind: KeyMaterialKind::FixedBytes,
                bytes: Some(16),
                archive_parameters: vec![ArchiveParameterDeclaration {
                    parameter_id: "file=C:\\Games\\SecretRoute\\Scene.pck".to_string(),
                    name: "private-route-ending.ks".to_string(),
                    kind: ArchiveParameterKind::ArchiveFormat,
                    required: true,
                }],
                validation: AdapterKeyValidationDeclaration {
                    method: KeyValidationMethod::DecryptHeaderProof,
                    proof_required: true,
                },
                semantic_errors: vec![SemanticErrorCode::SecretRedacted],
            },
        ]);

    let redacted = capabilities.redacted_for_report();
    let serialized = serde_json::to_string(&redacted).unwrap();

    assert!(serialized.contains(SEMANTIC_SECRET_REDACTED));
    assert_eq!(
        redacted.key_requirements[0].material_kind,
        KeyMaterialKind::FixedBytes
    );
    assert_eq!(redacted.key_requirements[0].bytes, Some(16));
    assert_eq!(
        redacted.key_requirements[0].validation.method,
        KeyValidationMethod::DecryptHeaderProof
    );
    assert_eq!(
        redacted.key_requirements[0].semantic_errors,
        vec![SemanticErrorCode::SecretRedacted]
    );
    for forbidden in [
        "/home/dev/game",
        "C:\\Games",
        "helper dump",
        "00112233445566778899aabbccddeeff",
        "private-route-ending.ks",
        "SecretRoute",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "capabilities leaked {forbidden}"
        );
    }
}

#[test]
fn adapter_failure_constructors_use_key_boundary_codes() {
    assert_eq!(
        AdapterFailure::missing_key_profile(
            "kaifuu.siglus",
            "siglus",
            "scene-pck-secondary-key",
            "pure adapters require a key profile before encrypted extraction"
        )
        .error_code,
        SEMANTIC_MISSING_KEY_PROFILE
    );
    assert_eq!(
        AdapterFailure::missing_key_material(
            "kaifuu.siglus",
            "siglus",
            "scene-pck-secondary-key",
            "siglus-secondary-key",
            "local secret storage did not resolve the referenced key"
        )
        .error_code,
        SEMANTIC_MISSING_KEY_MATERIAL
    );
    assert_eq!(
        AdapterFailure::helper_unavailable(
            "kaifuu.siglus",
            "siglus",
            "scene-pck-secondary-key",
            "helper execution is outside the pure adapter"
        )
        .error_code,
        SEMANTIC_HELPER_UNAVAILABLE
    );
    assert_eq!(
        AdapterFailure::key_validation_failed(
            "kaifuu.siglus",
            "siglus",
            "scene-pck-secondary-key",
            "siglus-secondary-key",
            "proof hash did not match local asset validation"
        )
        .error_code,
        SEMANTIC_KEY_VALIDATION_FAILED
    );
    assert_eq!(
        AdapterFailure::protected_executable_unsupported(
            "kaifuu.kirikiri",
            "kirikiri",
            "xp3-protected-executable",
            "protected executable helper cannot analyze this fixture"
        )
        .error_code,
        SEMANTIC_PROTECTED_EXECUTABLE_UNSUPPORTED
    );
    assert_eq!(
        AdapterFailure::secret_redacted(
            "kaifuu.siglus",
            "siglus",
            "scene-pck-secondary-key",
            "helper-evidence",
            "helper output included secret-bearing fields"
        )
        .error_code,
        SEMANTIC_SECRET_REDACTED
    );
}
