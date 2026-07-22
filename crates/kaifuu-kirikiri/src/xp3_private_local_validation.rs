//! private-local XP3 validation gate.
//! This module is the alpha gate that consumes an operator's **already-redacted**
//! private-local XP3 validation manifest and turns it into one aggregate report:
//! no corpus -> deterministic `skipped`; configured private-local rows -> stage
//! aggregates plus proof hashes linked to claimed XP3 support tuples.
//! The gate composes the production runner instead of reimplementing
//! XP3 crypt/extract/patch. A configured row for a claimed support tuple is not
//! allowed to be a label-only assertion: the claimed tuple must also be backed by
//! a passing synthetic production regression run. If the runner fails for a
//! claimed tuple, the report is `failed` and the diagnostic is a compatibility
//! regression. Rows outside the claimed XP3 tuple set are reported as
//! `out-of-profile` semantic diagnostics, not as support regressions.
//! # — readiness BINDS to a verified round-trip (not a label)
//! The gate runs the private-local validation workflow (the profiled
//! extract-patch-verify driver) ONCE and threads the resulting report. A claimed
//! row reaches `Passed` — and lifts the retail posture to `PrivateValidated` —
//! ONLY when its declared `roundTripProofHash` equals the WORKFLOW-BOUND value
//! recomputed from the real round-trip output for that exact tuple (the source +
//! rebuilt encrypted-container hashes, the per-member deltas, and the driver's
//! round-trip proof; see
//! [`canonical_xp3_round_trip_proof_hash_from_workflow`]). This is the
//! pattern: the proof hash is NO LONGER a mintable label (which
//! anyone who knew a kind/id string could forge), so `patch-proven` is
//! unreachable without a genuinely-passing round-trip. A missing/failed workflow,
//! or a tuple the workflow never round-tripped, is a LOUD typed diagnostic (never
//! a silent skip) and the top rungs stay unreached.
//! The manifest and report carry only logical ids, stage states, and
//! [`ProofHash`]es. They never carry raw keys, helper dumps, retail filenames,
//! decrypted text, local paths, screenshots, or assets. The report body is
//! deep-scanned before it is returned; a secret-shaped value is a hard error.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use kaifuu_core::{
    HelperRedactionStatus, KaifuuResult, OperationStatus, PartialDiagnosticSeverity, ProofHash,
    redact_for_log_or_report, sha256_hash_bytes, stable_json, validate_secret_redaction_boundary,
};

use crate::xp3_production::{
    Xp3ProductionError, Xp3ProductionOutcome, Xp3ProductionRegistry, Xp3ProductionReport,
    Xp3ProductionVariantReport, run_xp3_production,
};

#[path = "xp3_private_local_validation/public_api.rs"]
mod public_api;
pub use public_api::{
    SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_CLAIMED_FAILED,
    SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_OUT_OF_PROFILE,
    SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_REGRESSION_FAILED,
    SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_SECRET_LEAK,
    SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_SKIPPED,
    SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_UNVERIFIED_PROOF,
    SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_WORKFLOW_UNPROVEN,
    XP3_PRIVATE_LOCAL_VALIDATION_MANIFEST_COMMAND, XP3_PRIVATE_LOCAL_VALIDATION_MARKER,
    XP3_PRIVATE_LOCAL_VALIDATION_NO_CORPUS_COMMAND, XP3_PRIVATE_LOCAL_VALIDATION_SCHEMA_VERSION,
    XP3_PRIVATE_LOCAL_VALIDATION_SUPPORT_BOUNDARY, Xp3PrivateLocalValidationInput,
    Xp3PrivateLocalValidationManifest, Xp3PrivateLocalValidationManifestEntry,
    Xp3PrivateLocalValidationStageOutcome, Xp3PrivateLocalValidationState,
    Xp3PrivateLocalValidationStateCounts, Xp3RetailValidationPosture,
    canonical_xp3_round_trip_proof_hash_from_workflow,
};

/// The fixed validation stages the private-local gate aggregates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Xp3PrivateLocalValidationStage {
    /// XP3 classify/detect.
    Detect,
    /// Key/profile resolution.
    KeyProfileResolve,
    /// Extract/decrypt.
    Extract,
    /// Apply one trivial patch.
    TrivialPatch,
    /// Verify the rebuilt output.
    Verify,
    /// Apply/emit delta evidence.
    DeltaApply,
}

