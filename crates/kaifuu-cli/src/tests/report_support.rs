struct SensitiveReportAdapter;

impl EngineAdapter for SensitiveReportAdapter {
    fn id(&self) -> &'static str {
        "kaifuu.test.sensitive-report"
    }

    fn name(&self) -> &'static str {
        "Kaifuu sensitive report test adapter"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        AdapterCapabilities::new(
            self.id(),
            vec![
                CapabilityReport::requires_user_input(
                    Capability::KeyProfile,
                    "path=~/games/private/key.bin",
                ),
                CapabilityReport::unsupported(
                    Capability::PatchBack,
                    "requires file=%USERPROFILE%\\Games\\SecretRoute\\patcher.exe",
                ),
            ],
            // this fixture has no Detection report so even
            // Identify is Unsupported at the registry gate; the fully
            // unsupported matrix exercises the redaction pipeline only.
            AdapterCapabilityMatrix::new(
                self.id(),
                CapabilityLevelStatus::unsupported(
                    "sensitive-report fixture has no Detection capability report",
                ),
                CapabilityLevelStatus::unsupported(
                    "sensitive-report fixture has no AssetListing capability report",
                ),
                CapabilityLevelStatus::unsupported(
                    "sensitive-report fixture has no Extraction capability report",
                ),
                CapabilityLevelStatus::unsupported(
                    "sensitive-report fixture has no Patching capability report",
                ),
            ),
        )
    }

    fn detect(&self, _request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
        Ok(DetectionResult {
            adapter_id: self.id().to_string(),
            detected: true,
            engine_family: Some("sensitive-report-test".to_string()),
            engine_version: None,
            detected_variant: Some("private-route".to_string()),
            evidence: vec![],
            requirements: vec![
                ProfileRequirement {
                    category: RequirementCategory::SecretKey,
                    key: "route-key".to_string(),
                    status: RequirementStatus::Missing,
                    description: "read key from $HOME/games/private/key.bin".to_string(),
                    placeholder: Some(
                        "file=%USERPROFILE%\\Games\\SecretRoute\\key.bin".to_string(),
                    ),
                    secret: true,
                },
                ProfileRequirement {
                    category: RequirementCategory::File,
                    key: "script".to_string(),
                    status: RequirementStatus::Unsupported,
                    description: "story-ish filename private-route-ending.ks must stay local"
                        .to_string(),
                    placeholder: None,
                    secret: false,
                },
            ],
            capabilities: self.capabilities().reports,
        })
    }

    fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
        let mut metadata = BTreeMap::new();
        metadata.insert(
            "diagnostic".to_string(),
            "source=$HOME/games/private/key.bin".to_string(),
        );
        Ok(GameProfile {
                schema_version: "0.1.0".to_string(),
                profile_id: deterministic_id("profile", 1301),
                game_id: "sensitive-report-game".to_string(),
                title: "Sensitive Report Game".to_string(),
                source_locale: "ja-JP".to_string(),
                engine: EngineProfile {
                    adapter_id: self.id().to_string(),
                    engine_family: "sensitive-report-test".to_string(),
                    engine_version: None,
                    detected_variant: "private-route".to_string(),
                },
                source_fingerprint: None,
                key_requirements: vec![],
                archive_parameters: vec![],
                helper_evidence: None,
                assets: vec![AssetProfile {
                    asset_id: deterministic_id("asset", 1301),
                    path: "~/games/private/source.ks".to_string(),
                    asset_kind: AssetKind::Script,
                    text_surfaces: vec![TextSurface::Dialogue],
                    source_hash: Some(content_hash("sensitive profile asset")),
                    patching: CapabilityReport::limited(
                        Capability::Patching,
                        "helper input lives at %USERPROFILE%\\Games\\SecretRoute\\key.bin",
                    ),
                }],
                layered_access: None,
                capabilities: self.capabilities().reports,
                requirements: vec![ProfileRequirement {
                    category: RequirementCategory::SecretKey,
                    key: "route-key".to_string(),
                    status: RequirementStatus::Missing,
                    description:
                        "helper dump source:/home/dev/game/private-route-ending.ks exposed raw key 00112233445566778899aabbccddeeff"
                            .to_string(),
                    placeholder: Some("file=C:\\Games\\SecretRoute\\key.bin".to_string()),
                    secret: true,
                }],
                metadata,
            })
    }

    fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
        Err("list_assets is not used by the sensitive report test".into())
    }

    fn asset_inventory(
        &self,
        _request: AssetInventoryRequest<'_>,
    ) -> KaifuuResult<AssetInventoryManifest> {
        Err("asset_inventory is not used by the sensitive report test".into())
    }

    fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
        Err("extract is not used by the sensitive report test".into())
    }

    fn patch(&self, _request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
        Err("patch is not used by the sensitive report test".into())
    }

    fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
        Err("verify is not used by the sensitive report test".into())
    }
}

