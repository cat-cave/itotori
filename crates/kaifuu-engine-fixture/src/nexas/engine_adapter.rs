use super::*;

impl EngineAdapter for NexasProfileDetectorAdapter {
    fn id(&self) -> &'static str {
        NEXAS_DETECTOR_ADAPTER_ID
    }

    fn name(&self) -> &'static str {
        "Kaifuu NeXAS engine detector adapter"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        let identify = LayeredAccessOperationContract {
            status: CapabilityStatus::Supported,
            required_capabilities: vec![Capability::Detection, Capability::ProfileGeneration],
            supported_surfaces: vec![SurfaceTransform::Identity],
            supported_containers: vec![ContainerTransform::LooseFile],
            supported_crypto: vec![CryptoTransform::Unknown],
            supported_codecs: vec![CodecTransform::Unknown],
            supported_patch_back: vec![PatchBackTransform::Unsupported],
            support_boundary: Some(
                "identify/profile reads only file names and the fixed PAC container header"
                    .to_string(),
            ),
        };
        let unsupported = |required_capabilities| LayeredAccessOperationContract {
            status: CapabilityStatus::Unsupported,
            required_capabilities,
            supported_surfaces: vec![],
            supported_containers: vec![],
            supported_crypto: vec![],
            supported_codecs: vec![],
            supported_patch_back: vec![],
            support_boundary: Some(NEXAS_SUPPORT_BOUNDARY.to_string()),
        };
        AdapterCapabilities::new(
            NEXAS_DETECTOR_ADAPTER_ID,
            vec![
                CapabilityReport::supported(Capability::Detection),
                CapabilityReport::supported(Capability::ProfileGeneration),
                CapabilityReport::unsupported(
                    Capability::AssetListing,
                    "NeXAS PAC entry listing is provided by the kaifuu-nexas crate, not the detector",
                ),
                CapabilityReport::unsupported(
                    Capability::AssetInventory,
                    "NeXAS asset inventory is outside the detector",
                ),
                CapabilityReport::unsupported(
                    Capability::Extraction,
                    "the NeXAS detector does not extract PAC archives (use kaifuu-nexas)",
                ),
                CapabilityReport::unsupported(
                    Capability::Patching,
                    "the NeXAS detector does not patch or rebuild NeXAS assets",
                ),
                CapabilityReport::unsupported(
                    Capability::ContainerAccess,
                    "PAC container access is provided by the kaifuu-nexas crate",
                ),
                CapabilityReport::unsupported(
                    Capability::CryptoAccess,
                    "NeXAS archives are unencrypted; no crypto access is claimed by the detector",
                ),
                CapabilityReport::unsupported(
                    Capability::CodecAccess,
                    "per-entry decompression is provided by the kaifuu-nexas crate",
                ),
                CapabilityReport::unsupported(
                    Capability::PatchBack,
                    "NeXAS patch-back/repack support is outside the detector",
                ),
                CapabilityReport::unsupported(
                    Capability::RuntimeVm,
                    "runtime support belongs to future Utsushi/NeXAS work, not this detector",
                ),
                CapabilityReport::unsupported(
                    Capability::EncryptedInput,
                    "NeXAS PAC payloads are compressed, not encrypted",
                ),
                CapabilityReport::unsupported(
                    Capability::AssetTextPatching,
                    "no NeXAS text surfaces are patched by this detector",
                ),
                CapabilityReport::unsupported(
                    Capability::DeltaPatching,
                    ".kaifuu delta packages do not apply to the detector-only NeXAS profile",
                ),
                CapabilityReport::unsupported(
                    Capability::NonTextSurfaceExtraction,
                    "no non-text extraction or OCR is performed by the NeXAS detector",
                ),
            ],
            AdapterCapabilityMatrix::identify_only(
                NEXAS_DETECTOR_ADAPTER_ID,
                "NeXAS detector is identify-only; PAC extraction + per-entry decompression are provided by the kaifuu-nexas crate",
            ),
        )
        .with_access_contract(LayeredAccessCapabilityContract {
            identify,
            inventory: unsupported(vec![Capability::AssetListing, Capability::AssetInventory]),
            extract: unsupported(vec![Capability::Extraction]),
            patch: unsupported(vec![Capability::Patching, Capability::PatchBack]),
        })
    }

    fn detect(&self, request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
        let state = Self::inspect(request.game_dir);
        let detected = Self::is_detected(state.variant);
        let diagnostic_only = state.variant == NexasVariant::UnknownPacOnly;
        let mut result = DetectionResult {
            adapter_id: NEXAS_DETECTOR_ADAPTER_ID.to_string(),
            detected,
            engine_family: detected.then(|| "nexas".to_string()),
            engine_version: None,
            detected_variant: (detected || diagnostic_only)
                .then(|| Self::detected_variant(state.variant).to_string()),
            evidence: vec![
                DetectionEvidence {
                    path: state
                        .primary_pac_name
                        .clone()
                        .unwrap_or_else(|| "*.pac".to_string()),
                    kind: "nexas_pac_magic".to_string(),
                    status: if state.nexas_pac {
                        EvidenceStatus::Matched
                    } else if state.unknown_pac_magic {
                        EvidenceStatus::Invalid
                    } else {
                        EvidenceStatus::Missing
                    },
                    detail: if state.nexas_pac {
                        format!(
                            "a .pac opens with the NeXAS \"PAC\\0\" magic (50 41 43 00) and a sane header (pack_types: {})",
                            state
                                .pack_types
                                .iter()
                                .map(u32::to_string)
                                .collect::<Vec<_>>()
                                .join(",")
                        )
                    } else if state.unknown_pac_magic {
                        "a .pac opens with the \"PAC\\0\" magic but the count/pack_type header is out of range".to_string()
                    } else {
                        "no .pac with the NeXAS \"PAC\\0\" magic (Softpal \"PAC \" is a different engine)".to_string()
                    },
                },
                DetectionEvidence {
                    path: "*.pac".to_string(),
                    kind: "nexas_category_archives".to_string(),
                    status: if state.category_hits.is_empty() {
                        EvidenceStatus::Missing
                    } else {
                        EvidenceStatus::Matched
                    },
                    detail: if state.category_hits.is_empty() {
                        "no NeXAS category-archive names (Bgm/Face/Script/System/Voice*.pac) present"
                            .to_string()
                    } else {
                        format!(
                            "NeXAS category archives present: {}",
                            state
                                .category_hits
                                .iter()
                                .map(|hit| format!("{hit}.pac"))
                                .collect::<Vec<_>>()
                                .join(", ")
                        )
                    },
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

    fn profile(&self, request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
        self.profile_from_state(Self::inspect(request.game_dir))
    }

    fn list_assets(&self, request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
        let state = Self::inspect(request.game_dir);
        Err(Self::diagnostic_error(Self::unsupported_failure(
            SemanticErrorCode::MissingContainerCapability,
            Capability::AssetListing,
            Self::detected_variant(state.variant),
            "*.pac",
            "NeXAS PAC entry listing is provided by the kaifuu-nexas crate, not the detector",
            "use identify (detect/profile) output only",
        )))
    }

    fn asset_inventory(
        &self,
        request: AssetInventoryRequest<'_>,
    ) -> KaifuuResult<AssetInventoryManifest> {
        let state = Self::inspect(request.game_dir);
        Err(Self::diagnostic_error(Self::unsupported_failure(
            SemanticErrorCode::MissingContainerCapability,
            Capability::AssetInventory,
            Self::detected_variant(state.variant),
            "*.pac",
            "NeXAS asset inventory is outside the detector",
            "use identify (detect/profile) output only",
        )))
    }

    fn extract(&self, request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
        let state = Self::inspect(request.game_dir);
        Err(Self::diagnostic_error(Self::parser_boundary_failure(
            Self::detected_variant(state.variant),
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
            patch_result_id: deterministic_id("nexas-verify", 12),
            status: OperationStatus::Failed,
            output_hash: content_hash(NEXAS_SUPPORT_BOUNDARY),
            failures: vec![Self::unsupported_failure(
                SemanticErrorCode::UnsupportedLayeredTransform,
                Capability::RuntimeVm,
                Self::detected_variant(state.variant),
                "*.pac",
                "runtime/parser verification is outside the NeXAS detector",
                "use detect or profile only",
            )],
        })
    }
}
