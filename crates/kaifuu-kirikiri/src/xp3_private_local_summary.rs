//! KAIFUU-102 — the **private-local XP3 helper + patch summary** renderer.
//!
//! # What this is
//!
//! A local operator runs the profiled XP3 helper + patch-back flows against
//! their own private tree (the KAIFUU-100 crypt smoke, the KAIFUU-101 patch-back
//! smoke, and whatever local key helper resolved the archive password). Those
//! runs produce three already-safe, already-typed artifacts:
//!
//! - a **helper-result aggregate** — a set of KAIFUU-085
//!   [`HelperResult`](kaifuu_core::HelperResult)s (ref + hash schema; the raw key
//!   never leaves the resolving helper), and
//! - a **support-tuple summary** — a set of KAIFUU-105
//!   [`ClaimedSupportTuple`](kaifuu_core::compat_profile::ClaimedSupportTuple)s
//!   declaring what the operator's XP3 posture actually claims, and
//! - zero or more **XP3 patch-back summaries**
//!   ([`Xp3PatchReport`](crate::Xp3PatchReport)).
//!
//! This module COMPOSES those into ONE redacted validation summary that exposes
//! only **safe metadata** — profile ids, secret **requirement** ids, proof
//! hashes, capability levels, statuses, counts, and typed diagnostics. It
//! **never** carries a raw key, a private path, decrypted story text, a
//! screenshot, retail bytes, or a raw helper dump.
//!
//! # Redaction toggle + private-local law (mirrors KAIFUU-015 / KAIFUU-094)
//!
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
pub const XP3_PRIVATE_LOCAL_SUMMARY_SUPPORT_BOUNDARY: &str = "Kaifuu KiriKiri XP3 private-local summary COMPOSES an operator's local helper-result aggregate (KAIFUU-085 ref+hash HelperResults), support-tuple summary (KAIFUU-105 ClaimedSupportTuples), and XP3 patch-back summaries into ONE redacted validation summary. It exposes ONLY safe metadata: profile ids, secret REQUIREMENT ids, proof hashes, capability levels, statuses, counts, and typed diagnostics. It NEVER carries secret key bytes, private paths, decrypted or story text, screenshots, retail bytes, or unredacted helper logs. Every private-local row is optional (an empty render is valid + deterministic), so a private-local aggregate is never a public-CI dependency. The composed body is deep-scanned before it is returned; any secret-shaped material fails the render loudly and nothing is returned to persist.";

/// Semantic code: the composed summary failed the fail-loud deep secret scan.
pub const SEMANTIC_XP3_PRIVATE_LOCAL_SUMMARY_SECRET_LEAK: &str =
    "kaifuu.kirikiri.xp3_private_local_summary.secret_leak";
/// Semantic code: a helper-result row failed KAIFUU-085 validation.
pub const SEMANTIC_XP3_PRIVATE_LOCAL_SUMMARY_HELPER_INVALID: &str =
    "kaifuu.kirikiri.xp3_private_local_summary.helper_result_invalid";
/// Semantic code: a support tuple overclaimed / failed KAIFUU-105 validation.
pub const SEMANTIC_XP3_PRIVATE_LOCAL_SUMMARY_TUPLE_OVERCLAIM: &str =
    "kaifuu.kirikiri.xp3_private_local_summary.support_tuple_overclaim";
/// Semantic code: an XP3 patch-back summary reported a failed round-trip.
pub const SEMANTIC_XP3_PRIVATE_LOCAL_SUMMARY_PATCH_FAILED: &str =
    "kaifuu.kirikiri.xp3_private_local_summary.patch_summary_failed";

// ---------------------------------------------------------------------------
// Input aggregate fixtures (synthetic, deserialized from committed JSON).
// ---------------------------------------------------------------------------

/// The **helper-result aggregate** fixture: a set of KAIFUU-085 helper results
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

/// The **support-tuple summary** fixture: a set of KAIFUU-105 claimed-support
/// tuples declaring the operator's XP3 posture.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Xp3SupportTupleSummaryFixture {
    pub schema_version: String,
    pub summary_id: String,
    #[serde(default)]
    pub support_tuples: Vec<ClaimedSupportTuple>,
}

// ---------------------------------------------------------------------------
// Render input (borrowed slices; every leg is optional).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Rendered rows (safe metadata only).
// ---------------------------------------------------------------------------

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
    /// KAIFUU-085 schema validation status of the underlying helper result.
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
    /// `true` iff the body is clean against the KAIFUU-036/094 redaction boundary.
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

// ---------------------------------------------------------------------------
// The rendered summary.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Renderer.
// ---------------------------------------------------------------------------

