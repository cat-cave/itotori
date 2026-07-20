use super::*;

impl SoftpalProfileDetectorAdapter {
    fn pal_dll_path(game_dir: &Path) -> Option<std::path::PathBuf> {
        let dll_dir = case_insensitive_find(game_dir, SOFTPAL_PAL_DLL_DIR)?;
        if !dll_dir.is_dir() {
            return None;
        }
        case_insensitive_find(&dll_dir, SOFTPAL_PAL_DLL_NAME).filter(|path| path.is_file())
    }

    // Recognise a `.pac` whose file table names both `SCRIPT.SRC` and
    // `TEXT.DAT`. Reads only a bounded header/table prefix (never the whole
    // archive) and requires the `PAC ` magic plus a sane entry count before
    // searching for the entry names, so a bare `PAC ` file cannot false-positive.
    fn pac_names_softpal_scripts(path: &Path) -> bool {
        let Some(prefix) = read_file_prefix(path, SOFTPAL_PAC_TABLE_SCAN_LEN) else {
            return false;
        };
        if !prefix.starts_with(SOFTPAL_PAC_MAGIC) {
            return false;
        }
        let Some(entry_count) = read_u32_le(&prefix, 8) else {
            return false;
        };
        if entry_count == 0 || entry_count > SOFTPAL_PAC_MAX_ENTRIES {
            return false;
        }
        bytes_contains(&prefix, SOFTPAL_SCRIPT_SRC_ENTRY)
            && bytes_contains(&prefix, SOFTPAL_TEXT_DAT_ENTRY)
    }

    fn pac_has_magic(path: &Path) -> bool {
        read_file_prefix(path, SOFTPAL_PAC_MAGIC.len())
            .is_some_and(|prefix| prefix.starts_with(SOFTPAL_PAC_MAGIC))
    }

    // Loose `SCRIPT.SRC` opens with `Sv` followed by a two-digit version
    // (`Sv20` observed; `Sv<nn>` tolerates other script-format revisions).
    fn loose_script_src_ok(path: &Path) -> bool {
        let Some(prefix) = read_file_prefix(path, 4) else {
            return false;
        };
        prefix.len() >= 4
            && prefix.starts_with(SOFTPAL_SCRIPT_SRC_MAGIC_PREFIX)
            && prefix[2].is_ascii_digit()
            && prefix[3].is_ascii_digit()
    }

    // Loose `TEXT.DAT` opens with a one-byte encryption flag (`$` encrypted or
    // `_` plaintext) followed by `TEXT_LIST__`. Returns the flag byte so the
    // detector can report enc-flag robustness across variants.
    fn loose_text_dat_flag(path: &Path) -> Option<u8> {
        let want = 1 + SOFTPAL_TEXT_LIST_TAG.len();
        let prefix = read_file_prefix(path, want)?;
        if prefix.len() < want {
            return None;
        }
        let flag = prefix[0];
        if flag != SOFTPAL_TEXT_DAT_ENC_ENCRYPTED && flag != SOFTPAL_TEXT_DAT_ENC_PLAINTEXT {
            return None;
        }
        if &prefix[1..want] == SOFTPAL_TEXT_LIST_TAG {
            Some(flag)
        } else {
            None
        }
    }

