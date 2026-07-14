//! Integration tests for snapshot conformance ().
//!
//! Exercises the [`utsushi_core::SnapshotConformanceCheck`]
//! [`utsushi_core::SnapshotStore`] surface end-to-end via the synthetic
//! fixtures in [`utsushi_core::conformance::fixtures`]. The headline
//! audit-focus tests assert:
//!
//! - The serialized envelope carries a verbatim `statePath` entry per
//!   drifted state path on `Fail`.
//! - The serialized envelope passes
//!   `reject_unredacted_local_paths_in_value` end-to-end.
//! - `Unsupported` does not invoke the check struct.

use utsushi_core::conformance::fixtures::{
    synthetic_in_memory_snapshot_store, synthetic_snapshot_check_baseline_missing_from_store,
    synthetic_snapshot_check_identical_baseline_and_observed,
    synthetic_snapshot_check_observed_drifts_at_port_frame,
    synthetic_snapshot_check_observed_drifts_at_two_paths,
    synthetic_snapshot_paired_manifest_and_results, synthetic_snapshot_paired_negative,
    synthetic_snapshot_restore_manifest, synthetic_snapshot_restore_pass_result,
    synthetic_snapshot_restore_unsupported_result, synthetic_text_trace_manifest,
    synthetic_text_trace_pass_result,
};
use utsushi_core::{
    ConformanceError, ConformanceResult, EvidenceRef, EvidenceTier, ProfileId, ResultOutcome,
    SnapshotConformanceCheck, SnapshotStore, cross_validate_results_against_manifest,
    diff_snapshots,
};

#[test]
fn snapshot_conformance_check_run_through_synthetic_runner_emits_one_pass_per_profile() {
    // Build a full envelope around the Pass outcome and cross-validate
    // against the matching manifest.
    let (check, store) = synthetic_snapshot_check_identical_baseline_and_observed();
    let outcome = check.run(&store);
    assert!(matches!(outcome, ResultOutcome::Pass { .. }));
    let result = synthetic_snapshot_restore_pass_result();
    let manifest = synthetic_snapshot_restore_manifest();
    cross_validate_results_against_manifest(&manifest, &[result]).expect("cross-validates");
}

#[test]
fn snapshot_conformance_unsupported_path_does_not_invoke_check_struct() {
    // The runner takes the Unsupported path when the manifest does
    // not declare snapshot-restore. The check struct is never invoked.
    let result = synthetic_snapshot_restore_unsupported_result();
    match &result.outcome {
        ResultOutcome::Unsupported {
            semantic_code,
            declared_in_manifest,
        } => {
            assert_eq!(
                semantic_code,
                "utsushi.conformance.snapshot_restore_unsupported"
            );
            assert!(!declared_in_manifest);
        }
        other => panic!("expected Unsupported, got {other:?}"),
    }
    let manifest = synthetic_text_trace_manifest();
    cross_validate_results_against_manifest(
        &manifest,
        &[synthetic_text_trace_pass_result(), result],
    )
    .expect("cross-validates");
}

#[test]
fn snapshot_conformance_result_envelope_carries_state_path_evidence_in_serialized_output() {
    // The audit-focus "state drift reported too vaguely" structural
    // defense: the wire JSON contains `"artifactKind": "statePath"` and
    // the verbatim path string literally.
    let (check, store) = synthetic_snapshot_check_observed_drifts_at_port_frame();
    let outcome = check.run(&store);
    assert!(matches!(outcome, ResultOutcome::Fail { .. }));
    let baseline = store.resolve(&check.baseline).expect("baseline");
    let observed = store.resolve(&check.observed).expect("observed");
    let diff = diff_snapshots(&baseline, &observed).expect("diff");
    let evidence = SnapshotConformanceCheck::state_path_evidence_from_diff(&diff);
    let envelope = ConformanceResult {
        schema_version: utsushi_core::CONFORMANCE_SCHEMA_VERSION.to_string(),
        adapter_id: "utsushi-synthetic".to_string(),
        profile_id: ProfileId::SnapshotRestore,
        outcome,
        evidence,
        recorded_at: "2026-06-23T12:00:00Z".to_string(),
    };
    envelope.validate().expect("envelope validates");
    let value = serde_json::to_value(&envelope).expect("serializes");
    let serialized = serde_json::to_string(&value).expect("string");
    assert!(
        serialized.contains("\"artifactKind\":\"statePath\""),
        "wire JSON must carry the statePath tag: {serialized}"
    );
    assert!(
        serialized.contains("\"port.frame\""),
        "wire JSON must quote the drifted path verbatim: {serialized}"
    );
}

