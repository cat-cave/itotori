#[test]
fn public_helper_result_fixtures_validate_and_cover_diagnostic_matrix() {
    let fixture_codes = [
        ("success", HelperDiagnosticCode::Success),
        ("missing-key", HelperDiagnosticCode::MissingKey),
        ("xp3/wrong-key", HelperDiagnosticCode::WrongKey),
        ("helper-required", HelperDiagnosticCode::HelperRequired),
        (
            "helper-unavailable",
            HelperDiagnosticCode::HelperUnavailable,
        ),
        ("validation-failed", HelperDiagnosticCode::ValidationFailed),
        (
            "unsupported-protected-executable",
            HelperDiagnosticCode::UnsupportedProtectedExecutable,
        ),
        ("redaction-failure", HelperDiagnosticCode::RedactionFailure),
        (
            "key-helper/windows-helper-timeout",
            HelperDiagnosticCode::HelperTimeout,
        ),
        (
            "key-helper/authorization-denied",
            HelperDiagnosticCode::HelperAuthorizationDenied,
        ),
    ];
    let mut covered = BTreeSet::new();

    for (fixture, expected_code) in fixture_codes {
        let value = public_helper_result_fixture_value(fixture);
        let validation = validate_helper_result_value(&value);

        assert_eq!(
            validation.status,
            OperationStatus::Passed,
            "{fixture} should validate: {:#?}",
            validation.failures
        );
        let helper_result: HelperResult = serde_json::from_value(value).unwrap();
        assert_eq!(helper_result.diagnostic.code, expected_code);
        covered.insert(helper_result.diagnostic.code);
        let serialized = helper_result.stable_json().unwrap();
        let serialized_value: Value = serde_json::from_str(&serialized).unwrap();
        assert!(serialized_value["secretRefs"].is_array());
        assert!(serialized_value["proofHashes"].is_array());
        assert_eq!(
            validate_helper_result_value(&serialized_value).status,
            OperationStatus::Passed
        );
        assert!(!serialized.contains("rawKey"));
        assert!(!serialized.contains("00112233445566778899aabbccddeeff"));
    }

    assert_eq!(
        covered,
        [
            HelperDiagnosticCode::Success,
            HelperDiagnosticCode::MissingKey,
            HelperDiagnosticCode::WrongKey,
            HelperDiagnosticCode::HelperRequired,
            HelperDiagnosticCode::HelperUnavailable,
            HelperDiagnosticCode::HelperAuthorizationDenied,
            HelperDiagnosticCode::HelperTimeout,
            HelperDiagnosticCode::ValidationFailed,
            HelperDiagnosticCode::UnsupportedProtectedExecutable,
            HelperDiagnosticCode::RedactionFailure,
        ]
        .into_iter()
        .collect::<BTreeSet<_>>()
    );
}

#[test]
fn xp3_helper_result_fixtures_distinguish_required_key_and_protected_states() {
    let fixture_codes = [
        ("xp3/helper-required", HelperDiagnosticCode::HelperRequired),
        ("xp3/missing-key", HelperDiagnosticCode::MissingKey),
        ("xp3/wrong-key", HelperDiagnosticCode::WrongKey),
        (
            "xp3/validation-failed",
            HelperDiagnosticCode::ValidationFailed,
        ),
        (
            "xp3/unsupported-protected-executable",
            HelperDiagnosticCode::UnsupportedProtectedExecutable,
        ),
    ];
    let mut covered = BTreeSet::new();

    for (fixture, expected_code) in fixture_codes {
        let value = public_helper_result_fixture_value(fixture);
        let validation = validate_helper_result_value(&value);
        assert_eq!(
            validation.status,
            OperationStatus::Passed,
            "{fixture} should validate: {:#?}",
            validation.failures
        );

        let helper_result: HelperResult = serde_json::from_value(value).unwrap();
        assert_eq!(helper_result.diagnostic.code, expected_code, "{fixture}");
        assert!(
            helper_result.profile_id.contains("095")
                || helper_result.fixture_id.contains("protected-executable"),
            "{fixture} should be tied to XP3 fixture profile ids"
        );
        assert!(
            !helper_result.proof_hashes.is_empty(),
            "{fixture} must carry public proof hash evidence"
        );
        if expected_code == HelperDiagnosticCode::MissingKey {
            assert!(
                helper_result
                    .secret_refs
                    .iter()
                    .any(|secret| { secret.requirement_id == "kirikiri-xp3-key-profile" }),
                "missing_key must identify the concrete XP3 key requirement id"
            );
        }
        covered.insert(helper_result.diagnostic.code);

        let serialized = helper_result.stable_json().unwrap();
        for forbidden in [
            "rawKey",
            "keyMaterial",
            "00112233445566778899aabbccddeeff",
            "/home/",
            "C:\\",
        ] {
            assert!(
                !serialized.contains(forbidden),
                "{fixture} leaked {forbidden}"
            );
        }
    }

    assert_eq!(
        covered,
        [
            HelperDiagnosticCode::HelperRequired,
            HelperDiagnosticCode::MissingKey,
            HelperDiagnosticCode::WrongKey,
            HelperDiagnosticCode::ValidationFailed,
            HelperDiagnosticCode::UnsupportedProtectedExecutable,
        ]
        .into_iter()
        .collect::<BTreeSet<_>>()
    );
}

