//! KAIFUU-105 — Claimed-support compatibility profile schema.
//!
//! This module formalizes, HONESTLY, how kaifuu declares its compatibility
//! claims across *all* engine families in one versioned schema — the
//! **claimed-support tuple**. Where the per-family readiness validators pin one
//! engine each (KAIFUU-054 [`crate::xp3_capability_profile`], KAIFUU-108
//! [`crate::mv_mz_readiness`], KAIFUU-103 [`crate::packed_engine_readiness`],
//! ALPHA-004 [`crate::alpha_encrypted_readiness`]) and the KAIFUU-053
//! [`crate::AdapterCapabilityMatrix`] is the registry-side 4-rung ladder, this
//! schema is the single, cross-family *declaration* surface: what does kaifuu
//! CLAIM it can do with a given (family, variant, transform stack), at what
//! support level, backed by what evidence, gated by which secrets, and where
//! are the honest gaps.
//!
//! It deliberately REUSES the shared transform vocabulary
//! ([`ContainerTransform`] / [`CryptoTransform`] / [`CodecTransform`] /
//! [`SurfaceTransform`] / [`PatchBackTransform`]) and the shared
//! [`SecretRef`] / [`SemanticErrorCode`] / [`ProofHash`] types rather than
//! inventing a parallel vocabulary. The one thing it adds over the closed
//! KAIFUU-053 4-rung ladder is the 6-level [`ClaimedSupportLevel`] (adding
//! `helper` and `runtime`); the 4-rung [`crate::registry::CapabilityLevel`]
//! stays the registry gate (it is intentionally closed + DB/TS-mirrored), and
//! folding the two ladders into one is tracked as a follow-up (it needs a
//! coordinated Rust + TS + DB bump).
//!
//! # The honesty guarantees (mechanical, not prose)
//!
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
//!
//! # Evidence is synthetic, redacted, ref-only
//!
//! Tuples carry NO raw secrets and NO retail bytes: secrets are local-scheme
//! [`SecretRef`]s behind stable requirement ids, and evidence legs are
//! `evidenceId` + [`ProofHash`] refs. The report is funnelled through
//! [`redact_for_log_or_report`] and serialized via [`stable_json`].

use serde::{Deserialize, Serialize};

use crate::{
    CodecTransform, ContainerTransform, CryptoTransform, KaifuuResult, OperationStatus,
    PartialDiagnosticSeverity, PatchBackTransform, ProofHash, SecretRef, SemanticErrorCode,
    SurfaceTransform, redact_for_log_or_report, stable_json,
};

/// Schema version of the claimed-support tuple. Bumped on any breaking field
/// change (kept in lockstep with the JSON Schema fixture and the TS mirror).
pub const CLAIMED_SUPPORT_SCHEMA_VERSION: &str = "0.1.0";

/// Schema version of the generated validation report.
pub const CLAIMED_SUPPORT_REPORT_SCHEMA_VERSION: &str = "0.1.0";

/// The honesty boundary surfaced in every report.
pub const CLAIMED_SUPPORT_BOUNDARY: &str = "Claimed-support tuples are the single cross-family declaration of what kaifuu claims for a (family, variant, transform stack). A tuple resolves to its declared support level only when its evidence chain backs it: extract needs extraction evidence, and patch/helper/runtime additionally need validation + patch-back evidence and a real patch-back mode. Unknown variants and missing capability layers are explicit typed diagnostics, never broad 'unsupported' strings. Evidence is synthetic, redacted, ref-only — no raw secrets, no retail bytes.";

// ---------------------------------------------------------------------------
// Engine family taxonomy (unifying, for CLAIMS)
// ---------------------------------------------------------------------------

/// The engine families a compatibility CLAIM can be authored for. This is the
/// unifying claim-side taxonomy; the packed-only
/// [`crate::packed_engine_readiness::PackedEngineFamily`] remains the
/// readiness-validator taxonomy for archive/encrypted-asset engines. Folding
/// the two family enums into one is a follow-up (it touches KAIFUU-103's
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
            Self::RpgMakerMvMzJson => "rpg_maker_mv_mz_json",
            Self::RpgMakerMvMzEncryptedAsset => "rpg_maker_mv_mz_encrypted_asset",
            Self::RealLiveRuntime => "reallive_runtime",
            Self::Unknown => "unknown",
        }
    }

    /// The recognized (non-`Unknown`) families in canonical order.
    pub fn recognized() -> [Self; 6] {
        [
            Self::Siglus,
            Self::KirikiriKagPlaintext,
            Self::KirikiriXp3,
            Self::RpgMakerMvMzJson,
            Self::RpgMakerMvMzEncryptedAsset,
            Self::RealLiveRuntime,
        ]
    }
}

// ---------------------------------------------------------------------------
// The 6-level claimed-support ladder
// ---------------------------------------------------------------------------

/// The six mechanically-distinct support levels a tuple may claim.
///
/// `identify` / `inventory` / `extract` / `patch` mirror the closed KAIFUU-053
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

// ---------------------------------------------------------------------------
// Diagnostics — explicit + typed, never a broad string
// ---------------------------------------------------------------------------

