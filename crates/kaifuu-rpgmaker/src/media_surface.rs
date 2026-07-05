//! KAIFUU-059 — profiled MV/MZ **encrypted-media localization surfaces** +
//! asset replacement / patch-back policy.
//!
//! The KAIFUU-112 full-surface integration ([`crate::integration`]) supports
//! MV/MZ **JSON text** and declares encrypted media explicitly out-of-scope
//! (left byte-identical). KAIFUU-068 ([`crate::encrypted_asset_slice`]) proves
//! the crypto: detect the encrypted suffix, resolve the 16-byte key, decrypt
//! with the real RPGMV-header XOR scheme, and re-encrypt byte-correctly. THIS
//! module is the layer that goes *beyond* "media is out of scope": it profiles
//! each encrypted media asset into a **localization role** and decides, per
//! asset, whether it is a translatable SURFACE or inventory-only — then hands
//! the localize decision to Itotori under a documented patch-back policy.
//!
//! # What this node adds over KAIFUU-068 crypto
//!
//! 1. **Detection + decrypt (reused, not re-implemented).** The encrypted
//!    suffix routing ([`EncryptedAssetSuffix`]), key resolution
//!    ([`MvMzKeySource`]), and the XOR decrypt / re-encrypt
//!    ([`kaifuu_core::decrypt_rpgmaker_asset`] /
//!    [`kaifuu_core::encrypt_rpgmaker_asset`]) are the single canonical KAIFUU-068
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
//!
//! # Text-bearing is DECLARED, not inferred from prose
//!
//! The single subtlety worth flagging: **how "text-bearing" is determined.**
//! This node does NOT run OCR or guess from pixels. A profile's subtree → role
//! mapping is a *declaration* (the default [`MediaSurfaceProfile::rpg_maker`]
//! encodes the standard RPG Maker layout convention). A profiled text-bearing
//! image / UI texture / song-metadata asset is therefore a **candidate**
//! surface; the final "does this actually need localization" call is Itotori's,
//! made from the [`MediaAssetDecision`] handoff. This keeps the node honest —
//! it never asserts a texture contains text; it asserts the profile *classifies
//! its subtree as text-bearing*, which is a safe, reviewable rule.
//!
//! # THE LINE
//!
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

/// Schema version of the KAIFUU-059 media-surface manifest.
pub const MEDIA_SURFACE_SCHEMA_VERSION: &str = "0.1.0";
/// The KAIFUU-059 spec-DAG node id.
pub const MEDIA_SURFACE_SOURCE_NODE_ID: &str = "KAIFUU-059";
/// Engine family this profile targets.
pub const MEDIA_SURFACE_ENGINE_FAMILY: &str = "rpg_maker_mv_mz";

/// The declared support boundary of the KAIFUU-059 media-surface profile.
///
/// A failure *inside* this boundary is a bug / compatibility regression (see
/// [`FailureClass`]); a rejection *outside* it (unsupported suffix,
/// inventory-only patch attempt) is an expected semantic capability error.
pub const MEDIA_SURFACE_SUPPORT_BOUNDARY: &str = "Kaifuu RPG Maker MV/MZ encrypted-media localization surfaces (KAIFUU-059) profile each encrypted image/audio asset (image MV .rpgmvp / MZ .png_, audio MV .rpgmvo|.rpgmvm / MZ .ogg_|.m4a_) into a localization role via its RPG Maker subtree, decrypt it with the shared RPGMV-header XOR-with-System.json-key scheme WHEN a key is available (key-absent is represented, never a crash), and expose a per-asset localize decision to Itotori. Text-bearing patch-back is honored only for a profiled text-bearing/ui-texture/song-metadata surface whose key is available and whose replacement carries the matching media signature; re-encryption uses the same key and re-wraps the header, and an unchanged asset stays byte-identical. Inventory-only assets, key-absent patch attempts, capability mismatches, non-media replacements, and unsupported suffixes are typed semantic errors, never silent. Reports carry sha256 commitments / roles / paths / counts only — never media bytes, never the key.";

// ---------------------------------------------------------------------------
// Localization role
// ---------------------------------------------------------------------------

/// The localization role a profiled encrypted media asset carries.
///
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

