//! Alpha packed/encrypted-engine readiness-PROFILE subset.
//! This module is the *profile* half of the alpha packed-engine readiness
//! story. Where ([`crate::packed_engine_readiness`]) is the reusable
//! per-fixture transform-stack *validator*, and
//! ([`crate::alpha_encrypted_readiness`]) is the *evidence* generator that joins
//! validated profiles with synthetic patch artifacts, owns the small
//! curated subset of high-value packed/encrypted engines whose prerequisite
//! proof nodes exist and states — per engine, per operation — the alpha
//! capability level plus the helper/key gating.
//! It ships three deliverables, all built on the SHARED vocabulary (never
//! reimplemented):
//! 1. a **template** ([`alpha_readiness_profile_template`]) — the canonical,
//!    validation-passing skeleton an author copies to declare a new engine;
//! 2. **seeds** ([`alpha_readiness_seeds`]) for the five subset engines —
//!    Siglus, KiriKiri XP3, Wolf RPG Editor, RPG Maker VX Ace / RGSS3, and
//!    BGI / Ethornell; and
//! 3. an **alpha capability-level summary renderer**
//!    ([`render_alpha_capability_summary`] + [`AlphaCapabilitySummary`]).
//! # The five operations (identify / inventory / extract / patch / helper-key)
//! Each profile states, for the four capability rungs
//! ([`crate::CapabilityLevel`]) via an [`crate::AdapterCapabilityMatrix`], a
//! per-operation [`crate::CapabilityLevelStatus`] (supported / partial /
//! unsupported), plus a fifth **helper-key** posture
//! ([`AlphaHelperKeyStatus`]) that records the key-material and helper gating.
//! The renderer surfaces all five for every engine.
//! # Honest ceilings — BGI / Ethornell is detector/profile-only
//! The alpha subset applies a STRICTER ceiling than the engine spec.
//! BGI / Ethornell readiness is limited to detector/profile evidence (from the
//! detection node): its seed claims `identify` only and marks
//! inventory / extract / patch `unsupported`. It never claims an archive parser
//! or patch support — the honest ceiling, below even the family
//! spec's theoretical ceiling.
//! # Unknown / out-of-profile vs. in-profile BUG (the mechanical distinction)
//! Validation classifies every finding with a [`ReadinessFailureClass`]:
//! - [`ReadinessFailureClass::OutOfProfile`] — a semantic boundary that is NOT a
//!   defect: an unknown engine family, or a claim that reaches PAST the engine
//!   family's theoretical ceiling. An honestly-`unsupported` rung is
//!   the profile's declared boundary and produces NO finding at all.
//! - [`ReadinessFailureClass::InProfileBug`] — a defect INSIDE claimed support:
//!   a rung the profile claims (`supported`/`partial`) whose required backing
//!   field (fixture, key, helper, patch-back, provenance) is missing or
//!   inconsistent.
//!   Both classes fail the profile, but the class is recorded so a genuine
//!   not-yet-supported boundary is never confused with a broken claim.
//! # Evidence is synthetic, redacted, ref-only
//! Profiles carry NO raw key material, NO private asset paths, NO decrypted
//! scripts, NO helper dumps, and NO story filenames: only synthetic
//! profile/fixture ids, a local-scheme [`crate::SecretRef`] key reference, a
//! helper id, and — optionally — a hash/id-only reference to a private-local
//! aggregate report (never a path). Reports and the rendered summary are
//! funnelled through [`crate::redact_for_log_or_report`].

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::{
    AdapterCapabilityMatrix, CapabilityLevel, KaifuuResult, LayeredAccessHelperStatus,
    LayeredAccessKeyMaterialStatus, OperationStatus, PackedEngineFamily, PartialDiagnosticSeverity,
    PatchBackTransform, SecretRef, SemanticErrorCode, redact_for_log_or_report, stable_json,
};

mod seed_profiles;
mod validate;

pub use seed_profiles::{
    alpha_readiness_profile_template, alpha_readiness_seed_bgi, alpha_readiness_seed_kirikiri_xp3,
    alpha_readiness_seed_rgss3, alpha_readiness_seed_siglus, alpha_readiness_seed_wolf,
    alpha_readiness_seeds,
};
pub use validate::validate_alpha_readiness_profile;