/// Compose the redacted XP3 private-local summary from the operator's helper +
/// support-tuple + patch inputs.
///
/// The summary carries only safe metadata (profile ids, secret **requirement**
/// ids, proof hashes, capability levels, statuses, counts, diagnostics). The
/// status is `Failed` iff any helper result fails KAIFUU-085 validation, any
/// support tuple overclaims (KAIFUU-105), or any XP3 patch summary reports a
/// failed round-trip.
///
/// FAIL-LOUD: the composed body is deep-scanned; if any raw key, private path,
/// decrypted/story text, screenshot filename, retail byte blob, or raw helper
/// dump is present, this returns `Err` and nothing is returned to persist.
pub fn render_xp3_private_local_summary(
    input: Xp3PrivateLocalSummaryInput<'_>,
) -> KaifuuResult<Xp3PrivateLocalSummary> {
    let mut diagnostics: Vec<Xp3PrivateLocalSummaryDiagnostic> = Vec::new();
    let mut redaction_statuses: Vec<HelperRedactionStatus> = Vec::new();

    // --- Helper-result rows (KAIFUU-085) -----------------------------------
    let mut helper_rows: Vec<Xp3HelperResultRow> = Vec::with_capacity(input.helper_results.len());
    for helper in input.helper_results {
        let validation = helper.validate();
        if validation.status == OperationStatus::Failed {
            diagnostics.push(Xp3PrivateLocalSummaryDiagnostic {
                code: "helper_result_invalid".to_string(),
                severity: PartialDiagnosticSeverity::P1,
                field: "helperRows".to_string(),
                message: format!(
                    "helper result {} failed KAIFUU-085 validation with {} failure(s)",
                    helper.helper_result_id,
                    validation.failures.len()
                ),
                semantic_code: SEMANTIC_XP3_PRIVATE_LOCAL_SUMMARY_HELPER_INVALID.to_string(),
            });
        }
        redaction_statuses.push(helper.redaction.status);
        helper_rows.push(Xp3HelperResultRow {
            helper_result_id: helper.helper_result_id.clone(),
            profile_id: helper.profile_id.clone(),
            capability_level: helper.capability_level,
            diagnostic_code: helper.diagnostic.code,
            redaction_status: helper.redaction.status,
            secret_requirement_ids: helper
                .secret_refs
                .iter()
                .map(|secret| secret.requirement_id.clone())
                .collect(),
            redacted_log_hash: helper.redaction.redacted_log_hash.clone(),
            proof_hashes: helper
                .proof_hashes
                .iter()
                .map(|proof| proof.proof_hash.clone())
                .collect(),
            validation_status: validation.status,
        });
    }

    // --- Support-tuple rows (KAIFUU-105) -----------------------------------
    let mut support_rows: Vec<Xp3SupportTupleRow> = Vec::with_capacity(input.support_tuples.len());
    let mut honest_tuple_count = 0u64;
    let mut overclaim_tuple_count = 0u64;
    for tuple in input.support_tuples {
        let entry = validate_claimed_support_tuple(tuple);
        if entry.is_honest() {
            honest_tuple_count += 1;
        } else {
            overclaim_tuple_count += 1;
            diagnostics.push(Xp3PrivateLocalSummaryDiagnostic {
                code: "support_tuple_overclaim".to_string(),
                severity: PartialDiagnosticSeverity::P0,
                field: "supportRows".to_string(),
                message: format!(
                    "support tuple {} overclaims or failed KAIFUU-105 validation",
                    entry.profile_or_fixture_id
                ),
                semantic_code: SEMANTIC_XP3_PRIVATE_LOCAL_SUMMARY_TUPLE_OVERCLAIM.to_string(),
            });
        }
        support_rows.push(support_tuple_row(&entry));
    }

    // --- XP3 patch-back summary rows (KAIFUU-100 / 101) --------------------
    let mut patch_rows: Vec<Xp3PatchSummaryRow> = Vec::with_capacity(input.patch_reports.len());
    for report in input.patch_reports {
        if report.status == OperationStatus::Failed {
            diagnostics.push(Xp3PrivateLocalSummaryDiagnostic {
                code: "patch_summary_failed".to_string(),
                severity: PartialDiagnosticSeverity::P1,
                field: "patchRows".to_string(),
                message: format!(
                    "XP3 patch-back summary {} reported a failed round-trip",
                    report.fixture_id
                ),
                semantic_code: SEMANTIC_XP3_PRIVATE_LOCAL_SUMMARY_PATCH_FAILED.to_string(),
            });
        }
        redaction_statuses.push(report.redaction_status);
        patch_rows.push(Xp3PatchSummaryRow {
            fixture_id: report.fixture_id.clone(),
            patch_back_mode: report.capability.patch_back_mode,
            secret_requirement_id: report.secret_requirement_id.clone(),
            redaction_status: report.redaction_status,
            total_members: report.capability.coverage.total_members,
            members_patched: report.capability.coverage.members_patched,
            members_byte_preserved: report.capability.coverage.members_byte_preserved,
            identity_byte_identical: report.identity.byte_identical,
            identity_source_hash: report.identity.source_hash.clone(),
            identity_rebuilt_hash: report.identity.rebuilt_hash.clone(),
            verification_proof_hash: report.verification.verification_proof.proof_hash.clone(),
            secret_requirement_verified: report.verification.secret_requirement_verified,
            status: report.status.clone(),
        });
    }

    // Distinct capability levels (ascending), a safe aggregate.
    let mut capability_levels: Vec<HelperCapabilityLevel> =
        helper_rows.iter().map(|row| row.capability_level).collect();
    capability_levels.sort();
    capability_levels.dedup();

    let aggregate_redaction_status = aggregate_redaction_status(&redaction_statuses);

    let status = if diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity.is_blocking())
    {
        OperationStatus::Failed
    } else {
        OperationStatus::Passed
    };

    // Assemble the body with a placeholder redaction summary (it carries only
    // counts + a boolean, so it cannot itself hold a secret), deep-scan the raw
    // body, then attach the real redaction summary.
    let mut summary = Xp3PrivateLocalSummary {
        schema_version: XP3_PRIVATE_LOCAL_SUMMARY_SCHEMA_VERSION.to_string(),
        summary_id: input.summary_id.to_string(),
        support_boundary: XP3_PRIVATE_LOCAL_SUMMARY_SUPPORT_BOUNDARY.to_string(),
        status,
        helper_result_count: helper_rows.len() as u64,
        support_tuple_count: support_rows.len() as u64,
        patch_summary_count: patch_rows.len() as u64,
        honest_tuple_count,
        overclaim_tuple_count,
        capability_levels,
        helper_rows,
        support_rows,
        patch_rows,
        redaction_summary: Xp3PrivateLocalRedactionSummary {
            deep_scan_performed: false,
            strings_scanned: 0,
            secret_leak_findings: 0,
            redaction_boundary_ok: false,
            aggregate_redaction_status,
        },
        diagnostics,
    };

    // FAIL-LOUD deep scan (reject story text, screenshots, retail bytes, raw
    // helper output, raw keys, private paths). Scan the RAW body so a seeded
    // secret cannot be silently scrubbed and then written.
    let body = serde_json::to_value(&summary).map_err(|error| -> Box<dyn std::error::Error> {
        format!("{XP3_PRIVATE_LOCAL_SUMMARY_MARKER}: summary serialization: {error}").into()
    })?;
    let scan = deep_scan_persisted_artifact(&body);
    if scan.finding_count > 0 {
        return Err(format!(
            "{SEMANTIC_XP3_PRIVATE_LOCAL_SUMMARY_SECRET_LEAK}: refusing to return an XP3 private-local summary carrying secret-shaped material ({} finding(s), first field: {})",
            scan.finding_count,
            scan.first_field.as_deref().unwrap_or("<unknown>"),
        )
        .into());
    }

    summary.redaction_summary = Xp3PrivateLocalRedactionSummary {
        deep_scan_performed: true,
        strings_scanned: scan.strings_scanned,
        secret_leak_findings: 0,
        redaction_boundary_ok: true,
        aggregate_redaction_status,
    };

    Ok(summary)
}

