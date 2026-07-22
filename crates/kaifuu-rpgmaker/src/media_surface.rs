//! profiled MV/MZ **encrypted-media localization surfaces** +
//! asset replacement / patch-back policy.
//! The full-surface integration ([`crate::integration`]) supports
//! MV/MZ **JSON text** and declares encrypted media explicitly out-of-scope
//! (left byte-identical). ([`crate::encrypted_asset_slice`]) proves
//! the crypto: detect the encrypted suffix, resolve the 16-byte key, decrypt
//! with the real RPGMV-header XOR scheme, and re-encrypt byte-correctly. THIS
//! module is the layer that goes *beyond* "media is out of scope": it profiles
//! each encrypted media asset into a **localization role** and decides, per
//! asset, whether it is a translatable SURFACE or inventory-only — then hands
//! the localize decision to Itotori under a documented patch-back policy.
//! # What this node adds over crypto
//! 1. **Detection + decrypt (reused, not re-implemented).** The encrypted
//!    suffix routing ([`EncryptedAssetSuffix`]), key resolution
//!    ([`MvMzKeySource`]), and the XOR decrypt / re-encrypt
//!    ([`kaifuu_core::decrypt_rpgmaker_asset`] /
//!    [`kaifuu_core::encrypt_rpgmaker_asset`]) are the single canonical
//!    paths. A key-absent asset is **represented** as an encrypted asset (state
//!    [`MediaDecryptState::EncryptedKeyAbsent`]) — never a crash, never a
//!    silent drop.
//! 2. **Localization role (the surface model).** A [`MediaSurfaceProfile`] maps
//!    an asset's RPG Maker subtree (`img/pictures`, `img/system`, `audio/bgm`,
//!    …) to a [`MediaLocalizationRole`]: a text-bearing image, a UI texture, or
//!    audio/song metadata is a **candidate localization surface**; a plain
//!    sprite / tileset / sound effect is **inventory-only** (inventoried, not a
//!    surface).
//! 3. **Asset-decision handoff contract.** Per asset, [`build_media_surface`]
//!    emits a [`MediaAssetDecision`] telling Itotori the role, whether it is a
//!    candidate surface, whether the plaintext is available (key present), and
//!    the [`PatchBackMode`] the node will honor. Kaifuu classifies; **Itotori
//!    decides** whether to actually localize.
//! 4. **Replacement / patch-back policy.** [`plan_replacement`] re-encrypts a
//!    caller-supplied replacement with the *same key* and re-wraps the RPGMV
//!    header ([`PatchBackMode::ReEncryptSameKey`]) — but **only** for a profiled
//!    text-bearing surface whose key is available and whose replacement carries
//!    the matching media signature. An inventory-only asset, a key-absent asset,
//!    a capability mismatch, or a non-media replacement is a TYPED
//!    [`MediaSurfaceError`] (a semantic capability error), never a silent
//!    patch. Unchanged assets stay byte-identical
//!    (`re_encrypt(decrypt(x)) == x`).
//! # Text-bearing is DECLARED, not inferred from prose
//! The single subtlety worth flagging: **how "text-bearing" is determined.**
//! This node does NOT run OCR or guess from pixels. A profile's subtree → role
//! mapping is a *declaration* (the default [`MediaSurfaceProfile::rpg_maker`]
//! encodes the standard RPG Maker layout convention). A profiled text-bearing
//! image / UI texture / song-metadata asset is therefore a **candidate**
//! surface; the final "does this actually need localization" call is Itotori's,
//! made from the [`MediaAssetDecision`] handoff. This keeps the node honest —
//! it never asserts a texture contains text; it asserts the profile *classifies
//! its subtree as text-bearing*, which is a safe, reviewable rule.
//! # THE LINE
//! Reports carry sha256 commitments / counts / roles / paths only — never the
//! decrypted media bytes and never the key (the key stays inside
//! [`kaifuu_core::MvMzAssetKey`], redacting `Debug`, zeroizing `Drop`).
//! Failures *inside* a declared profile (a decrypt that fails on a profiled
//! text-bearing asset whose key IS present) are classified as
//! [`FailureClass::DeclaredProfileRegression`] — a bug / compatibility
//! regression — distinct from an out-of-profile capability error.