#[test]
fn helper_result_contract_rejects_missing_key_without_concrete_requirement() {
    let mut value = public_helper_result_fixture_value("xp3/missing-key");
    value["secretRefs"] = serde_json::json!([]);

    let validation = validate_helper_result_value(&value).redacted_for_report();

    assert_eq!(validation.status, OperationStatus::Failed);
    assert!(
        validation.failures.iter().any(|failure| {
            failure.fixture_id.as_deref() == Some("kaifuu-xp3-missing-key")
                && failure.field == "secretRefs"
                && failure.code == "missing_key_requires_secret_ref"
        }),
        "{:#?}",
        validation.failures
    );
}

#[test]
fn public_encrypted_matrix_helper_results_cover_failure_paths() {
    let fixture_codes = [
        ("missing-key", HelperDiagnosticCode::MissingKey),
        ("helper-required", HelperDiagnosticCode::HelperRequired),
        (
            "helper-unavailable",
            HelperDiagnosticCode::HelperUnavailable,
        ),
        ("validation-failed", HelperDiagnosticCode::ValidationFailed),
        ("redaction-path", HelperDiagnosticCode::RedactionFailure),
    ];

    for (fixture, expected_code) in fixture_codes {
        let value = encrypted_matrix_fixture_value(&format!("helper-results/{fixture}.json"));
        let validation = validate_helper_result_value(&value);
        assert_eq!(
            validation.status,
            OperationStatus::Passed,
            "{fixture} should validate: {:#?}",
            validation.failures
        );

        let helper_result: HelperResult = serde_json::from_value(value).unwrap();
        assert_eq!(helper_result.diagnostic.code, expected_code);
        let serialized = helper_result.stable_json().unwrap();
        assert!(!serialized.contains("00112233445566778899aabbccddeeff"));
        assert!(!serialized.contains("/home/dev"));
        assert!(!serialized.contains("private/key.bin"));
    }
}

#[test]
fn public_encrypted_matrix_key_profile_fixtures_validate_and_redact_negatives() {
    let valid =
        encrypted_matrix_fixture_value("key-profiles/siglus-valid-placeholder.profile.json");
    let validation = validate_profile_value(&valid);
    assert_eq!(
        validation.status,
        OperationStatus::Passed,
        "valid placeholder profile should pass: {:#?}",
        validation.failures
    );

    for fixture in [
        "key-profiles/negative/raw-key-secret-ref.profile.json",
        "key-profiles/negative/private-path-secret-ref.profile.json",
    ] {
        let value = encrypted_matrix_fixture_value(fixture);
        let validation = validate_profile_value(&value).redacted_for_report();
        assert_eq!(
            validation.status,
            OperationStatus::Failed,
            "{fixture} should fail profile validation"
        );
        let serialized = serde_json::to_string(&validation).unwrap();
        assert!(serialized.contains("secretRef"));
        assert!(!serialized.contains("00112233445566778899aabbccddeeff"));
        assert!(!serialized.contains("/home/dev"));
        assert!(!serialized.contains("private/key.bin"));
    }
}

