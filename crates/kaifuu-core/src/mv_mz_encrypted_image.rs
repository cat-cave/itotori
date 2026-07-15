//! RPG Maker MV/MZ encrypted-IMAGE decrypt + re-encrypt path.
//! This is the **encrypted-media** path for RPG Maker MV/MZ named image
//! surfaces. It is mechanically separate from two neighbouring nodes:
//! - ([`crate::mv_mz_readiness`]) is JSON-text inventory only and
//!   hard-pins encrypted media `extractable = false` / `patchable = false`.
//!   THIS node never touches a JSON-text surface and never widens that node's
//!   claims.
//! - ([`crate::encrypted_media_proof`]) is a research-only
//!   *readiness* proof that NEVER decrypts. THIS node is the distinct path
//!   that genuinely decrypts AND re-encrypts an image asset, with a
//!   byte-correct round-trip proof.
//! # The scheme (native Rust, NO shell-out)
//! RPG Maker MV/MZ encrypted images are the standard `RPGMV`-header scheme: a
//! 16-byte [`RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER`] signature is prepended to
//! the asset, and the first 16 bytes of the original PNG are XOR-masked with a
//! 16-byte key derived from `System.json`'s `encryptionKey`. Decryption strips
//! the header and XORs the first 16 body bytes back; re-encryption prepends the
//! header and XORs the first 16 plaintext bytes. XOR is involutive, so a
//! correct key yields a **byte-correct** round-trip
//! (`re_encrypt(decrypt(enc)) == enc`). The implementation is in-process Rust:
//! no `Command::new`, no helper process, no network.
//! # THE LINE (mechanical, not prose)
//! - Raw key bytes live **only** inside the module-private [`ImageAssetKey`]
//!   (redacting `Debug`, zeroizing `Drop`). They are never serialized, logged,
//!   or returned across the module boundary. Reports carry structured
//!   **secret-refs + proof hashes / counts** only.
//! - A re-encrypted patch artifact is produced **only** after a candidate key
//!   decrypts the asset to a valid PNG. Wrong-key, missing-key,
//!   unsupported-surface (audio / JSON), and unsupported-variant
//!   (malformed-header) entries fail **before** any re-encryption — every one
//!   is a structured [`MvMzEncryptedImageFinding`], never a silent skip or a
//!   panic.
//! - Audio and JSON surfaces are explicitly out of scope: an entry whose
//!   `surface_codec` is not [`CodecTransform::PngImage`] is rejected with a
//!   structured `unsupported_surface` finding before any byte is decrypted.
//! # Fixtures are synthetic + public
//! Every byte is synthesised in-module: a tiny real 1x1 PNG ([`SYNTHETIC_PNG`])
//! and a clearly-fake 16-byte key. No retail image bytes and no real keys are
//! ever vendored; the report carries only hashes / counts / secret-refs.

use serde::{Deserialize, Serialize};

#[cfg(test)]
use crate::KeyValidationMethod;
#[cfg(test)]
use crate::mv_mz_asset_xor::decrypt_rpgmaker_asset;
use crate::mv_mz_asset_xor::{MvMzAssetKey, RPGMAKER_ASSET_XOR_PREFIX_LEN, encrypt_rpgmaker_asset};
use crate::{
    CodecTransform, ContainerTransform, CryptoTransform, KaifuuResult, KeyMaterialKind,
    KeyValidationProof, OperationStatus, PartialDiagnosticSeverity, PatchBackTransform, ProofHash,
    RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER, SecretRef, SurfaceTransform, redact_for_log_or_report,
    sha256_hash_bytes, stable_json,
};

mod run;

/// The canonical RPGMV-header variant error. Re-exported under the historical
/// image-path name; the single implementation lives in [`crate::mv_mz_asset_xor`].
pub use crate::mv_mz_asset_xor::MvMzAssetVariantError as MvMzImageVariantError;
pub use run::{MvMzEncryptedImageRequest, run_mv_mz_encrypted_image};

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