impl Xp3PrivateLocalValidationStage {
    /// All stages, in gate order.
    #[must_use]
    pub fn ordered() -> [Self; 6] {
        [
            Self::Detect,
            Self::KeyProfileResolve,
            Self::Extract,
            Self::TrivialPatch,
            Self::Verify,
            Self::DeltaApply,
        ]
    }

    fn as_key(self) -> &'static str {
        match self {
            Self::Detect => "detect",
            Self::KeyProfileResolve => "keyProfileResolve",
            Self::Extract => "extract",
            Self::TrivialPatch => "trivialPatch",
            Self::Verify => "verify",
            Self::DeltaApply => "deltaApply",
        }
    }
}

impl Xp3PrivateLocalValidationStateCounts {
    fn increment(&mut self, state: Xp3PrivateLocalValidationState) {
        match state {
            Xp3PrivateLocalValidationState::Skipped => self.skipped += 1,
            Xp3PrivateLocalValidationState::Passed => self.passed += 1,
            Xp3PrivateLocalValidationState::Failed => self.failed += 1,
            Xp3PrivateLocalValidationState::OutOfProfile => self.out_of_profile += 1,
        }
    }
}

/// Stage aggregate bins keyed by the fixed private-local validation stages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3PrivateLocalValidationStageBins {
    pub detect: Xp3PrivateLocalValidationStateCounts,
    pub key_profile_resolve: Xp3PrivateLocalValidationStateCounts,
    pub extract: Xp3PrivateLocalValidationStateCounts,
    pub trivial_patch: Xp3PrivateLocalValidationStateCounts,
    pub verify: Xp3PrivateLocalValidationStateCounts,
    pub delta_apply: Xp3PrivateLocalValidationStateCounts,
}

impl Xp3PrivateLocalValidationStageBins {
    fn empty() -> Self {
        Self {
            detect: Xp3PrivateLocalValidationStateCounts::default(),
            key_profile_resolve: Xp3PrivateLocalValidationStateCounts::default(),
            extract: Xp3PrivateLocalValidationStateCounts::default(),
            trivial_patch: Xp3PrivateLocalValidationStateCounts::default(),
            verify: Xp3PrivateLocalValidationStateCounts::default(),
            delta_apply: Xp3PrivateLocalValidationStateCounts::default(),
        }
    }

    fn increment(
        &mut self,
        stage: Xp3PrivateLocalValidationStage,
        state: Xp3PrivateLocalValidationState,
    ) {
        match stage {
            Xp3PrivateLocalValidationStage::Detect => self.detect.increment(state),
            Xp3PrivateLocalValidationStage::KeyProfileResolve => {
                self.key_profile_resolve.increment(state);
            }
            Xp3PrivateLocalValidationStage::Extract => self.extract.increment(state),
            Xp3PrivateLocalValidationStage::TrivialPatch => {
                self.trivial_patch.increment(state);
            }
            Xp3PrivateLocalValidationStage::Verify => self.verify.increment(state),
            Xp3PrivateLocalValidationStage::DeltaApply => self.delta_apply.increment(state),
        }
    }
}

/// One row in the emitted aggregate report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3PrivateLocalValidationRow {
    pub corpus_id_redacted: String,
    pub claimed_support_tuple_id: String,
    pub profile_id_redacted: String,
    pub result: Xp3PrivateLocalValidationState,
    pub proof_hashes: Vec<ProofHash>,
    pub stages: Vec<Xp3PrivateLocalValidationStageOutcome>,
}

impl Xp3PrivateLocalValidationRow {
    fn redacted_for_report(&self) -> Self {
        Self {
            corpus_id_redacted: redact_for_log_or_report(&self.corpus_id_redacted),
            claimed_support_tuple_id: redact_for_log_or_report(&self.claimed_support_tuple_id),
            profile_id_redacted: redact_for_log_or_report(&self.profile_id_redacted),
            result: self.result,
            proof_hashes: self.proof_hashes.clone(),
            stages: self.stages.clone(),
        }
    }
}

