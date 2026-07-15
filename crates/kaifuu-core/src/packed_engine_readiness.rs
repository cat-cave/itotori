//! Packed-engine readiness profile validator.
//! A *packed-engine readiness profile* is the evidence-first, per-engine
//! declaration of the transform stack a packed (archive / encrypted-asset)
//! engine flows through, plus the key / helper gating that stands between a
//! recognized container and a usable text surface. It is the reusable sibling
//! of the MV/MZ JSON-text readiness record
//! ([`crate::MvMzReadinessRecord`]) and the KiriKiri XP3 capability
//! profile ([`crate::Xp3CapabilityProfileReport`]): where those pin one engine
//! family each, this validator composes the SHARED transform vocabulary
//! ([`ContainerTransform`] / [`CryptoTransform`] / [`CodecTransform`] /
//! [`SurfaceTransform`] / [`PatchBackTransform`]) and the SHARED capability
//! ladder ([`CapabilityLevel`]) into one schema that every packed engine
//! family is checked against.
//! # The mechanical line (not prose)
//! Mirroring ALPHA-004's matrix and 's plain-vs-encrypted line, the
//! distinction between a **profile-ready** posture and a **readiness-only**
//! posture is computed, never asserted. [`derive_packed_readiness_outcome`] is
//! the single source of truth: a profile only resolves to an
//! `identify`/`inventory`/`extract`/`patch` outcome when its layered transform
//! is supported AND its key material is resolved AND its helper is available.
//! A media-asset transform, missing key material, a helper-gated key, or an
//! unavailable helper collapses the outcome to
//! `unsupported_layered_transform` / `missing_key` / `helper_required` — a
//! readiness-only posture that can NEVER show a resolved extract/patch
//! capability. [`PackedReadinessOutcome::is_profile_ready`] is the mechanical
//! gate the report exposes.
//! # Consistency validation (structured findings, never silent)
//! [`validate_packed_engine_readiness_profile`] checks every profile against
//! its engine family's [`EngineProfileSpec`] and emits a structured
//! [`PackedReadinessFinding`] (with a shared [`SemanticErrorCode`]) whenever a
//! field is missing or inconsistent: an unknown engine family, an
//! out-of-profile container, an unsupported crypto / codec / surface /
//! patch-back leg, a capability overclaim past the engine ceiling, a missing
//! or unreferenced key, a missing helper id, a missing fixture id, or a
//! content-hash mismatch. A blocking finding flips the entry (and the report)
//! to [`OperationStatus::Failed`]; a malformed fixture file becomes a failed
//! entry, never a panic.
//! # Evidence is synthetic, redacted, hash-only
//! Profiles carry NO raw retail bytes and NO raw key material: only synthetic
//! content descriptors (`assetId` + byte count + per-asset `sha256` ref),
//! local-scheme [`SecretRef`] key references, and helper ids. The report is
//! funnelled through [`redact_for_log_or_report`] and serialized via
//! [`stable_json`]; it carries counts and hashes only.

use serde::{Deserialize, Serialize};

use crate::{
    CapabilityLevel, CodecTransform, ContainerTransform, CryptoTransform, PatchBackTransform,
    SurfaceTransform,
};

mod profile;
pub use profile::{
    PackedContentEntry, PackedEngineReadinessProfile, PackedHelperRequirement,
    PackedKeyRequirement, PackedReadinessEntryReport, PackedReadinessFinding,
    PackedReadinessOutcome, PackedReadinessPosture, PackedReadinessValidationReport,
    PackedTransformStack, derive_packed_readiness_outcome, recompute_content_hash,
    validate_packed_engine_readiness_dir, validate_packed_engine_readiness_profile,
};

/// Schema version of the profile input. Bumped on any breaking field change.
pub const PACKED_ENGINE_READINESS_SCHEMA_VERSION: &str = "0.1.0";
/// Schema version of the generated validation report.
pub const PACKED_READINESS_REPORT_SCHEMA_VERSION: &str = "0.1.0";
/// Canonical profile-fixture glob the validator consumes.
pub const PACKED_ENGINE_PROFILE_GLOB: &str = "*.profile.json";

/// The support boundary surfaced in every report.
pub const PACKED_ENGINE_READINESS_SUPPORT_BOUNDARY: &str = "Packed-engine readiness profiles compose the shared container, crypto, codec, surface, and patch-back transform vocabulary with the shared capability ladder. A profile resolves to a usable identify, inventory, extract, or patch posture only when its layered transform is supported, its key material is resolved, and its helper is available. A media-asset transform, a missing key, a helper-gated key, or an unavailable helper is a readiness-only posture that never claims extract or patch.";

// Engine families + per-family profile spec

/// The packed engine families this validator recognizes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PackedEngineFamily {
    /// Siglus (`SiglusPck` container, static-key crypto).
    Siglus,
    /// KiriKiri XP3 archive.
    KirikiriXp3,
    /// Wolf RPG Editor archive.
    Wolf,
    /// RPG Maker VX Ace RGSS3 (`Game.rgss3a`).
    Rgss3,
    /// BGI / Ethornell (BurikoGameInterface) archive.
    Bgi,
    /// RPG Maker MV/MZ encrypted media (`*.rpgmvp` / `*.rpgmvm` / `*.rpgmvo`).
    RpgMakerMvMzMedia,
    /// Unknown / unrecognized family — always an inconsistency.
    Unknown,
}