const FINDING_WRONG_KEY: &str = "rpgmaker.encrypted_image.wrong_key";
const FINDING_MISSING_KEY: &str = "rpgmaker.encrypted_image.missing_key";
const FINDING_UNSUPPORTED_SURFACE: &str = "rpgmaker.encrypted_image.unsupported_surface";
const FINDING_UNSUPPORTED_VARIANT: &str = "rpgmaker.encrypted_image.unsupported_variant";
const FINDING_OUTCOME_MISMATCH: &str = "rpgmaker.encrypted_image.outcome_mismatch";
const FINDING_INTERNAL: &str = "rpgmaker.encrypted_image.internal";

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
const SYNTHETIC_KEY_CORRECT: &[u8; 16] = b"ITOTORIFIXTUREK0";
/// A synthetic key that differs from the correct one within the first 8 bytes,
/// so a wrong-key decrypt corrupts the PNG signature and is detected.
const SYNTHETIC_KEY_WRONG: &[u8; 16] = b"XXXXXXXXXXXXXXXX";

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

// The XOR primitive, key type, decrypt, and re-encrypt all live in the single
// canonical `crate::mv_mz_asset_xor` module (imported above); this path never
// re-implements them. `ImageAssetKey` is the historical local name for the
// shared key type.

type ImageAssetKey = MvMzAssetKey;

/// True iff `bytes` begins with the PNG 8-byte signature — the wrong-key
/// discriminator for a decrypted RPG Maker image.
fn is_png(bytes: &[u8]) -> bool {
    bytes.len() >= PNG_SIGNATURE.len() && &bytes[..PNG_SIGNATURE.len()] == PNG_SIGNATURE
}

/// Build a clearly-synthetic RPGMV-header encrypted image from [`SYNTHETIC_PNG`]
/// masked with the given key. Public helper so callers can exercise the native
/// decrypt path on synthetic bytes without any retail asset.
pub fn encrypt_synthetic_image(key_bytes: &[u8]) -> Vec<u8> {
    encrypt_rpgmaker_asset(SYNTHETIC_PNG, &MvMzAssetKey::from_bytes(key_bytes))
}

/// The synthetic scenario a fixture entry materialises in-process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MvMzEncryptedImageScenario {
    /// Encrypted with the correct key; the correct key is offered — round-trips.
    Valid,
    /// Encrypted with the correct key; a wrong key is offered — decrypt yields
    /// non-PNG bytes.
    WrongKey,
    /// Encrypted asset present, but no key is resolvable for the requirement.
    MissingKey,
    /// The entry declares a non-image (audio) surface codec — outside this path.
    UnsupportedSurface,
    /// Asset bytes lack the RPGMV header magic (not a valid encrypted image).
    UnsupportedVariant,
}

impl MvMzEncryptedImageScenario {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Valid => "valid",
            Self::WrongKey => "wrong_key",
            Self::MissingKey => "missing_key",
            Self::UnsupportedSurface => "unsupported_surface",
            Self::UnsupportedVariant => "unsupported_variant",
        }
    }
}

/// The mechanical outcome of processing one entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MvMzEncryptedImageOutcome {
    /// Decrypted to a valid PNG and re-encrypted byte-correctly.
    RoundTripped,
    /// Candidate key did not decrypt to a valid PNG; no re-encryption.
    WrongKey,
    /// No key was resolvable; no decryption attempted.
    MissingKey,
    /// Surface codec is not image; outside this path.
    UnsupportedSurface,
    /// Asset bytes are not a well-formed RPGMV-header image.
    UnsupportedVariant,
}

