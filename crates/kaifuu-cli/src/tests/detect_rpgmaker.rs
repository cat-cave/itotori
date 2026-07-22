#[test]
fn detect_unknown_directory_is_non_fatal_and_evidence_based() {
    let root = temp_dir("unknown-detect");
    let game_dir = root.join("unknown-game");
    fs::create_dir_all(&game_dir).unwrap();
    let detect_path = root.join("detect.json");

    run_cli(&[
        "detect",
        game_dir.to_str().unwrap(),
        "--output",
        detect_path.to_str().unwrap(),
    ]);

    let detection_report: DetectionReport = read_json(&detect_path).unwrap();
    assert_eq!(detection_report.status, DetectionReportStatus::Unknown);
    assert_bgi_detection_absent_or_undetected(&detection_report);
    let softpal_detection = detection_report
        .detections
        .iter()
        .find(|detection| {
            detection.adapter_id == kaifuu_engine_fixture::SOFTPAL_DETECTOR_ADAPTER_ID
        })
        .unwrap();
    assert!(!softpal_detection.detected);
    let fixture_detection = detection_report
        .detections
        .iter()
        .find(|detection| detection.adapter_id == kaifuu_engine_fixture::FIXTURE_ADAPTER_ID)
        .unwrap();
    assert!(!fixture_detection.detected);
    assert!(fixture_detection.evidence.iter().any(|evidence| {
        evidence.path == "source.json" && evidence.status == EvidenceStatus::Missing
    }));
    let xp3_detection = detection_report
        .detections
        .iter()
        .find(|detection| detection.adapter_id == kaifuu_engine_fixture::XP3_DETECTOR_ADAPTER_ID)
        .unwrap();
    assert!(!xp3_detection.detected);
    assert!(xp3_detection.evidence.iter().any(|evidence| {
        evidence.path == "data.xp3" && evidence.status == EvidenceStatus::Missing
    }));
    let reallive_detection = detection_report
        .detections
        .iter()
        .find(|detection| {
            detection.adapter_id == kaifuu_engine_fixture::REALLIVE_DETECTOR_ADAPTER_ID
        })
        .unwrap();
    assert!(!reallive_detection.detected);
    assert!(
        detection_report
            .detections
            .iter()
            .all(|detection| !detection.detected)
    );
    assert!(detection_report.warnings[0].contains("no registered adapter"));

    let serialized = fs::read_to_string(&detect_path).unwrap();
    assert!(!serialized.contains("confidence"));
    let serialized_report: serde_json::Value = serde_json::from_str(&serialized).unwrap();
    for detection_json in serialized_report["detections"].as_array().unwrap() {
        let detection_json = detection_json.as_object().unwrap();
        assert!(!detection_json.contains_key("engineFamily"));
        assert!(!detection_json.contains_key("engineVersion"));
        assert!(!detection_json.contains_key("detectedVariant"));
    }
    let _ = fs::remove_dir_all(root);
}

