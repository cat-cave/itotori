//! Alpha public encrypted-readiness evidence generator.
//! This module COMPOSES the packed-engine readiness validator
//! ([`crate::packed_engine_readiness`]) — it does NOT reimplement readiness
//! logic. The generator reads a single *alpha-encrypted fixture directory*
//! that holds two synthetic, public input families:
//! 1. packed-engine readiness **profile fixtures** (`*.profile.json`, the exact
//!    [`PackedEngineReadinessProfile`] schema), and
//! 2. synthetic **patch artifacts** (`*.patch.json`, [`AlphaEncryptedPatchArtifact`])
//!    that pair a `profileId` with a hash-only patch-result reference.
//!    It runs [`validate_packed_engine_readiness_dir`] over the directory to
//!    obtain the [`PackedReadinessValidationReport`], then joins each
//!    validated profile entry with its patch artifact to emit an
//!    [`AlphaEncryptedReadinessReport`] — readiness EVIDENCE, never a production
//!    patch-support claim.
//! # The mechanical line (not prose)
//! The profile-ready-vs-readiness-only posture is taken VERBATIM from the
//! validator's mechanically-derived
//! [`PackedReadinessOutcome`]/[`PackedReadinessPosture`]; this layer never
//! re-derives it. On top of that, the generator enforces three mechanical
//! join rules, each a structured [`AlphaEncryptedFinding`], never prose:
//! - a profile-ready entry whose effective outcome reaches `extract`/`patch`
//!   MUST carry a patch-result reference (`patch_result_ref_missing` otherwise);
//! - a readiness-only entry MUST NOT carry a patch-result reference
//!   (`readiness_only_claims_patch` otherwise — this is the
//!   "readiness overstated as production support" guard);
//! - every validation failure for a profile propagates as a blocking
//!   `validation_failed` finding (the generator can never bless a profile the
//!   validator rejected).
//! # Evidence is synthetic, redacted, hash-only
//! Inputs and outputs carry NO raw retail bytes, NO raw key material, NO
//! decrypted scripts, NO helper dumps, and NO private paths: only synthetic
//! profile/fixture/helper ids, local-scheme [`SecretRef`] key references, and
//! `sha256:` content/output/report hashes. Reports are funnelled through
//! [`redact_for_log_or_report`]. The README-safe
//! [`AlphaEncryptedReadinessSummary`] reduces further to aggregate counts,
//! covered engine families, and the report hash — it names no asset, helper,
//! key, or patch id at all.

use serde::{Deserialize, Serialize};

use crate::packed_engine_readiness::PackedTransformStack;
use crate::{
    CapabilityLevel, KaifuuResult, LayeredAccessHelperStatus, LayeredAccessKeyMaterialStatus,
    OperationStatus, PackedEngineFamily, PackedReadinessOutcome, PackedReadinessPosture,
    PartialDiagnosticSeverity, PatchBackTransform, ProofHash, SecretRef, SemanticErrorCode,
    redact_for_log_or_report, stable_json,
};

mod generator;

pub use generator::generate_alpha_encrypted_readiness;

#[cfg(test)]
use crate::packed_engine_readiness::{
    PackedReadinessEntryReport, validate_packed_engine_readiness_dir,
};
#[cfg(test)]
use crate::sha256_hash_bytes;
#[cfg(test)]
use generator::{build_entry, requires_patch_evidence};

/// Spec-DAG source node id stamped into generated reports and entries.
/// Kept here (not in the child module) so the grandfathered node-id token
/// stays on the whitelisted parent path only.
const ALPHA_ENCRYPTED_SOURCE_NODE_ID: &str = "KAIFUU-104";

/// Schema version of the synthetic patch-artifact input.
pub const ALPHA_ENCRYPTED_PATCH_ARTIFACT_SCHEMA_VERSION: &str = "0.1.0";
/// Schema version of the generated full evidence report.
pub const ALPHA_ENCRYPTED_READINESS_REPORT_SCHEMA_VERSION: &str = "0.1.0";
/// Schema version of the README-safe summary artifact.
pub const ALPHA_ENCRYPTED_READINESS_SUMMARY_SCHEMA_VERSION: &str = "0.1.0";

/// Glob the generator reads for synthetic patch artifacts.
pub const ALPHA_ENCRYPTED_PATCH_ARTIFACT_GLOB: &str = "*.patch.json";

/// The support boundary stamped into every report and summary — the
/// readiness-evidence-not-production-support line.
pub const ALPHA_ENCRYPTED_READINESS_SUPPORT_BOUNDARY: &str = "Alpha encrypted-readiness evidence composes the KAIFUU-103 packed-engine readiness validator output with synthetic packed-engine profile fixtures and synthetic patch artifacts. It is readiness EVIDENCE that a transform stack, key/helper gating, and patch-back surface are recognized — it is NOT a production patch-support claim. A readiness-only posture (helper-gated, missing key material, or media transform) never carries a patch result. Every input is synthetic and public; artifacts carry only ids, counts, and sha256 hashes — never key material, plaintext content, helper memory, or local paths.";

