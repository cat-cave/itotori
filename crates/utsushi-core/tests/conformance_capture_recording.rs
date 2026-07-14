//! Integration tests for the capture/recording conformance slice
//! ().
//!
//! Each test exercises the slice end-to-end: building a check via the
//! fixture helpers, running it, and asserting outcome shape and audit
//! invariants (evidence tier visible, no host paths in serialized
//! output, unsupported path bypasses the check struct).

use utsushi_core::ConformanceError;
use utsushi_core::ProfileId;
use utsushi_core::ResultOutcome;
use utsushi_core::conformance::capture_recording::codes;
use utsushi_core::conformance::fixtures::{
    synthetic_capture_recording_manifest, synthetic_capture_recording_paired_manifest_and_results,
    synthetic_frame_capture_check_three_artifacts_at_e2,
    synthetic_frame_capture_unsupported_result, synthetic_recording_check_metadata_only,
};
use utsushi_core::cross_validate_results_against_manifest;
use utsushi_core::redaction::reject_unredacted_local_paths;

#[test]
fn capture_recording_check_run_through_synthetic_runner_emits_one_pass_per_profile() {
    let frame_outcome = synthetic_frame_capture_check_three_artifacts_at_e2().run();
    let recording_outcome = synthetic_recording_check_metadata_only().run();
    assert!(matches!(frame_outcome, ResultOutcome::Pass { .. }));
    assert!(matches!(recording_outcome, ResultOutcome::Pass { .. }));
}

#[test]
fn capture_recording_unsupported_path_does_not_invoke_check_struct() {
    // The "missing capture support" path is structural: the runner emits
    // an Unsupported outcome carrying the documented semantic code; it
    // never constructs the check struct. We model that by building the
    // result directly through the helper and asserting its shape.
    let result = synthetic_frame_capture_unsupported_result();
    result.validate().expect("validates");
    match result.outcome {
        ResultOutcome::Unsupported {
            semantic_code,
            declared_in_manifest,
        } => {
            assert_eq!(semantic_code, codes::FRAME_CAPTURE_UNSUPPORTED);
            assert!(!declared_in_manifest);
        }
        other => panic!("expected Unsupported, got {other:?}"),
    }
}

#[test]
fn capture_recording_result_envelope_carries_evidence_tier_in_serialized_output() {
    let (_manifest, results) = synthetic_capture_recording_paired_manifest_and_results();
    for result in &results {
        let value = serde_json::to_value(result).expect("serializes");
        let outcome = value
            .as_object()
            .and_then(|o| o.get("outcome"))
            .and_then(|v| v.as_object())
            .expect("outcome object");
        let tier = outcome
            .get("evidenceTier")
            .and_then(|v| v.as_str())
            .expect("evidenceTier present");
        assert_eq!(tier, "E2");
    }
}

#[test]
fn capture_recording_result_envelope_passes_reject_unredacted_local_paths_filter() {
    let (_manifest, results) = synthetic_capture_recording_paired_manifest_and_results();
    for result in &results {
        let value = serde_json::to_value(result).expect("serializes");
        reject_unredacted_local_paths("conformanceResult", &value)
            .expect("redaction filter accepts portable artifact refs");
    }
}

#[test]
fn capture_recording_cross_validates_paired_manifest_and_results() {
    let (manifest, results) = synthetic_capture_recording_paired_manifest_and_results();
    cross_validate_results_against_manifest(&manifest, &results).expect("cross-validates");
}

#[test]
fn capture_recording_manifest_declares_both_profiles_at_e2_ceiling() {
    let manifest = synthetic_capture_recording_manifest();
    manifest.validate().expect("validates");
    let frame = manifest
        .profile(ProfileId::FrameCapture)
        .expect("frame profile present");
    assert_eq!(frame.evidence_tier_ceiling, utsushi_core::EvidenceTier::E2);
    let recording = manifest
        .profile(ProfileId::RecordingCapture)
        .expect("recording profile present");
    assert_eq!(
        recording.evidence_tier_ceiling,
        utsushi_core::EvidenceTier::E2
    );
}

#[test]
fn capture_recording_failure_path_emits_stable_semantic_code() {
    let mut check = synthetic_frame_capture_check_three_artifacts_at_e2();
    check.observed_artifacts[0].artifact_ref.uri = "/home/leak/frame.png".to_string();
    let error = check.validate().expect_err("expected host-path fail");
    assert!(matches!(
        error,
        ConformanceError::FrameArtifactHostPath { .. }
    ));
    assert_eq!(error.semantic_code(), codes::FRAME_ARTIFACT_HOST_PATH);
}
