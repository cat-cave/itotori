use super::*;

/// The named MV/MZ audio surfaces this path handles. Each owns a stable
/// [`MvMzAudioSurface::surface_id`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MvMzAudioSurface {
    /// `www/audio/bgm/*` background music.
    Bgm,
    /// `www/audio/bgs/*` background sounds.
    Bgs,
    /// `www/audio/me/*` musical effects.
    Me,
    /// `www/audio/se/*` sound effects.
    Se,
}

impl MvMzAudioSurface {
    /// All named audio surfaces in canonical order.
    pub fn all() -> [Self; 4] {
        [Self::Bgm, Self::Bgs, Self::Me, Self::Se]
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Bgm => "bgm",
            Self::Bgs => "bgs",
            Self::Me => "me",
            Self::Se => "se",
        }
    }

    /// Stable, public surface id.
    pub fn surface_id(self) -> String {
        format!("mv_mz/audio/{}", self.as_str())
    }

    /// File glob (relative to the project root) the surface covers. MV ships
    /// `.rpgmvo`; MZ ships `.ogg_` — both route through this path.
    pub fn file_glob(self) -> &'static str {
        match self {
            Self::Bgm => "www/audio/bgm/*.{rpgmvo,ogg_}",
            Self::Bgs => "www/audio/bgs/*.{rpgmvo,ogg_}",
            Self::Me => "www/audio/me/*.{rpgmvo,ogg_}",
            Self::Se => "www/audio/se/*.{rpgmvo,ogg_}",
        }
    }
}

/// The crypto profile this path declares: the MV/MZ asset-XOR scheme. Carries
/// only public, non-secret facts (a hash of the public header magic, the header
/// and key lengths, the material kind).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpgMakerAudioCryptoProfile {
    pub profile_id: String,
    pub crypto: CryptoTransform,
    /// sha256 of the public 16-byte RPGMV header magic (never a key).
    pub header_magic_hash: ProofHash,
    pub header_len: u32,
    pub xor_prefix_len: u32,
    pub key_material_kind: KeyMaterialKind,
    pub key_bytes: u32,
}

impl RpgMakerAudioCryptoProfile {
    /// The canonical MV/MZ asset-XOR crypto profile.
    pub fn asset_xor() -> KaifuuResult<Self> {
        Ok(Self {
            profile_id: MV_MZ_ENCRYPTED_AUDIO_CRYPTO_PROFILE_ID.to_string(),
            crypto: CryptoTransform::RpgMakerAssetXor,
            header_magic_hash: ProofHash::new(sha256_hash_bytes(
                RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER,
            ))?,
            header_len: RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER.len() as u32,
            xor_prefix_len: RPGMAKER_AUDIO_XOR_PREFIX_LEN as u32,
            key_material_kind: KeyMaterialKind::RpgMakerAssetKey,
            key_bytes: RPGMAKER_AUDIO_XOR_PREFIX_LEN as u32,
        })
    }
}

/// One declared diagnostic this path can emit (the failure vocabulary).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzEncryptedAudioDiagnosticDeclaration {
    pub code: String,
    pub semantic_code: String,
    pub severity: PartialDiagnosticSeverity,
    pub summary: String,
}

impl MvMzEncryptedAudioDiagnosticDeclaration {
    fn new(code: &str, semantic_code: &str, summary: &str) -> Self {
        Self {
            code: code.to_string(),
            semantic_code: semantic_code.to_string(),
            severity: PartialDiagnosticSeverity::P0,
            summary: summary.to_string(),
        }
    }

    fn canonical() -> Vec<Self> {
        vec![
            Self::new(
                FINDING_WRONG_KEY,
                SEMANTIC_MV_MZ_AUDIO_WRONG_KEY,
                "candidate key did not decrypt the asset to a valid OGG; no re-encryption performed",
            ),
            Self::new(
                FINDING_MISSING_KEY,
                SEMANTIC_MV_MZ_AUDIO_MISSING_KEY,
                "no asset key was resolvable for the secret requirement; no decryption attempted",
            ),
            Self::new(
                FINDING_UNSUPPORTED_SURFACE,
                SEMANTIC_MV_MZ_AUDIO_UNSUPPORTED_SURFACE,
                "surface codec is not OGG audio; image and JSON surfaces are outside this path",
            ),
            Self::new(
                FINDING_UNSUPPORTED_VARIANT,
                SEMANTIC_MV_MZ_AUDIO_UNSUPPORTED_VARIANT,
                "asset bytes are not a well-formed RPGMV-header encrypted audio asset",
            ),
        ]
    }
}

/// The full path declaration consumed by the capability matrix and audits. It
/// pins every leg of the transform stack plus the fixture id, secret
/// requirement ids, and the diagnostic vocabulary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzEncryptedAudioPath {
    pub schema_version: String,
    pub engine_family: String,
    pub variant: String,
    pub container: ContainerTransform,
    pub crypto_profile: RpgMakerAudioCryptoProfile,
    pub codec: CodecTransform,
    pub surface: SurfaceTransform,
    pub patch_back: PatchBackTransform,
    pub fixture_id: String,
    pub secret_requirement_ids: Vec<String>,
    pub audio_surfaces: Vec<MvMzAudioSurfaceDeclaration>,
    pub diagnostics: Vec<MvMzEncryptedAudioDiagnosticDeclaration>,
    pub support_boundary: String,
}

