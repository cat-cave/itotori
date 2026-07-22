use super::*;

impl SiglusFixtureState {
    pub(super) fn engine_evidence(&self) -> Vec<String> {
        let mut evidence = Vec::new();
        if self.scene_exists {
            evidence.push(SIGLUS_SCENE_PATH.to_string());
        }
        if self.gameexe_exists {
            evidence.push(SIGLUS_GAMEEXE_PATH.to_string());
        }
        evidence
    }

    pub(super) fn asset_profiles(&self) -> Vec<AssetProfile> {
        let mut assets = Vec::new();
        if self.scene_exists {
            assets.push(AssetProfile {
                asset_id: "siglus-scene-pck".to_string(),
                path: SIGLUS_SCENE_PATH.to_string(),
                asset_kind: AssetKind::Archive,
                text_surfaces: vec![TextSurface::Dialogue, TextSurface::Narration],
                source_hash: self.scene_hash.clone(),
                patching: CapabilityReport::unsupported(
                    Capability::Patching,
                    "Siglus detector profile does not parse, decrypt, repack, or patch Scene.pck",
                ),
            });
        }
        if self.gameexe_exists {
            assets.push(AssetProfile {
                asset_id: "siglus-gameexe-dat".to_string(),
                path: SIGLUS_GAMEEXE_PATH.to_string(),
                asset_kind: AssetKind::Metadata,
                text_surfaces: vec![TextSurface::MetadataText],
                source_hash: self.gameexe_hash.clone(),
                patching: CapabilityReport::unsupported(
                    Capability::Patching,
                    "Siglus detector profile does not patch Gameexe.dat metadata",
                ),
            });
        }
        assets
    }

    pub(super) fn inventory_assets(&self) -> Vec<AssetInventoryAsset> {
        let mut assets = Vec::new();
        if self.scene_exists {
            let mut metadata = BTreeMap::new();
            metadata.insert(
                "signatureMatched".to_string(),
                self.scene_signature.to_string(),
            );
            metadata.insert(
                "supportBoundary".to_string(),
                "container identified only; archive entries are not parsed".to_string(),
            );
            assets.push(AssetInventoryAsset {
                asset_id: "siglus-scene-pck".to_string(),
                asset_key: SIGLUS_SCENE_PATH.to_string(),
                asset_kind: AssetInventoryAssetKind::Archive,
                path: Some(SIGLUS_SCENE_PATH.to_string()),
                source_hash: self.scene_hash.clone(),
                metadata,
            });
        }
        if self.gameexe_exists {
            let mut metadata = BTreeMap::new();
            metadata.insert(
                "signatureMatched".to_string(),
                self.gameexe_signature.to_string(),
            );
            metadata.insert(
                "supportBoundary".to_string(),
                "metadata identified only; secondary-key discovery is not implemented".to_string(),
            );
            assets.push(AssetInventoryAsset {
                asset_id: "siglus-gameexe-dat".to_string(),
                asset_key: SIGLUS_GAMEEXE_PATH.to_string(),
                asset_kind: AssetInventoryAssetKind::Metadata,
                path: Some(SIGLUS_GAMEEXE_PATH.to_string()),
                source_hash: self.gameexe_hash.clone(),
                metadata,
            });
        }
        assets
    }

