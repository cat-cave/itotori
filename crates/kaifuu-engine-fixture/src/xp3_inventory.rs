use super::*;

impl Xp3FixtureState {
    pub(super) fn engine_evidence(&self) -> Vec<String> {
        if self.archive_exists {
            vec![XP3_ARCHIVE_PATH.to_string()]
        } else {
            vec![]
        }
    }

    pub(super) fn asset_profiles(&self) -> Vec<AssetProfile> {
        if !self.archive_exists {
            return vec![];
        }
        vec![AssetProfile {
            asset_id: "kirikiri-xp3-archive".to_string(),
            path: XP3_ARCHIVE_PATH.to_string(),
            asset_kind: AssetKind::Archive,
            text_surfaces: vec![TextSurface::Dialogue, TextSurface::Narration],
            source_hash: self.archive_hash.clone(),
            patching: CapabilityReport::unsupported(
                Capability::Patching,
                "XP3 detector profile does not decrypt, extract payloads, decompress, repack, or patch archives",
            ),
        }]
    }

    pub(super) fn inventory_assets(&self, entries: &[PlainXp3Entry]) -> Vec<AssetInventoryAsset> {
        if !self.archive_exists {
            return vec![];
        }
        let mut metadata = BTreeMap::new();
        metadata.insert(
            "signatureMatched".to_string(),
            self.archive_signature.to_string(),
        );
        metadata.insert(
            "detectedVariant".to_string(),
            Xp3ProfileDetectorAdapter::detected_variant(self.variant).to_string(),
        );
        metadata.insert("entryCount".to_string(), entries.len().to_string());
        metadata.insert(
            "profileId".to_string(),
            Xp3ProfileDetectorAdapter::profile_id(self.variant).to_string(),
        );
        metadata.insert(
            "supportBoundary".to_string(),
            "plain XP3 index table parsed for inventory only; payload extraction and patch-back are unsupported".to_string(),
        );
        let mut assets = vec![AssetInventoryAsset {
            asset_id: "kirikiri-xp3-archive".to_string(),
            asset_key: XP3_ARCHIVE_PATH.to_string(),
            asset_kind: AssetInventoryAssetKind::Archive,
            path: Some(XP3_ARCHIVE_PATH.to_string()),
            source_hash: self.archive_hash.clone(),
            metadata,
        }];

        assets.extend(entries.iter().enumerate().map(|(index, entry)| {
            let mut metadata = BTreeMap::new();
            metadata.insert("archivePath".to_string(), XP3_ARCHIVE_PATH.to_string());
            metadata.insert("archiveSize".to_string(), entry.archive_size.to_string());
            metadata.insert("compressed".to_string(), entry.compressed.to_string());
            metadata.insert("originalSize".to_string(), entry.original_size.to_string());
            metadata.insert(
                "profileId".to_string(),
                Xp3ProfileDetectorAdapter::profile_id(self.variant).to_string(),
            );
            metadata.insert("segmentCount".to_string(), entry.segment_count.to_string());
            if let Some(stored_adler32) = &entry.stored_adler32 {
                metadata.insert("storedAdler32".to_string(), stored_adler32.clone());
            }
            AssetInventoryAsset {
                asset_id: format!("kirikiri-xp3-entry-{index:04}"),
                asset_key: entry.path.clone(),
                asset_kind: xp3_inventory_asset_kind(&entry.path),
                path: Some(entry.path.clone()),
                source_hash: entry.payload_hash.clone(),
                metadata,
            }
        }));
        assets
    }

