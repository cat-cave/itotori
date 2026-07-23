use super::*;

impl EngineAdapter for RealLiveProfileDetectorAdapter {
    fn id(&self) -> &'static str {
        REALLIVE_DETECTOR_ADAPTER_ID
    }

    fn name(&self) -> &'static str {
        "Kaifuu RealLive Scene/SEEN inventory adapter"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        self.adapter_capabilities()
    }

    fn detect(&self, request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
        let state = Self::inspect(request.game_dir);
        let detected = Self::is_detected(state.variant);
        let diagnostic_only = !detected && state.variant != RealLiveFixtureVariant::NotRealLive;
        // when the depth-N walk found a nested REALLIVEDATA/
        // the SEEN.TXT/SEEN.GAN/Gameexe.ini evidence paths are reported
        // relative to the game root with the REALLIVEDATA/ prefix so
        // downstream tools (and human auditors) see exactly where the
        // detector read its bytes. When no nested dir was resolved, the
        // bare top-level names are kept for backward compatibility with
        // the existing synthetic fixtures.
        let resolved_data_dir_display = state
            .resolved_reallive_data_dir
            .as_deref()
            .map(path_to_forward_slash);
        let seen_txt_evidence_path =
            nest_evidence_path(resolved_data_dir_display.as_deref(), REALLIVE_SEEN_TXT_PATH);
        let seen_gan_evidence_path =
            nest_evidence_path(resolved_data_dir_display.as_deref(), REALLIVE_SEEN_GAN_PATH);
        let gameexe_ini_evidence_path = nest_evidence_path(
            resolved_data_dir_display.as_deref(),
            REALLIVE_GAMEEXE_INI_PATH,
        );

        let mut evidence_rows = vec![
            DetectionEvidence {
                path: seen_txt_evidence_path,
                kind: "reallive_seen_txt_envelope".to_string(),
                status: evidence_status(state.seen_txt_exists, state.seen_txt_envelope_ok),
                detail: signature_detail(
                    state.seen_txt_exists,
                    state.seen_txt_envelope_ok,
                    "SEEN.TXT envelope",
                ),
            },
            DetectionEvidence {
                path: seen_gan_evidence_path,
                kind: "reallive_seen_gan_marker".to_string(),
                status: evidence_status(state.seen_gan_exists, state.seen_gan_synthetic_magic),
                detail: signature_detail(
                    state.seen_gan_exists,
                    state.seen_gan_synthetic_magic,
                    "SEEN.GAN marker",
                ),
            },
            DetectionEvidence {
                path: gameexe_ini_evidence_path,
                kind: "reallive_gameexe_ini_keys".to_string(),
                status: evidence_status(state.gameexe_ini_exists, state.gameexe_ini_keys.any()),
                detail: gameexe_ini_detail(state.gameexe_ini_exists, state.gameexe_ini_keys),
            },
            DetectionEvidence {
                path: "*.g00".to_string(),
                kind: "reallive_g00_extension_count".to_string(),
                status: if state.g00_count > 0 {
                    EvidenceStatus::Matched
                } else {
                    EvidenceStatus::Missing
                },
                detail: format!("RealLive .g00 image asset count: {}", state.g00_count),
            },
            DetectionEvidence {
                path: "*.ovk|*.koe|*.nwk".to_string(),
                kind: "reallive_voice_archive_count".to_string(),
                status: if state.voice_archive_count > 0 {
                    EvidenceStatus::Matched
                } else {
                    EvidenceStatus::Missing
                },
                detail: format!(
                    "RealLive voice archive extension count: {}",
                    state.voice_archive_count
                ),
            },
            DetectionEvidence {
                path: "Scene.pck".to_string(),
                kind: "siglus_cross_check_scene_pck".to_string(),
                status: if state.siglus_scene_pck_present {
                    EvidenceStatus::Invalid
                } else {
                    EvidenceStatus::Missing
                },
                detail: if state.siglus_scene_pck_present {
                    "Scene.pck co-present (Siglus marker)".to_string()
                } else {
                    "Scene.pck not present".to_string()
                },
            },
            DetectionEvidence {
                path: "Gameexe.dat".to_string(),
                kind: "siglus_cross_check_gameexe_dat".to_string(),
                status: if state.siglus_gameexe_dat_present {
                    EvidenceStatus::Invalid
                } else {
                    EvidenceStatus::Missing
                },
                detail: if state.siglus_gameexe_dat_present {
                    "Gameexe.dat co-present (Siglus marker)".to_string()
                } else {
                    "Gameexe.dat not present".to_string()
                },
            },
            DetectionEvidence {
                path: "*.pdt".to_string(),
                kind: "avg32_cross_check_pdt_count".to_string(),
                status: if state.avg32_pdt_count > 0 {
                    EvidenceStatus::Invalid
                } else {
                    EvidenceStatus::Missing
                },
                detail: format!(
                    "AVG32 .PDT image asset count (informational): {}",
                    state.avg32_pdt_count
                ),
            },
        ];

        if let Some(resolved_display) = resolved_data_dir_display.as_deref() {
            evidence_rows.push(DetectionEvidence {
                path: resolved_display.to_string(),
                kind: REALLIVE_NESTED_DATA_DIR_RESOLVED_CODE.to_string(),
                status: EvidenceStatus::Matched,
                detail: format!(
                    "RealLive REALLIVEDATA/ engine asset root resolved at relative path {resolved_display} (bounded depth descent)",
                ),
            });
        }

        let mut result = DetectionResult {
            adapter_id: REALLIVE_DETECTOR_ADAPTER_ID.to_string(),
            detected,
            engine_family: detected.then(|| "reallive".to_string()),
            engine_version: None,
            detected_variant: (detected || diagnostic_only)
                .then(|| Self::detected_variant(state.variant).to_string()),
            evidence: evidence_rows,
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
            adapter_id: REALLIVE_DETECTOR_ADAPTER_ID.to_string(),
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
        if !Self::is_detected(state.variant) {
            return Err(Self::diagnostic_error(Self::invalid_input_failure(
                state.variant,
            )));
        }
        let resolved = Self::resolve_reallive_data_dir(request.game_dir);
        let seen_path = Self::seen_txt_path(request.game_dir);
        let archive_bytes = fs::read(&seen_path)?;
        let scene_index = match kaifuu_reallive::parse_archive(&archive_bytes) {
            Ok(index) => index,
            Err(diag) => {
                return Err(Self::diagnostic_error(Self::parser_failure(
                    Self::detected_variant(state.variant),
                    diag.code.as_str(),
                    &diag.message,
                )));
            }
        };
        // Unified extract/patch path (adapter-unify): extract projects each
        // scene through the SAME SceneHeader + AVG32-decompress +
        // `produce_bundle` pipeline `patch` uses, minting the deterministic
        // bridgeUnitIds `patch` re-derives — so a PatchExport keyed on
        // extract's ids resolves in patch with no id mismatch. Gameexe.ini
        // feeds the producer's NAMAE speaker resolution (best-effort;
        // absent -> empty inventory).
        let gameexe_path =
            Self::gameexe_ini_path_with_resolved(request.game_dir, resolved.as_deref());
        let gameexe_bytes = fs::read(&gameexe_path).unwrap_or_default();
        let gameexe_inventory = kaifuu_reallive::parse_gameexe_inventory(&gameexe_bytes);
        let produced =
            Self::produce_scene_bundles(&archive_bytes, &scene_index, &gameexe_inventory)?;
        let mut units: Vec<BridgeUnit> = Vec::new();
        for (_scene_id, bundle) in &produced {
            for unit in &bundle.bundle.units {
                units.push(Self::bridge_unit_from_v02(unit));
            }
        }
        let profile = self.profile_from_state(state.clone())?;
        let bridge = BridgeBundle {
            schema_version: "0.1.0".to_string(),
            bridge_id: deterministic_id("reallive-bridge", 174),
            source_bundle_hash: kaifuu_core::sha256_hash_bytes(&archive_bytes),
            source_locale: "ja-JP".to_string(),
            extractor_name: "kaifuu-reallive".to_string(),
            extractor_version: env!("CARGO_PKG_VERSION").to_string(),
            units,
        };
        Ok(ExtractionResult {
            adapter_id: REALLIVE_DETECTOR_ADAPTER_ID.to_string(),
            profile,
            bridge,
            warnings: vec![],
        })
    }

    fn patch_preflight(&self, request: PatchPreflightRequest<'_>) -> KaifuuResult<PatchResult> {
        // Preflight confirms that source slots resolve and that every target
        // can encode as Shift-JIS. The bundle-driven patch path supports
        // length changes, so target length is not a preflight failure.
        let state = Self::inspect(request.game_dir);
        if !Self::is_detected(state.variant) {
            return Ok(self.unsupported_patch_result(
                request.patch_export.patch_export_id.clone(),
                state.variant,
            ));
        }
        let seen_path = Self::seen_txt_path(request.game_dir);
        let Ok(archive_bytes) = fs::read(&seen_path) else {
            return Ok(self.unsupported_patch_result(
                request.patch_export.patch_export_id.clone(),
                state.variant,
            ));
        };
        let Ok(scene_index) = kaifuu_reallive::parse_archive(&archive_bytes) else {
            return Ok(self.unsupported_patch_result(
                request.patch_export.patch_export_id.clone(),
                state.variant,
            ));
        };
        let resolved = Self::resolve_reallive_data_dir(request.game_dir);
        let gameexe_path =
            Self::gameexe_ini_path_with_resolved(request.game_dir, resolved.as_deref());
        let gameexe_bytes = fs::read(&gameexe_path).unwrap_or_default();
        let gameexe_inventory = kaifuu_reallive::parse_gameexe_inventory(&gameexe_bytes);
        let _ = Self::produce_scene_bundles(&archive_bytes, &scene_index, &gameexe_inventory)?;
        let mut scenes = Vec::new();
        for entry in &scene_index.entries {
            let blob = &archive_bytes[entry.byte_offset as usize
                ..(entry.byte_offset + u64::from(entry.byte_len)) as usize];
            let outcome =
                kaifuu_reallive::parse_scene_into_ast(blob, entry.scene_id, entry.byte_offset);
            if let Some(scene) = outcome.scene {
                scenes.push(scene);
            }
        }
        let failures = self.preflight_failures(
            request.patch_export,
            Self::detected_variant(state.variant),
            &scenes,
        );
        Ok(PatchResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("reallive-preflight", 174),
            patch_export_id: request.patch_export.patch_export_id.clone(),
            status: if failures.is_empty() {
                OperationStatus::Passed
            } else {
                OperationStatus::Failed
            },
            output_hash: content_hash(&kaifuu_core::sha256_hash_bytes(&archive_bytes)),
            failures,
        })
    }

    fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
        self.patch_fixture(request)
    }

    fn verify(&self, request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
        let state = Self::inspect(request.game_dir);
        let variant = Self::detected_variant(state.variant).to_string();
        let seen_path = Self::seen_txt_path(request.game_dir);
        let Ok(archive_bytes) = fs::read(&seen_path) else {
            return Ok(VerificationResult {
                schema_version: "0.1.0".to_string(),
                patch_result_id: deterministic_id("reallive-verify", 174),
                status: OperationStatus::Failed,
                output_hash: content_hash(REALLIVE_SUPPORT_BOUNDARY),
                failures: vec![Self::unsupported_failure(
                    SemanticErrorCode::UnsupportedLayeredTransform,
                    Capability::Verification,
                    variant,
                    REALLIVE_SEEN_TXT_PATH,
                    "patched SEEN.TXT not present at the requested game directory",
                    "run patch first to populate the output directory",
                )],
            });
        };
        let mut failures = Vec::new();
        match kaifuu_reallive::parse_archive(&archive_bytes) {
            Ok(index) => {
                for entry in &index.entries {
                    let blob = &archive_bytes[entry.byte_offset as usize
                        ..(entry.byte_offset + u64::from(entry.byte_len)) as usize];
                    let outcome = kaifuu_reallive::parse_scene_into_ast(
                        blob,
                        entry.scene_id,
                        entry.byte_offset,
                    );
                    if outcome.scene.is_none() {
                        failures.push(Self::unsupported_failure(
                            SemanticErrorCode::UnsupportedLayeredTransform,
                            Capability::Verification,
                            variant.clone(),
                            REALLIVE_SEEN_TXT_PATH,
                            "verify scene re-parse failed",
                            "re-run patch with a corrected translated bundle",
                        ));
                    }
                }
            }
            Err(diag) => {
                failures.push(Self::unsupported_failure(
                    SemanticErrorCode::UnsupportedLayeredTransform,
                    Capability::Verification,
                    variant.clone(),
                    REALLIVE_SEEN_TXT_PATH,
                    format!("verify archive re-parse failed: {}", diag.message),
                    "re-run patch with a corrected translated bundle",
                ));
            }
        }
        let status = if failures.is_empty() {
            OperationStatus::Passed
        } else {
            OperationStatus::Failed
        };
        Ok(VerificationResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("reallive-verify", 174),
            status,
            output_hash: kaifuu_core::sha256_hash_bytes(&archive_bytes),
            failures,
        })
    }
}
