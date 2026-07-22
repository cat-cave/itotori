fn golden_boundary_profile(adapter_id: &str) -> GameProfile {
    GameProfile {
        schema_version: PROFILE_SCHEMA_VERSION.to_string(),
        profile_id: deterministic_id("profile", 91),
        game_id: "golden-boundary-fixture".to_string(),
        title: "Golden Boundary Fixture".to_string(),
        source_locale: "ja-JP".to_string(),
        engine: EngineProfile {
            adapter_id: adapter_id.to_string(),
            engine_family: "fixture".to_string(),
            engine_version: None,
            detected_variant: "preflight-boundary".to_string(),
        },
        source_fingerprint: None,
        key_requirements: vec![],
        archive_parameters: vec![],
        helper_evidence: None,
        assets: vec![AssetProfile {
            asset_id: deterministic_id("asset", 91),
            path: "source.json".to_string(),
            asset_kind: AssetKind::Script,
            text_surfaces: vec![TextSurface::Dialogue],
            source_hash: Some(content_hash("こんにちは")),
            patching: CapabilityReport::supported(Capability::Patching),
        }],
        layered_access: None,
        capabilities: vec![
            CapabilityReport::supported(Capability::Detection),
            CapabilityReport::supported(Capability::Extraction),
            CapabilityReport::supported(Capability::Patching),
            CapabilityReport::supported(Capability::Verification),
        ],
        requirements: vec![],
        metadata: BTreeMap::new(),
    }
}

fn golden_boundary_extraction(adapter_id: &str) -> ExtractionResult {
    let source_unit_key = "scene.001.line.001".to_string();
    ExtractionResult {
        adapter_id: adapter_id.to_string(),
        profile: golden_boundary_profile(adapter_id),
        bridge: BridgeBundle {
            schema_version: PROFILE_SCHEMA_VERSION.to_string(),
            bridge_id: deterministic_id("bridge", 91),
            source_bundle_hash: content_hash("こんにちは"),
            source_locale: "ja-JP".to_string(),
            extractor_name: "golden-boundary-test".to_string(),
            extractor_version: "0.0.0".to_string(),
            units: vec![BridgeUnit {
                bridge_unit_id: deterministic_id("bridge-unit", 91),
                source_unit_key: source_unit_key.clone(),
                occurrence_id: "scene.001.line.001#1".to_string(),
                source_hash: content_hash("こんにちは"),
                source_locale: "ja-JP".to_string(),
                source_text: "こんにちは".to_string(),
                speaker: "Narrator".to_string(),
                text_surface: "dialogue".to_string(),
                protected_spans: vec![],
                patch_ref: PatchRef {
                    asset_id: deterministic_id("asset", 91),
                    write_mode: "replace_text".to_string(),
                    source_unit_key,
                },
            }],
        },
        warnings: vec![],
    }
}

fn golden_boundary_patch_export(patch_export_id: impl Into<String>) -> PatchExport {
    PatchExport {
        patch_export_id: patch_export_id.into(),
        source_locale: "ja-JP".to_string(),
        target_locale: "en-US".to_string(),
        entries: vec![PatchExportEntry {
            bridge_unit_id: deterministic_id("bridge-unit", 91),
            source_unit_key: "scene.001.line.001".to_string(),
            source_hash: content_hash("こんにちは"),
            target_text: "Hello.".to_string(),
            protected_span_mappings: vec![],
        }],
    }
}

// test adapters + fixtures proving the golden harness drives asset
// assertions off adapter INVENTORY + CAPABILITY data rather than a fixture
// `source.json` layout.

const INVENTORY_GOLDEN_ID: &str = "kaifuu.inventory-golden";
const INVENTORY_SCENE_ASSET: &str = "scene.dat";
const INVENTORY_LOGO_ASSET: &str = "art/logo.dat";
const INVENTORY_LOGO_ASSET_ID: &str = "asset-art-logo";
const INVENTORY_LOGO_BOUNDARY: &str = "inventory-golden adapter reports the logo art surface but cannot redraw or replace binary art assets";

fn write_file_all(base: &Path, relative: &str, bytes: &[u8]) {
    let path = base.join(relative);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, bytes).unwrap();
}

/// A NON-`source.json` game layout: a `scene.dat` script asset the adapter can
/// edit plus an `art/logo.dat` binary asset it reports as capability-unsupported.
fn inventory_golden_game(name: &str) -> PathBuf {
    let dir = temp_dir(name);
    write_file_all(&dir, INVENTORY_SCENE_ASSET, b"scene bytes v1");
    write_file_all(&dir, INVENTORY_LOGO_ASSET, b"logo binary bytes");
    dir
}

