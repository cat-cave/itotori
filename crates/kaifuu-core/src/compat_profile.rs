//! Claimed-support compatibility profile schema.
//! This module formalizes, HONESTLY, how kaifuu declares its compatibility
//! claims across *all* engine families in one versioned schema — the
//! **claimed-support tuple**. Where the per-family readiness validators pin one
//! engine each ([`crate::xp3_capability_profile`]
//! [`crate::mv_mz_readiness`], [`crate::packed_engine_readiness`]
//! ALPHA-004 [`crate::alpha_encrypted_readiness`]) and the
//! [`crate::AdapterCapabilityMatrix`] is the registry-side 4-rung ladder, this
//! schema is the single, cross-family *declaration* surface: what does kaifuu
//! CLAIM it can do with a given (family, variant, transform stack), at what
//! support level, backed by what evidence, gated by which secrets, and where
//! are the honest gaps.
//! It deliberately REUSES the shared transform vocabulary
//! ([`ContainerTransform`] / [`CryptoTransform`] / [`CodecTransform`] /
//! [`SurfaceTransform`] / [`PatchBackTransform`]) and the shared
//! [`SecretRef`] / [`SemanticErrorCode`] / [`ProofHash`] types rather than
//! inventing a parallel vocabulary. The one thing it adds over the closed
//! 4-rung ladder is the 6-level [`ClaimedSupportLevel`] (adding
//! `helper` and `runtime`); the 4-rung [`crate::registry::CapabilityLevel`]
//! stays the registry gate (it is intentionally closed + DB/TS-mirrored), and
//! folding the two ladders into one is tracked as a follow-up (it needs a
//! coordinated Rust + TS + DB bump).
//! # The honesty guarantees (mechanical, not prose)
//! 1. **All 10 identity/transform/reference fields are required.** A tuple
//!    missing `engineFamily`, `engineVariant`, `container`, `crypto`, `codec`,
//!    `surface`, `patchBackMode`, `profileOrFixtureId`, `secretRequirementIds`,
//!    or `diagnostics` fails to deserialize (serde has no default for any of
//!    them). Two further required fields — `claimedLevel` and `evidence` —
//!    carry the claim itself and its evidence chain.
//! 2. **The six support levels are distinguished** by [`ClaimedSupportLevel`]:
//!    `identify` / `inventory` / `extract` / `patch` / `helper` / `runtime`.
//! 3. **Anti-overclaim.** A tuple cannot claim patch-back (or the
//!    helper/runtime levels that subsume it) unless the evidence chain —
//!    extraction evidence + validation evidence + patch-back evidence — is
//!    present AND `patchBackMode` is a real write mode (not `unsupported` /
//!    `unknown`). [`validate_claimed_support_tuple`] emits a blocking typed
//!    diagnostic and fails the entry otherwise. This is the key guard against a
//!    tuple silently overstating what kaifuu can do.
//! 4. **Explicit typed diagnostics, never broad strings.** An unknown variant
//!    or a missing capability layer is a structured [`CompatDiagnostic`]
//!    (`{layer, status, reasonId, severity}`) — never a bare `"unsupported"`
//!    string.
//! # Evidence is synthetic, redacted, ref-only
//! Tuples carry NO raw secrets and NO retail bytes: secrets are local-scheme
//! [`SecretRef`]s behind stable requirement ids, and evidence legs are
//! `evidenceId` + [`ProofHash`] refs. The report is funnelled through
//! [`redact_for_log_or_report`] and serialized via [`crate::stable_json`].

use serde::{Deserialize, Serialize};

use crate::{
    CodecTransform, ContainerTransform, CryptoTransform, PartialDiagnosticSeverity,
    PatchBackTransform, ProofHash, SecretRef, SemanticErrorCode, SurfaceTransform,
    redact_for_log_or_report,
};

mod validator;
pub use validator::{
    ClaimedSupportEntryReport, ClaimedSupportValidationReport, validate_claimed_support_profile,
    validate_claimed_support_tuple,
};

