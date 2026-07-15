//! bounded MV/MZ encrypted-asset decrypt → replace → patch →
//! verify **slice** over SYNTHETIC encrypted image/audio fixtures.
//! Where the kaifuu-core paths prove each leg in isolation
//! ([`kaifuu_core::mv_mz_encrypted_image`] decrypt/re-encrypt,
//! [`kaifuu_core::mv_mz_encrypted_audio`] decrypt/re-encrypt,
//! [`kaifuu_core::mv_mz_encrypted_asset_replacement`] replace+verify), THIS node
//! stitches them into one bounded, end-to-end slice and adds the two surfaces
//! those paths do not carry:
//! 1. **Encrypted-suffix routing.** RPG Maker ships encrypted assets under
//!    engine-specific suffixes — image MV `.rpgmvp` / MZ `.png_`, audio MV
//!    `.rpgmvo` (Ogg) / MZ `.ogg_`, audio MV `.rpgmvm` / MZ `.m4a_` (M4A). This
//!    slice parses the suffix to a [`MediaCapability`]; an off-profile suffix is
//!    a TYPED [`MvMzSliceError::UnsupportedSuffix`], never a silent skip.
//! 2. **Key source.** The 16-byte asset key is derived either from a
//!    `System.json`-style `encryptionKey` (a 32-hex string) or **image-derived**:
//!    recovered by XOR-ing the encrypted image's first 16 body bytes against the
//!    known PNG plaintext prefix — no `System.json` needed. A missing key is
//!    [`MvMzSliceError::NoKey`]; an undecodable `encryptionKey` is
//!    [`MvMzSliceError::BadKeyMaterial`]; a decodable-but-wrong key that fails to
//!    recover the declared media signature is [`MvMzSliceError::WrongKey`].
//! 3. **Audio/image capability diff.** A replacement whose media kind does not
//!    match the asset suffix's capability (e.g. an image blob patched over an
//!    `.ogg_` audio asset), or an image-derived key source pointed at an audio
//!    asset, is a TYPED [`MvMzSliceError::CapabilityDiff`].
//! # The crypto (shared core, native Rust, NO shell-out)
//! The XOR primitive, key type, decrypt, and re-encrypt are the single canonical
//! [`kaifuu_core::mv_mz_asset_xor`] implementation; this slice never
//! re-implements them. A 16-byte
//! [`kaifuu_core::RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER`] is prepended and the first
//! 16 media bytes are XOR-masked with the key. XOR is involutive, so a correct
//! key round-trips byte-for-byte.
//! # THE LINE (mechanical, not prose)
//! - Raw key bytes live only inside [`kaifuu_core::MvMzAssetKey`] (redacting
//!   `Debug`, zeroizing `Drop`). Reports carry secret-refs + sha256 commitments /
//!   hashes / counts only — never the key, never the media bytes.
//! - A consumable verify proof is published ONLY after the key resolves, the
//!   decrypt recovers the declared media signature, and every hash check passes.
//!   No-key, bad-key, wrong-key, unsupported-suffix, capability-diff, and
//!   non-media-replacement entries fail BEFORE a consumable proof — each is a
//!   TYPED [`MvMzSliceError`] surfaced as a structured diagnostic, never a panic
//!   or silent pass.
//! # Fixtures are synthetic + public
//! Every byte is synthesised in-module from the public synthetic PNG/OGG media of
//! the kaifuu-core paths plus a clearly-fake 16-byte test key. No retail media
//! and no real keys are ever vendored; reports carry only hashes / counts /
//! secret-refs.

use std::fmt;
use std::path::Path;

use kaifuu_core::mv_mz_encrypted_audio::{OGG_SIGNATURE, SYNTHETIC_OGG};
use kaifuu_core::mv_mz_encrypted_image::{PNG_SIGNATURE, SYNTHETIC_PNG};
use kaifuu_core::{
    HelperRedactionStatus, KeyValidationMethod, KeyValidationProof, MvMzAssetKey, OperationStatus,
    ProofHash, RPGMAKER_ASSET_XOR_PREFIX_LEN, RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER, SecretRef,
    decrypt_rpgmaker_asset, encrypt_rpgmaker_asset, redact_for_log_or_report, sha256_hash_bytes,
    stable_json,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const MV_MZ_SLICE_SCHEMA_VERSION: &str = "0.1.0";
pub const MV_MZ_SLICE_ENGINE_FAMILY: &str = "rpg_maker_mv_mz";
pub const MV_MZ_SLICE_VARIANT: &str = "mv_or_mz";
pub const MV_MZ_SLICE_CRYPTO_PROFILE_ID: &str = "rpgmaker/mv_mz/asset_xor_v1";
pub const MV_MZ_SLICE_REQUIREMENT_ID: &str = "rpgmaker-mv-mz-asset-key";
pub const MV_MZ_SLICE_FIXTURE_ID: &str = "kaifuu-rpgmaker-mv-mz-encrypted-asset-slice";

pub const MV_MZ_SLICE_SUPPORT_BOUNDARY: &str = "Kaifuu RPG Maker MV/MZ encrypted-asset slice (KAIFUU-068) is in-process Rust over the shared RPGMV-header XOR-with-System.json-key scheme (image MV .rpgmvp / MZ .png_, audio MV .rpgmvo|.rpgmvm / MZ .ogg_|.m4a_); it never shells out. It parses the encrypted suffix to an image/audio capability, resolves the 16-byte key from a System.json encryptionKey or image-derived metadata, decrypts to the declared media, and either proves a byte-correct identity round-trip or applies + verifies a trivial replacement patch (decrypt(patched)==replacement, header exact, differs-from-original). A consumable verify proof is published only after the key resolves and every hash check passes; no-key, bad-key, wrong-key, unsupported-suffix, capability-diff, and non-media-replacement entries are rejected with typed diagnostics before any consumable proof. Raw key bytes are never logged, serialized, or returned — reports carry secret-refs + sha256 commitments only.";

/// The media capability an encrypted asset carries. RPG Maker's encrypted
/// suffixes collapse to exactly two decrypt/verify capabilities.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaCapability {
    Image,
    Audio,
}