use std::path::Path;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use kaifuu_core::{
    ProofHash, decrypt_rpgmaker_asset, encrypt_rpgmaker_asset, redact_for_log_or_report,
    sha256_hash_bytes, stable_json,
};

use crate::encrypted_asset_slice::{EncryptedAssetSuffix, MediaCapability, MvMzKeySource};

#[path = "media_surface/operations.rs"]
mod operations;
#[path = "media_surface/profile_impl.rs"]
mod profile_impl;

pub use operations::{build_media_surface, commitment, plan_replacement};

/// Schema version of the media-surface manifest.
pub const MEDIA_SURFACE_SCHEMA_VERSION: &str = "0.1.0";
/// Provenance node id stamped into generated reports.
pub const MEDIA_SURFACE_SOURCE_NODE_ID: &str = "KAIFUU-059";
/// Engine family this profile targets.
pub const MEDIA_SURFACE_ENGINE_FAMILY: &str = "rpg_maker_mv_mz";

/// The declared support boundary of the media-surface profile.
/// A failure *inside* this boundary is a bug / compatibility regression (see
/// [`FailureClass`]); a rejection *outside* it (unsupported suffix,
/// inventory-only patch attempt) is an expected semantic capability error.
pub const MEDIA_SURFACE_SUPPORT_BOUNDARY: &str = "Kaifuu RPG Maker MV/MZ encrypted-media localization surfaces (KAIFUU-059) profile each encrypted image/audio asset (image MV .rpgmvp / MZ .png_, audio MV .rpgmvo|.rpgmvm / MZ .ogg_|.m4a_) into a localization role via its RPG Maker subtree, decrypt it with the shared RPGMV-header XOR-with-System.json-key scheme WHEN a key is available (key-absent is represented, never a crash), and expose a per-asset localize decision to Itotori. Text-bearing patch-back is honored only for a profiled text-bearing/ui-texture/song-metadata surface whose key is available and whose replacement carries the matching media signature; re-encryption uses the same key and re-wraps the header, and an unchanged asset stays byte-identical. Inventory-only assets, key-absent patch attempts, capability mismatches, non-media replacements, and unsupported suffixes are typed semantic errors, never silent. Reports carry sha256 commitments / roles / paths / counts only — never media bytes, never the key.";

// Localization role

/// The localization role a profiled encrypted media asset carries.
/// The first three are **candidate localization surfaces** (the asset may need
/// localization); [`Self::InventoryOnly`] is inventoried but is not a surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaLocalizationRole {
    /// A text-bearing image (title cards, message pictures) — a candidate
    /// surface whose pixels may render localizable text.
    TextBearingImage,
    /// A UI texture (system graphics, window skins, buttons) — a candidate
    /// surface whose pixels may render localizable UI text.
    UiTexture,
    /// Audio/song metadata (an Ogg VORBIS comment TITLE/ARTIST on a BGM/ME
    /// track) — a candidate surface whose *metadata* text may be localizable.
    AudioSongMetadata,
    /// A non-text asset (sprite, face, tileset, parallax, sound effect,
    /// ambience) — inventoried but never a localization surface.
    InventoryOnly,
}

// Media-surface profile (subtree -> role) — text-bearing is DECLARED here

/// One subtree → role rule. The rule matches when the asset's normalized
/// relative path contains `subtree` as a path segment sequence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSurfaceRule {
    /// The RPG Maker subtree fragment (`img/pictures`, `audio/bgm`, …). Matched
    /// case-insensitively against the asset's `/`-joined path.
    pub subtree: String,
    /// The role assets under `subtree` carry.
    pub role: MediaLocalizationRole,
}