#[test]
fn public_encrypted_matrix_fixture_reports_detector_aggregate_output() {
    let raw_dir = repo_fixture_path("fixtures/public/kaifuu-encrypted-matrix/raw");
    let report = DetectionReport::from_results(
        &raw_dir,
        vec![DetectionResult {
            adapter_id: "kaifuu.fixture".to_string(),
            detected: false,
            engine_family: None,
            engine_version: None,
            detected_variant: None,
            evidence: vec![],
            requirements: vec![],
            capabilities: vec![],
        }],
    );
    let expected = encrypted_matrix_fixture_value("expected/detection-summary-v0.1.json");

    assert_eq!(report.status, DetectionReportStatus::Unknown);
    assert_eq!(report.game_dir, REDACTED_DETECTION_GAME_DIR);
    assert_eq!(
        report.archive_detection.status,
        ArchiveDetectionStatus::Matched
    );
    assert!(
        report
            .warnings
            .iter()
            .any(|warning| warning.contains("unsupported input diagnostics"))
    );

    for expected_row in expected["expectedRows"].as_array().unwrap() {
        let row_id = expected_row["rowId"].as_str().unwrap();
        let row = detected_archive_row(&report.archive_detection, row_id);
        assert_eq!(
            serde_json::to_value(&row.engine_family).unwrap(),
            expected_row["engineFamily"]
        );
        assert_eq!(row.detected, expected_row["detected"].as_bool().unwrap());
        assert_eq!(
            serde_json::to_value(&row.signals).unwrap(),
            expected_row["signals"],
            "{row_id} signals should match public fixture summary"
        );
    }

    let kirikiri = detected_archive_row(&report.archive_detection, "kirikiri-xp3");
    assert!(kirikiri.evidence.iter().any(|evidence| {
        evidence.pattern == "*.xp3"
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 4
    }));
    assert!(kirikiri.evidence.iter().any(|evidence| {
        evidence.pattern == "synthetic XP3 encryption marker"
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 1
    }));
    assert!(kirikiri.evidence.iter().any(|evidence| {
        evidence.pattern == "synthetic XP3 compression marker"
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 1
    }));
    assert!(kirikiri.evidence.iter().any(|evidence| {
        evidence.pattern == "synthetic XP3 unknown-variant marker"
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 1
    }));

    let rpg_maker = detected_archive_row(
        &report.archive_detection,
        "rpg-maker-mv-mz-encrypted-assets",
    );
    assert!(rpg_maker.evidence.iter().any(|evidence| {
        evidence.pattern == RPG_MAKER_MV_MZ_ENCRYPTED_SUFFIX_PATTERN
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 1
    }));
    assert!(rpg_maker.evidence.iter().any(|evidence| {
        evidence.pattern == "data/System.json encryption fields"
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 1
    }));

    let unknown = detected_archive_row(&report.archive_detection, "unknown-archive-variant");
    assert!(unknown.evidence.iter().any(|evidence| {
        evidence.pattern == "*.pak|*.bundle|*.bin|unprofiled *.dat|*.pck|*.arc"
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 3
    }));

    let serialized = serde_json::to_string(&report).unwrap();
    for forbidden in [
        raw_dir.display().to_string(),
        "data.xp3".to_string(),
        "fixture-only-rpg-maker-asset-key-v1".to_string(),
    ] {
        assert!(
            !serialized.contains(&forbidden),
            "report leaked {forbidden}"
        );
    }
    assert!(serialized.contains("aggregate-only"));
}

