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

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::{
    CapabilityLevel, CodecTransform, ContainerTransform, CryptoTransform, KaifuuResult,
    LayeredAccessHelperStatus, LayeredAccessKeyMaterialStatus, OperationStatus,
    PartialDiagnosticSeverity, PatchBackTransform, ProofHash, SecretRef, SemanticErrorCode,
    SurfaceTransform, read_json, redact_for_log_or_report, sha256_hash_bytes, stable_json,
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

// Profile input schema

/// A reusable packed-engine readiness profile fixture.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackedEngineReadinessProfile {
    pub schema_version: String,
    /// Stable profile id (synthetic; no retail names or local paths).
    pub profile_id: String,
    /// Stable fixture id this profile is derived from.
    pub fixture_id: String,
    /// The spec-DAG node id this profile is authored for (e.g. ``).
    pub source_node_id: String,
    pub engine_family: PackedEngineFamily,
    pub container: ContainerTransform,
    pub crypto: CryptoTransform,
    pub codec: CodecTransform,
    pub surface: SurfaceTransform,
    pub patch_back: PatchBackTransform,
    /// The capability posture this profile declares it is ready for.
    pub declared_capability: CapabilityLevel,
    pub key: PackedKeyRequirement,
    pub helper: PackedHelperRequirement,
    /// Synthetic packed-asset content descriptors (hash-only, never bytes).
    pub content: Vec<PackedContentEntry>,
    /// Declared content hash over the canonical serialization of `content`.
    /// The validator recomputes and compares.
    pub content_hash: ProofHash,
}

/// Key-material gating for the profile.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackedKeyRequirement {
    pub status: LayeredAccessKeyMaterialStatus,
    /// Local-scheme reference to the key material (never raw key bytes).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_ref: Option<SecretRef>,
    /// Stable id of the key requirement (cross-references helper evidence).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requirement_id: Option<String>,
}

/// Helper gating for the profile.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackedHelperRequirement {
    pub status: LayeredAccessHelperStatus,
    /// Stable id of the helper (never a local path / binary).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helper_id: Option<String>,
}

/// One synthetic packed-asset content descriptor.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackedContentEntry {
    pub asset_id: String,
    pub byte_count: u64,
    pub content_sha256: ProofHash,
}

/// Recompute the canonical content hash over `content` (sorted by `assetId`).
/// Deterministic and pure; no disk access.
pub fn recompute_content_hash(content: &[PackedContentEntry]) -> KaifuuResult<ProofHash> {
    let mut sorted = content.to_vec();
    sorted.sort();
    let canonical = stable_json(&sorted)?;
    ProofHash::new(sha256_hash_bytes(canonical.as_bytes())).map_err(Into::into)
}

// Outcome + posture (the mechanical line)

/// The mechanically-derived outcome of a packed-engine readiness profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PackedReadinessOutcome {
    /// Profile-ready postures (gates clear).
    Identify,
    Inventory,
    Extract,
    Patch,
    /// Readiness-only postures (gated).
    HelperRequired,
    MissingKey,
    UnsupportedLayeredTransform,
}

impl PackedReadinessOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Identify => "identify",
            Self::Inventory => "inventory",
            Self::Extract => "extract",
            Self::Patch => "patch",
            Self::HelperRequired => "helper_required",
            Self::MissingKey => "missing_key",
            Self::UnsupportedLayeredTransform => "unsupported_layered_transform",
        }
    }

    /// THE mechanical gate: a profile-ready outcome is one of the four
    /// capability rungs; every readiness-only outcome returns `false` and can
    /// therefore never present a resolved extract/patch capability.
    pub fn is_profile_ready(self) -> bool {
        matches!(
            self,
            Self::Identify | Self::Inventory | Self::Extract | Self::Patch
        )
    }

    /// The posture bucket for this outcome.
    pub fn posture(self) -> PackedReadinessPosture {
        if self.is_profile_ready() {
            PackedReadinessPosture::ProfileReady
        } else {
            PackedReadinessPosture::ReadinessOnly
        }
    }
}

/// The two mechanically-distinct postures (mirrors ALPHA-004's claimed-vs-
/// readiness distinction).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PackedReadinessPosture {
    ProfileReady,
    ReadinessOnly,
}

impl PackedReadinessPosture {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ProfileReady => "profile_ready",
            Self::ReadinessOnly => "readiness_only",
        }
    }
}

