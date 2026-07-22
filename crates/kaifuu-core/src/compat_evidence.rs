//! Claimed-support compatibility EVIDENCE integration.
//! This module is a pure INTEGRATION of the three already-built compatibility
//! evidence sources into ONE suite-readable artifact — it re-owns none of them:
//! 1. **Claimed-support tuple validation** (
//!    [`crate::compat_profile`]) — the cross-family declaration surface. Each
//!    validated [`ClaimedSupportEntryReport`] carries the exact engine family,
//!    variant, container, crypto, codec, surface, patch-back mode,
//!    profile/fixture id, secret-requirement ids, and merged diagnostics of a
//!    claim.
//! 2. **Redacted reproduction bundles** ([`crate::repro_bundle`])
//!    the shareable, private-asset-free artifact whose reproduction proofs pin a
//!    PUBLIC fixture id + [`ProofHash`] per claimed tuple. The integration INDEXES
//!    each claimed support to its bundle entry (bundle id + fixture id + proof
//!    hash) so a suite consumer can follow the claim straight to its
//!    reproduction.
//! 3. **Regression-runner outputs** ([`crate::compat_regression`])
//!    the drift gate that re-runs every claimed tuple against the public-fixture
//!    catalogue + the bundle's proofs + the recorded baseline. The integration
//!    attaches the LATEST per-claim regression verdict (fixture resolution,
//!    secret-metadata status, findings, drift, pass/fail).
//!    The single output — [`CompatEvidenceReport`] — lists, for EACH claimed
//!    support: engine family, variant, container, crypto, codec, surface,
//!    patch-back mode, profile/fixture id, secret-requirement ids, diagnostics, the
//!    redacted repro-bundle index entry, and the latest regression
//!    result. The report is REDACTION-CLEAN: it funnels every
//!    free-text field through [`redact_for_log_or_report`] and carries secrets and
//!    proofs only as the strongly-typed [`SecretRef`](crate::SecretRef) / requirement
//!    ids / [`ProofHash`] refs the embedded sources already use. No raw keys, no
//!    private paths, no retail bytes.

use serde::{Deserialize, Serialize};

use crate::{
    CodecTransform, ContainerTransform, CryptoTransform, KaifuuResult, OperationStatus,
    PatchBackTransform, ProofHash, SurfaceTransform, redact_for_log_or_report, stable_json,
};

use crate::compat_profile::{ClaimedSupportLevel, CompatDiagnostic, CompatEngineFamily};
use crate::compat_regression::{
    ClaimedProfileRegressionReport, DriftFinding, FixtureResolutionStatus, PublicFixtureCatalogue,
    RegressionBaseline, RegressionFinding, RegressionTupleResult, SecretMetadataStatus,
    run_claimed_profile_regression,
};
use crate::repro_bundle::{ReproBundle, ReproBundleValidationReport, validate_repro_bundle};

/// Schema version of the integrated compatibility-evidence report.
pub const COMPAT_EVIDENCE_REPORT_SCHEMA_VERSION: &str = "0.1.0";

/// The boundary surfaced in every integrated report.
pub const COMPAT_EVIDENCE_BOUNDARY: &str = "The claimed-support compatibility evidence report is a suite-readable INTEGRATION of three sources: the KAIFUU-105 claimed-support tuple validation (engine family, variant, container, crypto, codec, surface, patch-back mode, profile/fixture id, secret-requirement ids, diagnostics), the KAIFUU-106 redacted reproduction-bundle index (public fixture id + sha256 proof hash per claim), and the KAIFUU-107 regression-runner verdict (fixture resolution, secret-metadata status, findings, drift, latest pass/fail). It re-owns none of them. The report is redaction-clean: secrets and proofs are ref-only requirement ids / sha256 hashes, never raw keys, private paths, or retail bytes.";

// Redacted repro-bundle index entry (link)

