//! Validation engine for claimed-support tuples: the per-tuple and aggregate
//! report types ([`ClaimedSupportEntryReport`] / [`ClaimedSupportValidationReport`])
//! plus the [`validate_claimed_support_tuple`] / [`validate_claimed_support_profile`]
//! validators that implement the anti-overclaim gate. The schema (tuple +
//! transform/diagnostic vocabulary) lives in the parent [`super`] module; these
//! items are re-exported from [`crate::compat_profile`].

use serde::{Deserialize, Serialize};

use crate::{
    CodecTransform, ContainerTransform, CryptoTransform, KaifuuResult, OperationStatus,
    PartialDiagnosticSeverity, PatchBackTransform, SemanticErrorCode, SurfaceTransform,
    redact_for_log_or_report, stable_json,
};

use super::{
    CLAIMED_SUPPORT_BOUNDARY, CLAIMED_SUPPORT_REPORT_SCHEMA_VERSION, ClaimedSupportLevel,
    ClaimedSupportTuple, CompatDiagnostic, CompatDiagnosticStatus, CompatEngineFamily, CompatLayer,
    EvidenceLeg, SecretRequirementId, SupportEvidence, is_real_patch_back,
};

// Validator + report

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
/// The anti-overclaim gate (acceptance 3) lives here: a tuple whose
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
