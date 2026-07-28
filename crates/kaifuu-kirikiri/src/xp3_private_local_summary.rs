//! the **private-local XP3 helper + patch summary** renderer.
//! # What this is
//! A local operator runs the profiled XP3 helper + patch-back flows against
//! their own private tree (the crypt smoke, the patch-back
//! smoke, and whatever local key helper resolved the archive password). Those
//! runs produce three already-safe, already-typed artifacts:
//! - a **helper-result aggregate** — a set of
//!   [`HelperResult`](kaifuu_core::HelperResult)s (ref + hash schema; the raw key
//!   never leaves the resolving helper), and
//! - a **support-tuple summary** — a set of
//!   [`ClaimedSupportTuple`](kaifuu_core::compat_profile::ClaimedSupportTuple)s
//!   declaring what the operator's XP3 posture actually claims, and
//! - zero or more **XP3 patch-back summaries**
//!   ([`Xp3PatchReport`](crate::Xp3PatchReport)).
//!   This module COMPOSES those into ONE redacted validation summary that exposes
//!   only **safe metadata** — profile ids, secret **requirement** ids, proof
//!   hashes, capability levels, statuses, counts, and typed diagnostics. It
//!   **never** carries a raw key, a private path, decrypted story text, a
//!   screenshot, retail bytes, or a raw helper dump.
//! # Redaction toggle + private-local law (mirrors /)
//! - The renderer's inputs are all synthetic-reproducible, already-redacted
//!   types. It does not read corpus contents, decrypt bytes, or shell out.
//! - Every private-local row is **optional**: rendering with empty helper /
//!   tuple / patch slices yields a valid, deterministic empty summary, so a
//!   private-local aggregate is never a public-CI dependency (the committed
//!   public-safe fixtures reproduce from the synthetic builders in this module).
//! - FAIL-LOUD: the fully-composed body is deep-scanned BEFORE it is returned.
//!   A seeded raw key, private path, decrypted/story text, screenshot filename,
//!   retail byte blob, or raw helper dump makes
//!   [`render_xp3_private_local_summary`] return `Err` — nothing is returned to
//!   persist. It rejects, it never silently scrubs.
//! - [`Xp3PrivateLocalSummary::stable_json`] additionally emits the summary
//!   through the [`redact_for_log_or_report`] boundary as belt-and-suspenders for
//!   the committed public frame.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use kaifuu_core::compat_profile::{
    ClaimedSupportEntryReport, ClaimedSupportLevel, ClaimedSupportTuple, CompatEngineFamily,
    validate_claimed_support_tuple,
};
use kaifuu_core::{
    HelperCapabilityLevel, HelperDiagnosticCode, HelperRedactionStatus, HelperResult, KaifuuResult,
    OperationStatus, PartialDiagnosticSeverity, PatchBackTransform, ProofHash,
    redact_for_log_or_report, stable_json, validate_secret_redaction_boundary,
};

use crate::Xp3PatchReport;

/// Schema version of the aggregate fixtures + rendered summary.
pub const XP3_PRIVATE_LOCAL_SUMMARY_SCHEMA_VERSION: &str = "0.1.0";

/// Every typed error's `Display` starts here so an audit can pin the module.
pub const XP3_PRIVATE_LOCAL_SUMMARY_MARKER: &str = "kaifuu.kirikiri.xp3_private_local_summary";

/// The blunt support boundary carried in every rendered summary.
pub const XP3_PRIVATE_LOCAL_SUMMARY_SUPPORT_BOUNDARY: &str = "Kaifuu KiriKiri XP3 private-local summary COMPOSES an operator's local helper-result aggregate (ref+hash HelperResults), support-tuple summary (validated ClaimedSupportTuples), and XP3 patch-back summaries into ONE redacted validation summary. It exposes ONLY safe metadata: profile ids, secret REQUIREMENT ids, proof hashes, capability levels, statuses, counts, and typed diagnostics. It NEVER carries secret key bytes, private paths, decrypted or story text, screenshots, retail bytes, or unredacted helper logs. Every private-local row is optional (an empty render is valid + deterministic), so a private-local aggregate is never a public-CI dependency. The composed body is deep-scanned before it is returned; any secret-shaped material fails the render loudly and nothing is returned to persist.";

/// Semantic code: the composed summary failed the fail-loud deep secret scan.
pub const SEMANTIC_XP3_PRIVATE_LOCAL_SUMMARY_SECRET_LEAK: &str =
    "kaifuu.kirikiri.xp3_private_local_summary.secret_leak";
/// Semantic code: a helper-result row failed validation.
pub const SEMANTIC_XP3_PRIVATE_LOCAL_SUMMARY_HELPER_INVALID: &str =
    "kaifuu.kirikiri.xp3_private_local_summary.helper_result_invalid";
