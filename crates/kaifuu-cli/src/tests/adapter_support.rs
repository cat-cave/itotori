fn write_apply_delta(root: &Path) -> (PathBuf, PathBuf) {
    let game_dir = temp_game(root);
    let patched_dir = root.join("patched");
    fs::create_dir_all(&patched_dir).unwrap();
    write_fixture_file(
        &patched_dir,
        "source.json",
        br#"{"units":[{"targetText":"Hello, {player}."}]}"#,
    );

    let delta_path = root.join("hello.kaifuu");
    run_cli(&[
        "diff",
        game_dir.to_str().unwrap(),
        patched_dir.to_str().unwrap(),
        "--output",
        delta_path.to_str().unwrap(),
    ]);
    (game_dir, delta_path)
}

fn test_capabilities() -> AdapterCapabilities {
    AdapterCapabilities::new(
        TEST_ADAPTER_ID,
        vec![
            CapabilityReport::supported(Capability::Detection),
            CapabilityReport::supported(Capability::Extraction),
            CapabilityReport::supported(Capability::Patching),
            CapabilityReport::supported(Capability::Verification),
            CapabilityReport::supported(Capability::AssetListing),
            CapabilityReport::supported(Capability::AssetInventory),
            CapabilityReport::supported(Capability::NonTextSurfaceExtraction),
            CapabilityReport::supported(Capability::ProfileGeneration),
        ],
        // full-rung matrix mirrors the per-Capability
        // reports above; declared explicitly so the registry gate
        // sees a Supported claim at every rung.
        AdapterCapabilityMatrix::up_to(
            TEST_ADAPTER_ID,
            kaifuu_core::CapabilityLevel::Patch,
            "test capabilities cover every rung",
        ),
    )
}

struct RecordingAdapter {
    calls: Rc<RefCell<Vec<&'static str>>>,
}

impl RecordingAdapter {
    fn record(&self, call: &'static str) {
        self.calls.borrow_mut().push(call);
    }

    fn profile_result(&self) -> GameProfile {
        let mut profile = GameProfile {
            schema_version: "0.1.0".to_string(),
            profile_id: deterministic_id("profile", 98),
            game_id: "registry-dispatch-game".to_string(),
            title: "Registry Dispatch Game".to_string(),
            source_locale: "en-US".to_string(),
            engine: EngineProfile {
                adapter_id: TEST_ADAPTER_ID.to_string(),
                engine_family: "registry-test".to_string(),
                engine_version: Some("9.9.9".to_string()),
                detected_variant: "injected-adapter".to_string(),
            },
            source_fingerprint: None,
            key_requirements: vec![],
            archive_parameters: vec![],
            helper_evidence: None,
            assets: vec![AssetProfile {
                asset_id: deterministic_id("asset", 98),
                path: "registry.txt".to_string(),
                asset_kind: AssetKind::Script,
                text_surfaces: vec![TextSurface::Dialogue],
                source_hash: Some("registry-source-hash".to_string()),
                patching: CapabilityReport::supported(Capability::Patching),
            }],
            layered_access: None,
            capabilities: test_capabilities().reports,
            requirements: vec![],
            metadata: std::collections::BTreeMap::new(),
        };
        profile.normalize();
        profile
    }
}