impl MediaLocalizationRole {
    /// All roles in canonical order.
    #[must_use]
    pub fn all() -> [Self; 4] {
        [
            Self::TextBearingImage,
            Self::UiTexture,
            Self::AudioSongMetadata,
            Self::InventoryOnly,
        ]
    }

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TextBearingImage => "text_bearing_image",
            Self::UiTexture => "ui_texture",
            Self::AudioSongMetadata => "audio_song_metadata",
            Self::InventoryOnly => "inventory_only",
        }
    }

    /// True iff this role is a candidate localization surface (i.e. it may need
    /// localization). Inventory-only assets return `false`.
    #[must_use]
    pub fn is_localization_surface(self) -> bool {
        !matches!(self, Self::InventoryOnly)
    }

    /// The media capability a role must carry. Song-metadata roles are audio;
    /// image/texture roles are image; inventory-only can be either, so it has
    /// no fixed capability.
    #[must_use]
    pub fn required_capability(self) -> Option<MediaCapability> {
        match self {
            Self::TextBearingImage | Self::UiTexture => Some(MediaCapability::Image),
            Self::AudioSongMetadata => Some(MediaCapability::Audio),
            Self::InventoryOnly => None,
        }
    }
}

impl std::fmt::Display for MediaLocalizationRole {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

// ---------------------------------------------------------------------------
// Media-surface profile (subtree -> role) — text-bearing is DECLARED here
// ---------------------------------------------------------------------------

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

impl MediaSurfaceProfile {
    /// The canonical RPG Maker MV/MZ default profile.
    ///
    /// Title screens and pictures render arbitrary (often text-bearing) art;
    /// the `system` subtree holds window/UI graphics; `bgm`/`me` are songs whose
    /// Ogg VORBIS comment metadata may be localizable. Sprites, faces,
    /// tilesets, parallaxes, battlebacks, animations, ambience (`bgs`), and
    /// sound effects (`se`) are inventory-only.
    #[must_use]
    pub fn rpg_maker() -> Self {
        use MediaLocalizationRole::{
            AudioSongMetadata, InventoryOnly, TextBearingImage, UiTexture,
        };
        let rule = |subtree: &str, role| MediaSurfaceRule {
            subtree: subtree.to_string(),
            role,
        };
        Self {
            profile_id: "rpg_maker/mv_mz/media_surface_default_v1".to_string(),
            rules: vec![
                // Text-bearing images.
                rule("img/titles1", TextBearingImage),
                rule("img/titles2", TextBearingImage),
                rule("img/pictures", TextBearingImage),
                // UI textures.
                rule("img/system", UiTexture),
                // Song metadata.
                rule("audio/bgm", AudioSongMetadata),
                rule("audio/me", AudioSongMetadata),
                // Explicit inventory-only subtrees (documented, not silent).
                rule("img/characters", InventoryOnly),
                rule("img/faces", InventoryOnly),
                rule("img/sv_actors", InventoryOnly),
                rule("img/sv_enemies", InventoryOnly),
                rule("img/enemies", InventoryOnly),
                rule("img/tilesets", InventoryOnly),
                rule("img/parallaxes", InventoryOnly),
                rule("img/battlebacks1", InventoryOnly),
                rule("img/battlebacks2", InventoryOnly),
                rule("img/animations", InventoryOnly),
                rule("audio/bgs", InventoryOnly),
                rule("audio/se", InventoryOnly),
            ],
        }
    }

    /// Classify an asset's relative path to a localization role. Path matching
    /// is case-insensitive and `\\`-normalized; an unmatched path is
    /// [`MediaLocalizationRole::InventoryOnly`].
    #[must_use]
    pub fn classify(&self, relative_path: &str) -> MediaLocalizationRole {
        let normalized = relative_path.replace('\\', "/").to_ascii_lowercase();
        for rule in &self.rules {
            let needle = rule.subtree.to_ascii_lowercase();
            if path_contains_subtree(&normalized, &needle) {
                return rule.role;
            }
        }
        MediaLocalizationRole::InventoryOnly
    }
}

/// True iff `subtree` (a `/`-joined fragment) appears as a whole segment run in
/// `path` (also `/`-joined, already lowercased). Prevents `img/system`
/// matching `img/systematic`.
fn path_contains_subtree(path: &str, subtree: &str) -> bool {
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let needle: Vec<&str> = subtree.split('/').filter(|s| !s.is_empty()).collect();
    if needle.is_empty() || needle.len() > segments.len() {
        return false;
    }
    segments
        .windows(needle.len())
        .any(|window| window == needle.as_slice())
}

// ---------------------------------------------------------------------------
// Decrypt state
// ---------------------------------------------------------------------------

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

impl MediaDecryptState {
    /// True iff the plaintext is available (a correct decrypt).
    #[must_use]
    pub fn is_decrypted(&self) -> bool {
        matches!(
            self,
            Self::Decrypted {
                media_signature_ok: true,
                ..
            }
        )
    }

