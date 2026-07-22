#[test]
fn xp3_detector_profile_fixture_reports_variant_profiles_and_unknown_diagnostics() {
    let root = temp_dir("public-xp3-detector");
    let fixture_root = public_fixture_path("fixtures/public/kaifuu-encrypted-matrix");
    let expected_root = fixture_root.join("expected");

    for (variant, expected_name) in [
        ("plain", "xp3-plain-detector-profile-v0.1.json"),
        ("encrypted", "xp3-encrypted-detector-profile-v0.1.json"),
        ("compressed", "xp3-compressed-detector-profile-v0.1.json"),
    ] {
        let game_dir = fixture_root.join("xp3-profiles").join(variant);
        let profile_path = root.join(format!("xp3-{variant}-profile.json"));
        run_cli(&[
            "profile",
            "init",
            game_dir.to_str().unwrap(),
            "--output",
            profile_path.to_str().unwrap(),
        ]);
        let actual_profile: serde_json::Value = read_json(&profile_path).unwrap();
        let expected_profile: serde_json::Value =
            read_json(&expected_root.join(expected_name)).unwrap();
        assert_eq!(actual_profile, expected_profile);

        let profile: GameProfile = serde_json::from_value(actual_profile).unwrap();
        assert_eq!(
            profile.engine.adapter_id,
            kaifuu_engine_fixture::XP3_DETECTOR_ADAPTER_ID
        );
        assert_eq!(profile.validate().status, OperationStatus::Passed);
        assert!(profile.capabilities.iter().any(|capability| {
            capability.capability == Capability::Extraction
                && capability.status == CapabilityStatus::Unsupported
        }));
        if variant == "encrypted" {
            assert_eq!(profile.key_requirements.len(), 1);
            assert!(
                profile
                    .layered_access
                    .as_ref()
                    .unwrap()
                    .surfaces
                    .iter()
                    .any(|surface| surface.key_requirement_refs
                        == vec!["kirikiri-xp3-key-profile".to_string()])
            );
        }
        if variant == "compressed" {
            assert!(profile.archive_parameters.iter().any(|parameter| {
                parameter.kind == kaifuu_core::ArchiveParameterKind::Compression
                    && parameter.value == "compressed"
            }));
        }
    }

    let unknown_dir = fixture_root.join("xp3-profiles/unknown");
    let detect_path = root.join("xp3-unknown-detect.json");
    run_cli(&[
        "detect",
        unknown_dir.to_str().unwrap(),
        "--output",
        detect_path.to_str().unwrap(),
    ]);
    let actual_detection: serde_json::Value = read_json(&detect_path).unwrap();
    let expected_detection: serde_json::Value =
        read_json(&expected_root.join("xp3-unknown-detection-report-v0.1.json")).unwrap();
    assert_eq!(
        without_bgi_detection(actual_detection.clone()),
        expected_detection
    );
    let detection_report: DetectionReport = serde_json::from_value(actual_detection).unwrap();
    assert_eq!(detection_report.status, DetectionReportStatus::Unknown);
    let xp3_detection = detection_report
        .detections
        .iter()
        .find(|detection| detection.adapter_id == kaifuu_engine_fixture::XP3_DETECTOR_ADAPTER_ID)
        .unwrap();
    assert!(!xp3_detection.detected);
    assert_eq!(
        xp3_detection.detected_variant.as_deref(),
        Some("xp3-unknown-container")
    );
    let xp3_archive = detection_report
        .archive_detection
        .rows
        .iter()
        .find(|row| row.row_id == "kirikiri-xp3")
        .unwrap();
    assert!(
        xp3_archive
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == SemanticErrorCode::UnknownEngineVariant)
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn detect_cli_reports_reallive_adapter_on_synthetic_fixture() {
    let root = temp_dir("public-reallive-detect-positive");
    let game_dir =
        public_fixture_path("fixtures/public/reallive-detector/positive-synthetic-triple");
    let expected_path = game_dir.join("expected/detection-report.json");
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
    let reallive_detection = detection_report
        .detections
        .iter()
        .find(|detection| {
            detection.adapter_id == kaifuu_engine_fixture::REALLIVE_DETECTOR_ADAPTER_ID
        })
        .unwrap();
    assert!(reallive_detection.detected);
    assert_eq!(
        reallive_detection.engine_family.as_deref(),
        Some("reallive")
    );
    assert_eq!(
        reallive_detection.detected_variant.as_deref(),
        Some("reallive-synthetic-triple")
    );
}

#[test]
fn detect_cli_emits_archive_detection_matrix_reallive_row_with_aggregate_evidence_only() {
    let root = temp_dir("public-reallive-detect-matrix-row");
    let game_dir =
        public_fixture_path("fixtures/public/reallive-detector/positive-synthetic-triple");
    let detect_path = root.join("detect.json");

    run_cli(&[
        "detect",
        game_dir.to_str().unwrap(),
        "--output",
        detect_path.to_str().unwrap(),
    ]);

    let detection_report: DetectionReport = read_json(&detect_path).unwrap();
    let reallive_row = detection_report
        .archive_detection
        .rows
        .iter()
        .find(|row| row.row_id == "reallive-seen-txt")
        .expect("RealLive matrix row missing");
    assert!(reallive_row.detected);
    assert_eq!(reallive_row.detected_variant, "reallive-seen-txt-archive");
    assert!(reallive_row.capabilities.iter().any(|capability| {
        capability.capability == Capability::Extraction
            && capability.status == CapabilityStatus::Unsupported
    }));
    assert!(reallive_row.capabilities.iter().any(|capability| {
        capability.capability == Capability::Patching
            && capability.status == CapabilityStatus::Unsupported
    }));
}

#[test]
fn detect_cli_emits_ambiguous_engine_variant_diagnostic_when_reallive_and_siglus_markers_co_present()
 {
    let root = temp_dir("public-reallive-detect-ambiguous");
    let game_dir = public_fixture_path("fixtures/public/reallive-detector/negative-siglus-overlap");
    let detect_path = root.join("detect.json");

    run_cli(&[
        "detect",
        game_dir.to_str().unwrap(),
        "--output",
        detect_path.to_str().unwrap(),
    ]);

    let detection_report: DetectionReport = read_json(&detect_path).unwrap();
    let reallive_detection = detection_report
        .detections
        .iter()
        .find(|detection| {
            detection.adapter_id == kaifuu_engine_fixture::REALLIVE_DETECTOR_ADAPTER_ID
        })
        .unwrap();
    assert!(!reallive_detection.detected);
    assert_eq!(
        reallive_detection.detected_variant.as_deref(),
        Some("ambiguous-reallive-siglus-overlap")
    );
    let reallive_row = detection_report
        .archive_detection
        .rows
        .iter()
        .find(|row| row.row_id == "reallive-seen-txt")
        .expect("RealLive matrix row missing");
    assert!(
        reallive_row
            .diagnostics
            .iter()
            .any(|diagnostic| { diagnostic.code == SemanticErrorCode::AmbiguousEngineVariant })
    );
}

#[test]
fn capabilities_cli_lists_reallive_adapter_with_kaifuu_174_inventory_support_boundary() {
    let root = temp_dir("public-reallive-capabilities");
    let capabilities_path = root.join("capabilities.json");
    run_cli(&[
        "capabilities",
        "--output",
        capabilities_path.to_str().unwrap(),
    ]);
    let capabilities: Vec<AdapterCapabilities> = read_json(&capabilities_path).unwrap();
    let reallive_caps = capabilities
        .iter()
        .find(|caps| caps.adapter_id == kaifuu_engine_fixture::REALLIVE_DETECTOR_ADAPTER_ID)
        .expect("RealLive adapter missing from capabilities output");
    for required in [
        Capability::Detection,
        Capability::ProfileGeneration,
        Capability::AssetListing,
        Capability::AssetInventory,
        Capability::Extraction,
        Capability::ContainerAccess,
        Capability::CodecAccess,
        Capability::PatchBack,
    ] {
        assert!(
            reallive_caps.reports.iter().any(|report| {
                report.capability == required && report.status == CapabilityStatus::Supported
            }),
            "RealLive adapter missing supported {required:?}"
        );
    }
    for unsupported in [Capability::RuntimeVm, Capability::EncryptedInput] {
        assert!(
            reallive_caps.reports.iter().any(|report| {
                report.capability == unsupported && report.status == CapabilityStatus::Unsupported
            }),
            "RealLive adapter missing unsupported {unsupported:?}"
        );
    }
    // Patching is Limited per (§3.3): length-changing Scene/SEEN
    // text-slot replacement, but limited to one scene-scoped bundle per
    // call and to the configured text scope (not image-overlaid.g00 text).
    assert!(
        reallive_caps.reports.iter().any(|report| {
            report.capability == Capability::Patching && report.status == CapabilityStatus::Limited
        }),
        "RealLive adapter must report Patching as Limited for length-changing single-scene text-slot replacement"
    );
    // Field PR #2: typed level matrix must not under-detect real patch.
    assert!(
        reallive_caps.level_matrix.patch.is_partial(),
        "RealLive level matrix must expose partial Patch for length-changing single-scene patch-back"
    );
}

#[test]
fn xp3_inventory_cli_reports_plain_file_table_separately_from_extract_and_patch() {
    let root = temp_dir("xp3-inventory-cli");
    let game_dir = root.join("game");
    fs::create_dir_all(&game_dir).unwrap();
    fs::write(
        game_dir.join("data.xp3"),
        plain_xp3_fixture(&[
            Xp3TestEntry {
                path: "scenario/intro.ks",
                payload: b"plain text payload",
                compressed: false,
                adler32: 0x0102_0304,
            },
            Xp3TestEntry {
                path: "image/title.png",
                payload: b"compressed-image-bytes",
                compressed: true,
                adler32: 0x0506_0708,
            },
        ]),
    )
    .unwrap();
    let inventory_path = root.join("inventory.json");

    run_cli(&[
        "asset-inventory",
        game_dir.to_str().unwrap(),
        "--output",
        inventory_path.to_str().unwrap(),
    ]);

    let inventory: AssetInventoryManifest = read_json(&inventory_path).unwrap();
    assert_eq!(
        inventory.adapter_id,
        kaifuu_engine_fixture::XP3_DETECTOR_ADAPTER_ID
    );
    assert_eq!(inventory.validate().status, OperationStatus::Passed);
    assert!(inventory.capabilities.iter().any(|capability| {
        capability.capability == Capability::AssetInventory
            && capability.status == CapabilityStatus::Supported
    }));
    assert!(inventory.capabilities.iter().any(|capability| {
        capability.capability == Capability::Extraction
            && capability.status == CapabilityStatus::Unsupported
    }));
    assert!(inventory.capabilities.iter().any(|capability| {
        capability.capability == Capability::Patching
            && capability.status == CapabilityStatus::Unsupported
    }));

    let script = inventory
        .assets
        .iter()
        .find(|asset| asset.asset_key == "scenario/intro.ks")
        .unwrap();
    let script_hash = sha256_hash_bytes(b"plain text payload");
    assert_eq!(script.source_hash.as_deref(), Some(script_hash.as_str()));
    assert_eq!(
        script.metadata.get("profileId").map(String::as_str),
        Some("019ed000-0000-7000-8000-000000095001")
    );
    assert_eq!(
        script.metadata.get("compressed").map(String::as_str),
        Some("false")
    );

    let image = inventory
        .assets
        .iter()
        .find(|asset| asset.asset_key == "image/title.png")
        .unwrap();
    assert_eq!(image.asset_kind, AssetInventoryAssetKind::Image);
    assert_eq!(
        image.metadata.get("compressed").map(String::as_str),
        Some("true")
    );
    assert_eq!(
        image.metadata.get("storedAdler32").map(String::as_str),
        Some("adler32:05060708")
    );

    let _ = fs::remove_dir_all(root);
}
