use super::*;
use crate::xp3_production::synthetic;

fn proof(byte: u8) -> ProofHash {
    ProofHash::new(format!("sha256:{}", format!("{byte:02x}").repeat(32)))
        .expect("synthetic proof hash")
}

fn passed_stages() -> Vec<Xp3PrivateLocalValidationStageOutcome> {
    Xp3PrivateLocalValidationStage::ordered()
        .iter()
        .enumerate()
        .map(|(index, stage)| Xp3PrivateLocalValidationStageOutcome {
            stage: *stage,
            state: Xp3PrivateLocalValidationState::Passed,
            proof_hash: proof(0x90 + u8::try_from(index).unwrap()),
        })
        .collect()
}

fn manifest(
    entries: Vec<Xp3PrivateLocalValidationManifestEntry>,
) -> Xp3PrivateLocalValidationManifest {
    Xp3PrivateLocalValidationManifest {
        schema_version: XP3_PRIVATE_LOCAL_VALIDATION_SCHEMA_VERSION.to_string(),
        validation_id: "kaifuu-k144-xp3-private-local-validation".to_string(),
        entries,
    }
}

/// The genuine WORKFLOW-BOUND round-trip proof hash for `tuple_id`, computed
/// from a real production round-trip over `registry`. An entry
/// declaring this exact value is honored; anything else is a label-only proof.
fn workflow_bound_proof(registry: &Xp3ProductionRegistry, tuple_id: &str) -> ProofHash {
    let workflow = run_xp3_production(registry, "xp3-private-local-validation")
        .expect("production workflow runs");
    canonical_xp3_round_trip_proof_hash_from_workflow(&workflow, tuple_id)
        .expect("workflow round-trips the claimed tuple")
}

/// A claimed entry whose declared round-trip proof BINDS to the real workflow
/// round-trip for `tuple_id` (so it is honored and can reach `Passed`).
fn entry(
    registry: &Xp3ProductionRegistry,
    tuple_id: &str,
) -> Xp3PrivateLocalValidationManifestEntry {
    Xp3PrivateLocalValidationManifestEntry {
        corpus_id_redacted: "owned-xp3-corpus-a".to_string(),
        claimed_support_tuple_id: tuple_id.to_string(),
        profile_id_redacted: "owned-xp3-profile-a".to_string(),
        result: Xp3PrivateLocalValidationState::Passed,
        round_trip_proof_hash: workflow_bound_proof(registry, tuple_id),
        proof_hashes: vec![proof(0x80)],
        stages: passed_stages(),
    }
}

/// An entry for a tuple OUTSIDE the claimed profile (the workflow never
/// round-trips it, so its proof is never honored — it is classified
/// out-of-profile before the round-trip gate). Uses a placeholder hash.
fn out_of_profile_entry(tuple_id: &str) -> Xp3PrivateLocalValidationManifestEntry {
    Xp3PrivateLocalValidationManifestEntry {
        corpus_id_redacted: "owned-xp3-corpus-a".to_string(),
        claimed_support_tuple_id: tuple_id.to_string(),
        profile_id_redacted: "owned-xp3-profile-a".to_string(),
        result: Xp3PrivateLocalValidationState::Passed,
        round_trip_proof_hash: proof(0x81),
        proof_hashes: vec![proof(0x80)],
        stages: passed_stages(),
    }
}

fn run(
    manifest: Option<&Xp3PrivateLocalValidationManifest>,
    registry: &Xp3ProductionRegistry,
) -> Xp3PrivateLocalValidationReport {
    run_xp3_private_local_validation(Xp3PrivateLocalValidationInput {
        validation_id: "kaifuu-k144-xp3-private-local-validation",
        manifest,
        registry,
    })
    .expect("validation report")
}

