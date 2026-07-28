//! RPG Maker MV/MZ encrypted-image path declarations and report model.

use serde::{Deserialize, Serialize};

use crate::mv_mz_asset_xor::RPGMAKER_ASSET_XOR_PREFIX_LEN;
use crate::{
    CodecTransform, ContainerTransform, CryptoTransform, KaifuuResult, KeyMaterialKind,
    PartialDiagnosticSeverity, PatchBackTransform, ProofHash, RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER,
    SurfaceTransform, sha256_hash_bytes, stable_json,
};

/// The canonical RPGMV-header variant error. Re-exported under the historical
/// image-path name; the single implementation lives in [`crate::mv_mz_asset_xor`].
pub use crate::mv_mz_asset_xor::MvMzAssetVariantError as MvMzImageVariantError;

pub const MV_MZ_ENCRYPTED_IMAGE_SCHEMA_VERSION: &str = "0.1.0";

/// Canonical `engine_family` wire value for this path (the repo-wide
/// canonical MV/MZ token).
pub const MV_MZ_ENCRYPTED_IMAGE_ENGINE_FAMILY: &str = "rpg_maker_mv_mz";
/// Canonical `variant` wire value (MV and MZ share the asset-XOR scheme).
pub const MV_MZ_ENCRYPTED_IMAGE_VARIANT: &str = "mv_or_mz";
/// Stable id of this path / its public fixture.
pub const MV_MZ_ENCRYPTED_IMAGE_FIXTURE_ID: &str = "kaifuu-rpgmaker-mv-mz-encrypted-image";
/// Stable crypto-profile id for the MV/MZ asset-XOR scheme.
pub const MV_MZ_ENCRYPTED_IMAGE_CRYPTO_PROFILE_ID: &str = "rpgmaker/mv_mz/asset_xor_v1";
/// The single secret requirement: the `System.json` asset key.
pub const MV_MZ_ENCRYPTED_IMAGE_REQUIREMENT_ID: &str = "rpgmaker-mv-mz-asset-key";

/// The support boundary surfaced in every report.
pub const MV_MZ_ENCRYPTED_IMAGE_SUPPORT_BOUNDARY: &str = "Kaifuu RPG Maker MV/MZ encrypted-image decrypt + re-encrypt is in-process Rust (the standard RPGMV-header XOR-with-System.json-key scheme); it never shells out. A re-encrypted patch artifact is produced only after a candidate key decrypts the asset to a valid PNG and a byte-correct round-trip is proven; wrong-key, missing-key, unsupported-surface (audio/JSON), and unsupported-variant (malformed header) entries fail before any re-encryption. Raw key bytes are never logged, serialized, or returned — reports carry secret-refs + proof hashes only. Audio and JSON surfaces are out of scope for this path.";

/// The PNG 8-byte signature. Used as the wrong-key discriminator: a correctly
/// decrypted RPG Maker image begins with it.
pub const PNG_SIGNATURE: &[u8; 8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/// The number of leading bytes the RPGMV scheme XOR-masks (the key length).
/// Aliases the shared [`RPGMAKER_ASSET_XOR_PREFIX_LEN`].
pub const RPGMAKER_IMAGE_XOR_PREFIX_LEN: usize = RPGMAKER_ASSET_XOR_PREFIX_LEN;

pub const SEMANTIC_MV_MZ_IMAGE_WRONG_KEY: &str = "kaifuu.rpgmaker.encrypted_image.wrong_key";
pub const SEMANTIC_MV_MZ_IMAGE_MISSING_KEY: &str = "kaifuu.rpgmaker.encrypted_image.missing_key";
pub const SEMANTIC_MV_MZ_IMAGE_UNSUPPORTED_SURFACE: &str =
    "kaifuu.rpgmaker.encrypted_image.unsupported_surface";
pub const SEMANTIC_MV_MZ_IMAGE_UNSUPPORTED_VARIANT: &str =
    "kaifuu.rpgmaker.encrypted_image.unsupported_variant";

pub(super) const FINDING_WRONG_KEY: &str = "rpgmaker.encrypted_image.wrong_key";
pub(super) const FINDING_MISSING_KEY: &str = "rpgmaker.encrypted_image.missing_key";
pub(super) const FINDING_UNSUPPORTED_SURFACE: &str = "rpgmaker.encrypted_image.unsupported_surface";
pub(super) const FINDING_UNSUPPORTED_VARIANT: &str = "rpgmaker.encrypted_image.unsupported_variant";
pub(super) const FINDING_OUTCOME_MISMATCH: &str = "rpgmaker.encrypted_image.outcome_mismatch";
pub(super) const FINDING_INTERNAL: &str = "rpgmaker.encrypted_image.internal";

/// A tiny, real, 1x1 RGB PNG (69 bytes). Public + synthetic — it is the
/// plaintext every fixture entry round-trips.
pub const SYNTHETIC_PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0x60, 0x60, 0x60, 0x00,
    0x00, 0x00, 0x04, 0x00, 0x01, 0xc8, 0xea, 0xeb, 0xf9, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
    0x44, 0xae, 0x42, 0x60, 0x82,
];