struct InventoryGoldenAdapter {
    /// When true, the unchanged patch corrupts the capability-unsupported
    /// `art/logo.dat` asset so the adapter-neutral preservation check flags it.
    mutate_unsupported_asset: bool,
}

impl InventoryGoldenAdapter {
    fn asset_hash(game_dir: &Path, relative: &str) -> Option<String> {
        fs::read(game_dir.join(relative))
            .ok()
            .map(|bytes| content_hash(&String::from_utf8_lossy(&bytes)))
    }
}

impl EngineAdapter for InventoryGoldenAdapter {
    fn id(&self) -> &'static str {
        INVENTORY_GOLDEN_ID
    }

    fn name(&self) -> &'static str {
        "Inventory Golden"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        let reports = vec![
            CapabilityReport::supported(Capability::Detection),
            CapabilityReport::supported(Capability::Extraction),
            CapabilityReport::supported(Capability::Patching),
            CapabilityReport::supported(Capability::Verification),
            CapabilityReport::supported(Capability::AssetInventory),
            CapabilityReport::unsupported(
                Capability::NonTextSurfaceExtraction,
                "cannot patch binary art surfaces",
            ),
        ];
        let matrix = AdapterCapabilityMatrix::derive_from_reports(self.id(), &reports);
        AdapterCapabilities::new(self.id(), reports, matrix)
    }

    fn detect(&self, _request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
        Ok(DetectionResult {
            adapter_id: self.id().to_string(),
            detected: true,
            engine_family: Some("fixture".to_string()),
            engine_version: None,
            detected_variant: Some("inventory-golden".to_string()),
            evidence: vec![],
            requirements: vec![],
            capabilities: self.capabilities().reports,
        })
    }

    fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
        Ok(golden_boundary_profile(self.id()))
    }

    fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
        Ok(AssetList {
            adapter_id: self.id().to_string(),
            assets: vec![],
        })
    }

    fn asset_inventory(
        &self,
        request: AssetInventoryRequest<'_>,
    ) -> KaifuuResult<AssetInventoryManifest> {
        let mut manifest = AssetInventoryManifest {
            schema_version: ASSET_INVENTORY_SCHEMA_VERSION.to_string(),
            manifest_id: deterministic_id("inventory-golden", 1),
            adapter_id: self.id().to_string(),
            source_locale: "ja-JP".to_string(),
            assets: vec![
                AssetInventoryAsset {
                    asset_id: "asset-scene".to_string(),
                    asset_key: "scene/main".to_string(),
                    asset_kind: AssetInventoryAssetKind::Script,
                    path: Some(INVENTORY_SCENE_ASSET.to_string()),
                    source_hash: Self::asset_hash(request.game_dir, INVENTORY_SCENE_ASSET),
                    metadata: BTreeMap::new(),
                },
                AssetInventoryAsset {
                    asset_id: INVENTORY_LOGO_ASSET_ID.to_string(),
                    asset_key: "art/logo".to_string(),
                    asset_kind: AssetInventoryAssetKind::Image,
                    path: Some(INVENTORY_LOGO_ASSET.to_string()),
                    source_hash: Self::asset_hash(request.game_dir, INVENTORY_LOGO_ASSET),
                    metadata: BTreeMap::new(),
                },
            ],
            surfaces: vec![AssetInventorySurface {
                surface_id: "surface-art-logo".to_string(),
                asset_surface_kind: AssetInventorySurfaceKind::UiArt,
                source_asset_ref: AssetInventoryAssetRef {
                    asset_id: INVENTORY_LOGO_ASSET_ID.to_string(),
                    asset_key: Some("art/logo".to_string()),
                },
                source_location: None,
                source_text: None,
                source_hash: Self::asset_hash(request.game_dir, INVENTORY_LOGO_ASSET),
                text_source_kind: AssetInventoryTextSourceKind::NotApplicable,
                patch_mode: AssetInventoryPatchMode::AssetReplacementRequired,
                patching: CapabilityReport::unsupported(
                    Capability::NonTextSurfaceExtraction,
                    INVENTORY_LOGO_BOUNDARY,
                ),
                patch_payload: None,
                metadata_hash: None,
                notes: vec![],
            }],
            capabilities: self.capabilities().reports,
            warnings: vec![],
            metadata: BTreeMap::new(),
        };
        manifest.normalize();
        Ok(manifest)
    }

    fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
        Ok(ExtractionResult {
            adapter_id: self.id().to_string(),
            profile: golden_boundary_profile(self.id()),
            bridge: BridgeBundle {
                schema_version: PROFILE_SCHEMA_VERSION.to_string(),
                bridge_id: deterministic_id("inventory-golden-bridge", 1),
                source_bundle_hash: content_hash("inventory-golden"),
                source_locale: "ja-JP".to_string(),
                extractor_name: "inventory-golden-test".to_string(),
                extractor_version: "0.0.0".to_string(),
                units: vec![],
            },
            warnings: vec![],
        })
    }

    fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
        // Identity round-trip: copy the editable script asset byte-for-byte.
        let scene = fs::read(request.game_dir.join(INVENTORY_SCENE_ASSET))?;
        write_file_all(request.output_dir, INVENTORY_SCENE_ASSET, &scene);
        // The capability-unsupported asset must be passed through unchanged;
        // the mutating variant deliberately corrupts it.
        if self.mutate_unsupported_asset {
            write_file_all(
                request.output_dir,
                INVENTORY_LOGO_ASSET,
                b"corrupted logo bytes",
            );
        } else {
            let logo = fs::read(request.game_dir.join(INVENTORY_LOGO_ASSET))?;
            write_file_all(request.output_dir, INVENTORY_LOGO_ASSET, &logo);
        }
        Ok(PatchResult {
            schema_version: PROFILE_SCHEMA_VERSION.to_string(),
            patch_result_id: deterministic_id("inventory-golden-patch", 1),
            patch_export_id: request.patch_export.patch_export_id.clone(),
            status: OperationStatus::Passed,
            output_hash: content_hash(&String::from_utf8_lossy(&scene)),
            failures: vec![],
        })
    }

    fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
        Ok(VerificationResult {
            schema_version: PROFILE_SCHEMA_VERSION.to_string(),
            patch_result_id: deterministic_id("inventory-golden-verify", 1),
            status: OperationStatus::Passed,
            output_hash: content_hash("verified"),
            failures: vec![],
        })
    }
}

