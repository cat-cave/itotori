use super::*;

impl RealLiveFixtureState {
    pub(super) fn engine_evidence(&self) -> Vec<String> {
        let mut evidence = Vec::new();
        if self.seen_txt_exists {
            evidence.push(REALLIVE_SEEN_TXT_PATH.to_string());
        }
        if self.seen_gan_exists {
            evidence.push(REALLIVE_SEEN_GAN_PATH.to_string());
        }
        if self.gameexe_ini_exists {
            evidence.push(REALLIVE_GAMEEXE_INI_PATH.to_string());
        }
        evidence
    }

    pub(super) fn asset_profiles(&self) -> Vec<AssetProfile> {
        let mut assets = Vec::new();
        if self.seen_txt_exists {
            assets.push(AssetProfile {
                asset_id: "reallive-seen-txt".to_string(),
                path: REALLIVE_SEEN_TXT_PATH.to_string(),
                asset_kind: AssetKind::Archive,
                text_surfaces: vec![TextSurface::Dialogue, TextSurface::Narration],
                source_hash: self.seen_txt_hash.clone(),
                patching: CapabilityReport::unsupported(
                    Capability::Patching,
                    "RealLive detector profile does not parse, repack, or patch SEEN.TXT",
                ),
            });
        }
        if self.seen_gan_exists {
            assets.push(AssetProfile {
                asset_id: "reallive-seen-gan".to_string(),
                path: REALLIVE_SEEN_GAN_PATH.to_string(),
                asset_kind: AssetKind::Archive,
                text_surfaces: vec![],
                source_hash: self.seen_gan_hash.clone(),
                patching: CapabilityReport::unsupported(
                    Capability::Patching,
                    "RealLive detector profile does not parse or patch SEEN.GAN",
                ),
            });
        }
        if self.gameexe_ini_exists {
            assets.push(AssetProfile {
                asset_id: "reallive-gameexe-ini".to_string(),
                path: REALLIVE_GAMEEXE_INI_PATH.to_string(),
                asset_kind: AssetKind::Metadata,
                text_surfaces: vec![TextSurface::MetadataText],
                source_hash: self.gameexe_ini_hash.clone(),
                patching: CapabilityReport::unsupported(
                    Capability::Patching,
                    "RealLive detector profile does not patch Gameexe.ini metadata",
                ),
            });
        }
        assets
    }