/// Schema version of the profile input. Bumped on any breaking field change.
pub const ALPHA_READINESS_PROFILE_SCHEMA_VERSION: &str = "0.1.0";
/// Schema version of the rendered capability summary.
pub const ALPHA_READINESS_SUMMARY_SCHEMA_VERSION: &str = "0.1.0";
/// Provenance node id stamped into every seed/template report.
pub const ALPHA_READINESS_SOURCE_NODE_ID: &str = "KAIFUU-056";
/// Canonical profile-fixture glob the subset consumes.
pub const ALPHA_READINESS_PROFILE_GLOB: &str = "*.profile.json";

/// The support boundary surfaced in the rendered summary.
pub const ALPHA_READINESS_SUPPORT_BOUNDARY: &str = "The alpha readiness-profile subset states, per high-value packed/encrypted engine and per operation (identify, inventory, extract, patch, helper-key), the alpha capability level and helper/key gating. A rung is claimed only up to the engine's honest alpha ceiling — BGI / Ethornell is detector/profile-only and never claims an archive parser or patch support. An honestly-unsupported rung is the declared boundary, not a defect; a claimed rung missing its backing field is an in-profile bug. Profiles are generated from public synthetic fixtures and may be supplemented by a hash-only reference to a private-local aggregate report. No raw key material, private asset paths, decrypted scripts, helper dumps, or story filenames are ever serialized.";

// Profile input schema

/// The helper/key gating posture — the fifth "operation" every profile states.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AlphaHelperKeyStatus {
    pub key_status: LayeredAccessKeyMaterialStatus,
    /// Local-scheme reference to the key material (never raw key bytes).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_ref: Option<SecretRef>,
    pub helper_status: LayeredAccessHelperStatus,
    /// Stable helper id (never a local path / binary / memory dump).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helper_id: Option<String>,
}

impl AlphaHelperKeyStatus {
    /// A profile that needs neither key material nor a helper.
    pub fn none_required() -> Self {
        Self {
            key_status: LayeredAccessKeyMaterialStatus::NotRequired,
            key_ref: None,
            helper_status: LayeredAccessHelperStatus::NotRequired,
            helper_id: None,
        }
    }

    /// A profile whose key material is resolved (characterized), no helper.
    pub fn resolved_key(key_ref: SecretRef) -> Self {
        Self {
            key_status: LayeredAccessKeyMaterialStatus::Resolved,
            key_ref: Some(key_ref),
            helper_status: LayeredAccessHelperStatus::NotRequired,
            helper_id: None,
        }
    }

    fn redacted_for_report(&self) -> Self {
        Self {
            key_status: self.key_status,
            key_ref: self.key_ref.clone(),
            helper_status: self.helper_status,
            helper_id: self.helper_id.as_deref().map(redact_for_log_or_report),
        }
    }
}

/// How a profile was generated. Public-synthetic is the baseline; a private
/// aggregate may SUPPLEMENT it via a hash/id-only reference (never a path).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AlphaReadinessProvenance {
    /// `true` when the profile was generated from committed public synthetic
    /// fixtures.
    pub from_public_synthetic_fixture: bool,
    /// Optional hash/id-only reference to a private-local aggregate report that
    /// supplements the public fixture. Never a filesystem path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_aggregate_ref: Option<String>,
}

impl AlphaReadinessProvenance {
    pub fn public_synthetic() -> Self {
        Self {
            from_public_synthetic_fixture: true,
            private_aggregate_ref: None,
        }
    }

    /// A public profile SUPPLEMENTED by a private-local aggregate (ref-only).
    pub fn supplemented(private_aggregate_ref: impl Into<String>) -> Self {
        Self {
            from_public_synthetic_fixture: true,
            private_aggregate_ref: Some(private_aggregate_ref.into()),
        }
    }

    fn redacted_for_report(&self) -> Self {
        Self {
            from_public_synthetic_fixture: self.from_public_synthetic_fixture,
            private_aggregate_ref: self
                .private_aggregate_ref
                .as_deref()
                .map(redact_for_log_or_report),
        }
    }
}