#[test]
fn public_encrypted_matrix_detector_negative_markers_stay_unknown_only() {
    let marker_dir = repo_fixture_path(
        "fixtures/public/kaifuu-encrypted-matrix/negative-detectors/orphaned-subtype-markers",
    );
    let report = ArchiveDetectionReport::scan(&marker_dir);

    assert_eq!(report.status, ArchiveDetectionStatus::Matched);
    for row_id in [
        "kirikiri-xp3",
        "bgi-ethornell-containers",
        "wolf-rpg-editor-archives",
    ] {
        let row = report
            .rows
            .iter()
            .find(|row| row.row_id == row_id)
            .unwrap_or_else(|| panic!("missing archive row {row_id}"));
        assert!(!row.detected, "{row_id} should not family-detect");
        assert_eq!(row.detected_variant, "unknown-variant");
        assert_eq!(
            row.signals,
            vec![ArchiveDetectionSignal::UnknownVariant],
            "{row_id} should retain only the unknown-variant signal"
        );
        assert!(row.requirements.is_empty(), "{row_id} leaked requirements");
        assert!(row.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == SemanticErrorCode::UnknownEngineVariant
                && diagnostic.signal == ArchiveDetectionSignal::UnknownVariant
                && diagnostic.required_capability == Some(Capability::Detection)
        }));
    }

    let unknown = detected_archive_row(&report, "unknown-archive-variant");
    assert_eq!(
        unknown.signals,
        vec![ArchiveDetectionSignal::UnknownVariant]
    );
    assert!(unknown.evidence.iter().any(|evidence| {
        evidence.pattern == "orphaned encrypted/protected subtype marker"
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 3
    }));
}

fn public_rpg_maker_fixture_key_validation_report(
    resolver: &LocalKeyResolver<InMemoryLocalSecretStore>,
    image_asset_path: &Path,
) -> RpgMakerMvMzFixtureKeyValidationReport {
    let game_dir = repo_fixture_path("fixtures/public/kaifuu-encrypted-matrix/raw/rpg-maker");
    validate_rpg_maker_mv_mz_fixture_key(RpgMakerMvMzFixtureKeyValidationRequest {
        fixture_id: "kaifuu-rpg-maker-mv-mz-key-validation-success",
        game_dir: &game_dir,
        image_asset_path,
        requirement_id: "rpg-maker-mv-mz-asset-key",
        secret_ref: "local-secret:fixture/rpg-maker/asset-key",
        resolver,
    })
}

#[test]
fn rpg_maker_mv_mz_fixture_key_validation_matches_system_json_and_image_evidence() {
    let resolver = LocalKeyResolver::new(InMemoryLocalSecretStore::fixture_ci())
        .with_policy(KeyResolverPolicy::allow_prefixes(["fixture/"]));
    let image_asset_path = repo_fixture_path(
        "fixtures/public/kaifuu-encrypted-matrix/raw/rpg-maker/img/pictures/title.rpgmvp",
    );

    let report = public_rpg_maker_fixture_key_validation_report(&resolver, &image_asset_path);

    assert_eq!(report.status, OperationStatus::Passed);
    assert!(!report.decrypt_or_patch_claimed);
    assert_eq!(report.records.len(), 1);
    let record = &report.records[0];
    assert_eq!(record.requirement_id, "rpg-maker-mv-mz-asset-key");
    assert_eq!(record.secret_ref_scheme, Some(SecretRefScheme::LocalSecret));
    assert_eq!(record.surface, "image_asset");
    assert_eq!(record.codec, CodecTransform::PngImage);
    assert_eq!(
        record.diagnostic_result,
        RpgMakerMvMzFixtureKeyValidationDiagnosticCode::Success
    );
    assert!(record.proof_hash.is_some());
    assert!(record.system_json_proof_hash.is_some());
    assert!(record.image_evidence_hash.is_some());
    assert_eq!(
        report.diagnostics[0].code,
        RpgMakerMvMzFixtureKeyValidationDiagnosticCode::Success
    );
    let expected: Value = read_json(&repo_fixture_path(
            "fixtures/public/kaifuu-encrypted-matrix/expected/rpg-maker-mv-mz-key-validation-success-v0.1.json",
        ))
        .unwrap();
    assert_eq!(
        serde_json::to_value(report.redacted_for_report()).unwrap(),
        expected
    );

    let serialized = report.stable_json().unwrap();
    for forbidden in [
        "fixture-only-rpg-maker-asset-key-v1",
        "00112233445566778899aabbccddeeff",
        "fixture/rpg-maker/asset-key",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "validation report leaked {forbidden}: {serialized}"
        );
    }
    assert!(
        !serialized.contains(&image_asset_path.display().to_string()),
        "validation report leaked fixture path: {serialized}"
    );
    assert!(serialized.contains("rpg-maker-mv-mz-asset-key"));
    assert!(serialized.contains("image_asset"));
    assert!(serialized.contains("png_image"));
}