impl PackedEngineFamily {
    /// Stable string segment used in ids and findings.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Siglus => "siglus",
            Self::KirikiriXp3 => "kirikiri_xp3",
            Self::Wolf => "wolf",
            Self::Rgss3 => "rgss3",
            Self::Bgi => "bgi",
            Self::RpgMakerMvMzMedia => "rpg_maker_mv_mz_media",
            Self::Unknown => "unknown",
        }
    }

    /// The recognized (non-`Unknown`) families, in canonical order.
    pub fn recognized() -> [Self; 6] {
        [
            Self::Siglus,
            Self::KirikiriXp3,
            Self::Wolf,
            Self::Rgss3,
            Self::Bgi,
            Self::RpgMakerMvMzMedia,
        ]
    }

    /// The mechanical profile spec the validator checks a profile against.
    /// Returns `None` for [`PackedEngineFamily::Unknown`].
    pub fn profile_spec(self) -> Option<EngineProfileSpec> {
        use CodecTransform::{
            BinaryTable, BytecodeDecompile, M4aAudio, OggAudio, PngImage, RubyMarshal,
            ShiftJisText, Utf8Text, Utf16Text,
        };
        use CryptoTransform::{
            FixedKey, HelperGated, KeyProfile, NullKey, RpgMakerAssetKey, RpgMakerAssetXor, Xor,
        };
        use PatchBackTransform::{RepackArchive, Unsupported};
        use SurfaceTransform::{ArchiveEntry, BinaryOffset};
        let spec = match self {
            Self::Siglus => EngineProfileSpec {
                container: ContainerTransform::SiglusPck,
                allowed_crypto: &[FixedKey, KeyProfile, HelperGated],
                allowed_codec: &[Utf16Text, ShiftJisText, BinaryTable],
                allowed_surface: &[ArchiveEntry, BinaryOffset],
                allowed_patch_back: &[RepackArchive],
                key_required: true,
                capability_ceiling: CapabilityLevel::Patch,
                media_transform: false,
            },
            Self::KirikiriXp3 => EngineProfileSpec {
                container: ContainerTransform::Xp3,
                allowed_crypto: &[NullKey, Xor, KeyProfile, HelperGated],
                allowed_codec: &[Utf16Text, ShiftJisText, Utf8Text],
                allowed_surface: &[ArchiveEntry],
                allowed_patch_back: &[RepackArchive],
                key_required: false,
                capability_ceiling: CapabilityLevel::Patch,
                media_transform: false,
            },
            Self::Wolf => EngineProfileSpec {
                container: ContainerTransform::WolfArchive,
                allowed_crypto: &[NullKey, Xor, FixedKey, HelperGated],
                allowed_codec: &[ShiftJisText, Utf8Text, BinaryTable],
                allowed_surface: &[ArchiveEntry, BinaryOffset],
                allowed_patch_back: &[RepackArchive],
                key_required: false,
                capability_ceiling: CapabilityLevel::Patch,
                media_transform: false,
            },
            Self::Rgss3 => EngineProfileSpec {
                container: ContainerTransform::Rgssad,
                allowed_crypto: &[Xor, FixedKey],
                allowed_codec: &[RubyMarshal, Utf8Text, BinaryTable],
                allowed_surface: &[ArchiveEntry, BinaryOffset],
                allowed_patch_back: &[RepackArchive],
                key_required: true,
                capability_ceiling: CapabilityLevel::Patch,
                media_transform: false,
            },
            Self::Bgi => EngineProfileSpec {
                container: ContainerTransform::Archive,
                allowed_crypto: &[NullKey, FixedKey, Xor],
                allowed_codec: &[ShiftJisText, BinaryTable, BytecodeDecompile],
                allowed_surface: &[ArchiveEntry, BinaryOffset],
                allowed_patch_back: &[RepackArchive],
                key_required: false,
                capability_ceiling: CapabilityLevel::Patch,
                media_transform: false,
            },
            // MV/MZ encrypted media: recognized container + asset XOR crypto +
            // a media codec, but the media transform is unsupported for text
            // extraction (mirrors 's hard non-extractable pin), so the
            // capability ceiling is `identify` only.
            Self::RpgMakerMvMzMedia => EngineProfileSpec {
                container: ContainerTransform::ProjectAsset,
                allowed_crypto: &[RpgMakerAssetXor, RpgMakerAssetKey],
                allowed_codec: &[PngImage, M4aAudio, OggAudio],
                allowed_surface: &[BinaryOffset],
                allowed_patch_back: &[Unsupported],
                key_required: true,
                capability_ceiling: CapabilityLevel::Identify,
                media_transform: true,
            },
            Self::Unknown => return None,
        };
        Some(spec)
    }
}

/// The mechanical per-engine transform / capability spec. All fields are
/// closed sets; a profile leg outside the set is a structured inconsistency.
#[derive(Debug, Clone, Copy)]
pub struct EngineProfileSpec {
    pub container: ContainerTransform,
    pub allowed_crypto: &'static [CryptoTransform],
    pub allowed_codec: &'static [CodecTransform],
    pub allowed_surface: &'static [SurfaceTransform],
    pub allowed_patch_back: &'static [PatchBackTransform],
    pub key_required: bool,
    pub capability_ceiling: CapabilityLevel,
    /// `true` when the engine's layered transform is a media-asset transform
    /// that is recognized but unsupported for text extraction.
    pub media_transform: bool,
}

/// True iff `codec` is an encrypted/binary media codec (image or audio). A
/// packed text engine must never carry one; the MV/MZ encrypted-media family
/// always does. (Mirrors `mv_mz_readiness::is_media_codec`.)
pub fn is_media_codec(codec: CodecTransform) -> bool {
    matches!(
        codec,
        CodecTransform::PngImage | CodecTransform::M4aAudio | CodecTransform::OggAudio
    )
}
