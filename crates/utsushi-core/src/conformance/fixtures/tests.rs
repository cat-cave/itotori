use super::*;

#[test]
fn synthetic_text_trace_manifest_validates() {
    synthetic_text_trace_manifest()
        .validate()
        .expect("validates");
}

#[test]
fn synthetic_frame_capture_manifest_validates() {
    synthetic_frame_capture_manifest()
        .validate()
        .expect("validates");
}

#[test]
fn synthetic_text_trace_pass_result_validates() {
    synthetic_text_trace_pass_result()
        .validate()
        .expect("validates");
}

#[test]
fn synthetic_frame_capture_pass_result_validates() {
    synthetic_frame_capture_pass_result()
        .validate()
        .expect("validates");
}

#[test]
fn normalize_recorded_at_replaces_field() {
    let result = synthetic_text_trace_pass_result();
    let mut value = serde_json::to_value(&result).expect("serializes");
    normalize_recorded_at(&mut value, "NORMALIZED");
    assert_eq!(
        value
            .as_object()
            .and_then(|o| o.get("recordedAt"))
            .and_then(|v| v.as_str()),
        Some("NORMALIZED")
    );
}

#[test]
fn synthetic_capture_recording_manifest_validates() {
    synthetic_capture_recording_manifest()
        .validate()
        .expect("validates");
}

#[test]
fn synthetic_frame_capture_check_three_artifacts_at_e2_validates() {
    synthetic_frame_capture_check_three_artifacts_at_e2()
        .validate()
        .expect("validates");
}

#[test]
fn synthetic_frame_capture_check_three_artifacts_at_e2_runs_pass() {
    let outcome = synthetic_frame_capture_check_three_artifacts_at_e2().run();
    assert!(matches!(outcome, ResultOutcome::Pass { .. }));
}

#[test]
fn synthetic_recording_check_metadata_only_validates() {
    synthetic_recording_check_metadata_only()
        .validate()
        .expect("validates");
}

#[test]
fn synthetic_recording_check_metadata_only_runs_pass() {
    let outcome = synthetic_recording_check_metadata_only().run();
    assert!(matches!(outcome, ResultOutcome::Pass { .. }));
}

#[test]
fn synthetic_frame_capture_unsupported_result_validates_against_undeclared_manifest() {
    let result = synthetic_frame_capture_unsupported_result();
    result.validate().expect("validates");
    let manifest = synthetic_text_trace_manifest();
    crate::conformance::cross_validate_results_against_manifest(
        &manifest,
        &[synthetic_text_trace_pass_result(), result],
    )
    .expect("cross-validates");
}

#[test]
fn synthetic_frame_capture_check_with_host_path_fails_validation() {
    let check = synthetic_frame_capture_check_with_host_path();
    let error = check.validate().expect_err("expected host-path fail");
    assert_eq!(
        error.semantic_code(),
        crate::conformance::capture_recording::codes::FRAME_ARTIFACT_HOST_PATH
    );
}

#[test]
fn synthetic_frame_capture_check_with_host_path_fails_reject_unredacted_local_paths() {
    // The fixture must trip the project-wide redaction filter even
    // before validate() runs, so a reviewer sees both layers of
    // defense fire.
    let check = synthetic_frame_capture_check_with_host_path();
    let value = serde_json::to_value(&check).expect("serializes");
    let error = crate::redaction::reject_unredacted_local_paths("frameCheck", &value)
        .expect_err("redaction filter rejects host path");
    let message = error.to_string();
    assert!(
        message.contains("/home/leak/frame.png"),
        "redaction error must surface the offending value: {message}"
    );
}

#[test]
fn synthetic_recording_check_with_e4_overclaim_fails_validation() {
    let check = synthetic_recording_check_with_e4_overclaim();
    let error = check.validate().expect_err("expected overclaim fail");
    assert_eq!(
        error.semantic_code(),
        crate::conformance::capture_recording::codes::RECORDING_EVIDENCE_TIER_OVERCLAIM
    );
}

