#[test]
fn rpg_maker_mv_mz_fixture_key_validation_fails_closed_without_image_evidence() {
    let resolver = LocalKeyResolver::new(InMemoryLocalSecretStore::fixture_ci())
        .with_policy(KeyResolverPolicy::allow_prefixes(["fixture/"]));
    let game_dir = repo_fixture_path("fixtures/public/kaifuu-encrypted-matrix/raw/rpg-maker");
    let missing_image_asset = game_dir.join("img/pictures/missing.rpgmvp");

    let report = validate_rpg_maker_mv_mz_fixture_key(RpgMakerMvMzFixtureKeyValidationRequest {
        fixture_id: "kaifuu-rpg-maker-missing-image-evidence",
        game_dir: &game_dir,
        image_asset_path: &missing_image_asset,
        requirement_id: "rpg-maker-mv-mz-asset-key",
        secret_ref: "local-secret:fixture/rpg-maker/asset-key",
        resolver: &resolver,
    });

    assert_eq!(report.status, OperationStatus::Failed);
    let record = &report.records[0];
    assert_eq!(record.surface, "image_asset");
    assert_eq!(record.codec, CodecTransform::PngImage);
    assert_eq!(
        record.diagnostic_result,
        RpgMakerMvMzFixtureKeyValidationDiagnosticCode::MissingImageEvidence
    );
    assert!(record.proof_hash.is_none());
    assert!(record.system_json_proof_hash.is_some());
    assert!(record.image_evidence_hash.is_none());
    assert_eq!(
        report.diagnostics[0].code,
        RpgMakerMvMzFixtureKeyValidationDiagnosticCode::MissingImageEvidence
    );
    assert_eq!(
        report.diagnostics[0].semantic_code,
        SemanticErrorCode::KeyValidationFailed
    );
    assert_eq!(report.diagnostics[0].field, "imageAssetPath");
    assert_eq!(
        report.diagnostics[0].message,
        "encrypted image evidence is missing or unreadable"
    );

    let serialized = report.stable_json().unwrap();
    for forbidden in [
        "fixture-only-rpg-maker-asset-key-v1",
        "00112233445566778899aabbccddeeff",
        "fixture/rpg-maker/asset-key",
        &missing_image_asset.display().to_string(),
    ] {
        assert!(
            !serialized.contains(forbidden),
            "validation report leaked {forbidden}: {serialized}"
        );
    }
    assert!(serialized.contains("missing_image_evidence"));
    assert!(!serialized.contains("image evidence matched"));
}

