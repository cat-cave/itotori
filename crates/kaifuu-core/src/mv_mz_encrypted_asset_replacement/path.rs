//! Replacement path declarations and validation.

use super::*;

/// The media kind an entry replaces. Fixes the codec, the plaintext signature,
/// and the MV/MZ file extensions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReplacementMediaKind {
    Image,
    Audio,
}

impl ReplacementMediaKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Audio => "audio",
        }
    }

    /// The single surface codec this media kind accepts.
    pub fn codec(self) -> CodecTransform {
        match self {
            Self::Image => CodecTransform::PngImage,
            Self::Audio => CodecTransform::OggAudio,
        }
    }

    /// The MV-era encrypted file extension.
    pub fn mv_extension(self) -> &'static str {
        match self {
            Self::Image => "rpgmvp",
            Self::Audio => "rpgmvo",
        }
    }

    /// The MZ-era encrypted file extension.
    pub fn mz_extension(self) -> &'static str {
        match self {
            Self::Image => "png_",
            Self::Audio => "ogg_",
        }
    }

    /// The original in-game synthetic plaintext this kind replaces (reused from
    /// the public synthetic media).
    pub(super) fn original_plaintext(self) -> Vec<u8> {
        match self {
            Self::Image => SYNTHETIC_PNG.to_vec(),
            Self::Audio => SYNTHETIC_OGG.to_vec(),
        }
    }

    /// The synthetic replacement plaintext for this kind.
    pub(super) fn replacement_plaintext(self) -> Vec<u8> {
        match self {
            Self::Image => replacement_image(),
            Self::Audio => replacement_audio(),
        }
    }

    /// True iff `bytes` begins with this kind's media signature.
    pub(super) fn is_valid_media(self, bytes: &[u8]) -> bool {
        match self {
            Self::Image => {
                bytes.len() >= PNG_SIGNATURE.len() && &bytes[..PNG_SIGNATURE.len()] == PNG_SIGNATURE
            }
            Self::Audio => {
                bytes.len() >= OGG_SIGNATURE.len() && &bytes[..OGG_SIGNATURE.len()] == OGG_SIGNATURE
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpgMakerReplacementCryptoProfile {
    pub profile_id: String,
    pub crypto: CryptoTransform,
    /// sha256 of the public 16-byte RPGMV header magic (never a key).
    pub header_magic_hash: ProofHash,
    pub header_len: u32,
    pub xor_prefix_len: u32,
    pub key_material_kind: KeyMaterialKind,
    pub key_bytes: u32,
}

impl RpgMakerReplacementCryptoProfile {
    pub fn asset_xor() -> KaifuuResult<Self> {
        Ok(Self {
            profile_id: MV_MZ_ASSET_REPLACEMENT_CRYPTO_PROFILE_ID.to_string(),
            crypto: CryptoTransform::RpgMakerAssetXor,
            header_magic_hash: ProofHash::new(sha256_hash_bytes(
                RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER,
            ))?,
            header_len: RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER.len() as u32,
            xor_prefix_len: RPGMAKER_ASSET_XOR_PREFIX_LEN as u32,
            key_material_kind: KeyMaterialKind::RpgMakerAssetKey,
            key_bytes: RPGMAKER_ASSET_XOR_PREFIX_LEN as u32,
        })
    }
}

/// One media kind as declared in the path (codec + MV/MZ extensions).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplacementMediaKindDeclaration {
    pub media_kind: ReplacementMediaKind,
    pub codec: CodecTransform,
    pub mv_extension: String,
    pub mz_extension: String,
}

impl ReplacementMediaKindDeclaration {
    fn of(media_kind: ReplacementMediaKind) -> Self {
        Self {
            media_kind,
            codec: media_kind.codec(),
            mv_extension: media_kind.mv_extension().to_string(),
            mz_extension: media_kind.mz_extension().to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzAssetReplacementDiagnosticDeclaration {
    pub code: String,
    pub semantic_code: String,
    pub severity: PartialDiagnosticSeverity,
    pub summary: String,
}

impl MvMzAssetReplacementDiagnosticDeclaration {
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
                SEMANTIC_REPLACEMENT_WRONG_KEY,
                "resolved key sha256 does not match the declared key commitment; no patch produced",
            ),
            Self::new(
                FINDING_TAMPERED,
                SEMANTIC_REPLACEMENT_TAMPERED,
                "patched asset was corrupted; decrypt no longer recovers the replacement — rejected",
            ),
            Self::new(
                FINDING_MISSING_KEY,
                SEMANTIC_REPLACEMENT_MISSING_KEY,
                "no asset key was resolvable for the secret requirement; no patch produced",
            ),
            Self::new(
                FINDING_UNSUPPORTED_SURFACE,
                SEMANTIC_REPLACEMENT_UNSUPPORTED_SURFACE,
                "surface codec does not match the media kind; the entry is outside this path",
            ),
            Self::new(
                FINDING_NOT_MEDIA,
                SEMANTIC_REPLACEMENT_NOT_MEDIA,
                "replacement plaintext does not carry the declared media signature",
            ),
        ]
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzAssetReplacementPath {
    pub schema_version: String,
    pub engine_family: String,
    pub variant: String,
    pub container: ContainerTransform,
    pub crypto_profile: RpgMakerReplacementCryptoProfile,
    pub surface: SurfaceTransform,
    pub patch_back: PatchBackTransform,
    pub fixture_id: String,
    pub secret_requirement_ids: Vec<String>,
    pub media_kinds: Vec<ReplacementMediaKindDeclaration>,
    pub diagnostics: Vec<MvMzAssetReplacementDiagnosticDeclaration>,
    pub support_boundary: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum MvMzAssetReplacementPathViolation {
    WrongEngineFamily {
        found: String,
    },
    WrongVariant {
        found: String,
    },
    WrongContainer {
        found: ContainerTransform,
    },
    CryptoProfileNotAssetXor {
        found: CryptoTransform,
    },
    PatchBackNotReplaceAsset {
        found: PatchBackTransform,
    },
    NoSecretRequirement,
    NoMediaKind,
    MediaKindClaimsWrongCodec {
        media_kind: ReplacementMediaKind,
        codec: CodecTransform,
    },
    NoDiagnostics,
}

impl MvMzAssetReplacementPath {
    pub fn canonical() -> KaifuuResult<Self> {
        Ok(Self {
            schema_version: MV_MZ_ASSET_REPLACEMENT_SCHEMA_VERSION.to_string(),
            engine_family: MV_MZ_ASSET_REPLACEMENT_ENGINE_FAMILY.to_string(),
            variant: MV_MZ_ASSET_REPLACEMENT_VARIANT.to_string(),
            container: ContainerTransform::ProjectAsset,
            crypto_profile: RpgMakerReplacementCryptoProfile::asset_xor()?,
            surface: SurfaceTransform::ArchiveEntry,
            patch_back: PatchBackTransform::ReplaceAsset,
            fixture_id: MV_MZ_ASSET_REPLACEMENT_FIXTURE_ID.to_string(),
            secret_requirement_ids: vec![MV_MZ_ASSET_REPLACEMENT_REQUIREMENT_ID.to_string()],
            media_kinds: [ReplacementMediaKind::Image, ReplacementMediaKind::Audio]
                .into_iter()
                .map(ReplacementMediaKindDeclaration::of)
                .collect(),
            diagnostics: MvMzAssetReplacementDiagnosticDeclaration::canonical(),
            support_boundary: MV_MZ_ASSET_REPLACEMENT_SUPPORT_BOUNDARY.to_string(),
        })
    }

    pub fn validate(&self) -> Result<(), Vec<MvMzAssetReplacementPathViolation>> {
        let mut violations = Vec::new();
        if self.engine_family != MV_MZ_ASSET_REPLACEMENT_ENGINE_FAMILY {
            violations.push(MvMzAssetReplacementPathViolation::WrongEngineFamily {
                found: self.engine_family.clone(),
            });
        }
        if self.variant != MV_MZ_ASSET_REPLACEMENT_VARIANT {
            violations.push(MvMzAssetReplacementPathViolation::WrongVariant {
                found: self.variant.clone(),
            });
        }
        if self.container != ContainerTransform::ProjectAsset {
            violations.push(MvMzAssetReplacementPathViolation::WrongContainer {
                found: self.container,
            });
        }
        if self.crypto_profile.crypto != CryptoTransform::RpgMakerAssetXor {
            violations.push(
                MvMzAssetReplacementPathViolation::CryptoProfileNotAssetXor {
                    found: self.crypto_profile.crypto,
                },
            );
        }
        if self.patch_back != PatchBackTransform::ReplaceAsset {
            violations.push(
                MvMzAssetReplacementPathViolation::PatchBackNotReplaceAsset {
                    found: self.patch_back,
                },
            );
        }
        if self.secret_requirement_ids.is_empty() {
            violations.push(MvMzAssetReplacementPathViolation::NoSecretRequirement);
        }
        if self.media_kinds.is_empty() {
            violations.push(MvMzAssetReplacementPathViolation::NoMediaKind);
        }
        for declaration in &self.media_kinds {
            if declaration.codec != declaration.media_kind.codec() {
                violations.push(
                    MvMzAssetReplacementPathViolation::MediaKindClaimsWrongCodec {
                        media_kind: declaration.media_kind,
                        codec: declaration.codec,
                    },
                );
            }
        }
        if self.diagnostics.is_empty() {
            violations.push(MvMzAssetReplacementPathViolation::NoDiagnostics);
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
