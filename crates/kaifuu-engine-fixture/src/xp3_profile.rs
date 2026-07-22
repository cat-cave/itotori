use super::*;

impl Xp3ProfileDetectorAdapter {
    pub(super) fn archive_path(game_dir: &Path) -> std::path::PathBuf {
        game_dir.join(XP3_ARCHIVE_PATH)
    }

    pub(super) fn inspect(game_dir: &Path) -> Xp3FixtureState {
        let archive_path = Self::archive_path(game_dir);
        let archive_exists = archive_path.is_file();
        let bytes = fs::read(&archive_path).unwrap_or_default();
        let archive_signature = bytes.starts_with(XP3_MAGIC);
        let marker_text = Self::legacy_marker_text(&bytes);
        let variant = if !archive_signature {
            if archive_exists {
                Xp3FixtureVariant::Unknown
            } else {
                Xp3FixtureVariant::NotXp3
            }
        } else if marker_text.contains(&XP3_UNKNOWN_MARKER.to_ascii_lowercase()) {
            Xp3FixtureVariant::Unknown
        } else if marker_text.contains(&XP3_HELPER_REQUIRED_MARKER.to_ascii_lowercase()) {
            Xp3FixtureVariant::HelperRequired
        } else if marker_text.contains(&XP3_ENCRYPTED_MARKER.to_ascii_lowercase())
            || marker_text.contains("kaifuu-xp3-encrypted")
        {
            Xp3FixtureVariant::Encrypted
        } else if marker_text.contains(&XP3_COMPRESSED_MARKER.to_ascii_lowercase())
            || marker_text.contains("kaifuu-xp3-compressed")
        {
            Xp3FixtureVariant::Compressed
        } else {
            Xp3FixtureVariant::Plain
        };
        let archive_hash = archive_exists
            .then(|| sha256_file_ref(&archive_path).ok())
            .flatten();
        Xp3FixtureState {
            archive_path,
            archive_exists,
            archive_signature,
            archive_hash,
            variant,
        }
    }

    pub(super) fn legacy_marker_text(bytes: &[u8]) -> String {
        if !bytes.starts_with(b"XP3\r\n") || bytes.starts_with(XP3_PLAIN_MAGIC) {
            return String::new();
        }
        String::from_utf8_lossy(&bytes[..bytes.len().min(128)]).to_ascii_lowercase()
    }

