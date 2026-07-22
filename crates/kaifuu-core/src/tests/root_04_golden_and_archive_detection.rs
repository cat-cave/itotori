#[test]
fn golden_inventory_mode_flags_mutated_capability_unsupported_asset() {
    let game_dir = inventory_golden_game("k032-inventory-mutate-game");
    let work_dir = temp_dir("k032-inventory-mutate-work");

    let report = run_round_trip_golden(
        &inventory_golden_registry(true),
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

    assert_eq!(report.status, OperationStatus::Failed);
    let failure = report
        .failures
        .iter()
        .find(|failure| failure.code == "inventory_unsupported_asset_mutated")
        .expect("mutated capability-unsupported asset failure");
    assert_eq!(failure.phase, "inventory_asset_preservation");
    assert_eq!(failure.asset_ref.as_deref(), Some("art/logo"));
    assert_eq!(
        failure.required_capability,
        Some(Capability::NonTextSurfaceExtraction)
    );

    let _ = fs::remove_dir_all(game_dir);
    let _ = fs::remove_dir_all(work_dir);
}

#[test]
fn golden_source_json_mode_asserts_byte_identity_as_one_retained_case() {
    let game_dir = temp_dir("k032-source-json-pass-game");
    write_file_all(&game_dir, "source.json", b"{\"units\": []}\n");
    let work_dir = temp_dir("k032-source-json-pass-work");

    let mut registry = AdapterRegistry::new();
    registry.register(SourceJsonGoldenAdapter { mutate: false });

    let report = run_round_trip_golden(
        &registry,
        GoldenHarnessRequest {
            game_dir: &game_dir,
            work_dir: &work_dir,
            adapter_id: Some("kaifuu.source-json-golden"),
            byte_equivalence: GoldenByteEquivalenceMode::AssertSourceJson,
            translated_patch_export: None,
            translated_source_bridge: None,
        },
    )
    .unwrap();

    assert_eq!(report.status, OperationStatus::Passed);
    let byte_phase = report
        .phases
        .iter()
        .find(|phase| phase.phase == "byte_equivalence")
        .expect("byte equivalence phase");
    assert_eq!(byte_phase.status, GoldenAssertionStatus::Passed);
    assert_eq!(byte_phase.asset_ref.as_deref(), Some("source.json"));

    let _ = fs::remove_dir_all(game_dir);
    let _ = fs::remove_dir_all(work_dir);
}

#[test]
fn golden_source_json_mode_flags_byte_mismatch() {
    let game_dir = temp_dir("k032-source-json-fail-game");
    write_file_all(&game_dir, "source.json", b"{\"units\": []}\n");
    let work_dir = temp_dir("k032-source-json-fail-work");

    let mut registry = AdapterRegistry::new();
    registry.register(SourceJsonGoldenAdapter { mutate: true });

    let report = run_round_trip_golden(
        &registry,
        GoldenHarnessRequest {
            game_dir: &game_dir,
            work_dir: &work_dir,
            adapter_id: Some("kaifuu.source-json-golden"),
            byte_equivalence: GoldenByteEquivalenceMode::AssertSourceJson,
            translated_patch_export: None,
            translated_source_bridge: None,
        },
    )
    .unwrap();

    assert_eq!(report.status, OperationStatus::Failed);
    assert!(report.failures.iter().any(|failure| {
        failure.phase == "byte_equivalence" && failure.code == "byte_equivalence_mismatch"
    }));

    let _ = fs::remove_dir_all(game_dir);
    let _ = fs::remove_dir_all(work_dir);
}

struct GoldenPreflightBoundaryAdapter {
    block_on_preflight_call: usize,
    preflight_calls: Arc<AtomicUsize>,
    patch_calls: Arc<AtomicUsize>,
}

impl GoldenPreflightBoundaryAdapter {
    fn preflight_failure(&self, patch_export: &PatchExport) -> PatchResult {
        let raw_key = "00112233445566778899aabbccddeeff";
        let preflight = LayeredAccessPreflightReport::from_requirements(
            self.id(),
            "fixture",
            "layered-access-test",
            vec![
                LayeredAccessPreflightRequirement::missing_capability(
                    LayeredAccessStage::Container,
                    "private-route-name/ending.ks",
                    "container helper unavailable for $HOME/Private Route Spoiler Game/data.xp3",
                ),
                LayeredAccessPreflightRequirement::missing_capability(
                    LayeredAccessStage::Crypto,
                    "%USERPROFILE%\\Games\\Scene.pck",
                    format!(
                        "helper dump at ~/games/private/key.bin included unresolved raw key {raw_key}"
                    ),
                ),
            ],
        );
        PatchResult {
            schema_version: PROFILE_SCHEMA_VERSION.to_string(),
            patch_result_id: "patch-result=~/Private Route Spoiler Game/patch-result.json"
                .to_string(),
            patch_export_id: patch_export.patch_export_id.clone(),
            status: OperationStatus::Failed,
            output_hash: format!("helper dump output hash {raw_key}"),
            failures: preflight.failures,
        }
    }
}

impl EngineAdapter for GoldenPreflightBoundaryAdapter {
    fn id(&self) -> &'static str {
        "kaifuu.golden-preflight-boundary"
    }

    fn name(&self) -> &'static str {
        "Golden Preflight Boundary"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        // the golden boundary covers Detection, Extraction
        // Patching, Verification — but not AssetListing/AssetInventory,
        // so derive the matrix explicitly to keep the registry gate
        // honest (Inventory will land at Unsupported).
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
            detected_variant: Some("preflight-boundary".to_string()),
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
        Err("asset inventory is not used by golden preflight tests".into())
    }

    fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
        Ok(golden_boundary_extraction(self.id()))
    }

    fn patch_preflight(&self, request: PatchPreflightRequest<'_>) -> KaifuuResult<PatchResult> {
        let call = self.preflight_calls.fetch_add(1, Ordering::SeqCst) + 1;
        if call == self.block_on_preflight_call {
            Ok(self.preflight_failure(request.patch_export))
        } else {
            Ok(PatchResult::preflight_pass(request.patch_export))
        }
    }

    fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
        self.patch_calls.fetch_add(1, Ordering::SeqCst);
        fs::write(request.output_dir.join("source.json"), "{}\n")?;
        Ok(PatchResult {
            schema_version: PROFILE_SCHEMA_VERSION.to_string(),
            patch_result_id: deterministic_id("patch-result", 91),
            patch_export_id: request.patch_export.patch_export_id.clone(),
            status: OperationStatus::Passed,
            output_hash: content_hash("patched"),
            failures: vec![],
        })
    }

    fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
        Ok(VerificationResult {
            schema_version: PROFILE_SCHEMA_VERSION.to_string(),
            patch_result_id: deterministic_id("verify", 91),
            status: OperationStatus::Passed,
            output_hash: content_hash("verified"),
            failures: vec![],
        })
    }
}

