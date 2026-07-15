use super::*;

impl EngineAdapter for SoftpalProfileDetectorAdapter {
    fn id(&self) -> &'static str {
        SOFTPAL_DETECTOR_ADAPTER_ID
    }

    fn name(&self) -> &'static str {
        "Kaifuu Softpal ADV (Amuse Craft/Pal) detector adapter"
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
                "identify/profile reads only file names, container magics, and script signatures"
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
            support_boundary: Some(SOFTPAL_SUPPORT_BOUNDARY.to_string()),
        };
        AdapterCapabilities::new(
            SOFTPAL_DETECTOR_ADAPTER_ID,
            vec![
                CapabilityReport::supported(Capability::Detection),
                CapabilityReport::supported(Capability::ProfileGeneration),
                CapabilityReport::unsupported(
                    Capability::AssetListing,
                    "Softpal PAC entry listing is a later Softpal node, not the detector",
                ),
                CapabilityReport::unsupported(
                    Capability::AssetInventory,
                    "Softpal asset inventory is a later Softpal node, not the detector",
                ),
                CapabilityReport::unsupported(
                    Capability::Extraction,
                    "the Softpal detector does not extract PAC archives",
                ),
                CapabilityReport::unsupported(
                    Capability::Patching,
                    "the Softpal detector does not patch or rebuild Softpal assets",
                ),
                CapabilityReport::unsupported(
                    Capability::ContainerAccess,
                    "PAC archive parsing is outside the detector",
                ),
                CapabilityReport::unsupported(
                    Capability::CryptoAccess,
                    "TEXT.DAT/PAC decryption is outside the detector",
                ),
                CapabilityReport::unsupported(
                    Capability::CodecAccess,
                    "SCRIPT.SRC decompilation / TEXT.DAT decode is outside the detector",
                ),
                CapabilityReport::unsupported(
                    Capability::PatchBack,
                    "Softpal patch-back/repack support is outside the detector",
                ),
                CapabilityReport::unsupported(
                    Capability::RuntimeVm,
                    "runtime support belongs to future Utsushi/Softpal work, not this detector",
                ),
                CapabilityReport::unsupported(
                    Capability::EncryptedInput,
                    "encrypted TEXT.DAT payloads are identified only, never decrypted",
                ),
                CapabilityReport::unsupported(
                    Capability::AssetTextPatching,
                    "no Softpal text surfaces are patched by this detector",
                ),
                CapabilityReport::unsupported(
                    Capability::DeltaPatching,
                    ".kaifuu delta packages do not apply to the detector-only Softpal profile",
                ),
                CapabilityReport::unsupported(
                    Capability::NonTextSurfaceExtraction,
                    "no non-text extraction or OCR is performed by the Softpal detector",
                ),
            ],
            AdapterCapabilityMatrix::identify_only(
                SOFTPAL_DETECTOR_ADAPTER_ID,
                "Softpal detector is identify-only; PAC extraction, SCRIPT.SRC decompilation, TEXT.DAT decode/decryption, and patch-back are unsupported (later Softpal nodes)",
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
        let diagnostic_only = state.variant == SoftpalVariant::UnknownPacOnly;
        let mut result = DetectionResult {
            adapter_id: SOFTPAL_DETECTOR_ADAPTER_ID.to_string(),
            detected,
            engine_family: detected.then(|| "softpal".to_string()),
            engine_version: None,
            detected_variant: (detected || diagnostic_only)
                .then(|| Self::detected_variant(state.variant).to_string()),
            evidence: vec![
                DetectionEvidence {
                    path: format!("{SOFTPAL_PAL_DLL_DIR}/{SOFTPAL_PAL_DLL_NAME}"),
                    kind: "softpal_pal_dll".to_string(),
                    status: if state.pal_dll_present {
                        EvidenceStatus::Matched
                    } else {
                        EvidenceStatus::Missing
                    },
                    detail: if state.pal_dll_present {
                        "dll/Pal.dll present (definitive Softpal engine marker)".to_string()
                    } else {
                        "dll/Pal.dll not found".to_string()
                    },
                },
                DetectionEvidence {
                    path: state
                        .scripts_pac_name
                        .clone()
                        .unwrap_or_else(|| SOFTPAL_DATA_PAC_NAME.to_string()),
                    kind: "softpal_pac_script_text_entries".to_string(),
                    status: if state.pac_scripts {
                        EvidenceStatus::Matched
                    } else if state.pac_present {
                        EvidenceStatus::Invalid
                    } else {
                        EvidenceStatus::Missing
                    },
                    detail: if state.pac_scripts {
                        "PAC archive (\"PAC \" magic) lists SCRIPT.SRC and TEXT.DAT entries"
                            .to_string()
                    } else if state.pac_present {
                        "a .pac with \"PAC \" magic is present but does not list SCRIPT.SRC/TEXT.DAT"
                            .to_string()
                    } else {
                        "no Softpal PAC archive found".to_string()
                    },
                },
                DetectionEvidence {
                    path: SOFTPAL_SCRIPT_SRC_NAME.to_string(),
                    kind: "softpal_script_src_magic".to_string(),
                    status: if state.loose_script_src {
                        EvidenceStatus::Matched
                    } else {
                        EvidenceStatus::Missing
                    },
                    detail: if state.loose_script_src {
                        "loose SCRIPT.SRC opens with the Sv<nn> script magic".to_string()
                    } else {
                        "no loose SCRIPT.SRC with the Sv<nn> magic".to_string()
                    },
                },
                DetectionEvidence {
                    path: SOFTPAL_TEXT_DAT_NAME.to_string(),
                    kind: "softpal_text_dat_magic".to_string(),
                    status: if state.loose_text_dat {
                        EvidenceStatus::Matched
                    } else {
                        EvidenceStatus::Missing
                    },
                    detail: if state.loose_text_dat {
                        format!(
                            "loose TEXT.DAT opens with [$_]TEXT_LIST__ (enc flag: {})",
                            state.enc_flag_label()
                        )
                    } else {
                        "no loose TEXT.DAT with the [$_]TEXT_LIST__ magic".to_string()
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
            SOFTPAL_DATA_PAC_NAME,
            "Softpal PAC entry listing is a later Softpal node, not the detector",
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
            SOFTPAL_DATA_PAC_NAME,
            "Softpal asset inventory is a later Softpal node, not the detector",
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
            patch_result_id: deterministic_id("softpal-verify", 12),
            status: OperationStatus::Failed,
            output_hash: content_hash(SOFTPAL_SUPPORT_BOUNDARY),
            failures: vec![Self::unsupported_failure(
                SemanticErrorCode::UnsupportedLayeredTransform,
                Capability::RuntimeVm,
                Self::detected_variant(state.variant),
                SOFTPAL_DATA_PAC_NAME,
                "runtime/parser verification is outside the Softpal detector",
                "use detect or profile only",
            )],
        })
    }
}
