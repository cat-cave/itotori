#[test]
fn siglus_detector_reports_missing_pair_and_unknown_variant_diagnostics() {
    let root = temp_dir("siglus-detector-diagnostics");
    let source_fixture =
        public_fixture_path("fixtures/public/kaifuu-encrypted-matrix/raw/siglus/Scene.pck");
    let missing_pair_dir = root.join("missing-pair");
    fs::create_dir_all(&missing_pair_dir).unwrap();
    fs::copy(&source_fixture, missing_pair_dir.join("Scene.pck")).unwrap();

    let missing_pair_detect = root.join("missing-pair-detect.json");
    run_cli(&[
        "detect",
        missing_pair_dir.to_str().unwrap(),
        "--output",
        missing_pair_detect.to_str().unwrap(),
    ]);
    let missing_report: DetectionReport = read_json(&missing_pair_detect).unwrap();
    let missing_siglus = missing_report
        .detections
        .iter()
        .find(|detection| detection.adapter_id == kaifuu_engine_fixture::SIGLUS_DETECTOR_ADAPTER_ID)
        .unwrap();
    assert!(!missing_siglus.detected);
    assert_eq!(
        missing_siglus.detected_variant.as_deref(),
        Some("scene-pck-missing-gameexe-dat")
    );
    assert!(missing_siglus.requirements.iter().any(|requirement| {
        requirement.key == "Gameexe.dat" && requirement.status == RequirementStatus::Missing
    }));

    let missing_profile = root.join("missing-pair-profile.json");
    let missing_profile_error = run_cli_with_registry_result(
        &[
            "profile",
            "init",
            missing_pair_dir.to_str().unwrap(),
            "--output",
            missing_profile.to_str().unwrap(),
        ],
        &engine_registry(),
    )
    .unwrap_err()
    .to_string();
    assert!(missing_profile_error.contains("kaifuu.missing_capability.container"));
    assert!(missing_profile_error.contains("scene-pck-missing-gameexe-dat"));
    assert!(!missing_profile.exists());

    let missing_inventory = root.join("missing-pair-inventory.json");
    let missing_inventory_error = run_cli_with_registry_result(
        &[
            "asset-inventory",
            missing_pair_dir.to_str().unwrap(),
            "--output",
            missing_inventory.to_str().unwrap(),
        ],
        &engine_registry(),
    )
    .unwrap_err()
    .to_string();
    assert!(missing_inventory_error.contains("kaifuu.missing_capability.container"));
    assert!(missing_inventory_error.contains("scene-pck-missing-gameexe-dat"));
    assert!(!missing_inventory.exists());

    let unknown_dir = root.join("unknown-variant");
    fs::create_dir_all(&unknown_dir).unwrap();
    fs::write(
        unknown_dir.join("Scene.pck"),
        b"fixture-only unknown siglus-like scene",
    )
    .unwrap();
    fs::write(
        unknown_dir.join("Gameexe.dat"),
        b"fixture-only unknown siglus-like metadata",
    )
    .unwrap();
    let unknown_detect = root.join("unknown-detect.json");
    run_cli(&[
        "detect",
        unknown_dir.to_str().unwrap(),
        "--output",
        unknown_detect.to_str().unwrap(),
    ]);
    let report: DetectionReport = read_json(&unknown_detect).unwrap();
    let siglus = report
        .detections
        .iter()
        .find(|detection| detection.adapter_id == kaifuu_engine_fixture::SIGLUS_DETECTOR_ADAPTER_ID)
        .unwrap();
    assert!(!siglus.detected);
    assert_eq!(
        siglus.detected_variant.as_deref(),
        Some("unknown-siglus-named-files")
    );
    assert!(siglus.requirements.iter().any(|requirement| {
        requirement.key == "siglus-synthetic-signature"
            && requirement.status == RequirementStatus::Unsupported
    }));

    let unknown_profile = root.join("unknown-variant-profile.json");
    let unknown_profile_error = run_cli_with_registry_result(
        &[
            "profile",
            "init",
            unknown_dir.to_str().unwrap(),
            "--output",
            unknown_profile.to_str().unwrap(),
        ],
        &engine_registry(),
    )
    .unwrap_err()
    .to_string();
    assert!(unknown_profile_error.contains("kaifuu.unknown_engine_variant"));
    assert!(unknown_profile_error.contains("unknown-siglus-named-files"));
    assert!(!unknown_profile.exists());

    let unknown_inventory = root.join("unknown-variant-inventory.json");
    let unknown_inventory_error = run_cli_with_registry_result(
        &[
            "asset-inventory",
            unknown_dir.to_str().unwrap(),
            "--output",
            unknown_inventory.to_str().unwrap(),
        ],
        &engine_registry(),
    )
    .unwrap_err()
    .to_string();
    assert!(unknown_inventory_error.contains("kaifuu.unknown_engine_variant"));
    assert!(unknown_inventory_error.contains("unknown-siglus-named-files"));
    assert!(!unknown_inventory.exists());

    let generic_dir = root.join("unrecognized");
    fs::create_dir_all(&generic_dir).unwrap();
    let generic_profile = root.join("generic-profile.json");
    let generic_profile_error = run_cli_with_registry_result(
        &[
            "profile",
            "init",
            generic_dir.to_str().unwrap(),
            "--output",
            generic_profile.to_str().unwrap(),
        ],
        &engine_registry(),
    )
    .unwrap_err()
    .to_string();
    assert!(generic_profile_error.contains("no registered adapter detected"));

    let generic_inventory = root.join("generic-inventory.json");
    let generic_inventory_error = run_cli_with_registry_result(
        &[
            "asset-inventory",
            generic_dir.to_str().unwrap(),
            "--output",
            generic_inventory.to_str().unwrap(),
        ],
        &engine_registry(),
    )
    .unwrap_err()
    .to_string();
    assert!(generic_inventory_error.contains("no registered adapter detected"));

    let _ = fs::remove_dir_all(root);
}