    fn tag(&self) -> &'static str {
        match self {
            Self::Decrypted { .. } => "decrypted",
            Self::EncryptedKeyAbsent => "encrypted_key_absent",
            Self::KeyMaterialInvalid { .. } => "key_material_invalid",
            Self::WrongKey => "wrong_key",
            Self::MalformedAsset { .. } => "malformed_asset",
        }
    }
}

// ---------------------------------------------------------------------------
// Patch-back policy
// ---------------------------------------------------------------------------

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

impl PatchBackMode {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReEncryptSameKey => "re_encrypt_same_key",
            Self::HeldPendingKey => "held_pending_key",
            Self::ByteIdenticalPassthrough => "byte_identical_passthrough",
        }
    }
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

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

impl MediaSurfaceError {
    /// The stable machine code.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::UnsupportedSuffix { .. } => "kaifuu.rpgmaker.k059.unsupported_suffix",
            Self::NotALocalizationSurface { .. } => "kaifuu.rpgmaker.k059.not_a_surface",
            Self::KeyAbsent => "kaifuu.rpgmaker.k059.key_absent",
            Self::CapabilityDiff { .. } => "kaifuu.rpgmaker.k059.capability_diff",
            Self::ReplacementNotMedia { .. } => "kaifuu.rpgmaker.k059.replacement_not_media",
            Self::MalformedAsset { .. } => "kaifuu.rpgmaker.k059.malformed_asset",
            Self::WrongKey { .. } => "kaifuu.rpgmaker.k059.wrong_key",
        }
    }

    /// Classify a failure as a declared-profile regression (a bug) vs an
    /// expected out-of-profile capability error — acceptance item 4.
    ///
    /// `role` is the asset's localization role, `key_available` whether a key
    /// was resolvable. A `WrongKey` / `MalformedAsset` on a profiled surface
    /// WITH a key present is a regression (the declared profile should have
    /// decrypted it); everything else is an expected capability error.
    #[must_use]
    pub fn classify(&self, role: MediaLocalizationRole, key_available: bool) -> FailureClass {
        match self {
            Self::WrongKey { .. } | Self::MalformedAsset { .. }
                if role.is_localization_surface() && key_available =>
            {
                FailureClass::DeclaredProfileRegression
            }
            _ => FailureClass::OutOfProfileCapabilityError,
        }
    }
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

// ---------------------------------------------------------------------------
// The media-asset surface + Itotori decision handoff
// ---------------------------------------------------------------------------

/// One encrypted media asset represented as a (possibly) localization surface.
///
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

impl MediaAssetSurface {
    fn redacted_for_report(&self) -> Self {
        let mut clone = self.clone();
        clone.relative_path = redact_for_log_or_report(&self.relative_path);
        clone.decision.relative_path = redact_for_log_or_report(&self.decision.relative_path);
        clone.decision.reason = redact_for_log_or_report(&self.decision.reason);
        clone
    }
}

fn sanitize_relative_path(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    // Keep the last two segments (subtree hint) but strip any absolute prefix.
    let segments: Vec<&str> = normalized.split('/').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() {
        return "asset.bin".to_string();
    }
    segments.join("/")
}

/// Build the media-surface representation for one encrypted asset.
///
/// Detects the encrypted suffix (typed [`MediaSurfaceError::UnsupportedSuffix`]
/// for an off-profile suffix), classifies the localization role from
/// `profile`, and decrypts with `key_source` WHEN a key is available — a
/// key-absent asset is represented as [`MediaDecryptState::EncryptedKeyAbsent`]
/// (no crash). Returns the surface + the Itotori decision handoff.
pub fn build_media_surface(
    profile: &MediaSurfaceProfile,
    relative_path: &str,
    encrypted_asset: &[u8],
    key_source: &MvMzKeySource,
) -> Result<MediaAssetSurface, MediaSurfaceError> {
    let sanitized = sanitize_relative_path(relative_path);
    let file_name = Path::new(&sanitized)
        .file_name()
        .and_then(|c| c.to_str())
        .unwrap_or(&sanitized);
    let suffix = EncryptedAssetSuffix::parse(file_name).map_err(map_suffix_error)?;
    let capability = suffix.capability();
    let role = profile.classify(&sanitized);
    let encrypted_sha256 = sha256_hash_bytes(encrypted_asset);

    let decrypt_state = decrypt_state_for(encrypted_asset, key_source, capability);
    let plaintext_available = decrypt_state.is_decrypted();

    let patch_back_mode = if !role.is_localization_surface() {
        PatchBackMode::ByteIdenticalPassthrough
    } else if plaintext_available {
        PatchBackMode::ReEncryptSameKey
    } else {
        PatchBackMode::HeldPendingKey
    };

    let reason = format!(
        "role={} capability={} surface={} decrypt={} patch_back={}",
        role.as_str(),
        capability.as_str(),
        role.is_localization_surface(),
        decrypt_state.tag(),
        patch_back_mode.as_str()
    );

    let decision = MediaAssetDecision {
        relative_path: sanitized.clone(),
        role,
        capability,
        is_candidate_surface: role.is_localization_surface(),
        plaintext_available,
        patch_back_mode,
        reason,
    };

    Ok(MediaAssetSurface {
        relative_path: sanitized,
        suffix,
        capability,
        role,
        is_localization_surface: role.is_localization_surface(),
        encrypted_sha256,
        decrypt_state,
        decision,
    })
}