fn sensitive_report_registry() -> AdapterRegistry {
    let mut registry = AdapterRegistry::new();
    registry.register(SensitiveReportAdapter);
    registry
}

struct InvalidProfileAdapter;

impl EngineAdapter for InvalidProfileAdapter {
    fn id(&self) -> &'static str {
        "kaifuu.test.invalid-profile"
    }

    fn name(&self) -> &'static str {
        "Kaifuu invalid profile test adapter"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        AdapterCapabilities::new(
            self.id(),
            vec![
                CapabilityReport::supported(Capability::Detection),
                CapabilityReport::supported(Capability::ProfileGeneration),
                CapabilityReport::supported(Capability::Patching),
            ],
            // identify-only matrix — exercises the
            // missing-profile-id path; the registry gate must stay
            // strict despite the per-Capability reports.
            AdapterCapabilityMatrix::identify_only(
                self.id(),
                "invalid-profile fixture is identify-only at the registry gate",
            ),
        )
    }

    fn detect(&self, _request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
        Ok(DetectionResult {
            adapter_id: self.id().to_string(),
            detected: true,
            engine_family: Some("invalid-profile-test".to_string()),
            engine_version: None,
            detected_variant: Some("missing-profile-id".to_string()),
            evidence: vec![],
            requirements: vec![],
            capabilities: self.capabilities().reports,
        })
    }

    fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
        Ok(GameProfile {
            schema_version: "0.1.0".to_string(),
            profile_id: String::new(),
            game_id: "invalid-profile-game".to_string(),
            title: "Invalid Profile Game".to_string(),
            source_locale: "ja-JP".to_string(),
            engine: EngineProfile {
                adapter_id: self.id().to_string(),
                engine_family: "invalid-profile-test".to_string(),
                engine_version: None,
                detected_variant: "missing-profile-id".to_string(),
            },
            source_fingerprint: None,
            key_requirements: vec![],
            archive_parameters: vec![],
            helper_evidence: None,
            assets: vec![AssetProfile {
                asset_id: deterministic_id("asset", 1401),
                path: "source.ks".to_string(),
                asset_kind: AssetKind::Script,
                text_surfaces: vec![TextSurface::Dialogue],
                source_hash: Some(content_hash("invalid profile source")),
                patching: CapabilityReport::supported(Capability::Patching),
            }],
            layered_access: None,
            capabilities: self.capabilities().reports,
            requirements: vec![],
            metadata: BTreeMap::new(),
        })
    }

    fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
        Err("list_assets is not used by the invalid profile test".into())
    }

    fn asset_inventory(
        &self,
        _request: AssetInventoryRequest<'_>,
    ) -> KaifuuResult<AssetInventoryManifest> {
        Err("asset_inventory is not used by the invalid profile test".into())
    }

    fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
        Err("extract is not used by the invalid profile test".into())
    }

    fn patch(&self, _request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
        Err("patch is not used by the invalid profile test".into())
    }

    fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
        Err("verify is not used by the invalid profile test".into())
    }
}

fn invalid_profile_registry() -> AdapterRegistry {
    let mut registry = AdapterRegistry::new();
    registry.register(InvalidProfileAdapter);
    registry
}

fn assert_no_sensitive_profile_material(surface: &str) {
    for forbidden in [
        "~/games",
        "$HOME/games",
        "%USERPROFILE%",
        "/home/dev/game",
        "C:\\Games",
        "private/key.bin",
        "helper dump",
        "decrypted text",
        "00112233445566778899aabbccddeeff",
        "private-route-ending.ks",
        "SecretRoute",
    ] {
        assert!(
            !surface.contains(forbidden),
            "profile write surface leaked {forbidden}: {surface}"
        );
    }
}

fn assert_calls(calls: &Rc<RefCell<Vec<&'static str>>>, expected: &[&'static str]) {
    assert_eq!(calls.borrow().as_slice(), expected);
    calls.borrow_mut().clear();
}
