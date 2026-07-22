#[test]
fn engine_commands_use_supplied_registry() {
    let root = temp_dir("injected-registry-dispatch");
    let game_dir = root.join("non-fixture-game");
    fs::create_dir_all(&game_dir).unwrap();
    let calls = Rc::new(RefCell::new(Vec::new()));
    let registry = recording_registry(Rc::clone(&calls));

    let capabilities_path = root.join("capabilities.json");
    run_cli_with_registry(
        &[
            "capabilities",
            "--output",
            capabilities_path.to_str().unwrap(),
        ],
        &registry,
    );
    let capabilities: Vec<AdapterCapabilities> = read_json(&capabilities_path).unwrap();
    assert_eq!(capabilities, vec![test_capabilities()]);
    assert_calls(&calls, &["capabilities"]);

    let detect_path = root.join("detect.json");
    run_cli_with_registry(
        &[
            "detect",
            game_dir.to_str().unwrap(),
            "--output",
            detect_path.to_str().unwrap(),
        ],
        &registry,
    );
    let detection_report: DetectionReport = read_json(&detect_path).unwrap();
    assert_eq!(detection_report.status, DetectionReportStatus::Matched);
    assert_eq!(detection_report.detections.len(), 1);
    let detection = &detection_report.detections[0];
    assert_eq!(detection.adapter_id, TEST_ADAPTER_ID);
    assert_eq!(
        detection.detected_variant.as_deref(),
        Some("injected-adapter")
    );
    assert_eq!(detection.evidence[0].status, EvidenceStatus::Matched);
    let serialized_detection: serde_json::Value = read_json(&detect_path).unwrap();
    let detection_json = &serialized_detection["detections"][0];
    assert_eq!(detection_json["engineFamily"], "registry-test");
    assert_eq!(detection_json["engineVersion"], "9.9.9");
    assert_eq!(detection_json["detectedVariant"], "injected-adapter");
    let serialized_detection_text = fs::read_to_string(&detect_path).unwrap();
    assert!(!serialized_detection_text.contains(&game_dir.display().to_string()));
    assert_calls(&calls, &["detect"]);

    let profile_path = root.join("profile.json");
    run_cli_with_registry(
        &[
            "profile",
            "init",
            game_dir.to_str().unwrap(),
            "--output",
            profile_path.to_str().unwrap(),
        ],
        &registry,
    );
    let profile: GameProfile = read_json(&profile_path).unwrap();
    assert_eq!(profile.engine.adapter_id, TEST_ADAPTER_ID);
    assert_eq!(profile.game_id, "registry-dispatch-game");
    assert_calls(&calls, &["detect", "profile"]);

    let asset_inventory_path = root.join("asset-inventory.json");
    run_cli_with_registry(
        &[
            "asset-inventory",
            game_dir.to_str().unwrap(),
            "--output",
            asset_inventory_path.to_str().unwrap(),
        ],
        &registry,
    );
    let asset_inventory: AssetInventoryManifest = read_json(&asset_inventory_path).unwrap();
    assert_eq!(asset_inventory.adapter_id, TEST_ADAPTER_ID);
    assert_eq!(asset_inventory.surfaces.len(), 1);
    assert_eq!(
        asset_inventory.surfaces[0].patching.status,
        CapabilityStatus::Unsupported
    );
    assert_calls(&calls, &["detect", "asset_inventory"]);

    let validation_path = root.join("profile-validation.json");
    run_cli_with_registry(
        &[
            "profile",
            "validate",
            profile_path.to_str().unwrap(),
            "--output",
            validation_path.to_str().unwrap(),
        ],
        &registry,
    );
    let validation: kaifuu_core::ProfileValidationResult = read_json(&validation_path).unwrap();
    assert_eq!(validation.status, OperationStatus::Passed);
    assert_calls(&calls, &[]);

    let bridge_path = root.join("bridge.json");
    run_cli_with_registry(
        &[
            "extract",
            game_dir.to_str().unwrap(),
            "--output",
            bridge_path.to_str().unwrap(),
        ],
        &registry,
    );
    let bridge: BridgeBundle = read_json(&bridge_path).unwrap();
    assert_eq!(bridge.extractor_name, "registry-test-extractor");
    assert_eq!(bridge.units[0].source_unit_key, "registry.unit.001");
    assert_calls(&calls, &["detect", "extract"]);

    let patch_export = PatchExport {
        patch_export_id: deterministic_id("patch", 98),
        source_locale: "en-US".to_string(),
        target_locale: "fr-FR".to_string(),
        entries: vec![],
    };
    let patch_export_path = root.join("patch-export.json");
    write_json(&patch_export_path, &patch_export).unwrap();
    let patched_dir = root.join("patched");
    run_cli_with_registry(
        &[
            "patch",
            game_dir.to_str().unwrap(),
            "--patch",
            patch_export_path.to_str().unwrap(),
            "--output",
            patched_dir.to_str().unwrap(),
        ],
        &registry,
    );
    let patch_result: PatchResult = read_json(&patched_dir.join("patch-result.json")).unwrap();
    assert_eq!(patch_result.output_hash, "registry-patch-output");
    assert!(patched_dir.join("registry-adapter-called.txt").exists());
    assert_calls(&calls, &["detect", "patch"]);

    let verify_path = root.join("verify.json");
    run_cli_with_registry(
        &[
            "verify",
            game_dir.to_str().unwrap(),
            "--output",
            verify_path.to_str().unwrap(),
        ],
        &registry,
    );
    let verify: VerificationResult = read_json(&verify_path).unwrap();
    assert_eq!(verify.output_hash, "registry-verify-output");
    assert_calls(&calls, &["detect", "verify"]);

    let _ = fs::remove_dir_all(root);
}