impl MediaCapability {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Audio => "audio",
        }
    }

    /// True iff `bytes` begins with this capability's plaintext media signature.
    /// Image is validated by the PNG signature; audio by the Ogg `OggS` capture
    /// pattern (the synthetic audio media this slice round-trips). NOTE: `.m4a_`
    /// assets are real M4A (`ftyp`), which the synthetic fixtures do not model;
    /// the suffix still routes to [`Self::Audio`], and a real M4A signature check
    /// would be added when M4A fixtures land.
    /// `pub(crate)` so the media-surface layer reuses this single
    /// signature oracle (never re-implements it).
    pub(crate) fn signature_matches(self, bytes: &[u8]) -> bool {
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

impl fmt::Display for MediaCapability {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// The RPG Maker MV/MZ encrypted-asset suffixes this slice profiles. Each maps to
/// exactly one [`MediaCapability`]; a suffix outside this set is an
/// [`MvMzSliceError::UnsupportedSuffix`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EncryptedAssetSuffix {
    /// MV image (`*.rpgmvp`).
    Rpgmvp,
    /// MZ image (`*.png_`).
    PngUnderscore,
    /// MV Ogg audio (`*.rpgmvo`).
    Rpgmvo,
    /// MZ Ogg audio (`*.ogg_`).
    OggUnderscore,
    /// MV M4A audio (`*.rpgmvm`).
    Rpgmvm,
    /// MZ M4A audio (`*.m4a_`).
    M4aUnderscore,
}

impl EncryptedAssetSuffix {
    /// All profiled suffixes in canonical order.
    #[must_use]
    pub fn all() -> [Self; 6] {
        [
            Self::Rpgmvp,
            Self::PngUnderscore,
            Self::Rpgmvo,
            Self::OggUnderscore,
            Self::Rpgmvm,
            Self::M4aUnderscore,
        ]
    }

    /// The lowercase suffix token (no leading dot).
    #[must_use]
    pub fn token(self) -> &'static str {
        match self {
            Self::Rpgmvp => "rpgmvp",
            Self::PngUnderscore => "png_",
            Self::Rpgmvo => "rpgmvo",
            Self::OggUnderscore => "ogg_",
            Self::Rpgmvm => "rpgmvm",
            Self::M4aUnderscore => "m4a_",
        }
    }

    /// The media capability this suffix carries.
    #[must_use]
    pub fn capability(self) -> MediaCapability {
        match self {
            Self::Rpgmvp | Self::PngUnderscore => MediaCapability::Image,
            Self::Rpgmvo | Self::OggUnderscore | Self::Rpgmvm | Self::M4aUnderscore => {
                MediaCapability::Audio
            }
        }
    }

    /// Parse the encrypted suffix from a file name. The suffix is the substring
    /// after the final `.`; matching is case-insensitive. An off-profile suffix
    /// (or a name with no suffix) is a typed [`MvMzSliceError::UnsupportedSuffix`].
    pub fn parse(file_name: &str) -> Result<Self, MvMzSliceError> {
        let raw = file_name.rsplit_once('.').map(|(_, suffix)| suffix);
        let lowered = raw.map(str::to_ascii_lowercase);
        let matched = lowered.as_deref().and_then(|token| {
            Self::all()
                .into_iter()
                .find(|suffix| suffix.token() == token)
        });
        matched.ok_or_else(|| MvMzSliceError::UnsupportedSuffix {
            suffix: raw.unwrap_or("<none>").to_string(),
        })
    }
}

/// The known 16-byte PNG plaintext prefix an image-derived key recovery XORs
/// against the encrypted image's first 16 body bytes. It is exactly the leading
/// 16 bytes of the public synthetic PNG media (a fixed PNG signature + IHDR
/// framing that every RPG Maker PNG shares in its first bytes).
fn known_png_prefix() -> [u8; RPGMAKER_ASSET_XOR_PREFIX_LEN] {
    let mut prefix = [0u8; RPGMAKER_ASSET_XOR_PREFIX_LEN];
    prefix.copy_from_slice(&SYNTHETIC_PNG[..RPGMAKER_ASSET_XOR_PREFIX_LEN]);
    prefix
}

/// How the 16-byte asset key is sourced for an entry. Raw key material never
/// reaches the report — only the [`MvMzKeySourceKind`] tag plus a one-way
/// commitment do.
#[derive(Debug, Clone)]
pub enum MvMzKeySource {
    /// A `System.json`-style `encryptionKey` hex string (32 lowercase hex chars →
    /// 16 bytes). Undecodable / wrong-length input is a typed
    /// [`MvMzSliceError::BadKeyMaterial`].
    SystemJsonEncryptionKey(String),
    /// Recover the key from the encrypted image itself: XOR the first 16 body
    /// bytes against the known PNG plaintext prefix. Image-only — pointing it at
    /// an audio asset is a [`MvMzSliceError::CapabilityDiff`].
    ImageDerived,
    /// No key is resolvable — a typed [`MvMzSliceError::NoKey`].
    None,
}

/// The report-safe tag for a key source (never carries the key bytes/hex).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MvMzKeySourceKind {
    SystemJsonEncryptionKey,
    ImageDerived,
    None,
}

impl MvMzKeySource {
    fn kind(&self) -> MvMzKeySourceKind {
        match self {
            Self::SystemJsonEncryptionKey(_) => MvMzKeySourceKind::SystemJsonEncryptionKey,
            Self::ImageDerived => MvMzKeySourceKind::ImageDerived,
            Self::None => MvMzKeySourceKind::None,
        }
    }

    /// Resolve the 16-byte asset key. `encrypted` is the encrypted asset bytes
    /// (needed for image-derived recovery); `capability` is the asset suffix's
    /// capability (image-derived is image-only). Every failure is typed.
    /// `pub(crate)` so the media-surface layer reuses this single key
    /// resolution path (System.json hex / image-derived / none).
    pub(crate) fn resolve(
        &self,
        encrypted: &[u8],
        capability: MediaCapability,
    ) -> Result<MvMzAssetKey, MvMzSliceError> {
        match self {
            Self::None => Err(MvMzSliceError::NoKey),
            Self::SystemJsonEncryptionKey(hex) => {
                let bytes = decode_encryption_key_hex(hex)?;
                Ok(MvMzAssetKey::from_bytes(&bytes))
            }
            Self::ImageDerived => {
                if capability != MediaCapability::Image {
                    return Err(MvMzSliceError::CapabilityDiff {
                        asset_capability: capability,
                        requested_capability: MediaCapability::Image,
                    });
                }
                let bytes = recover_image_derived_key(encrypted)?;
                Ok(MvMzAssetKey::from_bytes(&bytes))
            }
        }
    }
}

/// Decode a `System.json` `encryptionKey`: exactly 32 lowercase/uppercase hex
/// characters → 16 bytes. Anything else is a typed [`MvMzSliceError::BadKeyMaterial`].
fn decode_encryption_key_hex(hex: &str) -> Result<Vec<u8>, MvMzSliceError> {
    let expected_chars = RPGMAKER_ASSET_XOR_PREFIX_LEN * 2;
    if hex.len() != expected_chars {
        return Err(MvMzSliceError::BadKeyMaterial {
            reason: format!(
                "encryptionKey must be {expected_chars} hex chars, got {}",
                hex.len()
            ),
        });
    }
    let mut bytes = Vec::with_capacity(RPGMAKER_ASSET_XOR_PREFIX_LEN);
    let raw = hex.as_bytes();
    let mut index = 0;
    while index < raw.len() {
        let hi = hex_nibble(raw[index])?;
        let lo = hex_nibble(raw[index + 1])?;
        bytes.push((hi << 4) | lo);
        index += 2;
    }
    Ok(bytes)
}

fn hex_nibble(byte: u8) -> Result<u8, MvMzSliceError> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        other => Err(MvMzSliceError::BadKeyMaterial {
            reason: format!("non-hex byte 0x{other:02x} in encryptionKey"),
        }),
    }
}