/// The link from a claimed support to its redacted reproduction
/// bundle: the bundle id + the PUBLIC fixture a reproducer runs, pinned by the
/// bundle's [`ProofHash`]. No bytes, no secrets, no private paths.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReproBundleIndexEntry {
    /// The bundle this claim's reproduction proof lives.
    pub bundle_id: String,
    /// The claimed tuple's `profileOrFixtureId` the proof reproduces.
    pub tuple_id: String,
    /// The PUBLIC fixture id a reproducer runs (never a private path/corpus).
    pub fixture_id: String,
    /// The sha256 proof hash the public-fixture run must match.
    pub proof_hash: ProofHash,
}

impl ReproBundleIndexEntry {
    fn redacted_for_report(&self) -> Self {
        Self {
            bundle_id: redact_for_log_or_report(&self.bundle_id),
            tuple_id: redact_for_log_or_report(&self.tuple_id),
            fixture_id: redact_for_log_or_report(&self.fixture_id),
            proof_hash: self.proof_hash.clone(),
        }
    }
}

// Latest regression result (verdict)

/// The LATEST regression verdict for one claimed support — the
/// runner's per-tuple outcome, minus the duplicated tuple identity fields (those
/// are surfaced once at the [`ClaimedSupportEvidence`] level).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestRegressionResult {
    pub status: OperationStatus,
    pub fixture_resolution: FixtureResolutionStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_fixture_id: Option<String>,
    pub secret_metadata: SecretMetadataStatus,
    pub diagnostics_fingerprint: ProofHash,
    pub findings: Vec<RegressionFinding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drift: Option<DriftFinding>,
}

impl LatestRegressionResult {
    fn from_result(result: &RegressionTupleResult) -> Self {
        Self {
            status: result.status.clone(),
            fixture_resolution: result.fixture_resolution,
            resolved_fixture_id: result.resolved_fixture_id.clone(),
            secret_metadata: result.secret_metadata,
            diagnostics_fingerprint: result.diagnostics_fingerprint.clone(),
            findings: result.findings.clone(),
            drift: result.drift.clone(),
        }
    }

    fn redacted_for_report(&self) -> Self {
        Self {
            status: self.status.clone(),
            fixture_resolution: self.fixture_resolution,
            resolved_fixture_id: self
                .resolved_fixture_id
                .as_deref()
                .map(redact_for_log_or_report),
            secret_metadata: self.secret_metadata,
            diagnostics_fingerprint: self.diagnostics_fingerprint.clone(),
            findings: self
                .findings
                .iter()
                .map(RegressionFinding::redacted_for_report)
                .collect(),
            drift: self.drift.as_ref().map(DriftFinding::redacted_for_report),
        }
    }
}

// Per claimed-support evidence row (the integrated shape)

/// One claimed support's fully-integrated evidence row. Lists — per
/// acceptance — the engine family, variant, container, crypto, codec, surface,
/// patch-back mode, profile/fixture id, secret-requirement ids, and diagnostics
/// (from), the redacted repro-bundle index, and the
/// latest regression result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimedSupportEvidence {
    pub profile_or_fixture_id: String,
    pub engine_family: CompatEngineFamily,
    pub engine_variant: String,
    pub container: ContainerTransform,
    pub crypto: CryptoTransform,
    pub codec: CodecTransform,
    pub surface: SurfaceTransform,
    pub patch_back_mode: PatchBackTransform,
    pub claimed_level: ClaimedSupportLevel,
    /// The secret-requirement IDS only — never the underlying secret values.
    pub secret_requirement_ids: Vec<String>,
    /// The merged (author-declared + validator) typed diagnostics.
    pub diagnostics: Vec<CompatDiagnostic>,
    /// Link to the claim's redacted reproduction bundle. `None` when
    /// the bundle carries no reproduction proof for this claim (the regression
    /// verdict flags that as missing fixture evidence).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repro_bundle_index: Option<ReproBundleIndexEntry>,
    /// The latest regression verdict for this claim.
    pub latest_regression: LatestRegressionResult,
}

