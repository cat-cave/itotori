struct PreflightBlockingAdapter;

impl EngineAdapter for PreflightBlockingAdapter {
    fn id(&self) -> &'static str {
        "kaifuu.test.preflight"
    }

    fn name(&self) -> &'static str {
        "Kaifuu preflight failure test adapter"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        AdapterCapabilities::new(
            self.id(),
            vec![
                CapabilityReport::supported(Capability::Detection),
                CapabilityReport::supported(Capability::Patching),
                CapabilityReport::requires_user_input(
                    Capability::ContainerAccess,
                    "synthetic preflight requires container support",
                ),
                CapabilityReport::requires_user_input(
                    Capability::CryptoAccess,
                    "synthetic preflight requires crypto support",
                ),
            ],
            // identify-only matrix — this synthetic
            // preflight fixture stops at Identify, so the registry
            // gate must never bubble it up to Inventory/Extract/Patch.
            AdapterCapabilityMatrix::identify_only(
                self.id(),
                "preflight failure test adapter is identify-only; container/crypto required-user-input gates inventory/extract/patch",
            ),
        )
    }

    fn detect(&self, _request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
        Ok(DetectionResult {
            adapter_id: self.id().to_string(),
            detected: true,
            engine_family: Some("preflight-test".to_string()),
            engine_version: None,
            detected_variant: Some("layered-access-test".to_string()),
            evidence: vec![],
            requirements: vec![],
            capabilities: self.capabilities().reports,
        })
    }

    fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
        Err("profile is not used by the preflight test".into())
    }

    fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
        Err("list_assets is not used by the preflight test".into())
    }

    fn asset_inventory(
        &self,
        _request: AssetInventoryRequest<'_>,
    ) -> KaifuuResult<AssetInventoryManifest> {
        Err("asset_inventory is not used by the preflight test".into())
    }

    fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
        Err("extract is not used by the preflight test".into())
    }

    fn patch_preflight(&self, request: PatchPreflightRequest<'_>) -> KaifuuResult<PatchResult> {
        let raw_key = "00112233445566778899aabbccddeeff";
        let preflight = LayeredAccessPreflightReport::from_requirements(
            self.id(),
            "preflight-test",
            "layered-access-test",
            vec![
                LayeredAccessPreflightRequirement::missing_capability(
                    LayeredAccessStage::Container,
                    "private-route-name/ending.ks",
                    "container helper unavailable for /home/dev/Private Route Spoiler Game/data.xp3",
                ),
                LayeredAccessPreflightRequirement::missing_capability(
                    LayeredAccessStage::Crypto,
                    "Scene.pck",
                    format!("helper dump included unresolved raw key {raw_key}"),
                ),
            ],
        );
        Ok(PatchResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("patch-result", 77),
            patch_export_id: request.patch_export.patch_export_id.clone(),
            status: OperationStatus::Failed,
            output_hash: content_hash("preflight failed without output"),
            failures: preflight.failures,
        })
    }

    fn patch(&self, _request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
        Err("patch must not run after a blocking preflight failure".into())
    }

    fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
        Err("verify is not used by the preflight test".into())
    }
}

fn preflight_registry() -> AdapterRegistry {
    let mut registry = AdapterRegistry::new();
    registry.register(PreflightBlockingAdapter);
    registry
}

struct ContractStatusPreflightAdapter;