/// Semantic code: a support tuple overclaimed / failed validation.
pub const SEMANTIC_XP3_PRIVATE_LOCAL_SUMMARY_TUPLE_OVERCLAIM: &str =
    "kaifuu.kirikiri.xp3_private_local_summary.support_tuple_overclaim";
/// Semantic code: an XP3 patch-back summary reported a failed round-trip.
pub const SEMANTIC_XP3_PRIVATE_LOCAL_SUMMARY_PATCH_FAILED: &str =
    "kaifuu.kirikiri.xp3_private_local_summary.patch_summary_failed";

// Input aggregate fixtures (synthetic, deserialized from committed JSON).

/// The **helper-result aggregate** fixture: a set of helper results
/// an operator's local key-helper runs produced. Carries only ref + hash
/// [`HelperResult`]s — never raw key material.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Xp3HelperResultAggregate {
    pub schema_version: String,
    pub aggregate_id: String,
    #[serde(default)]
    pub helper_results: Vec<HelperResult>,
}

/// The **support-tuple summary** fixture: a set of claimed-support
/// tuples declaring the operator's XP3 posture.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Xp3SupportTupleSummaryFixture {
    pub schema_version: String,
    pub summary_id: String,
    #[serde(default)]
    pub support_tuples: Vec<ClaimedSupportTuple>,
}

// Render input (borrowed slices; every leg is optional).

/// The already-loaded inputs to the renderer. Any slice may be empty — a
/// private-local row is never required, so an all-empty input renders a valid,
/// deterministic empty summary.
#[derive(Debug, Clone, Copy)]
pub struct Xp3PrivateLocalSummaryInput<'a> {
    pub summary_id: &'a str,
    pub helper_results: &'a [HelperResult],
    pub support_tuples: &'a [ClaimedSupportTuple],
    pub patch_reports: &'a [Xp3PatchReport],
}

// Rendered rows (safe metadata only).

/// One helper-result row: capability level, redaction posture, diagnostic code,
/// secret **requirement** ids, and proof hashes. Never a raw key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3HelperResultRow {
    pub helper_result_id: String,
    pub profile_id: String,
    pub capability_level: HelperCapabilityLevel,
    pub diagnostic_code: HelperDiagnosticCode,
    pub redaction_status: HelperRedactionStatus,
    pub secret_requirement_ids: Vec<String>,
    pub redacted_log_hash: ProofHash,
    pub proof_hashes: Vec<ProofHash>,
    /// schema validation status of the underlying helper result.
    pub validation_status: OperationStatus,
}

/// One support-tuple row: the claimed level, patch-back mode, secret
/// **requirement** ids, evidence proof hashes, honesty, and diagnostic count.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3SupportTupleRow {
    pub profile_or_fixture_id: String,
    pub engine_family: CompatEngineFamily,
    pub engine_variant: String,
    pub claimed_level: ClaimedSupportLevel,
    pub patch_back_mode: PatchBackTransform,
    pub secret_requirement_ids: Vec<String>,
    pub evidence_proof_hashes: Vec<ProofHash>,
    pub honest: bool,
    pub status: OperationStatus,
    pub diagnostic_count: u64,
}

/// One XP3 patch-back summary row: patch-back mode, coverage counts, identity
/// hashes, and the verification proof. Never a member's plaintext.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3PatchSummaryRow {
    pub fixture_id: String,
    pub patch_back_mode: PatchBackTransform,
    pub secret_requirement_id: String,
    pub redaction_status: HelperRedactionStatus,
    pub total_members: u32,
    pub members_patched: u32,
    pub members_byte_preserved: u32,
    pub identity_byte_identical: bool,
    pub identity_source_hash: ProofHash,
    pub identity_rebuilt_hash: ProofHash,
    pub verification_proof_hash: ProofHash,
    pub secret_requirement_verified: bool,
    pub status: OperationStatus,
}

/// The redaction posture of the composed summary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3PrivateLocalRedactionSummary {
    /// Always `true` on a returned summary: the body is deep-scanned before it
    /// is returned.
    pub deep_scan_performed: bool,
    /// The number of string values the deep scan examined.
    pub strings_scanned: u64,
    /// Secret-leak findings. A returned summary always carries `0` (any finding
    /// fails the render before a summary is returned).
    pub secret_leak_findings: u64,
    /// `true` iff the body is clean against the redaction boundary.
    pub redaction_boundary_ok: bool,
    /// The aggregate redaction status across every composed helper / patch row.
    pub aggregate_redaction_status: HelperRedactionStatus,
}

/// One typed summary-level diagnostic.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3PrivateLocalSummaryDiagnostic {
    pub code: String,
    pub severity: PartialDiagnosticSeverity,
    pub field: String,
    pub message: String,
    pub semantic_code: String,
}

impl Xp3PrivateLocalSummaryDiagnostic {
    fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            severity: self.severity,
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
            semantic_code: redact_for_log_or_report(&self.semantic_code),
        }
    }
}

// The rendered summary.

