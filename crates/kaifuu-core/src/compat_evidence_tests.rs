use super::*;

use super::fixtures::*;
use crate::compat_regression::fixtures as regression_fixtures;
use crate::repro_bundle::fixtures as bundle_fixtures;

const GOLDEN: &str =
    include_str!("../../../fixtures/kaifuu/compat-evidence/compat-evidence-report.json");

#[test]
#[ignore = "developer helper: regenerates the committed compat-evidence golden fixture"]
fn emit_committed_golden() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/kaifuu/compat-evidence");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("compat-evidence-report.json"),
        clean_report().stable_json().unwrap(),
    )
    .unwrap();
}

#[test]
fn clean_report_integrates_all_three_sources_per_claim() {
    let bundle = bundle_fixtures::clean_bundle();
    let report = clean_report();

    assert!(report.is_clean(), "{report:#?}");
    assert_eq!(report.status, OperationStatus::Passed);
    assert!(report.bundle_self_sufficient);
    assert_eq!(report.private_asset_violation_count, 0);
    assert_eq!(report.reproduction_gap_count, 0);
    assert_eq!(report.drift_count, 0);
    assert_eq!(
        report.claimed_support_count,
        bundle.support_tuples.len() as u64
    );
    assert_eq!(report.passed_count, report.claimed_support_count);
    assert_eq!(report.failed_count, 0);

    // For EVERY claimed support the integrated row lists all required fields
    // from all three sources.
    for tuple in &bundle.support_tuples {
        let support = report
            .support(&tuple.profile_or_fixture_id)
            .expect("every claimed tuple has an integrated evidence row");

        // tuple fields.
        assert_eq!(support.engine_family, tuple.engine_family);
        assert_eq!(support.engine_variant, tuple.engine_variant);
        assert_eq!(support.container, tuple.container);
        assert_eq!(support.crypto, tuple.crypto);
        assert_eq!(support.codec, tuple.codec);
        assert_eq!(support.surface, tuple.surface);
        assert_eq!(support.patch_back_mode, tuple.patch_back_mode);
        assert_eq!(support.profile_or_fixture_id, tuple.profile_or_fixture_id);
        assert_eq!(support.claimed_level, tuple.claimed_level);
        // Secret-requirement IDS only (never the values).
        let expected_ids: Vec<String> = tuple
            .secret_requirement_ids
            .iter()
            .map(|r| r.requirement_id.clone())
            .collect();
        assert_eq!(support.secret_requirement_ids, expected_ids);
        // Merged diagnostics are present (author-declared at minimum).
        assert!(!support.diagnostics.is_empty());

        // repro-bundle index entry.
        let index = support
            .repro_bundle_index
            .as_ref()
            .expect("clean claim links to its reproduction bundle");
        assert_eq!(index.bundle_id, bundle.bundle_id);
        assert_eq!(index.tuple_id, tuple.profile_or_fixture_id);
        assert!(!index.fixture_id.is_empty());

        // latest regression verdict.
        assert!(support.is_passed());
        assert_eq!(support.latest_regression.status, OperationStatus::Passed);
        assert_eq!(
            support.latest_regression.fixture_resolution,
            FixtureResolutionStatus::Resolved
        );
        assert_eq!(
            support.latest_regression.resolved_fixture_id.as_deref(),
            Some(index.fixture_id.as_str())
        );
        assert!(support.latest_regression.findings.is_empty());
        assert!(support.latest_regression.drift.is_none());
    }
}

#[test]
fn golden_fixture_matches_integrated_report() {
    // The committed golden asserts the exact integrated shape.
    let produced = clean_report().stable_json().expect("serialize");
    assert_eq!(
        produced, GOLDEN,
        "committed golden is stale — re-run the ignored `emit_committed_golden` helper"
    );
}

#[test]
fn report_is_redaction_clean_ref_only() {
    let report = clean_report();
    let json = report.stable_json().expect("serialize");
    // Ref-only: sha256 proof hashes + local-secret refs survive; no raw
    // material, no private paths, no retail/story bytes, no bare
    // "unsupported" diagnostic status.
    assert!(json.contains("sha256:"));
    assert!(json.contains("local-secret:") || !json.contains("secretRef"));
    assert!(!json.contains("BEGIN"));
    assert!(!json.contains("/home/"));
    assert!(!json.contains("deadbeef"));
    assert!(!json.contains("\"status\":\"unsupported\""));
    // The golden on disk is likewise redaction-clean.
    assert!(!GOLDEN.contains("BEGIN"));
    assert!(!GOLDEN.contains("/home/"));
    assert!(!GOLDEN.contains("deadbeef"));
}

#[test]
fn missing_reproduction_proof_surfaces_in_both_index_and_regression() {
    // Drop a claim's reproduction proof: the integration must show a `None`
    // index AND a failing regression verdict for that claim — never a silent
    // pass.
    let mut bundle = bundle_fixtures::clean_bundle();
    let orphaned = bundle.support_tuples[0].profile_or_fixture_id.clone();
    bundle
        .reproduction_proofs
        .retain(|proof| proof.tuple_id != orphaned);

    let report = integrate_compat_evidence(
        &bundle,
        &regression_fixtures::public_catalogue(),
        &regression_fixtures::baseline(),
    );
    assert_eq!(report.status, OperationStatus::Failed);
    assert!(!report.bundle_self_sufficient);
    let support = report.support(&orphaned).expect("row present");
    assert!(support.repro_bundle_index.is_none());
    assert!(!support.is_passed());
    assert_eq!(
        support.latest_regression.fixture_resolution,
        FixtureResolutionStatus::MissingReproductionProof
    );
    assert!(!support.latest_regression.findings.is_empty());
}

#[test]
fn overclaim_tuple_fails_the_integrated_report() {
    // A bundle embedding an overclaiming tuple fails the integration through
    // both the bundle validator and the regression gate.
    let mut bundle = bundle_fixtures::clean_bundle();
    let overclaim = crate::compat_profile::fixtures::overclaim_patch_without_evidence();
    let overclaim_id = overclaim.profile_or_fixture_id.clone();
    bundle
        .reproduction_proofs
        .push(crate::repro_bundle::ReproductionProof::new(
            overclaim_id.clone(),
            "public/siglus-known-key-extract",
            ProofHash::new(crate::sha256_hash_bytes(b"overclaim")).unwrap(),
        ));
    bundle.support_tuples.push(overclaim);
    let baseline = RegressionBaseline::from_bundle(&bundle);

    let report =
        integrate_compat_evidence(&bundle, &regression_fixtures::public_catalogue(), &baseline);
    assert_eq!(report.status, OperationStatus::Failed);
    let support = report.support(&overclaim_id).expect("row present");
    assert!(!support.is_passed());
}

#[test]
fn report_round_trips_through_json() {
    let report = clean_report();
    let json = serde_json::to_string(&report.redacted_for_report()).expect("serialize");
    let round: CompatEvidenceReport = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(round, report.redacted_for_report());
}