#[test]
fn no_private_inputs_emit_deterministic_skipped_artifact() {
    let registry = synthetic::production_registry();
    let a = run(None, &registry);
    let b = run(None, &registry);

    assert_eq!(a.status, Xp3PrivateLocalValidationState::Skipped);
    assert_eq!(
        a.reason.as_deref(),
        Some(SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_SKIPPED)
    );
    assert_eq!(
        a.alpha_proofs.retail_validation,
        Xp3RetailValidationPosture::NotPrivateValidated
    );
    assert_eq!(a.configured_private_inputs, 0);
    assert_eq!(a.stable_json().unwrap(), b.stable_json().unwrap());
    assert!(a.redaction_summary.deep_scan_performed);
    assert_eq!(a.redaction_summary.secret_leak_findings, 0);
}

#[test]
fn configured_claimed_input_passes_and_records_all_stage_aggregates() {
    let registry = synthetic::production_registry();
    let manifest = manifest(vec![entry(&registry, "kaifuu-k057-xp3-simple-crypt")]);
    let report = run(Some(&manifest), &registry);

    assert_eq!(report.status, Xp3PrivateLocalValidationState::Passed);
    assert!(report.is_private_validated());
    assert_eq!(report.result_counts.passed, 1);
    assert_eq!(report.claimed_private_inputs, 1);
    assert_eq!(report.out_of_profile_inputs, 0);
    assert_eq!(report.stage_bins.detect.passed, 1);
    assert_eq!(report.stage_bins.key_profile_resolve.passed, 1);
    assert_eq!(report.stage_bins.extract.passed, 1);
    assert_eq!(report.stage_bins.trivial_patch.passed, 1);
    assert_eq!(report.stage_bins.verify.passed, 1);
    assert_eq!(report.stage_bins.delta_apply.passed, 1);
    assert_eq!(report.regression.status, OperationStatus::Passed);
    assert!(report.regression.production_report_hash.is_some());
    assert!(
        report
            .proof_hashes
            .iter()
            .any(|hash| hash.as_str() == proof(0x80).as_str())
    );
}

#[test]
fn claimed_stage_failure_is_a_failed_compatibility_regression() {
    let registry = synthetic::production_registry();
    let mut failed = entry(&registry, "kaifuu-k057-xp3-simple-crypt");
    failed.result = Xp3PrivateLocalValidationState::Failed;
    failed.stages[2].state = Xp3PrivateLocalValidationState::Failed;
    let manifest = manifest(vec![failed]);

    let report = run(Some(&manifest), &registry);

    assert_eq!(report.status, Xp3PrivateLocalValidationState::Failed);
    assert_eq!(
        report.alpha_proofs.retail_validation,
        Xp3RetailValidationPosture::PrivateValidationFailed
    );
    assert_eq!(report.result_counts.failed, 1);
    assert_eq!(report.stage_bins.extract.failed, 1);
    assert!(report.diagnostics.iter().any(|diagnostic| {
        diagnostic.semantic_code == SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_CLAIMED_FAILED
            && diagnostic.severity == PartialDiagnosticSeverity::P0
    }));
}

#[test]
fn out_of_profile_input_produces_semantic_diagnostic_not_claimed_failure() {
    let registry = synthetic::production_registry();
    let manifest = manifest(vec![out_of_profile_entry("unknown-retail-xp3-profile")]);

    let report = run(Some(&manifest), &registry);

    assert_eq!(report.status, Xp3PrivateLocalValidationState::OutOfProfile);
    assert_eq!(
        report.alpha_proofs.retail_validation,
        Xp3RetailValidationPosture::OutOfProfileOnly
    );
    assert_eq!(report.result_counts.failed, 0);
    assert_eq!(report.result_counts.out_of_profile, 1);
    assert_eq!(report.stage_bins.detect.out_of_profile, 1);
    assert_eq!(
        report.rows[0].result,
        Xp3PrivateLocalValidationState::OutOfProfile
    );
    assert!(report.diagnostics.iter().any(|diagnostic| {
        diagnostic.semantic_code == SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_OUT_OF_PROFILE
    }));
}