/// A `source.json`-shaped identity adapter used to keep the fixture
/// `source.json` byte-equivalence path covered as ONE case.
struct SourceJsonGoldenAdapter {
    mutate: bool,
}

impl EngineAdapter for SourceJsonGoldenAdapter {
    fn id(&self) -> &'static str {
        "kaifuu.source-json-golden"
    }

    fn name(&self) -> &'static str {
        "Source Json Golden"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        let reports = vec![
            CapabilityReport::supported(Capability::Detection),
            CapabilityReport::supported(Capability::Extraction),
            CapabilityReport::supported(Capability::Patching),
            CapabilityReport::supported(Capability::Verification),
        ];
        let matrix = AdapterCapabilityMatrix::derive_from_reports(self.id(), &reports);
        AdapterCapabilities::new(self.id(), reports, matrix)
    }

    fn detect(&self, _request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
        Ok(DetectionResult {
            adapter_id: self.id().to_string(),
            detected: true,
            engine_family: Some("fixture".to_string()),
            engine_version: None,
            detected_variant: Some("source-json-golden".to_string()),
            evidence: vec![],
            requirements: vec![],
            capabilities: self.capabilities().reports,
        })
    }

    fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
        Ok(golden_boundary_profile(self.id()))
    }

    fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
        Ok(AssetList {
            adapter_id: self.id().to_string(),
            assets: vec![],
        })
    }

    fn asset_inventory(
        &self,
        _request: AssetInventoryRequest<'_>,
    ) -> KaifuuResult<AssetInventoryManifest> {
        Err("source-json-golden adapter uses the source.json byte case".into())
    }

    fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
        Ok(ExtractionResult {
            adapter_id: self.id().to_string(),
            profile: golden_boundary_profile(self.id()),
            bridge: BridgeBundle {
                schema_version: PROFILE_SCHEMA_VERSION.to_string(),
                bridge_id: deterministic_id("source-json-golden-bridge", 1),
                source_bundle_hash: content_hash("source-json-golden"),
                source_locale: "ja-JP".to_string(),
                extractor_name: "source-json-golden-test".to_string(),
                extractor_version: "0.0.0".to_string(),
                units: vec![],
            },
            warnings: vec![],
        })
    }

    fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
        let bytes = if self.mutate {
            b"{\"changed\": true}\n".to_vec()
        } else {
            fs::read(request.game_dir.join("source.json"))?
        };
        write_file_all(request.output_dir, "source.json", &bytes);
        Ok(PatchResult {
            schema_version: PROFILE_SCHEMA_VERSION.to_string(),
            patch_result_id: deterministic_id("source-json-golden-patch", 1),
            patch_export_id: request.patch_export.patch_export_id.clone(),
            status: OperationStatus::Passed,
            output_hash: content_hash(&String::from_utf8_lossy(&bytes)),
            failures: vec![],
        })
    }

    fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
        Ok(VerificationResult {
            schema_version: PROFILE_SCHEMA_VERSION.to_string(),
            patch_result_id: deterministic_id("source-json-golden-verify", 1),
            status: OperationStatus::Passed,
            output_hash: content_hash("verified"),
            failures: vec![],
        })
    }
}