/// Recover the 16-byte key from an encrypted image by XOR-ing its first 16 body
/// bytes (after the RPGMV header) against the known PNG plaintext prefix.
fn recover_image_derived_key(
    encrypted: &[u8],
) -> Result<[u8; RPGMAKER_ASSET_XOR_PREFIX_LEN], MvMzSliceError> {
    let header_len = RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER.len();
    let need = header_len + RPGMAKER_ASSET_XOR_PREFIX_LEN;
    if encrypted.len() < need {
        return Err(MvMzSliceError::MalformedAsset {
            reason: format!("encrypted image is {} bytes, need {need}", encrypted.len()),
        });
    }
    if &encrypted[..header_len] != RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER {
        return Err(MvMzSliceError::MalformedAsset {
            reason: "encrypted image lacks the RPGMV header magic".to_string(),
        });
    }
    let known = known_png_prefix();
    let mut key = [0u8; RPGMAKER_ASSET_XOR_PREFIX_LEN];
    for (index, slot) in key.iter_mut().enumerate() {
        *slot = encrypted[header_len + index] ^ known[index];
    }
    Ok(key)
}

/// The typed failure vocabulary of the slice. Every input problem is one of
/// these — never a panic, never a silent pass.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum MvMzSliceError {
    #[error("kaifuu.rpgmaker.k068.no_key: no asset key was resolvable for the secret requirement")]
    NoKey,
    #[error("kaifuu.rpgmaker.k068.bad_key_material: {reason}")]
    BadKeyMaterial { reason: String },
    #[error(
        "kaifuu.rpgmaker.k068.wrong_key: decrypt did not recover the declared {capability} media signature"
    )]
    WrongKey { capability: MediaCapability },
    #[error("kaifuu.rpgmaker.k068.unsupported_suffix: {suffix} is not a profiled encrypted suffix")]
    UnsupportedSuffix { suffix: String },
    #[error(
        "kaifuu.rpgmaker.k068.capability_diff: asset is {asset_capability} but the operation is {requested_capability}"
    )]
    CapabilityDiff {
        asset_capability: MediaCapability,
        requested_capability: MediaCapability,
    },
    #[error(
        "kaifuu.rpgmaker.k068.replacement_not_media: replacement does not carry the {capability} media signature"
    )]
    ReplacementNotMedia { capability: MediaCapability },
    #[error("kaifuu.rpgmaker.k068.malformed_asset: {reason}")]
    MalformedAsset { reason: String },
}

impl MvMzSliceError {
    /// The stable machine code (the `error` message prefix, without the message).
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::NoKey => "kaifuu.rpgmaker.k068.no_key",
            Self::BadKeyMaterial { .. } => "kaifuu.rpgmaker.k068.bad_key_material",
            Self::WrongKey { .. } => "kaifuu.rpgmaker.k068.wrong_key",
            Self::UnsupportedSuffix { .. } => "kaifuu.rpgmaker.k068.unsupported_suffix",
            Self::CapabilityDiff { .. } => "kaifuu.rpgmaker.k068.capability_diff",
            Self::ReplacementNotMedia { .. } => "kaifuu.rpgmaker.k068.replacement_not_media",
            Self::MalformedAsset { .. } => "kaifuu.rpgmaker.k068.malformed_asset",
        }
    }

    /// The semantic code (engine-family-namespaced), for cross-report joins.
    #[must_use]
    pub fn semantic_code(&self) -> &'static str {
        match self {
            Self::NoKey => "kaifuu.rpgmaker.encrypted_asset_slice.no_key",
            Self::BadKeyMaterial { .. } => "kaifuu.rpgmaker.encrypted_asset_slice.bad_key_material",
            Self::WrongKey { .. } => "kaifuu.rpgmaker.encrypted_asset_slice.wrong_key",
            Self::UnsupportedSuffix { .. } => {
                "kaifuu.rpgmaker.encrypted_asset_slice.unsupported_suffix"
            }
            Self::CapabilityDiff { .. } => "kaifuu.rpgmaker.encrypted_asset_slice.capability_diff",
            Self::ReplacementNotMedia { .. } => {
                "kaifuu.rpgmaker.encrypted_asset_slice.replacement_not_media"
            }
            Self::MalformedAsset { .. } => "kaifuu.rpgmaker.encrypted_asset_slice.malformed_asset",
        }
    }

    /// The slice outcome this error maps to.
    fn outcome(&self) -> MvMzSliceOutcome {
        match self {
            Self::NoKey => MvMzSliceOutcome::NoKey,
            Self::BadKeyMaterial { .. } => MvMzSliceOutcome::BadKeyMaterial,
            Self::WrongKey { .. } => MvMzSliceOutcome::WrongKey,
            Self::UnsupportedSuffix { .. } => MvMzSliceOutcome::UnsupportedSuffix,
            Self::CapabilityDiff { .. } => MvMzSliceOutcome::CapabilityDiff,
            Self::ReplacementNotMedia { .. } => MvMzSliceOutcome::ReplacementNotMedia,
            Self::MalformedAsset { .. } => MvMzSliceOutcome::MalformedAsset,
        }
    }

    fn diagnostic(&self) -> MvMzSliceDiagnostic {
        MvMzSliceDiagnostic {
            code: self.code().to_string(),
            semantic_code: self.semantic_code().to_string(),
            message: self.to_string(),
        }
    }
}

/// An internal failure building a proof hash. This is a programmer-error class
/// (the sha256 hashing invariants always hold for real bytes) surfaced instead
/// of a panic.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("kaifuu.rpgmaker.k068.internal: {0}")]
pub struct MvMzSliceInternalError(String);

fn proof_hash(bytes: &[u8]) -> Result<ProofHash, MvMzSliceInternalError> {
    ProofHash::new(sha256_hash_bytes(bytes)).map_err(MvMzSliceInternalError)
}

/// The mechanical outcome of one slice op.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MvMzSliceOutcome {
    /// Decrypted to the declared media AND re-encrypted byte-correctly (identity).
    DecryptedRoundTripped,
    /// A trivial replacement was patched in AND every verify check passed.
    Replaced,
    NoKey,
    BadKeyMaterial,
    WrongKey,
    UnsupportedSuffix,
    CapabilityDiff,
    ReplacementNotMedia,
    MalformedAsset,
}

impl MvMzSliceOutcome {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DecryptedRoundTripped => "decrypted_round_tripped",
            Self::Replaced => "replaced",
            Self::NoKey => "no_key",
            Self::BadKeyMaterial => "bad_key_material",
            Self::WrongKey => "wrong_key",
            Self::UnsupportedSuffix => "unsupported_suffix",
            Self::CapabilityDiff => "capability_diff",
            Self::ReplacementNotMedia => "replacement_not_media",
            Self::MalformedAsset => "malformed_asset",
        }
    }
}

/// A trivial replacement to patch in place of the decrypted asset.
#[derive(Debug, Clone)]
pub struct SliceReplacement {
    /// The media kind of the replacement plaintext. A mismatch with the asset
    /// suffix capability is a [`MvMzSliceError::CapabilityDiff`].
    pub capability: MediaCapability,
    /// The replacement plaintext bytes (must carry the capability's media signature).
    pub plaintext: Vec<u8>,
}

/// One slice op: an encrypted asset, a key source, and either an identity
/// round-trip (no replacement) or a trivial replacement patch.
#[derive(Debug, Clone)]
pub struct MvMzSliceOp {
    pub entry_id: String,
    /// The asset file name (its suffix routes the capability). Recorded sanitized.
    pub asset_file_name: String,
    pub secret_ref: SecretRef,
    pub key_source: MvMzKeySource,
    /// The encrypted asset bytes (synthetic).
    pub encrypted_asset: Vec<u8>,
    /// The known plaintext the asset must decrypt to (the decrypt-verify anchor).
    pub known_plaintext: Vec<u8>,
    /// `Some` for a replacement patch op; `None` for an identity round-trip.
    pub replacement: Option<SliceReplacement>,
    pub expected: MvMzSliceOutcome,
}