// Synthetic patch-artifact input

/// A synthetic, public patch artifact: a hash-only reference to a patch result
/// produced for one readiness profile. Carries NO patched bytes and NO
/// decrypted content — only the patch-result id, the touched synthetic asset
/// ids, and the `sha256:` output hash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AlphaEncryptedPatchArtifact {
    pub schema_version: String,
    /// Stable patch-result id (synthetic; no retail names or local paths).
    pub patch_result_id: String,
    /// The `profileId` of the readiness profile this patch result is for.
    pub profile_id: String,
    /// Provenance node id stamped into generated reports.
    pub source_node_id: String,
    /// Outcome of the synthetic patch run.
    pub status: OperationStatus,
    /// The patch-back transform exercised (must match the profile's).
    pub patch_back: PatchBackTransform,
    /// Synthetic in-archive asset ids the patch touched (never local paths).
    pub touched_assets: Vec<String>,
    /// `sha256:` hash of the synthetic patched output (never raw bytes).
    pub output_hash: ProofHash,
}

// Findings

/// A structured generator finding — never prose, never silent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlphaEncryptedFinding {
    pub code: String,
    pub severity: PartialDiagnosticSeverity,
    pub field: String,
    pub message: String,
    pub semantic_code: String,
}

impl AlphaEncryptedFinding {
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

pub(super) fn finding(
    code: &str,
    severity: PartialDiagnosticSeverity,
    field: &str,
    message: String,
    semantic_code: SemanticErrorCode,
) -> AlphaEncryptedFinding {
    AlphaEncryptedFinding {
        code: code.to_string(),
        severity,
        field: field.to_string(),
        message,
        semantic_code: semantic_code.as_str().to_string(),
    }
}

// Report

/// The hash-only patch-result reference carried by a profile-ready entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlphaEncryptedPatchResultRef {
    pub patch_result_id: String,
    pub status: OperationStatus,
    pub patch_back: PatchBackTransform,
    pub touched_asset_count: u64,
    pub output_hash: ProofHash,
}

impl AlphaEncryptedPatchResultRef {
    pub(super) fn from_artifact(artifact: &AlphaEncryptedPatchArtifact) -> Self {
        Self {
            patch_result_id: artifact.patch_result_id.clone(),
            status: artifact.status.clone(),
            patch_back: artifact.patch_back,
            touched_asset_count: artifact.touched_assets.len() as u64,
            output_hash: artifact.output_hash.clone(),
        }
    }

    fn redacted_for_report(&self) -> Self {
        Self {
            patch_result_id: redact_for_log_or_report(&self.patch_result_id),
            status: self.status.clone(),
            patch_back: self.patch_back,
            touched_asset_count: self.touched_asset_count,
            output_hash: self.output_hash.clone(),
        }
    }
}

/// One alpha-encrypted readiness evidence entry — the full acceptance tuple:
/// profile id, fixture id, engine family, surface ids, helper id, key ref,
/// capability levels, patch-result ref, diagnostics, and content hash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlphaEncryptedReadinessEntry {
    pub profile_id: String,
    pub fixture_id: String,
    pub source_node_id: String,
    pub engine_family: PackedEngineFamily,
    pub transform_stack: PackedTransformStack,
    /// Synthetic in-archive surface (asset) ids drawn from the profile content.
    pub surface_ids: Vec<String>,
    pub declared_capability: CapabilityLevel,
    /// The mechanically-derived outcome (taken verbatim).
    pub effective_outcome: PackedReadinessOutcome,
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
    /// Whether the validator passed this profile.
    pub validation_status: OperationStatus,
    /// Hash-only patch-result reference (present only for patch-capable
    /// profile-ready entries).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub patch_result: Option<AlphaEncryptedPatchResultRef>,
    pub status: OperationStatus,
    pub findings: Vec<AlphaEncryptedFinding>,
}

impl AlphaEncryptedReadinessEntry {
    pub(super) fn redacted_for_report(&self) -> Self {
        Self {
            profile_id: redact_for_log_or_report(&self.profile_id),
            fixture_id: redact_for_log_or_report(&self.fixture_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            engine_family: self.engine_family,
            transform_stack: self.transform_stack,
            surface_ids: self
                .surface_ids
                .iter()
                .map(|id| redact_for_log_or_report(id))
                .collect(),
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
            validation_status: self.validation_status.clone(),
            patch_result: self
                .patch_result
                .as_ref()
                .map(AlphaEncryptedPatchResultRef::redacted_for_report),
            status: self.status.clone(),
            findings: self
                .findings
                .iter()
                .map(AlphaEncryptedFinding::redacted_for_report)
                .collect(),
        }
    }
}

/// The mechanical proof that the validation report was consumed: its
/// status, posture counts, and a `sha256:` hash over its canonical
/// serialization.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumedValidationReport {
    pub schema_version: String,
    pub status: OperationStatus,
    pub profile_count: u64,
    pub profile_ready_count: u64,
    pub readiness_only_count: u64,
    pub report_hash: ProofHash,
}