#[test]
fn synthetic_capture_recording_paired_manifest_and_results_cross_validates() {
    let (manifest, results) = synthetic_capture_recording_paired_manifest_and_results();
    crate::conformance::cross_validate_results_against_manifest(&manifest, &results)
        .expect("cross-validates");
}

#[test]
fn synthetic_capture_recording_paired_negative_rejects_tier_above_manifest_ceiling() {
    let (manifest, results) = synthetic_capture_recording_paired_negative();
    let error = crate::conformance::cross_validate_results_against_manifest(&manifest, &results)
        .expect_err("expected PassAboveManifestCeiling");
    assert!(matches!(
        error,
        crate::conformance::ConformanceError::PassAboveManifestCeiling { .. }
    ));
}

#[test]
fn synthetic_snapshot_check_identical_baseline_and_observed_validates() {
    let (check, _store) = synthetic_snapshot_check_identical_baseline_and_observed();
    check.validate().expect("validates");
}

#[test]
fn synthetic_snapshot_check_identical_baseline_and_observed_runs_pass() {
    let (check, store) = synthetic_snapshot_check_identical_baseline_and_observed();
    let outcome = check.run(&store);
    match outcome {
        ResultOutcome::Pass { evidence_tier } => assert_eq!(evidence_tier, EvidenceTier::E1),
        other => panic!("expected Pass, got {other:?}"),
    }
}

#[test]
fn synthetic_snapshot_check_observed_drifts_at_port_frame_runs_fail_with_state_drift() {
    let (check, store) = synthetic_snapshot_check_observed_drifts_at_port_frame();
    let outcome = check.run(&store);
    match outcome {
        ResultOutcome::Fail { semantic_code, .. } => {
            assert_eq!(semantic_code, "utsushi.snapshot.state_drift");
        }
        other => panic!("expected Fail, got {other:?}"),
    }
}

#[test]
fn synthetic_snapshot_check_observed_drifts_at_port_frame_evidence_quotes_path_verbatim() {
    let (check, store) = synthetic_snapshot_check_observed_drifts_at_port_frame();
    let baseline = store.resolve(&check.baseline).expect("baseline");
    let observed = store.resolve(&check.observed).expect("observed");
    let diff = crate::diff_snapshots(&baseline, &observed).expect("diff");
    let evidence = SnapshotConformanceCheck::state_path_evidence_from_diff(&diff);
    assert_eq!(
        evidence,
        vec![EvidenceRef::StatePath {
            path: "port.frame".to_string(),
        }]
    );
}

#[test]
fn synthetic_snapshot_check_observed_drifts_at_two_paths_evidence_is_sorted() {
    let (check, store) = synthetic_snapshot_check_observed_drifts_at_two_paths();
    let baseline = store.resolve(&check.baseline).expect("baseline");
    let observed = store.resolve(&check.observed).expect("observed");
    let diff = crate::diff_snapshots(&baseline, &observed).expect("diff");
    let evidence = SnapshotConformanceCheck::state_path_evidence_from_diff(&diff);
    let paths: Vec<&str> = evidence
        .iter()
        .map(|e| match e {
            EvidenceRef::StatePath { path } => path.as_str(),
            _ => panic!("not state_path"),
        })
        .collect();
    let mut sorted = paths.clone();
    sorted.sort_unstable();
    assert_eq!(paths, sorted, "evidence must be sorted ascending");
    assert_eq!(paths, vec!["port.frame", "port.last"]);
}

#[test]
fn synthetic_snapshot_check_baseline_missing_from_store_runs_fail_with_not_found() {
    let (check, store) = synthetic_snapshot_check_baseline_missing_from_store();
    let outcome = check.run(&store);
    match outcome {
        ResultOutcome::Fail { semantic_code, .. } => {
            assert_eq!(semantic_code, "utsushi.snapshot.store_not_found");
        }
        other => panic!("expected Fail, got {other:?}"),
    }
}

