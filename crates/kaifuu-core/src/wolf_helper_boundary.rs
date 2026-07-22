//! Wolf RPG Editor key/protection helper BOUNDARY as a local-only
//! [`HelperResult`] (the helper-result schema).
//! The Wolf protection detector
//! ([`crate::wolf_protection_detector`]) classifies a `.wolf`/DXArchive-family
//! container into a plain, protected, helper-required, or unknown protection
//! profile. Two of those profiles are **keyRef-bound** — they name a concrete
//! secret the archive is gated by:
//! - [`WolfProtectionProfile::Protected`] — an encrypted DX archive gated by a
//!   known/static archive key that is imported LOCALLY (no untrusted code runs).
//! - [`WolfProtectionProfile::HelperRequired`] — a Wolf "Pro" per-game dynamic
//!   key that a LOCAL dynamic-key helper must recover before extraction.
//!   This node represents the **helper BOUNDARY** for those keyRef-bound profiles:
//!   given a keyRef-bound Wolf protection profile, [`resolve_wolf_helper_boundary`]
//!   produces a LOCAL-ONLY [`HelperResult`] that carries the secret **REFS**
//!   ([`HelperResultSecretRef`] — requirement id + local-scheme [`SecretRef`],
//!   never the key bytes), the proof hashes, and a redacted diagnostic. It NEVER
//!   runs the helper and NEVER emits raw key material — the key is resolved by ref
//!   locally, mirroring the XP3 crypt secret-ref discipline.
//! # The mechanical line (computed, never asserted)
//! [`derive_wolf_helper_boundary_outcome`] is the single source of truth. The
//! outcome is a pure function of the boundary kind (static-key local import vs
//! dynamic-key local helper) and whether the secret is locally available:
//! - `StaticKeyLocalImport` + available → `KeyResolved` (`success`)
//! - `StaticKeyLocalImport` + unavailable → `KeyMissing` (`missing_key`)
//! - `DynamicKeyLocalHelper` + available → `HelperRequired` (resolvable, unrun)
//! - `DynamicKeyLocalHelper` + unavailable → `HelperUnavailable`
//! # Engine-general (Wolf = data, no per-game branch)
//! A [`WolfHelperBoundaryProfile`] is pure DATA: a boundary kind, a keyRef
//! binding (requirement id + local-scheme secret ref + material kind), and a
//! local-availability flag. The resolver has no per-game branch; every Wolf
//! game is a data-driven profile.
//! # Evidence is synthetic, redacted, ref-only
//! Fixtures carry NO retail bytes and NO raw key material: only the local-scheme
//! secret refs, stable requirement ids, and sha256 proof hashes. Every emitted
//! [`HelperResult`] is funnelled through [`HelperResult::redacted_for_report`]
//! and validated against the schema via
//! [`validate_helper_result_value`].

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::wolf_protection_detector::{WOLF_ENGINE_FAMILY, WolfProtectionProfile};
use crate::{
    HELPER_RESULT_SCHEMA_VERSION, HelperCapabilityLevel, HelperDiagnostic, HelperDiagnosticCode,
    HelperExecutionFilesystemAccess, HelperExecutionSummary, HelperKind, HelperProvenance,
    HelperRedaction, HelperRedactionStatus, HelperResult, HelperResultExecutionMode,
    HelperResultSecretRef, KaifuuResult, KeyMaterialKind, KeyValidationMethod, KeyValidationProof,
    OperationStatus, ProofHash, SecretRef, read_json, redact_for_log_or_report, sha256_hash_bytes,
    stable_json, validate_helper_result_value,
};

/// Schema version of the helper-boundary fixture input.
pub const WOLF_HELPER_BOUNDARY_SCHEMA_VERSION: &str = "0.1.0";
/// Schema version of the generated helper-boundary report.
pub const WOLF_HELPER_BOUNDARY_REPORT_SCHEMA_VERSION: &str = "0.1.0";