/// A declarative subtree → localization-role classifier. The default
/// [`Self::rpg_maker`] encodes the standard RPG Maker MV/MZ directory layout;
/// callers may supply a game-specific profile. Rules are matched in order; the
/// first match wins. An asset that matches no rule is
/// [`MediaLocalizationRole::InventoryOnly`] (a safe default — never a silent
/// text claim).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSurfaceProfile {
    pub profile_id: String,
    pub rules: Vec<MediaSurfaceRule>,
}

// Decrypt state

/// The decrypt outcome for one encrypted media asset. Carries commitments /
/// lengths only — never the plaintext bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum MediaDecryptState {
    /// The asset decrypted with the available key. `media_signature_ok` is true
    /// iff the plaintext carries the capability's media signature.
    Decrypted {
        plaintext_sha256: String,
        plaintext_len: usize,
        media_signature_ok: bool,
    },
    /// No key was resolvable. The asset is REPRESENTED (its encrypted bytes
    /// hashed) but not decrypted — no crash, no drop.
    EncryptedKeyAbsent,
    /// A `System.json` `encryptionKey` was present but undecodable.
    KeyMaterialInvalid { reason: String },
    /// The key decoded but the decrypt did not recover the declared media
    /// signature (a wrong key).
    WrongKey,
    /// The asset is not a well-formed RPGMV-header asset (bad header / too
    /// short).
    MalformedAsset { reason: String },
}

// Patch-back policy

/// The patch-back mode the node will honor for an asset — the documented
/// replacement policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PatchBackMode {
    /// The asset is a profiled text-bearing surface with an available key: a
    /// replacement is re-encrypted with the SAME key and the RPGMV header is
    /// re-wrapped. Unchanged assets stay byte-identical.
    ReEncryptSameKey,
    /// The asset is a candidate surface but the key is absent, so the plaintext
    /// cannot be produced or patched; the encrypted bytes are held pending a
    /// key. Represented, never silently patched.
    HeldPendingKey,
    /// The asset is inventory-only: left byte-identical, never patched.
    ByteIdenticalPassthrough,
}

// Typed errors

/// The typed failure vocabulary of the media-surface layer. Every rejection is
/// a semantic capability error — never a panic, never a silent skip.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum MediaSurfaceError {
    #[error(
        "kaifuu.rpgmaker.k059.unsupported_suffix: {suffix} is not a profiled encrypted media suffix"
    )]
    UnsupportedSuffix { suffix: String },
    #[error(
        "kaifuu.rpgmaker.k059.not_a_surface: role {role} is inventory-only and cannot be patched"
    )]
    NotALocalizationSurface { role: MediaLocalizationRole },
    #[error(
        "kaifuu.rpgmaker.k059.key_absent: no key is available, the plaintext cannot be produced"
    )]
    KeyAbsent,
    #[error(
        "kaifuu.rpgmaker.k059.capability_diff: asset is {asset} but the replacement is {replacement}"
    )]
    CapabilityDiff {
        asset: MediaCapability,
        replacement: MediaCapability,
    },
    #[error(
        "kaifuu.rpgmaker.k059.replacement_not_media: replacement does not carry the {capability} media signature"
    )]
    ReplacementNotMedia { capability: MediaCapability },
    #[error("kaifuu.rpgmaker.k059.malformed_asset: {reason}")]
    MalformedAsset { reason: String },
    #[error(
        "kaifuu.rpgmaker.k059.wrong_key: decrypt did not recover the {capability} media signature"
    )]
    WrongKey { capability: MediaCapability },
}

/// Whether a failure is a bug/regression inside a declared profile or an
/// expected out-of-profile capability error.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureClass {
    /// A failure inside a declared, keyed profile — a bug / compatibility
    /// regression to be filed, NOT a feature request.
    DeclaredProfileRegression,
    /// An expected capability error (unsupported suffix, inventory-only patch
    /// attempt, key-absent, capability mismatch).
    OutOfProfileCapabilityError,
}

