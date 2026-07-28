use serde::{Deserialize, Serialize};

use crate::mv_mz_asset_xor::RPGMAKER_ASSET_XOR_PREFIX_LEN;
use crate::mv_mz_encrypted_audio::{OGG_SIGNATURE, SYNTHETIC_OGG};
use crate::mv_mz_encrypted_image::{PNG_SIGNATURE, SYNTHETIC_PNG};
use crate::{
    CodecTransform, ContainerTransform, CryptoTransform, KaifuuResult, KeyMaterialKind,
    KeyValidationProof, OperationStatus, PartialDiagnosticSeverity, PatchBackTransform, ProofHash,
    RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER, SecretRef, SurfaceTransform, redact_for_log_or_report,
    sha256_hash_bytes, stable_json,
};

pub const MV_MZ_ASSET_REPLACEMENT_SCHEMA_VERSION: &str = "0.1.0";

pub const MV_MZ_ASSET_REPLACEMENT_ENGINE_FAMILY: &str = "rpg_maker_mv_mz";
pub const MV_MZ_ASSET_REPLACEMENT_VARIANT: &str = "mv_or_mz";
pub const MV_MZ_ASSET_REPLACEMENT_FIXTURE_ID: &str = "kaifuu-rpgmaker-mv-mz-asset-replacement";
/// The MV/MZ asset-XOR scheme id — shared verbatim with the image/audio paths.
pub const MV_MZ_ASSET_REPLACEMENT_CRYPTO_PROFILE_ID: &str = "rpgmaker/mv_mz/asset_xor_v1";
/// The single secret requirement: the `System.json` asset key — the same key
/// requirement the image/audio paths declare (one project key masks all media).
pub const MV_MZ_ASSET_REPLACEMENT_REQUIREMENT_ID: &str = "rpgmaker-mv-mz-asset-key";

pub const MV_MZ_ASSET_REPLACEMENT_SUPPORT_BOUNDARY: &str = "Kaifuu RPG Maker MV/MZ encrypted-asset replacement is in-process Rust (the shared RPGMV-header XOR-with-System.json-key scheme; image MV .rpgmvp / MZ .png_, audio MV .rpgmvo / MZ .ogg_); it never shells out. A new synthetic media asset is encrypted with the resolved key and patched in, then the patch is verified: decrypt(patched)==replacement, the RPGMV header and non-replaced tail bytes are exact, and the patch differs from the original. A consumable patch is published only after the resolved key's sha256 matches the declared key commitment, the replacement is valid media, and every verify check passes; wrong-key, tampered, missing-key, unsupported-surface, and non-media-replacement entries are rejected with typed findings before any consumable patch. Raw key bytes are never logged, serialized, or returned — the manifest and reports carry secret-refs + sha256 commitments only.";

pub const SEMANTIC_REPLACEMENT_REPLACED: &str = "kaifuu.rpgmaker.asset_replacement.replaced";
pub const SEMANTIC_REPLACEMENT_WRONG_KEY: &str = "kaifuu.rpgmaker.asset_replacement.wrong_key";
pub const SEMANTIC_REPLACEMENT_TAMPERED: &str = "kaifuu.rpgmaker.asset_replacement.tampered";
pub const SEMANTIC_REPLACEMENT_MISSING_KEY: &str = "kaifuu.rpgmaker.asset_replacement.missing_key";
pub const SEMANTIC_REPLACEMENT_UNSUPPORTED_SURFACE: &str =
    "kaifuu.rpgmaker.asset_replacement.unsupported_surface";
pub const SEMANTIC_REPLACEMENT_NOT_MEDIA: &str =
    "kaifuu.rpgmaker.asset_replacement.replacement_not_media";

const FINDING_WRONG_KEY: &str = "rpgmaker.asset_replacement.wrong_key";
const FINDING_TAMPERED: &str = "rpgmaker.asset_replacement.tampered";
const FINDING_MISSING_KEY: &str = "rpgmaker.asset_replacement.missing_key";
const FINDING_UNSUPPORTED_SURFACE: &str = "rpgmaker.asset_replacement.unsupported_surface";
const FINDING_NOT_MEDIA: &str = "rpgmaker.asset_replacement.replacement_not_media";
const FINDING_OUTCOME_MISMATCH: &str = "rpgmaker.asset_replacement.outcome_mismatch";
const FINDING_INTERNAL: &str = "rpgmaker.asset_replacement.internal";

/// The synthetic "correct" 16-byte asset key. Clearly fake fixture material.
/// Its sha256 is the manifest's declared `keyCommitmentSha256`.
const SYNTHETIC_KEY_CORRECT: &[u8; 16] = b"ITOTORIFIXTUREK0";
/// A synthetic key whose commitment does NOT match — drives wrong-key rejection.
const SYNTHETIC_KEY_WRONG: &[u8; 16] = b"XXXXXXXXXXXXXXXX";