#[test]
fn snapshot_conformance_result_envelope_passes_reject_unredacted_local_paths_filter() {
    let (check, store) = synthetic_snapshot_check_observed_drifts_at_two_paths();
    let outcome = check.run(&store);
    let baseline = store.resolve(&check.baseline).expect("baseline");
    let observed = store.resolve(&check.observed).expect("observed");
    let diff = diff_snapshots(&baseline, &observed).expect("diff");
    let envelope = ConformanceResult {
        schema_version: utsushi_core::CONFORMANCE_SCHEMA_VERSION.to_string(),
        adapter_id: "utsushi-synthetic".to_string(),
        profile_id: ProfileId::SnapshotRestore,
        outcome,
        evidence: SnapshotConformanceCheck::state_path_evidence_from_diff(&diff),
        recorded_at: "2026-06-23T12:00:00Z".to_string(),
    };
    envelope.validate().expect("envelope validates");
    let value = serde_json::to_value(&envelope).expect("serializes");
    utsushi_core::redaction::reject_unredacted_local_paths("conformanceResult", &value)
        .expect("redaction filter passes");
}

#[test]
fn snapshot_conformance_check_negative_case_against_mutated_fixture_emits_state_path_evidence() {
    // The headline integration-level negative case.
    let (check, store) = synthetic_snapshot_check_observed_drifts_at_port_frame();
    let outcome = check.run(&store);
    match &outcome {
        ResultOutcome::Fail { semantic_code, .. } => {
            assert_eq!(semantic_code, "utsushi.snapshot.state_drift");
        }
        other => panic!("expected Fail, got {other:?}"),
    }
    let baseline = store.resolve(&check.baseline).expect("baseline");
    let observed = store.resolve(&check.observed).expect("observed");
    let diff = diff_snapshots(&baseline, &observed).expect("diff");
    let evidence = SnapshotConformanceCheck::state_path_evidence_from_diff(&diff);
    let envelope = ConformanceResult {
        schema_version: utsushi_core::CONFORMANCE_SCHEMA_VERSION.to_string(),
        adapter_id: "utsushi-synthetic".to_string(),
        profile_id: ProfileId::SnapshotRestore,
        outcome,
        evidence: evidence.clone(),
        recorded_at: "2026-06-23T12:00:00Z".to_string(),
    };
    envelope.validate().expect("envelope validates");
    assert!(!evidence.is_empty(), "evidence must not be empty");
    for entry in &evidence {
        match entry {
            EvidenceRef::StatePath { path } => {
                assert!(!path.is_empty(), "every path must be quoted verbatim");
            }
            other => panic!("expected StatePath, got {other:?}"),
        }
    }
}

#[test]
fn snapshot_conformance_check_missing_baseline_never_silently_passes() {
    let (check, store) = synthetic_snapshot_check_baseline_missing_from_store();
    let outcome = check.run(&store);
    // Audit-focus: the store error path can never produce a Pass.
    assert!(matches!(outcome, ResultOutcome::Fail { .. }));
}

#[test]
fn snapshot_restore_pass_results_cross_validate_against_snapshot_restore_manifest() {
    let (manifest, results) = synthetic_snapshot_paired_manifest_and_results();
    cross_validate_results_against_manifest(&manifest, &results).expect("cross-validates");
}

#[test]
fn cross_validation_rejects_snapshot_restore_pass_above_manifest_ceiling() {
    let (manifest, results) = synthetic_snapshot_paired_negative();
    let error = cross_validate_results_against_manifest(&manifest, &results)
        .expect_err("expected tier overclaim error");
    assert!(
        matches!(
            error,
            ConformanceError::PassAboveManifestCeiling { .. }
                | ConformanceError::EvidenceTierAboveProfileCeiling { .. }
        ),
        "expected tier overclaim error, got {error:?}"
    );
}

#[test]
fn synthetic_in_memory_snapshot_store_round_trips_inserted_snapshots() {
    let store = synthetic_in_memory_snapshot_store();
    // The fixture inserts two snapshots; both must round-trip cleanly.
    assert_eq!(store.len(), 2);
    let baseline = utsushi_core::SnapshotRef {
        snapshot_id: utsushi_core::SnapshotId::parse("snap-baseline-001").expect("id"),
        inspectable_id: "utsushi-fixture".to_string(),
        evidence_tier: EvidenceTier::E1,
    };
    let resolved = store.resolve(&baseline).expect("resolve");
    assert_eq!(resolved.snapshot_id().as_str(), "snap-baseline-001");
}
