use super::*;
use crate::compat_regression::fixtures::*;
use crate::repro_bundle::fixtures as bundle_fixtures;

#[test]
#[ignore = "developer helper: regenerates the committed regression fixtures"]
fn emit_committed_fixtures() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/kaifuu/compat-regression");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("public-fixture-catalogue.json"),
        format!("{}\n", stable_json(&public_catalogue()).unwrap()),
    )
    .unwrap();
    std::fs::write(
        dir.join("baseline.json"),
        format!("{}\n", stable_json(&baseline()).unwrap()),
    )
    .unwrap();
}

#[test]
fn clean_run_passes_and_records_every_tuple_field() {
    let bundle = bundle_fixtures::clean_bundle();
    let report = run_claimed_profile_regression(&bundle, &public_catalogue(), &baseline());

    assert!(report.is_clean(), "{report:#?}");
    assert_eq!(report.status, OperationStatus::Passed);
    assert_eq!(report.tuple_count, bundle.support_tuples.len() as u64);
    assert_eq!(report.passed_count, report.tuple_count);
    assert_eq!(report.failed_count, 0);
    assert_eq!(report.drift_count, 0);

    // Every recorded tuple field survives the round-trip through the result.
    for tuple in &bundle.support_tuples {
        let result = report
            .result(&tuple.profile_or_fixture_id)
            .expect("every tuple has a result");
        assert!(result.is_passed());
        assert_eq!(result.fixture_resolution, FixtureResolutionStatus::Resolved);
        assert!(result.resolved_fixture_id.is_some());
        assert!(result.findings.is_empty());
        assert!(result.drift.is_none());
        // The embedded entry records all ten identity/transform fields.
        assert_eq!(result.entry.engine_family, tuple.engine_family);
        assert_eq!(result.entry.engine_variant, tuple.engine_variant);
        assert_eq!(result.entry.container, tuple.container);
        assert_eq!(result.entry.crypto, tuple.crypto);
        assert_eq!(result.entry.codec, tuple.codec);
        assert_eq!(result.entry.surface, tuple.surface);
        assert_eq!(result.entry.patch_back_mode, tuple.patch_back_mode);
        assert_eq!(
            result.entry.secret_requirement_ids,
            tuple.secret_requirement_ids
        );
        assert!(!result.entry.diagnostics.is_empty());
    }
}

#[test]
fn missing_reproduction_proof_fails_the_claim() {
    // Drop the reproduction proof for the first tuple → missing fixture
    // evidence. NOT a skip, NOT a silent pass.
    let mut bundle = bundle_fixtures::clean_bundle();
    let orphaned = bundle.support_tuples[0].profile_or_fixture_id.clone();
    bundle
        .reproduction_proofs
        .retain(|proof| proof.tuple_id != orphaned);

    let report = run_claimed_profile_regression(&bundle, &public_catalogue(), &baseline());
    assert_eq!(report.status, OperationStatus::Failed);
    let result = report.result(&orphaned).expect("result present");
    assert!(!result.is_passed());
    assert_eq!(
        result.fixture_resolution,
        FixtureResolutionStatus::MissingReproductionProof
    );
    assert!(
        !report
            .findings_of(RegressionFindingKind::MissingFixtureEvidence)
            .is_empty()
    );
}

#[test]
fn unknown_public_fixture_fails_the_claim() {
    // The proof resolves to a tuple, but the fixture id is not in the
    // catalogue → not reproducible → fail.
    let bundle = bundle_fixtures::clean_bundle();
    let empty_catalogue = PublicFixtureCatalogue::new([]);
    let report = run_claimed_profile_regression(&bundle, &empty_catalogue, &baseline());
    assert_eq!(report.status, OperationStatus::Failed);
    for result in &report.results {
        assert_eq!(
            result.fixture_resolution,
            FixtureResolutionStatus::UnknownPublicFixture
        );
        assert!(!result.is_passed());
    }
    assert_eq!(
        report
            .findings_of(RegressionFindingKind::MissingFixtureEvidence)
            .len(),
        report.results.len()
    );
}

#[test]
fn missing_secret_requirement_metadata_fails_the_claim() {
    // The siglus tuple's crypto is a fixed key → it MUST declare secret
    // requirement metadata. Strip it → fail (not a silent pass).
    let mut bundle = bundle_fixtures::clean_bundle();
    let siglus_id = {
        let siglus = bundle
            .support_tuples
            .iter_mut()
            .find(|t| crypto_requires_secret(t.crypto))
            .expect("clean bundle has a key-gated tuple");
        assert!(!siglus.secret_requirement_ids.is_empty());
        siglus.secret_requirement_ids.clear();
        siglus.profile_or_fixture_id.clone()
    };
    // Re-baseline so the drift gate does not also fire (isolate the cause):
    // clearing secret metadata does not change the typed diagnostics.
    let report = run_claimed_profile_regression(&bundle, &public_catalogue(), &baseline());
    let result = report.result(&siglus_id).expect("result present");
    assert_eq!(result.secret_metadata, SecretMetadataStatus::Missing);
    assert!(!result.is_passed());
    assert_eq!(report.status, OperationStatus::Failed);
    assert!(
        !report
            .findings_of(RegressionFindingKind::MissingSecretRequirementMetadata)
            .is_empty()
    );
}

