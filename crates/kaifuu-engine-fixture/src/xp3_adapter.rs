use super::*;

impl EngineAdapter for Xp3ProfileDetectorAdapter {
    fn id(&self) -> &'static str {
        XP3_DETECTOR_ADAPTER_ID
    }

    fn name(&self) -> &'static str {
        "Kaifuu KiriKiri XP3 profile fixture adapter"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        let identify = LayeredAccessOperationContract {
            status: CapabilityStatus::Supported,
            required_capabilities: vec![Capability::Detection, Capability::ProfileGeneration],
            supported_surfaces: vec![SurfaceTransform::ArchiveEntry],
            supported_containers: vec![ContainerTransform::Xp3],
            supported_crypto: vec![CryptoTransform::NullKey, CryptoTransform::KeyProfile],
            supported_codecs: vec![CodecTransform::Unknown],
            supported_patch_back: vec![PatchBackTransform::Unsupported],
            support_boundary: Some("identify/profile generation reads only synthetic XP3 headers, markers, and source hashes".to_string()),
        };
        let inventory = LayeredAccessOperationContract {
            status: CapabilityStatus::Supported,
            required_capabilities: vec![Capability::AssetListing, Capability::AssetInventory],
            supported_surfaces: vec![SurfaceTransform::ArchiveEntry],
            supported_containers: vec![ContainerTransform::Xp3],
            supported_crypto: vec![CryptoTransform::NullKey, CryptoTransform::KeyProfile],
            supported_codecs: vec![CodecTransform::Unknown],
            supported_patch_back: vec![PatchBackTransform::Unsupported],
            support_boundary: Some("inventory parses synthetic plain XP3 index metadata and reports archive member rows; payload extraction, decompression, decryption, and patch-back are unsupported".to_string()),
        };
        let unsupported = |required_capabilities| LayeredAccessOperationContract {
            status: CapabilityStatus::Unsupported,
            required_capabilities,
            supported_surfaces: vec![],
            supported_containers: vec![],
            supported_crypto: vec![],
            supported_codecs: vec![],
            supported_patch_back: vec![],
            support_boundary: Some(XP3_SUPPORT_BOUNDARY.to_string()),
        };
        AdapterCapabilities::new(
            XP3_DETECTOR_ADAPTER_ID,
            vec![
                CapabilityReport::supported(Capability::Detection),
                CapabilityReport::supported(Capability::ProfileGeneration),
                CapabilityReport::supported(Capability::AssetListing),
                CapabilityReport::supported(Capability::AssetInventory),
                CapabilityReport::unsupported(
                    Capability::Extraction,
                    "the synthetic XP3 adapter is a detector profile fixture only.",
                ),
                CapabilityReport::unsupported(
                    Capability::Patching,
                    "the synthetic XP3 adapter does not patch or rebuild archives",
                ),
                CapabilityReport::unsupported(
                    Capability::ContainerAccess,
                    "XP3 container access is limited to synthetic plain-index inventory; extraction and rebuild are outside the detector profile",
                ),
                CapabilityReport::unsupported(
                    Capability::CryptoAccess,
                    "encrypted XP3 payload handling is outside the detector profile",
                ),
                CapabilityReport::unsupported(
                    Capability::CodecAccess,
                    "compressed XP3 payload handling and script decoding are outside the detector profile",
                ),
                CapabilityReport::unsupported(
                    Capability::PatchBack,
                    "XP3 patch-back/repack support is outside the detector profile",
                ),
                CapabilityReport::requires_user_input(
                    Capability::KeyProfile,
                    "encrypted XP3 diagnostics name the key requirement, but no key support is claimed",
                ),
                CapabilityReport::unsupported(
                    Capability::RuntimeVm,
                    "runtime support belongs to future Utsushi/KiriKiri work, not this detector fixture",
                ),
                CapabilityReport::unsupported(
                    Capability::EncryptedInput,
                    "encrypted payloads are identified only and are never decrypted by this profile",
                ),
                CapabilityReport::unsupported(
                    Capability::AssetTextPatching,
                    "no XP3 text surfaces are patched by this detector profile",
                ),
                CapabilityReport::unsupported(
                    Capability::DeltaPatching,
                    ".kaifuu delta packages do not apply to detector-only XP3 profiles",
                ),
                CapabilityReport::unsupported(
                    Capability::NonTextSurfaceExtraction,
                    "no non-text extraction or OCR is performed for XP3 detector fixtures",
                ),
            ],
            AdapterCapabilityMatrix::new(
                XP3_DETECTOR_ADAPTER_ID,
                CapabilityLevelStatus::supported(),
                CapabilityLevelStatus::supported(),
                CapabilityLevelStatus::unsupported(
                    "the synthetic XP3 adapter is a detector/profile fixture only; payload extraction, decompression, decryption, and patch-back are outside the detector profile",
                ),
                CapabilityLevelStatus::unsupported(
                    "XP3 patch-back/repack support is outside the detector profile (KAIFUU-XP3 patch backlog)",
                ),
            ),
        )
        .with_access_contract(LayeredAccessCapabilityContract {
            identify,
            inventory,
            extract: unsupported(vec![Capability::Extraction]),
            patch: unsupported(vec![Capability::Patching, Capability::PatchBack]),
        })
    }

    fn detect(&self, request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
        let state = Self::inspect(request.game_dir);
        let detected = Self::is_detected(state.variant);
        let diagnostic_only = !detected && state.variant == Xp3FixtureVariant::Unknown;
        let mut result = DetectionResult {
            adapter_id: XP3_DETECTOR_ADAPTER_ID.to_string(),
            detected,
            engine_family: detected.then(|| "kiri_kiri_xp3".to_string()),
            engine_version: None,
            detected_variant: (detected || diagnostic_only)
                .then(|| Self::detected_variant(state.variant).to_string()),
            evidence: vec![DetectionEvidence {
                path: XP3_ARCHIVE_PATH.to_string(),
                kind: "synthetic_xp3_archive_signature".to_string(),
                status: evidence_status(state.archive_exists, state.archive_signature),
                detail: signature_detail(
                    state.archive_exists,
                    state.archive_signature,
                    "XP3 synthetic archive signature",
                ),
            }],
            requirements: if detected || diagnostic_only {
                state.detection_requirements()
            } else {
                vec![]
            },
            capabilities: self.capabilities().reports,
        };
        result.normalize();
        Ok(result)
    }

    fn profile(&self, request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
        self.profile_from_state(Self::inspect(request.game_dir))
    }

    fn list_assets(&self, request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
        let state = Self::inspect(request.game_dir);
        if !Self::can_inventory(state.variant) {
            return Err(Self::diagnostic_error(Self::invalid_input_failure(
                state.variant,
            )));
        }
        Ok(AssetList {
            adapter_id: XP3_DETECTOR_ADAPTER_ID.to_string(),
            assets: state.asset_profiles(),
        })
    }

    fn asset_inventory(
        &self,
        request: AssetInventoryRequest<'_>,
    ) -> KaifuuResult<AssetInventoryManifest> {
        self.inventory_from_state(Self::inspect(request.game_dir))
    }

    fn extract(&self, request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
        let state = Self::inspect(request.game_dir);
        if state.variant == Xp3FixtureVariant::Encrypted {
            return Err(Self::diagnostic_error(Self::crypto_boundary_failure(
                state.variant,
            )));
        }
        if state.variant == Xp3FixtureVariant::HelperRequired {
            return Err(Self::diagnostic_error(Self::helper_required_failure(
                state.variant,
            )));
        }
        Err(Self::diagnostic_error(Self::parser_boundary_failure(
            state.variant,
        )))
    }

    fn patch_preflight(&self, request: PatchPreflightRequest<'_>) -> KaifuuResult<PatchResult> {
        let state = Self::inspect(request.game_dir);
        Ok(self
            .unsupported_patch_result(request.patch_export.patch_export_id.clone(), state.variant))
    }

    fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
        let state = Self::inspect(request.game_dir);
        Ok(self
            .unsupported_patch_result(request.patch_export.patch_export_id.clone(), state.variant))
    }

    fn verify(&self, request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
        let state = Self::inspect(request.game_dir);
        Ok(VerificationResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("xp3-verify", 95),
            status: OperationStatus::Failed,
            output_hash: content_hash(XP3_SUPPORT_BOUNDARY),
            failures: vec![Self::unsupported_failure(
                SemanticErrorCode::UnsupportedLayeredTransform,
                Capability::RuntimeVm,
                Self::detected_variant(state.variant),
                "runtime/parser verification is outside the XP3 detector profile",
                "use detect, profile, or asset-inventory only",
            )],
        })
    }
}