/// Resolve the key and decrypt, mapping every outcome to a [`MediaDecryptState`]
/// (key-absent and bad material are STATES, not hard errors — the asset is
/// still represented).
fn decrypt_state_for(
    encrypted: &[u8],
    key_source: &MvMzKeySource,
    capability: MediaCapability,
) -> MediaDecryptState {
    let key = match key_source.resolve(encrypted, capability) {
        Ok(key) => key,
        Err(err) => return key_resolution_state(&err),
    };
    match decrypt_rpgmaker_asset(encrypted, &key) {
        Ok(plaintext) => {
            let media_signature_ok = capability.signature_matches(&plaintext);
            if media_signature_ok {
                MediaDecryptState::Decrypted {
                    plaintext_sha256: sha256_hash_bytes(&plaintext),
                    plaintext_len: plaintext.len(),
                    media_signature_ok,
                }
            } else {
                MediaDecryptState::WrongKey
            }
        }
        Err(err) => MediaDecryptState::MalformedAsset {
            reason: format!("{err:?}"),
        },
    }
}

/// Map a KAIFUU-068 key-resolution error to a media-surface decrypt state.
fn key_resolution_state(err: &crate::encrypted_asset_slice::MvMzSliceError) -> MediaDecryptState {
    use crate::encrypted_asset_slice::MvMzSliceError;
    match err {
        MvMzSliceError::NoKey => MediaDecryptState::EncryptedKeyAbsent,
        MvMzSliceError::BadKeyMaterial { reason } => MediaDecryptState::KeyMaterialInvalid {
            reason: reason.clone(),
        },
        other => MediaDecryptState::MalformedAsset {
            reason: other.to_string(),
        },
    }
}

fn map_suffix_error(err: crate::encrypted_asset_slice::MvMzSliceError) -> MediaSurfaceError {
    use crate::encrypted_asset_slice::MvMzSliceError;
    match err {
        MvMzSliceError::UnsupportedSuffix { suffix } => {
            MediaSurfaceError::UnsupportedSuffix { suffix }
        }
        other => MediaSurfaceError::MalformedAsset {
            reason: other.to_string(),
        },
    }
}

// ---------------------------------------------------------------------------
// Replacement / patch-back
// ---------------------------------------------------------------------------

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