fn inventory_golden_registry(mutate_unsupported_asset: bool) -> AdapterRegistry {
    let mut registry = AdapterRegistry::new();
    registry.register(InventoryGoldenAdapter {
        mutate_unsupported_asset,
    });
    registry
}

#[test]
fn derive_asset_preservation_claims_from_inventory_is_source_json_agnostic() {
    let adapter = InventoryGoldenAdapter {
        mutate_unsupported_asset: false,
    };
    let game_dir = inventory_golden_game("k032-derive-claims");
    let manifest = adapter
        .asset_inventory(AssetInventoryRequest {
            game_dir: &game_dir,
        })
        .unwrap();

    let claims = derive_asset_preservation_claims(&manifest);
    assert_eq!(claims.len(), 1, "one capability-unsupported surface");
    let claim = &claims[0];
    assert_eq!(claim.asset_id, INVENTORY_LOGO_ASSET_ID);
    assert_eq!(claim.asset_ref, "art/logo");
    assert_eq!(
        claim.required_capability,
        Capability::NonTextSurfaceExtraction
    );
    assert_eq!(claim.support_boundary, INVENTORY_LOGO_BOUNDARY);
    // The claim never mentions source.json (adapter-neutral).
    assert!(!claim.asset_ref.contains("source.json"));

    let _ = fs::remove_dir_all(game_dir);
}

#[test]
fn golden_inventory_mode_asserts_preservation_and_capability_diagnostic_without_source_json() {
    let game_dir = inventory_golden_game("k032-inventory-pass-game");
    let work_dir = temp_dir("k032-inventory-pass-work");
    assert!(
        !game_dir.join("source.json").exists(),
        "the adapter-neutral fixture must have NO source.json"
    );

    let report = run_round_trip_golden(
        &inventory_golden_registry(false),
        GoldenHarnessRequest {
            game_dir: &game_dir,
            work_dir: &work_dir,
            adapter_id: Some(INVENTORY_GOLDEN_ID),
            byte_equivalence: GoldenByteEquivalenceMode::AssertInventory,
            translated_patch_export: None,
            translated_source_bridge: None,
        },
    )
    .unwrap();

    assert_eq!(report.status, OperationStatus::Passed);
    assert!(report.failures.is_empty());

    // Capability-aware diagnostic: typed, keyed on the unsupported capability.
    let diagnostic = report
        .phases
        .iter()
        .find(|phase| phase.phase == "asset_capability_diagnostic")
        .expect("capability-aware diagnostic phase");
    assert_eq!(diagnostic.status, GoldenAssertionStatus::Skipped);
    assert_eq!(
        diagnostic.required_capability,
        Some(Capability::NonTextSurfaceExtraction)
    );
    assert_eq!(diagnostic.asset_ref.as_deref(), Some("art/logo"));

    // Preservation asserted from inventory + capability, not source.json.
    let preservation = report
        .phases
        .iter()
        .find(|phase| phase.phase == "inventory_asset_preservation")
        .expect("inventory preservation phase");
    assert_eq!(preservation.status, GoldenAssertionStatus::Passed);

    // The asset-assertion phases (preservation + capability diagnostics) are
    // adapter-neutral: none of them fall back to a source.json asset ref, and
    // no byte_equivalence-by-source.json phase is emitted in inventory mode.
    assert!(
        !report
            .phases
            .iter()
            .any(|phase| phase.phase == "byte_equivalence")
    );
    assert!(
        report
            .phases
            .iter()
            .filter(|phase| {
                phase.phase == "inventory_asset_preservation"
                    || phase.phase == "asset_capability_diagnostic"
            })
            .all(|phase| phase.asset_ref.as_deref() != Some("source.json")),
        "adapter-neutral asset assertions must not reference a source.json asset ref"
    );

    let _ = fs::remove_dir_all(game_dir);
    let _ = fs::remove_dir_all(work_dir);
}