/// A structured diagnostic for a typed slice error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzSliceDiagnostic {
    pub code: String,
    pub semantic_code: String,
    pub message: String,
}

impl MvMzSliceDiagnostic {
    fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            semantic_code: redact_for_log_or_report(&self.semantic_code),
            message: redact_for_log_or_report(&self.message),
        }
    }
}

/// The identity-round-trip leg of a verify proof.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SliceRoundTripProof {
    /// sha256 of `re_encrypt(decrypt(enc))`.
    pub reencrypted_hash: ProofHash,
    /// `true` iff `reencrypted_hash == encrypted_source_hash` (byte-correct).
    pub byte_correct_round_trip: bool,
}

/// The replacement-patch leg of a verify proof.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlicePatchProof {
    /// sha256 of the intended replacement plaintext.
    pub replacement_plaintext_hash: ProofHash,
    /// sha256 of the produced patched encrypted asset.
    pub patched_encrypted_hash: ProofHash,
    /// sha256 of `decrypt(patched)`.
    pub decrypted_patched_hash: ProofHash,
    /// `true` iff `decrypt(patched) == replacement`.
    pub decrypt_matches_replacement: bool,
    /// `true` iff the patched asset differs from the original encrypted asset.
    pub differs_from_original: bool,
}

/// The hash-based verify proof. Carries hashes / counts / a secret-ref +
/// commitment only — never the key bytes, never the media bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzSliceVerifyProof {
    pub requirement_id: String,
    pub secret_ref: SecretRef,
    pub asset_capability: MediaCapability,
    pub key_source_kind: MvMzKeySourceKind,
    /// One-way sha256 commitment to the key bytes (never the key).
    pub key_material_hash: ProofHash,
    pub key_bytes: u32,
    /// sha256 of the original encrypted asset bytes.
    pub encrypted_source_hash: ProofHash,
    /// sha256 of `decrypt(enc)`.
    pub decrypted_plaintext_hash: ProofHash,
    /// sha256 of the declared known plaintext.
    pub known_plaintext_hash: ProofHash,
    /// `true` iff `decrypt(enc)` equals the declared known plaintext.
    pub decrypt_matches_known: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub round_trip: Option<SliceRoundTripProof>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub patch: Option<SlicePatchProof>,
    pub validation: KeyValidationProof,
    pub redaction_status: HelperRedactionStatus,
}

impl MvMzSliceVerifyProof {
    fn redacted_for_report(&self) -> Self {
        Self {
            requirement_id: redact_for_log_or_report(&self.requirement_id),
            secret_ref: self.secret_ref.clone(),
            asset_capability: self.asset_capability,
            key_source_kind: self.key_source_kind,
            key_material_hash: self.key_material_hash.clone(),
            key_bytes: self.key_bytes,
            encrypted_source_hash: self.encrypted_source_hash.clone(),
            decrypted_plaintext_hash: self.decrypted_plaintext_hash.clone(),
            known_plaintext_hash: self.known_plaintext_hash.clone(),
            decrypt_matches_known: self.decrypt_matches_known,
            round_trip: self.round_trip.clone(),
            patch: self.patch.clone(),
            validation: self.validation.clone(),
            redaction_status: self.redaction_status,
        }
    }
}

/// One slice entry report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzSliceEntryReport {
    pub entry_id: String,
    pub source_node_id: String,
    pub asset_file_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suffix: Option<EncryptedAssetSuffix>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_capability: Option<MediaCapability>,
    pub outcome: MvMzSliceOutcome,
    /// `true` only when a consumable verify proof was published.
    pub verified: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verify: Option<MvMzSliceVerifyProof>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<MvMzSliceDiagnostic>,
    pub validation_command: String,
    pub redaction_status: String,
    pub status: OperationStatus,
}

impl MvMzSliceEntryReport {
    /// The verify proof a caller may consume **iff** the entry passed and
    /// verified. Anything else returns `None`.
    #[must_use]
    pub fn consumable_proof(&self) -> Option<&MvMzSliceVerifyProof> {
        if self.verified && self.status == OperationStatus::Passed {
            self.verify.as_ref()
        } else {
            None
        }
    }

    fn redacted_for_report(&self) -> Self {
        Self {
            entry_id: redact_for_log_or_report(&self.entry_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            asset_file_name: redact_for_log_or_report(&self.asset_file_name),
            suffix: self.suffix,
            asset_capability: self.asset_capability,
            outcome: self.outcome,
            verified: self.verified,
            verify: self
                .verify
                .as_ref()
                .map(MvMzSliceVerifyProof::redacted_for_report),
            error: self
                .error
                .as_ref()
                .map(MvMzSliceDiagnostic::redacted_for_report),
            validation_command: redact_for_log_or_report(&self.validation_command),
            redaction_status: redact_for_log_or_report(&self.redaction_status),
            status: self.status.clone(),
        }
    }
}

/// The full slice report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvMzSliceReport {
    pub schema_version: String,
    pub source_node_id: String,
    pub engine_family: String,
    pub variant: String,
    pub crypto_profile_id: String,
    pub fixture_id: String,
    pub support_boundary: String,
    pub status: OperationStatus,
    pub entries: Vec<MvMzSliceEntryReport>,
}

impl MvMzSliceReport {
    #[must_use]
    pub fn entry(&self, entry_id: &str) -> Option<&MvMzSliceEntryReport> {
        self.entries.iter().find(|entry| entry.entry_id == entry_id)
    }

    #[must_use]
    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            variant: redact_for_log_or_report(&self.variant),
            crypto_profile_id: redact_for_log_or_report(&self.crypto_profile_id),
            fixture_id: redact_for_log_or_report(&self.fixture_id),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            status: self.status.clone(),
            entries: self
                .entries
                .iter()
                .map(MvMzSliceEntryReport::redacted_for_report)
                .collect(),
        }
    }

    /// Stable, redacted JSON (secret-refs + hashes only, trailing newline).
    pub fn stable_json(&self) -> Result<String, MvMzSliceInternalError> {
        stable_json(&self.redacted_for_report())
            .map_err(|err| MvMzSliceInternalError(err.to_string()))
    }
}

fn sanitize_file_name(name: &str) -> String {
    Path::new(name)
        .file_name()
        .and_then(|component| component.to_str())
        .map_or_else(|| "asset.bin".to_string(), ToString::to_string)
}