/// The synthetic "correct" 16-byte asset key. Clearly fake fixture material.
pub(super) const SYNTHETIC_KEY_CORRECT: &[u8; 16] = b"ITOTORIFIXTUREK0";
/// A synthetic key that differs from the correct one within the first 8 bytes,
/// so a wrong-key decrypt corrupts the PNG signature and is detected.
pub(super) const SYNTHETIC_KEY_WRONG: &[u8; 16] = b"XXXXXXXXXXXXXXXX";

/// The named MV/MZ image surfaces this path handles. Each owns a stable
/// [`MvMzImageSurface::surface_id`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MvMzImageSurface {
    /// `www/img/pictures/*` show-picture assets.
    Pictures,
    /// `www/img/titles1/*` / `titles2/*` title screen art.
    Titles,
    /// `www/img/faces/*` message face sheets.
    Faces,
    /// `www/img/characters/*` character sprite sheets.
    Characters,
    /// `www/img/system/*` window-skin / system art.
    System,
}

impl MvMzImageSurface {
    /// All named image surfaces in canonical order.
    pub fn all() -> [Self; 5] {
        [
            Self::Pictures,
            Self::Titles,
            Self::Faces,
            Self::Characters,
            Self::System,
        ]
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pictures => "pictures",
            Self::Titles => "titles",
            Self::Faces => "faces",
            Self::Characters => "characters",
            Self::System => "system",
        }
    }

    /// Stable, public surface id.
    pub fn surface_id(self) -> String {
        format!("mv_mz/image/{}", self.as_str())
    }

    /// File glob (relative to the project root) the surface covers. MV ships
    /// `.rpgmvp`; MZ ships `.png_` — both route through this path.
    pub fn file_glob(self) -> &'static str {
        match self {
            Self::Pictures => "www/img/pictures/*.{rpgmvp,png_}",
            Self::Titles => "www/img/titles{1,2}/*.{rpgmvp,png_}",
            Self::Faces => "www/img/faces/*.{rpgmvp,png_}",
            Self::Characters => "www/img/characters/*.{rpgmvp,png_}",
            Self::System => "www/img/system/*.{rpgmvp,png_}",
        }
    }
}

/// The crypto profile this path declares: the MV/MZ asset-XOR scheme. Carries
/// only public, non-secret facts (a hash of the public header magic, the header
/// and key lengths, the material kind).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpgMakerImageCryptoProfile {
    pub profile_id: String,
    pub crypto: CryptoTransform,
    /// sha256 of the public 16-byte RPGMV header magic (never a key).
    pub header_magic_hash: ProofHash,
    pub header_len: u32,
    pub xor_prefix_len: u32,
    pub key_material_kind: KeyMaterialKind,
    pub key_bytes: u32,
}

impl RpgMakerImageCryptoProfile {
    /// The canonical MV/MZ asset-XOR crypto profile.
    pub fn asset_xor() -> KaifuuResult<Self> {
        Ok(Self {
            profile_id: MV_MZ_ENCRYPTED_IMAGE_CRYPTO_PROFILE_ID.to_string(),
            crypto: CryptoTransform::RpgMakerAssetXor,
            header_magic_hash: ProofHash::new(sha256_hash_bytes(
                RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER,
            ))?,
            header_len: RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER.len() as u32,
            xor_prefix_len: RPGMAKER_IMAGE_XOR_PREFIX_LEN as u32,
            key_material_kind: KeyMaterialKind::RpgMakerAssetKey,
            key_bytes: RPGMAKER_IMAGE_XOR_PREFIX_LEN as u32,
        })
    }
}

/// One declared diagnostic this path can emit (the failure vocabulary).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzEncryptedImageDiagnosticDeclaration {
    pub code: String,
    pub semantic_code: String,
    pub severity: PartialDiagnosticSeverity,
    pub summary: String,
}

impl MvMzEncryptedImageDiagnosticDeclaration {
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
                SEMANTIC_MV_MZ_IMAGE_WRONG_KEY,
                "candidate key did not decrypt the asset to a valid PNG; no re-encryption performed",
            ),
            Self::new(
                FINDING_MISSING_KEY,
                SEMANTIC_MV_MZ_IMAGE_MISSING_KEY,
                "no asset key was resolvable for the secret requirement; no decryption attempted",
            ),
            Self::new(
                FINDING_UNSUPPORTED_SURFACE,
                SEMANTIC_MV_MZ_IMAGE_UNSUPPORTED_SURFACE,
                "surface codec is not image; audio and JSON surfaces are outside this path",
            ),
            Self::new(
                FINDING_UNSUPPORTED_VARIANT,
                SEMANTIC_MV_MZ_IMAGE_UNSUPPORTED_VARIANT,
                "asset bytes are not a well-formed RPGMV-header encrypted image",
            ),
        ]
    }
}