/// The synthetic replacement IMAGE plaintext: the PNG signature followed by a
/// clearly-fake payload. Signature-bearing synthetic media (the same
/// signature-based bar the image/audio paths use); NOT a retail asset.
fn replacement_image() -> Vec<u8> {
    let mut bytes = PNG_SIGNATURE.to_vec();
    bytes.extend_from_slice(b"itotori-replacement-image-payload-0001");
    bytes
}

/// The synthetic replacement AUDIO plaintext: the `OggS` capture pattern
/// followed by a clearly-fake payload.
fn replacement_audio() -> Vec<u8> {
    let mut bytes = OGG_SIGNATURE.to_vec();
    bytes.extend_from_slice(b"itotori-replacement-audio-payload-0001");
    bytes
}

/// A blob carrying NEITHER media signature — drives the `replacement_not_media`
/// scenario.
fn replacement_not_media_blob() -> Vec<u8> {
    b"itotori-not-valid-media-replacement-blob".to_vec()
}

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
    fn original_plaintext(self) -> Vec<u8> {
        match self {
            Self::Image => SYNTHETIC_PNG.to_vec(),
            Self::Audio => SYNTHETIC_OGG.to_vec(),
        }
    }

    /// The synthetic replacement plaintext for this kind.
    fn replacement_plaintext(self) -> Vec<u8> {
        match self {
            Self::Image => replacement_image(),
            Self::Audio => replacement_audio(),
        }
    }

    /// True iff `bytes` begins with this kind's media signature.
    fn is_valid_media(self, bytes: &[u8]) -> bool {
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

/// The synthetic scenario a fixture entry materialises in-process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MvMzAssetReplacementScenario {
    /// Correct key (commitment matches); valid replacement media — replaces.
    Valid,
    /// Resolver yields a key whose commitment does NOT match — wrong key.
    WrongKey,
    /// A valid patch is produced then a byte is corrupted — tamper.
    Tampered,
    /// No key resolvable for the requirement.
    MissingKey,
    /// The surface codec does not match the media kind.
    UnsupportedSurface,
    /// The replacement plaintext lacks the declared media signature.
    ReplacementNotMedia,
}

impl MvMzAssetReplacementScenario {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Valid => "valid",
            Self::WrongKey => "wrong_key",
            Self::Tampered => "tampered",
            Self::MissingKey => "missing_key",
            Self::UnsupportedSurface => "unsupported_surface",
            Self::ReplacementNotMedia => "replacement_not_media",
        }
    }
}

/// The mechanical outcome of processing one entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MvMzAssetReplacementOutcome {
    /// Patched byte-correctly and every verify check passed.
    Replaced,
    /// Key commitment mismatch; rejected before producing a patch.
    WrongKeyRejected,
    /// Patched asset was corrupted; decrypt no longer recovers the replacement.
    TamperRejected,
    /// No key resolvable; no patch produced.
    MissingKey,
    /// Surface codec does not match the media kind.
    UnsupportedSurface,
    /// Replacement plaintext is not valid media of the declared kind.
    ReplacementNotMedia,
}

impl MvMzAssetReplacementOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Replaced => "replaced",
            Self::WrongKeyRejected => "wrong_key_rejected",
            Self::TamperRejected => "tamper_rejected",
            Self::MissingKey => "missing_key",
            Self::UnsupportedSurface => "unsupported_surface",
            Self::ReplacementNotMedia => "replacement_not_media",
        }
    }
}

/// The encrypted-asset replacement manifest: which encrypted assets are being
/// replaced, each referencing the key by SECRET REF and carrying sha256
/// commitments (never raw key material).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MvMzAssetReplacementManifest {
    pub schema_version: String,
    pub path_id: String,
    /// Provenance node id stamped into generated reports.
    pub source_node_id: String,
    pub engine_family: String,
    pub entries: Vec<MvMzAssetReplacementEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MvMzAssetReplacementEntry {
    pub entry_id: String,
    pub requirement_id: String,
    /// Structured secret-ref for the asset key. Never raw key material.
    pub secret_ref: SecretRef,
    /// sha256 commitment to the game asset key. The resolved key must match this
    /// (credential posture: commitment, never the key).
    pub key_commitment_sha256: String,
    /// The media kind being replaced.
    pub media_kind: ReplacementMediaKind,
    /// The named surface being replaced (provenance, e.g. `mv_mz/image/pictures`).
    pub surface_id: String,
    /// The declared surface codec; must match the media kind.
    pub surface_codec: CodecTransform,
    /// sha256 commitment to the intended replacement plaintext. The game must
    /// decrypt the patched asset to exactly this.
    pub replacement_sha256: String,
    pub scenario: MvMzAssetReplacementScenario,
    pub expected: MvMzAssetReplacementOutcome,
}