#[test]
fn rpg_maker_mv_mz_fixture_key_validation_reports_distinct_failure_diagnostics() {
    let image_asset_path = repo_fixture_path(
        "fixtures/public/kaifuu-encrypted-matrix/raw/rpg-maker/img/pictures/title.rpgmvp",
    );

    let missing_key_resolver = LocalKeyResolver::new(InMemoryLocalSecretStore::new());
    let missing_key =
        public_rpg_maker_fixture_key_validation_report(&missing_key_resolver, &image_asset_path);
    assert_eq!(missing_key.status, OperationStatus::Failed);
    assert_eq!(
        missing_key.records[0].diagnostic_result,
        RpgMakerMvMzFixtureKeyValidationDiagnosticCode::MissingKey
    );

    let bad_key_resolver = LocalKeyResolver::new(InMemoryLocalSecretStore::new().with_secret(
        "fixture/rpg-maker/asset-key",
        b"ffffffffffffffffffffffffffffffff".to_vec(),
    ));
    let bad_key =
        public_rpg_maker_fixture_key_validation_report(&bad_key_resolver, &image_asset_path);
    assert_eq!(bad_key.status, OperationStatus::Failed);
    assert_eq!(
        bad_key.records[0].diagnostic_result,
        RpgMakerMvMzFixtureKeyValidationDiagnosticCode::BadKey
    );

    let resolver = LocalKeyResolver::new(InMemoryLocalSecretStore::fixture_ci());
    let missing_system_root = temp_dir("rpg-maker-missing-system-json");
    write_fixture_file(
        &missing_system_root,
        "img/pictures/title.rpgmvp",
        b"RPGMVP fixture-only encrypted image payload\n",
    );
    let missing_system =
        validate_rpg_maker_mv_mz_fixture_key(RpgMakerMvMzFixtureKeyValidationRequest {
            fixture_id: "kaifuu-rpg-maker-missing-system-json",
            game_dir: &missing_system_root,
            image_asset_path: &missing_system_root.join("img/pictures/title.rpgmvp"),
            requirement_id: "rpg-maker-mv-mz-asset-key",
            secret_ref: "local-secret:fixture/rpg-maker/asset-key",
            resolver: &resolver,
        });
    assert_eq!(
        missing_system.records[0].diagnostic_result,
        RpgMakerMvMzFixtureKeyValidationDiagnosticCode::MissingSystemJson
    );

    let unsupported_root = temp_dir("rpg-maker-unsupported-surface");
    write_fixture_file(
        &unsupported_root,
        "www/data/System.json",
        br#"{"hasEncryptedImages":true,"encryptionKey":"fixture-only-rpg-maker-asset-key-v1"}"#,
    );
    write_fixture_file(
        &unsupported_root,
        "audio/bgm/theme.rpgmvm",
        b"synthetic unsupported audio surface",
    );
    let unsupported_surface =
        validate_rpg_maker_mv_mz_fixture_key(RpgMakerMvMzFixtureKeyValidationRequest {
            fixture_id: "kaifuu-rpg-maker-unsupported-surface",
            game_dir: &unsupported_root,
            image_asset_path: &unsupported_root.join("audio/bgm/theme.rpgmvm"),
            requirement_id: "rpg-maker-mv-mz-asset-key",
            secret_ref: "local-secret:fixture/rpg-maker/asset-key",
            resolver: &resolver,
        });
    assert_eq!(
        unsupported_surface.records[0].diagnostic_result,
        RpgMakerMvMzFixtureKeyValidationDiagnosticCode::UnsupportedSurface
    );
    assert_eq!(unsupported_surface.records[0].surface, "audio_asset");
    assert_eq!(
        unsupported_surface.records[0].codec,
        CodecTransform::M4aAudio
    );
    let _ = fs::remove_dir_all(missing_system_root);
    let _ = fs::remove_dir_all(unsupported_root);

    let diagnostics = serde_json::to_string(&[
        missing_key.redacted_for_report(),
        bad_key.redacted_for_report(),
        missing_system.redacted_for_report(),
        unsupported_surface.redacted_for_report(),
    ])
    .unwrap();
    assert!(!diagnostics.contains("00112233445566778899aabbccddeeff"));
    assert!(!diagnostics.contains("fixture/rpg-maker/asset-key"));
    assert!(!diagnostics.contains("fixture-only-rpg-maker-asset-key-v1"));
}

#[test]
fn known_key_import_boundary_fixture_is_hash_only_public_output() {
    let value = public_helper_result_fixture_value("known-key-import-boundary");
    let validation = validate_helper_result_value(&value);

    assert_eq!(
        validation.status,
        OperationStatus::Passed,
        "{:#?}",
        validation.failures
    );
    assert_eq!(value["helper"]["helperKind"], "knownKeyDatabaseImport");
    assert_eq!(
        value["secretRefs"][0]["secretRef"],
        "local-secret:fixture/siglus/manual-secondary-key"
    );
    assert!(
        value["secretRefs"][0]["validation"]["proofHash"]
            .as_str()
            .unwrap()
            .starts_with("sha256:")
    );
    assert!(
        value["proofHashes"][0]["proofHash"]
            .as_str()
            .unwrap()
            .starts_with("sha256:")
    );
    assert!(value.get("sourceHash").is_none());
    assert!(value.get("materialHash").is_none());
    let serialized = serde_json::to_string(&value).unwrap();
    for forbidden in [
        "rawKey",
        "keyMaterial",
        "00112233445566778899aabbccddeeff",
        "decrypted script",
        "/home/dev",
    ] {
        assert!(!serialized.contains(forbidden));
    }
}