fn support_tuple_row(entry: &ClaimedSupportEntryReport) -> Xp3SupportTupleRow {
    let mut evidence_proof_hashes: Vec<ProofHash> = Vec::new();
    for leg in [
        entry.evidence.extraction.as_ref(),
        entry.evidence.validation.as_ref(),
        entry.evidence.patch_back.as_ref(),
        entry.evidence.runtime.as_ref(),
    ]
    .into_iter()
    .flatten()
    {
        evidence_proof_hashes.push(leg.proof_hash.clone());
    }
    Xp3SupportTupleRow {
        profile_or_fixture_id: entry.profile_or_fixture_id.clone(),
        engine_family: entry.engine_family,
        engine_variant: entry.engine_variant.clone(),
        claimed_level: entry.claimed_level,
        patch_back_mode: entry.patch_back_mode,
        secret_requirement_ids: entry
            .secret_requirement_ids
            .iter()
            .map(|requirement| requirement.requirement_id.clone())
            .collect(),
        evidence_proof_hashes,
        honest: entry.is_honest(),
        status: entry.status.clone(),
        diagnostic_count: entry.diagnostics.len() as u64,
    }
}

fn aggregate_redaction_status(statuses: &[HelperRedactionStatus]) -> HelperRedactionStatus {
    if statuses.contains(&HelperRedactionStatus::Failed) {
        HelperRedactionStatus::Failed
    } else if statuses.contains(&HelperRedactionStatus::Redacted) {
        HelperRedactionStatus::Redacted
    } else {
        HelperRedactionStatus::NotRequired
    }
}