/// The full alpha-encrypted readiness evidence report written to
/// `target/kaifuu/alpha-encrypted-readiness.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlphaEncryptedReadinessReport {
    pub schema_version: String,
    pub source_node_id: String,
    pub support_boundary: String,
    pub status: OperationStatus,
    /// Proof the validator output was consumed (not prose).
    pub consumed_validation: ConsumedValidationReport,
    pub profile_count: u64,
    pub profile_ready_count: u64,
    pub readiness_only_count: u64,
    pub patch_evidence_count: u64,
    pub entries: Vec<AlphaEncryptedReadinessEntry>,
    /// Report-level findings (dangling patch artifacts, missing inputs,...).
    pub findings: Vec<AlphaEncryptedFinding>,
    /// `sha256:` hash over the canonical serialization of the entries.
    pub report_hash: ProofHash,
}

impl AlphaEncryptedReadinessReport {
    pub fn entry(&self, profile_id: &str) -> Option<&AlphaEncryptedReadinessEntry> {
        self.entries
            .iter()
            .find(|entry| entry.profile_id == profile_id)
    }

    /// Sorted, distinct engine families covered (README-safe).
    pub fn covered_families(&self) -> Vec<PackedEngineFamily> {
        let mut families: Vec<PackedEngineFamily> =
            self.entries.iter().map(|e| e.engine_family).collect();
        families.sort();
        families.dedup();
        families
    }

    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            status: self.status.clone(),
            consumed_validation: self.consumed_validation.clone(),
            profile_count: self.profile_count,
            profile_ready_count: self.profile_ready_count,
            readiness_only_count: self.readiness_only_count,
            patch_evidence_count: self.patch_evidence_count,
            entries: self
                .entries
                .iter()
                .map(AlphaEncryptedReadinessEntry::redacted_for_report)
                .collect(),
            findings: self
                .findings
                .iter()
                .map(AlphaEncryptedFinding::redacted_for_report)
                .collect(),
            report_hash: self.report_hash.clone(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }

    /// The README-safe summary: aggregate counts, covered families, and the
    /// report hash only. Names no asset, helper, key, or patch id.
    pub fn summary(&self) -> AlphaEncryptedReadinessSummary {
        AlphaEncryptedReadinessSummary {
            schema_version: ALPHA_ENCRYPTED_READINESS_SUMMARY_SCHEMA_VERSION.to_string(),
            source_node_id: self.source_node_id.clone(),
            support_boundary: self.support_boundary.clone(),
            evidence_kind: ALPHA_ENCRYPTED_EVIDENCE_KIND.to_string(),
            status: self.status.clone(),
            profile_count: self.profile_count,
            profile_ready_count: self.profile_ready_count,
            readiness_only_count: self.readiness_only_count,
            patch_evidence_count: self.patch_evidence_count,
            covered_engine_families: self
                .covered_families()
                .iter()
                .map(|family| family.as_str().to_string())
                .collect(),
            report_hash: self.report_hash.clone(),
        }
    }
}

/// The fixed evidence-kind discriminator stamped into the summary so README
/// consumers can never mistake it for a production support matrix.
pub const ALPHA_ENCRYPTED_EVIDENCE_KIND: &str = "readiness_evidence";

/// README-safe summary artifact written to
/// `target/kaifuu/alpha-encrypted-readiness.summary.json`. Carries ONLY
/// aggregate counts, covered engine families, and the report hash — no asset,
/// helper, key, or patch ids, no paths, no source text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlphaEncryptedReadinessSummary {
    pub schema_version: String,
    pub source_node_id: String,
    pub support_boundary: String,
    /// Always `readiness_evidence` — distinguishes evidence from production
    /// support.
    pub evidence_kind: String,
    pub status: OperationStatus,
    pub profile_count: u64,
    pub profile_ready_count: u64,
    pub readiness_only_count: u64,
    pub patch_evidence_count: u64,
    pub covered_engine_families: Vec<String>,
    pub report_hash: ProofHash,
}

impl AlphaEncryptedReadinessSummary {
    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            evidence_kind: self.evidence_kind.clone(),
            status: self.status.clone(),
            profile_count: self.profile_count,
            profile_ready_count: self.profile_ready_count,
            readiness_only_count: self.readiness_only_count,
            patch_evidence_count: self.patch_evidence_count,
            covered_engine_families: self.covered_engine_families.clone(),
            report_hash: self.report_hash.clone(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

#[cfg(test)]
#[path = "alpha_encrypted_readiness_tests.rs"]
mod tests;