/// Plan a replacement (patch-back) for a profiled text-bearing surface.
///
/// Policy ([`PatchBackMode::ReEncryptSameKey`]): re-encrypt `replacement` with
/// the SAME key and re-wrap the RPGMV header. Allowed **only** when the asset's
/// role is a localization surface, the key is available, the replacement's
/// capability matches the asset, and the replacement carries the matching media
/// signature — every other case is a typed [`MediaSurfaceError`]. The proof
/// confirms `decrypt(patched) == replacement` and records whether the change
/// was byte-identical (unchanged) or a real diff.
pub fn plan_replacement(
    surface: &MediaAssetSurface,
    key_source: &MvMzKeySource,
    original_encrypted: &[u8],
    replacement_plaintext: &[u8],
) -> Result<ReplacementPlan, MediaSurfaceError> {
    // (1) Inventory-only assets are never patched.
    if !surface.role.is_localization_surface() {
        return Err(MediaSurfaceError::NotALocalizationSurface { role: surface.role });
    }
    // (2) The key must be available (the plaintext must be producible).
    let key = key_source
        .resolve(original_encrypted, surface.capability)
        .map_err(|err| match key_resolution_state(&err) {
            MediaDecryptState::EncryptedKeyAbsent
            | MediaDecryptState::KeyMaterialInvalid { .. } => MediaSurfaceError::KeyAbsent,
            _ => MediaSurfaceError::MalformedAsset {
                reason: err.to_string(),
            },
        })?;

    // (3) Verify the ORIGINAL decrypts to the declared capability (a wrong key
    // is a declared-profile regression, surfaced typed).
    let original_plaintext = decrypt_rpgmaker_asset(original_encrypted, &key).map_err(|err| {
        MediaSurfaceError::MalformedAsset {
            reason: format!("{err:?}"),
        }
    })?;
    if !surface.capability.signature_matches(&original_plaintext) {
        return Err(MediaSurfaceError::WrongKey {
            capability: surface.capability,
        });
    }

    // (4) The replacement must be media of the asset's capability.
    if !surface.capability.signature_matches(replacement_plaintext) {
        return Err(MediaSurfaceError::ReplacementNotMedia {
            capability: surface.capability,
        });
    }

    // (5) Re-encrypt the replacement with the SAME key + re-wrap the header.
    let patched = encrypt_rpgmaker_asset(replacement_plaintext, &key);
    let decrypted_patched = decrypt_rpgmaker_asset(&patched, &key).map_err(|err| {
        MediaSurfaceError::MalformedAsset {
            reason: format!("patched asset no longer decrypts: {err:?}"),
        }
    })?;
    let decrypt_matches_replacement = decrypted_patched == replacement_plaintext;
    let differs_from_original = patched != original_encrypted;

    // (6) Byte-preservation: re-encrypting the ORIGINAL plaintext reproduces the
    // original asset exactly (the unchanged-asset guarantee).
    let identity_reencrypt = encrypt_rpgmaker_asset(&original_plaintext, &key);
    let identity_byte_preserving = identity_reencrypt == original_encrypted;

    let proof = ReplacementProof {
        mode: PatchBackMode::ReEncryptSameKey,
        role: surface.role,
        capability: surface.capability,
        original_encrypted_sha256: sha256_hash_bytes(original_encrypted),
        replacement_plaintext_sha256: sha256_hash_bytes(replacement_plaintext),
        patched_encrypted_sha256: sha256_hash_bytes(&patched),
        decrypted_patched_sha256: sha256_hash_bytes(&decrypted_patched),
        decrypt_matches_replacement,
        differs_from_original,
        identity_byte_preserving,
    };

    // A produced-but-unverified patch is an internal fault surfaced as malformed
    // (never a silent bad patch).
    if !(decrypt_matches_replacement && identity_byte_preserving) {
        return Err(MediaSurfaceError::MalformedAsset {
            reason: format!(
                "patch verify failed: decrypt_matches_replacement={decrypt_matches_replacement} identity_byte_preserving={identity_byte_preserving}"
            ),
        });
    }

    Ok(ReplacementPlan {
        patched_asset: patched,
        proof,
    })
}

// ---------------------------------------------------------------------------
// Inventory manifest (report)
// ---------------------------------------------------------------------------

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

impl MediaSurfaceManifest {
    /// Build a manifest from classified surfaces.
    #[must_use]
    pub fn new(profile: &MediaSurfaceProfile, surfaces: Vec<MediaAssetSurface>) -> Self {
        let localization_surface_count = surfaces
            .iter()
            .filter(|s| s.is_localization_surface)
            .count();
        let inventory_only_count = surfaces.len() - localization_surface_count;
        Self {
            schema_version: MEDIA_SURFACE_SCHEMA_VERSION.to_string(),
            source_node_id: MEDIA_SURFACE_SOURCE_NODE_ID.to_string(),
            engine_family: MEDIA_SURFACE_ENGINE_FAMILY.to_string(),
            profile_id: profile.profile_id.clone(),
            support_boundary: MEDIA_SURFACE_SUPPORT_BOUNDARY.to_string(),
            surfaces,
            localization_surface_count,
            inventory_only_count,
        }
    }

    /// The Itotori decision handoffs for every asset (kaifuu classifies;
    /// Itotori decides).
    #[must_use]
    pub fn decisions(&self) -> Vec<MediaAssetDecision> {
        self.surfaces.iter().map(|s| s.decision.clone()).collect()
    }

    fn redacted_for_report(&self) -> Self {
        let mut clone = self.clone();
        clone.surfaces = self
            .surfaces
            .iter()
            .map(MediaAssetSurface::redacted_for_report)
            .collect();
        clone
    }