/// Schema version of the claimed-support tuple. Bumped on any breaking field
/// change (kept in lockstep with the JSON Schema fixture and the TS mirror).
pub const CLAIMED_SUPPORT_SCHEMA_VERSION: &str = "0.1.0";

/// Schema version of the generated validation report.
pub const CLAIMED_SUPPORT_REPORT_SCHEMA_VERSION: &str = "0.1.0";

/// The honesty boundary surfaced in every report.
pub const CLAIMED_SUPPORT_BOUNDARY: &str = "Claimed-support tuples are the single cross-family declaration of what kaifuu claims for a (family, variant, transform stack). A tuple resolves to its declared support level only when its evidence chain backs it: extract needs extraction evidence, and patch/helper/runtime additionally need validation + patch-back evidence and a real patch-back mode. Unknown variants and missing capability layers are explicit typed diagnostics, never broad 'unsupported' strings. Evidence is synthetic, redacted, ref-only — no raw secrets, no retail bytes.";

// Engine family taxonomy (unifying, for CLAIMS)

/// The engine families a compatibility CLAIM can be authored for. This is the
/// unifying claim-side taxonomy; the packed-only
/// [`crate::packed_engine_readiness::PackedEngineFamily`] remains the
/// readiness-validator taxonomy for archive/encrypted-asset engines. Folding
/// the two family enums into one is a follow-up (it touches 's
/// spec + fixtures). `Unknown` always resolves to an explicit diagnostic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompatEngineFamily {
    /// Siglus / SiglusEngine (`SiglusPck`, static-key crypto).
    Siglus,
    /// KiriKiri KAG `.ks` plaintext scenario scripts (the null-container floor
    /// case — NOT commercial encrypted-XP3 coverage).
    KirikiriKagPlaintext,
    /// KiriKiri XP3 commercial archives (per-title key material / helper-gated).
    KirikiriXp3,
    /// TyranoScript `.ks` plaintext scenario scripts (identity container,
    /// null-key crypto, `tyrano_script_markup` codec — the null-key/plaintext
    /// floor, mirroring KAG's shape but an independent adapter).
    #[serde(rename = "tyranoscript")]
    TyranoScript,
    /// RPG Maker MV/MZ project JSON text (`data/*.json`).
    RpgMakerMvMzJson,
    /// RPG Maker MV/MZ encrypted media assets (`*.rpgmvp` / `*.rpgmvo` …).
    RpgMakerMvMzEncryptedAsset,
    /// RealLive / Utsushi runtime VM surface.
    RealLiveRuntime,
    /// Unknown / unrecognized family — always an explicit diagnostic.
    Unknown,
}

impl CompatEngineFamily {
    /// Stable string segment used in ids and diagnostics.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Siglus => "siglus",
            Self::KirikiriKagPlaintext => "kirikiri_kag_plaintext",
            Self::KirikiriXp3 => "kirikiri_xp3",
            Self::TyranoScript => "tyranoscript",
            Self::RpgMakerMvMzJson => "rpg_maker_mv_mz_json",
            Self::RpgMakerMvMzEncryptedAsset => "rpg_maker_mv_mz_encrypted_asset",
            Self::RealLiveRuntime => "reallive_runtime",
            Self::Unknown => "unknown",
        }
    }

    /// The recognized (non-`Unknown`) families in canonical order.
    pub fn recognized() -> [Self; 7] {
        [
            Self::Siglus,
            Self::KirikiriKagPlaintext,
            Self::KirikiriXp3,
            Self::TyranoScript,
            Self::RpgMakerMvMzJson,
            Self::RpgMakerMvMzEncryptedAsset,
            Self::RealLiveRuntime,
        ]
    }
}

// The 6-level claimed-support ladder

/// The six mechanically-distinct support levels a tuple may claim.
/// `identify` / `inventory` / `extract` / `patch` mirror the closed
/// 4-rung ladder; `helper` marks a capability reachable only with an external
/// helper present; `runtime` marks runtime-VM execution (Utsushi territory).
/// The ordering is the natural ladder — `helper` and `runtime` subsume the
/// patch-back evidence chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaimedSupportLevel {
    Identify,
    Inventory,
    Extract,
    Patch,
    Helper,
    Runtime,
}