    pub(super) fn layered_access_profile(&self) -> LayeredAccessProfile {
        let mut surfaces = Vec::new();
        if self.scene_exists {
            surfaces.push(LayeredTextSurfaceAccess {
                surface_id: "siglus-scene-pck#dialogue".to_string(),
                asset_id: "siglus-scene-pck".to_string(),
                path: SIGLUS_SCENE_PATH.to_string(),
                text_surface: TextSurface::Dialogue,
                surface_transform: SurfaceTransform::ArchiveEntry,
                surface_selector: "aggregate-only:synthetic-scene-package".to_string(),
                container: ContainerTransform::SiglusPck,
                crypto: CryptoTransform::KeyProfile,
                codec: CodecTransform::Unknown,
                patch_back: PatchBackTransform::Unsupported,
                key_material_status: LayeredAccessKeyMaterialStatus::Missing,
                helper_status: LayeredAccessHelperStatus::Unavailable,
                key_requirement_refs: vec![],
                notes: vec![
                    "detector-only layered access record; no parser, normalized script text, or archive entry listing is claimed".to_string(),
                ],
            });
        }
        if self.gameexe_exists {
            surfaces.push(LayeredTextSurfaceAccess {
                surface_id: "siglus-gameexe-dat#metadata".to_string(),
                asset_id: "siglus-gameexe-dat".to_string(),
                path: SIGLUS_GAMEEXE_PATH.to_string(),
                text_surface: TextSurface::MetadataText,
                surface_transform: SurfaceTransform::BinaryOffset,
                surface_selector: "aggregate-only:synthetic-gameexe-metadata".to_string(),
                container: ContainerTransform::LooseFile,
                crypto: CryptoTransform::Unknown,
                codec: CodecTransform::Unknown,
                patch_back: PatchBackTransform::Unsupported,
                key_material_status: LayeredAccessKeyMaterialStatus::Missing,
                helper_status: LayeredAccessHelperStatus::Unavailable,
                key_requirement_refs: vec![],
                notes: vec![
                    "detector-only metadata record; secondary-key derivation is outside this profile".to_string(),
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
        let mut requirements = vec![
            ProfileRequirement {
                category: RequirementCategory::File,
                key: SIGLUS_SCENE_PATH.to_string(),
                status: if self.scene_signature {
                    RequirementStatus::Satisfied
                } else {
                    RequirementStatus::Missing
                },
                description: if self.scene_real {
                    "real Siglus Scene.pck archive-header signature".to_string()
                } else {
                    "synthetic Siglus Scene.pck signature fixture".to_string()
                },
                placeholder: None,
                secret: false,
            },
            ProfileRequirement {
                category: RequirementCategory::File,
                key: SIGLUS_GAMEEXE_PATH.to_string(),
                status: if self.gameexe_signature {
                    RequirementStatus::Satisfied
                } else {
                    RequirementStatus::Missing
                },
                description: if self.gameexe_real {
                    "real Siglus Gameexe.dat archive-header signature".to_string()
                } else {
                    "synthetic Siglus Gameexe.dat signature fixture".to_string()
                },
                placeholder: None,
                secret: false,
            },
            ProfileRequirement {
                category: RequirementCategory::SecretKey,
                key: "siglus-secondary-key".to_string(),
                status: RequirementStatus::Missing,
                description: "encrypted Siglus payload is detected, but key resolution is outside the detector profile".to_string(),
                placeholder: Some("KAIFUU_SIGLUS_SECONDARY_KEY_PROFILE".to_string()),
                secret: true,
            },
            ProfileRequirement {
                category: RequirementCategory::Platform,
                key: "siglus-parser".to_string(),
                status: RequirementStatus::Unsupported,
                description: "Scene.pck parser/decompiler boundary is unsupported for the synthetic detector profile".to_string(),
                placeholder: None,
                secret: false,
            },
        ];
        if self.variant == SiglusFixtureVariant::UnknownNamedPair {
            requirements.push(ProfileRequirement {
                category: RequirementCategory::File,
                key: "siglus-synthetic-signature".to_string(),
                status: RequirementStatus::Unsupported,
                description: "Scene.pck/Gameexe.dat names were present without recognized synthetic fixture signatures".to_string(),
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
                key: SIGLUS_SCENE_PATH.to_string(),
                status: if self.scene_exists {
                    RequirementStatus::Satisfied
                } else {
                    RequirementStatus::NotRequired
                },
                description: "synthetic Siglus Scene.pck detector evidence status".to_string(),
                placeholder: None,
                secret: false,
            },
            ProfileRequirement {
                category: RequirementCategory::File,
                key: SIGLUS_GAMEEXE_PATH.to_string(),
                status: if self.gameexe_exists {
                    RequirementStatus::Satisfied
                } else {
                    RequirementStatus::NotRequired
                },
                description: "synthetic Siglus Gameexe.dat detector evidence status".to_string(),
                placeholder: None,
                secret: false,
            },
            ProfileRequirement {
                category: RequirementCategory::SecretKey,
                key: "siglus-secondary-key".to_string(),
                status: RequirementStatus::NotRequired,
                description: "key material is not accepted by the detector-only profile"
                    .to_string(),
                placeholder: None,
                secret: true,
            },
            ProfileRequirement {
                category: RequirementCategory::Platform,
                key: "siglus-parser".to_string(),
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
        // Real archive-header signatures are not fixtures; report honestly so
        // downstream consumers do not treat a real Siglus title as synthetic.
        // Synthetic fixtures keep `fixtureOnly=true` (byte-identical output);
        // a real pair reports `false`.
        let real_pair = matches!(self.variant, SiglusFixtureVariant::CompleteRealPair);
        metadata.insert("fixtureOnly".to_string(), (!real_pair).to_string());
        metadata.insert(
            "profileDiagnostics.missingPair".to_string(),
            (!self.scene_signature || !self.gameexe_signature).to_string(),
        );
        metadata.insert(
            "profileDiagnostics.unknownVariant".to_string(),
            (self.variant == SiglusFixtureVariant::UnknownNamedPair).to_string(),
        );
        metadata.insert(
            "profileDiagnostics.encryptedPayload".to_string(),
            self.scene_signature.to_string(),
        );
        metadata.insert(
            "profileDiagnostics.unsupportedParserBoundary".to_string(),
            "true".to_string(),
        );
        metadata.insert(
            "supportBoundary".to_string(),
            SIGLUS_SUPPORT_BOUNDARY.to_string(),
        );
        metadata
    }
}