impl EngineAdapter for ContractStatusPreflightAdapter {
    fn id(&self) -> &'static str {
        "kaifuu.test.contract-status-preflight"
    }

    fn name(&self) -> &'static str {
        "Kaifuu contract status preflight test adapter"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        let mut access_contract = LayeredAccessCapabilityContract::plaintext_identity();
        access_contract.patch.status = CapabilityStatus::RequiresUserInput;
        access_contract.patch.support_boundary =
            Some("patch access requires local helper confirmation before writing".to_string());
        AdapterCapabilities::new(
                self.id(),
                vec![
                    CapabilityReport::supported(Capability::Detection),
                    CapabilityReport::supported(Capability::Patching),
                    CapabilityReport::supported(Capability::ContainerAccess),
                    CapabilityReport::supported(Capability::CryptoAccess),
                    CapabilityReport::supported(Capability::CodecAccess),
                    CapabilityReport::supported(Capability::PatchBack),
                ],
                // identify-only matrix — Patching reports as
                // Supported but the access-contract `RequiresUserInput`
                // status keeps the registry gate strict.
                AdapterCapabilityMatrix::identify_only(
                    self.id(),
                    "contract-status preflight test adapter is identify-only; patch contract requires user input before any write",
                ),
            )
            .with_access_contract(access_contract)
    }

    fn detect(&self, _request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
        Ok(DetectionResult {
            adapter_id: self.id().to_string(),
            detected: true,
            engine_family: Some("contract-status-preflight-test".to_string()),
            engine_version: None,
            detected_variant: Some("requires-user-input".to_string()),
            evidence: vec![],
            requirements: vec![],
            capabilities: self.capabilities().reports,
        })
    }

    fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
        Err("profile is not used by the contract status preflight test".into())
    }

    fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
        Err("list_assets is not used by the contract status preflight test".into())
    }

    fn asset_inventory(
        &self,
        _request: AssetInventoryRequest<'_>,
    ) -> KaifuuResult<AssetInventoryManifest> {
        Err("asset_inventory is not used by the contract status preflight test".into())
    }

    fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
        Err("extract is not used by the contract status preflight test".into())
    }

    fn patch_preflight(&self, request: PatchPreflightRequest<'_>) -> KaifuuResult<PatchResult> {
        let access_profile = LayeredAccessProfile::plaintext_identity_for_asset(
            "source-json",
            "source.json",
            &[TextSurface::Dialogue],
            "$.lines[*]",
        );
        let preflight = LayeredAccessPreflightReport::from_access_profile(
            self.id(),
            "contract-status-preflight-test",
            "requires-user-input",
            &self.capabilities(),
            &access_profile,
        );
        Ok(PatchResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("patch-result", 82),
            patch_export_id: request.patch_export.patch_export_id.clone(),
            status: preflight.status,
            output_hash: content_hash("contract status preflight without output"),
            failures: preflight.failures,
        })
    }

    fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
        fs::create_dir_all(request.output_dir)?;
        fs::write(
            request
                .output_dir
                .join("contract-status-preflight-bypassed.txt"),
            "patch should not have run\n",
        )?;
        Ok(PatchResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("patch-result", 83),
            patch_export_id: request.patch_export.patch_export_id.clone(),
            status: OperationStatus::Passed,
            output_hash: content_hash("contract status preflight bypassed"),
            failures: vec![],
        })
    }

    fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
        Err("verify is not used by the contract status preflight test".into())
    }
}

fn contract_status_preflight_registry() -> AdapterRegistry {
    let mut registry = AdapterRegistry::new();
    registry.register(ContractStatusPreflightAdapter);
    registry
}

struct MaliciousPreflightBlockingPatchAdapter {
    failure: AdapterFailure,
}

impl MaliciousPreflightBlockingPatchAdapter {
    fn new(failure: AdapterFailure) -> Self {
        Self { failure }
    }
}

impl EngineAdapter for MaliciousPreflightBlockingPatchAdapter {
    fn id(&self) -> &'static str {
        "kaifuu.test.malicious-preflight"
    }

    fn name(&self) -> &'static str {
        "Kaifuu malicious preflight failure test adapter"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        AdapterCapabilities::new(
            self.id(),
            vec![
                CapabilityReport::supported(Capability::Detection),
                CapabilityReport::supported(Capability::Patching),
            ],
            // identify-only matrix — the malicious-preflight
            // fixture intentionally has no real inventory/extract/patch
            // path despite a Patching capability report.
            AdapterCapabilityMatrix::identify_only(
                self.id(),
                "malicious-preflight test adapter is identify-only at the registry gate",
            ),
        )
    }

    fn detect(&self, _request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
        Ok(DetectionResult {
            adapter_id: self.id().to_string(),
            detected: true,
            engine_family: Some("malicious-preflight-test".to_string()),
            engine_version: None,
            detected_variant: Some("writes-before-failure".to_string()),
            evidence: vec![],
            requirements: vec![],
            capabilities: self.capabilities().reports,
        })
    }

    fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
        Err("profile is not used by the malicious preflight test".into())
    }

    fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
        Err("list_assets is not used by the malicious preflight test".into())
    }

    fn asset_inventory(
        &self,
        _request: AssetInventoryRequest<'_>,
    ) -> KaifuuResult<AssetInventoryManifest> {
        Err("asset_inventory is not used by the malicious preflight test".into())
    }

    fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
        Err("extract is not used by the malicious preflight test".into())
    }

    fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
        fs::create_dir_all(request.output_dir)?;
        fs::write(
            request.output_dir.join("must-not-escape.txt"),
            "leaked output\n",
        )?;
        Ok(PatchResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("patch-result", 78),
            patch_export_id: request.patch_export.patch_export_id.clone(),
            status: OperationStatus::Failed,
            output_hash: content_hash("malicious preflight output"),
            failures: vec![self.failure.clone()],
        })
    }

    fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
        Err("verify is not used by the malicious preflight test".into())
    }
}