/// The composed, redacted XP3 private-local validation summary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3PrivateLocalSummary {
    pub schema_version: String,
    pub summary_id: String,
    pub support_boundary: String,
    pub status: OperationStatus,
    pub helper_result_count: u64,
    pub support_tuple_count: u64,
    pub patch_summary_count: u64,
    pub honest_tuple_count: u64,
    pub overclaim_tuple_count: u64,
    /// Distinct helper capability levels seen across the aggregate, ascending.
    pub capability_levels: Vec<HelperCapabilityLevel>,
    pub helper_rows: Vec<Xp3HelperResultRow>,
    pub support_rows: Vec<Xp3SupportTupleRow>,
    pub patch_rows: Vec<Xp3PatchSummaryRow>,
    pub redaction_summary: Xp3PrivateLocalRedactionSummary,
    pub diagnostics: Vec<Xp3PrivateLocalSummaryDiagnostic>,
}

impl Xp3PrivateLocalSummary {
    /// True iff the summary composed with no blocking diagnostic.
    #[must_use]
    pub fn is_ok(&self) -> bool {
        self.status == OperationStatus::Passed
    }

    /// A belt-and-suspenders redacted clone for the committed public frame.
    /// Every free-text id/message goes through [`redact_for_log_or_report`]; the
    /// enums, counts, hashes, and secret **requirement** ids are already safe.
    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            summary_id: redact_for_log_or_report(&self.summary_id),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            status: self.status.clone(),
            helper_result_count: self.helper_result_count,
            support_tuple_count: self.support_tuple_count,
            patch_summary_count: self.patch_summary_count,
            honest_tuple_count: self.honest_tuple_count,
            overclaim_tuple_count: self.overclaim_tuple_count,
            capability_levels: self.capability_levels.clone(),
            helper_rows: self
                .helper_rows
                .iter()
                .map(Xp3HelperResultRow::redacted_for_report)
                .collect(),
            support_rows: self
                .support_rows
                .iter()
                .map(Xp3SupportTupleRow::redacted_for_report)
                .collect(),
            patch_rows: self
                .patch_rows
                .iter()
                .map(Xp3PatchSummaryRow::redacted_for_report)
                .collect(),
            redaction_summary: self.redaction_summary.clone(),
            diagnostics: self
                .diagnostics
                .iter()
                .map(Xp3PrivateLocalSummaryDiagnostic::redacted_for_report)
                .collect(),
        }
    }

    /// Stable, redacted JSON for committing as a public-safe proof.
    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

impl Xp3HelperResultRow {
    fn redacted_for_report(&self) -> Self {
        Self {
            helper_result_id: redact_for_log_or_report(&self.helper_result_id),
            profile_id: redact_for_log_or_report(&self.profile_id),
            capability_level: self.capability_level,
            diagnostic_code: self.diagnostic_code,
            redaction_status: self.redaction_status,
            secret_requirement_ids: self
                .secret_requirement_ids
                .iter()
                .map(|id| redact_for_log_or_report(id))
                .collect(),
            redacted_log_hash: self.redacted_log_hash.clone(),
            proof_hashes: self.proof_hashes.clone(),
            validation_status: self.validation_status.clone(),
        }
    }
}

impl Xp3SupportTupleRow {
    fn redacted_for_report(&self) -> Self {
        Self {
            profile_or_fixture_id: redact_for_log_or_report(&self.profile_or_fixture_id),
            engine_family: self.engine_family,
            engine_variant: redact_for_log_or_report(&self.engine_variant),
            claimed_level: self.claimed_level,
            patch_back_mode: self.patch_back_mode,
            secret_requirement_ids: self
                .secret_requirement_ids
                .iter()
                .map(|id| redact_for_log_or_report(id))
                .collect(),
            evidence_proof_hashes: self.evidence_proof_hashes.clone(),
            honest: self.honest,
            status: self.status.clone(),
            diagnostic_count: self.diagnostic_count,
        }
    }
}

impl Xp3PatchSummaryRow {
    fn redacted_for_report(&self) -> Self {
        Self {
            fixture_id: redact_for_log_or_report(&self.fixture_id),
            patch_back_mode: self.patch_back_mode,
            secret_requirement_id: redact_for_log_or_report(&self.secret_requirement_id),
            redaction_status: self.redaction_status,
            total_members: self.total_members,
            members_patched: self.members_patched,
            members_byte_preserved: self.members_byte_preserved,
            identity_byte_identical: self.identity_byte_identical,
            identity_source_hash: self.identity_source_hash.clone(),
            identity_rebuilt_hash: self.identity_rebuilt_hash.clone(),
            verification_proof_hash: self.verification_proof_hash.clone(),
            secret_requirement_verified: self.secret_requirement_verified,
            status: self.status.clone(),
        }
    }
}

mod render;
pub use render::render_xp3_private_local_summary;
pub mod synthetic;

#[cfg(test)]
#[path = "xp3_private_local_summary_tests.rs"]
mod tests;