#[test]
fn key_helper_fixture_matrix_normalizes_all_helper_methods() {
    let cases = [
        (
            "key-helper/static-parser",
            HelperKind::StaticParser,
            HelperCapabilityLevel::StaticAnalysis,
            HelperResultExecutionMode::InProcess,
        ),
        (
            "key-helper/known-key-import",
            HelperKind::KnownKeyDatabaseImport,
            HelperCapabilityLevel::LocalKeyImport,
            HelperResultExecutionMode::NotExecuted,
        ),
        (
            "key-helper/manual-entry",
            HelperKind::ManualKeyEntry,
            HelperCapabilityLevel::ManualEntry,
            HelperResultExecutionMode::NotExecuted,
        ),
        (
            "key-helper/wine-helper-unavailable",
            HelperKind::WineLocalWindowsHelper,
            HelperCapabilityLevel::WineLocal,
            HelperResultExecutionMode::PlatformHelper,
        ),
        (
            "key-helper/windows-helper-timeout",
            HelperKind::WineLocalWindowsHelper,
            HelperCapabilityLevel::WindowsLocal,
            HelperResultExecutionMode::PlatformHelper,
        ),
    ];

    for (fixture, expected_kind, expected_level, expected_mode) in cases {
        let value = public_helper_result_fixture_value(fixture);
        let helper_result = normalize_helper_result_value(&value)
            .unwrap_or_else(|validation| panic!("{fixture} failed: {validation:#?}"));
        let serialized = helper_result.stable_json().unwrap();
        let serialized_value: Value = serde_json::from_str(&serialized).unwrap();

        assert_eq!(helper_result.helper.helper_kind, expected_kind);
        assert_eq!(helper_result.capability_level, expected_level);
        assert_eq!(helper_result.execution.mode, expected_mode);
        assert!(helper_result.execution.bounded);
        assert!(helper_result.execution.timeout_ms > 0);
        assert_eq!(
            validate_helper_result_value(&serialized_value).status,
            OperationStatus::Passed
        );
        for forbidden in [
            "rawKey",
            "helperDump",
            "command",
            "00112233445566778899aabbccddeeff",
            "/home/dev",
        ] {
            assert!(
                !serialized.contains(forbidden),
                "{fixture} normalized output leaked {forbidden}: {serialized}"
            );
        }
    }
}

#[test]
fn key_helper_contract_rejects_arbitrary_execution_command_metadata() {
    let value = invalid_public_helper_result_fixture_value("execution-command-field");
    let validation = validate_helper_result_value(&value).redacted_for_report();

    assert_eq!(validation.status, OperationStatus::Failed);
    assert!(
        validation.failures.iter().any(|failure| {
            failure.fixture_id.as_deref() == Some("kaifuu-key-helper-invalid-command-field")
                && failure.field == "execution.command"
                && failure.code == "forbidden_helper_execution_field"
        }),
        "{:#?}",
        validation.failures
    );
    let serialized = serde_json::to_string(&validation).unwrap();
    assert!(!serialized.contains("fixture-helper --dump"));
}

#[test]
fn helper_result_contract_rejects_unknown_top_level_fields_before_deserialization() {
    let mut value = public_helper_result_fixture_value("key-helper/static-parser");
    value
        .as_object_mut()
        .unwrap()
        .insert("unexpectedAuditField".to_string(), serde_json::json!(true));

    let validation = validate_helper_result_value(&value).redacted_for_report();

    assert_eq!(validation.status, OperationStatus::Failed);
    assert!(
        validation.failures.iter().any(|failure| {
            failure.fixture_id.as_deref() == Some("kaifuu-key-helper-static-parser")
                && failure.field == "unexpectedAuditField"
                && failure.code == "unknown_helper_result_field"
        }),
        "{:#?}",
        validation.failures
    );
    assert!(serde_json::from_value::<HelperResult>(value).is_err());
}