/// Which layer of the transform stack a diagnostic is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompatLayer {
    Variant,
    Container,
    Crypto,
    Codec,
    Surface,
    PatchBack,
    Key,
    Helper,
    Evidence,
    Runtime,
}

impl CompatLayer {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Variant => "variant",
            Self::Container => "container",
            Self::Crypto => "crypto",
            Self::Codec => "codec",
            Self::Surface => "surface",
            Self::PatchBack => "patch_back",
            Self::Key => "key",
            Self::Helper => "helper",
            Self::Evidence => "evidence",
            Self::Runtime => "runtime",
        }
    }
}

/// The typed status of a layer. Deliberately does NOT include a bare
/// `unsupported` — an honest diagnostic states *why* (`not_implemented`,
/// `helper_required`, `missing_key`, `unknown_variant`, `known_key_only`,
/// `media_non_extractable`, `evidence_missing`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompatDiagnosticStatus {
    /// The layer is implemented and available (an affirmative note).
    Supported,
    /// The layer exists in the vocabulary but kaifuu has no implementation.
    NotImplemented,
    /// The layer is reachable only with an external helper present.
    HelperRequired,
    /// The layer needs key material that is not resolved.
    MissingKey,
    /// The engine family / variant is not recognized.
    UnknownVariant,
    /// Crypto works only against a catalogued known key, not arbitrary titles.
    KnownKeyOnly,
    /// An encrypted media asset that is recognized but non-extractable as text.
    MediaNonExtractable,
    /// A claimed level whose required evidence leg is absent (anti-overclaim).
    EvidenceMissing,
}

impl CompatDiagnosticStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Supported => "supported",
            Self::NotImplemented => "not_implemented",
            Self::HelperRequired => "helper_required",
            Self::MissingKey => "missing_key",
            Self::UnknownVariant => "unknown_variant",
            Self::KnownKeyOnly => "known_key_only",
            Self::MediaNonExtractable => "media_non_extractable",
            Self::EvidenceMissing => "evidence_missing",
        }
    }
}

/// A structured, typed compatibility diagnostic. Used both for the honest
/// author-declared gaps a tuple carries and for the findings
/// [`validate_claimed_support_tuple`] emits. Never a bare prose string.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompatDiagnostic {
    pub layer: CompatLayer,
    pub status: CompatDiagnosticStatus,
    /// The typed reason code (never a free-form string).
    pub reason_id: SemanticErrorCode,
    pub severity: PartialDiagnosticSeverity,
    /// Optional human note — redacted in reports, never carries secrets/bytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl CompatDiagnostic {
    pub fn new(
        layer: CompatLayer,
        status: CompatDiagnosticStatus,
        reason_id: SemanticErrorCode,
        severity: PartialDiagnosticSeverity,
    ) -> Self {
        Self {
            layer,
            status,
            reason_id,
            severity,
            detail: None,
        }
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    /// True iff this diagnostic is blocking (P0/P1) — flips the entry to
    /// [`OperationStatus::Failed`].
    pub fn is_blocking(&self) -> bool {
        self.severity.is_blocking()
    }

    pub(crate) fn redacted_for_report(&self) -> Self {
        Self {
            layer: self.layer,
            status: self.status,
            reason_id: self.reason_id,
            severity: self.severity,
            detail: self.detail.as_deref().map(redact_for_log_or_report),
        }
    }
}

// ---------------------------------------------------------------------------
// Secret requirement ids + evidence chain
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// The claimed-support tuple
// ---------------------------------------------------------------------------

/// The versioned claimed-support tuple: the single cross-family declaration of
/// a compatibility claim.
///
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
    // --- the 10 required tuple fields ---
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
    // --- the claim + its evidence chain ---
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

// ---------------------------------------------------------------------------
// Validator + report
// ---------------------------------------------------------------------------

/// Per-tuple validation report entry. Carries the claim, the mechanically
/// merged diagnostics (author-declared + validator findings), and the status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimedSupportEntryReport {
    pub profile_or_fixture_id: String,
    pub engine_family: CompatEngineFamily,
    pub engine_variant: String,
    pub claimed_level: ClaimedSupportLevel,
    pub container: ContainerTransform,
    pub crypto: CryptoTransform,
    pub codec: CodecTransform,
    pub surface: SurfaceTransform,
    pub patch_back_mode: PatchBackTransform,
    pub secret_requirement_ids: Vec<SecretRequirementId>,
    pub evidence: SupportEvidence,
    /// Author-declared + validator-emitted diagnostics, merged.
    pub diagnostics: Vec<CompatDiagnostic>,
    pub status: OperationStatus,
}

impl ClaimedSupportEntryReport {
    /// True iff the entry validated (no blocking diagnostic).
    pub fn is_honest(&self) -> bool {
        self.status == OperationStatus::Passed
    }