/// THE single source of truth for the profile-ready-vs-readiness-only line.
/// A profile resolves to a capability rung (`identify`/`inventory`/`extract`/
/// `patch`, capped at the engine ceiling) **if and only if** the layered
/// transform is supported (no media-asset transform), the key material is
/// resolved (or not required), and the helper is available (or not required).
/// Any media transform, missing/helper-gated key, or unavailable helper
/// collapses to the corresponding readiness-only outcome. Total and
/// side-effect-free.
pub fn derive_packed_readiness_outcome(
    spec: &EngineProfileSpec,
    declared_capability: CapabilityLevel,
    codec: CodecTransform,
    key_status: LayeredAccessKeyMaterialStatus,
    helper_status: LayeredAccessHelperStatus,
) -> PackedReadinessOutcome {
    if spec.media_transform || is_media_codec(codec) {
        return PackedReadinessOutcome::UnsupportedLayeredTransform;
    }
    match key_status {
        LayeredAccessKeyMaterialStatus::Missing => return PackedReadinessOutcome::MissingKey,
        LayeredAccessKeyMaterialStatus::HelperGated => {
            return PackedReadinessOutcome::HelperRequired;
        }
        LayeredAccessKeyMaterialStatus::Resolved | LayeredAccessKeyMaterialStatus::NotRequired => {}
    }
    if helper_status == LayeredAccessHelperStatus::Unavailable {
        return PackedReadinessOutcome::HelperRequired;
    }
    // Gates clear: resolve to the declared rung, capped at the engine ceiling.
    let level = declared_capability.min(spec.capability_ceiling);
    match level {
        CapabilityLevel::Identify => PackedReadinessOutcome::Identify,
        CapabilityLevel::Inventory => PackedReadinessOutcome::Inventory,
        CapabilityLevel::Extract => PackedReadinessOutcome::Extract,
        CapabilityLevel::Patch => PackedReadinessOutcome::Patch,
    }
}

// Findings + report

/// A structured validation finding — never prose, never silent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackedReadinessFinding {
    pub code: String,
    pub severity: PartialDiagnosticSeverity,
    pub field: String,
    pub message: String,
    pub semantic_code: String,
}

impl PackedReadinessFinding {
    fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            severity: self.severity,
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
            semantic_code: self.semantic_code.clone(),
        }
    }
}

/// The shared transform stack as recorded in the report.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackedTransformStack {
    pub container: ContainerTransform,
    pub crypto: CryptoTransform,
    pub codec: CodecTransform,
    pub surface: SurfaceTransform,
    pub patch_back: PatchBackTransform,
}

/// Per-profile report entry. Carries the full acceptance tuple: profile id,
/// fixture id, capability levels, helper id, key ref, diagnostics, and hashes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackedReadinessEntryReport {
    pub profile_id: String,
    pub fixture_id: String,
    pub source_node_id: String,
    pub engine_family: PackedEngineFamily,
    pub transform_stack: PackedTransformStack,
    pub declared_capability: CapabilityLevel,
    /// Mechanically-derived outcome (the single source of truth).
    pub effective_outcome: PackedReadinessOutcome,
    /// The mechanically-distinct posture bucket.
    pub posture: PackedReadinessPosture,
    pub key_status: LayeredAccessKeyMaterialStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_ref: Option<SecretRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_requirement_id: Option<String>,
    pub helper_status: LayeredAccessHelperStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helper_id: Option<String>,
    pub content_hash: ProofHash,
    pub content_entry_count: u64,
    pub status: OperationStatus,
    pub findings: Vec<PackedReadinessFinding>,
}

impl PackedReadinessEntryReport {
    fn redacted_for_report(&self) -> Self {
        Self {
            profile_id: redact_for_log_or_report(&self.profile_id),
            fixture_id: redact_for_log_or_report(&self.fixture_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            engine_family: self.engine_family,
            transform_stack: self.transform_stack,
            declared_capability: self.declared_capability,
            effective_outcome: self.effective_outcome,
            posture: self.posture,
            key_status: self.key_status,
            key_ref: self.key_ref.clone(),
            key_requirement_id: self
                .key_requirement_id
                .as_deref()
                .map(redact_for_log_or_report),
            helper_status: self.helper_status,
            helper_id: self.helper_id.as_deref().map(redact_for_log_or_report),
            content_hash: self.content_hash.clone(),
            content_entry_count: self.content_entry_count,
            status: self.status.clone(),
            findings: self
                .findings
                .iter()
                .map(PackedReadinessFinding::redacted_for_report)
                .collect(),
        }
    }
}

/// The aggregate validation report written to
/// `target/kaifuu/packed-readiness-validation.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackedReadinessValidationReport {
    pub schema_version: String,
    pub support_boundary: String,
    pub status: OperationStatus,
    pub profile_count: u64,
    pub profile_ready_count: u64,
    pub readiness_only_count: u64,
    pub entries: Vec<PackedReadinessEntryReport>,
}