    pub(super) fn inventory_assets(&self) -> Vec<AssetInventoryAsset> {
        let mut assets = Vec::new();
        if self.seen_txt_exists {
            let mut metadata = BTreeMap::new();
            metadata.insert(
                "syntheticMagicMatched".to_string(),
                self.seen_txt_synthetic_magic.to_string(),
            );
            metadata.insert(
                "envelopeValid".to_string(),
                self.seen_txt_envelope_ok.to_string(),
            );
            metadata.insert(
                "supportBoundary".to_string(),
                "container identified only; archive entries are not parsed".to_string(),
            );
            assets.push(AssetInventoryAsset {
                asset_id: "reallive-seen-txt".to_string(),
                asset_key: REALLIVE_SEEN_TXT_PATH.to_string(),
                asset_kind: AssetInventoryAssetKind::Archive,
                path: Some(REALLIVE_SEEN_TXT_PATH.to_string()),
                source_hash: self.seen_txt_hash.clone(),
                metadata,
            });
        }
        if self.seen_gan_exists {
            let mut metadata = BTreeMap::new();
            metadata.insert(
                "syntheticMagicMatched".to_string(),
                self.seen_gan_synthetic_magic.to_string(),
            );
            metadata.insert(
                "supportBoundary".to_string(),
                "container identified only; animation entries are not parsed".to_string(),
            );
            assets.push(AssetInventoryAsset {
                asset_id: "reallive-seen-gan".to_string(),
                asset_key: REALLIVE_SEEN_GAN_PATH.to_string(),
                asset_kind: AssetInventoryAssetKind::Archive,
                path: Some(REALLIVE_SEEN_GAN_PATH.to_string()),
                source_hash: self.seen_gan_hash.clone(),
                metadata,
            });
        }
        if self.gameexe_ini_exists {
            let mut metadata = BTreeMap::new();
            metadata.insert(
                "syntheticMagicMatched".to_string(),
                self.gameexe_ini_synthetic_magic.to_string(),
            );
            metadata.insert(
                "gameexeVersionKeyPresent".to_string(),
                self.gameexe_ini_keys.gameexe_version.to_string(),
            );
            metadata.insert(
                "regnameKeyPresent".to_string(),
                self.gameexe_ini_keys.regname.to_string(),
            );
            metadata.insert(
                "g00KeyPresent".to_string(),
                self.gameexe_ini_keys.g00_key.to_string(),
            );
            metadata.insert(
                "koeKeyPresent".to_string(),
                self.gameexe_ini_keys.koe_key.to_string(),
            );
            metadata.insert(
                "seenKeyPresent".to_string(),
                self.gameexe_ini_keys.seen_key.to_string(),
            );
            metadata.insert(
                "supportBoundary".to_string(),
                "metadata identified only; full Gameexe.ini parsing is not implemented".to_string(),
            );
            assets.push(AssetInventoryAsset {
                asset_id: "reallive-gameexe-ini".to_string(),
                asset_key: REALLIVE_GAMEEXE_INI_PATH.to_string(),
                asset_kind: AssetInventoryAssetKind::Metadata,
                path: Some(REALLIVE_GAMEEXE_INI_PATH.to_string()),
                source_hash: self.gameexe_ini_hash.clone(),
                metadata,
            });
        }
        assets
    }

    pub(super) fn layered_access_profile(&self) -> LayeredAccessProfile {
        let mut surfaces = Vec::new();
        if self.seen_txt_exists {
            surfaces.push(LayeredTextSurfaceAccess {
                surface_id: "reallive-seen-txt#dialogue".to_string(),
                asset_id: "reallive-seen-txt".to_string(),
                path: REALLIVE_SEEN_TXT_PATH.to_string(),
                text_surface: TextSurface::Dialogue,
                surface_transform: SurfaceTransform::ArchiveEntry,
                surface_selector: "aggregate-only:synthetic-seen-archive".to_string(),
                container: ContainerTransform::LooseFile,
                crypto: CryptoTransform::Unknown,
                codec: CodecTransform::Unknown,
                patch_back: PatchBackTransform::Unsupported,
                key_material_status: LayeredAccessKeyMaterialStatus::Missing,
                helper_status: LayeredAccessHelperStatus::Unavailable,
                key_requirement_refs: vec![],
                notes: vec![
                    "detector-only layered access record; no Scene/SEEN parser, normalized script text, or archive entry listing is claimed".to_string(),
                ],
            });
        }
        if self.gameexe_ini_exists {
            surfaces.push(LayeredTextSurfaceAccess {
                surface_id: "reallive-gameexe-ini#metadata".to_string(),
                asset_id: "reallive-gameexe-ini".to_string(),
                path: REALLIVE_GAMEEXE_INI_PATH.to_string(),
                text_surface: TextSurface::MetadataText,
                surface_transform: SurfaceTransform::Identity,
                surface_selector: "aggregate-only:synthetic-gameexe-ini-metadata".to_string(),
                container: ContainerTransform::LooseFile,
                crypto: CryptoTransform::Unknown,
                codec: CodecTransform::Unknown,
                patch_back: PatchBackTransform::Unsupported,
                key_material_status: LayeredAccessKeyMaterialStatus::Missing,
                helper_status: LayeredAccessHelperStatus::Unavailable,
                key_requirement_refs: vec![],
                notes: vec![
                    "detector-only metadata record; full Gameexe.ini parsing is outside this profile".to_string(),
                ],
            });
        }
        let mut profile = LayeredAccessProfile {
            schema_version: "0.1.0".to_string(),
            surfaces,
        };
        profile.normalize();
        profile
    }