/// The support boundary surfaced in every Wolf helper-boundary report.
pub const WOLF_HELPER_BOUNDARY_SUPPORT_BOUNDARY: &str = "The Wolf key/protection helper boundary turns a keyRef-bound Wolf protection profile (protected static-key or helper-required Wolf \"Pro\" per-game dynamic-key) into a LOCAL-ONLY KAIFUU-085 helper result. It resolves the key BY REF locally — carrying the secret-requirement ids, local-scheme secret refs, sha256 proof hashes, and a redacted diagnostic — and NEVER runs the helper, launches untrusted code, or emits raw key material. Plain and unknown protection profiles are not keyRef-bound and have no helper boundary.";

// The boundary kind (which keyRef-bound Wolf protection profile)

/// Which keyRef-bound Wolf protection profile this helper boundary serves. Each
/// kind maps 1:1 to a [`WolfProtectionProfile`] and fixes the
/// local-only helper path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WolfHelperBoundaryKind {
    /// A [`WolfProtectionProfile::Protected`] archive gated by a known/static
    /// key imported locally (a [`HelperKind::KnownKeyDatabaseImport`] path).
    StaticKeyLocalImport,
    /// A [`WolfProtectionProfile::HelperRequired`] Wolf "Pro" per-game dynamic
    /// key recovered by a LOCAL dynamic-key helper (a
    /// [`HelperKind::WineLocalWindowsHelper`] path — never run at the boundary).
    DynamicKeyLocalHelper,
}

impl WolfHelperBoundaryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::StaticKeyLocalImport => "static_key_local_import",
            Self::DynamicKeyLocalHelper => "dynamic_key_local_helper",
        }
    }

    /// The Wolf protection profile this boundary serves.
    pub fn protection_profile(self) -> WolfProtectionProfile {
        match self {
            Self::StaticKeyLocalImport => WolfProtectionProfile::Protected,
            Self::DynamicKeyLocalHelper => WolfProtectionProfile::HelperRequired,
        }
    }

    /// The helper kind for this local-only boundary path.
    pub fn helper_kind(self) -> HelperKind {
        match self {
            Self::StaticKeyLocalImport => HelperKind::KnownKeyDatabaseImport,
            Self::DynamicKeyLocalHelper => HelperKind::WineLocalWindowsHelper,
        }
    }

    /// The capability level for this local-only boundary path.
    pub fn capability_level(self) -> HelperCapabilityLevel {
        match self {
            Self::StaticKeyLocalImport => HelperCapabilityLevel::LocalKeyImport,
            Self::DynamicKeyLocalHelper => HelperCapabilityLevel::WineLocal,
        }
    }

    /// The execution mode. Neither path runs at the boundary: the
    /// static import is `not_executed`; the dynamic helper resolves the
    /// `platform_helper` plan with `durationMs: 0` (never launched).
    pub fn execution_mode(self) -> HelperResultExecutionMode {
        match self {
            Self::StaticKeyLocalImport => HelperResultExecutionMode::NotExecuted,
            Self::DynamicKeyLocalHelper => HelperResultExecutionMode::PlatformHelper,
        }
    }

    fn execution_platform(self) -> &'static str {
        match self {
            Self::StaticKeyLocalImport => "wolf-local-key-store",
            Self::DynamicKeyLocalHelper => "wolf-wine-local",
        }
    }

    fn filesystem_access(self) -> HelperExecutionFilesystemAccess {
        match self {
            // A local key-store import reads only its own key store.
            Self::StaticKeyLocalImport => HelperExecutionFilesystemAccess::ReadOnlyWorkspace,
            // A dynamic helper reads the local game copy read-only.
            Self::DynamicKeyLocalHelper => HelperExecutionFilesystemAccess::LocalGameReadOnly,
        }
    }

    fn timeout_ms(self) -> u32 {
        match self {
            Self::StaticKeyLocalImport => 1000,
            Self::DynamicKeyLocalHelper => 5000,
        }
    }
}