#[test]
fn production_regression_failure_blocks_claimed_private_validation() {
    // Build the entry against a healthy registry (a genuinely workflow-bound
    // proof), then break the registry so the workflow fails at run time.
    let healthy = synthetic::production_registry();
    let manifest = manifest(vec![entry(&healthy, "kaifuu-k057-xp3-simple-crypt")]);
    let mut registry = synthetic::production_registry();
    registry.variants[0].set_resolved_key_evidence(None);

    let report = run(Some(&manifest), &registry);

    assert_eq!(report.status, Xp3PrivateLocalValidationState::Failed);
    assert_eq!(report.regression.status, OperationStatus::Failed);
    assert!(report.regression.production_report_hash.is_none());
    assert!(report.diagnostics.iter().any(|diagnostic| {
        diagnostic.semantic_code == SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_REGRESSION_FAILED
    }));
}

#[test]
fn report_rejects_private_paths_helper_dumps_and_raw_material() {
    let registry = synthetic::production_registry();
    let mut leaking = entry(&registry, "kaifuu-k057-xp3-simple-crypt");
    leaking.profile_id_redacted = "/home/operator/private-title/data.xp3".to_string();
    let leaking_manifest = manifest(vec![leaking]);

    let error = run_xp3_private_local_validation(Xp3PrivateLocalValidationInput {
        validation_id: "kaifuu-k144-xp3-private-local-validation",
        manifest: Some(&leaking_manifest),
        registry: &registry,
    })
    .expect_err("private path must fail before a report is returned");
    assert!(
        error
            .to_string()
            .contains(SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_SECRET_LEAK)
    );

    let mut leaking = entry(&registry, "kaifuu-k057-xp3-simple-crypt");
    leaking.profile_id_redacted = "raw helper dump: registers and memory".to_string();
    let leaking_manifest = manifest(vec![leaking]);
    let error = run_xp3_private_local_validation(Xp3PrivateLocalValidationInput {
        validation_id: "kaifuu-k144-xp3-private-local-validation",
        manifest: Some(&leaking_manifest),
        registry: &registry,
    })
    .expect_err("helper dump must fail before a report is returned");
    assert!(
        error
            .to_string()
            .contains(SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_SECRET_LEAK)
    );
}

#[test]
fn configured_entries_must_record_every_validation_stage() {
    let registry = synthetic::production_registry();
    let mut incomplete = entry(&registry, "kaifuu-k057-xp3-simple-crypt");
    incomplete.stages.pop();
    let manifest = manifest(vec![incomplete]);

    let error = run_xp3_private_local_validation(Xp3PrivateLocalValidationInput {
        validation_id: "kaifuu-k144-xp3-private-local-validation",
        manifest: Some(&manifest),
        registry: &registry,
    })
    .expect_err("missing stage must be semantic failure");
    assert!(error.to_string().contains("missing stage deltaApply"));
}

// ---: readiness BINDS to a VERIFIED round-trip (not a label). --

#[test]
fn passed_row_proof_equals_the_workflow_bound_round_trip_value() {
    // The honored proof is EXACTLY the value recomputed from the real
    // extract-patch-verify round-trip output for this tuple — not
    // a static label. This is what binds `PrivateValidated` to a verified
    // round-trip.
    let registry = synthetic::production_registry();
    let canonical = workflow_bound_proof(&registry, "kaifuu-k057-xp3-simple-crypt");
    let manifest = manifest(vec![entry(&registry, "kaifuu-k057-xp3-simple-crypt")]);
    let report = run(Some(&manifest), &registry);

    assert_eq!(report.status, Xp3PrivateLocalValidationState::Passed);
    assert!(report.is_private_validated());
    // The verified workflow-bound proof entered the aggregate + row proof set.
    assert!(report.proof_hashes.contains(&canonical));
    assert!(report.rows[0].proof_hashes.contains(&canonical));
}