    pub(crate) fn redacted_for_report(&self) -> Self {
        Self {
            profile_or_fixture_id: redact_for_log_or_report(&self.profile_or_fixture_id),
            engine_family: self.engine_family,
            engine_variant: redact_for_log_or_report(&self.engine_variant),
            claimed_level: self.claimed_level,
            container: self.container,
            crypto: self.crypto,
            codec: self.codec,
            surface: self.surface,
            patch_back_mode: self.patch_back_mode,
            secret_requirement_ids: self
                .secret_requirement_ids
                .iter()
                .map(SecretRequirementId::redacted_for_report)
                .collect(),
            evidence: self.evidence.redacted_for_report(),
            diagnostics: self
                .diagnostics
                .iter()
                .map(CompatDiagnostic::redacted_for_report)
                .collect(),
            status: self.status.clone(),
        }
    }
}

/// The aggregate validation report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimedSupportValidationReport {
    pub schema_version: String,
    pub support_boundary: String,
    pub status: OperationStatus,
    pub tuple_count: u64,
    pub honest_count: u64,
    pub overclaim_count: u64,
    pub entries: Vec<ClaimedSupportEntryReport>,
}

impl ClaimedSupportValidationReport {
    pub fn entry(&self, profile_or_fixture_id: &str) -> Option<&ClaimedSupportEntryReport> {
        self.entries
            .iter()
            .find(|entry| entry.profile_or_fixture_id == profile_or_fixture_id)
    }

    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            status: self.status.clone(),
            tuple_count: self.tuple_count,
            honest_count: self.honest_count,
            overclaim_count: self.overclaim_count,
            entries: self
                .entries
                .iter()
                .map(ClaimedSupportEntryReport::redacted_for_report)
                .collect(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

/// Validate a single claimed-support tuple, producing one structured report
/// entry. Every inconsistency is a typed [`CompatDiagnostic`]; this never
/// panics and never returns `Err`.
///
/// The anti-overclaim gate (KAIFUU-105 acceptance 3) lives here: a tuple whose
/// `claimedLevel` claims patch-back but lacks the extraction + validation +
/// patch-back evidence chain, or whose `patchBackMode` is not a real write
/// mode, gets a blocking `evidence_missing` / `not_implemented` diagnostic and
/// fails.
pub fn validate_claimed_support_tuple(tuple: &ClaimedSupportTuple) -> ClaimedSupportEntryReport {
    // Start from the author-declared diagnostics, then append validator findings.
    let mut diagnostics: Vec<CompatDiagnostic> = tuple.diagnostics.clone();

    // Unknown family → explicit typed diagnostic (acceptance 4), never a broad
    // string.
    if tuple.engine_family == CompatEngineFamily::Unknown {
        diagnostics.push(CompatDiagnostic::new(
            CompatLayer::Variant,
            CompatDiagnosticStatus::UnknownVariant,
            SemanticErrorCode::UnknownEngineVariant,
            PartialDiagnosticSeverity::P0,
        ));
    }

    if tuple.engine_variant.trim().is_empty() {
        diagnostics.push(CompatDiagnostic::new(
            CompatLayer::Variant,
            CompatDiagnosticStatus::UnknownVariant,
            SemanticErrorCode::UnknownEngineVariant,
            PartialDiagnosticSeverity::P0,
        ));
    }

    // Anti-overclaim: required evidence legs per claimed level.
    for leg in tuple.claimed_level.required_evidence_legs() {
        if tuple.evidence.leg(*leg).is_none() {
            let (layer, reason) = match leg {
                EvidenceLeg::Extraction => (
                    CompatLayer::Evidence,
                    SemanticErrorCode::MissingCodecCapability,
                ),
                EvidenceLeg::Validation => (
                    CompatLayer::Evidence,
                    SemanticErrorCode::KeyValidationFailed,
                ),
                EvidenceLeg::PatchBack => (
                    CompatLayer::PatchBack,
                    SemanticErrorCode::MissingPatchBackCapability,
                ),
                EvidenceLeg::Runtime => (
                    CompatLayer::Runtime,
                    SemanticErrorCode::UnsupportedLayeredTransform,
                ),
            };
            diagnostics.push(
                CompatDiagnostic::new(
                    layer,
                    CompatDiagnosticStatus::EvidenceMissing,
                    reason,
                    PartialDiagnosticSeverity::P0,
                )
                .with_detail(format!(
                    "claimedLevel {} requires {} evidence, which is absent",
                    tuple.claimed_level.as_str(),
                    leg.as_str()
                )),
            );
        }
    }

    // Anti-overclaim: a patch-back claim needs a real write-back mode.
    if tuple.claimed_level.claims_patch_back() && !is_real_patch_back(tuple.patch_back_mode) {
        diagnostics.push(
            CompatDiagnostic::new(
                CompatLayer::PatchBack,
                CompatDiagnosticStatus::NotImplemented,
                SemanticErrorCode::MissingPatchBackCapability,
                PartialDiagnosticSeverity::P0,
            )
            .with_detail(format!(
                "claimedLevel {} claims patch-back but patchBackMode is not a real write mode",
                tuple.claimed_level.as_str()
            )),
        );
    }

    let status = if diagnostics.iter().any(CompatDiagnostic::is_blocking) {
        OperationStatus::Failed
    } else {
        OperationStatus::Passed
    };

    ClaimedSupportEntryReport {
        profile_or_fixture_id: tuple.profile_or_fixture_id.clone(),
        engine_family: tuple.engine_family,
        engine_variant: tuple.engine_variant.clone(),
        claimed_level: tuple.claimed_level,
        container: tuple.container,
        crypto: tuple.crypto,
        codec: tuple.codec,
        surface: tuple.surface,
        patch_back_mode: tuple.patch_back_mode,
        secret_requirement_ids: tuple.secret_requirement_ids.clone(),
        evidence: tuple.evidence.clone(),
        diagnostics,
        status,
    }
}

/// Validate a set of claimed-support tuples into one aggregate report. The
/// report status is `Failed` iff any entry is an overclaim.
pub fn validate_claimed_support_profile(
    tuples: &[ClaimedSupportTuple],
) -> ClaimedSupportValidationReport {
    let entries: Vec<ClaimedSupportEntryReport> =
        tuples.iter().map(validate_claimed_support_tuple).collect();
    let honest_count = entries.iter().filter(|e| e.is_honest()).count() as u64;
    let overclaim_count = entries.len() as u64 - honest_count;
    let status = if overclaim_count == 0 {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };
    ClaimedSupportValidationReport {
        schema_version: CLAIMED_SUPPORT_REPORT_SCHEMA_VERSION.to_string(),
        support_boundary: CLAIMED_SUPPORT_BOUNDARY.to_string(),
        status,
        tuple_count: entries.len() as u64,
        honest_count,
        overclaim_count,
        entries,
    }
}

// ---------------------------------------------------------------------------
// Fixtures — 6 capability levels + real-adapter HONEST tuples
// ---------------------------------------------------------------------------

/// Synthetic, declared example tuples. These are the honest-level fixtures the
/// acceptance invariants are checked against — no retail bytes, no raw secrets.
pub mod fixtures {
    use super::*;
    use crate::{ProofHash, SecretRef, sha256_hash_bytes};

    fn proof(seed: &str) -> ProofHash {
        ProofHash::new(sha256_hash_bytes(seed.as_bytes())).expect("synthetic proof hash is valid")
    }

    fn secret_ref(name: &str) -> SecretRef {
        SecretRef::new(format!("local-secret:{name}")).expect("synthetic secret ref is valid")
    }

    fn extraction(seed: &str) -> EvidenceRef {
        EvidenceRef::new(
            format!("evidence/extract/{seed}"),
            proof(&format!("extract:{seed}")),
        )
    }
    fn validation(seed: &str) -> EvidenceRef {
        EvidenceRef::new(
            format!("evidence/validate/{seed}"),
            proof(&format!("validate:{seed}")),
        )
    }
    fn patch_back(seed: &str) -> EvidenceRef {
        EvidenceRef::new(
            format!("evidence/patch/{seed}"),
            proof(&format!("patch:{seed}")),
        )
    }

    /// LEVEL: `identify`. A recognized-but-unproven family — kaifuu can name it
    /// and nothing more. No evidence, no overclaim.
    pub fn level_identify() -> ClaimedSupportTuple {
        ClaimedSupportTuple {
            schema_version: CLAIMED_SUPPORT_SCHEMA_VERSION.to_string(),
            engine_family: CompatEngineFamily::RealLiveRuntime,
            engine_variant: "reallive_detected_only".to_string(),
            container: ContainerTransform::Archive,
            crypto: CryptoTransform::Unknown,
            codec: CodecTransform::Unknown,
            surface: SurfaceTransform::Unknown,
            patch_back_mode: PatchBackTransform::Unsupported,
            profile_or_fixture_id: "compat/reallive/identify-only".to_string(),
            secret_requirement_ids: vec![],
            diagnostics: vec![CompatDiagnostic::new(
                CompatLayer::Codec,
                CompatDiagnosticStatus::NotImplemented,
                SemanticErrorCode::MissingCodecCapability,
                PartialDiagnosticSeverity::P3,
            )],
            claimed_level: ClaimedSupportLevel::Identify,
            evidence: SupportEvidence::none(),
        }
    }

    /// LEVEL: `inventory`. Kaifuu can list assets but not extract text.
    pub fn level_inventory() -> ClaimedSupportTuple {
        ClaimedSupportTuple {
            schema_version: CLAIMED_SUPPORT_SCHEMA_VERSION.to_string(),
            engine_family: CompatEngineFamily::KirikiriXp3,
            engine_variant: "kirikiri_xp3_inventory_only".to_string(),
            container: ContainerTransform::Xp3,
            crypto: CryptoTransform::NullKey,
            codec: CodecTransform::Unknown,
            surface: SurfaceTransform::ArchiveEntry,
            patch_back_mode: PatchBackTransform::Unsupported,
            profile_or_fixture_id: "compat/kirikiri-xp3/inventory-only".to_string(),
            secret_requirement_ids: vec![],
            diagnostics: vec![CompatDiagnostic::new(
                CompatLayer::Codec,
                CompatDiagnosticStatus::NotImplemented,
                SemanticErrorCode::MissingCodecCapability,
                PartialDiagnosticSeverity::P3,
            )],
            claimed_level: ClaimedSupportLevel::Inventory,
            evidence: SupportEvidence::none(),
        }
    }

    /// LEVEL: `extract`. Siglus at its HONEST posture: identify + known-static-
    /// key extraction, NOT patch/runtime. Patch-back is declared not-implemented.
    pub fn level_extract_siglus() -> ClaimedSupportTuple {
        ClaimedSupportTuple {
            schema_version: CLAIMED_SUPPORT_SCHEMA_VERSION.to_string(),
            engine_family: CompatEngineFamily::Siglus,
            engine_variant: "siglus_pck_static_key".to_string(),
            container: ContainerTransform::SiglusPck,
            crypto: CryptoTransform::FixedKey,
            codec: CodecTransform::Utf16Text,
            surface: SurfaceTransform::ArchiveEntry,
            patch_back_mode: PatchBackTransform::Unsupported,
            profile_or_fixture_id: "compat/siglus/known-key-extract".to_string(),
            secret_requirement_ids: vec![SecretRequirementId::new(
                "siglus.scene-pck.static-key",
                secret_ref("siglus-scene-static-key"),
            )],
            diagnostics: vec![
                CompatDiagnostic::new(
                    CompatLayer::Crypto,
                    CompatDiagnosticStatus::KnownKeyOnly,
                    SemanticErrorCode::MissingKeyMaterial,
                    PartialDiagnosticSeverity::P2,
                )
                .with_detail("extraction is limited to catalogued known static keys"),
                CompatDiagnostic::new(
                    CompatLayer::PatchBack,
                    CompatDiagnosticStatus::NotImplemented,
                    SemanticErrorCode::MissingPatchBackCapability,
                    PartialDiagnosticSeverity::P2,
                )
                .with_detail("Siglus patch-back is not yet proven"),
            ],
            claimed_level: ClaimedSupportLevel::Extract,
            evidence: SupportEvidence {
                extraction: Some(extraction("siglus")),
                validation: None,
                patch_back: None,
                runtime: None,
            },
        }
    }

    /// LEVEL: `patch`. KiriKiri plaintext KAG `.ks`: extract + patch, container
    /// is `loose_file` (NOT commercial XP3), no crypto. Full evidence chain.
    pub fn level_patch_kirikiri_kag_plaintext() -> ClaimedSupportTuple {
        ClaimedSupportTuple {
            schema_version: CLAIMED_SUPPORT_SCHEMA_VERSION.to_string(),
            engine_family: CompatEngineFamily::KirikiriKagPlaintext,
            engine_variant: "kirikiri_kag_plaintext_ks".to_string(),
            container: ContainerTransform::LooseFile,
            crypto: CryptoTransform::NullKey,
            codec: CodecTransform::ShiftJisText,
            surface: SurfaceTransform::Identity,
            patch_back_mode: PatchBackTransform::ReplaceFile,
            profile_or_fixture_id: "compat/kirikiri-kag/plaintext-patch".to_string(),
            secret_requirement_ids: vec![],
            diagnostics: vec![
                CompatDiagnostic::new(
                    CompatLayer::Container,
                    CompatDiagnosticStatus::NotImplemented,
                    SemanticErrorCode::UnsupportedVariantEncrypted,
                    PartialDiagnosticSeverity::P3,
                )
                .with_detail("plaintext KAG only — encrypted commercial XP3 is NOT covered"),
            ],
            claimed_level: ClaimedSupportLevel::Patch,
            evidence: SupportEvidence {
                extraction: Some(extraction("kag")),
                validation: Some(validation("kag")),
                patch_back: Some(patch_back("kag")),
                runtime: None,
            },
        }
    }

    /// A second HONEST `patch` tuple: RPG Maker MV/MZ project JSON text at the
    /// declared JSON-pointer surface. Extract + patch, no crypto.
    pub fn patch_rpg_maker_mv_mz_json() -> ClaimedSupportTuple {
        ClaimedSupportTuple {
            schema_version: CLAIMED_SUPPORT_SCHEMA_VERSION.to_string(),
            engine_family: CompatEngineFamily::RpgMakerMvMzJson,
            engine_variant: "rpg_maker_mz".to_string(),
            container: ContainerTransform::ProjectAsset,
            crypto: CryptoTransform::NullKey,
            codec: CodecTransform::RpgMakerMvMzJson,
            surface: SurfaceTransform::JsonPointer,
            patch_back_mode: PatchBackTransform::RewriteJson,
            profile_or_fixture_id: "compat/rpg-maker/mz-json-patch".to_string(),
            secret_requirement_ids: vec![],
            diagnostics: vec![],
            claimed_level: ClaimedSupportLevel::Patch,
            evidence: SupportEvidence {
                extraction: Some(extraction("mz-json")),
                validation: Some(validation("mz-json")),
                patch_back: Some(patch_back("mz-json")),
                runtime: None,
            },
        }
    }

    /// LEVEL: `helper`. KiriKiri XP3 commercial: patch reachable only with an
    /// external key/helper present. Helper-gated crypto + a helper diagnostic;
    /// full evidence chain for what it can do once the helper resolves the key.
    pub fn level_helper_kirikiri_xp3() -> ClaimedSupportTuple {
        ClaimedSupportTuple {
            schema_version: CLAIMED_SUPPORT_SCHEMA_VERSION.to_string(),
            engine_family: CompatEngineFamily::KirikiriXp3,
            engine_variant: "kirikiri_xp3_encrypted".to_string(),
            container: ContainerTransform::Xp3,
            crypto: CryptoTransform::HelperGated,
            codec: CodecTransform::Utf16Text,
            surface: SurfaceTransform::ArchiveEntry,
            patch_back_mode: PatchBackTransform::RepackArchive,
            profile_or_fixture_id: "compat/kirikiri-xp3/helper-gated-patch".to_string(),
            secret_requirement_ids: vec![SecretRequirementId::new(
                "kirikiri.xp3.per-title-key",
                secret_ref("kirikiri-xp3-per-title-key"),
            )],
            diagnostics: vec![
                CompatDiagnostic::new(
                    CompatLayer::Crypto,
                    CompatDiagnosticStatus::HelperRequired,
                    SemanticErrorCode::HelperRequired,
                    PartialDiagnosticSeverity::P2,
                )
                .with_detail("per-title key material must be resolved by an external helper"),
            ],
            claimed_level: ClaimedSupportLevel::Helper,
            evidence: SupportEvidence {
                extraction: Some(extraction("xp3")),
                validation: Some(validation("xp3")),
                patch_back: Some(patch_back("xp3")),
                runtime: None,
            },
        }
    }

    /// A HONEST encrypted-asset `patch` tuple: RPG Maker MV/MZ encrypted media
    /// asset replacement, gated by the asset encryption key (secretRequirement).
    /// Full evidence chain (asset round-trip).
    pub fn patch_rpg_maker_encrypted_asset() -> ClaimedSupportTuple {
        ClaimedSupportTuple {
            schema_version: CLAIMED_SUPPORT_SCHEMA_VERSION.to_string(),
            engine_family: CompatEngineFamily::RpgMakerMvMzEncryptedAsset,
            engine_variant: "rpg_maker_mv_encrypted_asset".to_string(),
            container: ContainerTransform::ProjectAsset,
            crypto: CryptoTransform::RpgMakerAssetKey,
            codec: CodecTransform::PngImage,
            surface: SurfaceTransform::BinaryOffset,
            patch_back_mode: PatchBackTransform::ReplaceAsset,
            profile_or_fixture_id: "compat/rpg-maker/mv-encrypted-asset-patch".to_string(),
            secret_requirement_ids: vec![SecretRequirementId::new(
                "rpg_maker.mv.encryption-key",
                secret_ref("rpgmaker-mv-encryption-key"),
            )],
            diagnostics: vec![
                CompatDiagnostic::new(
                    CompatLayer::Codec,
                    CompatDiagnosticStatus::MediaNonExtractable,
                    SemanticErrorCode::UnsupportedLayeredTransform,
                    PartialDiagnosticSeverity::P3,
                )
                .with_detail("media asset carries no extractable text; patch is asset replacement"),
            ],
            claimed_level: ClaimedSupportLevel::Patch,
            evidence: SupportEvidence {
                extraction: Some(extraction("mv-asset")),
                validation: Some(validation("mv-asset")),
                patch_back: Some(patch_back("mv-asset")),
                runtime: None,
            },
        }
    }

    /// LEVEL: `runtime`. A synthetic runtime-ready tuple carrying a full
    /// evidence chain INCLUDING a runtime leg. This demonstrates the level is
    /// distinguished; the honest live posture of the RealLive runtime is the
    /// identify-only tuple above (the runtime engine is largely unbuilt).
    pub fn level_runtime_synthetic() -> ClaimedSupportTuple {
        ClaimedSupportTuple {
            schema_version: CLAIMED_SUPPORT_SCHEMA_VERSION.to_string(),
            engine_family: CompatEngineFamily::RealLiveRuntime,
            engine_variant: "reallive_runtime_synthetic".to_string(),
            container: ContainerTransform::Archive,
            crypto: CryptoTransform::NullKey,
            codec: CodecTransform::BytecodeDecompile,
            surface: SurfaceTransform::RuntimeTrace,
            patch_back_mode: PatchBackTransform::RecompileBytecode,
            profile_or_fixture_id: "compat/reallive/runtime-synthetic".to_string(),
            secret_requirement_ids: vec![],
            diagnostics: vec![],
            claimed_level: ClaimedSupportLevel::Runtime,
            evidence: SupportEvidence {
                extraction: Some(extraction("runtime")),
                validation: Some(validation("runtime")),
                patch_back: Some(patch_back("runtime")),
                runtime: Some(EvidenceRef::new(
                    "evidence/runtime/reallive",
                    proof("runtime:reallive"),
                )),
            },
        }
    }

    /// An OVERCLAIMING tuple: claims `patch` but carries NO evidence and an
    /// `unsupported` patch-back mode. The validator MUST fail this (acceptance
    /// invariant 3). Used by the anti-overclaim test.
    pub fn overclaim_patch_without_evidence() -> ClaimedSupportTuple {
        ClaimedSupportTuple {
            schema_version: CLAIMED_SUPPORT_SCHEMA_VERSION.to_string(),
            engine_family: CompatEngineFamily::Siglus,
            engine_variant: "siglus_pck_static_key".to_string(),
            container: ContainerTransform::SiglusPck,
            crypto: CryptoTransform::FixedKey,
            codec: CodecTransform::Utf16Text,
            surface: SurfaceTransform::ArchiveEntry,
            patch_back_mode: PatchBackTransform::Unsupported,
            profile_or_fixture_id: "compat/siglus/OVERCLAIM-patch".to_string(),
            secret_requirement_ids: vec![],
            diagnostics: vec![],
            claimed_level: ClaimedSupportLevel::Patch,
            evidence: SupportEvidence::none(),
        }
    }

    /// The full set of HONEST fixtures — one per level plus the extra real
    /// adapters. Every one of these validates green.
    pub fn honest_catalogue() -> Vec<ClaimedSupportTuple> {
        vec![
            level_identify(),
            level_inventory(),
            level_extract_siglus(),
            level_patch_kirikiri_kag_plaintext(),
            patch_rpg_maker_mv_mz_json(),
            level_helper_kirikiri_xp3(),
            patch_rpg_maker_encrypted_asset(),
            level_runtime_synthetic(),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;

    fn tuple_json(tuple: &ClaimedSupportTuple) -> serde_json::Value {
        serde_json::to_value(tuple).expect("tuple serializes")
    }

    #[test]
    fn all_six_levels_are_distinguished() {
        let levels: Vec<ClaimedSupportLevel> =
            honest_catalogue().iter().map(|t| t.claimed_level).collect();
        for level in ClaimedSupportLevel::all() {
            assert!(
                levels.contains(&level),
                "honest catalogue must demonstrate the {} level",
                level.as_str()
            );
        }
        // And the 6 enum strings are distinct.
        let mut names: Vec<&str> = ClaimedSupportLevel::all()
            .iter()
            .map(|l| l.as_str())
            .collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), 6);
    }

    #[test]
    fn schema_requires_all_ten_fields() {
        // Deserializing a tuple with any one of the 10 required fields removed
        // must fail (serde has no default for them).
        let tuple = level_patch_kirikiri_kag_plaintext();
        let base = tuple_json(&tuple);
        for field in CLAIMED_SUPPORT_REQUIRED_FIELDS {
            let mut object = base.as_object().expect("tuple is a JSON object").clone();
            assert!(
                object.remove(field).is_some(),
                "field {field} must be present in a serialized tuple"
            );
            let result: Result<ClaimedSupportTuple, _> =
                serde_json::from_value(serde_json::Value::Object(object));
            assert!(
                result.is_err(),
                "removing required field {field} must fail deserialization"
            );
        }
        // Sanity: the untouched tuple round-trips.
        let round: ClaimedSupportTuple = serde_json::from_value(base).expect("round trip");
        assert_eq!(round, tuple);
    }

    #[test]
    fn claim_and_evidence_fields_are_also_required() {
        let tuple = level_patch_kirikiri_kag_plaintext();
        for field in ["claimedLevel", "evidence"] {
            let mut object = tuple_json(&tuple).as_object().expect("object").clone();
            object.remove(field);
            let result: Result<ClaimedSupportTuple, _> =
                serde_json::from_value(serde_json::Value::Object(object));
            assert!(result.is_err(), "missing {field} must fail deserialization");
        }
    }

    #[test]
    fn honest_catalogue_all_validates_green() {
        let report = validate_claimed_support_profile(&honest_catalogue());
        assert_eq!(report.status, OperationStatus::Passed, "{report:#?}");
        assert_eq!(report.overclaim_count, 0);
        assert_eq!(report.honest_count, report.tuple_count);
    }

    #[test]
    fn siglus_validates_at_extract_not_patch() {
        let entry = validate_claimed_support_tuple(&level_extract_siglus());
        assert!(entry.is_honest());
        assert_eq!(entry.claimed_level, ClaimedSupportLevel::Extract);
        // Honest posture: patch-back is declared not-implemented and NOT claimed.
        assert!(!entry.claimed_level.claims_patch_back());
        assert!(
            entry
                .diagnostics
                .iter()
                .any(|d| d.layer == CompatLayer::PatchBack
                    && d.status == CompatDiagnosticStatus::NotImplemented)
        );
        assert!(!is_real_patch_back(entry.patch_back_mode));
    }

    #[test]
    fn plaintext_kag_is_loose_file_not_xp3() {
        let entry = validate_claimed_support_tuple(&level_patch_kirikiri_kag_plaintext());
        assert!(entry.is_honest());
        assert_eq!(
            entry.engine_family,
            CompatEngineFamily::KirikiriKagPlaintext
        );
        assert_eq!(entry.container, ContainerTransform::LooseFile);
        assert_ne!(entry.container, ContainerTransform::Xp3);
        assert!(entry.claimed_level.claims_patch_back());
    }

    #[test]
    fn encrypted_asset_patch_carries_secret_requirement() {
        let entry = validate_claimed_support_tuple(&patch_rpg_maker_encrypted_asset());
        assert!(entry.is_honest());
        assert_eq!(entry.secret_requirement_ids.len(), 1);
        assert_eq!(
            entry.secret_requirement_ids[0].requirement_id,
            "rpg_maker.mv.encryption-key"
        );
        // Secret is a ref, never raw material.
        assert!(
            entry.secret_requirement_ids[0]
                .secret_ref
                .as_str()
                .starts_with("local-secret:")
        );
    }

    #[test]
    fn anti_overclaim_patch_without_evidence_fails() {
        let entry = validate_claimed_support_tuple(&overclaim_patch_without_evidence());
        assert_eq!(entry.status, OperationStatus::Failed);
        // Blocking evidence-missing diagnostics on every required leg + the
        // not-implemented patch-back mode.
        let blocking: Vec<&CompatDiagnostic> = entry
            .diagnostics
            .iter()
            .filter(|d| d.is_blocking())
            .collect();
        assert!(!blocking.is_empty());
        assert!(
            blocking
                .iter()
                .any(|d| d.status == CompatDiagnosticStatus::EvidenceMissing)
        );
        assert!(blocking.iter().any(|d| d.layer == CompatLayer::PatchBack));
        // The aggregate report flips to Failed and counts the overclaim.
        let report = validate_claimed_support_profile(&[overclaim_patch_without_evidence()]);
        assert_eq!(report.status, OperationStatus::Failed);
        assert_eq!(report.overclaim_count, 1);
    }

    #[test]
    fn anti_overclaim_patch_missing_one_leg_fails() {
        // Full mode + extraction + patch_back but MISSING validation → still an
        // overclaim (the chain must be complete).
        let mut tuple = level_patch_kirikiri_kag_plaintext();
        tuple.evidence.validation = None;
        let entry = validate_claimed_support_tuple(&tuple);
        assert_eq!(entry.status, OperationStatus::Failed);
        assert!(
            entry
                .diagnostics
                .iter()
                .any(|d| d.status == CompatDiagnosticStatus::EvidenceMissing
                    && d.layer == CompatLayer::Evidence)
        );
    }

    #[test]
    fn unknown_variant_is_explicit_typed_diagnostic_not_broad_string() {
        let mut tuple = level_identify();
        tuple.engine_family = CompatEngineFamily::Unknown;
        let entry = validate_claimed_support_tuple(&tuple);
        assert_eq!(entry.status, OperationStatus::Failed);
        let diag = entry
            .diagnostics
            .iter()
            .find(|d| d.status == CompatDiagnosticStatus::UnknownVariant)
            .expect("unknown variant emits a typed diagnostic");
        assert_eq!(diag.layer, CompatLayer::Variant);
        assert_eq!(diag.reason_id, SemanticErrorCode::UnknownEngineVariant);
        assert!(diag.is_blocking());
        // Honesty: every diagnostic carries a typed (layer, status, reasonId),
        // and NO diagnostic status is the broad "unsupported" string — the
        // status enum has no such variant (`not_implemented` etc. state why).
        for d in &entry.diagnostics {
            let status = d.status.as_str();
            assert_ne!(status, "unsupported", "diagnostic status must be specific");
            assert!(!d.reason_id.as_str().is_empty());
        }
        // The serialized diagnostics never carry a bare "unsupported" status.
        let json = validate_claimed_support_profile(&[tuple])
            .stable_json()
            .expect("report serializes");
        assert!(
            !json.contains("\"status\":\"unsupported\""),
            "diagnostics must use typed statuses, not a broad 'unsupported' string"
        );
    }

    #[test]
    fn report_is_redacted_and_ref_only() {
        let report = validate_claimed_support_profile(&honest_catalogue());
        let json = report.stable_json().expect("serialize");
        // No raw key material — only local-scheme refs.
        assert!(!json.contains("BEGIN"));
        assert!(json.contains("local-secret:"));
        // Evidence is proof-hash refs only.
        assert!(json.contains("sha256:"));
    }

    #[test]
    fn identify_and_inventory_need_no_evidence() {
        for tuple in [level_identify(), level_inventory()] {
            let entry = validate_claimed_support_tuple(&tuple);
            assert!(entry.is_honest(), "{entry:?}");
            assert!(entry.evidence == SupportEvidence::none());
        }
    }

    #[test]
    fn runtime_level_requires_runtime_evidence_leg() {
        // Drop the runtime leg from the runtime fixture → overclaim.
        let mut tuple = level_runtime_synthetic();
        tuple.evidence.runtime = None;
        let entry = validate_claimed_support_tuple(&tuple);
        assert_eq!(entry.status, OperationStatus::Failed);
        assert!(
            entry
                .diagnostics
                .iter()
                .any(|d| d.layer == CompatLayer::Runtime
                    && d.status == CompatDiagnosticStatus::EvidenceMissing)
        );
    }
}