impl ClaimedSupportLevel {
    /// All six levels in ascending order.
    pub fn all() -> [Self; 6] {
        [
            Self::Identify,
            Self::Inventory,
            Self::Extract,
            Self::Patch,
            Self::Helper,
            Self::Runtime,
        ]
    }

    /// Stable canonical string.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Identify => "identify",
            Self::Inventory => "inventory",
            Self::Extract => "extract",
            Self::Patch => "patch",
            Self::Helper => "helper",
            Self::Runtime => "runtime",
        }
    }

    /// The evidence legs this level REQUIRES. `extract` needs extraction;
    /// `patch` / `helper` / `runtime` additionally need validation + patch-back
    /// (the anti-overclaim chain); `runtime` needs a runtime leg on top.
    /// `identify` / `inventory` need none.
    pub fn required_evidence_legs(self) -> &'static [EvidenceLeg] {
        match self {
            Self::Identify | Self::Inventory => &[],
            Self::Extract => &[EvidenceLeg::Extraction],
            Self::Patch | Self::Helper => &[
                EvidenceLeg::Extraction,
                EvidenceLeg::Validation,
                EvidenceLeg::PatchBack,
            ],
            Self::Runtime => &[
                EvidenceLeg::Extraction,
                EvidenceLeg::Validation,
                EvidenceLeg::PatchBack,
                EvidenceLeg::Runtime,
            ],
        }
    }

    /// True iff the level claims patch-back (or subsumes it). These are exactly
    /// the levels the anti-overclaim gate polices for a real `patchBackMode`.
    pub fn claims_patch_back(self) -> bool {
        matches!(self, Self::Patch | Self::Helper | Self::Runtime)
    }
}

/// One leg of the evidence chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EvidenceLeg {
    Extraction,
    Validation,
    PatchBack,
    Runtime,
}

impl EvidenceLeg {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Extraction => "extraction",
            Self::Validation => "validation",
            Self::PatchBack => "patch_back",
            Self::Runtime => "runtime",
        }
    }
}

#[path = "compat_profile/diagnostics.rs"]
mod diagnostics;
pub use diagnostics::{CompatDiagnostic, CompatDiagnosticStatus, CompatLayer};

// Secret requirement ids + evidence chain

/// A secret-requirement id mapping — WHAT secret the tuple needs, by ref, never
/// a raw key. `requirementId` is the stable cross-reference; `secretRef` is a
/// local-scheme [`SecretRef`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecretRequirementId {
    pub requirement_id: String,
    pub secret_ref: SecretRef,
}

impl SecretRequirementId {
    pub fn new(requirement_id: impl Into<String>, secret_ref: SecretRef) -> Self {
        Self {
            requirement_id: requirement_id.into(),
            secret_ref,
        }
    }

    fn redacted_for_report(&self) -> Self {
        Self {
            requirement_id: redact_for_log_or_report(&self.requirement_id),
            // SecretRef already serializes as an opaque local ref, never raw
            // material; nothing further to redact.
            secret_ref: self.secret_ref.clone(),
        }
    }
}

/// One evidence leg: a stable id + a [`ProofHash`] proving the leg passed. No
/// bytes, no secrets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceRef {
    pub evidence_id: String,
    pub proof_hash: ProofHash,
}

impl EvidenceRef {
    pub fn new(evidence_id: impl Into<String>, proof_hash: ProofHash) -> Self {
        Self {
            evidence_id: evidence_id.into(),
            proof_hash,
        }
    }

    fn redacted_for_report(&self) -> Self {
        Self {
            evidence_id: redact_for_log_or_report(&self.evidence_id),
            proof_hash: self.proof_hash.clone(),
        }
    }
}