    pub(super) fn detection_requirements(&self) -> Vec<ProfileRequirement> {
        vec![
            ProfileRequirement {
                category: RequirementCategory::File,
                key: REALLIVE_SEEN_TXT_PATH.to_string(),
                status: if self.seen_txt_envelope_ok {
                    RequirementStatus::Satisfied
                } else if self.seen_txt_exists {
                    RequirementStatus::Unsupported
                } else {
                    RequirementStatus::Missing
                },
                description: "RealLive SEEN.TXT envelope (synthetic magic or generic shape)".to_string(),
                placeholder: None,
                secret: false,
            },
            ProfileRequirement {
                category: RequirementCategory::File,
                key: REALLIVE_GAMEEXE_INI_PATH.to_string(),
                status: if self.gameexe_ini_keys.any() {
                    RequirementStatus::Satisfied
                } else if self.gameexe_ini_exists {
                    RequirementStatus::Unsupported
                } else {
                    RequirementStatus::Missing
                },
                description: "RealLive Gameexe.ini with at least one RealLive-specific key (#GAMEEXE_VERSION, #REGNAME, #G00*, #KOE*, #SEEN*)".to_string(),
                placeholder: None,
                secret: false,
            },
            ProfileRequirement {
                category: RequirementCategory::Platform,
                key: "reallive-parser".to_string(),
                status: RequirementStatus::Unsupported,
                description: "Scene/SEEN parser/decompiler boundary is unsupported for the synthetic detector profile".to_string(),
                placeholder: None,
                secret: false,
            },
        ]
    }

    pub(super) fn profile_requirements(&self) -> Vec<ProfileRequirement> {
        vec![
            ProfileRequirement {
                category: RequirementCategory::File,
                key: REALLIVE_SEEN_TXT_PATH.to_string(),
                status: if self.seen_txt_exists {
                    RequirementStatus::Satisfied
                } else {
                    RequirementStatus::NotRequired
                },
                description: "RealLive SEEN.TXT detector evidence status".to_string(),
                placeholder: None,
                secret: false,
            },
            ProfileRequirement {
                category: RequirementCategory::File,
                key: REALLIVE_GAMEEXE_INI_PATH.to_string(),
                status: if self.gameexe_ini_exists {
                    RequirementStatus::Satisfied
                } else {
                    RequirementStatus::NotRequired
                },
                description: "RealLive Gameexe.ini detector evidence status".to_string(),
                placeholder: None,
                secret: false,
            },
            ProfileRequirement {
                category: RequirementCategory::Platform,
                key: "reallive-parser".to_string(),
                status: RequirementStatus::NotRequired,
                description: "parser/runtime helpers are outside the detector-only profile"
                    .to_string(),
                placeholder: None,
                secret: false,
            },
        ]
    }

    pub(super) fn metadata(&self) -> BTreeMap<String, String> {
        let mut metadata = BTreeMap::new();
        metadata.insert("fixtureOnly".to_string(), "true".to_string());
        metadata.insert(
            "profileDiagnostics.ambiguousSiglusOverlap".to_string(),
            (self.siglus_scene_pck_present || self.siglus_gameexe_dat_present).to_string(),
        );
        metadata.insert(
            "profileDiagnostics.avg32PdtPresent".to_string(),
            (self.avg32_pdt_count > 0).to_string(),
        );
        metadata.insert(
            "profileDiagnostics.gameexeIniKeyHits".to_string(),
            self.gameexe_ini_keys.any().to_string(),
        );
        metadata.insert(
            "profileDiagnostics.unsupportedParserBoundary".to_string(),
            "true".to_string(),
        );
        metadata.insert("g00Count".to_string(), self.g00_count.to_string());
        metadata.insert(
            "voiceArchiveCount".to_string(),
            self.voice_archive_count.to_string(),
        );
        metadata.insert(
            "supportBoundary".to_string(),
            REALLIVE_SUPPORT_BOUNDARY.to_string(),
        );
        metadata
    }
}