impl PackedReadinessValidationReport {
    pub fn entry(&self, profile_id: &str) -> Option<&PackedReadinessEntryReport> {
        self.entries
            .iter()
            .find(|entry| entry.profile_id == profile_id)
    }

    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            status: self.status.clone(),
            profile_count: self.profile_count,
            profile_ready_count: self.profile_ready_count,
            readiness_only_count: self.readiness_only_count,
            entries: self
                .entries
                .iter()
                .map(PackedReadinessEntryReport::redacted_for_report)
                .collect(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

// Validator

fn finding(
    code: &str,
    severity: PartialDiagnosticSeverity,
    field: &str,
    message: String,
    semantic_code: SemanticErrorCode,
) -> PackedReadinessFinding {
    PackedReadinessFinding {
        code: code.to_string(),
        severity,
        field: field.to_string(),
        message,
        semantic_code: semantic_code.as_str().to_string(),
    }
}

/// Validate a single packed-engine readiness profile, producing one structured
/// report entry. Every inconsistency is a structured finding; this never
/// panics and never returns `Err`.
pub fn validate_packed_engine_readiness_profile(
    profile: &PackedEngineReadinessProfile,
) -> PackedReadinessEntryReport {
    let mut findings: Vec<PackedReadinessFinding> = Vec::new();

    if profile.schema_version != PACKED_ENGINE_READINESS_SCHEMA_VERSION {
        findings.push(finding(
            "packed.readiness.schema_version_mismatch",
            PartialDiagnosticSeverity::P1,
            "schemaVersion",
            format!(
                "profile declared schemaVersion {} but validator expects {}",
                profile.schema_version, PACKED_ENGINE_READINESS_SCHEMA_VERSION
            ),
            SemanticErrorCode::UnsupportedEngineVariant,
        ));
    }
    if profile.profile_id.trim().is_empty() {
        findings.push(finding(
            "packed.readiness.profile_id_missing",
            PartialDiagnosticSeverity::P0,
            "profileId",
            "profile is missing a non-empty profileId".to_string(),
            SemanticErrorCode::UnknownEngineVariant,
        ));
    }
    if profile.fixture_id.trim().is_empty() {
        findings.push(finding(
            "packed.readiness.fixture_id_missing",
            PartialDiagnosticSeverity::P0,
            "fixtureId",
            "profile is missing a non-empty fixtureId".to_string(),
            SemanticErrorCode::UnknownEngineVariant,
        ));
    }

    let Some(spec) = profile.engine_family.profile_spec() else {
        findings.push(finding(
            "packed.readiness.unknown_engine_family",
            PartialDiagnosticSeverity::P0,
            "engineFamily",
            "engineFamily is unknown / unrecognized".to_string(),
            SemanticErrorCode::UnknownEngineVariant,
        ));
        return build_entry(
            profile,
            None,
            PackedReadinessOutcome::UnsupportedLayeredTransform,
            findings,
        );
    };

    if profile.container != spec.container {
        findings.push(finding(
            "packed.readiness.out_of_profile_container",
            PartialDiagnosticSeverity::P0,
            "container",
            format!(
                "engine {} requires container {:?} but profile declared {:?}",
                profile.engine_family.as_str(),
                spec.container,
                profile.container
            ),
            if profile.container == ContainerTransform::Unknown {
                SemanticErrorCode::MissingContainerCapability
            } else {
                SemanticErrorCode::UnsupportedVariantPacked
            },
        ));
    }
    if !spec.allowed_crypto.contains(&profile.crypto) {
        findings.push(finding(
            "packed.readiness.unsupported_crypto",
            PartialDiagnosticSeverity::P0,
            "crypto",
            format!(
                "engine {} does not support crypto {:?}",
                profile.engine_family.as_str(),
                profile.crypto
            ),
            SemanticErrorCode::MissingCryptoCapability,
        ));
    }
    if !spec.allowed_codec.contains(&profile.codec) {
        findings.push(finding(
            "packed.readiness.unsupported_codec",
            PartialDiagnosticSeverity::P0,
            "codec",
            format!(
                "engine {} does not support codec {:?}",
                profile.engine_family.as_str(),
                profile.codec
            ),
            SemanticErrorCode::MissingCodecCapability,
        ));
    }
    if !spec.allowed_surface.contains(&profile.surface) {
        findings.push(finding(
            "packed.readiness.unsupported_surface",
            PartialDiagnosticSeverity::P0,
            "surface",
            format!(
                "engine {} does not support surface {:?}",
                profile.engine_family.as_str(),
                profile.surface
            ),
            SemanticErrorCode::UnsupportedLayeredTransform,
        ));
    }
    if !spec.allowed_patch_back.contains(&profile.patch_back) {
        findings.push(finding(
            "packed.readiness.unsupported_patch_back",
            PartialDiagnosticSeverity::P0,
            "patchBack",
            format!(
                "engine {} does not support patch-back {:?}",
                profile.engine_family.as_str(),
                profile.patch_back
            ),
            SemanticErrorCode::MissingPatchBackCapability,
        ));
    }

    if profile.declared_capability > spec.capability_ceiling {
        findings.push(finding(
            "packed.readiness.capability_overclaim",
            PartialDiagnosticSeverity::P0,
            "declaredCapability",
            format!(
                "engine {} ceiling is {} but profile declared {}",
                profile.engine_family.as_str(),
                spec.capability_ceiling.as_str(),
                profile.declared_capability.as_str()
            ),
            SemanticErrorCode::UnsupportedVariantPacked,
        ));
    }

    validate_key(profile, &spec, &mut findings);

    validate_helper(profile, &mut findings);

    if profile.content.is_empty() {
        findings.push(finding(
            "packed.readiness.content_missing",
            PartialDiagnosticSeverity::P1,
            "content",
            "profile declares no synthetic content descriptors".to_string(),
            SemanticErrorCode::UnsupportedEngineVariant,
        ));
    }
    match recompute_content_hash(&profile.content) {
        Ok(recomputed) => {
            if recomputed.as_str() != profile.content_hash.as_str() {
                findings.push(finding(
                    "packed.readiness.content_hash_mismatch",
                    PartialDiagnosticSeverity::P0,
                    "contentHash",
                    "declared contentHash does not match the recomputed content hash".to_string(),
                    SemanticErrorCode::UnsupportedEngineVariant,
                ));
            }
        }
        Err(error) => findings.push(finding(
            "packed.readiness.content_hash_uncomputable",
            PartialDiagnosticSeverity::P0,
            "contentHash",
            redact_for_log_or_report(&error.to_string()),
            SemanticErrorCode::UnsupportedEngineVariant,
        )),
    }

    let outcome = derive_packed_readiness_outcome(
        &spec,
        profile.declared_capability,
        profile.codec,
        profile.key.status,
        profile.helper.status,
    );

    build_entry(profile, Some(spec), outcome, findings)
}

fn validate_key(
    profile: &PackedEngineReadinessProfile,
    spec: &EngineProfileSpec,
    findings: &mut Vec<PackedReadinessFinding>,
) {
    let status = profile.key.status;
    let has_ref = profile.key.key_ref.is_some() || profile.key.requirement_id.is_some();

    if spec.key_required && status == LayeredAccessKeyMaterialStatus::NotRequired {
        findings.push(finding(
            "packed.readiness.key_required_but_not_declared",
            PartialDiagnosticSeverity::P0,
            "key.status",
            format!(
                "engine {} requires key material but the profile declares keyStatus not_required",
                profile.engine_family.as_str()
            ),
            SemanticErrorCode::MissingKeyMaterial,
        ));
    }
    // A gated/resolved key must reference WHICH key it is (ref or requirement
    // id) — a missing key with no reference is itself an inconsistency.
    if matches!(
        status,
        LayeredAccessKeyMaterialStatus::Missing
            | LayeredAccessKeyMaterialStatus::Resolved
            | LayeredAccessKeyMaterialStatus::HelperGated
    ) && !has_ref
    {
        findings.push(finding(
            "packed.readiness.key_ref_missing",
            PartialDiagnosticSeverity::P0,
            "key.keyRef",
            format!("keyStatus {status:?} requires a keyRef or requirementId reference"),
            SemanticErrorCode::MissingKeyMaterial,
        ));
    }
    // A resolved key must carry the actual key reference.
    if status == LayeredAccessKeyMaterialStatus::Resolved && profile.key.key_ref.is_none() {
        findings.push(finding(
            "packed.readiness.resolved_key_without_ref",
            PartialDiagnosticSeverity::P0,
            "key.keyRef",
            "resolved key material must carry a keyRef".to_string(),
            SemanticErrorCode::MissingKeyMaterial,
        ));
    }
    // A not-required key must not carry a reference.
    if status == LayeredAccessKeyMaterialStatus::NotRequired
        && (profile.key.key_ref.is_some() || profile.key.requirement_id.is_some())
    {
        findings.push(finding(
            "packed.readiness.unexpected_key_ref",
            PartialDiagnosticSeverity::P1,
            "key.keyRef",
            "keyStatus not_required must not carry a keyRef / requirementId".to_string(),
            SemanticErrorCode::MissingKeyMaterial,
        ));
    }
}

fn validate_helper(
    profile: &PackedEngineReadinessProfile,
    findings: &mut Vec<PackedReadinessFinding>,
) {
    let status = profile.helper.status;
    let has_id = profile.helper.helper_id.is_some();

    // Helper-gated crypto must declare a required (available/unavailable)
    // helper, never not_required.
    if profile.crypto == CryptoTransform::HelperGated
        && status == LayeredAccessHelperStatus::NotRequired
    {
        findings.push(finding(
            "packed.readiness.helper_gated_crypto_without_helper",
            PartialDiagnosticSeverity::P0,
            "helper.status",
            "helper_gated crypto requires a helper but helperStatus is not_required".to_string(),
            SemanticErrorCode::HelperRequired,
        ));
    }
    // A helper-gated key likewise requires a helper.
    if profile.key.status == LayeredAccessKeyMaterialStatus::HelperGated
        && status == LayeredAccessHelperStatus::NotRequired
    {
        findings.push(finding(
            "packed.readiness.helper_gated_key_without_helper",
            PartialDiagnosticSeverity::P0,
            "helper.status",
            "helper_gated key material requires a helper but helperStatus is not_required"
                .to_string(),
            SemanticErrorCode::HelperRequired,
        ));
    }
    // A required helper (available/unavailable) must name WHICH helper.
    if matches!(
        status,
        LayeredAccessHelperStatus::Available | LayeredAccessHelperStatus::Unavailable
    ) && !has_id
    {
        findings.push(finding(
            "packed.readiness.helper_id_missing",
            PartialDiagnosticSeverity::P0,
            "helper.helperId",
            format!("helperStatus {status:?} requires a helperId"),
            SemanticErrorCode::HelperRequired,
        ));
    }
    // A not-required helper must not name a helper.
    if status == LayeredAccessHelperStatus::NotRequired && has_id {
        findings.push(finding(
            "packed.readiness.unexpected_helper_id",
            PartialDiagnosticSeverity::P1,
            "helper.helperId",
            "helperStatus not_required must not carry a helperId".to_string(),
            SemanticErrorCode::HelperRequired,
        ));
    }
}

fn build_entry(
    profile: &PackedEngineReadinessProfile,
    _spec: Option<EngineProfileSpec>,
    outcome: PackedReadinessOutcome,
    findings: Vec<PackedReadinessFinding>,
) -> PackedReadinessEntryReport {
    let status = if findings.iter().any(|f| f.severity.is_blocking()) {
        OperationStatus::Failed
    } else {
        OperationStatus::Passed
    };
    PackedReadinessEntryReport {
        profile_id: profile.profile_id.clone(),
        fixture_id: profile.fixture_id.clone(),
        source_node_id: profile.source_node_id.clone(),
        engine_family: profile.engine_family,
        transform_stack: PackedTransformStack {
            container: profile.container,
            crypto: profile.crypto,
            codec: profile.codec,
            surface: profile.surface,
            patch_back: profile.patch_back,
        },
        declared_capability: profile.declared_capability,
        effective_outcome: outcome,
        posture: outcome.posture(),
        key_status: profile.key.status,
        key_ref: profile.key.key_ref.clone(),
        key_requirement_id: profile.key.requirement_id.clone(),
        helper_status: profile.helper.status,
        helper_id: profile.helper.helper_id.clone(),
        content_hash: profile.content_hash.clone(),
        content_entry_count: profile.content.len() as u64,
        status,
        findings,
    }
}

/// Read every `*.profile.json` fixture under `dir` (sorted by file name),
/// validate each, and aggregate one [`PackedReadinessValidationReport`]. A
/// malformed fixture becomes a failed entry, never a hard error.
pub fn validate_packed_engine_readiness_dir(
    dir: &Path,
) -> KaifuuResult<PackedReadinessValidationReport> {
    let mut files: Vec<std::path::PathBuf> = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_file()
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".profile.json"))
        {
            files.push(path);
        }
    }
    files.sort();

    let mut entries = Vec::with_capacity(files.len());
    for path in &files {
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("<unknown>");
        match read_json::<PackedEngineReadinessProfile>(path) {
            Ok(profile) => entries.push(validate_packed_engine_readiness_profile(&profile)),
            Err(error) => entries.push(malformed_entry(file_name, &error.to_string())),
        }
    }

    let profile_ready_count = entries
        .iter()
        .filter(|entry| entry.posture == PackedReadinessPosture::ProfileReady)
        .count() as u64;
    let readiness_only_count = entries
        .iter()
        .filter(|entry| entry.posture == PackedReadinessPosture::ReadinessOnly)
        .count() as u64;
    let status = if entries
        .iter()
        .all(|entry| matches!(entry.status, OperationStatus::Passed))
    {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };

    Ok(PackedReadinessValidationReport {
        schema_version: PACKED_READINESS_REPORT_SCHEMA_VERSION.to_string(),
        support_boundary: PACKED_ENGINE_READINESS_SUPPORT_BOUNDARY.to_string(),
        status,
        profile_count: entries.len() as u64,
        profile_ready_count,
        readiness_only_count,
        entries,
    })
}