impl EngineAdapter for RecordingAdapter {
    fn id(&self) -> &'static str {
        TEST_ADAPTER_ID
    }

    fn name(&self) -> &'static str {
        "Kaifuu registry dispatch test adapter"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        self.record("capabilities");
        test_capabilities()
    }

    fn detect(&self, request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
        self.record("detect");
        Ok(DetectionResult {
            adapter_id: TEST_ADAPTER_ID.to_string(),
            detected: true,
            engine_family: Some("registry-test".to_string()),
            engine_version: Some("9.9.9".to_string()),
            detected_variant: Some("injected-adapter".to_string()),
            evidence: vec![DetectionEvidence {
                path: request.game_dir.display().to_string(),
                kind: "injected_registry".to_string(),
                status: EvidenceStatus::Matched,
                detail: "custom registry adapter was called".to_string(),
            }],
            requirements: vec![ProfileRequirement {
                category: RequirementCategory::SecretKey,
                key: "test_key".to_string(),
                status: RequirementStatus::NotRequired,
                description: "test adapter does not need secrets".to_string(),
                placeholder: None,
                secret: true,
            }],
            capabilities: test_capabilities().reports,
        })
    }

    fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
        self.record("profile");
        Ok(self.profile_result())
    }

    fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
        self.record("list_assets");
        Ok(AssetList {
            adapter_id: TEST_ADAPTER_ID.to_string(),
            assets: vec![],
        })
    }

    fn asset_inventory(
        &self,
        _request: AssetInventoryRequest<'_>,
    ) -> KaifuuResult<AssetInventoryManifest> {
        self.record("asset_inventory");
        let mut metadata = BTreeMap::new();
        metadata.insert(
            "supportBoundary".to_string(),
            "registry test asset inventory".to_string(),
        );
        let mut manifest = AssetInventoryManifest {
            schema_version: ASSET_INVENTORY_SCHEMA_VERSION.to_string(),
            manifest_id: deterministic_id("asset-inventory", 98),
            adapter_id: TEST_ADAPTER_ID.to_string(),
            source_locale: "en-US".to_string(),
            assets: vec![AssetInventoryAsset {
                asset_id: "registry-image".to_string(),
                asset_key: "image/registry".to_string(),
                asset_kind: AssetInventoryAssetKind::Image,
                path: Some("registry/image.png".to_string()),
                source_hash: Some(content_hash("registry-image")),
                metadata: BTreeMap::new(),
            }],
            surfaces: vec![AssetInventorySurface {
                surface_id: "registry-image-text".to_string(),
                asset_surface_kind: AssetInventorySurfaceKind::ImageText,
                source_asset_ref: AssetInventoryAssetRef {
                    asset_id: "registry-image".to_string(),
                    asset_key: Some("image/registry".to_string()),
                },
                source_location: None,
                source_text: Some("Registry".to_string()),
                source_hash: Some(content_hash("Registry")),
                text_source_kind: AssetInventoryTextSourceKind::ManualTranscription,
                patch_mode: AssetInventoryPatchMode::Unsupported,
                patching: CapabilityReport::unsupported(
                    Capability::AssetTextPatching,
                    "registry test adapter does not patch image assets",
                ),
                patch_payload: None,
                metadata_hash: None,
                notes: vec![],
            }],
            capabilities: test_capabilities().reports,
            warnings: vec![],
            metadata,
        };
        manifest.normalize();
        Ok(manifest)
    }

    fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
        self.record("extract");
        Ok(ExtractionResult {
            adapter_id: TEST_ADAPTER_ID.to_string(),
            profile: self.profile_result(),
            bridge: BridgeBundle {
                schema_version: "0.1.0".to_string(),
                bridge_id: deterministic_id("bridge", 98),
                source_bundle_hash: "registry-bundle-hash".to_string(),
                source_locale: "en-US".to_string(),
                extractor_name: "registry-test-extractor".to_string(),
                extractor_version: "9.9.9".to_string(),
                units: vec![BridgeUnit {
                    bridge_unit_id: deterministic_id("bridge-unit", 98),
                    source_unit_key: "registry.unit.001".to_string(),
                    occurrence_id: "registry-occurrence-001".to_string(),
                    source_hash: "registry-source-hash".to_string(),
                    source_locale: "en-US".to_string(),
                    source_text: "Registry source".to_string(),
                    speaker: "Registry".to_string(),
                    text_surface: "dialogue".to_string(),
                    protected_spans: vec![],
                    patch_ref: PatchRef {
                        asset_id: "registry.txt".to_string(),
                        write_mode: "replace".to_string(),
                        source_unit_key: "registry.unit.001".to_string(),
                    },
                }],
            },
            warnings: Vec::<AdapterWarning>::new(),
        })
    }

    fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
        self.record("patch");
        fs::create_dir_all(request.output_dir)?;
        fs::write(
            request.output_dir.join("registry-adapter-called.txt"),
            "patch\n",
        )?;
        Ok(PatchResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("patch-result", 98),
            patch_export_id: request.patch_export.patch_export_id.clone(),
            status: OperationStatus::Passed,
            output_hash: "registry-patch-output".to_string(),
            failures: vec![],
        })
    }

    fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
        self.record("verify");
        Ok(VerificationResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("verify", 98),
            status: OperationStatus::Passed,
            output_hash: "registry-verify-output".to_string(),
            failures: vec![],
        })
    }
}

fn recording_registry(calls: Rc<RefCell<Vec<&'static str>>>) -> AdapterRegistry {
    let mut registry = AdapterRegistry::new();
    registry.register(RecordingAdapter { calls });
    registry
}
