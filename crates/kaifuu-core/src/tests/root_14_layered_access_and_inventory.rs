#[test]
fn layered_access_preflight_reports_stable_redacted_failures() {
    let raw_key = "00112233445566778899aabbccddeeff";
    let report = LayeredAccessPreflightReport::from_requirements(
        "kaifuu.private-adapter",
        "kirikiri",
        "xp3-encrypted-protected",
        vec![
            LayeredAccessPreflightRequirement::missing_capability(
                LayeredAccessStage::Container,
                "private-route-name/ending.ks",
                "missing XP3 container transform for /home/dev/Private Route Spoiler Game/data.xp3",
            ),
            LayeredAccessPreflightRequirement::missing_capability(
                LayeredAccessStage::Crypto,
                "Scene.pck",
                format!("raw key {raw_key} was not resolved"),
            ),
            LayeredAccessPreflightRequirement::missing_capability(
                LayeredAccessStage::Codec,
                "script.bin",
                "codec support has no helper dump or decrypted text evidence",
            ),
            LayeredAccessPreflightRequirement::missing_capability(
                LayeredAccessStage::PatchBack,
                "patch-back-target",
                "patch-back writer is absent for this container",
            ),
            LayeredAccessPreflightRequirement::unsupported_transform(
                LayeredAccessStage::Crypto,
                "helper dump from private executable",
                "Gameexe.dat",
                "requested transform is not in the alpha readiness profile",
            ),
        ],
    );

    assert_eq!(report.status, OperationStatus::Failed);
    let codes = report
        .failures
        .iter()
        .map(|failure| failure.error_code.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        codes,
        vec![
            SEMANTIC_MISSING_CONTAINER_CAPABILITY,
            SEMANTIC_MISSING_CRYPTO_CAPABILITY,
            SEMANTIC_MISSING_CODEC_CAPABILITY,
            SEMANTIC_MISSING_PATCH_BACK_CAPABILITY,
            SEMANTIC_UNSUPPORTED_LAYERED_TRANSFORM,
        ]
    );
    assert!(
        report
            .failures
            .iter()
            .all(AdapterFailure::is_preflight_blocking)
    );
    assert!(
        report
            .failures
            .iter()
            .any(|failure| { failure.required_capability == Some(Capability::ContainerAccess) })
    );
    assert!(
        report
            .failures
            .iter()
            .any(|failure| { failure.required_capability == Some(Capability::PatchBack) })
    );

    let serialized = report.stable_json().unwrap();
    assert!(!serialized.contains(raw_key));
    assert!(!serialized.contains("/home/dev"));
    assert!(!serialized.contains("Private Route Spoiler Game"));
    assert!(!serialized.contains("private-route-name"));
    assert!(!serialized.contains("helper dump"));
    assert!(!serialized.contains("decrypted text"));
    assert!(serialized.contains(SEMANTIC_SECRET_REDACTED));
}