/// The pure decrypt→(replace)→patch→verify transform for one op. Returns the
/// verify proof + outcome on success, or a typed [`MvMzSliceError`]. Never
/// panics; input problems are all typed errors.
fn slice_verify(op: &MvMzSliceOp) -> Result<(MvMzSliceVerifyProof, MvMzSliceOutcome), SliceStep> {
    // (0) Route the encrypted suffix to a capability.
    let suffix = EncryptedAssetSuffix::parse(&op.asset_file_name).map_err(SliceStep::Typed)?;
    let capability = suffix.capability();

    // (1) Capability diff: a replacement whose kind mismatches the asset.
    if let Some(replacement) = &op.replacement
        && replacement.capability != capability
    {
        return Err(SliceStep::Typed(MvMzSliceError::CapabilityDiff {
            asset_capability: capability,
            requested_capability: replacement.capability,
        }));
    }

    // (2) Resolve the key (typed no-key / bad-key / capability-diff).
    let key = op
        .key_source
        .resolve(&op.encrypted_asset, capability)
        .map_err(SliceStep::Typed)?;

    // (3) Decrypt (typed malformed-asset).
    let plaintext = decrypt_rpgmaker_asset(&op.encrypted_asset, &key).map_err(|err| {
        SliceStep::Typed(MvMzSliceError::MalformedAsset {
            reason: format!("{err:?}"),
        })
    })?;

    // (4) Wrong-key gate: a correct decrypt recovers the declared media signature.
    if !capability.signature_matches(&plaintext) {
        return Err(SliceStep::Typed(MvMzSliceError::WrongKey { capability }));
    }

    // (5) Hash-based decrypt-verify against the declared known plaintext.
    let encrypted_source_hash = proof_hash(&op.encrypted_asset).map_err(SliceStep::Internal)?;
    let decrypted_plaintext_hash = proof_hash(&plaintext).map_err(SliceStep::Internal)?;
    let known_plaintext_hash = proof_hash(&op.known_plaintext).map_err(SliceStep::Internal)?;
    let decrypt_matches_known = plaintext == op.known_plaintext;
    let key_material_hash = key
        .material_hash()
        .map_err(|err| SliceStep::Internal(MvMzSliceInternalError(err.to_string())))?;
    let key_bytes = u32::try_from(key.byte_len()).unwrap_or(u32::MAX);

    let mut proof = MvMzSliceVerifyProof {
        requirement_id: MV_MZ_SLICE_REQUIREMENT_ID.to_string(),
        secret_ref: op.secret_ref.clone(),
        asset_capability: capability,
        key_source_kind: op.key_source.kind(),
        key_material_hash,
        key_bytes,
        encrypted_source_hash: encrypted_source_hash.clone(),
        decrypted_plaintext_hash,
        known_plaintext_hash,
        decrypt_matches_known,
        round_trip: None,
        patch: None,
        validation: KeyValidationProof {
            method: KeyValidationMethod::FixtureRoundTripProof,
            proof_hash: encrypted_source_hash.clone(),
        },
        redaction_status: HelperRedactionStatus::Redacted,
    };

    // (6a) Replacement patch path.
    if let Some(replacement) = &op.replacement {
        if !capability.signature_matches(&replacement.plaintext) {
            return Err(SliceStep::Typed(MvMzSliceError::ReplacementNotMedia {
                capability,
            }));
        }
        let patched = encrypt_rpgmaker_asset(&replacement.plaintext, &key);
        let decrypted_patched = decrypt_rpgmaker_asset(&patched, &key).map_err(|err| {
            SliceStep::Typed(MvMzSliceError::MalformedAsset {
                reason: format!("patched asset no longer decrypts: {err:?}"),
            })
        })?;
        let decrypt_matches_replacement = decrypted_patched == replacement.plaintext;
        let differs_from_original = patched != op.encrypted_asset;
        let decrypted_patched_hash = proof_hash(&decrypted_patched).map_err(SliceStep::Internal)?;
        proof.patch = Some(SlicePatchProof {
            replacement_plaintext_hash: proof_hash(&replacement.plaintext)
                .map_err(SliceStep::Internal)?,
            patched_encrypted_hash: proof_hash(&patched).map_err(SliceStep::Internal)?,
            decrypted_patched_hash: decrypted_patched_hash.clone(),
            decrypt_matches_replacement,
            differs_from_original,
        });
        proof.validation = KeyValidationProof {
            method: KeyValidationMethod::KnownPlaintextProof,
            proof_hash: decrypted_patched_hash,
        };
        // A produced-but-unverified patch is an internal fault, never published.
        if !(decrypt_matches_replacement && differs_from_original) {
            return Err(SliceStep::Internal(MvMzSliceInternalError(format!(
                "patch verify failed: decrypt_matches_replacement={decrypt_matches_replacement} differs_from_original={differs_from_original}"
            ))));
        }
        return Ok((proof, MvMzSliceOutcome::Replaced));
    }

    // (6b) Identity round-trip path.
    let reencrypted = encrypt_rpgmaker_asset(&plaintext, &key);
    let byte_correct_round_trip = reencrypted == op.encrypted_asset;
    proof.round_trip = Some(SliceRoundTripProof {
        reencrypted_hash: proof_hash(&reencrypted).map_err(SliceStep::Internal)?,
        byte_correct_round_trip,
    });
    if !byte_correct_round_trip {
        return Err(SliceStep::Internal(MvMzSliceInternalError(
            "identity round-trip not byte-correct".to_string(),
        )));
    }
    Ok((proof, MvMzSliceOutcome::DecryptedRoundTripped))
}

/// A failed step: a typed input error (a valid diagnostic) or an internal fault.
enum SliceStep {
    Typed(MvMzSliceError),
    Internal(MvMzSliceInternalError),
}

/// Run one slice op → an entry report. The declared `expected` outcome is
/// validated against the evidence-derived one: a correctly-diagnosed failure
/// (no-key, bad-key, wrong-key, unsupported-suffix, capability-diff,
/// replacement-not-media) is a PASSING conformance entry; only an outcome
/// mismatch or an internal fault flips the entry red. Returns `Err` only on an
/// internal fault.
pub fn run_slice_op(
    op: &MvMzSliceOp,
    source_node_id: &str,
) -> Result<MvMzSliceEntryReport, MvMzSliceInternalError> {
    let validation_command = format!(
        "kaifuu rpgmaker encrypted-asset-slice --asset {}",
        sanitize_file_name(&op.asset_file_name)
    );
    // Suffix (best-effort) for provenance even on a failing entry.
    let suffix = EncryptedAssetSuffix::parse(&op.asset_file_name).ok();
    let asset_capability = suffix.map(EncryptedAssetSuffix::capability);

    let (outcome, verify, error) = match slice_verify(op) {
        Ok((proof, outcome)) => (outcome, Some(proof), None),
        Err(SliceStep::Typed(err)) => (err.outcome(), None, Some(err.diagnostic())),
        Err(SliceStep::Internal(err)) => return Err(err),
    };

    let outcome_matches = op.expected == outcome;
    let verified =
        outcome == MvMzSliceOutcome::DecryptedRoundTripped || outcome == MvMzSliceOutcome::Replaced;
    // Belt-and-braces: a proof exists ONLY for a verified outcome.
    let verify = if verified { verify } else { None };
    let status = if outcome_matches {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };

    Ok(MvMzSliceEntryReport {
        entry_id: op.entry_id.clone(),
        source_node_id: source_node_id.to_string(),
        asset_file_name: sanitize_file_name(&op.asset_file_name),
        suffix,
        asset_capability,
        outcome,
        verified: verified && verify.is_some(),
        verify,
        error,
        validation_command,
        redaction_status: "redacted".to_string(),
        status,
    })
}