    pub(super) fn detected_variant(variant: Xp3FixtureVariant) -> &'static str {
        match variant {
            Xp3FixtureVariant::Plain => "xp3-plain-container",
            Xp3FixtureVariant::Encrypted => "xp3-encrypted-container",
            Xp3FixtureVariant::HelperRequired => "xp3-helper-required-container",
            Xp3FixtureVariant::Compressed => "xp3-compressed-container",
            Xp3FixtureVariant::Unknown => "xp3-unknown-container",
            Xp3FixtureVariant::NotXp3 => "not-xp3",
        }
    }

    pub(super) fn profile_id(variant: Xp3FixtureVariant) -> &'static str {
        match variant {
            Xp3FixtureVariant::Plain => "019ed000-0000-7000-8000-000000095001",
            Xp3FixtureVariant::Encrypted => "019ed000-0000-7000-8000-000000095002",
            Xp3FixtureVariant::Compressed => "019ed000-0000-7000-8000-000000095003",
            Xp3FixtureVariant::HelperRequired => "019ed000-0000-7000-8000-000000095004",
            Xp3FixtureVariant::Unknown | Xp3FixtureVariant::NotXp3 => {
                "019ed000-0000-7000-8000-000000095099"
            }
        }
    }

    pub(super) fn archive_parameter_variant(variant: Xp3FixtureVariant) -> &'static str {
        match variant {
            Xp3FixtureVariant::Plain => "plain",
            Xp3FixtureVariant::Encrypted => "encrypted",
            Xp3FixtureVariant::HelperRequired => "helper_required",
            Xp3FixtureVariant::Compressed => "compressed",
            Xp3FixtureVariant::Unknown => "unknown",
            Xp3FixtureVariant::NotXp3 => "not-xp3",
        }
    }

    pub(super) fn is_detected(variant: Xp3FixtureVariant) -> bool {
        matches!(
            variant,
            Xp3FixtureVariant::Plain
                | Xp3FixtureVariant::Encrypted
                | Xp3FixtureVariant::HelperRequired
                | Xp3FixtureVariant::Compressed
        )
    }

    pub(super) fn can_inventory(variant: Xp3FixtureVariant) -> bool {
        matches!(
            variant,
            Xp3FixtureVariant::Plain | Xp3FixtureVariant::Compressed
        )
    }

    pub(super) fn profile_from_state(&self, state: Xp3FixtureState) -> KaifuuResult<GameProfile> {
        if !Self::is_detected(state.variant) {
            return Err(Self::diagnostic_error(Self::invalid_input_failure(
                state.variant,
            )));
        }
        let mut profile = GameProfile {
            schema_version: "0.1.0".to_string(),
            profile_id: Self::profile_id(state.variant).to_string(),
            game_id: format!("{XP3_GAME_ID}-{}", Self::detected_variant(state.variant)),
            title: "KiriKiri XP3 fixture".to_string(),
            source_locale: "ja-JP".to_string(),
            engine: EngineProfile {
                adapter_id: XP3_DETECTOR_ADAPTER_ID.to_string(),
                engine_family: "kiri_kiri_xp3".to_string(),
                engine_version: None,
                detected_variant: Self::detected_variant(state.variant).to_string(),
            },
            source_fingerprint: Some(SourceFingerprint {
                game_root_hash: None,
                engine_evidence: state.engine_evidence(),
            }),
            key_requirements: state.key_requirements()?,
            archive_parameters: state.archive_parameters(),
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
        state: Xp3FixtureState,
    ) -> KaifuuResult<AssetInventoryManifest> {
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
        if !Self::can_inventory(state.variant) {
            return Err(Self::diagnostic_error(Self::invalid_input_failure(
                state.variant,
            )));
        }
        let archive_bytes = fs::read(&state.archive_path)?;
        let xp3_inventory =
            read_plain_xp3_inventory(&archive_bytes).map_err(Self::inventory_reader_error)?;
        let mut manifest = AssetInventoryManifest {
            schema_version: ASSET_INVENTORY_SCHEMA_VERSION.to_string(),
            manifest_id: deterministic_id("xp3-inventory", 95),
            adapter_id: XP3_DETECTOR_ADAPTER_ID.to_string(),
            source_locale: "ja-JP".to_string(),
            assets: state.inventory_assets(&xp3_inventory.entries),
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
        support_boundary: impl Into<String>,
        remediation: impl Into<String>,
    ) -> AdapterFailure {
        AdapterFailure::semantic(
            AdapterFailureSemanticParams::new(code, XP3_DETECTOR_ADAPTER_ID, support_boundary)
                .engine("kiri_kiri_xp3")
                .detected_variant(variant)
                .asset_ref(XP3_ARCHIVE_PATH)
                .required_capability(required_capability)
                .remediation(remediation),
        )
    }

    pub(super) fn invalid_input_failure(variant: Xp3FixtureVariant) -> AdapterFailure {
        match variant {
            Xp3FixtureVariant::Unknown => Self::unsupported_failure(
                SemanticErrorCode::UnknownEngineVariant,
                Capability::Detection,
                Self::detected_variant(variant),
                "XP3 bytes or names were present without a profiled synthetic XP3 variant",
                "add a profiled synthetic fixture or private-local aggregate evidence before claiming support",
            ),
            Xp3FixtureVariant::NotXp3 => Self::unsupported_failure(
                SemanticErrorCode::UnknownEngineVariant,
                Capability::Detection,
                Self::detected_variant(variant),
                "XP3 profile fixtures require a data.xp3 file with a synthetic XP3 header",
                "run detection with a profiled synthetic XP3 fixture directory or select another adapter",
            ),
            Xp3FixtureVariant::Plain
            | Xp3FixtureVariant::Encrypted
            | Xp3FixtureVariant::HelperRequired
            | Xp3FixtureVariant::Compressed => Self::unsupported_failure(
                SemanticErrorCode::UnsupportedLayeredTransform,
                Capability::ContainerAccess,
                Self::detected_variant(variant),
                XP3_SUPPORT_BOUNDARY,
                "use detect, profile, or asset-inventory output only",
            ),
        }
    }

    pub(super) fn diagnostic_error(failure: AdapterFailure) -> Box<dyn std::error::Error> {
        match kaifuu_core::stable_json(&failure) {
            Ok(serialized) => serialized.into(),
            Err(error) => error,
        }
    }

    pub(super) fn parser_boundary_failure(variant: Xp3FixtureVariant) -> AdapterFailure {
        Self::unsupported_failure(
            SemanticErrorCode::MissingContainerCapability,
            Capability::ContainerAccess,
            Self::detected_variant(variant),
            "XP3 index/entry metadata is parsed for inventory, but payload extraction, decompression, and decryption are outside synthetic XP3 profile fixtures",
            "use identify or asset-inventory output only; do not request extract or patch for this detector profile",
        )
    }

    pub(super) fn crypto_boundary_failure(variant: Xp3FixtureVariant) -> AdapterFailure {
        Self::unsupported_failure(
            SemanticErrorCode::MissingCryptoCapability,
            Capability::CryptoAccess,
            Self::detected_variant(variant),
            "encrypted XP3 inventory requires crypto support and resolved key material; no decryption is implemented",
            "add an explicit crypto-capable XP3 adapter before inventory or extraction",
        )
    }

    pub(super) fn helper_required_failure(variant: Xp3FixtureVariant) -> AdapterFailure {
        Self::unsupported_failure(
            SemanticErrorCode::HelperRequired,
            Capability::KeyProfile,
            Self::detected_variant(variant),
            "this XP3 profile requires an external helper before archive table access",
            "run an approved helper or provide a future helper result before inventory or extraction",
        )
    }

    pub(super) fn inventory_reader_error(
        error: PlainXp3InventoryError,
    ) -> Box<dyn std::error::Error> {
        let failure = match error {
            PlainXp3InventoryError::UnsupportedEncrypted => {
                Self::crypto_boundary_failure(Xp3FixtureVariant::Encrypted)
            }
            PlainXp3InventoryError::UnsupportedIndexEncoding(_) => Self::unsupported_failure(
                SemanticErrorCode::MissingCodecCapability,
                Capability::CodecAccess,
                Self::detected_variant(Xp3FixtureVariant::Compressed),
                format!("plain XP3 inventory supports only raw or zlib index tables: {error}"),
                "use a fixture with a raw or zlib XP3 index table",
            ),
            PlainXp3InventoryError::MalformedHeader
            | PlainXp3InventoryError::Truncated(_)
            | PlainXp3InventoryError::InvalidOffset(_)
            | PlainXp3InventoryError::IndexDecompression(_)
            | PlainXp3InventoryError::InvalidChunk(_)
            | PlainXp3InventoryError::InvalidUtf16Path
            | PlainXp3InventoryError::DuplicateEntry(_) => Self::unsupported_failure(
                SemanticErrorCode::MissingContainerCapability,
                Capability::ContainerAccess,
                Self::detected_variant(Xp3FixtureVariant::Plain),
                format!("plain XP3 inventory could not parse the fixture file table: {error}"),
                "use a well-formed plain XP3 fixture with unique file entries",
            ),
        };
        Self::diagnostic_error(failure)
    }

    pub(super) fn unsupported_patch_result(
        &self,
        patch_export_id: String,
        variant: Xp3FixtureVariant,
    ) -> PatchResult {
        let detected_variant = Self::detected_variant(variant).to_string();
        let mut failures = vec![Self::parser_boundary_failure(variant)];
        if variant == Xp3FixtureVariant::Encrypted {
            failures.push(Self::crypto_boundary_failure(variant));
        }
        if variant == Xp3FixtureVariant::HelperRequired {
            failures.push(Self::helper_required_failure(variant));
        }
        if variant == Xp3FixtureVariant::Compressed {
            failures.push(Self::unsupported_failure(
                SemanticErrorCode::MissingCodecCapability,
                Capability::CodecAccess,
                detected_variant.clone(),
                "compressed XP3 payload handling is outside synthetic XP3 profile fixtures",
                "provide future adapter decompression support before extraction or patching",
            ));
        }
        failures.push(Self::unsupported_failure(
            SemanticErrorCode::MissingPatchBackCapability,
            Capability::PatchBack,
            detected_variant,
            "XP3 patch-back/repack support is not implemented by the detector profile",
            "add an explicit patch-back adapter before writing patched XP3 output",
        ));
        PatchResult {
            schema_version: "0.1.0".to_string(),
            patch_result_id: deterministic_id("xp3-patch", 95),
            patch_export_id,
            status: OperationStatus::Failed,
            output_hash: content_hash(XP3_SUPPORT_BOUNDARY),
            failures,
        }
    }
}
