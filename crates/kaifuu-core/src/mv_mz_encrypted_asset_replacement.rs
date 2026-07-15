//! RPG Maker MV/MZ encrypted-asset **replacement** patch + verify.
//! Where ([`crate::mv_mz_encrypted_image`]) and
//! ([`crate::mv_mz_encrypted_audio`]) prove a byte-correct *identity*
//! round-trip (`encrypt(decrypt(enc)) == enc`), THIS node proves an actual
//! **replacement**: a NEW synthetic media asset is encrypted with the game's
//! key (resolved via a declared secret ref) and patched in, producing a
//! byte-correct encrypted asset the game would decrypt to the *replacement*
//! (not the original). It then VERIFIES the patch and REJECTS a wrong-key or
//! tampered patch.
//! # The scheme (shared core, native Rust, NO shell-out)
//! The XOR primitive, key type, decrypt, and re-encrypt are the single
//! canonical [`crate::mv_mz_asset_xor`] implementation — image, audio, and this
//! replacement path all consume it; none re-implements the crypto. MV/MZ
//! encrypt image AND audio identically: a 16-byte
//! [`RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER`] is prepended and the first 16 bytes
//! of the media are XOR-masked with the 16-byte `System.json` key. Bytes beyond
//! the 16-byte prefix are stored verbatim.
//! MV vs MZ differ only in file extension, not in the scheme:
//! image MV `.rpgmvp` / MZ `.png_`; audio MV `.rpgmvo` / MZ `.ogg_`. Both route
//! through this path.
//! # The replacement + verify transform (per entry)
//! 1. The surface codec must match the media kind (`png_image` for an image
//!    replacement, `ogg_audio` for an audio replacement); anything else is an
//!    `unsupported_surface` before any byte is touched.
//! 2. The asset key is resolved from the declared **secret ref**. No key →
//!    `missing_key`, no patch produced.
//! 3. **Key-commitment gate (credential posture):** the resolved key's sha256
//!    must equal the manifest's declared `keyCommitmentSha256`. A mismatch is a
//!    WRONG KEY — rejected with a typed finding, no patch produced. This is how
//!    a wrong-key patch is refused without ever embedding the key.
//! 4. The replacement plaintext must carry the declared media signature (PNG /
//!    OggS); otherwise `replacement_not_media`.
//! 5. Encrypt the replacement with the key → the patched asset. For the tamper
//!    scenario a single byte of the patched asset is then corrupted.
//! 6. **Verify:** `decrypt(patched, key) == replacement` (round-trip); the first
//!    16 bytes are exactly the RPGMV header; the non-replaced tail (bytes beyond
//!    the 16-byte XOR prefix) is byte-identical to the replacement; and the
//!    patched asset differs from the original encrypted asset (a real
//!    replacement occurred). A tampered patch fails the round-trip and is
//!    REJECTED. `decrypt(patched)` must also equal the manifest's declared
//!    `replacementSha256`.
//! # THE LINE (mechanical, not prose)
//! - Raw key bytes live only inside the shared [`MvMzAssetKey`] (redacting
//!   `Debug`, zeroizing `Drop`). Reports carry secret-refs + sha256 commitments
//!   hashes / counts only — never the key, never the media bytes.
//! - A consumable replacement proof is produced ONLY after the key commitment
//!   matches, the replacement is valid media, and every verify check passes.
//!   Wrong-key, tampered, missing-key, unsupported-surface, and
//!   non-media-replacement entries fail BEFORE a consumable patch is published —
//!   each is a structured finding, never a silent skip or panic.
//! # Fixtures are synthetic + public
//! Every byte is synthesised in-module: the original in-game plaintext reuses
//! the public synthetic media; the replacement is a
//! clearly-synthetic signature-bearing blob; the key is a clearly-fake 16-byte
//! test key. No retail media and no real keys are ever vendored.

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
    /// The spec-DAG node id this manifest is authored for (``).
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzAssetReplacementReport {
    pub schema_version: String,
    pub path_id: String,
    pub source_node_id: String,
    pub engine_family: String,
    pub support_boundary: String,
    pub path: MvMzAssetReplacementPath,
    pub status: OperationStatus,
    pub entries: Vec<MvMzAssetReplacementEntryReport>,
}