#[test]
fn detection_and_capabilities_reports_redact_sensitive_free_text() {
    let root = temp_dir("sensitive-report-redaction");
    let game_dir = root.join("game");
    fs::create_dir_all(&game_dir).unwrap();
    let registry = sensitive_report_registry();

    let capabilities_path = root.join("capabilities.json");
    run_cli_with_registry(
        &[
            "capabilities",
            "--output",
            capabilities_path.to_str().unwrap(),
        ],
        &registry,
    );
    let capabilities_serialized = fs::read_to_string(&capabilities_path).unwrap();
    assert!(capabilities_serialized.contains(kaifuu_core::SEMANTIC_SECRET_REDACTED));
    for forbidden in ["~/games", "%USERPROFILE%", "private/key.bin", "SecretRoute"] {
        assert!(
            !capabilities_serialized.contains(forbidden),
            "capabilities leaked {forbidden}"
        );
    }

    let detect_path = root.join("detect.json");
    run_cli_with_registry(
        &[
            "detect",
            game_dir.to_str().unwrap(),
            "--output",
            detect_path.to_str().unwrap(),
        ],
        &registry,
    );
    let detection_serialized = fs::read_to_string(&detect_path).unwrap();
    assert!(detection_serialized.contains(kaifuu_core::SEMANTIC_SECRET_REDACTED));
    for forbidden in [
        "$HOME/games",
        "%USERPROFILE%",
        "private/key.bin",
        "SecretRoute",
    ] {
        assert!(
            !detection_serialized.contains(forbidden),
            "detection leaked {forbidden}"
        );
    }

    let _ = fs::remove_dir_all(root);
}

#[test]
fn profile_write_gate_rejects_unredacted_adapter_payloads_on_init_and_legacy_paths() {
    let root = temp_dir("sensitive-profile-write-gate");
    let game_dir = root.join("game");
    fs::create_dir_all(&game_dir).unwrap();
    let registry = sensitive_report_registry();

    for legacy in [false, true] {
        let label = if legacy { "legacy" } else { "init" };
        let output = root.join(format!("profile-{label}.json"));
        let args = if legacy {
            vec![
                "profile",
                game_dir.to_str().unwrap(),
                "--output",
                output.to_str().unwrap(),
            ]
        } else {
            vec![
                "profile",
                "init",
                game_dir.to_str().unwrap(),
                "--output",
                output.to_str().unwrap(),
            ]
        };
        let error = run_cli_with_registry_result(&args, &registry)
            .expect_err("sensitive profile payload should be rejected")
            .to_string();

        assert!(
            error.contains("generated profile failed validation"),
            "{label} path returned unexpected error: {error}"
        );
        assert!(
            error.contains(kaifuu_core::SEMANTIC_SECRET_REDACTED),
            "{label} path did not report the redaction boundary: {error}"
        );
        assert!(
            !output.exists(),
            "{label} path persisted an invalid profile to {}",
            output.display()
        );
        assert_no_sensitive_profile_material(&error);
    }

    let _ = fs::remove_dir_all(root);
}