    pub(super) fn archive_parameters(&self) -> Vec<ArchiveParameter> {
        let mut parameters = vec![
            ArchiveParameter {
                parameter_id: "xp3-archive-format".to_string(),
                name: "archiveFormat".to_string(),
                kind: ArchiveParameterKind::ArchiveFormat,
                value: "xp3".to_string(),
                source: Some(ArchiveParameterSource::Detected),
            },
            ArchiveParameter {
                parameter_id: "xp3-profile-variant".to_string(),
                name: "variant".to_string(),
                kind: ArchiveParameterKind::Variant,
                value: Xp3ProfileDetectorAdapter::archive_parameter_variant(self.variant)
                    .to_string(),
                source: Some(ArchiveParameterSource::Detected),
            },
        ];
        match self.variant {
            Xp3FixtureVariant::Encrypted => parameters.push(ArchiveParameter {
                parameter_id: "xp3-cipher-scheme".to_string(),
                name: "cipherScheme".to_string(),
                kind: ArchiveParameterKind::CipherScheme,
                value: "fixture-key-profile-marker".to_string(),
                source: Some(ArchiveParameterSource::Detected),
            }),
            Xp3FixtureVariant::HelperRequired => parameters.push(ArchiveParameter {
                parameter_id: "xp3-helper-requirement".to_string(),
                name: "helperRequirement".to_string(),
                kind: ArchiveParameterKind::Variant,
                value: "fixture-helper-required".to_string(),
                source: Some(ArchiveParameterSource::Detected),
            }),
            Xp3FixtureVariant::Compressed => parameters.push(ArchiveParameter {
                parameter_id: "xp3-compression".to_string(),
                name: "compression".to_string(),
                kind: ArchiveParameterKind::Compression,
                value: "compressed".to_string(),
                source: Some(ArchiveParameterSource::Detected),
            }),
            Xp3FixtureVariant::Plain | Xp3FixtureVariant::Unknown | Xp3FixtureVariant::NotXp3 => {}
        }
        parameters
    }

    pub(super) fn key_requirements(&self) -> KaifuuResult<Vec<KeyRequirement>> {
        if !matches!(
            self.variant,
            Xp3FixtureVariant::Encrypted | Xp3FixtureVariant::HelperRequired
        ) {
            return Ok(vec![]);
        }
        Ok(vec![KeyRequirement {
            requirement_id: "kirikiri-xp3-key-profile".to_string(),
            secret_ref: SecretRef::new(
                "local-secret:fixture/kirikiri/xp3-archive-password".to_string(),
            )?,
            kind: KeyMaterialKind::ArchivePassword,
            bytes: None,
            validation: None,
        }])
    }

    pub(super) fn layered_access_profile(&self) -> LayeredAccessProfile {
        let (crypto, key_material_status, helper_status, key_requirement_refs) = match self.variant
        {
            Xp3FixtureVariant::Encrypted => (
                CryptoTransform::KeyProfile,
                LayeredAccessKeyMaterialStatus::Missing,
                LayeredAccessHelperStatus::Unavailable,
                vec!["kirikiri-xp3-key-profile".to_string()],
            ),
            Xp3FixtureVariant::HelperRequired => (
                CryptoTransform::HelperGated,
                LayeredAccessKeyMaterialStatus::HelperGated,
                LayeredAccessHelperStatus::Unavailable,
                vec!["kirikiri-xp3-key-profile".to_string()],
            ),
            Xp3FixtureVariant::Plain | Xp3FixtureVariant::Compressed => (
                CryptoTransform::NullKey,
                LayeredAccessKeyMaterialStatus::NotRequired,
                LayeredAccessHelperStatus::NotRequired,
                vec![],
            ),
            Xp3FixtureVariant::Unknown | Xp3FixtureVariant::NotXp3 => (
                CryptoTransform::Unknown,
                LayeredAccessKeyMaterialStatus::Missing,
                LayeredAccessHelperStatus::Unavailable,
                vec![],
            ),
        };
        let mut profile = LayeredAccessProfile {
            schema_version: "0.1.0".to_string(),
            surfaces: vec![LayeredTextSurfaceAccess {
                surface_id: "kirikiri-xp3-archive#dialogue".to_string(),
                asset_id: "kirikiri-xp3-archive".to_string(),
                path: XP3_ARCHIVE_PATH.to_string(),
                text_surface: TextSurface::Dialogue,
                surface_transform: SurfaceTransform::ArchiveEntry,
                surface_selector: "aggregate-only:synthetic-xp3-archive".to_string(),
                container: ContainerTransform::Xp3,
                crypto,
                codec: CodecTransform::Unknown,
                patch_back: PatchBackTransform::Unsupported,
                key_material_status,
                helper_status,
                key_requirement_refs,
                notes: vec![
                    "detector-only layered access record; plain inventory may list XP3 entries, but script decoding, extraction, and patch-back are not claimed".to_string(),
                ],
            }],
        };
        profile.normalize();
        profile
    }

