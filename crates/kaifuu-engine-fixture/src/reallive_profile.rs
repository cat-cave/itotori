use super::*;

impl RealLiveProfileDetectorAdapter {
    // depth-N descent that locates the REALLIVEDATA/ engine
    // asset root inside an arbitrary game directory tree. Some installations
    // place it at
    // `<game_root>/<localized-title>/REALLIVEDATA/`
    // (depth 2 from the install root); pointing `kaifuu detect` at the
    // install root must walk the title subdir before reporting any
    // RealLive marker missing. See `docs/audits/real-bytes-validation-2026-06-24.md`
    // §2.1 and `kaifuu_reallive::detector` for the depth bound rationale.
    // I/O errors are swallowed into `None` here because this helper feeds
    // a detector that already tolerates "directory unreadable" elsewhere
    // (e.g. extract / profile flows). The kaifuu-reallive detector
    // surfaces three-state outcomes for callers that care about the
    // difference (see `kaifuu_reallive::RealLiveDetectError`).
    pub(super) fn resolve_reallive_data_dir(game_dir: &Path) -> Option<std::path::PathBuf> {
        kaifuu_reallive::detect_reallive_data_dir(game_dir)
            .ok()
            .flatten()
            .map(|evidence| evidence.reallive_data_path)
    }