/// The evidence chain backing a claim. Each leg is optional at the type level;
/// which legs are REQUIRED is decided per claimed level by
/// [`ClaimedSupportLevel::required_evidence_legs`] and enforced by the
/// validator (the anti-overclaim gate).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SupportEvidence {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extraction: Option<EvidenceRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validation: Option<EvidenceRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub patch_back: Option<EvidenceRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<EvidenceRef>,
}

impl SupportEvidence {
    /// An empty evidence chain (identify/inventory tuples).
    pub fn none() -> Self {
        Self {
            extraction: None,
            validation: None,
            patch_back: None,
            runtime: None,
        }
    }

    /// The ref for `leg`, if present.
    pub fn leg(&self, leg: EvidenceLeg) -> Option<&EvidenceRef> {
        match leg {
            EvidenceLeg::Extraction => self.extraction.as_ref(),
            EvidenceLeg::Validation => self.validation.as_ref(),
            EvidenceLeg::PatchBack => self.patch_back.as_ref(),
            EvidenceLeg::Runtime => self.runtime.as_ref(),
        }
    }

    fn redacted_for_report(&self) -> Self {
        Self {
            extraction: self
                .extraction
                .as_ref()
                .map(EvidenceRef::redacted_for_report),
            validation: self
                .validation
                .as_ref()
                .map(EvidenceRef::redacted_for_report),
            patch_back: self
                .patch_back
                .as_ref()
                .map(EvidenceRef::redacted_for_report),
            runtime: self.runtime.as_ref().map(EvidenceRef::redacted_for_report),
        }
    }
}

/// True iff `mode` is a real write-back mode (not `unsupported` / `unknown` /
/// `identity`). A patch/helper/runtime claim requires one.
pub fn is_real_patch_back(mode: PatchBackTransform) -> bool {
    matches!(
        mode,
        PatchBackTransform::ReplaceFile
            | PatchBackTransform::RewriteJson
            | PatchBackTransform::RepackArchive
            | PatchBackTransform::RecompileBytecode
            | PatchBackTransform::ReplaceAsset
    )
}

// The claimed-support tuple

/// The versioned claimed-support tuple: the single cross-family declaration of
/// a compatibility claim.
/// The 10 REQUIRED identity/transform/reference fields are `engineFamily`,
/// `engineVariant`, `container`, `crypto`, `codec`, `surface`, `patchBackMode`,
/// `profileOrFixtureId`, `secretRequirementIds`, and `diagnostics`. Two further
/// required fields carry the claim itself (`claimedLevel`) and its evidence
/// chain (`evidence`). None of these carries a serde default — a tuple missing
/// any of them fails to deserialize.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaimedSupportTuple {
    pub schema_version: String,
    pub engine_family: CompatEngineFamily,
    pub engine_variant: String,
    pub container: ContainerTransform,
    pub crypto: CryptoTransform,
    pub codec: CodecTransform,
    pub surface: SurfaceTransform,
    pub patch_back_mode: PatchBackTransform,
    pub profile_or_fixture_id: String,
    /// Secret requirement id → local-scheme ref mapping (never raw material).
    pub secret_requirement_ids: Vec<SecretRequirementId>,
    /// Author-declared honest gaps (explicit typed diagnostics).
    pub diagnostics: Vec<CompatDiagnostic>,
    pub claimed_level: ClaimedSupportLevel,
    pub evidence: SupportEvidence,
}

/// The 10 required tuple field names, in schema order. Used by the schema-parity
/// test and the JSON Schema fixture.
pub const CLAIMED_SUPPORT_REQUIRED_FIELDS: [&str; 10] = [
    "engineFamily",
    "engineVariant",
    "container",
    "crypto",
    "codec",
    "surface",
    "patchBackMode",
    "profileOrFixtureId",
    "secretRequirementIds",
    "diagnostics",
];

// Fixtures — 6 capability levels + real-adapter HONEST tuples

/// Synthetic, declared example tuples. These are the honest-level fixtures the
/// acceptance invariants are checked against — no retail bytes, no raw secrets.
pub mod fixtures;

#[cfg(test)]
#[path = "compat_profile/tests.rs"]
mod tests;