#[test]
fn archive_detection_matrix_reports_requested_engine_families() {
    let root = temp_dir("archive-matrix-families");
    write_fixture_file(
        &root,
        "private-spoiler-route-name.xp3",
        b"XP3\r\nKAIFUU-XP3-ENCRYPTED",
    );
    write_fixture_file(&root, "Scene.pck", b"siglus scene package");
    write_fixture_file(&root, "Gameexe.dat", b"siglus metadata");
    write_fixture_file(
        &root,
        "www/data/System.json",
        br#"{
  "hasEncryptedImages": true,
  "hasEncryptedAudio": true,
  "encryptionKey": "00112233445566778899aabbccddeeff"
}"#,
    );
    write_fixture_file(&root, "img/pictures/title.rpgmvp", b"rpgmvp synthetic");
    write_fixture_file(&root, "img/pictures/title.png_", b"mz image synthetic");
    write_fixture_file(
        &root,
        "img/pictures/plain-title.png",
        b"plain image synthetic",
    );
    write_fixture_file(
        &root,
        "img/pictures/title.webp_",
        b"unknown image synthetic",
    );
    write_fixture_file(&root, "audio/bgm/theme.m4a_", b"mz audio synthetic");
    write_fixture_file(&root, "audio/se/cursor.ogg_", b"mz audio synthetic");
    write_fixture_file(
        &root,
        "Data.wolf",
        b"WOLF RPG Editor synthetic WOLF-PROTECTED protection-key",
    );
    write_fixture_file(&root, "pack.arc", b"BURIKO ARC20\0BGI-ENCRYPTED synthetic");
    write_fixture_file(&root, "game/archive.rpa", b"RenPy archive synthetic");
    write_fixture_file(&root, "game/script.rpyc", b"RenPy bytecode synthetic");
    write_fixture_file(&root, "mystery/private-route-name.pak", b"unknown archive");

    let report = ArchiveDetectionReport::scan(&root);

    assert_eq!(report.status, ArchiveDetectionStatus::Matched);
    assert_eq!(
        report
            .rows
            .iter()
            .map(|row| row.row_id.as_str())
            .collect::<Vec<_>>(),
        vec![
            "kirikiri-xp3",
            "siglus-scene-pck",
            "reallive-seen-txt",
            "rpg-maker-mv-mz-encrypted-assets",
            "wolf-rpg-editor-archives",
            "bgi-ethornell-containers",
            "renpy-packed-inputs",
            "unknown-archive-variant",
        ]
    );

    let kirikiri = detected_archive_row(&report, "kirikiri-xp3");
    assert!(
        kirikiri
            .signals
            .contains(&ArchiveDetectionSignal::Encrypted)
    );
    assert!(
        kirikiri.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == SemanticErrorCode::UnsupportedVariantEncrypted
        })
    );

    let siglus = detected_archive_row(&report, "siglus-scene-pck");
    assert!(siglus.signals.contains(&ArchiveDetectionSignal::MissingKey));
    assert!(
        siglus
            .diagnostics
            .iter()
            .any(|diagnostic| { diagnostic.code == SemanticErrorCode::HelperUnavailable })
    );

    let rpg_maker = detected_archive_row(&report, "rpg-maker-mv-mz-encrypted-assets");
    assert_eq!(rpg_maker.detected_variant, "mv_or_mz_with_unknown_suffix");
    assert!(rpg_maker.evidence.iter().any(|evidence| {
        evidence.pattern == RPG_MAKER_MV_MZ_ENCRYPTED_SUFFIX_PATTERN
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 4
    }));
    assert!(rpg_maker.evidence.iter().any(|evidence| {
        evidence.pattern == RPG_MAKER_MV_MZ_PLAIN_SUFFIX_PATTERN
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 1
    }));
    assert!(rpg_maker.evidence.iter().any(|evidence| {
        evidence.pattern == RPG_MAKER_MV_MZ_UNKNOWN_SUFFIX_PATTERN
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 1
    }));
    assert!(rpg_maker.evidence.iter().any(|evidence| {
        evidence.pattern == "data/System.json encryption fields"
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 1
    }));
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
            && surface.codec == CodecTransform::PngImage
            && surface.key_requirement_refs.is_empty()
            && surface.diagnostics.is_empty()
    }));
    assert!(rpg_maker.surfaces.iter().any(|surface| {
        surface.fixture_id == "kaifuu-rpgmaker-unknown-webp_"
            && surface.variant == "unknown_suffix"
            && surface.crypto == CryptoTransform::Unknown
            && surface.key_requirement_refs.is_empty()
            && surface
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == SemanticErrorCode::MissingCryptoCapability)
    }));

    let wolf = detected_archive_row(&report, "wolf-rpg-editor-archives");
    assert!(wolf.signals.contains(&ArchiveDetectionSignal::Protected));
    assert!(wolf.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == SemanticErrorCode::ProtectedExecutableUnsupported
    }));

    let bgi = detected_archive_row(&report, "bgi-ethornell-containers");
    assert!(
        bgi.signals
            .contains(&ArchiveDetectionSignal::UnknownVariant)
    );
    assert!(
        bgi.diagnostics
            .iter()
            .any(|diagnostic| { diagnostic.code == SemanticErrorCode::UnknownEngineVariant })
    );

    let renpy = detected_archive_row(&report, "renpy-packed-inputs");
    assert!(
        renpy
            .diagnostics
            .iter()
            .any(|diagnostic| { diagnostic.code == SemanticErrorCode::UnsupportedVariantPacked })
    );

    let unknown = detected_archive_row(&report, "unknown-archive-variant");
    assert!(
        unknown
            .signals
            .contains(&ArchiveDetectionSignal::UnknownVariant)
    );

    let serialized = serde_json::to_string(&report).unwrap();
    assert!(!serialized.contains("private-spoiler-route-name"));
    assert!(!serialized.contains("private-route-name"));
    assert!(!serialized.contains("00112233445566778899aabbccddeeff"));
    assert!(!serialized.contains("confidence"));
    assert!(serialized.contains("aggregate-only"));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn archive_detection_plain_xp3_with_marker_like_payload_is_not_encrypted_or_compressed() {
    // a valid plain XP3 whose member payload legitimately
    // contains marker-like text ("XP3-CRYPT", "xp3-encrypted",
    // "xp3-compressed") must be classified PLAIN. The aggregate detector
    // must not treat an incidental payload substring as a structural
    // subtype marker.
    let root = temp_dir("kirikiri-xp3-plain-with-marker-payload");
    let bytes = plain_xp3_fixture(&[Xp3TestEntry {
        path: "scenario/spoiler.ks",
        // Marker-like tokens embedded in ordinary member payload
        // bytes — exactly the false-positive trigger.
        payload:
            b"the villain says: XP3-CRYPT and xp3-encrypted and xp3-compressed are just words here",
        compressed: false,
        adler32: 0x0102_0304,
    }]);
    // Sanity: the fixture really is a genuine plain XP3 the structural
    // parser accepts, and the marker-like text lands inside the header
    // window the detector reads.
    assert!(bytes.starts_with(XP3_PLAIN_MAGIC));
    assert!(read_plain_xp3_inventory(&bytes).is_ok());
    write_fixture_file(&root, "private-route-name.xp3", &bytes);

    let report = ArchiveDetectionReport::scan(&root);
    let kirikiri = detected_archive_row(&report, "kirikiri-xp3");
    assert_eq!(
        kirikiri.detected_variant, "xp3-archive",
        "plain XP3 with marker-like payload must classify as a plain archive"
    );
    assert!(
        !kirikiri
            .signals
            .contains(&ArchiveDetectionSignal::Encrypted),
        "plain XP3 must not be flagged encrypted from a payload substring: {kirikiri:#?}"
    );
    assert!(
        !kirikiri
            .signals
            .contains(&ArchiveDetectionSignal::Compressed),
        "plain XP3 must not be flagged compressed from a payload substring: {kirikiri:#?}"
    );
    assert!(
        !kirikiri
            .signals
            .contains(&ArchiveDetectionSignal::UnknownVariant)
    );
    // The encrypted-marker evidence count is zero for a plain archive.
    assert!(kirikiri.evidence.iter().any(|evidence| {
        evidence.pattern == "synthetic XP3 encryption marker" && evidence.count == 0
    }));
    assert!(kirikiri.evidence.iter().any(|evidence| {
        evidence.pattern == "synthetic XP3 compression marker" && evidence.count == 0
    }));
    let _ = fs::remove_dir_all(root);
}