fn malformed_entry(file_name: &str, error: &str) -> PackedReadinessEntryReport {
    let placeholder_hash = ProofHash::new(sha256_hash_bytes(&[]))
        .unwrap_or_else(|_| unreachable!("empty sha256 is a valid proof hash"));
    PackedReadinessEntryReport {
        profile_id: format!("{file_name}-unparseable"),
        fixture_id: file_name.to_string(),
        source_node_id: "KAIFUU-103".to_string(),
        engine_family: PackedEngineFamily::Unknown,
        transform_stack: PackedTransformStack {
            container: ContainerTransform::Unknown,
            crypto: CryptoTransform::Unknown,
            codec: CodecTransform::Unknown,
            surface: SurfaceTransform::Unknown,
            patch_back: PatchBackTransform::Unknown,
        },
        declared_capability: CapabilityLevel::Identify,
        effective_outcome: PackedReadinessOutcome::UnsupportedLayeredTransform,
        posture: PackedReadinessPosture::ReadinessOnly,
        key_status: LayeredAccessKeyMaterialStatus::NotRequired,
        key_ref: None,
        key_requirement_id: None,
        helper_status: LayeredAccessHelperStatus::NotRequired,
        helper_id: None,
        content_hash: placeholder_hash,
        content_entry_count: 0,
        status: OperationStatus::Failed,
        findings: vec![finding(
            "packed.readiness.fixture_unparseable",
            PartialDiagnosticSeverity::P0,
            "fixture",
            format!(
                "profile fixture could not be parsed: {}",
                redact_for_log_or_report(error)
            ),
            SemanticErrorCode::UnknownEngineVariant,
        )],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixtures_dir() -> PathBuf {
        crate::test_manifest_dir()
            .join("../..")
            .join("fixtures/kaifuu/packed-engine")
    }

    fn negative_dir() -> PathBuf {
        fixtures_dir().join("negative")
    }

    fn load(name: &str) -> PackedEngineReadinessProfile {
        read_json(&fixtures_dir().join(name)).unwrap_or_else(|e| panic!("load {name}: {e}"))
    }

    fn load_negative(name: &str) -> PackedEngineReadinessProfile {
        read_json(&negative_dir().join(name))
            .unwrap_or_else(|e| panic!("load negative {name}: {e}"))
    }

    #[test]
    fn gated_states_can_never_be_profile_ready() {
        for family in PackedEngineFamily::recognized() {
            let spec = family.profile_spec().unwrap();
            let codec = *spec.allowed_codec.first().unwrap();
            for declared in CapabilityLevel::all() {
                // Every gated state is non-profile-ready for EVERY family.
                for (key, helper) in [
                    (
                        LayeredAccessKeyMaterialStatus::Missing,
                        LayeredAccessHelperStatus::NotRequired,
                    ),
                    (
                        LayeredAccessKeyMaterialStatus::HelperGated,
                        LayeredAccessHelperStatus::Available,
                    ),
                    (
                        LayeredAccessKeyMaterialStatus::NotRequired,
                        LayeredAccessHelperStatus::Unavailable,
                    ),
                ] {
                    let out = derive_packed_readiness_outcome(&spec, declared, codec, key, helper);
                    assert!(
                        !out.is_profile_ready(),
                        "{} gated state {key:?}/{helper:?} must not be profile-ready",
                        family.as_str()
                    );
                }

                // For the non-media text engines the exact readiness outcome
                // is pinned (the media family short-circuits earlier — covered
                // by `media_transform_is_never_profile_ready`).
                if !spec.media_transform {
                    assert_eq!(
                        derive_packed_readiness_outcome(
                            &spec,
                            declared,
                            codec,
                            LayeredAccessKeyMaterialStatus::Missing,
                            LayeredAccessHelperStatus::NotRequired,
                        ),
                        PackedReadinessOutcome::MissingKey
                    );
                    assert_eq!(
                        derive_packed_readiness_outcome(
                            &spec,
                            declared,
                            codec,
                            LayeredAccessKeyMaterialStatus::HelperGated,
                            LayeredAccessHelperStatus::Available,
                        ),
                        PackedReadinessOutcome::HelperRequired
                    );
                    assert_eq!(
                        derive_packed_readiness_outcome(
                            &spec,
                            declared,
                            codec,
                            LayeredAccessKeyMaterialStatus::NotRequired,
                            LayeredAccessHelperStatus::Unavailable,
                        ),
                        PackedReadinessOutcome::HelperRequired
                    );
                }
            }
        }
    }

    #[test]
    fn media_transform_is_never_profile_ready() {
        let spec = PackedEngineFamily::RpgMakerMvMzMedia
            .profile_spec()
            .unwrap();
        for declared in CapabilityLevel::all() {
            let out = derive_packed_readiness_outcome(
                &spec,
                declared,
                CodecTransform::PngImage,
                LayeredAccessKeyMaterialStatus::Resolved,
                LayeredAccessHelperStatus::NotRequired,
            );
            assert_eq!(out, PackedReadinessOutcome::UnsupportedLayeredTransform);
            assert!(!out.is_profile_ready());
        }
    }

    #[test]
    fn resolved_gates_reach_the_declared_rung_capped_at_ceiling() {
        let spec = PackedEngineFamily::Siglus.profile_spec().unwrap();
        assert_eq!(
            derive_packed_readiness_outcome(
                &spec,
                CapabilityLevel::Patch,
                CodecTransform::Utf16Text,
                LayeredAccessKeyMaterialStatus::Resolved,
                LayeredAccessHelperStatus::NotRequired,
            ),
            PackedReadinessOutcome::Patch
        );
        assert_eq!(
            derive_packed_readiness_outcome(
                &spec,
                CapabilityLevel::Inventory,
                CodecTransform::Utf16Text,
                LayeredAccessKeyMaterialStatus::Resolved,
                LayeredAccessHelperStatus::NotRequired,
            ),
            PackedReadinessOutcome::Inventory
        );
    }

    #[test]
    fn positive_fixture_dir_is_green_and_covers_all_outcomes() {
        use PackedReadinessOutcome::{
            Extract, HelperRequired, Identify, Inventory, MissingKey, Patch,
            UnsupportedLayeredTransform,
        };
        let report = validate_packed_engine_readiness_dir(&fixtures_dir())
            .expect("validation runs without environmental error");
        assert_eq!(
            report.status,
            OperationStatus::Passed,
            "entries: {:?}",
            report
                .entries
                .iter()
                .filter(|e| e.status == OperationStatus::Failed)
                .map(|e| (e.profile_id.clone(), e.findings.clone()))
                .collect::<Vec<_>>()
        );
        for entry in &report.entries {
            assert_eq!(entry.source_node_id, "KAIFUU-103");
            assert!(!entry.fixture_id.is_empty());
        }
        // Every one of the seven outcomes appears at least once.
        for outcome in [
            Identify,
            Inventory,
            Extract,
            Patch,
            HelperRequired,
            MissingKey,
            UnsupportedLayeredTransform,
        ] {
            assert!(
                report
                    .entries
                    .iter()
                    .any(|e| e.effective_outcome == outcome),
                "no entry produced outcome {}",
                outcome.as_str()
            );
        }
        // Both postures are populated and counted consistently.
        assert!(report.profile_ready_count > 0);
        assert!(report.readiness_only_count > 0);
        assert_eq!(
            report.profile_ready_count + report.readiness_only_count,
            report.profile_count
        );
    }

    #[test]
    fn every_recognized_engine_has_a_positive_fixture() {
        let report = validate_packed_engine_readiness_dir(&fixtures_dir()).unwrap();
        for family in PackedEngineFamily::recognized() {
            assert!(
                report.entries.iter().any(|e| e.engine_family == family),
                "no positive fixture for {}",
                family.as_str()
            );
        }
    }

    fn has_code(entry: &PackedReadinessEntryReport, code: &str) -> bool {
        entry.findings.iter().any(|f| f.code == code)
    }

    #[test]
    fn negative_missing_helper_fails() {
        let entry = validate_packed_engine_readiness_profile(&load_negative(
            "wolf-missing-helper.profile.json",
        ));
        assert_eq!(entry.status, OperationStatus::Failed);
        assert!(has_code(&entry, "packed.readiness.helper_id_missing"));
    }

    #[test]
    fn negative_missing_key_fails() {
        let entry = validate_packed_engine_readiness_profile(&load_negative(
            "rgss3-missing-key.profile.json",
        ));
        assert_eq!(entry.status, OperationStatus::Failed);
        assert!(has_code(
            &entry,
            "packed.readiness.key_required_but_not_declared"
        ));
    }

    #[test]
    fn negative_unsupported_codec_fails() {
        let entry = validate_packed_engine_readiness_profile(&load_negative(
            "siglus-unsupported-codec.profile.json",
        ));
        assert_eq!(entry.status, OperationStatus::Failed);
        assert!(has_code(&entry, "packed.readiness.unsupported_codec"));
    }

    #[test]
    fn negative_hash_mismatch_fails() {
        let entry = validate_packed_engine_readiness_profile(&load_negative(
            "bgi-hash-mismatch.profile.json",
        ));
        assert_eq!(entry.status, OperationStatus::Failed);
        assert!(has_code(&entry, "packed.readiness.content_hash_mismatch"));
    }

    #[test]
    fn negative_out_of_profile_container_fails() {
        let entry = validate_packed_engine_readiness_profile(&load_negative(
            "kirikiri-xp3-out-of-profile.profile.json",
        ));
        assert_eq!(entry.status, OperationStatus::Failed);
        assert!(has_code(
            &entry,
            "packed.readiness.out_of_profile_container"
        ));
    }

    #[test]
    fn negative_capability_overclaim_fails() {
        let entry = validate_packed_engine_readiness_profile(&load_negative(
            "mv-mz-media-overclaim.profile.json",
        ));
        assert_eq!(entry.status, OperationStatus::Failed);
        assert!(has_code(&entry, "packed.readiness.capability_overclaim"));
    }

    #[test]
    fn negative_dir_report_is_failed() {
        let report = validate_packed_engine_readiness_dir(&negative_dir())
            .expect("negative dir validates without environmental error");
        assert_eq!(report.status, OperationStatus::Failed);
        assert!(
            report
                .entries
                .iter()
                .all(|e| e.status == OperationStatus::Failed)
        );
    }

    #[test]
    fn report_round_trips_and_carries_acceptance_tuple() {
        let report = validate_packed_engine_readiness_dir(&fixtures_dir()).unwrap();
        let json = report.stable_json().expect("stable json");
        assert!(json.ends_with('\n'));
        let parsed: PackedReadinessValidationReport =
            serde_json::from_str(&json).expect("round trip");
        // Spot-check that the acceptance tuple survives serialization.
        let entry = parsed
            .entries
            .iter()
            .find(|e| e.posture == PackedReadinessPosture::ProfileReady)
            .unwrap();
        assert!(!entry.profile_id.is_empty());
        assert!(!entry.fixture_id.is_empty());
        assert!(entry.content_hash.as_str().starts_with("sha256:"));
    }

    #[test]
    fn report_redacts_path_bearing_ids() {
        let mut profile = load("siglus.positive.profile.json");
        profile.profile_id = "/home/trevor/private/leak.pck".to_string();
        let entry = validate_packed_engine_readiness_profile(&profile);
        let report = PackedReadinessValidationReport {
            schema_version: PACKED_READINESS_REPORT_SCHEMA_VERSION.to_string(),
            support_boundary: PACKED_ENGINE_READINESS_SUPPORT_BOUNDARY.to_string(),
            status: entry.status.clone(),
            profile_count: 1,
            profile_ready_count: 1,
            readiness_only_count: 0,
            entries: vec![entry],
        };
        let json = report.stable_json().unwrap();
        assert!(!json.contains("/home/trevor/private/leak.pck"));
        assert!(json.contains("[REDACTED:"));
    }

    #[test]
    fn content_hash_recompute_is_order_independent() {
        let mut profile = load("siglus.positive.profile.json");
        profile.content.reverse();
        let recomputed = recompute_content_hash(&profile.content).unwrap();
        assert_eq!(recomputed.as_str(), profile.content_hash.as_str());
    }
}
