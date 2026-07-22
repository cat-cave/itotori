#[test]
fn detect_source_without_units_has_no_engine_version() {
    let root = temp_dir("source-without-units-detect");
    let game_dir = root.join("unknown-fixture-like-game");
    fs::create_dir_all(&game_dir).unwrap();
    fs::write(
        game_dir.join("source.json"),
        r#"{
  "gameId": "not-fixture-yet",
  "title": "Not Fixture Yet",
  "sourceLocale": "ja-JP"
}
"#,
    )
    .unwrap();
    let detect_path = root.join("detect.json");

    run_cli(&[
        "detect",
        game_dir.to_str().unwrap(),
        "--output",
        detect_path.to_str().unwrap(),
    ]);

    let detection_report: DetectionReport = read_json(&detect_path).unwrap();
    assert_eq!(detection_report.status, DetectionReportStatus::Unknown);
    let detection = detection_report
        .detections
        .iter()
        .find(|detection| detection.adapter_id == kaifuu_engine_fixture::FIXTURE_ADAPTER_ID)
        .unwrap();
    assert!(!detection.detected);
    assert_eq!(detection.engine_family, None);
    assert_eq!(detection.engine_version, None);
    assert_eq!(detection.detected_variant, None);
    assert!(detection.evidence.iter().any(|evidence| {
        evidence.path == "source.json"
            && evidence.status == EvidenceStatus::Missing
            && evidence.detail.contains("missing units")
    }));
    let serialized: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&detect_path).unwrap()).unwrap();
    let detection_json = serialized["detections"]
        .as_array()
        .unwrap()
        .iter()
        .find(|detection| detection["adapterId"] == kaifuu_engine_fixture::FIXTURE_ADAPTER_ID)
        .unwrap()
        .as_object()
        .unwrap();
    assert!(!detection_json.contains_key("engineFamily"));
    assert!(!detection_json.contains_key("engineVersion"));
    assert!(!detection_json.contains_key("detectedVariant"));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn profile_init_is_stable_across_repeated_cli_runs() {
    let root = temp_dir("profile-init-stability");
    let game_dir = temp_game(&root);
    let first_path = root.join("profile-first.json");
    let second_path = root.join("profile-second.json");

    run_cli(&[
        "profile",
        "init",
        game_dir.to_str().unwrap(),
        "--output",
        first_path.to_str().unwrap(),
    ]);
    run_cli(&[
        "profile",
        "init",
        game_dir.to_str().unwrap(),
        "--output",
        second_path.to_str().unwrap(),
    ]);

    assert_eq!(
        fs::read_to_string(&first_path).unwrap(),
        fs::read_to_string(&second_path).unwrap()
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn profile_validation_reports_missing_required_fields() {
    let root = temp_dir("profile-validation-failure");
    let profile_path = root.join("profile.json");
    let validation_path = root.join("validation.json");
    fs::write(
        &profile_path,
        r#"{
  "schemaVersion": "0.1.0",
  "profileId": "",
  "gameId": "broken-game",
  "title": "Broken Game",
  "sourceLocale": "ja-JP",
  "engine": {
    "adapterId": "kaifuu.fixture",
    "engineFamily": "fixture",
    "engineVersion": null,
    "detectedVariant": ""
  },
  "assets": [],
  "capabilities": [],
  "requirements": [
    {
      "category": "secret_key",
      "key": "archive_key",
      "status": "missing",
      "description": "archive key must be provided out of band",
      "placeholder": "KAIFUU_ARCHIVE_KEY",
      "secret": true
    }
  ],
  "metadata": {}
}
"#,
    )
    .unwrap();

    run_cli(&[
        "profile",
        "validate",
        profile_path.to_str().unwrap(),
        "--output",
        validation_path.to_str().unwrap(),
    ]);

    let validation: kaifuu_core::ProfileValidationResult = read_json(&validation_path).unwrap();
    assert_eq!(validation.status, OperationStatus::Failed);
    assert!(validation.failures.iter().any(|failure| {
        failure.code == "missing_required_field" && failure.field == "profileId"
    }));
    assert!(validation.failures.iter().any(|failure| {
        failure.code == "missing_requirement" && failure.field == "requirements.archive_key"
    }));
    let serialized = fs::read_to_string(&validation_path).unwrap();
    assert!(serialized.contains("KAIFUU_ARCHIVE_KEY"));
    assert!(!serialized.contains("actual-secret"));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn profile_validation_redacts_secret_bearing_key_profile_fields() {
    let root = temp_dir("profile-validation-redaction");
    let profile_path = root.join("profile.json");
    let validation_path = root.join("validation.json");
    fs::write(
        &profile_path,
        r#"{
  "schemaVersion": "0.1.0",
  "profileId": "019ed000-0000-7000-8000-profile00014",
  "gameId": "siglus-owned-local",
  "title": "Siglus Owned Local",
  "sourceLocale": "ja-JP",
  "engine": {
    "adapterId": "kaifuu.siglus",
    "engineFamily": "siglus",
    "engineVersion": null,
    "detectedVariant": "scene-pck-secondary-key"
  },
  "sourceFingerprint": {
    "gameRootHash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "engineEvidence": ["Scene.pck", "Gameexe.dat"]
  },
  "keyRequirements": [
    {
      "requirementId": "siglus-secondary-key",
      "secretRef": "local-secret:siglus/example/secondary-key",
      "kind": "fixedBytes",
      "bytes": 16,
      "rawKey": "00112233445566778899aabbccddeeff",
      "validation": {
        "method": "decryptHeaderProof",
        "proofHash": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      }
    }
  ],
  "archiveParameters": [
    {
      "parameterId": "scene-cipher-key",
      "name": "cipherKey",
      "kind": "cipherScheme",
      "value": "mP9xZpQ2rS7vLj4N8aW_KtYd0hF3uC6b",
      "source": "manual"
    }
  ],
  "helperEvidence": {
    "helperKind": "staticParser",
    "toolVersion": "kaifuu-key-helper/0.1.0",
    "redactedLogHash": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "helperDump": "register dump with local key bytes"
  },
  "assets": [
    {
      "assetId": "019ed000-0000-7000-8000-asset0000014",
      "path": "Scene.pck",
      "assetKind": "archive",
      "textSurfaces": ["dialogue"],
      "sourceHash": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      "patching": {
        "capability": "patching",
        "status": "limited",
        "limitation": "requires caller-provided resolved keys and archive parameters"
      }
    }
  ],
  "capabilities": [
    {
      "capability": "key_profile",
      "status": "supported",
      "limitation": null
    },
    {
      "capability": "patching",
      "status": "limited",
      "limitation": "requires caller-provided resolved keys and archive parameters"
    }
  ],
  "requirements": [
    {
      "category": "secret_key",
      "key": "siglus-secondary-key",
      "status": "satisfied",
      "description": "secondary key is referenced through local secret storage",
      "placeholder": null,
      "secret": true
    }
  ],
  "metadata": {
    "localPath": "/home/dev/private-game",
    "decryptedText": "private script line"
  }
}
"#,
    )
    .unwrap();

    run_cli(&[
        "profile",
        "validate",
        profile_path.to_str().unwrap(),
        "--output",
        validation_path.to_str().unwrap(),
    ]);

    let validation: kaifuu_core::ProfileValidationResult = read_json(&validation_path).unwrap();
    assert_eq!(validation.status, OperationStatus::Failed);
    for field in [
        "keyRequirements.0.rawKey",
        "archiveParameters.0.value",
        "helperEvidence.helperDump",
        "metadata.localPath",
        "metadata.decryptedText",
    ] {
        assert!(
            validation.failures.iter().any(|failure| {
                failure.code == kaifuu_core::SEMANTIC_SECRET_REDACTED && failure.field == field
            }),
            "missing secret redaction failure for {field}: {:#?}",
            validation.failures
        );
    }
    let serialized = fs::read_to_string(&validation_path).unwrap();
    assert!(!serialized.contains("00112233445566778899aabbccddeeff"));
    assert!(!serialized.contains("mP9xZpQ2rS7vLj4N8aW_KtYd0hF3uC6b"));
    assert!(!serialized.contains("/home/dev/private-game"));
    assert!(!serialized.contains("private script line"));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn profile_validation_redacts_requirement_free_text_fields() {
    let root = temp_dir("profile-validation-requirement-redaction");
    let profile_path = root.join("profile.json");
    let validation_path = root.join("validation.json");
    fs::write(
            &profile_path,
            r#"{
  "schemaVersion": "0.1.0",
  "profileId": "019ed000-0000-7000-8000-profile00015",
  "gameId": "sensitive-requirements",
  "title": "Sensitive Requirements",
  "sourceLocale": "ja-JP",
  "engine": {
    "adapterId": "kaifuu.fixture",
    "engineFamily": "fixture",
    "engineVersion": null,
    "detectedVariant": "plain-json-source"
  },
  "assets": [],
  "capabilities": [
    {
      "capability": "patching",
      "status": "limited",
      "limitation": "requires profile validation"
    }
  ],
  "requirements": [
    {
      "category": "secret_key",
      "key": "archive-key",
      "status": "missing",
      "description": "helper dump source:/home/dev/game/private-route-ending.ks exposed raw key 00112233445566778899aabbccddeeff",
      "placeholder": "file=C:\\Games\\SecretRoute\\key.bin",
      "secret": true
    },
    {
      "category": "file",
      "key": "story-script",
      "status": "unsupported",
      "description": "decrypted text from private-route-ending.ks must remain local",
      "placeholder": null,
      "secret": false
    }
  ],
  "metadata": {}
}
"#,
        )
        .unwrap();

    run_cli(&[
        "profile",
        "validate",
        profile_path.to_str().unwrap(),
        "--output",
        validation_path.to_str().unwrap(),
    ]);

    let validation: kaifuu_core::ProfileValidationResult = read_json(&validation_path).unwrap();
    assert_eq!(validation.status, OperationStatus::Failed);
    for field in [
        "requirements.0.description",
        "requirements.0.placeholder",
        "requirements.1.description",
    ] {
        assert!(
            validation.failures.iter().any(|failure| {
                failure.code == kaifuu_core::SEMANTIC_SECRET_REDACTED && failure.field == field
            }),
            "missing requirement redaction failure for {field}: {:#?}",
            validation.failures
        );
    }
    let serialized = fs::read_to_string(&validation_path).unwrap();
    assert!(serialized.contains(kaifuu_core::SEMANTIC_SECRET_REDACTED));
    for forbidden in [
        "/home/dev/game",
        "C:\\Games",
        "helper dump",
        "decrypted text",
        "00112233445566778899aabbccddeeff",
        "private-route-ending.ks",
        "SecretRoute",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "validation leaked {forbidden}"
        );
    }

    let _ = fs::remove_dir_all(root);
}