#[test]
fn profile_write_gate_redacts_raw_key_material_before_persisting_valid_profile() {
    let root = temp_dir("profile-write-gate-redacted-persist");
    let output = root.join("profile.json");
    let profile = GameProfile {
        schema_version: "0.1.0".to_string(),
        profile_id: deterministic_id("profile", 1402),
        game_id: "valid-redaction-profile-game".to_string(),
        title: "Valid Profile 00112233445566778899aabbccddeeff".to_string(),
        source_locale: "ja-JP".to_string(),
        engine: EngineProfile {
            adapter_id: "kaifuu.test.redacted-persist".to_string(),
            engine_family: "redacted-persist-test".to_string(),
            engine_version: None,
            detected_variant: "valid-title-redaction".to_string(),
        },
        source_fingerprint: None,
        key_requirements: vec![],
        archive_parameters: vec![],
        helper_evidence: None,
        assets: vec![AssetProfile {
            asset_id: deterministic_id("asset", 1402),
            path: "source.ks".to_string(),
            asset_kind: AssetKind::Script,
            text_surfaces: vec![TextSurface::Dialogue],
            source_hash: Some(content_hash("redacted persist source")),
            patching: CapabilityReport::supported(Capability::Patching),
        }],
        layered_access: None,
        capabilities: vec![
            CapabilityReport::supported(Capability::ProfileGeneration),
            CapabilityReport::supported(Capability::Patching),
        ],
        requirements: vec![],
        metadata: BTreeMap::new(),
    };

    assert_eq!(profile.validate().status, OperationStatus::Passed);
    write_validated_stable_profile(&output, &profile).unwrap();

    let serialized = fs::read_to_string(&output).unwrap();
    assert!(serialized.contains(kaifuu_core::SEMANTIC_SECRET_REDACTED));
    assert_no_sensitive_profile_material(&serialized);

    let _ = fs::remove_dir_all(root);
}

#[test]
fn legacy_profile_command_rejects_structurally_invalid_profiles_before_write() {
    let root = temp_dir("legacy-profile-invalid-write-gate");
    let game_dir = root.join("game");
    fs::create_dir_all(&game_dir).unwrap();
    let output = root.join("profile.json");
    let registry = invalid_profile_registry();

    let error = run_cli_with_registry_result(
        &[
            "profile",
            game_dir.to_str().unwrap(),
            "--output",
            output.to_str().unwrap(),
        ],
        &registry,
    )
    .expect_err("legacy profile command should reject invalid generated profiles")
    .to_string();

    assert!(error.contains("generated profile failed validation"));
    assert!(error.contains("missing_required_field"));
    assert!(!output.exists());
    assert_no_sensitive_profile_material(&error);

    let _ = fs::remove_dir_all(root);
}