/// Run the whole slice fixture → a report. Aggregates per-op entries; the report
/// is `Passed` iff every entry passed.
pub fn run_mv_mz_slice(
    ops: &[MvMzSliceOp],
    source_node_id: &str,
) -> Result<MvMzSliceReport, MvMzSliceInternalError> {
    let mut entries = Vec::with_capacity(ops.len());
    for op in ops {
        entries.push(run_slice_op(op, source_node_id)?);
    }
    let status = if entries
        .iter()
        .all(|entry| entry.status == OperationStatus::Passed)
    {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };
    Ok(MvMzSliceReport {
        schema_version: MV_MZ_SLICE_SCHEMA_VERSION.to_string(),
        source_node_id: source_node_id.to_string(),
        engine_family: MV_MZ_SLICE_ENGINE_FAMILY.to_string(),
        variant: MV_MZ_SLICE_VARIANT.to_string(),
        crypto_profile_id: MV_MZ_SLICE_CRYPTO_PROFILE_ID.to_string(),
        fixture_id: MV_MZ_SLICE_FIXTURE_ID.to_string(),
        support_boundary: MV_MZ_SLICE_SUPPORT_BOUNDARY.to_string(),
        status,
        entries,
    })
}

/// The synthetic spec-DAG node id.
pub const MV_MZ_SLICE_SOURCE_NODE_ID: &str = "KAIFUU-068";

/// The clearly-fake 16-byte fixture key. Its hex is the synthetic `System.json`
/// `encryptionKey`.
const SLICE_KEY_CORRECT: &[u8; 16] = b"ITOTORIFIXTUREK0";
/// A decodable-but-wrong 16-byte key — drives the wrong-key rejection.
const SLICE_KEY_WRONG: &[u8; 16] = b"XXXXXXXXXXXXXXXX";

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from_digit(u32::from(byte >> 4), 16).unwrap_or('0'));
        out.push(char::from_digit(u32::from(byte & 0x0f), 16).unwrap_or('0'));
    }
    out
}

fn slice_secret_ref() -> SecretRef {
    SecretRef::new("local-secret:rpgmaker-mv-mz-asset-key")
        .expect("static local-secret ref is valid")
}

/// A clearly-synthetic replacement image (PNG signature + fake payload).
fn replacement_image() -> Vec<u8> {
    let mut bytes = PNG_SIGNATURE.to_vec();
    bytes.extend_from_slice(b"itotori-k068-replacement-image-0001");
    bytes
}

/// A clearly-synthetic replacement audio (OggS capture pattern + fake payload).
fn replacement_audio() -> Vec<u8> {
    let mut bytes = OGG_SIGNATURE.to_vec();
    bytes.extend_from_slice(b"itotori-k068-replacement-audio-0001");
    bytes
}

/// Encrypt the synthetic PNG with the correct key (a synthetic encrypted image).
fn encrypted_image() -> Vec<u8> {
    encrypt_rpgmaker_asset(SYNTHETIC_PNG, &MvMzAssetKey::from_bytes(SLICE_KEY_CORRECT))
}

/// Encrypt the synthetic OGG with the correct key (a synthetic encrypted audio).
fn encrypted_audio() -> Vec<u8> {
    encrypt_rpgmaker_asset(SYNTHETIC_OGG, &MvMzAssetKey::from_bytes(SLICE_KEY_CORRECT))
}

