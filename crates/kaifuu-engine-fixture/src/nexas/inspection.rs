use super::*;

impl NexasProfileDetectorAdapter {
    // Recognise a NeXAS `.pac`: `PAC\0` magic (4th byte NUL, NOT the Softpal
    // space), a sane count @0x04, and a small pack_type @0x08. Returns
    // `Some(Some(pack_type))` for a valid NeXAS header, `Some(None)` when the
    // magic matched but the header is out of range, and `None` when the magic
    // is not `PAC\0` at all (e.g. a Softpal `"PAC "` archive).
    fn nexas_pac_header(path: &Path) -> Option<Option<u32>> {
        let prefix = read_file_prefix(path, NEXAS_HEADER_BYTE_LEN)?;
        if prefix.len() < NEXAS_HEADER_BYTE_LEN || !prefix.starts_with(NEXAS_PAC_MAGIC) {
            return None;
        }
        let count = read_u32_le(&prefix, NEXAS_COUNT_OFFSET)?;
        let pack_type = read_u32_le(&prefix, NEXAS_PACK_TYPE_OFFSET)?;
        if count == 0 || count > NEXAS_PAC_MAX_ENTRIES || pack_type > NEXAS_PACK_TYPE_MAX {
            return Some(None);
        }
        Some(Some(pack_type))
    }

    pub(super) fn inspect(game_dir: &Path) -> NexasState {
        let mut nexas_pac = false;
        let mut unknown_pac_magic = false;
        let mut primary_pac_name: Option<String> = None;
        let mut category_hits: Vec<String> = Vec::new();
        let mut pack_types: Vec<u32> = Vec::new();

        if let Ok(entries) = fs::read_dir(game_dir) {
            let mut pac_paths: Vec<std::path::PathBuf> = entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| {
                    path.is_file()
                        && path
                            .extension()
                            .and_then(|ext| ext.to_str())
                            .is_some_and(|ext| ext.eq_ignore_ascii_case("pac"))
                })
                .collect();
            pac_paths.sort();
            for path in pac_paths {
                let stem = path
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .map(str::to_ascii_lowercase);
                if let Some(stem) = &stem
                    && NEXAS_CATEGORY_ARCHIVES.contains(&stem.as_str())
                {
                    category_hits.push(stem.clone());
                }
                match Self::nexas_pac_header(&path) {
                    Some(Some(pack_type)) => {
                        nexas_pac = true;
                        if !pack_types.contains(&pack_type) {
                            pack_types.push(pack_type);
                        }
                        if primary_pac_name.is_none() {
                            primary_pac_name = path
                                .file_name()
                                .and_then(|name| name.to_str())
                                .map(str::to_string);
                        }
                    }
                    Some(None) => unknown_pac_magic = true,
                    None => {}
                }
            }
        }
        category_hits.sort();
        category_hits.dedup();
        pack_types.sort_unstable();

        let variant = if nexas_pac {
            NexasVariant::NexasPac
        } else if unknown_pac_magic {
            NexasVariant::UnknownPacOnly
        } else {
            NexasVariant::NotNexas
        };

        NexasState {
            nexas_pac,
            unknown_pac_magic,
            primary_pac_name,
            category_hits,
            pack_types,
            variant,
        }
    }

    pub(super) fn detected_variant(variant: NexasVariant) -> &'static str {
        match variant {
            NexasVariant::NexasPac => "pac-magic",
            NexasVariant::UnknownPacOnly => "unknown-nexas-signature",
            NexasVariant::NotNexas => "not-nexas",
        }
    }

    pub(super) fn is_detected(variant: NexasVariant) -> bool {
        matches!(variant, NexasVariant::NexasPac)
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
            AdapterFailureSemanticParams::new(code, NEXAS_DETECTOR_ADAPTER_ID, support_boundary)
                .engine("nexas")
                .detected_variant(variant)
                .asset_ref(asset_ref)
                .required_capability(required_capability)
                .remediation(remediation),
        )
    }

    pub(super) fn parser_boundary_failure(variant: impl Into<String>) -> AdapterFailure {
        Self::unsupported_failure(
            SemanticErrorCode::UnsupportedLayeredTransform,
            Capability::ContainerAccess,
            variant,
            "*.pac",
            "NeXAS PAC extraction / decompression is provided by the kaifuu-nexas crate, not this detector",
            "use identify (detect/profile) output only; call the kaifuu-nexas reader for extraction",
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
        variant: NexasVariant,
    ) -> PatchResult {
        let detected_variant = Self::detected_variant(variant).to_string();
        PatchResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("nexas-patch", 12),
            patch_export_id,
            status: OperationStatus::Failed,
            output_hash: content_hash(NEXAS_SUPPORT_BOUNDARY),
            failures: vec![
                Self::parser_boundary_failure(detected_variant.clone()),
                Self::unsupported_failure(
                    SemanticErrorCode::MissingPatchBackCapability,
                    Capability::PatchBack,
                    detected_variant,
                    "*.pac",
                    "NeXAS patch-back/repack support is not implemented",
                    "add an explicit NeXAS patch-back adapter before writing patched PAC output",
                ),
            ],
        }
    }

    pub(super) fn profile_from_state(&self, state: NexasState) -> KaifuuResult<GameProfile> {
        if !Self::is_detected(state.variant) {
            return Err(Self::diagnostic_error(Self::unsupported_failure(
                SemanticErrorCode::UnknownEngineVariant,
                Capability::Detection,
                Self::detected_variant(state.variant),
                "*.pac",
                "NeXAS detector requires a `PAC\\0`-magic archive with a sane header",
                "run detect against a NeXAS title or select another adapter",
            )));
        }
        let mut profile = GameProfile {
            schema_version: "0.1.0".to_string(),
            profile_id: NEXAS_PROFILE_ID.to_string(),
            game_id: NEXAS_GAME_ID.to_string(),
            title: "NeXAS title (detector profile)".to_string(),
            source_locale: "ja-JP".to_string(),
            engine: EngineProfile {
                adapter_id: NEXAS_DETECTOR_ADAPTER_ID.to_string(),
                engine_family: "nexas".to_string(),
                engine_version: None,
                detected_variant: Self::detected_variant(state.variant).to_string(),
            },
            source_fingerprint: Some(SourceFingerprint {
                game_root_hash: None,
                engine_evidence: state.engine_evidence(),
            }),
            key_requirements: vec![],
            archive_parameters: vec![ArchiveParameter {
                parameter_id: "nexas-pac-archive".to_string(),
                name: "pacArchive".to_string(),
                kind: ArchiveParameterKind::ArchiveFormat,
                value: state
                    .primary_pac_name
                    .clone()
                    .unwrap_or_else(|| "*.pac".to_string()),
                source: Some(ArchiveParameterSource::Detected),
            }],
            helper_evidence: None,
            assets: vec![],
            layered_access: None,
            capabilities: self.capabilities().reports,
            requirements: state.detection_requirements(),
            metadata: state.metadata(),
        };
        profile.normalize();
        Ok(profile)
    }
}