#[test]
fn fixture_commands_dispatch_through_registered_adapter() {
    let root = temp_dir("fixture-dispatch");
    let game_dir = temp_game(&root);

    let capabilities_path = root.join("capabilities.json");
    run_cli(&[
        "capabilities",
        "--output",
        capabilities_path.to_str().unwrap(),
    ]);
    let capabilities: Vec<AdapterCapabilities> = read_json(&capabilities_path).unwrap();
    assert_eq!(capabilities.len(), 7);
    let fixture_capabilities = capabilities
        .iter()
        .find(|capabilities| capabilities.adapter_id == kaifuu_engine_fixture::FIXTURE_ADAPTER_ID)
        .unwrap();
    assert_eq!(
        fixture_capabilities.adapter_id,
        kaifuu_engine_fixture::FIXTURE_ADAPTER_ID
    );
    assert!(fixture_capabilities.reports.iter().any(|report| {
        report.capability == Capability::LineParityPatching
            && report.status == CapabilityStatus::Limited
    }));
    assert!(fixture_capabilities.access_contract.is_some());
    assert!(
        fixture_capabilities
            .helper_requirements
            .iter()
            .any(|requirement| {
                requirement.helper_registry_id == kaifuu_core::FIXTURE_HELPER_REGISTRY_ID
                    && requirement.allowlist_ref_id == kaifuu_core::FIXTURE_HELPER_ALLOWLIST_REF_ID
                    && requirement
                        .capabilities
                        .contains(&HelperCapability::FixtureInvocation)
            })
    );
    assert!(capabilities.iter().any(|capabilities| {
        capabilities.adapter_id == kaifuu_engine_fixture::XP3_DETECTOR_ADAPTER_ID
            && capabilities.reports.iter().any(|report| {
                report.capability == Capability::Detection
                    && report.status == CapabilityStatus::Supported
            })
    }));

    let detect_path = root.join("detect.json");
    run_cli(&[
        "detect",
        game_dir.to_str().unwrap(),
        "--output",
        detect_path.to_str().unwrap(),
    ]);
    let detection_report: DetectionReport = read_json(&detect_path).unwrap();
    assert_eq!(detection_report.status, DetectionReportStatus::Matched);
    let detection = detection_report
        .detections
        .iter()
        .find(|detection| detection.adapter_id == kaifuu_engine_fixture::FIXTURE_ADAPTER_ID)
        .unwrap();
    assert!(detection.detected);
    assert_eq!(
        detection.adapter_id,
        kaifuu_engine_fixture::FIXTURE_ADAPTER_ID
    );
    assert!(detection.evidence.iter().any(|evidence| {
        evidence.path == "source.json" && evidence.status == EvidenceStatus::Matched
    }));

    let profile_path = root.join("profile.json");
    run_cli(&[
        "profile",
        "init",
        game_dir.to_str().unwrap(),
        "--output",
        profile_path.to_str().unwrap(),
    ]);
    let profile: GameProfile = read_json(&profile_path).unwrap();
    assert_eq!(
        profile.engine.adapter_id,
        kaifuu_engine_fixture::FIXTURE_ADAPTER_ID
    );
    let layered_access = profile.layered_access.as_ref().unwrap();
    assert!(layered_access.surfaces.iter().any(|surface| {
        surface.container == kaifuu_core::ContainerTransform::Identity
            && surface.crypto == kaifuu_core::CryptoTransform::NullKey
            && surface.codec == kaifuu_core::CodecTransform::Identity
    }));
    assert!(profile.requirements.iter().any(|requirement| {
        requirement.category == RequirementCategory::SecretKey
            && requirement.status == RequirementStatus::NotRequired
            && requirement.secret
            && requirement.placeholder.is_none()
    }));

    let validation_path = root.join("profile-validation.json");
    run_cli(&[
        "profile",
        "validate",
        profile_path.to_str().unwrap(),
        "--output",
        validation_path.to_str().unwrap(),
    ]);
    let validation: kaifuu_core::ProfileValidationResult = read_json(&validation_path).unwrap();
    assert_eq!(validation.status, OperationStatus::Passed);

    let bridge_path = root.join("bridge.json");
    run_cli(&[
        "extract",
        game_dir.to_str().unwrap(),
        "--output",
        bridge_path.to_str().unwrap(),
    ]);
    let bridge: BridgeBundle = read_json(&bridge_path).unwrap();
    assert_eq!(bridge.units.len(), 1);

    let patch_export = PatchExport {
        patch_export_id: deterministic_id("patch", 1),
        source_locale: "ja-JP".to_string(),
        target_locale: "en-US".to_string(),
        entries: vec![PatchExportEntry {
            bridge_unit_id: bridge.units[0].bridge_unit_id.clone(),
            source_unit_key: bridge.units[0].source_unit_key.clone(),
            source_hash: bridge.units[0].source_hash.clone(),
            target_text: "Hello, {player}.".to_string(),
            protected_span_mappings: vec![ProtectedSpanMapping::new("{player}", 7, 15)],
        }],
    };
    let patch_export_path = root.join("patch-export.json");
    write_json(&patch_export_path, &patch_export).unwrap();

    let patched_dir = root.join("patched");
    run_cli(&[
        "patch",
        game_dir.to_str().unwrap(),
        "--patch",
        patch_export_path.to_str().unwrap(),
        "--output",
        patched_dir.to_str().unwrap(),
    ]);
    let patch_result: PatchResult = read_json(&patched_dir.join("patch-result.json")).unwrap();
    assert_eq!(patch_result.status, OperationStatus::Passed);
    assert!(
        fs::read_to_string(patched_dir.join("source.json"))
            .unwrap()
            .contains("Hello, {player}.")
    );

    let verify_path = root.join("verify.json");
    run_cli(&[
        "verify",
        patched_dir.to_str().unwrap(),
        "--output",
        verify_path.to_str().unwrap(),
    ]);
    let verify: VerificationResult = read_json(&verify_path).unwrap();
    assert_eq!(verify.status, OperationStatus::Passed);

    let _ = fs::remove_dir_all(root);
}