/// The canonical synthetic slice fixture: the decrypt/round-trip/replace happy
/// paths for image + audio, image-derived key recovery, and one op per typed
/// failure (no-key, bad-key material, wrong-key, unsupported-suffix,
/// capability-diff, replacement-not-media).
#[must_use]
pub fn canonical_slice_fixture() -> Vec<MvMzSliceOp> {
    let key_hex = hex_encode(SLICE_KEY_CORRECT);
    let wrong_hex = hex_encode(SLICE_KEY_WRONG);
    vec![
        // Image decrypt + identity round-trip (System.json encryptionKey).
        MvMzSliceOp {
            entry_id: "image-round-trip".to_string(),
            asset_file_name: "pictures/title.rpgmvp".to_string(),
            secret_ref: slice_secret_ref(),
            key_source: MvMzKeySource::SystemJsonEncryptionKey(key_hex.clone()),
            encrypted_asset: encrypted_image(),
            known_plaintext: SYNTHETIC_PNG.to_vec(),
            replacement: None,
            expected: MvMzSliceOutcome::DecryptedRoundTripped,
        },
        // Audio decrypt + identity round-trip (MZ.ogg_ suffix).
        MvMzSliceOp {
            entry_id: "audio-round-trip".to_string(),
            asset_file_name: "bgm/theme.ogg_".to_string(),
            secret_ref: slice_secret_ref(),
            key_source: MvMzKeySource::SystemJsonEncryptionKey(key_hex.clone()),
            encrypted_asset: encrypted_audio(),
            known_plaintext: SYNTHETIC_OGG.to_vec(),
            replacement: None,
            expected: MvMzSliceOutcome::DecryptedRoundTripped,
        },
        // Image-derived key recovery (no System.json) + round-trip.
        MvMzSliceOp {
            entry_id: "image-derived-key".to_string(),
            asset_file_name: "pictures/logo.png_".to_string(),
            secret_ref: slice_secret_ref(),
            key_source: MvMzKeySource::ImageDerived,
            encrypted_asset: encrypted_image(),
            known_plaintext: SYNTHETIC_PNG.to_vec(),
            replacement: None,
            expected: MvMzSliceOutcome::DecryptedRoundTripped,
        },
        // Trivial replacement patch (image).
        MvMzSliceOp {
            entry_id: "image-replace".to_string(),
            asset_file_name: "pictures/title.rpgmvp".to_string(),
            secret_ref: slice_secret_ref(),
            key_source: MvMzKeySource::SystemJsonEncryptionKey(key_hex.clone()),
            encrypted_asset: encrypted_image(),
            known_plaintext: SYNTHETIC_PNG.to_vec(),
            replacement: Some(SliceReplacement {
                capability: MediaCapability::Image,
                plaintext: replacement_image(),
            }),
            expected: MvMzSliceOutcome::Replaced,
        },
        // Trivial replacement patch (audio, MV.rpgmvo suffix).
        MvMzSliceOp {
            entry_id: "audio-replace".to_string(),
            asset_file_name: "bgm/theme.rpgmvo".to_string(),
            secret_ref: slice_secret_ref(),
            key_source: MvMzKeySource::SystemJsonEncryptionKey(key_hex.clone()),
            encrypted_asset: encrypted_audio(),
            known_plaintext: SYNTHETIC_OGG.to_vec(),
            replacement: Some(SliceReplacement {
                capability: MediaCapability::Audio,
                plaintext: replacement_audio(),
            }),
            expected: MvMzSliceOutcome::Replaced,
        },
        // Typed: no key.
        MvMzSliceOp {
            entry_id: "no-key".to_string(),
            asset_file_name: "pictures/title.rpgmvp".to_string(),
            secret_ref: slice_secret_ref(),
            key_source: MvMzKeySource::None,
            encrypted_asset: encrypted_image(),
            known_plaintext: SYNTHETIC_PNG.to_vec(),
            replacement: None,
            expected: MvMzSliceOutcome::NoKey,
        },
        // Typed: bad key material (undecodable encryptionKey).
        MvMzSliceOp {
            entry_id: "bad-key-material".to_string(),
            asset_file_name: "pictures/title.rpgmvp".to_string(),
            secret_ref: slice_secret_ref(),
            key_source: MvMzKeySource::SystemJsonEncryptionKey("not-hex".to_string()),
            encrypted_asset: encrypted_image(),
            known_plaintext: SYNTHETIC_PNG.to_vec(),
            replacement: None,
            expected: MvMzSliceOutcome::BadKeyMaterial,
        },
        // Typed: wrong key (decodable hex, decrypt fails the media signature).
        MvMzSliceOp {
            entry_id: "wrong-key".to_string(),
            asset_file_name: "pictures/title.rpgmvp".to_string(),
            secret_ref: slice_secret_ref(),
            key_source: MvMzKeySource::SystemJsonEncryptionKey(wrong_hex),
            encrypted_asset: encrypted_image(),
            known_plaintext: SYNTHETIC_PNG.to_vec(),
            replacement: None,
            expected: MvMzSliceOutcome::WrongKey,
        },
        // Typed: unsupported suffix.
        MvMzSliceOp {
            entry_id: "unsupported-suffix".to_string(),
            asset_file_name: "movies/opening.webm".to_string(),
            secret_ref: slice_secret_ref(),
            key_source: MvMzKeySource::SystemJsonEncryptionKey(key_hex.clone()),
            encrypted_asset: encrypted_image(),
            known_plaintext: SYNTHETIC_PNG.to_vec(),
            replacement: None,
            expected: MvMzSliceOutcome::UnsupportedSuffix,
        },
        // Typed: audio/image capability diff (image blob patched over audio asset).
        MvMzSliceOp {
            entry_id: "capability-diff".to_string(),
            asset_file_name: "bgm/theme.ogg_".to_string(),
            secret_ref: slice_secret_ref(),
            key_source: MvMzKeySource::SystemJsonEncryptionKey(key_hex.clone()),
            encrypted_asset: encrypted_audio(),
            known_plaintext: SYNTHETIC_OGG.to_vec(),
            replacement: Some(SliceReplacement {
                capability: MediaCapability::Image,
                plaintext: replacement_image(),
            }),
            expected: MvMzSliceOutcome::CapabilityDiff,
        },
        // Typed: replacement is not valid media of the declared kind.
        MvMzSliceOp {
            entry_id: "replacement-not-media".to_string(),
            asset_file_name: "pictures/title.rpgmvp".to_string(),
            secret_ref: slice_secret_ref(),
            key_source: MvMzKeySource::SystemJsonEncryptionKey(key_hex),
            encrypted_asset: encrypted_image(),
            known_plaintext: SYNTHETIC_PNG.to_vec(),
            replacement: Some(SliceReplacement {
                capability: MediaCapability::Image,
                plaintext: b"itotori-not-valid-media-blob".to_vec(),
            }),
            expected: MvMzSliceOutcome::ReplacementNotMedia,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report() -> MvMzSliceReport {
        run_mv_mz_slice(&canonical_slice_fixture(), MV_MZ_SLICE_SOURCE_NODE_ID)
            .expect("slice run must not fault internally")
    }

    #[test]
    fn suffix_routes_every_profiled_extension_to_a_capability() {
        for (name, suffix, cap) in [
            (
                "a.rpgmvp",
                EncryptedAssetSuffix::Rpgmvp,
                MediaCapability::Image,
            ),
            (
                "a.png_",
                EncryptedAssetSuffix::PngUnderscore,
                MediaCapability::Image,
            ),
            (
                "a.rpgmvo",
                EncryptedAssetSuffix::Rpgmvo,
                MediaCapability::Audio,
            ),
            (
                "a.ogg_",
                EncryptedAssetSuffix::OggUnderscore,
                MediaCapability::Audio,
            ),
            (
                "a.rpgmvm",
                EncryptedAssetSuffix::Rpgmvm,
                MediaCapability::Audio,
            ),
            (
                "a.m4a_",
                EncryptedAssetSuffix::M4aUnderscore,
                MediaCapability::Audio,
            ),
        ] {
            let parsed = EncryptedAssetSuffix::parse(name).expect("profiled suffix");
            assert_eq!(parsed, suffix, "{name}");
            assert_eq!(parsed.capability(), cap, "{name}");
        }
        // Case-insensitive.
        assert_eq!(
            EncryptedAssetSuffix::parse("A.RPGMVP").unwrap(),
            EncryptedAssetSuffix::Rpgmvp
        );
    }

    #[test]
    fn off_profile_suffix_is_a_typed_unsupported_error() {
        let err = EncryptedAssetSuffix::parse("a.webm").expect_err("off-profile");
        assert!(matches!(err, MvMzSliceError::UnsupportedSuffix { .. }));
        assert_eq!(err.code(), "kaifuu.rpgmaker.k068.unsupported_suffix");
        let no_suffix = EncryptedAssetSuffix::parse("noextension").expect_err("no suffix");
        assert!(matches!(
            no_suffix,
            MvMzSliceError::UnsupportedSuffix { .. }
        ));
    }

    #[test]
    fn system_json_hex_key_decrypts_and_image_derived_recovers_the_same_key() {
        let report = report();
        let via_hex = report.entry("image-round-trip").unwrap();
        let via_derived = report.entry("image-derived-key").unwrap();
        assert_eq!(via_hex.status, OperationStatus::Passed);
        assert_eq!(via_derived.status, OperationStatus::Passed);
        // Both key sources commit to the SAME key (image-derived recovered it).
        assert_eq!(
            via_hex.verify.as_ref().unwrap().key_material_hash.as_str(),
            via_derived
                .verify
                .as_ref()
                .unwrap()
                .key_material_hash
                .as_str()
        );
        assert_eq!(
            via_hex.verify.as_ref().unwrap().key_material_hash.as_str(),
            sha256_hash_bytes(SLICE_KEY_CORRECT)
        );
        assert_eq!(
            via_derived.verify.as_ref().unwrap().key_source_kind,
            MvMzKeySourceKind::ImageDerived
        );
    }

    #[test]
    fn bad_hex_encryption_key_is_typed_bad_key_material() {
        let bytes = decode_encryption_key_hex("not-hex");
        assert!(matches!(bytes, Err(MvMzSliceError::BadKeyMaterial { .. })));
        // Wrong length is also bad material.
        assert!(matches!(
            decode_encryption_key_hex("00"),
            Err(MvMzSliceError::BadKeyMaterial { .. })
        ));
        // A correct 32-hex key decodes to the 16 bytes.
        let ok = decode_encryption_key_hex(&hex_encode(SLICE_KEY_CORRECT)).unwrap();
        assert_eq!(ok, SLICE_KEY_CORRECT);
    }

    #[test]
    fn slice_matrix_passes_and_records_the_node() {
        let report = report();
        assert_eq!(
            report.status,
            OperationStatus::Passed,
            "{:?}",
            report.entries
        );
        assert_eq!(report.source_node_id, "KAIFUU-068");
        assert_eq!(report.engine_family, "rpg_maker_mv_mz");
        assert_eq!(report.crypto_profile_id, "rpgmaker/mv_mz/asset_xor_v1");
        for entry in &report.entries {
            assert_eq!(entry.status, OperationStatus::Passed, "{entry:?}");
            assert_eq!(entry.source_node_id, "KAIFUU-068");
            assert!(
                entry
                    .validation_command
                    .starts_with("kaifuu rpgmaker encrypted-asset-slice --asset")
            );
            assert_eq!(entry.redaction_status, "redacted");
        }
    }

    #[test]
    fn image_and_audio_decrypt_round_trip_with_matching_hashes() {
        let report = report();
        for (entry_id, plaintext) in [
            ("image-round-trip", SYNTHETIC_PNG),
            ("audio-round-trip", SYNTHETIC_OGG),
        ] {
            let entry = report.entry(entry_id).unwrap();
            assert_eq!(entry.outcome, MvMzSliceOutcome::DecryptedRoundTripped);
            assert!(entry.verified);
            let proof = entry.consumable_proof().expect("consumable");
            assert!(proof.decrypt_matches_known);
            assert_eq!(
                proof.decrypted_plaintext_hash.as_str(),
                sha256_hash_bytes(plaintext)
            );
            assert_eq!(
                proof.decrypted_plaintext_hash.as_str(),
                proof.known_plaintext_hash.as_str()
            );
            let round_trip = proof.round_trip.as_ref().expect("round-trip leg");
            assert!(round_trip.byte_correct_round_trip);
            // Byte-correct: the re-encrypted hash equals the encrypted source hash.
            assert_eq!(
                round_trip.reencrypted_hash.as_str(),
                proof.encrypted_source_hash.as_str()
            );
            assert!(proof.patch.is_none());
            assert_eq!(proof.key_bytes, RPGMAKER_ASSET_XOR_PREFIX_LEN as u32);
        }
    }

    #[test]
    fn replacement_patch_applies_and_verifies_for_image_and_audio() {
        let report = report();
        for (entry_id, replacement) in [
            ("image-replace", replacement_image()),
            ("audio-replace", replacement_audio()),
        ] {
            let entry = report.entry(entry_id).unwrap();
            assert_eq!(entry.outcome, MvMzSliceOutcome::Replaced);
            let proof = entry.consumable_proof().expect("consumable");
            let patch = proof.patch.as_ref().expect("patch leg");
            assert!(patch.decrypt_matches_replacement);
            assert!(patch.differs_from_original);
            // decrypt(patched) hashes to exactly the replacement plaintext.
            assert_eq!(
                patch.decrypted_patched_hash.as_str(),
                sha256_hash_bytes(&replacement)
            );
            assert_eq!(
                patch.decrypted_patched_hash.as_str(),
                patch.replacement_plaintext_hash.as_str()
            );
            // The patch genuinely changed the encrypted asset.
            assert_ne!(
                patch.patched_encrypted_hash.as_str(),
                proof.encrypted_source_hash.as_str()
            );
            assert_eq!(
                proof.validation.method,
                KeyValidationMethod::KnownPlaintextProof
            );
        }
    }

    #[test]
    fn no_key_bad_key_unsupported_suffix_and_capability_diff_are_typed() {
        let report = report();
        for (entry_id, outcome, code) in [
            (
                "no-key",
                MvMzSliceOutcome::NoKey,
                "kaifuu.rpgmaker.k068.no_key",
            ),
            (
                "bad-key-material",
                MvMzSliceOutcome::BadKeyMaterial,
                "kaifuu.rpgmaker.k068.bad_key_material",
            ),
            (
                "wrong-key",
                MvMzSliceOutcome::WrongKey,
                "kaifuu.rpgmaker.k068.wrong_key",
            ),
            (
                "unsupported-suffix",
                MvMzSliceOutcome::UnsupportedSuffix,
                "kaifuu.rpgmaker.k068.unsupported_suffix",
            ),
            (
                "capability-diff",
                MvMzSliceOutcome::CapabilityDiff,
                "kaifuu.rpgmaker.k068.capability_diff",
            ),
            (
                "replacement-not-media",
                MvMzSliceOutcome::ReplacementNotMedia,
                "kaifuu.rpgmaker.k068.replacement_not_media",
            ),
        ] {
            let entry = report.entry(entry_id).unwrap();
            assert_eq!(entry.outcome, outcome, "{entry_id}");
            assert!(!entry.verified, "{entry_id} must not verify");
            assert!(entry.verify.is_none(), "{entry_id} must publish no proof");
            assert!(
                entry.consumable_proof().is_none(),
                "{entry_id} must not be consumable"
            );
            let diagnostic = entry.error.as_ref().expect("typed diagnostic");
            assert_eq!(diagnostic.code, code, "{entry_id}");
            assert!(
                diagnostic
                    .semantic_code
                    .starts_with("kaifuu.rpgmaker.encrypted_asset_slice."),
                "{entry_id}"
            );
            // A correctly-diagnosed failure is a PASSING conformance entry.
            assert_eq!(entry.status, OperationStatus::Passed, "{entry_id}");
        }
    }

    #[test]
    fn validator_fails_on_outcome_mismatch() {
        let mut ops = canonical_slice_fixture();
        for op in &mut ops {
            if op.entry_id == "wrong-key" {
                op.expected = MvMzSliceOutcome::DecryptedRoundTripped;
            }
        }
        let report = run_mv_mz_slice(&ops, MV_MZ_SLICE_SOURCE_NODE_ID).unwrap();
        assert_eq!(report.status, OperationStatus::Failed);
        let entry = report.entry("wrong-key").unwrap();
        assert_eq!(entry.status, OperationStatus::Failed);
        // The evidence-derived outcome is still the truthful wrong-key.
        assert_eq!(entry.outcome, MvMzSliceOutcome::WrongKey);
    }

    #[test]
    fn report_never_carries_raw_key_material() {
        let report = report();
        let json = report.stable_json().expect("stable json");
        let key_text = String::from_utf8_lossy(SLICE_KEY_CORRECT);
        assert!(!json.contains(key_text.as_ref()), "raw key leaked");
        // The hex form of the key must not leak either.
        assert!(
            !json.contains(&hex_encode(SLICE_KEY_CORRECT)),
            "raw key hex leaked"
        );
        // The proof carries a one-way commitment + count, not the key.
        let proof = report
            .entry("image-round-trip")
            .unwrap()
            .verify
            .as_ref()
            .unwrap();
        assert_eq!(proof.key_bytes as usize, SLICE_KEY_CORRECT.len());
        assert_eq!(
            proof.key_material_hash.as_str(),
            sha256_hash_bytes(SLICE_KEY_CORRECT)
        );
    }

    #[test]
    fn report_round_trips_through_stable_json() {
        let report = report();
        let json = report.stable_json().expect("stable json");
        assert!(json.ends_with('\n'));
        let parsed: MvMzSliceReport = serde_json::from_str(&json).expect("round trip");
        assert_eq!(parsed, report.redacted_for_report());
    }

    #[test]
    fn image_derived_recovery_recovers_the_exact_key_bytes() {
        let encrypted = encrypted_image();
        let recovered = recover_image_derived_key(&encrypted).expect("recovers");
        assert_eq!(&recovered, SLICE_KEY_CORRECT);
        // A malformed (headerless) asset is a typed malformed-asset error.
        assert!(matches!(
            recover_image_derived_key(SYNTHETIC_PNG),
            Err(MvMzSliceError::MalformedAsset { .. })
        ));
    }
}