/// P1: variant string without adapter opt-in must stay on the
/// partial / no-adapter path; profile and inventory must never run.
#[test]
fn undetected_variant_without_diagnostic_opt_in_never_invokes_profile_or_inventory() {
    const ADAPTER_ID: &str = "kaifuu.test.variant-only-no-opt-in";

    struct VariantOnlyNoOptInAdapter {
        calls: Rc<RefCell<Vec<&'static str>>>,
    }

    impl VariantOnlyNoOptInAdapter {
        fn record(&self, call: &'static str) {
            self.calls.borrow_mut().push(call);
        }
    }

    impl EngineAdapter for VariantOnlyNoOptInAdapter {
        fn id(&self) -> &'static str {
            ADAPTER_ID
        }

        fn name(&self) -> &'static str {
            "Variant-only adapter without diagnostic opt-in"
        }

        fn capabilities(&self) -> AdapterCapabilities {
            AdapterCapabilities::new(
                ADAPTER_ID,
                vec![
                    CapabilityReport::supported(Capability::Detection),
                    CapabilityReport::supported(Capability::ProfileGeneration),
                    CapabilityReport::supported(Capability::AssetInventory),
                ],
                AdapterCapabilityMatrix::identify_only(
                    ADAPTER_ID,
                    "test adapter is identify-only decoy",
                ),
            )
        }

        fn detect(&self, request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
            self.record("detect");
            Ok(DetectionResult {
                adapter_id: ADAPTER_ID.to_string(),
                detected: false,
                engine_family: Some("decoy".to_string()),
                engine_version: None,
                detected_variant: Some("looks-like-mine".to_string()),
                evidence: vec![DetectionEvidence {
                    path: request.game_dir.display().to_string(),
                    kind: "variant_only_marker".to_string(),
                    status: EvidenceStatus::Matched,
                    detail: "undetected adapter with a descriptive variant".to_string(),
                }],
                requirements: vec![],
                capabilities: self.capabilities().reports,
            })
        }

        // Default is_diagnostic_candidate → false.

        fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
            self.record("profile");
            panic!("profile must not run without diagnostic opt-in");
        }

        fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
            self.record("list_assets");
            unreachable!("list_assets must not run")
        }

        fn asset_inventory(
            &self,
            _request: AssetInventoryRequest<'_>,
        ) -> KaifuuResult<AssetInventoryManifest> {
            self.record("asset_inventory");
            panic!("asset_inventory must not run without diagnostic opt-in");
        }

        fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
            self.record("extract");
            unreachable!("extract must not run")
        }

        fn patch(&self, _request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
            self.record("patch");
            unreachable!("patch must not run")
        }

        fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
            self.record("verify");
            unreachable!("verify must not run")
        }
    }

    let calls = Rc::new(RefCell::new(Vec::new()));
    let mut registry = AdapterRegistry::new();
    registry.register(VariantOnlyNoOptInAdapter {
        calls: Rc::clone(&calls),
    });

    let root = temp_dir("variant-only-no-opt-in");
    let game_dir = root.join("game");
    fs::create_dir_all(&game_dir).unwrap();

    // Registry selection refuses the decoy.
    let detections = registry.detect_all(&game_dir).unwrap();
    assert!(
        registry
            .diagnostic_candidate_from_results(&detections)
            .is_none()
    );

    // Profile: matched evidence without opt-in takes the partial path —
    // never Diagnostic, never adapter.profile.
    let profile_out = root.join("profile.json");
    run_cli_with_registry(
        &[
            "profile",
            "init",
            game_dir.to_str().unwrap(),
            "--output",
            profile_out.to_str().unwrap(),
        ],
        &registry,
    );
    let profile_report: serde_json::Value = read_json(&profile_out).unwrap();
    assert_eq!(
        profile_report["partial"].as_bool(),
        Some(true),
        "must stay on partial path, not diagnostic profile route: {profile_report}"
    );
    assert_eq!(
        profile_report["detected"].as_bool(),
        Some(false),
        "partial report must not claim full detection: {profile_report}"
    );
    assert_eq!(
        profile_report["command"].as_str(),
        Some("profile"),
        "partial envelope command must be profile: {profile_report}"
    );
    // Full GameProfile carries schemaVersion 0.1.0 + engine.adapterId;
    // partial reports never carry an engine block.
    assert!(
        profile_report.get("engine").is_none(),
        "must not emit a full profile for the decoy adapter: {profile_report}"
    );

    // Inventory: partial gate falls through to registered_adapter_for_game,
    // which requires detected=true → hard error; inventory must not run.
    let inventory_out = root.join("inventory.json");
    let inventory_error = run_cli_with_registry_result(
        &[
            "asset-inventory",
            game_dir.to_str().unwrap(),
            "--output",
            inventory_out.to_str().unwrap(),
        ],
        &registry,
    )
    .unwrap_err()
    .to_string();
    assert!(
        inventory_error.contains("no registered adapter detected"),
        "unexpected inventory error: {inventory_error}"
    );
    assert!(!inventory_out.exists());

    let recorded = calls.borrow().clone();
    assert!(
        recorded
            .iter()
            .all(|call| *call == "detect" || *call == "capabilities"),
        "profile/inventory must never be invoked; calls={recorded:?}"
    );
    assert!(
        !recorded
            .iter()
            .any(|call| *call == "profile" || *call == "asset_inventory"),
        "profile/inventory must never be invoked; calls={recorded:?}"
    );

    let _ = fs::remove_dir_all(root);
}