#[test]
fn synthetic_snapshot_check_observed_has_mismatched_schema_version_runs_fail_with_typed_code() {
    let (check, store) = synthetic_snapshot_check_observed_has_mismatched_schema_version();
    let outcome = check.run(&store);
    match outcome {
        ResultOutcome::Fail { semantic_code, .. } => {
            assert_eq!(
                semantic_code,
                "utsushi.snapshot.store_mismatched_schema_version"
            );
        }
        other => panic!("expected Fail, got {other:?}"),
    }
}

#[test]
fn synthetic_snapshot_check_with_mismatched_inspectable_ids_fails_validation() {
    let check = synthetic_snapshot_check_with_mismatched_inspectable_ids();
    let err = check.validate().expect_err("expected inspectable mismatch");
    assert_eq!(
        err.semantic_code(),
        crate::conformance::snapshot_check::codes::SNAPSHOT_INSPECTABLE_ID_MISMATCH
    );
}

#[test]
fn synthetic_snapshot_check_with_wrong_profile_fails_validation() {
    let check = synthetic_snapshot_check_with_wrong_profile();
    let err = check.validate().expect_err("expected profile mismatch");
    assert_eq!(
        err.semantic_code(),
        crate::conformance::snapshot_check::codes::SNAPSHOT_CHECK_PROFILE_MISMATCH
    );
}

#[test]
fn synthetic_snapshot_restore_unsupported_result_cross_validates_against_undeclared_manifest() {
    let result = synthetic_snapshot_restore_unsupported_result();
    result.validate().expect("validates");
    // Pair with the text-trace manifest (which does NOT declare
    // snapshot-restore) plus the text-trace pass result so every
    // declared profile gets reported.
    let manifest = synthetic_text_trace_manifest();
    crate::conformance::cross_validate_results_against_manifest(
        &manifest,
        &[synthetic_text_trace_pass_result(), result],
    )
    .expect("cross-validates");
}

#[test]
fn synthetic_snapshot_paired_manifest_and_results_cross_validates() {
    let (manifest, results) = synthetic_snapshot_paired_manifest_and_results();
    crate::conformance::cross_validate_results_against_manifest(&manifest, &results)
        .expect("cross-validates");
}

#[test]
fn synthetic_snapshot_paired_negative_rejects_tier_above_manifest_ceiling() {
    let (manifest, results) = synthetic_snapshot_paired_negative();
    let error = crate::conformance::cross_validate_results_against_manifest(&manifest, &results)
        .expect_err("expected PassAboveManifestCeiling or overclaim");
    // The result's standalone validator catches the tier overclaim
    // first because `evidence_tier` exceeds the profile-id ceiling
    // (E1). Either error is admissible — what matters is the
    // negative twin is rejected.
    assert!(
        matches!(
            error,
            crate::conformance::ConformanceError::PassAboveManifestCeiling { .. }
                | crate::conformance::ConformanceError::EvidenceTierAboveProfileCeiling { .. }
        ),
        "expected tier overclaim error, got {error:?}"
    );
}

#[test]
fn synthetic_in_memory_snapshot_store_returns_inserted_snapshots_for_known_ids() {
    let store = synthetic_in_memory_snapshot_store();
    assert_eq!(store.len(), 2);
    let baseline_ref = crate::snapshot::SnapshotRef {
        snapshot_id: crate::snapshot::SnapshotId::parse("snap-baseline-001").expect("id"),
        inspectable_id: SNAPSHOT_FIXTURE_INSPECTABLE_ID.to_string(),
        evidence_tier: EvidenceTier::E1,
    };
    let resolved = store.resolve(&baseline_ref).expect("resolve");
    assert_eq!(resolved.snapshot_id().as_str(), "snap-baseline-001");
}