/// Summary of the claimed-profile regression runner backing this validation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3PrivateLocalRegressionSummary {
    pub runner: String,
    pub source_node_id: String,
    pub claimed_support_tuple_ids: Vec<String>,
    pub production_report_hash: Option<ProofHash>,
    pub status: OperationStatus,
    pub diagnostic: Option<String>,
}

impl Xp3PrivateLocalRegressionSummary {
    fn redacted_for_report(&self) -> Self {
        Self {
            runner: self.runner.clone(),
            source_node_id: self.source_node_id.clone(),
            claimed_support_tuple_ids: self
                .claimed_support_tuple_ids
                .iter()
                .map(|id| redact_for_log_or_report(id))
                .collect(),
            production_report_hash: self.production_report_hash.clone(),
            status: self.status.clone(),
            diagnostic: self.diagnostic.as_deref().map(redact_for_log_or_report),
        }
    }
}

/// Alpha proof posture block carried by the report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3PrivateLocalAlphaProofs {
    pub retail_validation: Xp3RetailValidationPosture,
}

/// One typed validation diagnostic.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3PrivateLocalValidationDiagnostic {
    pub code: String,
    pub severity: PartialDiagnosticSeverity,
    pub field: String,
    pub message: String,
    pub semantic_code: String,
}

impl Xp3PrivateLocalValidationDiagnostic {
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

/// Redaction posture of the returned report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3PrivateLocalValidationRedactionSummary {
    pub deep_scan_performed: bool,
    pub strings_scanned: u64,
    pub secret_leak_findings: u64,
    pub redaction_boundary_ok: bool,
    pub redaction_status: HelperRedactionStatus,
}

/// The redacted private-local XP3 validation report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3PrivateLocalValidationReport {
    pub schema_version: String,
    pub validation_id: String,
    pub source_node_id: String,
    pub command: String,
    pub support_boundary: String,
    pub status: Xp3PrivateLocalValidationState,
    pub reason: Option<String>,
    pub alpha_proofs: Xp3PrivateLocalAlphaProofs,
    pub result_counts: Xp3PrivateLocalValidationStateCounts,
    pub stage_bins: Xp3PrivateLocalValidationStageBins,
    pub configured_private_inputs: u64,
    pub claimed_private_inputs: u64,
    pub out_of_profile_inputs: u64,
    pub proof_hashes: Vec<ProofHash>,
    pub regression: Xp3PrivateLocalRegressionSummary,
    pub rows: Vec<Xp3PrivateLocalValidationRow>,
    pub diagnostics: Vec<Xp3PrivateLocalValidationDiagnostic>,
    pub redaction_summary: Xp3PrivateLocalValidationRedactionSummary,
}

impl Xp3PrivateLocalValidationReport {
    /// True iff at least one claimed private-local row passed and no claimed row
    /// failed.
    #[must_use]
    pub fn is_private_validated(&self) -> bool {
        self.alpha_proofs.retail_validation == Xp3RetailValidationPosture::PrivateValidated
    }

    /// Redacted clone for persistence.
    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            validation_id: redact_for_log_or_report(&self.validation_id),
            source_node_id: self.source_node_id.clone(),
            command: self.command.clone(),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            status: self.status,
            reason: self.reason.as_deref().map(redact_for_log_or_report),
            alpha_proofs: self.alpha_proofs.clone(),
            result_counts: self.result_counts,
            stage_bins: self.stage_bins.clone(),
            configured_private_inputs: self.configured_private_inputs,
            claimed_private_inputs: self.claimed_private_inputs,
            out_of_profile_inputs: self.out_of_profile_inputs,
            proof_hashes: self.proof_hashes.clone(),
            regression: self.regression.redacted_for_report(),
            rows: self
                .rows
                .iter()
                .map(Xp3PrivateLocalValidationRow::redacted_for_report)
                .collect(),
            diagnostics: self
                .diagnostics
                .iter()
                .map(Xp3PrivateLocalValidationDiagnostic::redacted_for_report)
                .collect(),
            redaction_summary: self.redaction_summary.clone(),
        }
    }

    /// Stable, redacted JSON for writing an artifact.
    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

#[path = "xp3_private_local_validation/workflow.rs"]
mod workflow;
pub use workflow::run_xp3_private_local_validation;