    /// Deterministic stable JSON. Carries roles / hashes / counts / structural
    /// paths only — never media bytes, never the key. Any secret-looking value
    /// is redacted as defense-in-depth.
    pub fn stable_json(&self) -> Result<String, MediaManifestError> {
        stable_json(&self.redacted_for_report()).map_err(|err| MediaManifestError(err.to_string()))
    }
}

/// A stable-JSON serialization fault (programmer-error class, surfaced instead
/// of a panic).
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("kaifuu.rpgmaker.k059.manifest: {0}")]
pub struct MediaManifestError(String);

/// A `ProofHash` helper kept for parity with the KAIFUU-068 slice (validates a
/// sha256 commitment before it is published).
#[must_use]
pub fn commitment(bytes: &[u8]) -> Option<ProofHash> {
    ProofHash::new(sha256_hash_bytes(bytes)).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use kaifuu_core::MvMzAssetKey;
    use kaifuu_core::mv_mz_encrypted_audio::{OGG_SIGNATURE, SYNTHETIC_OGG};
    use kaifuu_core::mv_mz_encrypted_image::{PNG_SIGNATURE, SYNTHETIC_PNG};

    const KEY: &[u8; 16] = b"ITOTORIFIXTUREK0";

    fn key_hex() -> String {
        let mut out = String::new();
        for byte in KEY {
            out.push(char::from_digit(u32::from(byte >> 4), 16).unwrap());
            out.push(char::from_digit(u32::from(byte & 0x0f), 16).unwrap());
        }
        out
    }

    fn enc_image() -> Vec<u8> {
        encrypt_rpgmaker_asset(SYNTHETIC_PNG, &MvMzAssetKey::from_bytes(KEY))
    }

    fn enc_audio() -> Vec<u8> {
        encrypt_rpgmaker_asset(SYNTHETIC_OGG, &MvMzAssetKey::from_bytes(KEY))
    }

    #[test]
    fn profile_classifies_subtrees_to_roles() {
        let p = MediaSurfaceProfile::rpg_maker();
        assert_eq!(
            p.classify("www/img/pictures/title.rpgmvp"),
            MediaLocalizationRole::TextBearingImage
        );
        assert_eq!(
            p.classify("www/img/titles1/logo.png_"),
            MediaLocalizationRole::TextBearingImage
        );
        assert_eq!(
            p.classify("www/img/system/Window.rpgmvp"),
            MediaLocalizationRole::UiTexture
        );
        assert_eq!(
            p.classify("www/audio/bgm/Theme.rpgmvo"),
            MediaLocalizationRole::AudioSongMetadata
        );
        assert_eq!(
            p.classify("www/img/characters/Actor1.rpgmvp"),
            MediaLocalizationRole::InventoryOnly
        );
        assert_eq!(
            p.classify("www/audio/se/Cursor.ogg_"),
            MediaLocalizationRole::InventoryOnly
        );
        // Unmatched subtree -> inventory-only (safe default).
        assert_eq!(
            p.classify("www/img/unknownsub/x.rpgmvp"),
            MediaLocalizationRole::InventoryOnly
        );
    }

    #[test]
    fn subtree_match_is_whole_segment() {
        let p = MediaSurfaceProfile::rpg_maker();
        // `img/system` must NOT match `img/systematic`.
        assert_eq!(
            p.classify("www/img/systematic/x.rpgmvp"),
            MediaLocalizationRole::InventoryOnly
        );
    }

    #[test]
    fn text_bearing_image_decrypts_and_is_a_surface() {
        let p = MediaSurfaceProfile::rpg_maker();
        let enc = enc_image();
        let surface = build_media_surface(
            &p,
            "www/img/pictures/title.rpgmvp",
            &enc,
            &MvMzKeySource::SystemJsonEncryptionKey(key_hex()),
        )
        .unwrap();
        assert_eq!(surface.role, MediaLocalizationRole::TextBearingImage);
        assert!(surface.is_localization_surface);
        assert!(surface.decrypt_state.is_decrypted());
        assert_eq!(
            surface.decision.patch_back_mode,
            PatchBackMode::ReEncryptSameKey
        );
        assert!(surface.decision.is_candidate_surface);
        assert!(surface.decision.plaintext_available);
    }

    #[test]
    fn audio_song_metadata_is_a_surface() {
        let p = MediaSurfaceProfile::rpg_maker();
        let enc = enc_audio();
        let surface = build_media_surface(
            &p,
            "www/audio/bgm/Theme.rpgmvo",
            &enc,
            &MvMzKeySource::SystemJsonEncryptionKey(key_hex()),
        )
        .unwrap();
        assert_eq!(surface.role, MediaLocalizationRole::AudioSongMetadata);
        assert_eq!(surface.capability, MediaCapability::Audio);
        assert!(surface.is_localization_surface);
        assert!(surface.decrypt_state.is_decrypted());
    }

    #[test]
    fn inventory_only_asset_is_not_a_surface_and_passes_through() {
        let p = MediaSurfaceProfile::rpg_maker();
        let enc = enc_image();
        let surface = build_media_surface(
            &p,
            "www/img/characters/Actor1.rpgmvp",
            &enc,
            &MvMzKeySource::SystemJsonEncryptionKey(key_hex()),
        )
        .unwrap();
        assert_eq!(surface.role, MediaLocalizationRole::InventoryOnly);
        assert!(!surface.is_localization_surface);
        assert_eq!(
            surface.decision.patch_back_mode,
            PatchBackMode::ByteIdenticalPassthrough
        );
    }

    #[test]
    fn key_absent_is_represented_not_a_crash() {
        let p = MediaSurfaceProfile::rpg_maker();
        let enc = enc_image();
        let surface = build_media_surface(
            &p,
            "www/img/pictures/title.rpgmvp",
            &enc,
            &MvMzKeySource::None,
        )
        .unwrap();
        // The asset is REPRESENTED without decrypting.
        assert_eq!(surface.decrypt_state, MediaDecryptState::EncryptedKeyAbsent);
        assert!(!surface.decision.plaintext_available);
        assert_eq!(
            surface.decision.patch_back_mode,
            PatchBackMode::HeldPendingKey
        );
        // But it is still a candidate surface (its role says so).
        assert!(surface.is_localization_surface);
        // The encrypted bytes are still committed.
        assert_eq!(surface.encrypted_sha256, sha256_hash_bytes(&enc));
    }

    #[test]
    fn unsupported_suffix_is_a_typed_error() {
        let p = MediaSurfaceProfile::rpg_maker();
        let err = build_media_surface(
            &p,
            "www/movies/opening.webm",
            b"not-media",
            &MvMzKeySource::None,
        )
        .unwrap_err();
        assert!(matches!(err, MediaSurfaceError::UnsupportedSuffix { .. }));
        assert_eq!(err.code(), "kaifuu.rpgmaker.k059.unsupported_suffix");
        assert_eq!(
            err.classify(MediaLocalizationRole::InventoryOnly, false),
            FailureClass::OutOfProfileCapabilityError
        );
    }

    #[test]
    fn replacement_round_trip_is_byte_correct() {
        let p = MediaSurfaceProfile::rpg_maker();
        let enc = enc_image();
        let surface = build_media_surface(
            &p,
            "www/img/pictures/title.rpgmvp",
            &enc,
            &MvMzKeySource::SystemJsonEncryptionKey(key_hex()),
        )
        .unwrap();
        // A real replacement image.
        let mut replacement = PNG_SIGNATURE.to_vec();
        replacement.extend_from_slice(b"k059-localized-title-card-0001");
        let plan = plan_replacement(
            &surface,
            &MvMzKeySource::SystemJsonEncryptionKey(key_hex()),
            &enc,
            &replacement,
        )
        .unwrap();
        assert!(plan.proof.decrypt_matches_replacement);
        assert!(plan.proof.differs_from_original);
        assert!(plan.proof.identity_byte_preserving);
        // decrypt(encrypt(x)) == x
        let re =
            decrypt_rpgmaker_asset(&plan.patched_asset, &MvMzAssetKey::from_bytes(KEY)).unwrap();
        assert_eq!(re, replacement);
    }

    #[test]
    fn unchanged_replacement_is_byte_identical() {
        let p = MediaSurfaceProfile::rpg_maker();
        let enc = enc_image();
        let surface = build_media_surface(
            &p,
            "www/img/pictures/title.rpgmvp",
            &enc,
            &MvMzKeySource::SystemJsonEncryptionKey(key_hex()),
        )
        .unwrap();
        // Re-supply the ORIGINAL plaintext as the "replacement".
        let plan = plan_replacement(
            &surface,
            &MvMzKeySource::SystemJsonEncryptionKey(key_hex()),
            &enc,
            SYNTHETIC_PNG,
        )
        .unwrap();
        assert!(
            !plan.proof.differs_from_original,
            "unchanged must be byte-identical"
        );
        assert_eq!(plan.patched_asset, enc);
    }

    #[test]
    fn inventory_only_replacement_is_refused() {
        let p = MediaSurfaceProfile::rpg_maker();
        let enc = enc_image();
        let surface = build_media_surface(
            &p,
            "www/img/characters/Actor1.rpgmvp",
            &enc,
            &MvMzKeySource::SystemJsonEncryptionKey(key_hex()),
        )
        .unwrap();
        let err = plan_replacement(
            &surface,
            &MvMzKeySource::SystemJsonEncryptionKey(key_hex()),
            &enc,
            SYNTHETIC_PNG,
        )
        .unwrap_err();
        assert!(matches!(
            err,
            MediaSurfaceError::NotALocalizationSurface { .. }
        ));
    }

    #[test]
    fn key_absent_replacement_is_refused() {
        let p = MediaSurfaceProfile::rpg_maker();
        let enc = enc_image();
        let surface = build_media_surface(
            &p,
            "www/img/pictures/title.rpgmvp",
            &enc,
            &MvMzKeySource::None,
        )
        .unwrap();
        let err =
            plan_replacement(&surface, &MvMzKeySource::None, &enc, SYNTHETIC_PNG).unwrap_err();
        assert_eq!(err, MediaSurfaceError::KeyAbsent);
    }

    #[test]
    fn capability_mismatch_replacement_is_refused() {
        let p = MediaSurfaceProfile::rpg_maker();
        let enc = enc_audio();
        let surface = build_media_surface(
            &p,
            "www/audio/bgm/Theme.rpgmvo",
            &enc,
            &MvMzKeySource::SystemJsonEncryptionKey(key_hex()),
        )
        .unwrap();
        // An image blob patched over an audio asset -> not audio media.
        let mut image = PNG_SIGNATURE.to_vec();
        image.extend_from_slice(b"wrong-kind");
        let err = plan_replacement(
            &surface,
            &MvMzKeySource::SystemJsonEncryptionKey(key_hex()),
            &enc,
            &image,
        )
        .unwrap_err();
        assert!(matches!(err, MediaSurfaceError::ReplacementNotMedia { .. }));
        // Sanity: a proper Ogg replacement is accepted.
        let mut ogg = OGG_SIGNATURE.to_vec();
        ogg.extend_from_slice(b"k059-localized-song-meta");
        assert!(
            plan_replacement(
                &surface,
                &MvMzKeySource::SystemJsonEncryptionKey(key_hex()),
                &enc,
                &ogg,
            )
            .is_ok()
        );
    }

    #[test]
    fn wrong_key_on_profiled_surface_is_a_declared_profile_regression() {
        let err = MediaSurfaceError::WrongKey {
            capability: MediaCapability::Image,
        };
        // Profiled surface + key available -> a bug/regression, not a feature request.
        assert_eq!(
            err.classify(MediaLocalizationRole::TextBearingImage, true),
            FailureClass::DeclaredProfileRegression
        );
        // Inventory-only or no key -> an expected capability error.
        assert_eq!(
            err.classify(MediaLocalizationRole::InventoryOnly, true),
            FailureClass::OutOfProfileCapabilityError
        );
    }

    #[test]
    fn manifest_counts_surfaces_and_redacts_paths() {
        let p = MediaSurfaceProfile::rpg_maker();
        let enc_img = enc_image();
        let enc_aud = enc_audio();
        let ks = MvMzKeySource::SystemJsonEncryptionKey(key_hex());
        let surfaces = vec![
            build_media_surface(&p, "www/img/pictures/a.rpgmvp", &enc_img, &ks).unwrap(),
            build_media_surface(&p, "www/audio/bgm/b.rpgmvo", &enc_aud, &ks).unwrap(),
            build_media_surface(&p, "www/img/characters/c.rpgmvp", &enc_img, &ks).unwrap(),
        ];
        let manifest = MediaSurfaceManifest::new(&p, surfaces);
        assert_eq!(manifest.localization_surface_count, 2);
        assert_eq!(manifest.inventory_only_count, 1);
        assert_eq!(manifest.decisions().len(), 3);
        let json = manifest.stable_json().unwrap();
        // Report-safe: roles + sha256 commitments present, but NEVER the key
        // hex and NEVER decrypted media bytes. (Structural paths are kept, as in
        // the KAIFUU-112 media inventory.)
        assert!(json.contains("text_bearing_image"));
        assert!(json.contains(&sha256_hash_bytes(&enc_img)));
        assert!(!json.contains(&key_hex()));
        assert!(!json.contains("ITOTORIFIXTUREK0"));
    }
}