#[test]
fn layered_access_profile_represents_plaintext_and_encrypted_surfaces() {
    let mut profile = GameProfile {
        schema_version: PROFILE_SCHEMA_VERSION.to_string(),
        profile_id: deterministic_id("profile", 520),
        game_id: "mv-mz-layered-fixture".to_string(),
        title: "MV MZ Layered Fixture".to_string(),
        source_locale: "ja-JP".to_string(),
        engine: EngineProfile {
            adapter_id: "kaifuu.rpg-maker-mv-mz".to_string(),
            engine_family: "rpg-maker-mv-mz".to_string(),
            engine_version: None,
            detected_variant: "json-text-encrypted-media".to_string(),
        },
        source_fingerprint: None,
        key_requirements: vec![],
        archive_parameters: vec![],
        helper_evidence: None,
        assets: vec![
            AssetProfile {
                asset_id: "data/map001.json".to_string(),
                path: "data/Map001.json".to_string(),
                asset_kind: AssetKind::Script,
                text_surfaces: vec![TextSurface::Dialogue],
                source_hash: Some(content_hash("json text")),
                patching: CapabilityReport::supported(Capability::Patching),
            },
            AssetProfile {
                asset_id: "img/pictures/title.rpgmvp".to_string(),
                path: "img/pictures/title.rpgmvp".to_string(),
                asset_kind: AssetKind::Image,
                text_surfaces: vec![TextSurface::ImageText],
                source_hash: Some(content_hash("encrypted image asset")),
                patching: CapabilityReport::unsupported(
                    Capability::AssetTextPatching,
                    "encrypted media text restoration is not supported by this profile",
                ),
            },
        ],
        layered_access: Some(LayeredAccessProfile {
            schema_version: PROFILE_SCHEMA_VERSION.to_string(),
            surfaces: vec![
                LayeredTextSurfaceAccess {
                    surface_id: "map001-dialogue".to_string(),
                    asset_id: "data/map001.json".to_string(),
                    path: "data/Map001.json".to_string(),
                    text_surface: TextSurface::Dialogue,
                    surface_transform: SurfaceTransform::JsonPointer,
                    surface_selector: "$.events[*].pages[*].list[*].parameters[*]".to_string(),
                    container: ContainerTransform::LooseFile,
                    crypto: CryptoTransform::NullKey,
                    codec: CodecTransform::RpgMakerMvMzJson,
                    patch_back: PatchBackTransform::RewriteJson,
                    key_material_status: LayeredAccessKeyMaterialStatus::NotRequired,
                    helper_status: LayeredAccessHelperStatus::NotRequired,
                    key_requirement_refs: vec![],
                    notes: vec![],
                },
                LayeredTextSurfaceAccess {
                    surface_id: "title-image-text".to_string(),
                    asset_id: "img/pictures/title.rpgmvp".to_string(),
                    path: "img/pictures/title.rpgmvp".to_string(),
                    text_surface: TextSurface::ImageText,
                    surface_transform: SurfaceTransform::OcrRegion,
                    surface_selector: "image:full-frame".to_string(),
                    container: ContainerTransform::LooseFile,
                    crypto: CryptoTransform::RpgMakerAssetKey,
                    codec: CodecTransform::Identity,
                    patch_back: PatchBackTransform::ReplaceAsset,
                    key_material_status: LayeredAccessKeyMaterialStatus::Missing,
                    helper_status: LayeredAccessHelperStatus::NotRequired,
                    key_requirement_refs: vec![],
                    notes: vec![
                        "MV/MZ media can be encrypted while JSON text remains plaintext"
                            .to_string(),
                    ],
                },
            ],
        }),
        capabilities: vec![
            CapabilityReport::supported(Capability::Detection),
            CapabilityReport::supported(Capability::ProfileGeneration),
            CapabilityReport::supported(Capability::Patching),
            CapabilityReport::supported(Capability::ContainerAccess),
            CapabilityReport::supported(Capability::CryptoAccess),
            CapabilityReport::supported(Capability::CodecAccess),
            CapabilityReport::supported(Capability::PatchBack),
            CapabilityReport::unsupported(
                Capability::AssetTextPatching,
                "encrypted media asset text is inventoried but not patched",
            ),
        ],
        requirements: vec![],
        metadata: BTreeMap::new(),
    };

    profile.normalize();

    assert_eq!(profile.validate().status, OperationStatus::Passed);
    let serialized = profile.stable_json().unwrap();
    assert!(serialized.contains("\"crypto\": \"null_key\""));
    assert!(serialized.contains("\"crypto\": \"rpg_maker_asset_key\""));
    assert!(serialized.contains("\"codec\": \"rpg_maker_mv_mz_json\""));
    assert!(serialized.contains("\"surfaceTransform\": \"ocr_region\""));
}

