use super::*;

impl SiglusProfileDetectorAdapter {
    pub(super) fn scene_path(game_dir: &Path) -> std::path::PathBuf {
        game_dir.join(SIGLUS_SCENE_PATH)
    }

    pub(super) fn gameexe_path(game_dir: &Path) -> std::path::PathBuf {
        game_dir.join(SIGLUS_GAMEEXE_PATH)
    }

    pub(super) fn inspect(game_dir: &Path) -> SiglusFixtureState {
        let scene_path = Self::scene_path(game_dir);
        let gameexe_path = Self::gameexe_path(game_dir);
        let scene_exists = scene_path.is_file();
        let gameexe_exists = gameexe_path.is_file();
        let scene_synthetic = file_starts_with(&scene_path, SIGLUS_SCENE_MAGIC);
        let gameexe_synthetic = file_starts_with(&gameexe_path, SIGLUS_GAMEEXE_MAGIC);
        // Only probe the real archive-header signature when the synthetic magic
        // did not already match, so a synthetic fixture is never re-classified.
        let scene_real = !scene_synthetic && siglus_scene_pck_real_signature_ok(&scene_path);
        let gameexe_real =
            !gameexe_synthetic && siglus_gameexe_dat_real_signature_ok(&gameexe_path);
        let scene_signature = scene_synthetic || scene_real;
        let gameexe_signature = gameexe_synthetic || gameexe_real;
        let any_real = scene_real || gameexe_real;
        let variant = match (
            scene_signature,
            gameexe_signature,
            scene_exists,
            gameexe_exists,
        ) {
            (true, true, _, _) if any_real => SiglusFixtureVariant::CompleteRealPair,
            (true, true, _, _) => SiglusFixtureVariant::CompleteSyntheticPair,
            (true, false, _, _) => SiglusFixtureVariant::MissingGameexeDat,
            (false, true, _, _) => SiglusFixtureVariant::MissingScenePck,
            (false, false, true, _) | (false, false, _, true) => {
                SiglusFixtureVariant::UnknownNamedPair
            }
            _ => SiglusFixtureVariant::NotSiglus,
        };
        SiglusFixtureState {
            scene_exists,
            gameexe_exists,
            scene_signature,
            gameexe_signature,
            scene_real,
            gameexe_real,
            scene_hash: scene_exists
                .then(|| sha256_file_ref(&scene_path).ok())
                .flatten(),
            gameexe_hash: gameexe_exists
                .then(|| sha256_file_ref(&gameexe_path).ok())
                .flatten(),
            variant,
        }
    }