/// One alpha readiness profile: the per-operation capability posture of a single
/// packed/encrypted engine in the alpha subset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AlphaReadinessProfile {
    pub schema_version: String,
    /// Stable profile id (synthetic; no retail names or local paths).
    pub profile_id: String,
    /// Stable id of the backing public synthetic fixture.
    pub fixture_id: String,
    /// Provenance node id stamped into generated reports.
    pub source_node_id: String,
    /// The prerequisite proof-node/artifact this subset entry relies on.
    pub prerequisite_proof: String,
    pub engine_family: PackedEngineFamily,
    /// Per-operation capability posture (identify / inventory / extract /
    /// patch). `adapterId` is a synthetic engine id, never a path.
    pub capabilities: AdapterCapabilityMatrix,
    /// The fifth operation: helper/key gating.
    pub helper_key: AlphaHelperKeyStatus,
    /// The patch-back write mode. A claimed `patch` rung REQUIRES a real write
    /// mode ([`PatchBackTransform::RepackArchive`]); otherwise `Unsupported`.
    pub patch_back: PatchBackTransform,
    pub provenance: AlphaReadinessProvenance,
}

impl AlphaReadinessProfile {
    pub(super) fn synthetic_adapter_id(family: PackedEngineFamily) -> String {
        format!("kaifuu.packed.{}", family.as_str())
    }
}

// Findings + failure classification (the mechanical distinction)

/// Distinguishes an unknown / out-of-profile semantic boundary from a defect
/// inside a claimed-support profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadinessFailureClass {
    /// A semantic boundary that is NOT a defect (unknown engine, a claim past
    /// the engine family's theoretical ceiling).
    OutOfProfile,
    /// A defect inside claimed support (a claimed rung missing its backing).
    InProfileBug,
}

impl ReadinessFailureClass {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OutOfProfile => "out_of_profile",
            Self::InProfileBug => "in_profile_bug",
        }
    }
}

/// A structured validation finding — never prose, never silent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlphaReadinessFinding {
    pub code: String,
    pub severity: PartialDiagnosticSeverity,
    pub failure_class: ReadinessFailureClass,
    pub field: String,
    pub message: String,
    pub semantic_code: String,
}

impl AlphaReadinessFinding {
    fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            severity: self.severity,
            failure_class: self.failure_class,
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
            semantic_code: self.semantic_code.clone(),
        }
    }
}

// Per-profile validation entry

/// Per-operation status snapshot as recorded in the entry (the rendered row).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlphaOperationStatuses {
    pub identify: String,
    pub inventory: String,
    pub extract: String,
    pub patch: String,
    /// Combined helper-key posture kind (e.g. `resolved/not_required`).
    pub helper_key: String,
}

impl AlphaOperationStatuses {
    fn from(matrix: &AdapterCapabilityMatrix, helper_key: &AlphaHelperKeyStatus) -> Self {
        Self {
            identify: matrix.identify.kind_str().to_string(),
            inventory: matrix.inventory.kind_str().to_string(),
            extract: matrix.extract.kind_str().to_string(),
            patch: matrix.patch.kind_str().to_string(),
            helper_key: format!(
                "{}/{}",
                key_status_str(helper_key.key_status),
                helper_status_str(helper_key.helper_status)
            ),
        }
    }
}

fn key_status_str(status: LayeredAccessKeyMaterialStatus) -> &'static str {
    match status {
        LayeredAccessKeyMaterialStatus::NotRequired => "not_required",
        LayeredAccessKeyMaterialStatus::Resolved => "resolved",
        LayeredAccessKeyMaterialStatus::Missing => "missing",
        LayeredAccessKeyMaterialStatus::HelperGated => "helper_gated",
    }
}

fn helper_status_str(status: LayeredAccessHelperStatus) -> &'static str {
    match status {
        LayeredAccessHelperStatus::NotRequired => "not_required",
        LayeredAccessHelperStatus::Available => "available",
        LayeredAccessHelperStatus::Unavailable => "unavailable",
    }
}

#[path = "alpha_readiness_profile/report.rs"]
mod report;
pub use report::*;

#[cfg(test)]
#[path = "alpha_readiness_profile/tests.rs"]
mod tests;