#[test]
fn profile_validation_reports_malformed_profile_fields() {
    let root = temp_dir("profile-validation-malformed");
    let profile_path = root.join("profile.json");
    let validation_path = root.join("validation.json");
    fs::write(
        &profile_path,
        r#"{
  "schemaVersion": "9.9.9",
  "profileId": "bad profile id",
  "gameId": "broken-game",
  "title": "Broken Game",
  "sourceLocale": "ja_JP",
  "engine": {
    "adapterId": "kaifuu.fixture",
    "engineFamily": "fixture",
    "engineVersion": "",
    "detectedVariant": "plain-json-source"
  },
  "assets": [
    {
      "assetId": "bad asset",
      "path": "../source.json",
      "assetKind": "scriptish",
      "textSurfaces": ["dialogue", "dialogue", "bad_surface"],
      "sourceHash": "",
      "patching": {
        "capability": "line_parity_patching",
        "status": "limited",
        "limitation": ""
      }
    }
  ],
  "capabilities": [
    {
      "capability": "detection",
      "status": "supported",
      "limitation": "unexpected"
    },
    {
      "capability": "detection",
      "status": "supported",
      "limitation": null
    }
  ],
  "requirements": [
    {
      "category": "secret_key",
      "key": "archive key",
      "status": "blocked",
      "description": "",
      "placeholder": null,
      "secret": true
    }
  ],
  "metadata": {}
}
"#,
    )
    .unwrap();

    run_cli(&[
        "profile",
        "validate",
        profile_path.to_str().unwrap(),
        "--output",
        validation_path.to_str().unwrap(),
    ]);

    let validation: kaifuu_core::ProfileValidationResult = read_json(&validation_path).unwrap();
    assert_eq!(validation.status, OperationStatus::Failed);
    for expected_code in [
        "unsupported_schema_version",
        "invalid_locale",
        "invalid_engine_version",
        "invalid_asset_id",
        "invalid_asset_path",
        "invalid_enum_value",
        "duplicate_text_surface",
        "invalid_text_surface",
        "invalid_source_hash",
        "missing_capability_limitation",
        "unexpected_capability_limitation",
        "duplicate_capability",
        "invalid_requirement_key",
        "inconsistent_capability",
    ] {
        assert!(
            validation
                .failures
                .iter()
                .any(|failure| failure.code == expected_code),
            "missing validation failure code {expected_code}: {:#?}",
            validation.failures
        );
    }
    let serialized = fs::read_to_string(&validation_path).unwrap();
    assert!(!serialized.contains("confidence"));
    assert!(!serialized.contains("actual-secret"));

    let _ = fs::remove_dir_all(root);
}

// `kaifuu xp3 profile-proof` CLI tests

fn kirikiri_fixture_path(relative_path: &str) -> PathBuf {
    test_manifest_dir()
        .join("../..")
        .join("fixtures/kaifuu/kirikiri")
        .join(relative_path)
}