#[test]
fn layered_access_preflight_blocks_transform_key_and_helper_gates() {
    let reports = vec![
        CapabilityReport::supported(Capability::ContainerAccess),
        CapabilityReport::supported(Capability::CryptoAccess),
        CapabilityReport::supported(Capability::CodecAccess),
        CapabilityReport::supported(Capability::PatchBack),
    ];
    let capabilities = AdapterCapabilities::new(
        "kaifuu.layered-test",
        reports.clone(),
        derived_matrix_for("kaifuu.layered-test", &reports),
    )
    .with_access_contract(LayeredAccessCapabilityContract::plaintext_identity());
    let access_profile = LayeredAccessProfile {
        schema_version: PROFILE_SCHEMA_VERSION.to_string(),
        surfaces: vec![
            LayeredTextSurfaceAccess {
                surface_id: "scene-pck-dialogue".to_string(),
                asset_id: "Scene.pck".to_string(),
                path: "Scene.pck".to_string(),
                text_surface: TextSurface::Dialogue,
                surface_transform: SurfaceTransform::ArchiveEntry,
                surface_selector: "scripts/scene001.bin".to_string(),
                container: ContainerTransform::SiglusPck,
                crypto: CryptoTransform::KeyProfile,
                codec: CodecTransform::BytecodeDecompile,
                patch_back: PatchBackTransform::RepackArchive,
                key_material_status: LayeredAccessKeyMaterialStatus::Missing,
                helper_status: LayeredAccessHelperStatus::NotRequired,
                key_requirement_refs: vec!["siglus-secondary-key".to_string()],
                notes: vec![],
            },
            LayeredTextSurfaceAccess {
                surface_id: "protected-helper-route".to_string(),
                asset_id: "data.xp3".to_string(),
                path: "data.xp3".to_string(),
                text_surface: TextSurface::Dialogue,
                surface_transform: SurfaceTransform::ArchiveEntry,
                surface_selector: "scenario/ending.ks".to_string(),
                container: ContainerTransform::Xp3,
                crypto: CryptoTransform::HelperGated,
                codec: CodecTransform::Utf8Text,
                patch_back: PatchBackTransform::RepackArchive,
                key_material_status: LayeredAccessKeyMaterialStatus::HelperGated,
                helper_status: LayeredAccessHelperStatus::Unavailable,
                key_requirement_refs: vec![],
                notes: vec![],
            },
        ],
    };

    let report = LayeredAccessPreflightReport::from_access_profile(
        "kaifuu.layered-test",
        "fixture",
        "layered-transform-test",
        &capabilities,
        &access_profile,
    );

    assert_eq!(report.status, OperationStatus::Failed);
    assert!(report.failures.iter().any(|failure| {
        failure.error_code == SEMANTIC_UNSUPPORTED_LAYERED_TRANSFORM
            && failure.required_capability == Some(Capability::PatchBack)
    }));
    assert!(
        report
            .failures
            .iter()
            .any(|failure| failure.error_code == SEMANTIC_MISSING_KEY_MATERIAL)
    );
    assert!(
        report
            .failures
            .iter()
            .any(|failure| failure.error_code == SEMANTIC_HELPER_UNAVAILABLE)
    );
    assert!(
        report
            .failures
            .iter()
            .all(AdapterFailure::is_preflight_blocking)
    );
}

#[test]
fn layered_access_preflight_allows_plaintext_identity_without_patch_contract() {
    let reports = vec![
        CapabilityReport::supported(Capability::ContainerAccess),
        CapabilityReport::supported(Capability::CryptoAccess),
        CapabilityReport::supported(Capability::CodecAccess),
        CapabilityReport::supported(Capability::PatchBack),
    ];
    let capabilities = AdapterCapabilities::new(
        "kaifuu.layered-test",
        reports.clone(),
        derived_matrix_for("kaifuu.layered-test", &reports),
    );
    let access_profile = LayeredAccessProfile::plaintext_identity_for_asset(
        "source-json",
        "source.json",
        &[TextSurface::Dialogue],
        "$.lines[*]",
    );

    let report = LayeredAccessPreflightReport::from_access_profile(
        "kaifuu.layered-test",
        "fixture",
        "plaintext-identity",
        &capabilities,
        &access_profile,
    );

    assert_eq!(report.status, OperationStatus::Passed);
    assert_eq!(report.failures, Vec::<AdapterFailure>::new());
}

#[test]
fn layered_access_preflight_fails_closed_without_patch_contract_for_non_identity_transforms() {
    let reports = vec![
        CapabilityReport::supported(Capability::ContainerAccess),
        CapabilityReport::supported(Capability::CryptoAccess),
        CapabilityReport::supported(Capability::CodecAccess),
        CapabilityReport::supported(Capability::PatchBack),
    ];
    let capabilities = AdapterCapabilities::new(
        "kaifuu.layered-test",
        reports.clone(),
        derived_matrix_for("kaifuu.layered-test", &reports),
    );
    let access_profile = LayeredAccessProfile {
        schema_version: PROFILE_SCHEMA_VERSION.to_string(),
        surfaces: vec![LayeredTextSurfaceAccess {
            surface_id: "xp3-bytecode-route".to_string(),
            asset_id: "data.xp3".to_string(),
            path: "data.xp3".to_string(),
            text_surface: TextSurface::Dialogue,
            surface_transform: SurfaceTransform::ArchiveEntry,
            surface_selector: "scenario/route.ks".to_string(),
            container: ContainerTransform::Xp3,
            crypto: CryptoTransform::NullKey,
            codec: CodecTransform::BytecodeDecompile,
            patch_back: PatchBackTransform::RepackArchive,
            key_material_status: LayeredAccessKeyMaterialStatus::Resolved,
            helper_status: LayeredAccessHelperStatus::Available,
            key_requirement_refs: vec![],
            notes: vec![],
        }],
    };

    let report = LayeredAccessPreflightReport::from_access_profile(
        "kaifuu.layered-test",
        "kirikiri",
        "xp3-bytecode",
        &capabilities,
        &access_profile,
    );

    assert_eq!(report.status, OperationStatus::Failed);
    for required_capability in [
        Capability::ContainerAccess,
        Capability::CodecAccess,
        Capability::PatchBack,
    ] {
        assert!(
            report.failures.iter().any(|failure| {
                failure.error_code == SEMANTIC_UNSUPPORTED_LAYERED_TRANSFORM
                    && failure.required_capability == Some(required_capability.clone())
            }),
            "missing unsupported transform failure for {required_capability:?}: {:#?}",
            report.failures
        );
    }
    assert!(
        report
            .failures
            .iter()
            .all(AdapterFailure::is_preflight_blocking)
    );
}