    // Returns the effective data-root for SEEN.TXT/Gameexe.ini/extension
    // lookups: the resolved REALLIVEDATA subdir when found, else
    // `game_dir` itself. Keeps synthetic fixtures (which ship SEEN.TXT
    // at the game root) working without a REALLIVEDATA marker.
    pub(super) fn effective_data_dir<'a>(
        game_dir: &'a Path,
        resolved: Option<&'a Path>,
    ) -> &'a Path {
        resolved.unwrap_or(game_dir)
    }

    pub(super) fn seen_txt_path(game_dir: &Path) -> std::path::PathBuf {
        let resolved = Self::resolve_reallive_data_dir(game_dir);
        Self::seen_txt_path_with_resolved(game_dir, resolved.as_deref())
    }

    pub(super) fn seen_txt_path_with_resolved(
        game_dir: &Path,
        resolved: Option<&Path>,
    ) -> std::path::PathBuf {
        let effective = Self::effective_data_dir(game_dir, resolved);
        case_insensitive_find(effective, REALLIVE_SEEN_TXT_PATH)
            .unwrap_or_else(|| effective.join(REALLIVE_SEEN_TXT_PATH))
    }

    pub(super) fn seen_gan_path_with_resolved(
        game_dir: &Path,
        resolved: Option<&Path>,
    ) -> std::path::PathBuf {
        let effective = Self::effective_data_dir(game_dir, resolved);
        case_insensitive_find(effective, REALLIVE_SEEN_GAN_PATH)
            .unwrap_or_else(|| effective.join(REALLIVE_SEEN_GAN_PATH))
    }

    pub(super) fn gameexe_ini_path_with_resolved(
        game_dir: &Path,
        resolved: Option<&Path>,
    ) -> std::path::PathBuf {
        let effective = Self::effective_data_dir(game_dir, resolved);
        case_insensitive_find(effective, REALLIVE_GAMEEXE_INI_PATH)
            .unwrap_or_else(|| effective.join(REALLIVE_GAMEEXE_INI_PATH))
    }

    pub(super) fn inspect(game_dir: &Path) -> RealLiveFixtureState {
        let resolved_reallive_data_dir = Self::resolve_reallive_data_dir(game_dir);
        let seen_txt_path =
            Self::seen_txt_path_with_resolved(game_dir, resolved_reallive_data_dir.as_deref());
        let seen_gan_path =
            Self::seen_gan_path_with_resolved(game_dir, resolved_reallive_data_dir.as_deref());
        let gameexe_ini_path =
            Self::gameexe_ini_path_with_resolved(game_dir, resolved_reallive_data_dir.as_deref());
        let seen_txt_exists = seen_txt_path.is_file();
        let seen_gan_exists = seen_gan_path.is_file();
        let gameexe_ini_exists = gameexe_ini_path.is_file();
        let seen_txt_synthetic_magic = file_starts_with(&seen_txt_path, REALLIVE_SEEN_TXT_MAGIC);
        let seen_gan_synthetic_magic = file_starts_with(&seen_gan_path, REALLIVE_SEEN_GAN_MAGIC);
        let gameexe_ini_synthetic_magic =
            file_starts_with(&gameexe_ini_path, REALLIVE_GAMEEXE_INI_MAGIC);
        let seen_txt_envelope_ok =
            seen_txt_synthetic_magic || reallive_seen_txt_envelope_ok(&seen_txt_path);
        let gameexe_ini_keys = if gameexe_ini_exists {
            reallive_gameexe_ini_key_hits(&gameexe_ini_path)
        } else {
            GameexeIniKeyHits::default()
        };
        let effective_extension_dir =
            Self::effective_data_dir(game_dir, resolved_reallive_data_dir.as_deref());
        let (g00_count, voice_archive_count, avg32_pdt_count) =
            reallive_extension_counts(effective_extension_dir);
        // Siglus cross-check stays anchored to the game root: Siglus
        // markers (`Scene.pck`, `Gameexe.dat`) never live inside a
        // RealLive `REALLIVEDATA/` subtree.
        let siglus_scene_pck_present = case_insensitive_find(game_dir, "Scene.pck").is_some();
        let siglus_gameexe_dat_present = case_insensitive_find(game_dir, "Gameexe.dat").is_some();
        let variant = RealLiveFsmSignals {
            seen_txt_exists,
            seen_txt_envelope_ok,
            seen_txt_synthetic_magic,
            seen_gan_exists,
            gameexe_ini_exists,
            gameexe_ini_synthetic_magic,
            gameexe_ini_keys,
            g00_count,
            voice_archive_count,
            siglus_scene_pck_present,
            siglus_gameexe_dat_present,
            avg32_pdt_count,
        }
        .resolve();
        let resolved_relative = resolved_reallive_data_dir.as_deref().map(|resolved| {
            resolved
                .strip_prefix(game_dir)
                .map_or_else(|_| resolved.to_path_buf(), std::path::Path::to_path_buf)
        });
        RealLiveFixtureState {
            seen_txt_exists,
            seen_txt_envelope_ok,
            seen_txt_synthetic_magic,
            seen_gan_exists,
            seen_gan_synthetic_magic,
            gameexe_ini_exists,
            gameexe_ini_synthetic_magic,
            gameexe_ini_keys,
            g00_count,
            voice_archive_count,
            siglus_scene_pck_present,
            siglus_gameexe_dat_present,
            avg32_pdt_count,
            seen_txt_hash: seen_txt_exists
                .then(|| sha256_file_ref(&seen_txt_path).ok())
                .flatten(),
            seen_gan_hash: seen_gan_exists
                .then(|| sha256_file_ref(&seen_gan_path).ok())
                .flatten(),
            gameexe_ini_hash: gameexe_ini_exists
                .then(|| sha256_file_ref(&gameexe_ini_path).ok())
                .flatten(),
            variant,
            resolved_reallive_data_dir: resolved_relative,
        }
    }

    pub(super) fn detected_variant(variant: RealLiveFixtureVariant) -> &'static str {
        match variant {
            RealLiveFixtureVariant::CompleteSyntheticTriple => "reallive-synthetic-triple",
            RealLiveFixtureVariant::PositiveLiveLayout => "reallive-positive-live-layout",
            RealLiveFixtureVariant::AmbiguousSiglusOverlap => "ambiguous-reallive-siglus-overlap",
            RealLiveFixtureVariant::UnsupportedAvg32Lineage => "avg32-lineage-seen-txt",
            RealLiveFixtureVariant::UnknownEngineVariant => "unknown-reallive-named-files",
            RealLiveFixtureVariant::NotRealLive => "not-reallive",
        }
    }

    pub(super) fn is_detected(variant: RealLiveFixtureVariant) -> bool {
        matches!(
            variant,
            RealLiveFixtureVariant::CompleteSyntheticTriple
                | RealLiveFixtureVariant::PositiveLiveLayout
        )
    }

    pub(super) fn can_inventory(variant: RealLiveFixtureVariant) -> bool {
        Self::is_detected(variant)
    }

    pub(super) fn profile_from_state(
        &self,
        state: RealLiveFixtureState,
    ) -> KaifuuResult<GameProfile> {
        if !Self::is_detected(state.variant) {
            return Err(Self::diagnostic_error(Self::invalid_input_failure(
                state.variant,
            )));
        }
        let mut profile = GameProfile {
            schema_version: "0.1.0".to_string(),
            profile_id: REALLIVE_PROFILE_ID.to_string(),
            game_id: REALLIVE_GAME_ID.to_string(),
            title: "RealLive fixture".to_string(),
            source_locale: "ja-JP".to_string(),
            engine: EngineProfile {
                adapter_id: REALLIVE_DETECTOR_ADAPTER_ID.to_string(),
                engine_family: "reallive".to_string(),
                engine_version: None,
                detected_variant: Self::detected_variant(state.variant).to_string(),
            },
            source_fingerprint: Some(SourceFingerprint {
                game_root_hash: None,
                engine_evidence: state.engine_evidence(),
            }),
            key_requirements: vec![],
            archive_parameters: vec![ArchiveParameter {
                parameter_id: "scene-archive".to_string(),
                name: "sceneArchive".to_string(),
                kind: ArchiveParameterKind::ArchiveFormat,
                value: REALLIVE_SEEN_TXT_PATH.to_string(),
                source: Some(ArchiveParameterSource::Detected),
            }],
            helper_evidence: None,
            assets: state.asset_profiles(),
            layered_access: Some(state.layered_access_profile()),
            capabilities: self.capabilities().reports,
            requirements: state.profile_requirements(),
            metadata: state.metadata(),
        };
        profile.normalize();
        Ok(profile)
    }

    pub(super) fn inventory_from_state(
        &self,
        state: RealLiveFixtureState,
    ) -> KaifuuResult<AssetInventoryManifest> {
        if !Self::can_inventory(state.variant) {
            return Err(Self::diagnostic_error(Self::invalid_input_failure(
                state.variant,
            )));
        }
        let mut manifest = AssetInventoryManifest {
            schema_version: ASSET_INVENTORY_SCHEMA_VERSION.to_string(),
            manifest_id: deterministic_id("reallive-inventory", 172),
            adapter_id: REALLIVE_DETECTOR_ADAPTER_ID.to_string(),
            source_locale: "ja-JP".to_string(),
            assets: state.inventory_assets(),
            surfaces: vec![],
            capabilities: self.capabilities().reports,
            warnings: vec![],
            metadata: state.metadata(),
        };
        manifest.normalize();
        Ok(manifest)
    }

    pub(super) fn unsupported_failure(
        code: SemanticErrorCode,
        required_capability: Capability,
        variant: impl Into<String>,
        asset_ref: impl Into<String>,
        support_boundary: impl Into<String>,
        remediation: impl Into<String>,
    ) -> AdapterFailure {
        AdapterFailure::semantic(
            AdapterFailureSemanticParams::new(code, REALLIVE_DETECTOR_ADAPTER_ID, support_boundary)
                .engine("reallive")
                .detected_variant(variant)
                .asset_ref(asset_ref)
                .required_capability(required_capability)
                .remediation(remediation),
        )
    }

    pub(super) fn parser_boundary_failure(variant: impl Into<String>) -> AdapterFailure {
        Self::unsupported_failure(
            SemanticErrorCode::UnsupportedLayeredTransform,
            Capability::CodecAccess,
            variant,
            REALLIVE_SEEN_TXT_PATH,
            "RealLive SEEN.TXT/Scene parsing/decompilation is outside synthetic detector fixtures",
            "use identify or asset-inventory output only; do not request extract or patch for this detector profile",
        )
    }

    pub(super) fn invalid_input_failure(variant: RealLiveFixtureVariant) -> AdapterFailure {
        let (code, required_capability, asset_ref, support_boundary, remediation) = match variant {
            RealLiveFixtureVariant::AmbiguousSiglusOverlap => (
                SemanticErrorCode::AmbiguousEngineVariant,
                Capability::Detection,
                REALLIVE_SEEN_TXT_PATH,
                "RealLive detector requires unambiguous RealLive evidence; co-presence of Siglus markers (Scene.pck/Gameexe.dat) blocks identification.",
                "audit the input directory; remove or relocate cross-engine markers, or report the layout as a new engine variant",
            ),
            RealLiveFixtureVariant::UnsupportedAvg32Lineage => (
                SemanticErrorCode::UnsupportedEngineVariant,
                Capability::Detection,
                REALLIVE_SEEN_TXT_PATH,
                "RealLive detector does not claim AVG32 lineage support; AVG32-shaped SEEN.TXT inputs are out of scope.",
                "add an AVG32-specific detector (separate node) before localizing this title",
            ),
            RealLiveFixtureVariant::UnknownEngineVariant => (
                SemanticErrorCode::UnknownEngineVariant,
                Capability::Detection,
                REALLIVE_SEEN_TXT_PATH,
                "RealLive marker names were present without recognized RealLive SEEN.TXT envelope and Gameexe.ini key evidence",
                "provide a complete synthetic RealLive fixture or add an explicit adapter for this RealLive variant before profiling or inventory",
            ),
            RealLiveFixtureVariant::NotRealLive => (
                SemanticErrorCode::UnknownEngineVariant,
                Capability::Detection,
                REALLIVE_SEEN_TXT_PATH,
                "RealLive detector profile requires recognized SEEN.TXT/Gameexe.ini fixture evidence",
                "run detection with a complete synthetic RealLive fixture or select another adapter",
            ),
            RealLiveFixtureVariant::CompleteSyntheticTriple
            | RealLiveFixtureVariant::PositiveLiveLayout => (
                SemanticErrorCode::UnsupportedLayeredTransform,
                Capability::CodecAccess,
                REALLIVE_SEEN_TXT_PATH,
                REALLIVE_SUPPORT_BOUNDARY,
                "use identify or asset-inventory output only",
            ),
        };
        Self::unsupported_failure(
            code,
            required_capability,
            Self::detected_variant(variant),
            asset_ref,
            support_boundary,
            remediation,
        )
    }

    pub(super) fn diagnostic_error(failure: AdapterFailure) -> Box<dyn std::error::Error> {
        match kaifuu_core::stable_json(&failure) {
            Ok(serialized) => serialized.into(),
            Err(error) => error,
        }
    }

    pub(super) fn unsupported_patch_result(
        &self,
        patch_export_id: String,
        variant: RealLiveFixtureVariant,
    ) -> PatchResult {
        let detected_variant = Self::detected_variant(variant).to_string();
        PatchResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("reallive-patch", 172),
            patch_export_id,
            status: OperationStatus::Failed,
            output_hash: content_hash(REALLIVE_SUPPORT_BOUNDARY),
            failures: vec![
                Self::unsupported_failure(
                    SemanticErrorCode::MissingContainerCapability,
                    Capability::ContainerAccess,
                    detected_variant.clone(),
                    REALLIVE_SEEN_TXT_PATH,
                    "RealLive SEEN.TXT archive container access is not implemented by the detector profile",
                    "use identify or asset-inventory output only",
                ),
                Self::parser_boundary_failure(detected_variant.clone()),
                Self::unsupported_failure(
                    SemanticErrorCode::MissingPatchBackCapability,
                    Capability::PatchBack,
                    detected_variant,
                    REALLIVE_SEEN_TXT_PATH,
                    "RealLive patch-back/repack support is not implemented by the detector profile",
                    "add an explicit patch-back adapter before writing patched SEEN.TXT output",
                ),
            ],
        }
    }
}
