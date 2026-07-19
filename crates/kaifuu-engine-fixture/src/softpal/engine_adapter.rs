use super::*;

impl EngineAdapter for SoftpalProfileDetectorAdapter {
    fn id(&self) -> &'static str {
        SOFTPAL_DETECTOR_ADAPTER_ID
    }

    fn name(&self) -> &'static str {
        "Kaifuu Softpal ADV (Amuse Craft/Pal) detector adapter"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        const PATCH_LIMITATION: &str = "dialogue + choice text is patched back by rebuilding TEXT.DAT (re-encrypting when the original was) and repointing SCRIPT.SRC as loose files; PAC repack, speaker-name/non-text surfaces, and the full Sv20 opcode table are not claimed";
        let identify = LayeredAccessOperationContract {
            status: CapabilityStatus::Supported,
            required_capabilities: vec![Capability::Detection, Capability::ProfileGeneration],
            supported_surfaces: vec![SurfaceTransform::Identity],
            supported_containers: vec![ContainerTransform::LooseFile],
            supported_crypto: vec![CryptoTransform::NullKey],
            supported_codecs: vec![CodecTransform::Unknown],
            supported_patch_back: vec![PatchBackTransform::Unsupported],
            support_boundary: Some(
                "identify/profile reads only file names, container magics, and script signatures"
                    .to_string(),
            ),
        };
        let inventory = LayeredAccessOperationContract {
            status: CapabilityStatus::Supported,
            required_capabilities: vec![Capability::AssetListing, Capability::AssetInventory],
            supported_surfaces: vec![SurfaceTransform::ArchiveEntry],
            supported_containers: vec![ContainerTransform::Archive, ContainerTransform::LooseFile],
            supported_crypto: vec![CryptoTransform::NullKey],
            supported_codecs: vec![CodecTransform::BinaryTable],
            supported_patch_back: vec![PatchBackTransform::Unsupported],
            support_boundary: Some(
                "enumerates the PAC entry table (or the loose SCRIPT.SRC/TEXT.DAT pair); text extraction is claimed only for the script/text surfaces"
                    .to_string(),
            ),
        };
        let extract = LayeredAccessOperationContract {
            status: CapabilityStatus::Supported,
            required_capabilities: vec![
                Capability::Extraction,
                Capability::ContainerAccess,
                Capability::CryptoAccess,
                Capability::CodecAccess,
            ],
            supported_surfaces: vec![SurfaceTransform::BinaryOffset],
            supported_containers: vec![ContainerTransform::Archive, ContainerTransform::LooseFile],
            supported_crypto: vec![CryptoTransform::NullKey],
            supported_codecs: vec![
                CodecTransform::BytecodeDecompile,
                CodecTransform::ShiftJisText,
                CodecTransform::BinaryTable,
            ],
            supported_patch_back: vec![PatchBackTransform::Unsupported],
            support_boundary: Some(
                "extracts the TEXT-SHOW (dialogue) + text-bearing SELECT (choice) surfaces of SCRIPT.SRC, resolving 4-byte TEXT.DAT pointers to decoded cp932 lines"
                    .to_string(),
            ),
        };
        let patch = LayeredAccessOperationContract {
            status: CapabilityStatus::Limited,
            required_capabilities: vec![Capability::Patching, Capability::PatchBack],
            supported_surfaces: vec![SurfaceTransform::BinaryOffset],
            supported_containers: vec![ContainerTransform::LooseFile],
            supported_crypto: vec![CryptoTransform::NullKey],
            supported_codecs: vec![CodecTransform::ShiftJisText, CodecTransform::BinaryTable],
            supported_patch_back: vec![PatchBackTransform::ReplaceFile],
            support_boundary: Some(PATCH_LIMITATION.to_string()),
        };
        AdapterCapabilities::new(
            SOFTPAL_DETECTOR_ADAPTER_ID,
            vec![
                CapabilityReport::supported(Capability::Detection),
                CapabilityReport::supported(Capability::ProfileGeneration),
                CapabilityReport::supported(Capability::AssetListing),
                CapabilityReport::supported(Capability::AssetInventory),
                CapabilityReport::supported(Capability::Extraction),
                CapabilityReport::supported(Capability::Verification),
                CapabilityReport::limited(Capability::Patching, PATCH_LIMITATION),
                CapabilityReport::supported(Capability::ContainerAccess),
                CapabilityReport::supported(Capability::CryptoAccess),
                CapabilityReport::supported(Capability::CodecAccess),
                CapabilityReport::limited(Capability::PatchBack, PATCH_LIMITATION),
                CapabilityReport::unsupported(
                    Capability::RuntimeVm,
                    "runtime support belongs to future Utsushi/Softpal work, not this adapter",
                ),
                CapabilityReport::supported(Capability::EncryptedInput),
                CapabilityReport::limited(Capability::AssetTextPatching, PATCH_LIMITATION),
                CapabilityReport::unsupported(
                    Capability::DeltaPatching,
                    "Softpal patch-back emits rebuilt loose files, not a .kaifuu delta package",
                ),
                CapabilityReport::unsupported(
                    Capability::NonTextSurfaceExtraction,
                    "no non-text extraction or OCR is performed by the Softpal adapter",
                ),
            ],
            AdapterCapabilityMatrix::new(
                SOFTPAL_DETECTOR_ADAPTER_ID,
                CapabilityLevelStatus::Supported,
                CapabilityLevelStatus::Supported,
                CapabilityLevelStatus::Supported,
                CapabilityLevelStatus::partial([PATCH_LIMITATION.to_string()]),
            ),
        )
        .with_access_contract(LayeredAccessCapabilityContract {
            identify,
            inventory,
            extract,
            patch,
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
        if !Self::is_detected(state.variant) {
            return Err(Self::diagnostic_error(Self::unsupported_failure(
                SemanticErrorCode::UnknownEngineVariant,
                Capability::AssetListing,
                Self::detected_variant(state.variant),
                SOFTPAL_DATA_PAC_NAME,
                "list-assets requires a recognised Softpal title (Pal.dll / PAC+scripts / loose scripts)",
                "run detect against a Softpal title first",
            )));
        }
        self.build_asset_list(request.game_dir)
    }

    fn asset_inventory(
        &self,
        request: AssetInventoryRequest<'_>,
    ) -> KaifuuResult<AssetInventoryManifest> {
        let state = Self::inspect(request.game_dir);
        if !Self::is_detected(state.variant) {
            return Err(Self::diagnostic_error(Self::unsupported_failure(
                SemanticErrorCode::UnknownEngineVariant,
                Capability::AssetInventory,
                Self::detected_variant(state.variant),
                SOFTPAL_DATA_PAC_NAME,
                "asset-inventory requires a recognised Softpal title (Pal.dll / PAC+scripts / loose scripts)",
                "run detect against a Softpal title first",
            )));
        }
        self.build_asset_inventory(request.game_dir)
    }

    fn extract(&self, request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
        let state = Self::inspect(request.game_dir);
        if !Self::is_detected(state.variant) {
            return Err(Self::diagnostic_error(Self::parser_boundary_failure(
                Self::detected_variant(state.variant),
            )));
        }
        let scripts = Self::resolve_scripts(request.game_dir)?;
        let (bridge, warnings) = Self::build_bridge(&scripts)?;
        let profile = self.profile_from_state(state)?;
        Ok(ExtractionResult {
            adapter_id: SOFTPAL_DETECTOR_ADAPTER_ID.to_string(),
            profile,
            bridge,
            warnings,
        })
    }

    fn patch_preflight(&self, request: PatchPreflightRequest<'_>) -> KaifuuResult<PatchResult> {
        // The dialogue/choice patch-back rebuilds the whole TEXT.DAT pool, so
        // there is no fixed slot budget to preflight; the only hard constraint
        // (cp932-encodability) is enforced by the patch itself. Preflight is a
        // pass unless the title is unrecognised.
        let state = Self::inspect(request.game_dir);
        if !Self::is_detected(state.variant) {
            return Ok(self.unsupported_patch_result(
                request.patch_export.patch_export_id.clone(),
                state.variant,
            ));
        }
        Ok(PatchResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("softpal-preflight", 12),
            patch_export_id: request.patch_export.patch_export_id.clone(),
            status: OperationStatus::Passed,
            output_hash: content_hash(SOFTPAL_SUPPORT_BOUNDARY),
            failures: vec![],
        })
    }

    fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
        let state = Self::inspect(request.game_dir);
        if !Self::is_detected(state.variant) {
            return Ok(self.unsupported_patch_result(
                request.patch_export.patch_export_id.clone(),
                state.variant,
            ));
        }
        self.run_patch(request)
    }

    fn verify(&self, request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
        let state = Self::inspect(request.game_dir);
        if !Self::is_detected(state.variant) {
            return Ok(VerificationResult {
                schema_version: "0.1.0".to_string(),
                patch_result_id: deterministic_id("softpal-verify", 12),
                status: OperationStatus::Failed,
                output_hash: content_hash(SOFTPAL_SUPPORT_BOUNDARY),
                failures: vec![Self::unsupported_failure(
                    SemanticErrorCode::UnknownEngineVariant,
                    Capability::Verification,
                    Self::detected_variant(state.variant),
                    SOFTPAL_DATA_PAC_NAME,
                    "verify requires a recognised Softpal title",
                    "run detect against a Softpal title first",
                )],
            });
        }
        self.run_verify(request)
    }
}