#[test]
fn a_label_only_proof_does_not_reach_private_validated() {
    // THE missing regression: a claimed row whose declared round-trip proof
    // is a mintable label (derived from a kind/id string, exactly the
    // anti-pattern) must NOT reach patch-proven. It is refused by
    // the workflow binding even though every stage/result is authored "passed".
    let registry = synthetic::production_registry();
    let label_hash = ProofHash::new(sha256_hash_bytes(
        b"kaifuu-k144-xp3-readiness/kaifuu-k057-xp3-simple-crypt/label",
    ))
    .unwrap();
    let mut labelled = entry(&registry, "kaifuu-k057-xp3-simple-crypt");
    // Sanity: the label hash is NOT the workflow-bound value.
    assert_ne!(labelled.round_trip_proof_hash, label_hash);
    labelled.round_trip_proof_hash = label_hash;
    let manifest = manifest(vec![labelled]);

    let report = run(Some(&manifest), &registry);

    // The label-only proof is refused → the row FAILS, is NOT private-validated.
    assert_eq!(report.status, Xp3PrivateLocalValidationState::Failed);
    assert!(!report.is_private_validated());
    assert_eq!(
        report.alpha_proofs.retail_validation,
        Xp3RetailValidationPosture::PrivateValidationFailed
    );
    assert_eq!(report.result_counts.passed, 0);
    assert_eq!(report.result_counts.failed, 1);
    assert!(report.diagnostics.iter().any(|diagnostic| {
        diagnostic.semantic_code == SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_UNVERIFIED_PROOF
            && diagnostic.severity == PartialDiagnosticSeverity::P0
    }));
    // And the refused label proof never entered the proof set.
    let label_hash_again = ProofHash::new(sha256_hash_bytes(
        b"kaifuu-k144-xp3-readiness/kaifuu-k057-xp3-simple-crypt/label",
    ))
    .unwrap();
    assert!(!report.proof_hashes.contains(&label_hash_again));
}

#[test]
fn a_broken_workflow_fails_loud_and_never_reaches_patch_proven() {
    // A claimed row with a genuine (previously workflow-bound) proof, but the
    // workflow itself is broken so it cannot re-derive/verify the round-trip.
    // The row must fail LOUD (typed workflow-unproven diagnostic), never a
    // silent skip, and must not reach patch-proven.
    let healthy = synthetic::production_registry();
    let manifest = manifest(vec![entry(&healthy, "kaifuu-k057-xp3-simple-crypt")]);
    let mut broken = synthetic::production_registry();
    broken.variants[0].set_resolved_key_evidence(None);

    let report = run(Some(&manifest), &broken);

    assert_eq!(report.status, Xp3PrivateLocalValidationState::Failed);
    assert!(!report.is_private_validated());
    assert_eq!(report.result_counts.passed, 0);
    // The broken workflow surfaces the loud production-regression diagnostic
    // (the regression gate fires before the per-row round-trip binding).
    assert!(report.diagnostics.iter().any(|diagnostic| {
        (diagnostic.semantic_code == SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_REGRESSION_FAILED
            || diagnostic.semantic_code == SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_WORKFLOW_UNPROVEN)
            && diagnostic.severity == PartialDiagnosticSeverity::P0
    }));
    assert_eq!(report.regression.status, OperationStatus::Failed);
}

#[test]
fn a_tuple_the_workflow_never_round_trips_cannot_be_honored() {
    // Directly exercise the per-row workflow-unproven path: even a passing
    // workflow yields no canonical proof for a tuple it did not round-trip,
    // so honor_round_trip_proof refuses it loud.
    let registry = synthetic::production_registry();
    let workflow = run_xp3_production(&registry, "xp3-private-local-validation")
        .expect("production workflow runs");
    assert!(
        canonical_xp3_round_trip_proof_hash_from_workflow(&workflow, "not-a-real-tuple").is_none()
    );
}