    pub(super) fn detection_requirements(&self) -> Vec<ProfileRequirement> {
        let mut requirements = vec![
            ProfileRequirement {
                category: RequirementCategory::File,
                key: XP3_ARCHIVE_PATH.to_string(),
                status: if self.archive_signature {
                    RequirementStatus::Satisfied
                } else {
                    RequirementStatus::Missing
                },
                description: "synthetic XP3 archive header fixture".to_string(),
                placeholder: None,
                secret: false,
            },
            ProfileRequirement {
                category: RequirementCategory::Platform,
                key: "xp3-parser".to_string(),
                status: RequirementStatus::Unsupported,
                description: "XP3 archive parser/rebuilder boundary is unsupported for the synthetic detector profile"
                    .to_string(),
                placeholder: None,
                secret: false,
            },
        ];
        if matches!(
            self.variant,
            Xp3FixtureVariant::Encrypted | Xp3FixtureVariant::HelperRequired
        ) {
            requirements.push(ProfileRequirement {
                category: RequirementCategory::SecretKey,
                key: "kirikiri-xp3-key-profile".to_string(),
                status: RequirementStatus::Missing,
                description: if self.variant == Xp3FixtureVariant::HelperRequired {
                    "XP3 helper-required payload is detected, but helper execution is outside the detector profile"
                } else {
                    "encrypted XP3 payload is detected, but key resolution is outside the detector profile"
                }
                .to_string(),
                placeholder: Some("KAIFUU_KIRIKIRI_XP3_KEY_PROFILE".to_string()),
                secret: true,
            });
        }
        if self.variant == Xp3FixtureVariant::Compressed {
            requirements.push(ProfileRequirement {
                category: RequirementCategory::Platform,
                key: "xp3-decompressor".to_string(),
                status: RequirementStatus::Unsupported,
                description: "compressed XP3 payload handling is outside the detector profile"
                    .to_string(),
                placeholder: None,
                secret: false,
            });
        }
        if self.variant == Xp3FixtureVariant::Unknown {
            requirements.push(ProfileRequirement {
                category: RequirementCategory::File,
                key: "xp3-synthetic-profile-marker".to_string(),
                status: RequirementStatus::Unsupported,
                description: "XP3 header was present without a profiled synthetic fixture variant"
                    .to_string(),
                placeholder: None,
                secret: false,
            });
        }
        requirements
    }

    pub(super) fn profile_requirements(&self) -> Vec<ProfileRequirement> {
        vec![
            ProfileRequirement {
                category: RequirementCategory::File,
                key: XP3_ARCHIVE_PATH.to_string(),
                status: RequirementStatus::Satisfied,
                description: "synthetic XP3 detector evidence status".to_string(),
                placeholder: None,
                secret: false,
            },
            ProfileRequirement {
                category: RequirementCategory::Platform,
                key: "xp3-parser".to_string(),
                status: RequirementStatus::NotRequired,
                description: "parser/runtime helpers are outside the detector-only profile"
                    .to_string(),
                placeholder: None,
                secret: false,
            },
            ProfileRequirement {
                category: RequirementCategory::SecretKey,
                key: "kirikiri-xp3-key-profile".to_string(),
                status: RequirementStatus::NotRequired,
                description: if matches!(
                    self.variant,
                    Xp3FixtureVariant::Encrypted | Xp3FixtureVariant::HelperRequired
                ) {
                    "encrypted XP3 profile metadata names the key requirement, but detector-only profiles do not resolve local key material"
                } else {
                    "key material is not required for this synthetic XP3 profile"
                }
                .to_string(),
                placeholder: None,
                secret: true,
            },
        ]
    }

    pub(super) fn metadata(&self) -> BTreeMap<String, String> {
        let mut metadata = BTreeMap::new();
        metadata.insert("fixtureOnly".to_string(), "true".to_string());
        metadata.insert(
            "profileDiagnostics.encryptedPayload".to_string(),
            (self.variant == Xp3FixtureVariant::Encrypted).to_string(),
        );
        if self.variant == Xp3FixtureVariant::HelperRequired {
            metadata.insert(
                "profileDiagnostics.helperRequired".to_string(),
                "true".to_string(),
            );
        }
        metadata.insert(
            "profileDiagnostics.compressedPayload".to_string(),
            (self.variant == Xp3FixtureVariant::Compressed).to_string(),
        );
        metadata.insert(
            "profileDiagnostics.unknownVariant".to_string(),
            (self.variant == Xp3FixtureVariant::Unknown).to_string(),
        );
        metadata.insert(
            "profileDiagnostics.unsupportedParserBoundary".to_string(),
            "true".to_string(),
        );
        metadata.insert(
            "supportBoundary".to_string(),
            XP3_SUPPORT_BOUNDARY.to_string(),
        );
        metadata
    }
}