/// One named audio surface as declared in the path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzAudioSurfaceDeclaration {
    pub surface_id: String,
    pub surface: MvMzAudioSurface,
    pub file_glob: String,
    pub codec: CodecTransform,
}

impl MvMzAudioSurfaceDeclaration {
    fn of(surface: MvMzAudioSurface) -> Self {
        Self {
            surface_id: surface.surface_id(),
            surface,
            file_glob: surface.file_glob().to_string(),
            codec: CodecTransform::OggAudio,
        }
    }
}

/// A structured violation of the path declaration. `validate` returns one per
/// offending field so failures are machine-actionable findings, never prose.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum MvMzEncryptedAudioPathViolation {
    WrongEngineFamily {
        found: String,
    },
    WrongVariant {
        found: String,
    },
    WrongContainer {
        found: ContainerTransform,
    },
    WrongCodec {
        found: CodecTransform,
    },
    CryptoProfileNotAssetXor {
        found: CryptoTransform,
    },
    PatchBackNotReplaceAsset {
        found: PatchBackTransform,
    },
    NoSecretRequirement,
    NoAudioSurface,
    AudioSurfaceClaimsNonAudioCodec {
        surface_id: String,
        codec: CodecTransform,
    },
    NoDiagnostics,
}

impl MvMzEncryptedAudioPath {
    /// The canonical, fully-populated path declaration.
    pub fn canonical() -> KaifuuResult<Self> {
        Ok(Self {
            schema_version: MV_MZ_ENCRYPTED_AUDIO_SCHEMA_VERSION.to_string(),
            engine_family: MV_MZ_ENCRYPTED_AUDIO_ENGINE_FAMILY.to_string(),
            variant: MV_MZ_ENCRYPTED_AUDIO_VARIANT.to_string(),
            container: ContainerTransform::ProjectAsset,
            crypto_profile: RpgMakerAudioCryptoProfile::asset_xor()?,
            codec: CodecTransform::OggAudio,
            // A named asset entry inside the project-asset container.
            surface: SurfaceTransform::ArchiveEntry,
            patch_back: PatchBackTransform::ReplaceAsset,
            fixture_id: MV_MZ_ENCRYPTED_AUDIO_FIXTURE_ID.to_string(),
            secret_requirement_ids: vec![MV_MZ_ENCRYPTED_AUDIO_REQUIREMENT_ID.to_string()],
            audio_surfaces: MvMzAudioSurface::all()
                .into_iter()
                .map(MvMzAudioSurfaceDeclaration::of)
                .collect(),
            diagnostics: MvMzEncryptedAudioDiagnosticDeclaration::canonical(),
            support_boundary: MV_MZ_ENCRYPTED_AUDIO_SUPPORT_BOUNDARY.to_string(),
        })
    }

    /// Mechanically enforce the path declaration. Returns every violation found.
    pub fn validate(&self) -> Result<(), Vec<MvMzEncryptedAudioPathViolation>> {
        let mut violations = Vec::new();
        if self.engine_family != MV_MZ_ENCRYPTED_AUDIO_ENGINE_FAMILY {
            violations.push(MvMzEncryptedAudioPathViolation::WrongEngineFamily {
                found: self.engine_family.clone(),
            });
        }
        if self.variant != MV_MZ_ENCRYPTED_AUDIO_VARIANT {
            violations.push(MvMzEncryptedAudioPathViolation::WrongVariant {
                found: self.variant.clone(),
            });
        }
        if self.container != ContainerTransform::ProjectAsset {
            violations.push(MvMzEncryptedAudioPathViolation::WrongContainer {
                found: self.container,
            });
        }
        if self.codec != CodecTransform::OggAudio {
            violations.push(MvMzEncryptedAudioPathViolation::WrongCodec { found: self.codec });
        }
        if self.crypto_profile.crypto != CryptoTransform::RpgMakerAssetXor {
            violations.push(MvMzEncryptedAudioPathViolation::CryptoProfileNotAssetXor {
                found: self.crypto_profile.crypto,
            });
        }
        if self.patch_back != PatchBackTransform::ReplaceAsset {
            violations.push(MvMzEncryptedAudioPathViolation::PatchBackNotReplaceAsset {
                found: self.patch_back,
            });
        }
        if self.secret_requirement_ids.is_empty() {
            violations.push(MvMzEncryptedAudioPathViolation::NoSecretRequirement);
        }
        if self.audio_surfaces.is_empty() {
            violations.push(MvMzEncryptedAudioPathViolation::NoAudioSurface);
        }
        for surface in &self.audio_surfaces {
            if surface.codec != CodecTransform::OggAudio {
                violations.push(
                    MvMzEncryptedAudioPathViolation::AudioSurfaceClaimsNonAudioCodec {
                        surface_id: surface.surface_id.clone(),
                        codec: surface.codec,
                    },
                );
            }
        }
        if self.diagnostics.is_empty() {
            violations.push(MvMzEncryptedAudioPathViolation::NoDiagnostics);
        }
        if violations.is_empty() {
            Ok(())
        } else {
            Err(violations)
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(self)
    }
}