#[test]
fn detect_cli_writes_archive_detection_matrix_without_adapter_support_claim() {
    let root = temp_dir("archive-detect");
    let game_dir = root.join("Private Route Spoiler Game");
    fs::create_dir_all(&game_dir).unwrap();
    write_fixture_file(&game_dir, "game/scripts.rpa", b"RenPy archive synthetic");
    write_fixture_file(
        &game_dir,
        "www/data/System.json",
        br#"{
  "hasEncryptedImages": true,
  "encryptionKey": "00112233445566778899aabbccddeeff"
}"#,
    );
    write_fixture_file(&game_dir, "img/pictures/private-title.rpgmvp", b"encrypted");
    write_fixture_file(&game_dir, "img/pictures/private-title.png_", b"encrypted");
    let detect_path = root.join("detect.json");

    run_cli(&[
        "detect",
        game_dir.to_str().unwrap(),
        "--output",
        detect_path.to_str().unwrap(),
    ]);

    let detection_report: DetectionReport = read_json(&detect_path).unwrap();
    assert_eq!(detection_report.game_dir, REDACTED_DETECTION_GAME_DIR);
    assert_eq!(detection_report.status, DetectionReportStatus::Unknown);
    assert_eq!(
        detection_report.archive_detection.status,
        ArchiveDetectionStatus::Matched
    );
    assert!(!detection_report.detections[0].detected);
    assert!(
        detection_report
            .warnings
            .iter()
            .any(|warning| { warning.contains("no registered extraction adapter") })
    );

    let rpg_maker = detection_report
        .archive_detection
        .rows
        .iter()
        .find(|row| row.row_id == "rpg-maker-mv-mz-encrypted-assets")
        .unwrap();
    assert!(rpg_maker.detected);
    assert!(
        rpg_maker
            .signals
            .contains(&ArchiveDetectionSignal::Encrypted)
    );
    assert!(rpg_maker.evidence.iter().any(|evidence| {
        evidence.pattern == "*.rpgmvp|*.rpgmvm|*.rpgmvo|*.rpgmvu|*.png_|*.m4a_|*.ogg_"
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 2
    }));
    assert!(
        rpg_maker
            .diagnostics
            .iter()
            .any(|diagnostic| { diagnostic.code == SemanticErrorCode::MissingKeyMaterial })
    );
    assert!(rpg_maker.capabilities.iter().any(|capability| {
        capability.capability == Capability::Extraction
            && capability.status == CapabilityStatus::Unsupported
    }));

    let serialized = fs::read_to_string(&detect_path).unwrap();
    assert!(serialized.contains("\"archiveDetection\""));
    assert!(!serialized.contains(&game_dir.display().to_string()));
    assert!(!serialized.contains("Private Route Spoiler Game"));
    assert!(!serialized.contains("00112233445566778899aabbccddeeff"));
    assert!(!serialized.contains("private-title"));
    assert!(!serialized.contains("confidence"));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn detect_cli_matches_public_rpg_maker_encrypted_suffix_fixture_report() {
    let root = temp_dir("public-rpg-maker-suffix-detect");
    let game_dir = public_fixture_path("fixtures/public/kaifuu-rpg-maker-encrypted-suffixes");
    let expected_path = game_dir.join("expected/detection-report-v0.1.json");
    let detect_path = root.join("detect.json");

    run_cli(&[
        "detect",
        game_dir.to_str().unwrap(),
        "--output",
        detect_path.to_str().unwrap(),
    ]);

    let actual: serde_json::Value = read_json(&detect_path).unwrap();
    let expected: serde_json::Value = read_json(&expected_path).unwrap();
    assert_eq!(without_bgi_detection(actual.clone()), expected);

    let detection_report: DetectionReport = serde_json::from_value(actual).unwrap();
    assert_eq!(detection_report.status, DetectionReportStatus::Unknown);
    assert_eq!(
        detection_report.archive_detection.status,
        ArchiveDetectionStatus::Matched
    );
    assert!(!detection_report.detections[0].detected);
    let rpg_maker = detection_report
        .archive_detection
        .rows
        .iter()
        .find(|row| row.row_id == "rpg-maker-mv-mz-encrypted-assets")
        .unwrap();
    assert!(rpg_maker.detected);
    assert!(rpg_maker.evidence.iter().any(|evidence| {
        evidence.pattern == "*.rpgmvp|*.rpgmvm|*.rpgmvo|*.rpgmvu|*.png_|*.m4a_|*.ogg_"
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 7
    }));
    assert!(
        rpg_maker
            .diagnostics
            .iter()
            .any(|diagnostic| { diagnostic.code == SemanticErrorCode::MissingKeyMaterial })
    );
    assert_eq!(rpg_maker.detected_variant, "mv_or_mz_with_unknown_suffix");
    assert!(rpg_maker.surfaces.iter().any(|surface| {
        surface.fixture_id == "kaifuu-rpgmaker-mv-image-rpgmvp"
            && surface.engine_family == "rpg_maker_mv_mz"
            && surface.variant == "mv_or_mz"
            && surface.container == ContainerTransform::ProjectAsset
            && surface.crypto == CryptoTransform::RpgMakerAssetXor
            && surface.codec == CodecTransform::PngImage
            && surface.surface == "image_asset"
            && surface.key_requirement_refs == vec!["rpg-maker-mv-mz-asset-key".to_string()]
    }));
    assert!(rpg_maker.surfaces.iter().any(|surface| {
        surface.fixture_id == "kaifuu-rpgmaker-plain-image-png"
            && surface.variant == "plain_asset"
            && surface.crypto == CryptoTransform::NullKey
            && surface.key_requirement_refs.is_empty()
            && surface.diagnostics.is_empty()
    }));
    let unknown_surfaces = rpg_maker
        .surfaces
        .iter()
        .filter(|surface| surface.variant == "unknown_suffix")
        .collect::<Vec<_>>();
    assert_eq!(unknown_surfaces.len(), 1);
    for surface in unknown_surfaces {
        assert_eq!(surface.crypto, CryptoTransform::Unknown);
        assert!(surface.key_requirement_refs.is_empty());
        assert!(
            surface.diagnostics.iter().any(|diagnostic| {
                diagnostic.code == SemanticErrorCode::MissingCryptoCapability
            })
        );
        assert!(
            !surface
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == SemanticErrorCode::MissingKeyMaterial)
        );
    }

    let serialized = fs::read_to_string(&detect_path).unwrap();
    for forbidden in [
        "title.rpgmvp",
        "theme.rpgmvm",
        "cursor.rpgmvo",
        "title.rpgmvu",
        "title.webp_",
    ] {
        assert!(!serialized.contains(forbidden), "report leaked {forbidden}");
    }

    let _ = fs::remove_dir_all(root);
}