/// The full path declaration consumed by the capability matrix and audits. It
/// pins every leg of the transform stack plus the fixture id, secret
/// requirement ids, and the diagnostic vocabulary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzEncryptedImagePath {
    pub schema_version: String,
    pub engine_family: String,
    pub variant: String,
    pub container: ContainerTransform,
    pub crypto_profile: RpgMakerImageCryptoProfile,
    pub codec: CodecTransform,
    pub surface: SurfaceTransform,
    pub patch_back: PatchBackTransform,
    pub fixture_id: String,
    pub secret_requirement_ids: Vec<String>,
    pub image_surfaces: Vec<MvMzImageSurfaceDeclaration>,
    pub diagnostics: Vec<MvMzEncryptedImageDiagnosticDeclaration>,
    pub support_boundary: String,
}

/// One named image surface as declared in the path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzImageSurfaceDeclaration {
    pub surface_id: String,
    pub surface: MvMzImageSurface,
    pub file_glob: String,
    pub codec: CodecTransform,
}

impl MvMzImageSurfaceDeclaration {
    fn of(surface: MvMzImageSurface) -> Self {
        Self {
            surface_id: surface.surface_id(),
            surface,
            file_glob: surface.file_glob().to_string(),
            codec: CodecTransform::PngImage,
        }
    }
}

/// A structured violation of the path declaration. `validate` returns one per
/// offending field so failures are machine-actionable findings, never prose.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum MvMzEncryptedImagePathViolation {
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
    NoImageSurface,
    ImageSurfaceClaimsNonImageCodec {
        surface_id: String,
        codec: CodecTransform,
    },
    NoDiagnostics,
}

impl MvMzEncryptedImagePath {
    /// The canonical, fully-populated path declaration.
    pub fn canonical() -> KaifuuResult<Self> {
        Ok(Self {
            schema_version: MV_MZ_ENCRYPTED_IMAGE_SCHEMA_VERSION.to_string(),
            engine_family: MV_MZ_ENCRYPTED_IMAGE_ENGINE_FAMILY.to_string(),
            variant: MV_MZ_ENCRYPTED_IMAGE_VARIANT.to_string(),
            container: ContainerTransform::ProjectAsset,
            crypto_profile: RpgMakerImageCryptoProfile::asset_xor()?,
            codec: CodecTransform::PngImage,
            // A named asset entry inside the project-asset container.
            surface: SurfaceTransform::ArchiveEntry,
            patch_back: PatchBackTransform::ReplaceAsset,
            fixture_id: MV_MZ_ENCRYPTED_IMAGE_FIXTURE_ID.to_string(),
            secret_requirement_ids: vec![MV_MZ_ENCRYPTED_IMAGE_REQUIREMENT_ID.to_string()],
            image_surfaces: MvMzImageSurface::all()
                .into_iter()
                .map(MvMzImageSurfaceDeclaration::of)
                .collect(),
            diagnostics: MvMzEncryptedImageDiagnosticDeclaration::canonical(),
            support_boundary: MV_MZ_ENCRYPTED_IMAGE_SUPPORT_BOUNDARY.to_string(),
        })
    }

    /// Mechanically enforce the path declaration. Returns every violation found.
    pub fn validate(&self) -> Result<(), Vec<MvMzEncryptedImagePathViolation>> {
        let mut violations = Vec::new();
        if self.engine_family != MV_MZ_ENCRYPTED_IMAGE_ENGINE_FAMILY {
            violations.push(MvMzEncryptedImagePathViolation::WrongEngineFamily {
                found: self.engine_family.clone(),
            });
        }
        if self.variant != MV_MZ_ENCRYPTED_IMAGE_VARIANT {
            violations.push(MvMzEncryptedImagePathViolation::WrongVariant {
                found: self.variant.clone(),
            });
        }
        if self.container != ContainerTransform::ProjectAsset {
            violations.push(MvMzEncryptedImagePathViolation::WrongContainer {
                found: self.container,
            });
        }
        if self.codec != CodecTransform::PngImage {
            violations.push(MvMzEncryptedImagePathViolation::WrongCodec { found: self.codec });
        }
        if self.crypto_profile.crypto != CryptoTransform::RpgMakerAssetXor {
            violations.push(MvMzEncryptedImagePathViolation::CryptoProfileNotAssetXor {
                found: self.crypto_profile.crypto,
            });
        }
        if self.patch_back != PatchBackTransform::ReplaceAsset {
            violations.push(MvMzEncryptedImagePathViolation::PatchBackNotReplaceAsset {
                found: self.patch_back,
            });
        }
        if self.secret_requirement_ids.is_empty() {
            violations.push(MvMzEncryptedImagePathViolation::NoSecretRequirement);
        }
        if self.image_surfaces.is_empty() {
            violations.push(MvMzEncryptedImagePathViolation::NoImageSurface);
        }
        for surface in &self.image_surfaces {
            if surface.codec != CodecTransform::PngImage {
                violations.push(
                    MvMzEncryptedImagePathViolation::ImageSurfaceClaimsNonImageCodec {
                        surface_id: surface.surface_id.clone(),
                        codec: surface.codec,
                    },
                );
            }
        }
        if self.diagnostics.is_empty() {
            violations.push(MvMzEncryptedImagePathViolation::NoDiagnostics);
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