#[test]
fn helper_result_contract_rejects_top_level_command_metadata() {
    let mut value = public_helper_result_fixture_value("key-helper/static-parser");
    value.as_object_mut().unwrap().insert(
        "command".to_string(),
        serde_json::json!("fixture-helper --dump-private-state"),
    );

    let validation = validate_helper_result_value(&value).redacted_for_report();

    assert_eq!(validation.status, OperationStatus::Failed);
    assert!(
        validation.failures.iter().any(|failure| {
            failure.fixture_id.as_deref() == Some("kaifuu-key-helper-static-parser")
                && failure.field == "command"
                && failure.code == "forbidden_helper_metadata_field"
        }),
        "{:#?}",
        validation.failures
    );
    let serialized = serde_json::to_string(&validation).unwrap();
    assert!(!serialized.contains("dump-private-state"));
    assert!(serde_json::from_value::<HelperResult>(value).is_err());
}

#[test]
fn helper_result_contract_rejects_unknown_nested_fields_outside_execution() {
    let mut value = public_helper_result_fixture_value("key-helper/static-parser");
    value["diagnostic"]["unexpected"] = serde_json::json!("extra diagnostic metadata");
    value["secretRefs"][0]["validation"]["extraProofMetadata"] = serde_json::json!(true);

    let validation = validate_helper_result_value(&value).redacted_for_report();

    assert_eq!(validation.status, OperationStatus::Failed);
    for field in [
        "diagnostic.unexpected",
        "secretRefs.0.validation.extraProofMetadata",
    ] {
        assert!(
            validation.failures.iter().any(|failure| {
                failure.fixture_id.as_deref() == Some("kaifuu-key-helper-static-parser")
                    && failure.field == field
                    && failure.code == "unknown_helper_result_field"
            }),
            "missing unknown-field failure for {field}: {:#?}",
            validation.failures
        );
    }
    assert!(serde_json::from_value::<HelperResult>(value).is_err());
}

#[test]
fn key_helper_contract_rejects_static_parser_remote_overclaim() {
    let mut value = public_helper_result_fixture_value("key-helper/static-parser");
    value["capabilityLevel"] = serde_json::json!("remoteWindows");
    value["execution"]["mode"] = serde_json::json!("remoteHelper");

    let validation = validate_helper_result_value(&value).redacted_for_report();

    assert_eq!(validation.status, OperationStatus::Failed);
    assert!(
        validation.failures.iter().any(|failure| {
            failure.fixture_id.as_deref() == Some("kaifuu-key-helper-static-parser")
                && failure.field == "helper"
                && failure.code == "invalid_helper_semantics"
        }),
        "{:#?}",
        validation.failures
    );
}

#[test]
fn helper_result_contract_rejects_success_without_secret_ref_and_proof_hash() {
    let mut value = public_helper_result_fixture_value("success");
    value["secretRefs"] = serde_json::json!([]);
    value["proofHashes"] = serde_json::json!([]);

    let validation = validate_helper_result_value(&value).redacted_for_report();

    assert_eq!(validation.status, OperationStatus::Failed);
    for (field, code) in [
        ("secretRefs", "missing_success_secret_ref"),
        ("proofHashes", "missing_success_proof_hash"),
    ] {
        assert!(
            validation.failures.iter().any(|failure| {
                failure.fixture_id.as_deref() == Some("kaifuu-helper-success")
                    && failure.field == field
                    && failure.code == code
            }),
            "missing success-evidence failure for {field}: {:#?}",
            validation.failures
        );
    }
}