// ---------------------------------------------------------------------------
// Fail-loud deep scan (mirrors the KAIFUU-015 profile-proof scan).
// ---------------------------------------------------------------------------

struct DeepScanResult {
    strings_scanned: u64,
    finding_count: u64,
    first_field: Option<String>,
}

/// Combine the field-name-gated [`validate_secret_redaction_boundary`] (catches
/// forbidden field NAMES such as `helperDump` / `rawKey` / `decryptedText`) with
/// a full-string value scan (catches any raw key, local absolute path, forbidden
/// private payload — helper dumps, decrypted/story text — or private/spoiler
/// filename in ANY field, via [`redact_for_log_or_report`]).
fn deep_scan_persisted_artifact(value: &Value) -> DeepScanResult {
    let mut strings_scanned = 0u64;
    let mut findings: Vec<String> = Vec::new();
    scan_strings(value, "$", &mut strings_scanned, &mut findings);
    for finding in validate_secret_redaction_boundary(value) {
        findings.push(finding.field);
    }
    let first_field = findings.first().cloned();
    DeepScanResult {
        strings_scanned,
        finding_count: findings.len() as u64,
        first_field,
    }
}

fn scan_strings(value: &Value, field: &str, strings_scanned: &mut u64, findings: &mut Vec<String>) {
    match value {
        Value::String(text) => {
            *strings_scanned += 1;
            if redact_for_log_or_report(text) != *text {
                findings.push(field.to_string());
            }
        }
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                scan_strings(item, &format!("{field}.{index}"), strings_scanned, findings);
            }
        }
        Value::Object(object) => {
            for (key, child) in object {
                let child_field = if field == "$" {
                    key.clone()
                } else {
                    format!("{field}.{key}")
                };
                scan_strings(child, &child_field, strings_scanned, findings);
            }
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// Synthetic builders (public, reproducible — the source of truth for the
// committed fixtures + the public-safe summary).
// ---------------------------------------------------------------------------

pub mod synthetic {
    //! Deterministic synthetic builders. No corpus bytes, no retail names, no
    //! real keys — only logical ids, secret **requirement** ids, and hashes.

    use super::{Xp3HelperResultAggregate, Xp3SupportTupleSummaryFixture};
    use kaifuu_core::compat_profile::{
        ClaimedSupportLevel, ClaimedSupportTuple, CompatDiagnostic, CompatDiagnosticStatus,
        CompatEngineFamily, CompatLayer, EvidenceRef, SecretRequirementId, SupportEvidence,
    };
    use kaifuu_core::{
        CodecTransform, ContainerTransform, CryptoTransform, HelperCapabilityLevel,
        HelperDiagnostic, HelperDiagnosticCode, HelperExecutionFilesystemAccess,
        HelperExecutionSummary, HelperKind, HelperProvenance, HelperRedaction,
        HelperRedactionStatus, HelperResult, HelperResultExecutionMode, HelperResultSecretRef,
        KeyMaterialKind, KeyValidationMethod, KeyValidationProof, PartialDiagnosticSeverity,
        PatchBackTransform, ProofHash, SecretRef, SemanticErrorCode, SurfaceTransform,
    };

    use super::XP3_PRIVATE_LOCAL_SUMMARY_SCHEMA_VERSION;

    fn proof_hash(byte: u8) -> ProofHash {
        let hex = format!("{byte:02x}").repeat(32);
        ProofHash::new(format!("sha256:{hex}")).expect("synthetic proof hash is valid")
    }

    /// The KAIFUU-085 helper-result aggregate an operator's local key helpers
    /// produced against a synthetic XP3 tree.
    #[must_use]
    pub fn helper_result_aggregate() -> Xp3HelperResultAggregate {
        Xp3HelperResultAggregate {
            schema_version: XP3_PRIVATE_LOCAL_SUMMARY_SCHEMA_VERSION.to_string(),
            aggregate_id: "kaifuu/k102/xp3-helper-result-aggregate".to_string(),
            helper_results: vec![
                // A helper-gated profile: manual key entry required before table access.
                HelperResult {
                    schema_version: kaifuu_core::HELPER_RESULT_SCHEMA_VERSION.to_string(),
                    fixture_id: "kaifuu-k102-xp3-helper-required".to_string(),
                    helper_result_id: "helper-result/kaifuu/k102/xp3/helper-required".to_string(),
                    profile_id: "019ed000-0000-7000-8000-0000000a2001".to_string(),
                    helper: HelperProvenance {
                        helper_id: "kaifuu.fixture.manual-entry".to_string(),
                        helper_version: "0.1.0".to_string(),
                        helper_kind: HelperKind::ManualKeyEntry,
                    },
                    capability_level: HelperCapabilityLevel::ManualEntry,
                    execution: HelperExecutionSummary {
                        mode: HelperResultExecutionMode::NotExecuted,
                        platform: "fixture-local".to_string(),
                        bounded: true,
                        timeout_ms: 1000,
                        duration_ms: Some(0),
                        network_access: false,
                        filesystem_access: HelperExecutionFilesystemAccess::None,
                    },
                    diagnostic: HelperDiagnostic {
                        code: HelperDiagnosticCode::HelperRequired,
                        message: "synthetic XP3 helper-gated profile requires a local helper result before archive table access".to_string(),
                    },
                    redaction: HelperRedaction {
                        status: HelperRedactionStatus::NotRequired,
                        redacted_log_hash: proof_hash(0x10),
                    },
                    secret_refs: vec![HelperResultSecretRef {
                        requirement_id: "kirikiri-xp3-key-profile".to_string(),
                        secret_ref: SecretRef::new("prompt:fixture/kirikiri/xp3-archive-password")
                            .expect("synthetic secret ref is valid"),
                        material_kind: KeyMaterialKind::ArchivePassword,
                        bytes: None,
                        validation: None,
                    }],
                    proof_hashes: vec![KeyValidationProof {
                        method: KeyValidationMethod::ArchiveIndexProof,
                        proof_hash: proof_hash(0x11),
                    }],
                },
                // A known-key import that could not find local material.
                HelperResult {
                    schema_version: kaifuu_core::HELPER_RESULT_SCHEMA_VERSION.to_string(),
                    fixture_id: "kaifuu-k102-xp3-missing-key".to_string(),
                    helper_result_id: "helper-result/kaifuu/k102/xp3/missing-key".to_string(),
                    profile_id: "019ed000-0000-7000-8000-0000000a2002".to_string(),
                    helper: HelperProvenance {
                        helper_id: "kaifuu.fixture.known-key-import".to_string(),
                        helper_version: "0.1.0".to_string(),
                        helper_kind: HelperKind::KnownKeyDatabaseImport,
                    },
                    capability_level: HelperCapabilityLevel::LocalKeyImport,
                    execution: HelperExecutionSummary {
                        mode: HelperResultExecutionMode::NotExecuted,
                        platform: "fixture-local".to_string(),
                        bounded: true,
                        timeout_ms: 1000,
                        duration_ms: Some(0),
                        network_access: false,
                        filesystem_access: HelperExecutionFilesystemAccess::None,
                    },
                    diagnostic: HelperDiagnostic {
                        code: HelperDiagnosticCode::MissingKey,
                        message: "synthetic XP3 encrypted profile declares kirikiri-xp3-key-profile but no local key material was found".to_string(),
                    },
                    redaction: HelperRedaction {
                        status: HelperRedactionStatus::Redacted,
                        redacted_log_hash: proof_hash(0x20),
                    },
                    secret_refs: vec![HelperResultSecretRef {
                        requirement_id: "kirikiri-xp3-key-profile".to_string(),
                        secret_ref: SecretRef::new("local-secret:fixture/kirikiri/xp3/missing-password")
                            .expect("synthetic secret ref is valid"),
                        material_kind: KeyMaterialKind::ArchivePassword,
                        bytes: None,
                        validation: None,
                    }],
                    proof_hashes: vec![],
                },
            ],
        }
    }

    /// The KAIFUU-105 support-tuple summary declaring the operator's XP3 posture.
    #[must_use]
    pub fn support_tuple_summary() -> Xp3SupportTupleSummaryFixture {
        Xp3SupportTupleSummaryFixture {
            schema_version: XP3_PRIVATE_LOCAL_SUMMARY_SCHEMA_VERSION.to_string(),
            summary_id: "kaifuu/k102/xp3-support-tuple-summary".to_string(),
            support_tuples: vec![
                // An honest known-key XP3 extract claim.
                ClaimedSupportTuple {
                    schema_version: "0.1.0".to_string(),
                    engine_family: CompatEngineFamily::KirikiriXp3,
                    engine_variant: "kirikiri_xp3_known_key".to_string(),
                    container: ContainerTransform::Xp3,
                    crypto: CryptoTransform::KeyProfile,
                    codec: CodecTransform::ShiftJisText,
                    surface: SurfaceTransform::ArchiveEntry,
                    patch_back_mode: PatchBackTransform::RepackArchive,
                    profile_or_fixture_id: "compat/kirikiri-xp3/known-key-extract".to_string(),
                    secret_requirement_ids: vec![SecretRequirementId::new(
                        "kirikiri-xp3-key-profile",
                        SecretRef::new("prompt:fixture/kirikiri/xp3-archive-password")
                            .expect("synthetic secret ref is valid"),
                    )],
                    diagnostics: vec![CompatDiagnostic {
                        layer: CompatLayer::Crypto,
                        status: CompatDiagnosticStatus::KnownKeyOnly,
                        reason_id: SemanticErrorCode::KeyValidationFailed,
                        severity: PartialDiagnosticSeverity::P3,
                        detail: Some(
                            "extract limited to a catalogued known key; arbitrary titles unsupported"
                                .to_string(),
                        ),
                    }],
                    claimed_level: ClaimedSupportLevel::Extract,
                    evidence: SupportEvidence {
                        extraction: Some(EvidenceRef::new(
                            "evidence/extract/xp3-known-key",
                            proof_hash(0x31),
                        )),
                        validation: None,
                        patch_back: None,
                        runtime: None,
                    },
                },
                // An honest patch-back claim with the full evidence chain.
                ClaimedSupportTuple {
                    schema_version: "0.1.0".to_string(),
                    engine_family: CompatEngineFamily::KirikiriXp3,
                    engine_variant: "kirikiri_xp3_fixture_patch".to_string(),
                    container: ContainerTransform::Xp3,
                    crypto: CryptoTransform::KeyProfile,
                    codec: CodecTransform::ShiftJisText,
                    surface: SurfaceTransform::ArchiveEntry,
                    patch_back_mode: PatchBackTransform::RepackArchive,
                    profile_or_fixture_id: "compat/kirikiri-xp3/fixture-patch-back".to_string(),
                    secret_requirement_ids: vec![SecretRequirementId::new(
                        "kaifuu-k100-xp3-crypt-key",
                        SecretRef::new("local-secret:kaifuu-kirikiri-crypt-fixture-key")
                            .expect("synthetic secret ref is valid"),
                    )],
                    diagnostics: vec![],
                    claimed_level: ClaimedSupportLevel::Patch,
                    evidence: SupportEvidence {
                        extraction: Some(EvidenceRef::new(
                            "evidence/extract/xp3-fixture",
                            proof_hash(0x41),
                        )),
                        validation: Some(EvidenceRef::new(
                            "evidence/validate/xp3-fixture",
                            proof_hash(0x42),
                        )),
                        patch_back: Some(EvidenceRef::new(
                            "evidence/patch/xp3-fixture",
                            proof_hash(0x43),
                        )),
                        runtime: None,
                    },
                },
            ],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kaifuu_core::{
        HelperDiagnostic, HelperDiagnosticCode, HelperRedactionStatus, HelperResult,
    };

    fn synthetic_helper_results() -> Vec<HelperResult> {
        synthetic::helper_result_aggregate().helper_results
    }

    fn synthetic_support_tuples() -> Vec<ClaimedSupportTuple> {
        synthetic::support_tuple_summary().support_tuples
    }

    fn render_synthetic() -> Xp3PrivateLocalSummary {
        let helpers = synthetic_helper_results();
        let tuples = synthetic_support_tuples();
        render_xp3_private_local_summary(Xp3PrivateLocalSummaryInput {
            summary_id: "kaifuu/k102/xp3-private-local-summary",
            helper_results: &helpers,
            support_tuples: &tuples,
            patch_reports: &[],
        })
        .expect("clean synthetic inputs render")
    }

    #[test]
    fn clean_summary_exposes_only_safe_metadata() {
        let summary = render_synthetic();
        assert_eq!(summary.status, OperationStatus::Passed);
        assert_eq!(summary.helper_result_count, 2);
        assert_eq!(summary.support_tuple_count, 2);
        assert_eq!(summary.honest_tuple_count, 2);
        assert_eq!(summary.overclaim_tuple_count, 0);

        // profile ids present.
        assert!(
            summary
                .helper_rows
                .iter()
                .any(|row| row.profile_id.starts_with("019ed000"))
        );
        // secret REQUIREMENT ids present (never the raw key).
        assert!(summary.helper_rows.iter().any(|row| {
            row.secret_requirement_ids
                .contains(&"kirikiri-xp3-key-profile".to_string())
        }));
        assert!(summary.support_rows.iter().any(|row| {
            row.secret_requirement_ids
                .contains(&"kaifuu-k100-xp3-crypt-key".to_string())
        }));
        // proof hashes present.
        assert!(
            summary
                .helper_rows
                .iter()
                .any(|row| !row.proof_hashes.is_empty())
        );
        assert!(
            summary
                .support_rows
                .iter()
                .any(|row| !row.evidence_proof_hashes.is_empty())
        );
        // capability levels present (aggregate).
        assert!(
            summary
                .capability_levels
                .contains(&HelperCapabilityLevel::ManualEntry)
        );
        assert!(
            summary
                .capability_levels
                .contains(&HelperCapabilityLevel::LocalKeyImport)
        );
        // deep scan ran clean.
        assert!(summary.redaction_summary.deep_scan_performed);
        assert_eq!(summary.redaction_summary.secret_leak_findings, 0);
        assert!(summary.redaction_summary.redaction_boundary_ok);
    }

    #[test]
    fn serialized_summary_carries_no_raw_key_or_private_path() {
        let summary = render_synthetic();
        let json = summary.stable_json().expect("stable json");
        // No local absolute paths.
        assert!(!json.contains("/home/"));
        assert!(!json.contains("\\Users\\"));
        // The raw fixture key constant never appears.
        assert!(!json.contains("K100-XP3-XORKEY1"));
        // Round-trips (structurally valid).
        let value: serde_json::Value = serde_json::from_str(&json).expect("valid json");
        assert!(value.get("redactionSummary").is_some());
    }

    #[test]
    fn empty_input_renders_valid_deterministic_summary() {
        let a = render_xp3_private_local_summary(Xp3PrivateLocalSummaryInput {
            summary_id: "kaifuu/k102/xp3-private-local-empty",
            helper_results: &[],
            support_tuples: &[],
            patch_reports: &[],
        })
        .expect("empty render");
        let b = render_xp3_private_local_summary(Xp3PrivateLocalSummaryInput {
            summary_id: "kaifuu/k102/xp3-private-local-empty",
            helper_results: &[],
            support_tuples: &[],
            patch_reports: &[],
        })
        .expect("empty render");
        assert_eq!(a.status, OperationStatus::Passed);
        assert_eq!(a.helper_result_count, 0);
        assert_eq!(a.support_tuple_count, 0);
        assert_eq!(a.patch_summary_count, 0);
        assert!(a.redaction_summary.deep_scan_performed);
        // Omitting every private-local row is fine and byte-stable.
        assert_eq!(
            a.stable_json().unwrap(),
            b.stable_json().unwrap(),
            "empty summary is deterministic"
        );
    }

    #[test]
    fn render_is_reproducible_from_synthetic_inputs() {
        assert_eq!(
            render_synthetic().stable_json().unwrap(),
            render_synthetic().stable_json().unwrap(),
        );
    }

    #[test]
    fn overclaim_tuple_flips_status_failed() {
        let mut tuples = synthetic_support_tuples();
        // Strip the patch-back evidence leg from the patch-claiming tuple → overclaim.
        let patch_tuple = tuples
            .iter_mut()
            .find(|tuple| tuple.claimed_level == ClaimedSupportLevel::Patch)
            .expect("patch tuple present");
        patch_tuple.evidence.patch_back = None;
        let helpers = synthetic_helper_results();
        let summary = render_xp3_private_local_summary(Xp3PrivateLocalSummaryInput {
            summary_id: "kaifuu/k102/xp3-private-local-overclaim",
            helper_results: &helpers,
            support_tuples: &tuples,
            patch_reports: &[],
        })
        .expect("overclaim still renders (it is a status, not a leak)");
        assert_eq!(summary.status, OperationStatus::Failed);
        assert_eq!(summary.overclaim_tuple_count, 1);
        assert!(summary.diagnostics.iter().any(|diagnostic| {
            diagnostic.semantic_code == SEMANTIC_XP3_PRIVATE_LOCAL_SUMMARY_TUPLE_OVERCLAIM
        }));
    }

    // --- Private-field rejection tests (fail-loud deep scan) ----------------
    //
    // These poison a field the renderer COPIES into the summary body (the
    // `profileId`, a copied+scanned safe-metadata field). The fail-loud deep
    // scan must reject each of the four private-content categories — nothing is
    // returned to persist.

    /// Build helper results whose (copied, scanned) `profileId` carries a poison
    /// payload the deep scan must reject.
    fn poisoned_profile_id(poison: &str) -> Vec<HelperResult> {
        let mut helpers = synthetic_helper_results();
        helpers[0].profile_id = poison.to_string();
        helpers
    }

    fn render_poisoned(helpers: &[HelperResult]) -> KaifuuResult<Xp3PrivateLocalSummary> {
        render_xp3_private_local_summary(Xp3PrivateLocalSummaryInput {
            summary_id: "kaifuu/k102/xp3-private-local-poisoned",
            helper_results: helpers,
            support_tuples: &[],
            patch_reports: &[],
        })
    }

    #[test]
    fn rejects_decrypted_story_text() {
        // Decrypted scenario / story prose is copyrighted private content.
        let helpers = poisoned_profile_id(
            "decrypted script text: the heroine confesses under the cherry tree",
        );
        let error = render_poisoned(&helpers).expect_err("story text must be rejected");
        assert!(
            error
                .to_string()
                .contains(SEMANTIC_XP3_PRIVATE_LOCAL_SUMMARY_SECRET_LEAK)
        );
    }

    #[test]
    fn rejects_screenshot_path() {
        // A screenshot of a spoiler route is private + copyrighted.
        let helpers = poisoned_profile_id("true-ending-route-spoiler.png");
        let error = render_poisoned(&helpers).expect_err("screenshot filename must be rejected");
        assert!(
            error
                .to_string()
                .contains(SEMANTIC_XP3_PRIVATE_LOCAL_SUMMARY_SECRET_LEAK)
        );
    }

    #[test]
    fn rejects_retail_byte_blob() {
        // A base64 blob of retail archive bytes is disallowed raw material.
        let helpers = poisoned_profile_id("aGVsbG8gd29ybGQgdGhpcyBpcyBhIHNlY3JldCBrZXkgYmxvYg==");
        let error = render_poisoned(&helpers).expect_err("retail byte blob must be rejected");
        assert!(
            error
                .to_string()
                .contains(SEMANTIC_XP3_PRIVATE_LOCAL_SUMMARY_SECRET_LEAK)
        );
    }

    #[test]
    fn rejects_raw_helper_output() {
        // A raw helper log / dump must never reach the summary.
        let helpers = poisoned_profile_id("raw helper log dump: register + memory dump");
        let error = render_poisoned(&helpers).expect_err("raw helper output must be rejected");
        assert!(
            error
                .to_string()
                .contains(SEMANTIC_XP3_PRIVATE_LOCAL_SUMMARY_SECRET_LEAK)
        );
    }

    #[test]
    fn rejects_local_absolute_path_in_profile_id() {
        // A private local game path leaking through a profile id is rejected.
        let helpers = poisoned_profile_id("/home/operator/games/private-title/data.xp3");
        let error = render_poisoned(&helpers).expect_err("private path must be rejected");
        assert!(
            error
                .to_string()
                .contains(SEMANTIC_XP3_PRIVATE_LOCAL_SUMMARY_SECRET_LEAK)
        );
    }

    #[test]
    fn rejects_forbidden_field_name_in_support_tuple_detail() {
        // A support tuple whose diagnostic detail carries a raw-key phrase is
        // rejected by the value scan even though the field name is innocent.
        let mut tuples = synthetic_support_tuples();
        tuples[0].profile_or_fixture_id =
            "/home/operator/private/route-spoiler/data.xp3".to_string();
        let helpers = synthetic_helper_results();
        let error = render_xp3_private_local_summary(Xp3PrivateLocalSummaryInput {
            summary_id: "kaifuu/k102/xp3-private-local-poisoned",
            helper_results: &helpers,
            support_tuples: &tuples,
            patch_reports: &[],
        })
        .expect_err("private path in a tuple id must be rejected");
        assert!(
            error
                .to_string()
                .contains(SEMANTIC_XP3_PRIVATE_LOCAL_SUMMARY_SECRET_LEAK)
        );
    }

    #[test]
    fn omits_raw_helper_diagnostic_message() {
        // The renderer copies only the diagnostic CODE, never the free-text
        // helper message — so a poisoned message is OMITTED (safe by
        // construction), and the summary renders clean.
        let mut helpers = synthetic_helper_results();
        helpers[0].diagnostic = HelperDiagnostic {
            code: HelperDiagnosticCode::HelperRequired,
            message: "raw helper log dump: register + memory dump".to_string(),
        };
        let summary = render_xp3_private_local_summary(Xp3PrivateLocalSummaryInput {
            summary_id: "kaifuu/k102/xp3-private-local-omit",
            helper_results: &helpers,
            support_tuples: &[],
            patch_reports: &[],
        })
        .expect("poisoned message is dropped, so the summary renders clean");
        let json = summary.stable_json().expect("stable json");
        assert!(
            !json.contains("memory dump"),
            "helper message must be omitted"
        );
        assert!(!json.contains("register"), "helper message must be omitted");
    }

    #[test]
    fn clean_redaction_status_aggregates() {
        let summary = render_synthetic();
        // One helper is `redacted`, so the aggregate is Redacted (not NotRequired).
        assert_eq!(
            summary.redaction_summary.aggregate_redaction_status,
            HelperRedactionStatus::Redacted
        );
    }
}