impl ClaimedSupportEvidence {
    /// True iff the claim's latest regression verdict passed.
    pub fn is_passed(&self) -> bool {
        self.latest_regression.status == OperationStatus::Passed
    }

    fn redacted_for_report(&self) -> Self {
        Self {
            profile_or_fixture_id: redact_for_log_or_report(&self.profile_or_fixture_id),
            engine_family: self.engine_family,
            engine_variant: redact_for_log_or_report(&self.engine_variant),
            container: self.container,
            crypto: self.crypto,
            codec: self.codec,
            surface: self.surface,
            patch_back_mode: self.patch_back_mode,
            claimed_level: self.claimed_level,
            secret_requirement_ids: self
                .secret_requirement_ids
                .iter()
                .map(|id| redact_for_log_or_report(id))
                .collect(),
            diagnostics: self
                .diagnostics
                .iter()
                .map(CompatDiagnostic::redacted_for_report)
                .collect(),
            repro_bundle_index: self
                .repro_bundle_index
                .as_ref()
                .map(ReproBundleIndexEntry::redacted_for_report),
            latest_regression: self.latest_regression.redacted_for_report(),
        }
    }
}

// The integrated report artifact

/// The single suite-readable compatibility-evidence artifact: the integration of
/// the tuple validation, the reproduction-bundle index, and
/// the regression outputs for one reproduction bundle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatEvidenceReport {
    pub schema_version: String,
    pub boundary: String,
    pub bundle_id: String,
    /// `Passed` iff the bundle validated (no private assets, self-sufficient, no
    /// overclaim) AND the regression run is clean.
    pub status: OperationStatus,
    /// whether the bundle is self-sufficient for public reproduction.
    pub bundle_self_sufficient: bool,
    /// private-asset violations (must be zero for a clean report).
    pub private_asset_violation_count: u64,
    /// reproduction-self-sufficiency gaps (must be zero when clean).
    pub reproduction_gap_count: u64,
    pub claimed_support_count: u64,
    /// claims whose latest regression passed / failed / drifted.
    pub passed_count: u64,
    pub failed_count: u64,
    pub drift_count: u64,
    pub supports: Vec<ClaimedSupportEvidence>,
}

impl CompatEvidenceReport {
    /// True iff the integrated evidence is clean end-to-end.
    pub fn is_clean(&self) -> bool {
        self.status == OperationStatus::Passed
    }

