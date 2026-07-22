#[test]
fn patch_command_preflight_failure_is_redacted_and_writes_no_output() {
    let root = temp_dir("patch-preflight-redaction");
    let game_dir = root.join("Private Route Spoiler Game");
    fs::create_dir_all(&game_dir).unwrap();
    let patch_export = PatchExport {
        patch_export_id: deterministic_id("patch", 77),
        source_locale: "ja-JP".to_string(),
        target_locale: "en-US".to_string(),
        entries: vec![],
    };
    let patch_export_path = root.join("patch-export.json");
    write_json(&patch_export_path, &patch_export).unwrap();
    let output_dir = root.join("patched-output");
    let registry = preflight_registry();

    let result = run_with_args_and_registry(
        [
            "patch",
            game_dir.to_str().unwrap(),
            "--patch",
            patch_export_path.to_str().unwrap(),
            "--output",
            output_dir.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
        &registry,
    );

    let error = result.unwrap_err().to_string();
    assert!(error.contains("patch preflight failed"), "{error}");
    assert!(
        error.contains(kaifuu_core::SEMANTIC_MISSING_CONTAINER_CAPABILITY),
        "{error}"
    );
    assert!(
        error.contains(kaifuu_core::SEMANTIC_MISSING_CRYPTO_CAPABILITY),
        "{error}"
    );
    assert!(!error.contains("00112233445566778899aabbccddeeff"));
    assert!(!error.contains("/home/dev"));
    assert!(!error.contains("Private Route Spoiler Game"));
    assert!(!error.contains("private-route-name"));
    assert!(!error.contains("helper dump"));
    assert!(!output_dir.exists());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn patch_command_preflight_blocks_layered_contract_status_before_output_prepare() {
    let root = temp_dir("patch-preflight-contract-status");
    let game_dir = root.join("game");
    fs::create_dir_all(&game_dir).unwrap();
    let patch_export = PatchExport {
        patch_export_id: deterministic_id("patch", 82),
        source_locale: "ja-JP".to_string(),
        target_locale: "en-US".to_string(),
        entries: vec![],
    };
    let patch_export_path = root.join("patch-export.json");
    write_json(&patch_export_path, &patch_export).unwrap();
    let output_dir = root.join("patched-output");
    let registry = contract_status_preflight_registry();

    let result = run_with_args_and_registry(
        [
            "patch",
            game_dir.to_str().unwrap(),
            "--patch",
            patch_export_path.to_str().unwrap(),
            "--output",
            output_dir.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
        &registry,
    );

    let error = result.unwrap_err().to_string();
    assert!(error.contains("patch preflight failed"), "{error}");
    assert!(
        error.contains(kaifuu_core::SEMANTIC_MISSING_PATCH_BACK_CAPABILITY),
        "{error}"
    );
    assert!(!output_dir.exists());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn patch_command_reports_encoded_string_slot_preflight_without_output_mutation() {
    let root = temp_dir("patch-encoded-string-slot-preflight");
    let game_dir = root.join("game");
    fs::create_dir_all(&game_dir).unwrap();
    fs::write(
        game_dir.join("source.json"),
        r#"{
  "gameId": "encoded-slot-fixture",
  "title": "Encoded Slot Fixture",
  "sourceLocale": "ja-JP",
  "units": [
    {
      "sourceUnitKey": "slot.line.001",
      "speaker": "Narrator",
      "textSurface": "dialogue",
      "sourceText": "Hi",
      "encodedStringSlot": {
        "slotId": "slot.line.001",
        "encoding": "utf_8",
        "byteRange": { "start": 32, "end": 37 },
        "layout": { "kind": "null_terminated", "terminatorHex": "00" },
        "sourceBytesHex": "4869000000"
      }
    }
  ]
}
"#,
    )
    .unwrap();
    let bridge_path = root.join("bridge.json");
    run_cli(&[
        "extract",
        game_dir.to_str().unwrap(),
        "--output",
        bridge_path.to_str().unwrap(),
    ]);
    let bridge: BridgeBundle = read_json(&bridge_path).unwrap();
    let patch_export = PatchExport {
        patch_export_id: deterministic_id("patch", 82),
        source_locale: "ja-JP".to_string(),
        target_locale: "en-US".to_string(),
        entries: vec![PatchExportEntry {
            bridge_unit_id: bridge.units[0].bridge_unit_id.clone(),
            source_unit_key: bridge.units[0].source_unit_key.clone(),
            source_hash: bridge.units[0].source_hash.clone(),
            target_text: "Overflow".to_string(),
            protected_span_mappings: vec![],
        }],
    };
    let patch_export_path = root.join("patch-export.json");
    write_json(&patch_export_path, &patch_export).unwrap();
    let output_dir = root.join("patched-output");

    let result = run_with_args(
        [
            "patch",
            game_dir.to_str().unwrap(),
            "--patch",
            patch_export_path.to_str().unwrap(),
            "--output",
            output_dir.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
    );

    let error = result.unwrap_err().to_string();
    assert!(error.contains("patch preflight failed"), "{error}");
    assert!(error.contains(kaifuu_core::STRING_SLOT_OVERFLOW), "{error}");
    assert!(error.contains("slot.line.001"), "{error}");
    assert!(error.contains("byte range 32..37"), "{error}");
    assert!(error.contains("shorten_translation"), "{error}");
    assert!(error.contains("encoded target plus terminator"), "{error}");
    assert!(!error.contains("Overflow"), "{error}");
    assert!(!output_dir.exists());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn patch_command_cleans_malicious_adapter_output_on_late_preflight_failure() {
    let root = temp_dir("patch-preflight-malicious-output");
    let game_dir = root.join("malicious-game");
    fs::create_dir_all(&game_dir).unwrap();
    let patch_export = PatchExport {
        patch_export_id: deterministic_id("patch", 78),
        source_locale: "ja-JP".to_string(),
        target_locale: "en-US".to_string(),
        entries: vec![],
    };
    let patch_export_path = root.join("patch-export.json");
    write_json(&patch_export_path, &patch_export).unwrap();
    let output_dir = root.join("patched-output");
    let registry = malicious_registry(AdapterFailure::missing_key_material(
        "kaifuu.test.malicious-preflight",
        "malicious-preflight-test",
        "writes-before-failure",
        "raw-key",
        "path=/home/dev/game helper dump contained 00112233445566778899aabbccddeeff",
    ));

    let result = run_with_args_and_registry(
        [
            "patch",
            game_dir.to_str().unwrap(),
            "--patch",
            patch_export_path.to_str().unwrap(),
            "--output",
            output_dir.to_str().unwrap(),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect(),
        &registry,
    );

    let error = result.unwrap_err().to_string();
    assert!(error.contains("patch preflight failed"), "{error}");
    assert!(error.contains(kaifuu_core::SEMANTIC_MISSING_KEY_MATERIAL));
    assert!(!error.contains("/home/dev"));
    assert!(!error.contains("helper dump"));
    assert!(!error.contains("00112233445566778899aabbccddeeff"));
    assert!(!output_dir.exists());
    let leaked_entries = fs::read_dir(&root)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.contains("patched-output") && name.contains("kaifuu-staging"))
        .collect::<Vec<_>>();
    assert_eq!(leaked_entries, Vec::<String>::new());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn patch_command_preflight_blocking_semantic_classes_write_no_output() {
    let cases = vec![
        AdapterFailure::missing_key_material(
            "kaifuu.test.malicious-preflight",
            "semantic-test",
            "missing-key",
            "local-key",
            "missing local key material",
        ),
        AdapterFailure::helper_unavailable(
            "kaifuu.test.malicious-preflight",
            "semantic-test",
            "helper-unavailable",
            "helper unavailable before patching",
        ),
        AdapterFailure::key_validation_failed(
            "kaifuu.test.malicious-preflight",
            "semantic-test",
            "key-validation",
            "local-key",
            "key validation failed before patching",
        ),
        AdapterFailure::protected_executable_unsupported(
            "kaifuu.test.malicious-preflight",
            "semantic-test",
            "protected-exe",
            "protected executable unsupported before patching",
        ),
        AdapterFailure::semantic(
            kaifuu_core::AdapterFailureSemanticParams::new(
                SemanticErrorCode::UnsupportedLayeredTransform,
                "kaifuu.test.malicious-preflight",
                "unsupported layered transform before patching",
            )
            .engine("semantic-test")
            .detected_variant("unsupported-layered-transform"),
        ),
        AdapterFailure::semantic(
            kaifuu_core::AdapterFailureSemanticParams::new(
                SemanticErrorCode::MissingCodecCapability,
                "kaifuu.test.malicious-preflight",
                "codec unavailable before patching",
            )
            .engine("semantic-test")
            .detected_variant("missing-codec")
            .required_capability(Capability::CodecAccess),
        ),
        AdapterFailure::semantic(
            kaifuu_core::AdapterFailureSemanticParams::new(
                SemanticErrorCode::MissingPatchBackCapability,
                "kaifuu.test.malicious-preflight",
                "patch-back unavailable before patching",
            )
            .engine("semantic-test")
            .detected_variant("missing-patch-back")
            .required_capability(Capability::PatchBack),
        ),
    ];

    for (index, failure) in cases.into_iter().enumerate() {
        let root = temp_dir(&format!("patch-preflight-semantic-{index}"));
        let game_dir = root.join("game");
        fs::create_dir_all(&game_dir).unwrap();
        let patch_export = PatchExport {
            patch_export_id: deterministic_id("patch", 790 + index),
            source_locale: "ja-JP".to_string(),
            target_locale: "en-US".to_string(),
            entries: vec![],
        };
        let patch_export_path = root.join("patch-export.json");
        write_json(&patch_export_path, &patch_export).unwrap();
        let output_dir = root.join("patched-output");
        let expected_code = failure.error_code.clone();
        let registry = malicious_registry(failure);

        let result = run_with_args_and_registry(
            [
                "patch",
                game_dir.to_str().unwrap(),
                "--patch",
                patch_export_path.to_str().unwrap(),
                "--output",
                output_dir.to_str().unwrap(),
            ]
            .iter()
            .map(std::string::ToString::to_string)
            .collect(),
            &registry,
        );

        let error = result.unwrap_err().to_string();
        assert!(error.contains("patch preflight failed"), "{error}");
        assert!(error.contains(&expected_code), "{error}");
        assert!(!output_dir.exists(), "{expected_code} wrote output");
        let _ = fs::remove_dir_all(root);
    }
}
