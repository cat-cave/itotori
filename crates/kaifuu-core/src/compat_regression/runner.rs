//! The claimed-profile regression runner — the per-tuple + aggregate driver.
//!
//! Lives in its own child module so the catalogue / baseline / finding /
//! result-artifact types stay co-located in the parent while the actual
//! re-run machinery (`resolve_fixture`, `run_one`,
//! [`run_claimed_profile_regression`]) reads as one cohesive band.

use super::*;

use crate::OperationStatus;
use crate::compat_profile::{ClaimedSupportTuple, validate_claimed_support_tuple};
use crate::repro_bundle::ReproBundle;

// The runner

/// Resolve a single tuple against the bundle's reproduction proofs + the
/// catalogue.
fn resolve_fixture(
    bundle: &ReproBundle,
    catalogue: &PublicFixtureCatalogue,
    tuple: &ClaimedSupportTuple,
) -> (FixtureResolutionStatus, Option<String>) {
    let tuple_id = tuple.profile_or_fixture_id.as_str();
    match bundle
        .reproduction_proofs
        .iter()
        .find(|proof| proof.tuple_id == tuple_id)
    {
        None => (FixtureResolutionStatus::MissingReproductionProof, None),
        Some(proof) if catalogue.contains(&proof.fixture_id) => (
            FixtureResolutionStatus::Resolved,
            Some(proof.fixture_id.clone()),
        ),
        Some(_) => (FixtureResolutionStatus::UnknownPublicFixture, None),
    }
}

/// Run one claimed profile against its fixture/proof + the recorded baseline.
fn run_one(
    bundle: &ReproBundle,
    catalogue: &PublicFixtureCatalogue,
    baseline: &RegressionBaseline,
    tuple: &ClaimedSupportTuple,
) -> RegressionTupleResult {
    let tuple_id = tuple.profile_or_fixture_id.clone();

    // 1. The anti-overclaim gate + recorded tuple fields.
    let entry = validate_claimed_support_tuple(tuple);
    let mut findings: Vec<RegressionFinding> = Vec::new();

    if entry.status == OperationStatus::Failed {
        findings.push(RegressionFinding::new(
            &tuple_id,
            RegressionFindingKind::OverclaimTuple,
            "the embedded support tuple overclaims (the anti-overclaim gate failed)",
        ));
    }

    // 2. Fixture-evidence resolution (fail on missing / unknown).
    let (fixture_resolution, resolved_fixture_id) = resolve_fixture(bundle, catalogue, tuple);
    if !fixture_resolution.is_resolved() {
        let reason = match fixture_resolution {
            FixtureResolutionStatus::MissingReproductionProof => {
                "no reproduction proof pins a public fixture for this claim"
            }
            FixtureResolutionStatus::UnknownPublicFixture => {
                "the reproduction proof names a fixture id absent from the public-fixture catalogue"
            }
            FixtureResolutionStatus::Resolved => unreachable!(),
        };
        findings.push(RegressionFinding::new(
            &tuple_id,
            RegressionFindingKind::MissingFixtureEvidence,
            reason,
        ));
    }

    // 3. Secret-requirement metadata gate (fail on missing).
    let secret_metadata = if crypto_requires_secret(tuple.crypto) {
        if tuple.secret_requirement_ids.is_empty() {
            findings.push(RegressionFinding::new(
                &tuple_id,
                RegressionFindingKind::MissingSecretRequirementMetadata,
                "a key-gated crypto layer declares no secretRequirementIds metadata",
            ));
            SecretMetadataStatus::Missing
        } else {
            SecretMetadataStatus::Declared
        }
    } else {
        SecretMetadataStatus::NotRequired
    };

    // 4. Diagnostic drift vs the recorded baseline (finding, never a rewrite).
    let current_fingerprint = diagnostics_fingerprint(&entry.diagnostics);
    let baseline_fingerprint = baseline.fingerprint_of(&tuple_id).cloned();
    let drift = match &baseline_fingerprint {
        Some(recorded) if *recorded == current_fingerprint => None,
        Some(_) => Some(DriftFinding {
            tuple_id: tuple_id.clone(),
            baseline_fingerprint: baseline_fingerprint.clone(),
            current_fingerprint: current_fingerprint.clone(),
            message: "diagnostics changed vs the recorded baseline (compatibility drift)"
                .to_string(),
        }),
        None => Some(DriftFinding {
            tuple_id: tuple_id.clone(),
            baseline_fingerprint: None,
            current_fingerprint: current_fingerprint.clone(),
            message: "no recorded baseline for this claim; a new tuple must be baselined \
                      deliberately, not silently passed"
                .to_string(),
        }),
    };
    if drift.is_some() {
        findings.push(RegressionFinding::new(
            &tuple_id,
            RegressionFindingKind::DiagnosticDrift,
            "diagnostics drifted from the recorded baseline",
        ));
    }

    let status = if findings.is_empty() {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };

    RegressionTupleResult {
        tuple_id,
        entry,
        fixture_resolution,
        resolved_fixture_id,
        secret_metadata,
        diagnostics_fingerprint: current_fingerprint,
        findings,
        drift,
        status,
    }
}

/// Run the claimed-profile regression: re-run every tuple in `bundle`
/// against the `catalogue`, the bundle's reproduction proofs, and the
/// recorded `baseline`. Never panics, never returns `Err`.
/// The report FAILS iff any claim is missing fixture evidence, is missing
/// required secret metadata, overclaims, or has drifted from the baseline.
pub fn run_claimed_profile_regression(
    bundle: &ReproBundle,
    catalogue: &PublicFixtureCatalogue,
    baseline: &RegressionBaseline,
) -> ClaimedProfileRegressionReport {
    let results: Vec<RegressionTupleResult> = bundle
        .support_tuples
        .iter()
        .map(|tuple| run_one(bundle, catalogue, baseline, tuple))
        .collect();

    let passed_count = results.iter().filter(|r| r.is_passed()).count() as u64;
    let failed_count = results.len() as u64 - passed_count;
    let drift_count = results.iter().filter(|r| r.drift.is_some()).count() as u64;
    let status = if failed_count == 0 {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };

    ClaimedProfileRegressionReport {
        schema_version: REGRESSION_REPORT_SCHEMA_VERSION.to_string(),
        boundary: REGRESSION_BOUNDARY.to_string(),
        bundle_id: bundle.bundle_id.clone(),
        status,
        tuple_count: results.len() as u64,
        passed_count,
        failed_count,
        drift_count,
        results,
    }
}