impl MvMzAssetReplacementReport {
    pub fn entry(&self, entry_id: &str) -> Option<&MvMzAssetReplacementEntryReport> {
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
                .map(MvMzAssetReplacementEntryReport::redacted_for_report)
                .collect(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzAssetReplacementEntryReport {
    pub entry_id: String,
    pub source_node_id: String,
    pub path_id: String,
    pub surface_id: String,
    pub media_kind: ReplacementMediaKind,
    pub scenario: MvMzAssetReplacementScenario,
    pub outcome: MvMzAssetReplacementOutcome,
    /// `true` only when a patch was produced AND every verify check passed.
    pub replaced: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proof: Option<MvMzReplacementProof>,
    pub validation_command: String,
    pub redaction_status: String,
    pub status: OperationStatus,
    pub findings: Vec<MvMzAssetReplacementFinding>,
}

impl MvMzAssetReplacementEntryReport {
    /// The verified replacement patch proof a caller may consume **iff** the
    /// entry passed and replaced. Anything else returns `None`.
    pub fn consumable_proof(&self) -> Option<&MvMzReplacementProof> {
        if self.replaced && self.status == OperationStatus::Passed {
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
            media_kind: self.media_kind,
            scenario: self.scenario,
            outcome: self.outcome,
            replaced: self.replaced,
            proof: self
                .proof
                .as_ref()
                .map(MvMzReplacementProof::redacted_for_report),
            validation_command: redact_for_log_or_report(&self.validation_command),
            redaction_status: redact_for_log_or_report(&self.redaction_status),
            status: self.status.clone(),
            findings: self
                .findings
                .iter()
                .map(MvMzAssetReplacementFinding::redacted_for_report)
                .collect(),
        }
    }
}

/// The verified replacement proof. Carries hashes / counts / a secret-ref +
/// commitments only — never the key bytes, never the media bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzReplacementProof {
    pub requirement_id: String,
    pub secret_ref: SecretRef,
    pub surface_id: String,
    pub media_kind: ReplacementMediaKind,
    /// sha256 of the original (pre-replacement) encrypted asset.
    pub original_encrypted_hash: ProofHash,
    /// sha256 of the intended replacement plaintext (== declared commitment).
    pub replacement_plaintext_hash: ProofHash,
    /// sha256 of the produced patched encrypted asset.
    pub patched_encrypted_hash: ProofHash,
    /// sha256 of decrypt(patched); byte-correct iff it equals the replacement.
    pub decrypted_patched_hash: ProofHash,
    /// `true` iff `decrypt(patched) == replacement`.
    pub decrypt_matches_replacement: bool,
    /// `true` iff the first 16 bytes are exactly the RPGMV header.
    pub header_correct: bool,
    /// `true` iff the non-replaced tail (beyond the XOR prefix) is exact.
    pub tail_bytes_correct: bool,
    /// `true` iff the patched asset differs from the original (a real change).
    pub differs_from_original: bool,
    /// `true` iff decrypt(patched) matches the manifest's declared commitment.
    pub matches_declared_commitment: bool,
    /// `true` iff the resolved key sha256 matched the declared key commitment.
    pub key_commitment_matches: bool,
    /// One-way sha256 commitment to the key bytes (never the key).
    pub key_material_hash: ProofHash,
    pub key_bytes: u32,
    pub validation: KeyValidationProof,
    pub redaction_status: crate::HelperRedactionStatus,
}

impl MvMzReplacementProof {
    fn redacted_for_report(&self) -> Self {
        Self {
            requirement_id: redact_for_log_or_report(&self.requirement_id),
            secret_ref: self.secret_ref.clone(),
            surface_id: redact_for_log_or_report(&self.surface_id),
            media_kind: self.media_kind,
            original_encrypted_hash: self.original_encrypted_hash.clone(),
            replacement_plaintext_hash: self.replacement_plaintext_hash.clone(),
            patched_encrypted_hash: self.patched_encrypted_hash.clone(),
            decrypted_patched_hash: self.decrypted_patched_hash.clone(),
            decrypt_matches_replacement: self.decrypt_matches_replacement,
            header_correct: self.header_correct,
            tail_bytes_correct: self.tail_bytes_correct,
            differs_from_original: self.differs_from_original,
            matches_declared_commitment: self.matches_declared_commitment,
            key_commitment_matches: self.key_commitment_matches,
            key_material_hash: self.key_material_hash.clone(),
            key_bytes: self.key_bytes,
            validation: self.validation.clone(),
            redaction_status: self.redaction_status,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzAssetReplacementFinding {
    pub code: String,
    pub severity: PartialDiagnosticSeverity,
    pub field: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub semantic_code: Option<String>,
}

impl MvMzAssetReplacementFinding {
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

mod run;

pub use run::{MvMzAssetReplacementRequest, run_mv_mz_asset_replacement};

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::{KeyValidationMethod, read_json};

    fn manifest_dir() -> PathBuf {
        crate::test_manifest_dir()
            .join("../..")
            .join("fixtures/kaifuu/rpgmaker")
    }

    fn load_manifest() -> MvMzAssetReplacementManifest {
        read_json(&manifest_dir().join("encrypted-asset-replacement.json"))
            .expect("encrypted-asset-replacement manifest must parse")
    }

    fn run(manifest: &MvMzAssetReplacementManifest) -> MvMzAssetReplacementReport {
        run_mv_mz_asset_replacement(MvMzAssetReplacementRequest {
            manifest,
            manifest_file_name: "encrypted-asset-replacement.json",
        })
        .expect("run must not error internally")
    }

    fn entry_mut<'a>(
        manifest: &'a mut MvMzAssetReplacementManifest,
        entry_id: &str,
    ) -> &'a mut MvMzAssetReplacementEntry {
        manifest
            .entries
            .iter_mut()
            .find(|entry| entry.entry_id == entry_id)
            .expect("entry must exist")
    }

    fn has_finding(report: &MvMzAssetReplacementReport, entry_id: &str, code: &str) -> bool {
        report
            .entry(entry_id)
            .is_some_and(|entry| entry.findings.iter().any(|finding| finding.code == code))
    }

    #[test]
    fn canonical_path_declares_and_validates_every_leg() {
        let path = MvMzAssetReplacementPath::canonical().unwrap();
        assert_eq!(path.engine_family, "rpg_maker_mv_mz");
        assert_eq!(path.variant, "mv_or_mz");
        assert_eq!(path.container, ContainerTransform::ProjectAsset);
        assert_eq!(
            path.crypto_profile.crypto,
            CryptoTransform::RpgMakerAssetXor
        );
        assert_eq!(path.patch_back, PatchBackTransform::ReplaceAsset);
        assert_eq!(path.media_kinds.len(), 2);
        assert!(!path.diagnostics.is_empty());
        path.validate().expect("canonical path is consistent");
        // Consistency with the image/audio paths: shared crypto profile + key.
        assert_eq!(
            MV_MZ_ASSET_REPLACEMENT_CRYPTO_PROFILE_ID,
            crate::MV_MZ_ENCRYPTED_IMAGE_CRYPTO_PROFILE_ID
        );
        assert_eq!(
            MV_MZ_ASSET_REPLACEMENT_REQUIREMENT_ID,
            crate::MV_MZ_ENCRYPTED_AUDIO_REQUIREMENT_ID
        );
    }

    #[test]
    fn media_kind_extensions_note_mv_vs_mz() {
        assert_eq!(ReplacementMediaKind::Image.mv_extension(), "rpgmvp");
        assert_eq!(ReplacementMediaKind::Image.mz_extension(), "png_");
        assert_eq!(ReplacementMediaKind::Audio.mv_extension(), "rpgmvo");
        assert_eq!(ReplacementMediaKind::Audio.mz_extension(), "ogg_");
    }

    #[test]
    fn validate_rejects_wrong_codec_and_legs() {
        let mut path = MvMzAssetReplacementPath::canonical().unwrap();
        path.patch_back = PatchBackTransform::RewriteJson;
        path.media_kinds[0].codec = CodecTransform::OggAudio;
        let violations = path.validate().expect_err("must fail");
        assert!(violations.iter().any(|v| matches!(
            v,
            MvMzAssetReplacementPathViolation::PatchBackNotReplaceAsset { .. }
        )));
        assert!(violations.iter().any(|v| matches!(
            v,
            MvMzAssetReplacementPathViolation::MediaKindClaimsWrongCodec { .. }
        )));
    }

    #[test]
    fn manifest_matrix_passes_and_records_path() {
        let report = run(&load_manifest());
        assert_eq!(
            report.status,
            OperationStatus::Passed,
            "{:?}",
            report.entries
        );
        assert_eq!(report.source_node_id, "KAIFUU-117");
        report.path.validate().expect("path is consistent");
        for entry in &report.entries {
            assert_eq!(entry.status, OperationStatus::Passed, "{entry:?}");
            assert_eq!(entry.source_node_id, "KAIFUU-117");
            assert!(
                entry
                    .validation_command
                    .starts_with("kaifuu rpgmaker asset-replacement --manifest")
            );
            assert_eq!(entry.redaction_status, "redacted");
        }
    }

    // --- Image replacement: encrypt-with-key -> patch -> decrypt==replacement.

    #[test]
    fn image_replacement_round_trips_and_verifies() {
        let report = run(&load_manifest());
        let entry = report.entry("replace-image-pictures").unwrap();
        assert_eq!(entry.media_kind, ReplacementMediaKind::Image);
        assert_eq!(entry.outcome, MvMzAssetReplacementOutcome::Replaced);
        assert!(entry.replaced);
        let proof = entry.consumable_proof().expect("replaced is consumable");
        assert!(proof.decrypt_matches_replacement);
        assert!(proof.header_correct);
        assert!(proof.tail_bytes_correct);
        assert!(proof.differs_from_original);
        assert!(proof.matches_declared_commitment);
        assert!(proof.key_commitment_matches);
        // decrypt(patched) == replacement == the declared replacement commitment.
        assert_eq!(
            proof.decrypted_patched_hash.as_str(),
            proof.replacement_plaintext_hash.as_str()
        );
        assert_eq!(
            proof.decrypted_patched_hash.as_str(),
            sha256_hash_bytes(&replacement_image())
        );
        // The patch genuinely changed the asset.
        assert_ne!(
            proof.patched_encrypted_hash.as_str(),
            proof.original_encrypted_hash.as_str()
        );
        assert_eq!(
            proof.validation.method,
            KeyValidationMethod::KnownPlaintextProof
        );
    }

    #[test]
    fn audio_replacement_round_trips_and_verifies() {
        let report = run(&load_manifest());
        let entry = report.entry("replace-audio-bgm").unwrap();
        assert_eq!(entry.media_kind, ReplacementMediaKind::Audio);
        assert_eq!(entry.outcome, MvMzAssetReplacementOutcome::Replaced);
        let proof = entry.consumable_proof().expect("replaced is consumable");
        assert!(proof.decrypt_matches_replacement);
        assert!(proof.header_correct);
        assert!(proof.tail_bytes_correct);
        assert!(proof.differs_from_original);
        assert_eq!(
            proof.decrypted_patched_hash.as_str(),
            sha256_hash_bytes(&replacement_audio())
        );
    }

    #[test]
    fn wrong_key_and_tamper_and_more_are_rejected_with_no_consumable_patch() {
        let report = run(&load_manifest());
        for (entry_id, outcome, code) in [
            (
                "replace-image-wrong-key",
                MvMzAssetReplacementOutcome::WrongKeyRejected,
                FINDING_WRONG_KEY,
            ),
            (
                "replace-image-tampered",
                MvMzAssetReplacementOutcome::TamperRejected,
                FINDING_TAMPERED,
            ),
            (
                "replace-audio-tampered",
                MvMzAssetReplacementOutcome::TamperRejected,
                FINDING_TAMPERED,
            ),
            (
                "replace-image-missing-key",
                MvMzAssetReplacementOutcome::MissingKey,
                FINDING_MISSING_KEY,
            ),
            (
                "replace-audio-unsupported-surface",
                MvMzAssetReplacementOutcome::UnsupportedSurface,
                FINDING_UNSUPPORTED_SURFACE,
            ),
            (
                "replace-image-not-media",
                MvMzAssetReplacementOutcome::ReplacementNotMedia,
                FINDING_NOT_MEDIA,
            ),
        ] {
            let entry = report.entry(entry_id).unwrap();
            assert_eq!(entry.outcome, outcome, "{entry_id}");
            assert!(!entry.replaced, "{entry_id} must not replace");
            assert!(entry.proof.is_none(), "{entry_id} must publish no proof");
            assert!(
                entry.consumable_proof().is_none(),
                "{entry_id} must not be consumable"
            );
            assert!(has_finding(&report, entry_id, code), "{entry_id} finding");
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
        let mut manifest = load_manifest();
        entry_mut(&mut manifest, "replace-image-wrong-key").expected =
            MvMzAssetReplacementOutcome::Replaced;
        let report = run(&manifest);
        assert_eq!(report.status, OperationStatus::Failed);
        assert!(has_finding(
            &report,
            "replace-image-wrong-key",
            FINDING_OUTCOME_MISMATCH
        ));
    }

    #[test]
    fn manifest_carries_secret_refs_and_commitments_never_raw_key() {
        let manifest = load_manifest();
        for entry in &manifest.entries {
            assert_eq!(
                entry.secret_ref.scheme(),
                crate::SecretRefScheme::LocalSecret
            );
            // A `sha256:` + 64-hex commitment (never raw key material).
            assert!(entry.key_commitment_sha256.starts_with("sha256:"));
            assert_eq!(entry.key_commitment_sha256.len(), "sha256:".len() + 64);
            assert!(entry.replacement_sha256.starts_with("sha256:"));
            assert_eq!(entry.replacement_sha256.len(), "sha256:".len() + 64);
        }
        // The declared key commitment is the sha256 of the fake key, not the key.
        let valid = manifest
            .entries
            .iter()
            .find(|entry| entry.scenario == MvMzAssetReplacementScenario::Valid)
            .unwrap();
        assert_eq!(
            valid.key_commitment_sha256,
            sha256_hash_bytes(SYNTHETIC_KEY_CORRECT)
        );
    }

    #[test]
    fn report_never_carries_raw_key_material() {
        use std::fmt::Write as _;
        let report = run(&load_manifest());
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

        let proof = report
            .entry("replace-image-pictures")
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
    fn report_round_trips_through_stable_json() {
        let report = run(&load_manifest());
        let json = report.stable_json().expect("stable json");
        assert!(json.ends_with('\n'));
        let parsed: MvMzAssetReplacementReport = serde_json::from_str(&json).expect("round trip");
        assert_eq!(parsed, report.redacted_for_report());
    }

    #[test]
    fn replacement_media_differs_from_the_original() {
        assert_ne!(replacement_image(), SYNTHETIC_PNG.to_vec());
        assert_ne!(replacement_audio(), SYNTHETIC_OGG.to_vec());
        assert!(ReplacementMediaKind::Image.is_valid_media(&replacement_image()));
        assert!(ReplacementMediaKind::Audio.is_valid_media(&replacement_audio()));
        assert!(!ReplacementMediaKind::Image.is_valid_media(&replacement_not_media_blob()));
    }
}