    pub(super) fn inspect(game_dir: &Path) -> SoftpalState {
        let pal_dll_present = Self::pal_dll_path(game_dir).is_some();

        // Scan the game dir's `.pac` archives (bounded). `data.pac` carries the
        // scripts, but iterate all `.pac` to stay robust to packaging variants.
        let mut pac_present = false;
        let mut pac_scripts = false;
        let mut scripts_pac_name: Option<String> = None;
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
            // Deterministic order; probe `data.pac` first so it wins the report.
            pac_paths.sort();
            pac_paths.sort_by_key(|path| {
                !path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.eq_ignore_ascii_case(SOFTPAL_DATA_PAC_NAME))
            });
            for path in pac_paths {
                if Self::pac_has_magic(&path) {
                    pac_present = true;
                }
                if !pac_scripts && Self::pac_names_softpal_scripts(&path) {
                    pac_scripts = true;
                    scripts_pac_name = path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .map(str::to_string);
                }
            }
        }

        let loose_script_src = case_insensitive_find(game_dir, SOFTPAL_SCRIPT_SRC_NAME)
            .is_some_and(|path| Self::loose_script_src_ok(&path));
        let text_dat_enc_flag = case_insensitive_find(game_dir, SOFTPAL_TEXT_DAT_NAME)
            .and_then(|path| Self::loose_text_dat_flag(&path));
        let loose_text_dat = text_dat_enc_flag.is_some();

        let variant = if pal_dll_present {
            SoftpalVariant::PalDll
        } else if pac_scripts {
            SoftpalVariant::PacScripts
        } else if loose_script_src && loose_text_dat {
            SoftpalVariant::LooseScripts
        } else if pac_present || loose_script_src || loose_text_dat {
            SoftpalVariant::UnknownPacOnly
        } else {
            SoftpalVariant::NotSoftpal
        };

        SoftpalState {
            pal_dll_present,
            pac_present,
            pac_scripts,
            scripts_pac_name,
            loose_script_src,
            loose_text_dat,
            text_dat_enc_flag,
            variant,
        }
    }

    pub(super) fn detected_variant(variant: SoftpalVariant) -> &'static str {
        match variant {
            SoftpalVariant::PalDll => "pal-dll",
            SoftpalVariant::PacScripts => "pac-script-src-text-dat",
            SoftpalVariant::LooseScripts => "loose-script-src-text-dat",
            SoftpalVariant::UnknownPacOnly => "unknown-softpal-signature",
            SoftpalVariant::NotSoftpal => "not-softpal",
        }
    }

    pub(super) fn is_detected(variant: SoftpalVariant) -> bool {
        matches!(
            variant,
            SoftpalVariant::PalDll | SoftpalVariant::PacScripts | SoftpalVariant::LooseScripts
        )
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
            AdapterFailureSemanticParams::new(code, SOFTPAL_DETECTOR_ADAPTER_ID, support_boundary)
                .engine("softpal")
                .detected_variant(variant)
                .asset_ref(asset_ref)
                .required_capability(required_capability)
                .remediation(remediation),
        )
    }

    pub(super) fn parser_boundary_failure(variant: impl Into<String>) -> AdapterFailure {
        Self::unsupported_failure(
            SemanticErrorCode::UnknownEngineVariant,
            Capability::ContainerAccess,
            variant,
            SOFTPAL_DATA_PAC_NAME,
            "no recognised Softpal title here, so there is no PAC/SCRIPT.SRC/TEXT.DAT surface to extract or decode (extraction is supported only for a detected Softpal title)",
            "run detect against a Softpal title (Pal.dll / PAC+SCRIPT.SRC/TEXT.DAT / loose script magics) first",
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
        variant: SoftpalVariant,
    ) -> PatchResult {
        let detected_variant = Self::detected_variant(variant).to_string();
        PatchResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("softpal-patch", 12),
            patch_export_id,
            status: OperationStatus::Failed,
            output_hash: content_hash(SOFTPAL_SUPPORT_BOUNDARY),
            failures: vec![
                Self::unsupported_failure(
                    SemanticErrorCode::UnknownEngineVariant,
                    Capability::ContainerAccess,
                    detected_variant.clone(),
                    SOFTPAL_DATA_PAC_NAME,
                    "no recognised Softpal title here, so its PAC/SCRIPT.SRC/TEXT.DAT container cannot be opened (container access is supported only for a detected Softpal title)",
                    "run detect against a Softpal title first",
                ),
                Self::parser_boundary_failure(detected_variant.clone()),
                Self::unsupported_failure(
                    SemanticErrorCode::UnknownEngineVariant,
                    Capability::PatchBack,
                    detected_variant,
                    SOFTPAL_DATA_PAC_NAME,
                    "no recognised Softpal title here to patch; dialogue/choice patch-back (TEXT.DAT rebuild + SCRIPT.SRC repoint) targets a detected Softpal title, and PAC repack remains out of scope",
                    "run detect against a Softpal title first",
                ),
            ],
        }
    }

    pub(super) fn profile_from_state(&self, state: SoftpalState) -> KaifuuResult<GameProfile> {
        if !Self::is_detected(state.variant) {
            return Err(Self::diagnostic_error(Self::unsupported_failure(
                SemanticErrorCode::UnknownEngineVariant,
                Capability::Detection,
                Self::detected_variant(state.variant),
                format!("{SOFTPAL_PAL_DLL_DIR}/{SOFTPAL_PAL_DLL_NAME}"),
                "Softpal detector requires a recognised Pal.dll / PAC+SCRIPT.SRC/TEXT.DAT / script-magic signature",
                "run detect against a Softpal title or select another adapter",
            )));
        }
        let mut profile = GameProfile {
            schema_version: "0.1.0".to_string(),
            profile_id: SOFTPAL_PROFILE_ID.to_string(),
            game_id: SOFTPAL_GAME_ID.to_string(),
            title: "Softpal title (detector profile)".to_string(),
            source_locale: "ja-JP".to_string(),
            engine: EngineProfile {
                adapter_id: SOFTPAL_DETECTOR_ADAPTER_ID.to_string(),
                engine_family: "softpal".to_string(),
                engine_version: None,
                detected_variant: Self::detected_variant(state.variant).to_string(),
            },
            source_fingerprint: Some(SourceFingerprint {
                game_root_hash: None,
                engine_evidence: state.engine_evidence(),
            }),
            key_requirements: vec![],
            archive_parameters: vec![ArchiveParameter {
                parameter_id: "softpal-pac-archive".to_string(),
                name: "pacArchive".to_string(),
                kind: ArchiveParameterKind::ArchiveFormat,
                value: SOFTPAL_DATA_PAC_NAME.to_string(),
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