// The boundary outcome (the mechanical classification)

/// The mechanically-derived helper-boundary outcome — the four local-only
/// results this node distinguishes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WolfHelperBoundaryOutcome {
    /// The static key resolved locally by ref: a `success` result carrying a
    /// validated secret ref + proof hash.
    KeyResolved,
    /// The static key is not available in the local store: a `missing_key`
    /// result naming the concrete requirement id.
    KeyMissing,
    /// The dynamic-key helper is resolvable locally but not run at the boundary:
    /// a `helper_required` result naming the pending requirement.
    HelperRequired,
    /// The local dynamic-key helper platform is unavailable: a
    /// `helper_unavailable` result naming the pending requirement.
    HelperUnavailable,
}

impl WolfHelperBoundaryOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::KeyResolved => "key_resolved",
            Self::KeyMissing => "key_missing",
            Self::HelperRequired => "helper_required",
            Self::HelperUnavailable => "helper_unavailable",
        }
    }

    /// The diagnostic code for this outcome.
    pub fn diagnostic_code(self) -> HelperDiagnosticCode {
        match self {
            Self::KeyResolved => HelperDiagnosticCode::Success,
            Self::KeyMissing => HelperDiagnosticCode::MissingKey,
            Self::HelperRequired => HelperDiagnosticCode::HelperRequired,
            Self::HelperUnavailable => HelperDiagnosticCode::HelperUnavailable,
        }
    }

    /// True iff the outcome recovered validated key material (only `key_resolved`
    /// carries a validation proof).
    pub fn recovered_key(self) -> bool {
        matches!(self, Self::KeyResolved)
    }
}

/// Classify a Wolf helper boundary into its local-only outcome. Total, pure,
/// side-effect-free — the single source of truth exercised by the tests.
/// `locally_available` is interpreted per kind: for a static-key local import it
/// is whether the key material exists in the local store; for a dynamic-key
/// local helper it is whether the local helper platform is available.
pub fn derive_wolf_helper_boundary_outcome(
    kind: WolfHelperBoundaryKind,
    locally_available: bool,
) -> WolfHelperBoundaryOutcome {
    match (kind, locally_available) {
        (WolfHelperBoundaryKind::StaticKeyLocalImport, true) => {
            WolfHelperBoundaryOutcome::KeyResolved
        }
        (WolfHelperBoundaryKind::StaticKeyLocalImport, false) => {
            WolfHelperBoundaryOutcome::KeyMissing
        }
        (WolfHelperBoundaryKind::DynamicKeyLocalHelper, true) => {
            WolfHelperBoundaryOutcome::HelperRequired
        }
        (WolfHelperBoundaryKind::DynamicKeyLocalHelper, false) => {
            WolfHelperBoundaryOutcome::HelperUnavailable
        }
    }
}

// The keyRef binding + the boundary profile (fixture input)

/// The keyRef binding a keyRef-bound Wolf protection profile carries: the stable
/// requirement id, the local-scheme [`SecretRef`] the key is resolved by, and
/// the key material kind. NEVER the key bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WolfHelperKeyRequirement {
    /// Stable id of the key requirement (never raw key bytes).
    pub requirement_id: String,
    /// Local-scheme reference to the key material (never raw key bytes).
    pub key_ref: SecretRef,
    /// The material kind (e.g. archive password / fixed bytes).
    pub material_kind: KeyMaterialKind,
}

/// One synthetic keyRef-bound Wolf helper-boundary profile — pure data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WolfHelperBoundaryProfile {
    /// Stable public fixture id.
    pub fixture_id: String,
    /// Stable helper-boundary profile id (a single-token identifier).
    pub profile_id: String,
    /// Which keyRef-bound protection profile this boundary serves.
    pub boundary_kind: WolfHelperBoundaryKind,
    /// The keyRef binding (requirement id + local-scheme secret ref + kind).
    pub key_requirement: WolfHelperKeyRequirement,
    /// Whether the secret is locally available (key material present for a
    /// static import; helper platform present for a dynamic helper).
    pub locally_available: bool,
    /// The outcome this profile is authored to resolve to. The resolver
    /// recomputes it from evidence and raises a finding on a mismatch.
    pub expected_outcome: WolfHelperBoundaryOutcome,
}