    /// The evidence row for `profile_or_fixture_id`, if present.
    pub fn support(&self, profile_or_fixture_id: &str) -> Option<&ClaimedSupportEvidence> {
        self.supports
            .iter()
            .find(|s| s.profile_or_fixture_id == profile_or_fixture_id)
    }

    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            boundary: redact_for_log_or_report(&self.boundary),
            bundle_id: redact_for_log_or_report(&self.bundle_id),
            status: self.status.clone(),
            bundle_self_sufficient: self.bundle_self_sufficient,
            private_asset_violation_count: self.private_asset_violation_count,
            reproduction_gap_count: self.reproduction_gap_count,
            claimed_support_count: self.claimed_support_count,
            passed_count: self.passed_count,
            failed_count: self.failed_count,
            drift_count: self.drift_count,
            supports: self
                .supports
                .iter()
                .map(ClaimedSupportEvidence::redacted_for_report)
                .collect(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

// The integrator

/// Find the reproduction proof (index entry) that pins `tuple_id`.
fn repro_index_for(bundle: &ReproBundle, tuple_id: &str) -> Option<ReproBundleIndexEntry> {
    bundle
        .reproduction_proofs
        .iter()
        .find(|proof| proof.tuple_id == tuple_id)
        .map(|proof| ReproBundleIndexEntry {
            bundle_id: bundle.bundle_id.clone(),
            tuple_id: proof.tuple_id.clone(),
            fixture_id: proof.fixture_id.clone(),
            proof_hash: proof.proof_hash.clone(),
        })
}

/// Build one integrated evidence report from a bundle validation report + a
/// regression report over the same bundle.
fn integrate_reports(
    bundle: &ReproBundle,
    bundle_report: &ReproBundleValidationReport,
    regression: &ClaimedProfileRegressionReport,
) -> CompatEvidenceReport {
    let supports: Vec<ClaimedSupportEvidence> = regression
        .results
        .iter()
        .map(|result| {
            let entry = &result.entry;
            ClaimedSupportEvidence {
                profile_or_fixture_id: entry.profile_or_fixture_id.clone(),
                engine_family: entry.engine_family,
                engine_variant: entry.engine_variant.clone(),
                container: entry.container,
                crypto: entry.crypto,
                codec: entry.codec,
                surface: entry.surface,
                patch_back_mode: entry.patch_back_mode,
                claimed_level: entry.claimed_level,
                secret_requirement_ids: entry
                    .secret_requirement_ids
                    .iter()
                    .map(|requirement| requirement.requirement_id.clone())
                    .collect(),
                diagnostics: entry.diagnostics.clone(),
                repro_bundle_index: repro_index_for(bundle, &entry.profile_or_fixture_id),
                latest_regression: LatestRegressionResult::from_result(result),
            }
        })
        .collect();

    // Clean end-to-end iff BOTH the bundle validated and the regression is clean.
    let status = if bundle_report.status == OperationStatus::Passed
        && regression.status == OperationStatus::Passed
    {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };

    CompatEvidenceReport {
        schema_version: COMPAT_EVIDENCE_REPORT_SCHEMA_VERSION.to_string(),
        boundary: COMPAT_EVIDENCE_BOUNDARY.to_string(),
        bundle_id: bundle.bundle_id.clone(),
        status,
        bundle_self_sufficient: bundle_report.self_sufficient,
        private_asset_violation_count: bundle_report.violations.len() as u64,
        reproduction_gap_count: bundle_report.gaps.len() as u64,
        claimed_support_count: supports.len() as u64,
        passed_count: regression.passed_count,
        failed_count: regression.failed_count,
        drift_count: regression.drift_count,
        supports,
    }
}

/// Integrate the three compatibility-evidence sources for one reproduction
/// bundle into a single suite-readable [`CompatEvidenceReport`].
/// It runs the bundle validator and the regression runner
/// over the SAME bundle, then joins each claim's validated tuple fields
/// with its reproduction-bundle index entry and its
/// latest regression verdict. Never panics, never returns `Err`.
pub fn integrate_compat_evidence(
    bundle: &ReproBundle,
    catalogue: &PublicFixtureCatalogue,
    baseline: &RegressionBaseline,
) -> CompatEvidenceReport {
    let bundle_report = validate_repro_bundle(bundle);
    let regression = run_claimed_profile_regression(bundle, catalogue, baseline);
    integrate_reports(bundle, &bundle_report, &regression)
}

// Fixtures — the integrated report over the clean bundle

/// Synthetic integration fixtures over the clean reproduction bundle +
/// the matching public-fixture catalogue + baseline. The
/// integrated report validates green and is redaction-clean.
pub mod fixtures {
    use super::*;
    use crate::compat_regression::fixtures as regression_fixtures;
    use crate::repro_bundle::fixtures as bundle_fixtures;

    /// The integrated compatibility-evidence report over the clean bundle.
    pub fn clean_report() -> CompatEvidenceReport {
        integrate_compat_evidence(
            &bundle_fixtures::clean_bundle(),
            &regression_fixtures::public_catalogue(),
            &regression_fixtures::baseline(),
        )
    }
}

#[cfg(test)]
#[path = "compat_evidence_tests.rs"]
mod tests;