fn malicious_registry(failure: AdapterFailure) -> AdapterRegistry {
    let mut registry = AdapterRegistry::new();
    registry.register(MaliciousPreflightBlockingPatchAdapter::new(failure));
    registry
}

enum PatchFilesystemFailureMode {
    AdapterErrAfterWrite,
    ReportWriteCollision,
    SuccessfulWrite,
}

struct PatchFilesystemFailureAdapter {
    mode: PatchFilesystemFailureMode,
}

impl PatchFilesystemFailureAdapter {
    fn new(mode: PatchFilesystemFailureMode) -> Self {
        Self { mode }
    }
}

impl EngineAdapter for PatchFilesystemFailureAdapter {
    fn id(&self) -> &'static str {
        "kaifuu.test.patch-filesystem-failure"
    }

    fn name(&self) -> &'static str {
        "Kaifuu patch filesystem failure test adapter"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        AdapterCapabilities::new(
            self.id(),
            vec![
                CapabilityReport::supported(Capability::Detection),
                CapabilityReport::supported(Capability::Patching),
            ],
            // identify-only matrix — this test adapter
            // simulates filesystem failure during patch and never
            // promotes itself in the registry-side gate.
            AdapterCapabilityMatrix::identify_only(
                self.id(),
                "patch filesystem-failure test adapter is identify-only at the registry gate",
            ),
        )
    }

    fn detect(&self, _request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
        Ok(DetectionResult {
            adapter_id: self.id().to_string(),
            detected: true,
            engine_family: Some("patch-filesystem-failure-test".to_string()),
            engine_version: None,
            detected_variant: Some("cleanup".to_string()),
            evidence: vec![],
            requirements: vec![],
            capabilities: self.capabilities().reports,
        })
    }

    fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
        Err("profile is not used by the patch filesystem failure test".into())
    }

    fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
        Err("list_assets is not used by the patch filesystem failure test".into())
    }

    fn asset_inventory(
        &self,
        _request: AssetInventoryRequest<'_>,
    ) -> KaifuuResult<AssetInventoryManifest> {
        Err("asset_inventory is not used by the patch filesystem failure test".into())
    }

    fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
        Err("extract is not used by the patch filesystem failure test".into())
    }

    fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
        fs::write(
            request.output_dir.join("adapter-output.txt"),
            "staged output\n",
        )?;
        match self.mode {
            PatchFilesystemFailureMode::AdapterErrAfterWrite => {
                Err("adapter failed after writing staged output".into())
            }
            PatchFilesystemFailureMode::ReportWriteCollision => {
                fs::create_dir(request.output_dir.join("patch-result.json"))?;
                Ok(self.patch_result(request.patch_export))
            }
            PatchFilesystemFailureMode::SuccessfulWrite => {
                Ok(self.patch_result(request.patch_export))
            }
        }
    }

    fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
        Err("verify is not used by the patch filesystem failure test".into())
    }
}

impl PatchFilesystemFailureAdapter {
    fn patch_result(&self, patch_export: &PatchExport) -> PatchResult {
        PatchResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("patch-result", 79),
            patch_export_id: patch_export.patch_export_id.clone(),
            status: OperationStatus::Passed,
            output_hash: content_hash("patch filesystem failure output"),
            failures: vec![],
        }
    }
}

fn patch_filesystem_failure_registry(mode: PatchFilesystemFailureMode) -> AdapterRegistry {
    let mut registry = AdapterRegistry::new();
    registry.register(PatchFilesystemFailureAdapter::new(mode));
    registry
}

fn empty_patch_export(root: &Path, seed: usize) -> PathBuf {
    let patch_export = PatchExport {
        patch_export_id: deterministic_id("patch", seed),
        source_locale: "ja-JP".to_string(),
        target_locale: "en-US".to_string(),
        entries: vec![],
    };
    let patch_export_path = root.join("patch-export.json");
    write_json(&patch_export_path, &patch_export).unwrap();
    patch_export_path
}

fn assert_no_patch_staging_entries(root: &Path, output_name: &str) {
    let leaked_entries = fs::read_dir(root)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.contains(output_name) && name.contains("kaifuu-staging"))
        .collect::<Vec<_>>();
    assert_eq!(leaked_entries, Vec::<String>::new());
}