#[test]
fn rpg_maker_validate_fixture_key_command_writes_redacted_proof_report() {
    let root = temp_dir("rpg-maker-key-validation-cli");
    let secret_store = root.join("secret-store");
    write_fixture_file(
        &secret_store,
        "fixture/rpg-maker/asset-key",
        b"00112233445566778899aabbccddeeff",
    );
    let game_dir = public_fixture_path("fixtures/public/kaifuu-encrypted-matrix/raw/rpg-maker");
    let image_asset = game_dir.join("img").join("pictures").join("title.rpgmvp");
    let output = root.join("rpg-maker-key-validation.json");

    run_cli(&[
        "rpg-maker",
        "validate-fixture-key",
        "--game-dir",
        game_dir.to_str().unwrap(),
        "--image-asset",
        image_asset.to_str().unwrap(),
        "--secret-store",
        secret_store.to_str().unwrap(),
        "--secret-ref",
        "local-secret:fixture/rpg-maker/asset-key",
        "--output",
        output.to_str().unwrap(),
        "--fixture-id",
        "kaifuu-rpg-maker-mv-mz-key-validation-success",
    ]);

    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "passed");
    assert_eq!(report["decryptOrPatchClaimed"], false);
    assert_eq!(
        report["records"][0]["requirementId"],
        "rpg-maker-mv-mz-asset-key"
    );
    assert_eq!(report["records"][0]["surface"], "image_asset");
    assert_eq!(report["records"][0]["codec"], "png_image");
    assert_eq!(report["records"][0]["diagnosticResult"], "success");
    assert!(
        report["records"][0]["proofHash"]
            .as_str()
            .unwrap()
            .starts_with("sha256:")
    );

    let serialized = fs::read_to_string(&output).unwrap();
    for forbidden in [
        "fixture-only-rpg-maker-asset-key-v1",
        "00112233445566778899aabbccddeeff",
        "fixture/rpg-maker/asset-key",
        secret_store.to_str().unwrap(),
        image_asset.to_str().unwrap(),
    ] {
        assert!(
            !serialized.contains(forbidden),
            "CLI report leaked {forbidden}: {serialized}"
        );
    }

    let _ = fs::remove_dir_all(root);
}

#[test]
fn rpg_maker_validate_fixture_key_command_fails_without_image_evidence() {
    let root = temp_dir("rpg-maker-key-validation-cli-missing-image");
    let secret_store = root.join("secret-store");
    write_fixture_file(
        &secret_store,
        "fixture/rpg-maker/asset-key",
        b"00112233445566778899aabbccddeeff",
    );
    let game_dir = public_fixture_path("fixtures/public/kaifuu-encrypted-matrix/raw/rpg-maker");
    let missing_image_asset = game_dir.join("img").join("pictures").join("missing.rpgmvp");
    let output = root.join("rpg-maker-key-validation-missing-image.json");

    let result = run_with_args(
        [
            "rpg-maker",
            "validate-fixture-key",
            "--game-dir",
            game_dir.to_str().unwrap(),
            "--image-asset",
            missing_image_asset.to_str().unwrap(),
            "--secret-store",
            secret_store.to_str().unwrap(),
            "--secret-ref",
            "local-secret:fixture/rpg-maker/asset-key",
            "--output",
            output.to_str().unwrap(),
            "--fixture-id",
            "kaifuu-rpg-maker-missing-image-evidence",
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
    );

    let error = result.expect_err("missing image evidence must fail validation");
    let error = error.to_string();
    assert!(error.contains("MissingImageEvidence:imageAssetPath"));

    let report: serde_json::Value = read_json(&output).unwrap();
    assert_eq!(report["status"], "failed");
    assert_eq!(report["records"][0]["surface"], "image_asset");
    assert_eq!(report["records"][0]["codec"], "png_image");
    assert_eq!(
        report["records"][0]["diagnosticResult"],
        "missing_image_evidence"
    );
    assert!(report["records"][0]["proofHash"].is_null());
    assert!(report["records"][0]["imageEvidenceHash"].is_null());
    assert!(
        report["records"][0]["systemJsonProofHash"]
            .as_str()
            .unwrap()
            .starts_with("sha256:")
    );
    assert_eq!(report["diagnostics"][0]["code"], "missing_image_evidence");
    assert_eq!(report["diagnostics"][0]["field"], "imageAssetPath");
    assert_eq!(
        report["diagnostics"][0]["message"],
        "encrypted image evidence is missing or unreadable"
    );

    let serialized = fs::read_to_string(&output).unwrap();
    for forbidden in [
        "fixture-only-rpg-maker-asset-key-v1",
        "00112233445566778899aabbccddeeff",
        "fixture/rpg-maker/asset-key",
        secret_store.to_str().unwrap(),
        missing_image_asset.to_str().unwrap(),
    ] {
        assert!(
            !serialized.contains(forbidden),
            "CLI report leaked {forbidden}: {serialized}"
        );
    }
    assert!(!serialized.contains("image evidence matched"));

    let _ = fs::remove_dir_all(root);
}