    pub(super) fn detected_variant(variant: SiglusFixtureVariant) -> &'static str {
        match variant {
            SiglusFixtureVariant::CompleteSyntheticPair => "scene-pck-gameexe-dat-synthetic",
            SiglusFixtureVariant::CompleteRealPair => "scene-pck-gameexe-dat-real",
            SiglusFixtureVariant::MissingGameexeDat => "scene-pck-missing-gameexe-dat",
            SiglusFixtureVariant::MissingScenePck => "gameexe-dat-missing-scene-pck",
            SiglusFixtureVariant::UnknownNamedPair => "unknown-siglus-named-files",
            SiglusFixtureVariant::NotSiglus => "not-siglus",
        }
    }

    pub(super) fn is_detected(variant: SiglusFixtureVariant) -> bool {
        matches!(
            variant,
            SiglusFixtureVariant::CompleteSyntheticPair | SiglusFixtureVariant::CompleteRealPair
        )
    }

    pub(super) fn can_inventory(variant: SiglusFixtureVariant) -> bool {
        Self::is_detected(variant)
    }

    pub(super) fn profile_from_state(
        &self,
        state: SiglusFixtureState,
    ) -> KaifuuResult<GameProfile> {
        if !Self::is_detected(state.variant) {
            return Err(Self::diagnostic_error(Self::invalid_input_failure(
                state.variant,
            )));
        }
        let is_real = matches!(state.variant, SiglusFixtureVariant::CompleteRealPair);
        let mut profile = GameProfile {
            schema_version: "0.1.0".to_string(),
            profile_id: SIGLUS_PROFILE_ID.to_string(),
            game_id: if is_real {
                SIGLUS_REAL_GAME_ID.to_string()
            } else {
                SIGLUS_GAME_ID.to_string()
            },
            title: if is_real {
                "Siglus title (detector profile)".to_string()
            } else {
                "Siglus fixture".to_string()
            },
            source_locale: "ja-JP".to_string(),
            engine: EngineProfile {
                adapter_id: SIGLUS_DETECTOR_ADAPTER_ID.to_string(),
                engine_family: "siglus".to_string(),
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
                value: SIGLUS_SCENE_PATH.to_string(),
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
        state: SiglusFixtureState,
    ) -> KaifuuResult<AssetInventoryManifest> {
        if !Self::can_inventory(state.variant) {
            return Err(Self::diagnostic_error(Self::invalid_input_failure(
                state.variant,
            )));
        }
        let mut manifest = AssetInventoryManifest {
            schema_version: ASSET_INVENTORY_SCHEMA_VERSION.to_string(),
            manifest_id: deterministic_id("siglus-inventory", 91),
            adapter_id: SIGLUS_DETECTOR_ADAPTER_ID.to_string(),
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
            AdapterFailureSemanticParams::new(code, SIGLUS_DETECTOR_ADAPTER_ID, support_boundary)
                .engine("siglus")
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
            SIGLUS_SCENE_PATH,
            "Siglus Scene.pck parsing/decompilation is outside synthetic detector fixtures",
            "use identify or asset-inventory output only; do not request extract or patch for this detector profile",
        )
    }

    pub(super) fn invalid_input_failure(variant: SiglusFixtureVariant) -> AdapterFailure {
        let (code, required_capability, asset_ref, support_boundary, remediation) = match variant {
            SiglusFixtureVariant::MissingGameexeDat => (
                SemanticErrorCode::MissingContainerCapability,
                Capability::AssetListing,
                SIGLUS_GAMEEXE_PATH,
                "Siglus detector profile requires both synthetic Scene.pck and Gameexe.dat signatures before profiling or inventory",
                "provide the complete synthetic Scene.pck/Gameexe.dat signature pair or treat this input as a diagnostic-only partial fixture",
            ),
            SiglusFixtureVariant::MissingScenePck => (
                SemanticErrorCode::MissingContainerCapability,
                Capability::AssetListing,
                SIGLUS_SCENE_PATH,
                "Siglus detector profile requires both synthetic Scene.pck and Gameexe.dat signatures before profiling or inventory",
                "provide the complete synthetic Scene.pck/Gameexe.dat signature pair or treat this input as a diagnostic-only partial fixture",
            ),
            SiglusFixtureVariant::UnknownNamedPair => (
                SemanticErrorCode::UnknownEngineVariant,
                Capability::Detection,
                "Scene.pck/Gameexe.dat",
                "Scene.pck/Gameexe.dat names were present without recognized synthetic Siglus signatures",
                "use the complete synthetic signature pair fixture or add an explicit adapter for this Siglus variant before profiling or inventory",
            ),
            SiglusFixtureVariant::NotSiglus => (
                SemanticErrorCode::UnknownEngineVariant,
                Capability::Detection,
                "Scene.pck/Gameexe.dat",
                "Siglus detector profile requires recognized synthetic Scene.pck/Gameexe.dat fixture evidence",
                "run detection with a complete synthetic Siglus fixture or select another adapter",
            ),
            SiglusFixtureVariant::CompleteSyntheticPair
            | SiglusFixtureVariant::CompleteRealPair => (
                SemanticErrorCode::UnsupportedLayeredTransform,
                Capability::CodecAccess,
                SIGLUS_SCENE_PATH,
                SIGLUS_SUPPORT_BOUNDARY,
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
        variant: SiglusFixtureVariant,
    ) -> PatchResult {
        let detected_variant = Self::detected_variant(variant).to_string();
        PatchResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("siglus-patch", 91),
            patch_export_id,
            status: OperationStatus::Failed,
            output_hash: content_hash(SIGLUS_SUPPORT_BOUNDARY),
            failures: vec![
                Self::unsupported_failure(
                    SemanticErrorCode::MissingContainerCapability,
                    Capability::ContainerAccess,
                    detected_variant.clone(),
                    SIGLUS_SCENE_PATH,
                    "Siglus Scene.pck archive container access is not implemented by the detector profile",
                    "use identify or asset-inventory output only",
                ),
                Self::unsupported_failure(
                    SemanticErrorCode::MissingCryptoCapability,
                    Capability::CryptoAccess,
                    detected_variant.clone(),
                    SIGLUS_SCENE_PATH,
                    "Siglus encrypted payload handling is not implemented by the detector profile",
                    "provide future adapter crypto support before extraction or patching",
                ),
                Self::parser_boundary_failure(detected_variant.clone()),
                Self::unsupported_failure(
                    SemanticErrorCode::MissingPatchBackCapability,
                    Capability::PatchBack,
                    detected_variant,
                    SIGLUS_SCENE_PATH,
                    "Siglus patch-back/repack support is not implemented by the detector profile",
                    "add an explicit patch-back adapter before writing patched Scene.pck output",
                ),
            ],
        }
    }
}