impl MvMzEncryptedImageOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RoundTripped => "round_tripped",
            Self::WrongKey => "wrong_key",
            Self::MissingKey => "missing_key",
            Self::UnsupportedSurface => "unsupported_surface",
            Self::UnsupportedVariant => "unsupported_variant",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MvMzEncryptedImageFixture {
    pub schema_version: String,
    pub path_id: String,
    /// The spec-DAG node id this fixture is authored for (e.g. ``).
    pub source_node_id: String,
    pub engine_family: String,
    pub entries: Vec<MvMzEncryptedImageFixtureEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MvMzEncryptedImageFixtureEntry {
    pub entry_id: String,
    pub requirement_id: String,
    /// Structured secret-ref for the asset key. Never raw key material.
    pub secret_ref: SecretRef,
    /// The named image surface this entry targets (surface provenance).
    pub surface: MvMzImageSurface,
    /// The declared surface codec. The path accepts `png_image` only; an audio
    /// or JSON codec is an `unsupported_surface`.
    pub surface_codec: CodecTransform,
    pub scenario: MvMzEncryptedImageScenario,
    pub expected: MvMzEncryptedImageOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzEncryptedImageReport {
    pub schema_version: String,
    pub path_id: String,
    pub source_node_id: String,
    pub engine_family: String,
    pub support_boundary: String,
    pub path: MvMzEncryptedImagePath,
    pub status: OperationStatus,
    pub entries: Vec<MvMzEncryptedImageEntryReport>,
}

impl MvMzEncryptedImageReport {
    pub fn entry(&self, entry_id: &str) -> Option<&MvMzEncryptedImageEntryReport> {
        self.entries.iter().find(|entry| entry.entry_id == entry_id)
    }

    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            path_id: redact_for_log_or_report(&self.path_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            path: self.path.clone(),
            status: self.status.clone(),
            entries: self
                .entries
                .iter()
                .map(MvMzEncryptedImageEntryReport::redacted_for_report)
                .collect(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzEncryptedImageEntryReport {
    pub entry_id: String,
    pub source_node_id: String,
    pub path_id: String,
    pub surface_id: String,
    pub scenario: MvMzEncryptedImageScenario,
    pub outcome: MvMzEncryptedImageOutcome,
    /// `true` only when the asset decrypted to a valid PNG AND re-encrypted
    /// byte-correctly.
    pub round_tripped: bool,
    /// The round-trip proof, present **only** when `round_tripped`. `None` means
    /// no re-encrypted patch artifact was produced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proof: Option<MvMzImageRoundTripProof>,
    pub validation_command: String,
    pub redaction_status: String,
    pub status: OperationStatus,
    pub findings: Vec<MvMzEncryptedImageFinding>,
}

impl MvMzEncryptedImageEntryReport {
    /// The byte-correct round-trip proof an adapter may consume **iff** the
    /// entry passed and round-tripped. Anything else returns `None`, so a
    /// caller physically cannot consume a patch artifact for a failed entry.
    pub fn consumable_proof(&self) -> Option<&MvMzImageRoundTripProof> {
        if self.round_tripped && self.status == OperationStatus::Passed {
            self.proof.as_ref()
        } else {
            None
        }
    }

    fn redacted_for_report(&self) -> Self {
        Self {
            entry_id: redact_for_log_or_report(&self.entry_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            path_id: redact_for_log_or_report(&self.path_id),
            surface_id: redact_for_log_or_report(&self.surface_id),
            scenario: self.scenario,
            outcome: self.outcome,
            round_tripped: self.round_tripped,
            proof: self
                .proof
                .as_ref()
                .map(MvMzImageRoundTripProof::redacted_for_report),
            validation_command: redact_for_log_or_report(&self.validation_command),
            redaction_status: redact_for_log_or_report(&self.redaction_status),
            status: self.status.clone(),
            findings: self
                .findings
                .iter()
                .map(MvMzEncryptedImageFinding::redacted_for_report)
                .collect(),
        }
    }
}

/// The byte-correct round-trip proof. Carries hashes / counts / a secret-ref
/// only — never the key bytes, never the decrypted image bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzImageRoundTripProof {
    pub requirement_id: String,
    pub secret_ref: SecretRef,
    pub surface_id: String,
    /// sha256 of the original encrypted asset bytes.
    pub encrypted_source_hash: ProofHash,
    /// sha256 of the decrypted plaintext PNG bytes.
    pub decrypted_plaintext_hash: ProofHash,
    /// sha256 of the re-encrypted asset bytes.
    pub reencrypted_hash: ProofHash,
    /// `true` iff `reencrypted_hash == encrypted_source_hash` (byte-correct).
    pub byte_correct_round_trip: bool,
    /// One-way sha256 commitment to the key bytes (never the key).
    pub key_material_hash: ProofHash,
    pub key_bytes: u32,
    /// Proof method + hash. `proof_hash` is the byte-correct re-encrypted hash.
    pub validation: KeyValidationProof,
    pub redaction_status: crate::HelperRedactionStatus,
}

impl MvMzImageRoundTripProof {
    fn redacted_for_report(&self) -> Self {
        Self {
            requirement_id: redact_for_log_or_report(&self.requirement_id),
            secret_ref: self.secret_ref.clone(),
            surface_id: redact_for_log_or_report(&self.surface_id),
            encrypted_source_hash: self.encrypted_source_hash.clone(),
            decrypted_plaintext_hash: self.decrypted_plaintext_hash.clone(),
            reencrypted_hash: self.reencrypted_hash.clone(),
            byte_correct_round_trip: self.byte_correct_round_trip,
            key_material_hash: self.key_material_hash.clone(),
            key_bytes: self.key_bytes,
            validation: self.validation.clone(),
            redaction_status: self.redaction_status,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzEncryptedImageFinding {
    pub code: String,
    pub severity: PartialDiagnosticSeverity,
    pub field: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub semantic_code: Option<String>,
}

impl MvMzEncryptedImageFinding {
    fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            severity: self.severity,
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
            semantic_code: self.semantic_code.as_deref().map(redact_for_log_or_report),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::read_json;

    fn manifest_dir() -> PathBuf {
        crate::test_manifest_dir()
            .join("../..")
            .join("fixtures/kaifuu/rpgmaker")
    }

    fn load_fixture() -> MvMzEncryptedImageFixture {
        read_json(&manifest_dir().join("encrypted-image.json"))
            .expect("encrypted-image manifest must parse")
    }

    fn run(fixture: &MvMzEncryptedImageFixture) -> MvMzEncryptedImageReport {
        run_mv_mz_encrypted_image(MvMzEncryptedImageRequest {
            fixture,
            fixture_file_name: "encrypted-image.json",
        })
        .expect("run must not error internally")
    }

    fn entry_mut<'a>(
        fixture: &'a mut MvMzEncryptedImageFixture,
        entry_id: &str,
    ) -> &'a mut MvMzEncryptedImageFixtureEntry {
        fixture
            .entries
            .iter_mut()
            .find(|entry| entry.entry_id == entry_id)
            .expect("entry must exist")
    }

    fn has_finding(report: &MvMzEncryptedImageReport, entry_id: &str, code: &str) -> bool {
        report
            .entry(entry_id)
            .is_some_and(|entry| entry.findings.iter().any(|finding| finding.code == code))
    }

    #[test]
    fn canonical_path_declares_and_validates_every_leg() {
        let path = MvMzEncryptedImagePath::canonical().unwrap();
        assert_eq!(path.engine_family, "rpg_maker_mv_mz");
        assert_eq!(path.variant, "mv_or_mz");
        assert_eq!(path.container, ContainerTransform::ProjectAsset);
        assert_eq!(path.codec, CodecTransform::PngImage);
        assert_eq!(
            path.crypto_profile.crypto,
            CryptoTransform::RpgMakerAssetXor
        );
        assert_eq!(path.patch_back, PatchBackTransform::ReplaceAsset);
        assert_eq!(
            path.secret_requirement_ids,
            vec![MV_MZ_ENCRYPTED_IMAGE_REQUIREMENT_ID.to_string()]
        );
        assert_eq!(path.image_surfaces.len(), 5);
        assert!(!path.diagnostics.is_empty());
        assert_eq!(path.fixture_id, MV_MZ_ENCRYPTED_IMAGE_FIXTURE_ID);
        path.validate().expect("canonical path is consistent");
    }

    #[test]
    fn validate_rejects_non_image_codec_and_wrong_legs() {
        let mut path = MvMzEncryptedImagePath::canonical().unwrap();
        path.codec = CodecTransform::M4aAudio;
        path.patch_back = PatchBackTransform::RewriteJson;
        path.image_surfaces[0].codec = CodecTransform::OggAudio;
        let violations = path.validate().expect_err("must fail");
        assert!(
            violations
                .iter()
                .any(|v| matches!(v, MvMzEncryptedImagePathViolation::WrongCodec { .. }))
        );
        assert!(violations.iter().any(|v| matches!(
            v,
            MvMzEncryptedImagePathViolation::PatchBackNotReplaceAsset { .. }
        )));
        assert!(violations.iter().any(|v| matches!(
            v,
            MvMzEncryptedImagePathViolation::ImageSurfaceClaimsNonImageCodec { .. }
        )));
    }

    #[test]
    fn decrypt_re_encrypt_is_byte_correct_round_trip() {
        let key = MvMzAssetKey::from_bytes(SYNTHETIC_KEY_CORRECT);
        let encrypted = encrypt_synthetic_image(SYNTHETIC_KEY_CORRECT);
        // The encrypted asset carries the RPGMV header magic.
        assert_eq!(
            &encrypted[..RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER.len()],
            RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER
        );
        let plaintext = decrypt_rpgmaker_asset(&encrypted, &key).expect("decrypts");
        assert_eq!(plaintext, SYNTHETIC_PNG, "decrypt recovers the PNG exactly");
        assert!(is_png(&plaintext));
        let reencrypted = encrypt_rpgmaker_asset(&plaintext, &key);
        assert_eq!(
            reencrypted, encrypted,
            "re-encrypt reproduces the source bytes (byte-correct)"
        );
        assert_eq!(
            sha256_hash_bytes(&reencrypted),
            sha256_hash_bytes(&encrypted)
        );
    }

    #[test]
    fn wrong_key_decrypt_does_not_yield_a_png() {
        let encrypted = encrypt_synthetic_image(SYNTHETIC_KEY_CORRECT);
        let wrong = MvMzAssetKey::from_bytes(SYNTHETIC_KEY_WRONG);
        let plaintext = decrypt_rpgmaker_asset(&encrypted, &wrong).expect("strips header");
        assert!(!is_png(&plaintext), "wrong key must not recover the PNG");
    }

    #[test]
    fn malformed_header_is_a_variant_error() {
        let key = MvMzAssetKey::from_bytes(SYNTHETIC_KEY_CORRECT);
        assert_eq!(
            decrypt_rpgmaker_asset(SYNTHETIC_PNG, &key).err(),
            Some(MvMzImageVariantError::MissingHeaderMagic)
        );
        assert_eq!(
            decrypt_rpgmaker_asset(b"RPGMV", &key).err(),
            Some(MvMzImageVariantError::TooShort)
        );
    }

    #[test]
    fn fixture_matrix_passes_and_records_path() {
        let report = run(&load_fixture());
        assert_eq!(
            report.status,
            OperationStatus::Passed,
            "{:?}",
            report.entries
        );
        assert_eq!(report.source_node_id, "KAIFUU-115");
        report.path.validate().expect("path is consistent");
        for entry in &report.entries {
            assert_eq!(entry.status, OperationStatus::Passed, "{entry:?}");
            assert_eq!(entry.source_node_id, "KAIFUU-115");
            assert!(
                entry
                    .validation_command
                    .starts_with("kaifuu rpgmaker encrypted-image --fixture")
            );
            assert_eq!(entry.redaction_status, "redacted");
        }
    }

    #[test]
    fn valid_entry_round_trips_with_matching_hashes() {
        let report = run(&load_fixture());
        let entry = report.entry("image-valid-pictures").unwrap();
        assert_eq!(entry.outcome, MvMzEncryptedImageOutcome::RoundTripped);
        assert!(entry.round_tripped);
        let proof = entry
            .consumable_proof()
            .expect("round-tripped is consumable");
        assert!(proof.byte_correct_round_trip);
        // Byte-correct: the re-encrypted hash equals the encrypted source hash.
        assert_eq!(
            proof.reencrypted_hash.as_str(),
            proof.encrypted_source_hash.as_str()
        );
        // The decrypted plaintext is exactly the synthetic PNG.
        assert_eq!(
            proof.decrypted_plaintext_hash.as_str(),
            sha256_hash_bytes(SYNTHETIC_PNG)
        );
        assert_eq!(
            proof.validation.method,
            KeyValidationMethod::FixtureRoundTripProof
        );
        assert_eq!(proof.key_bytes, RPGMAKER_IMAGE_XOR_PREFIX_LEN as u32);
    }

    #[test]
    fn failing_entries_publish_no_patch_artifact() {
        let report = run(&load_fixture());
        for (entry_id, outcome, code) in [
            (
                "image-wrong-key",
                MvMzEncryptedImageOutcome::WrongKey,
                FINDING_WRONG_KEY,
            ),
            (
                "image-missing-key",
                MvMzEncryptedImageOutcome::MissingKey,
                FINDING_MISSING_KEY,
            ),
            (
                "image-unsupported-surface-audio",
                MvMzEncryptedImageOutcome::UnsupportedSurface,
                FINDING_UNSUPPORTED_SURFACE,
            ),
            (
                "image-unsupported-variant",
                MvMzEncryptedImageOutcome::UnsupportedVariant,
                FINDING_UNSUPPORTED_VARIANT,
            ),
        ] {
            let entry = report.entry(entry_id).unwrap();
            assert_eq!(entry.outcome, outcome, "{entry_id}");
            assert!(!entry.round_tripped, "{entry_id} must not round-trip");
            assert!(entry.proof.is_none(), "{entry_id} must publish no proof");
            assert!(
                entry.consumable_proof().is_none(),
                "{entry_id} must not be consumable"
            );
            assert!(has_finding(&report, entry_id, code), "{entry_id} finding");
            // The structured finding carries a semantic code.
            let finding = report
                .entry(entry_id)
                .unwrap()
                .findings
                .iter()
                .find(|finding| finding.code == code)
                .unwrap();
            assert!(finding.semantic_code.is_some(), "{entry_id} semantic code");
        }
    }

    #[test]
    fn validator_fails_on_outcome_mismatch() {
        let mut fixture = load_fixture();
        entry_mut(&mut fixture, "image-wrong-key").expected =
            MvMzEncryptedImageOutcome::RoundTripped;
        let report = run(&fixture);
        assert_eq!(report.status, OperationStatus::Failed);
        assert!(has_finding(
            &report,
            "image-wrong-key",
            FINDING_OUTCOME_MISMATCH
        ));
    }

    #[test]
    fn report_never_carries_raw_key_material() {
        use std::fmt::Write as _;
        let report = run(&load_fixture());
        let json = report.stable_json().expect("stable json");
        let key_text = String::from_utf8_lossy(SYNTHETIC_KEY_CORRECT);
        assert!(!json.contains(key_text.as_ref()), "raw key leaked");
        let key_hex: String = SYNTHETIC_KEY_CORRECT
            .iter()
            .fold(String::new(), |mut acc, byte| {
                let _ = write!(acc, "{byte:02x}");
                acc
            });
        assert!(!json.contains(&key_hex), "raw key hex leaked");

        // The proof carries a one-way commitment + count, not the key.
        let proof = report
            .entry("image-valid-pictures")
            .unwrap()
            .proof
            .as_ref()
            .unwrap();
        assert_eq!(proof.key_bytes as usize, SYNTHETIC_KEY_CORRECT.len());
        assert_eq!(
            proof.key_material_hash.as_str(),
            sha256_hash_bytes(SYNTHETIC_KEY_CORRECT)
        );
    }

    #[test]
    fn key_debug_is_redacted_and_zeroized() {
        let key = MvMzAssetKey::from_bytes(SYNTHETIC_KEY_CORRECT);
        let rendered = format!("{key:?}");
        assert!(rendered.contains("REDACTED"));
        assert!(!rendered.contains(&String::from_utf8_lossy(SYNTHETIC_KEY_CORRECT).into_owned()));
    }

    #[test]
    fn report_round_trips_through_stable_json() {
        let report = run(&load_fixture());
        let json = report.stable_json().expect("stable json");
        assert!(json.ends_with('\n'));
        let parsed: MvMzEncryptedImageReport = serde_json::from_str(&json).expect("round trip");
        assert_eq!(parsed, report.redacted_for_report());
    }
}