// The media-asset surface + Itotori decision handoff

/// One encrypted media asset represented as a (possibly) localization surface.
/// Report-safe: paths are sanitized, media is committed by sha256, and no key
/// material is present.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaAssetSurface {
    /// The sanitized relative asset path (its subtree drives the role).
    pub relative_path: String,
    /// The parsed encrypted suffix.
    pub suffix: EncryptedAssetSuffix,
    /// The media capability the suffix carries.
    pub capability: MediaCapability,
    /// The localization role from the profile.
    pub role: MediaLocalizationRole,
    /// True iff `role` is a candidate localization surface.
    pub is_localization_surface: bool,
    /// sha256 of the encrypted asset bytes (always present).
    pub encrypted_sha256: String,
    /// The decrypt outcome (plaintext commitment when a key is available).
    pub decrypt_state: MediaDecryptState,
    /// The Itotori asset-decision handoff for this asset.
    pub decision: MediaAssetDecision,
}

/// The asset-decision handoff contract: what kaifuu tells Itotori so Itotori
/// can DECIDE whether to localize this asset. Kaifuu classifies; Itotori
/// decides.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaAssetDecision {
    pub relative_path: String,
    pub role: MediaLocalizationRole,
    pub capability: MediaCapability,
    /// True iff this asset is a candidate localization surface Itotori may
    /// choose to localize.
    pub is_candidate_surface: bool,
    /// True iff the plaintext is available (key resolved + media signature ok),
    /// so a patch-back can actually be produced.
    pub plaintext_available: bool,
    /// The patch-back mode the node will honor for this asset.
    pub patch_back_mode: PatchBackMode,
    /// A machine-readable reason for the decision (structural, no retail text).
    pub reason: String,
}

// Replacement / patch-back

/// A byte-correct replacement plan for one profiled text-bearing surface. The
/// `patched_asset` is the re-encrypted, header-wrapped bytes; the proof fields
/// commit to the round-trip.
#[derive(Debug, Clone)]
pub struct ReplacementPlan {
    /// The re-encrypted asset bytes (same key, re-wrapped header).
    pub patched_asset: Vec<u8>,
    /// The proof (hashes + booleans) — report-safe.
    pub proof: ReplacementProof,
}

/// The report-safe replacement proof. Hashes + booleans only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplacementProof {
    pub mode: PatchBackMode,
    pub role: MediaLocalizationRole,
    pub capability: MediaCapability,
    pub original_encrypted_sha256: String,
    pub replacement_plaintext_sha256: String,
    pub patched_encrypted_sha256: String,
    pub decrypted_patched_sha256: String,
    /// `true` iff `decrypt(patched) == replacement`.
    pub decrypt_matches_replacement: bool,
    /// `true` iff the patched bytes differ from the original (a real change).
    /// `false` for an identity (unchanged) replacement.
    pub differs_from_original: bool,
    /// `true` iff a re-encrypt of the *original* plaintext is byte-identical to
    /// the original asset — the unchanged-asset byte-preservation guarantee.
    pub identity_byte_preserving: bool,
}

// Inventory manifest (report)

/// A deterministic, report-safe manifest of profiled encrypted media surfaces.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSurfaceManifest {
    pub schema_version: String,
    pub source_node_id: String,
    pub engine_family: String,
    pub profile_id: String,
    pub support_boundary: String,
    pub surfaces: Vec<MediaAssetSurface>,
    /// Count of candidate localization surfaces.
    pub localization_surface_count: usize,
    /// Count of inventory-only (non-text) assets.
    pub inventory_only_count: usize,
}

/// A stable-JSON serialization fault (programmer-error class, surfaced instead
/// of a panic).
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("kaifuu.rpgmaker.k059.manifest: {0}")]
pub struct MediaManifestError(String);

#[cfg(test)]
#[path = "media_surface/tests.rs"]
mod tests;