/// A Wolf helper-boundary fixture set — a small manifest of synthetic profiles.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WolfHelperBoundaryFixture {
    pub schema_version: String,
    /// Stable id for the fixture set (synthetic; no retail names/local paths).
    pub boundary_set_id: String,
    /// Provenance node id stamped into generated reports.
    pub source_node_id: String,
    pub engine_family: String,
    pub profiles: Vec<WolfHelperBoundaryProfile>,
}

// The generated report (per-profile local-only helper result)

/// One structured finding raised by the resolver (declared-vs-derived mismatch).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolfHelperBoundaryFinding {
    pub code: String,
    pub field: String,
    pub message: String,
}

impl WolfHelperBoundaryFinding {
    fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
        }
    }
}

/// The generated per-profile helper-boundary report. Echoes the acceptance
/// fields (profile id, boundary kind, protection profile, secret requirement
/// ids, proof hashes) and carries the derived local-only
/// [`HelperResult`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolfHelperBoundaryEntryReport {
    pub fixture_id: String,
    pub source_node_id: String,
    pub engine_family: String,
    pub profile_id: String,
    pub boundary_kind: WolfHelperBoundaryKind,
    pub protection_profile: WolfProtectionProfile,
    pub outcome: WolfHelperBoundaryOutcome,
    /// The secret requirement ids this profile names (redacted; never key bytes).
    pub secret_requirement_ids: Vec<String>,
    /// The sha256 validation proofs carried by the local-only helper result.
    pub proof_hashes: Vec<KeyValidationProof>,
    /// The local-only helper result (refs + redacted diagnostics).
    pub helper_result: HelperResult,
    pub status: OperationStatus,
    pub findings: Vec<WolfHelperBoundaryFinding>,
}

impl WolfHelperBoundaryEntryReport {
    pub(crate) fn redacted_for_report(&self) -> Self {
        Self {
            fixture_id: redact_for_log_or_report(&self.fixture_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            profile_id: redact_for_log_or_report(&self.profile_id),
            boundary_kind: self.boundary_kind,
            protection_profile: self.protection_profile,
            outcome: self.outcome,
            secret_requirement_ids: self
                .secret_requirement_ids
                .iter()
                .map(|id| redact_for_log_or_report(id))
                .collect(),
            proof_hashes: self.proof_hashes.clone(),
            helper_result: self.helper_result.redacted_for_report(),
            status: self.status.clone(),
            findings: self
                .findings
                .iter()
                .map(WolfHelperBoundaryFinding::redacted_for_report)
                .collect(),
        }
    }
}

/// The aggregate helper-boundary report over a fixture set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolfHelperBoundaryReport {
    pub schema_version: String,
    pub boundary_set_id: String,
    pub source_node_id: String,
    pub engine_family: String,
    pub support_boundary: String,
    pub status: OperationStatus,
    pub entries: Vec<WolfHelperBoundaryEntryReport>,
}

impl WolfHelperBoundaryReport {
    pub fn entry(&self, fixture_id: &str) -> Option<&WolfHelperBoundaryEntryReport> {
        self.entries
            .iter()
            .find(|entry| entry.fixture_id == fixture_id)
    }

    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            boundary_set_id: redact_for_log_or_report(&self.boundary_set_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            status: self.status.clone(),
            entries: self
                .entries
                .iter()
                .map(WolfHelperBoundaryEntryReport::redacted_for_report)
                .collect(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

#[path = "wolf_helper_boundary_resolver.rs"]
mod resolver;
pub use resolver::*;

#[cfg(test)]
#[path = "wolf_helper_boundary_tests.rs"]
mod tests;