fn proof_hash(bytes: &[u8]) -> Result<ProofHash, String> {
    ProofHash::new(sha256_hash_bytes(bytes))
}

struct DeepScanResult {
    strings_scanned: u64,
    finding_count: u64,
    first_field: Option<String>,
}

fn scan_report(
    report: &Xp3PrivateLocalValidationReport,
) -> KaifuuResult<Xp3PrivateLocalValidationRedactionSummary> {
    let value = serde_json::to_value(report).map_err(|error| -> Box<dyn std::error::Error> {
        format!("{XP3_PRIVATE_LOCAL_VALIDATION_MARKER}: report serialization before scan: {error}")
            .into()
    })?;
    let scan = deep_scan_persisted_artifact(&value);
    if scan.finding_count > 0 {
        return Err(format!(
            "{SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_SECRET_LEAK}: refusing to return an XP3 private-local validation report carrying secret-shaped material ({} finding(s), first field: {})",
            scan.finding_count,
            scan.first_field.as_deref().unwrap_or("<unknown>"),
        )
        .into());
    }
    Ok(Xp3PrivateLocalValidationRedactionSummary {
        deep_scan_performed: true,
        strings_scanned: scan.strings_scanned,
        secret_leak_findings: 0,
        redaction_boundary_ok: true,
        redaction_status: HelperRedactionStatus::Redacted,
    })
}

fn deep_scan_persisted_artifact(value: &Value) -> DeepScanResult {
    let mut strings_scanned = 0u64;
    let mut findings: Vec<String> = Vec::new();
    scan_strings(value, "$", &mut strings_scanned, &mut findings);
    for finding in validate_secret_redaction_boundary(value) {
        findings.push(finding.field);
    }
    DeepScanResult {
        strings_scanned,
        finding_count: findings.len() as u64,
        first_field: findings.first().cloned(),
    }
}

fn scan_strings(value: &Value, field: &str, strings_scanned: &mut u64, findings: &mut Vec<String>) {
    match value {
        Value::String(text) => {
            *strings_scanned += 1;
            if is_allowed_policy_string(field, text) {
                return;
            }
            if looks_like_forbidden_private_value(text) {
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
                if redact_for_log_or_report(key) != *key {
                    findings.push(format!("{field}.<key>"));
                }
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

fn is_allowed_policy_string(field: &str, text: &str) -> bool {
    matches!(field, "command" | "supportBoundary")
        && matches!(
            text,
            XP3_PRIVATE_LOCAL_VALIDATION_NO_CORPUS_COMMAND
                | XP3_PRIVATE_LOCAL_VALIDATION_MANIFEST_COMMAND
                | XP3_PRIVATE_LOCAL_VALIDATION_SUPPORT_BOUNDARY
        )
}

fn looks_like_forbidden_private_value(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("local-secret:")
        || lower.contains("/home/")
        || lower.contains("/users/")
        || lower.contains("/scratch/")
        || lower.contains("\\users\\")
        || has_windows_drive_prefix(text)
        || lower.contains("helper dump")
        || lower.contains("raw helper")
        || lower.contains("decrypted")
        || lower.contains("retail byte")
        || has_forbidden_image_extension(&lower)
        || has_raw_hex_run(text)
}

fn has_forbidden_image_extension(text: &str) -> bool {
    std::path::Path::new(text)
        .extension()
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("png") || extension.eq_ignore_ascii_case("jpg")
        })
}

fn has_windows_drive_prefix(text: &str) -> bool {
    text.as_bytes()
        .windows(3)
        .any(|window| window[0].is_ascii_alphabetic() && window[1] == b':' && window[2] == b'\\')
}

fn has_raw_hex_run(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut start = 0usize;
    let mut len = 0usize;
    for (index, byte) in bytes.iter().enumerate() {
        if byte.is_ascii_hexdigit() {
            if len == 0 {
                start = index;
            }
            len += 1;
            if len >= 24 && !is_sha256_hex_run(text, start) {
                return true;
            }
        } else {
            len = 0;
        }
    }
    false
}

fn is_sha256_hex_run(text: &str, start: usize) -> bool {
    text.get(start.saturating_sub(7)..start) == Some("sha256:")
}

#[cfg(test)]
mod tests;