#[test]
fn helper_result_stable_json_keeps_empty_arrays_in_public_contract() {
    let value = public_helper_result_fixture_value("unsupported-protected-executable");
    let helper_result: HelperResult = serde_json::from_value(value).unwrap();
    assert!(helper_result.secret_refs.is_empty());
    assert!(helper_result.proof_hashes.is_empty());

    let serialized = helper_result.stable_json().unwrap();
    let serialized_value: Value = serde_json::from_str(&serialized).unwrap();

    assert_eq!(serialized_value["secretRefs"], serde_json::json!([]));
    assert_eq!(serialized_value["proofHashes"], serde_json::json!([]));
    assert_eq!(
        validate_helper_result_value(&serialized_value).status,
        OperationStatus::Passed
    );
}

// the hash rule is named `utf8-lf-json-stable-v1`. It USED to
// claim `nfc`, but no write path NFC-normalizes string contents — and it
// must not: the bridge (`sourceText`, `spans.raw`) is emitted through
// `stable_json` and must stay BYTE-EXACT for the "span byte range must
// would compose e.g. a decomposed Japanese voiced kana (か + U+3099 → が)
// and corrupt that round-trip. These fixtures + test pin the honest
// behavior: composed and decomposed metadata serialize DISTINCTLY (no
// silent normalization), and raw/asset bytes are hashed untouched.
fn nfc_alignment_fixture(name: &str) -> String {
    let path = repo_fixture_path(&format!("fixtures/kaifuu-core/nfc-alignment/{name}"));
    fs::read_to_string(path).unwrap()
}

#[test]
fn stable_json_metadata_rule_does_not_nfc_normalize_string_contents() {
    // Composed: "café" = U+00E9; "がぎぐ" = U+304C U+304E U+3050.
    // Decomposed: "cafe" + U+0301; "か"+U+3099... = the SAME logical text.
    let composed: Value = serde_json::from_str(&nfc_alignment_fixture("composed-metadata.json"))
        .expect("composed fixture is valid JSON");
    let decomposed: Value =
        serde_json::from_str(&nfc_alignment_fixture("decomposed-metadata.json"))
            .expect("decomposed fixture is valid JSON");

    // The fixtures encode exactly the code points we claim: byte-distinct
    // representations of the same logical strings.
    assert_eq!(composed["displayName"].as_str().unwrap(), "caf\u{00e9}");
    assert_eq!(decomposed["displayName"].as_str().unwrap(), "cafe\u{0301}");
    assert_eq!(
        composed["speakerNote"].as_str().unwrap(),
        "\u{304c}\u{304e}\u{3050}"
    );
    assert_eq!(
        decomposed["speakerNote"].as_str().unwrap(),
        "\u{304b}\u{3099}\u{304d}\u{3099}\u{304f}\u{3099}"
    );
    // Logically equal, byte-distinct (this is exactly what an NFC rule would
    // otherwise collapse — and what we must NOT collapse).
    assert_ne!(
        composed["displayName"], decomposed["displayName"],
        "fixtures must differ at the code-point level"
    );

    let composed_json = stable_json(&composed).unwrap();
    let decomposed_json = stable_json(&decomposed).unwrap();

    // Honest `utf8-lf-json-stable-v1`: NO NFC. The decomposed input keeps
    // its combining marks; the two serializations stay distinct. If the
    // writer NFC-normalized (as the old `...nfc...` name claimed), these
    // would be byte-identical.
    assert_ne!(
        composed_json, decomposed_json,
        "stable_json must NOT NFC-normalize (decomposed != composed)"
    );
    assert!(
        decomposed_json.contains("cafe\u{0301}"),
        "decomposed combining acute must survive stable_json byte-exact"
    );
    assert!(
        decomposed_json.contains("\u{304b}\u{3099}"),
        "decomposed combining dakuten must survive stable_json byte-exact"
    );
    assert!(
        !decomposed_json.contains("caf\u{00e9}"),
        "stable_json must not silently compose the decomposed form"
    );

    // Round-trip: the emitted bytes reparse to the SAME (still decomposed)
    // value — proving byte-exact preservation the patchback path relies on.
    let reparsed: Value = serde_json::from_str(&decomposed_json).unwrap();
    assert_eq!(reparsed, decomposed);
}
