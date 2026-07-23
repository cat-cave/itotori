use super::*;

impl EngineAdapter for SiglusProfileDetectorAdapter {
    fn id(&self) -> &'static str {
        SIGLUS_DETECTOR_ADAPTER_ID
    }

    fn name(&self) -> &'static str {
        "Kaifuu Siglus detector profile fixture adapter"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        let identify = LayeredAccessOperationContract {
            status: CapabilityStatus::Supported,
            required_capabilities: vec![Capability::Detection, Capability::ProfileGeneration],
            supported_surfaces: vec![SurfaceTransform::Identity],
            supported_containers: vec![ContainerTransform::LooseFile, ContainerTransform::SiglusPck],
            supported_crypto: vec![CryptoTransform::Unknown],
            supported_codecs: vec![CodecTransform::Unknown],
            supported_patch_back: vec![PatchBackTransform::Unsupported],
            support_boundary: Some("identify/profile generation reads only synthetic file names, signatures, and source hashes".to_string()),
        };
        let inventory = LayeredAccessOperationContract {
            status: CapabilityStatus::Supported,
            required_capabilities: vec![Capability::AssetListing, Capability::AssetInventory],
            supported_surfaces: vec![SurfaceTransform::Identity, SurfaceTransform::ArchiveEntry, SurfaceTransform::BinaryOffset],
            supported_containers: vec![ContainerTransform::LooseFile, ContainerTransform::SiglusPck],
            supported_crypto: vec![CryptoTransform::Unknown],
            supported_codecs: vec![CodecTransform::Unknown],
            supported_patch_back: vec![PatchBackTransform::Unsupported],
            support_boundary: Some("inventory reports only top-level Scene.pck/Gameexe.dat assets and hashes; no archive entry parser is claimed".to_string()),
        };
        let unsupported = |required_capabilities| LayeredAccessOperationContract {
            status: CapabilityStatus::Unsupported,
            required_capabilities,
            supported_surfaces: vec![],
            supported_containers: vec![],
            supported_crypto: vec![],
            supported_codecs: vec![],
            supported_patch_back: vec![],
            support_boundary: Some(SIGLUS_SUPPORT_BOUNDARY.to_string()),
        };
        AdapterCapabilities::new(
            SIGLUS_DETECTOR_ADAPTER_ID,
            vec![
                CapabilityReport::supported(Capability::Detection),
                CapabilityReport::supported(Capability::ProfileGeneration),
                CapabilityReport::supported(Capability::AssetListing),
                CapabilityReport::supported(Capability::AssetInventory),
                CapabilityReport::unsupported(
                    Capability::Extraction,
                    "the synthetic Siglus adapter is a detector profile fixture only.",
                ),
                CapabilityReport::unsupported(
                    Capability::Patching,
                    "the synthetic Siglus adapter does not patch or rebuild assets",
                ),
                CapabilityReport::unsupported(
                    Capability::ContainerAccess,
                    "Scene.pck archive parsing is outside the detector profile",
                ),
                CapabilityReport::unsupported(
                    Capability::CryptoAccess,
                    "encrypted Siglus payload handling is outside the detector profile",
                ),
                CapabilityReport::unsupported(
                    Capability::CodecAccess,
                    "Siglus script decode/decompile support is outside the detector profile",
                ),
                CapabilityReport::unsupported(
                    Capability::PatchBack,
                    "Siglus patch-back/repack support is outside the detector profile",
                ),
                CapabilityReport::requires_user_input(
                    Capability::KeyProfile,
                    "encrypted payload diagnostics name the key requirement, but no key support is claimed",
                ),
                CapabilityReport::unsupported(
                    Capability::RuntimeVm,
                    "runtime support belongs to future Utsushi/Siglus work, not this detector fixture",
                ),
                CapabilityReport::unsupported(
                    Capability::EncryptedInput,
                    "encrypted payloads are identified only and are never decrypted by this profile",
                ),
                CapabilityReport::unsupported(
                    Capability::AssetTextPatching,
                    "no Siglus text surfaces are patched by this detector profile",
                ),
                CapabilityReport::unsupported(
                    Capability::DeltaPatching,
                    ".kaifuu delta packages do not apply to detector-only Siglus profiles",
                ),
                CapabilityReport::unsupported(
                    Capability::NonTextSurfaceExtraction,
                    "no non-text extraction or OCR is performed for Siglus detector fixtures",
                ),
            ],
            AdapterCapabilityMatrix::identify_only(
                SIGLUS_DETECTOR_ADAPTER_ID,
                "Siglus detector profile is identify-only; Scene.pck/Gameexe.dat archive parsing, extraction, decryption, and patch-back are unsupported",
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
        let diagnostic_only = !detected && state.variant != SiglusFixtureVariant::NotSiglus;
        let mut result = DetectionResult {
            adapter_id: SIGLUS_DETECTOR_ADAPTER_ID.to_string(),
            detected,
            engine_family: detected.then(|| "siglus".to_string()),
            engine_version: None,
            detected_variant: (detected || diagnostic_only)
                .then(|| Self::detected_variant(state.variant).to_string()),
            evidence: vec![
                DetectionEvidence {
                    path: SIGLUS_SCENE_PATH.to_string(),
                    kind: if state.scene_real {
                        "real_siglus_scene_pck_signature".to_string()
                    } else {
                        "synthetic_siglus_scene_pck_signature".to_string()
                    },
                    status: evidence_status(state.scene_exists, state.scene_signature),
                    detail: signature_detail(
                        state.scene_exists,
                        state.scene_signature,
                        if state.scene_real {
                            "Scene.pck real archive-header signature"
                        } else {
                            "Scene.pck synthetic signature"
                        },
                    ),
                },
                DetectionEvidence {
                    path: SIGLUS_GAMEEXE_PATH.to_string(),
                    kind: if state.gameexe_real {
                        "real_siglus_gameexe_dat_signature".to_string()
                    } else {
                        "synthetic_siglus_gameexe_dat_signature".to_string()
                    },
                    status: evidence_status(state.gameexe_exists, state.gameexe_signature),
                    detail: signature_detail(
                        state.gameexe_exists,
                        state.gameexe_signature,
                        if state.gameexe_real {
                            "Gameexe.dat real archive-header signature"
                        } else {
                            "Gameexe.dat synthetic signature"
                        },
                    ),
                },
            ],
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

    fn is_diagnostic_candidate(&self, detection: &DetectionResult) -> bool {
        // Adapter-owned opt-in: only the Siglus diagnostic-only fixture
        // variants (incomplete pair / unknown named files) may be routed for
        // structured AdapterFailure. Variant presence alone is not consent.
        !detection.detected
            && matches!(
                detection.detected_variant.as_deref(),
                Some(
                    "scene-pck-missing-gameexe-dat"
                        | "gameexe-dat-missing-scene-pck"
                        | "unknown-siglus-named-files"
                )
            )
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
            adapter_id: SIGLUS_DETECTOR_ADAPTER_ID.to_string(),
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
        let variant = Self::detected_variant(state.variant);
        Err(Self::diagnostic_error(Self::parser_boundary_failure(
            variant,
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
        let variant = Self::detected_variant(state.variant).to_string();
        Ok(VerificationResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("siglus-verify", 91),
            status: OperationStatus::Failed,
            output_hash: content_hash(SIGLUS_SUPPORT_BOUNDARY),
            failures: vec![Self::unsupported_failure(
                SemanticErrorCode::UnsupportedLayeredTransform,
                Capability::RuntimeVm,
                variant,
                SIGLUS_SCENE_PATH,
                "runtime/parser verification is outside the Siglus detector profile",
                "use detect, profile, or asset-inventory only",
            )],
        })
    }
}