#[test]
fn layered_access_preflight_blocks_patch_contract_status_before_transform_match_passes() {
    for status in [
        CapabilityStatus::Unsupported,
        CapabilityStatus::RequiresUserInput,
    ] {
        let mut access_contract = LayeredAccessCapabilityContract::plaintext_identity();
        access_contract.patch.status = status.clone();
        access_contract.patch.support_boundary = Some(format!(
            "patch contract status {status:?} requires local evidence before writing"
        ));
        let reports = vec![
            CapabilityReport::supported(Capability::ContainerAccess),
            CapabilityReport::supported(Capability::CryptoAccess),
            CapabilityReport::supported(Capability::CodecAccess),
            CapabilityReport::supported(Capability::PatchBack),
        ];
        let capabilities = AdapterCapabilities::new(
            "kaifuu.layered-test",
            reports.clone(),
            derived_matrix_for("kaifuu.layered-test", &reports),
        )
        .with_access_contract(access_contract);
        let access_profile = LayeredAccessProfile::plaintext_identity_for_asset(
            "source-json",
            "source.json",
            &[TextSurface::Dialogue],
            "$.lines[*]",
        );

        let report = LayeredAccessPreflightReport::from_access_profile(
            "kaifuu.layered-test",
            "fixture",
            "patch-status",
            &capabilities,
            &access_profile,
        );

        assert_eq!(report.status, OperationStatus::Failed);
        assert!(report.failures.iter().any(|failure| {
            failure.error_code == SEMANTIC_MISSING_PATCH_BACK_CAPABILITY
                && failure.required_capability == Some(Capability::PatchBack)
        }));
        assert!(
            report
                .failures
                .iter()
                .all(AdapterFailure::is_preflight_blocking)
        );
    }
}

#[test]
fn asset_inventory_rejects_engine_specific_source_location_fields() {
    let manifest = AssetInventoryManifest {
        schema_version: ASSET_INVENTORY_SCHEMA_VERSION.to_string(),
        manifest_id: deterministic_id("asset-inventory", 1),
        adapter_id: "kaifuu.fixture".to_string(),
        source_locale: "ja-JP".to_string(),
        assets: vec![AssetInventoryAsset {
            asset_id: "asset-image-sign".to_string(),
            asset_key: "image/sign".to_string(),
            asset_kind: AssetInventoryAssetKind::Image,
            path: Some("images/sign.png".to_string()),
            source_hash: Some(content_hash("image/sign")),
            metadata: BTreeMap::new(),
        }],
        surfaces: vec![AssetInventorySurface {
            surface_id: "surface-image-sign-text".to_string(),
            asset_surface_kind: AssetInventorySurfaceKind::ImageText,
            source_asset_ref: AssetInventoryAssetRef {
                asset_id: "asset-image-sign".to_string(),
                asset_key: Some("image/sign".to_string()),
            },
            source_location: Some(serde_json::json!({
                "containerKey": "image/sign",
                "rpgMakerEventId": 12
            })),
            source_text: Some("注意".to_string()),
            source_hash: Some(content_hash("注意")),
            text_source_kind: AssetInventoryTextSourceKind::ManualTranscription,
            patch_mode: AssetInventoryPatchMode::RegionRedrawRequired,
            patching: CapabilityReport::unsupported(
                Capability::AssetTextPatching,
                "test adapter does not patch image assets",
            ),
            patch_payload: None,
            metadata_hash: None,
            notes: vec![],
        }],
        capabilities: vec![CapabilityReport::supported(Capability::AssetInventory)],
        warnings: vec![],
        metadata: BTreeMap::new(),
    };

    let validation = manifest.validate();

    assert_eq!(validation.status, OperationStatus::Failed);
    assert!(validation.failures.iter().any(|failure| {
        failure.code == "engine_specific_source_location"
            && failure.field == "surfaces.0.sourceLocation.rpgMakerEventId"
    }));
}