#[test]
fn diagnostic_drift_is_surfaced_not_silently_updated() {
    // Baseline the clean bundle, then mutate a tuple's declared diagnostics.
    // The runner must SURFACE the change as drift — and must NOT rewrite the
    // recorded baseline.
    let recorded = baseline();
    let recorded_before = recorded.clone();

    let mut bundle = bundle_fixtures::clean_bundle();
    let drifted_id = {
        let tuple = &mut bundle.support_tuples[0];
        tuple.diagnostics.push(CompatDiagnostic::new(
            crate::compat_profile::CompatLayer::Runtime,
            crate::compat_profile::CompatDiagnosticStatus::NotImplemented,
            crate::SemanticErrorCode::UnsupportedLayeredTransform,
            crate::PartialDiagnosticSeverity::P3,
        ));
        tuple.profile_or_fixture_id.clone()
    };

    let report = run_claimed_profile_regression(&bundle, &public_catalogue(), &recorded);
    assert_eq!(report.status, OperationStatus::Failed);
    assert_eq!(report.drift_count, 1);

    let result = report.result(&drifted_id).expect("result present");
    assert!(!result.is_passed());
    let drift = result.drift.as_ref().expect("drift recorded");
    assert!(drift.baseline_fingerprint.is_some());
    assert_ne!(
        drift.baseline_fingerprint.as_ref().unwrap(),
        &drift.current_fingerprint
    );
    assert!(
        !report
            .findings_of(RegressionFindingKind::DiagnosticDrift)
            .is_empty()
    );
    // The recorded baseline was NOT silently updated by the run.
    assert_eq!(recorded, recorded_before);
}

#[test]
fn unbaselined_tuple_is_drift_not_silent_pass() {
    // A tuple absent from the recorded baseline must not silently pass — it
    // drifts (with no baseline fingerprint) until deliberately baselined.
    let bundle = bundle_fixtures::clean_bundle();
    let empty_baseline = RegressionBaseline {
        schema_version: REGRESSION_BASELINE_SCHEMA_VERSION.to_string(),
        entries: vec![],
    };
    let report = run_claimed_profile_regression(&bundle, &public_catalogue(), &empty_baseline);
    assert_eq!(report.status, OperationStatus::Failed);
    assert_eq!(report.drift_count, report.tuple_count);
    for result in &report.results {
        let drift = result.drift.as_ref().expect("unbaselined → drift");
        assert!(drift.baseline_fingerprint.is_none());
    }
}

#[test]
fn overclaim_tuple_fails_the_regression() {
    // A bundle embedding an overclaiming tuple fails via the rolled-up
    // gate — even with a resolvable fixture + baseline.
    let mut bundle = bundle_fixtures::clean_bundle();
    let overclaim = crate::compat_profile::fixtures::overclaim_patch_without_evidence();
    let overclaim_id = overclaim.profile_or_fixture_id.clone();
    bundle
        .reproduction_proofs
        .push(crate::repro_bundle::ReproductionProof::new(
            overclaim_id.clone(),
            "public/siglus-known-key-extract",
            ProofHash::new(sha256_hash_bytes(b"overclaim")).unwrap(),
        ));
    bundle.support_tuples.push(overclaim);
    let baseline = RegressionBaseline::from_bundle(&bundle);

    let report = run_claimed_profile_regression(&bundle, &public_catalogue(), &baseline);
    assert_eq!(report.status, OperationStatus::Failed);
    let result = report.result(&overclaim_id).expect("result present");
    assert!(!result.is_passed());
    assert!(
        !report
            .findings_of(RegressionFindingKind::OverclaimTuple)
            .is_empty()
    );
}

#[test]
fn result_artifact_is_redacted_and_ref_only() {
    let bundle = bundle_fixtures::clean_bundle();
    let report = run_claimed_profile_regression(&bundle, &public_catalogue(), &baseline());
    let json = report.stable_json().expect("serialize");
    // Ref-only: proof-hash refs + local-secret refs, no raw material.
    assert!(json.contains("sha256:"));
    assert!(json.contains("local-secret:"));
    assert!(!json.contains("BEGIN"));
    assert!(!json.contains("/home/"));
    assert!(!json.contains("deadbeef"));
}

#[test]
fn fingerprint_is_stable_and_detail_insensitive() {
    // The typed-identity fingerprint ignores free-text detail: a detail-only
    // change is NOT drift, a typed-field change IS.
    let base = bundle_fixtures::clean_bundle().support_tuples[0]
        .diagnostics
        .clone();
    let mut detail_only = base.clone();
    detail_only[0].detail = Some("a completely different, longer human note".to_string());
    assert_eq!(
        diagnostics_fingerprint(&base),
        diagnostics_fingerprint(&detail_only),
        "detail-only change must not register as drift"
    );

    let mut typed_change = base.clone();
    typed_change[0].severity = crate::PartialDiagnosticSeverity::P0;
    assert_ne!(
        diagnostics_fingerprint(&base),
        diagnostics_fingerprint(&typed_change),
        "a typed-field change must register as drift"
    );
}
