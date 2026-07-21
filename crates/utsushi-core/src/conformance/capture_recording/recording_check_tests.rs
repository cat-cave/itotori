use super::*;
use crate::{RuntimeArtifactKind, runtime_artifact_uri};

fn artifact(kind: RuntimeArtifactKind, id: &str) -> ObservationArtifactRef {
    let uri = runtime_artifact_uri("synthetic-run", kind, id).expect("uri");
    ObservationArtifactRef {
        artifact_id: id.to_string(),
        artifact_kind: kind.artifact_kind().to_string(),
        uri,
        media_type: None,
    }
}

fn baseline_metadata() -> RecordingMetadata {
    RecordingMetadata {
        recording_id: "recording-001".to_string(),
        frame_count: 3,
        audio_event_count: 4,
        duration_ms: 1_500,
        evidence_tier: EvidenceTier::E2,
        artifact_refs: vec![
            artifact(RuntimeArtifactKind::Recording, "recording-001"),
            artifact(RuntimeArtifactKind::FrameCapture, "frame-0001"),
            artifact(RuntimeArtifactKind::FrameCapture, "frame-0002"),
            artifact(RuntimeArtifactKind::FrameCapture, "frame-0003"),
        ],
    }
}

fn baseline_check() -> RecordingConformanceCheck {
    RecordingConformanceCheck {
        profile: ProfileId::RecordingCapture,
        observed_recording: baseline_metadata(),
        expected_duration_range: DurationRangeMs {
            min: 1_000,
            max: 2_000,
        },
        expected_event_count_range: ArtifactCountRange { min: 5, max: 10 },
    }
}

#[test]
fn recording_check_round_trips_through_serde_json() {
    let check = baseline_check();
    let value = serde_json::to_value(&check).expect("serializes");
    let restored: RecordingConformanceCheck = serde_json::from_value(value).expect("deserializes");
    assert_eq!(check, restored);
}

#[test]
fn recording_check_serializes_with_camel_case() {
    let check = baseline_check();
    let value = serde_json::to_value(&check).expect("serializes");
    let object = value.as_object().expect("object");
    assert!(object.contains_key("observedRecording"));
    assert!(object.contains_key("expectedDurationRange"));
    assert!(object.contains_key("expectedEventCountRange"));
    let recording = object
        .get("observedRecording")
        .and_then(|v| v.as_object())
        .expect("recording object");
    assert!(recording.contains_key("recordingId"));
    assert!(recording.contains_key("frameCount"));
    assert!(recording.contains_key("audioEventCount"));
    assert!(recording.contains_key("durationMs"));
    assert!(recording.contains_key("evidenceTier"));
    assert!(recording.contains_key("artifactRefs"));
}

#[test]
fn recording_check_validates_one_container_plus_three_frames() {
    baseline_check().validate().expect("validates");
}

#[test]
fn recording_check_validates_audio_event_count_only_recording() {
    // Recording with audio events alongside frames must still pass.
    let mut check = baseline_check();
    check.observed_recording.audio_event_count = 6;
    check.expected_event_count_range = ArtifactCountRange { min: 7, max: 12 };
    check.validate().expect("validates");
}

#[test]
fn recording_check_rejects_profile_mismatch() {
    let check = RecordingConformanceCheck {
        profile: ProfileId::FrameCapture,
        ..baseline_check()
    };
    assert!(matches!(
        check.validate(),
        Err(ConformanceError::CaptureCheckProfileMismatch { .. })
    ));
}

#[test]
fn recording_check_rejects_duration_range_inverted() {
    let check = RecordingConformanceCheck {
        expected_duration_range: DurationRangeMs {
            min: 2_000,
            max: 500,
        },
        ..baseline_check()
    };
    assert!(matches!(
        check.validate(),
        Err(ConformanceError::DurationRangeMalformed { .. })
    ));
}

#[test]
fn recording_check_rejects_event_count_range_inverted() {
    let check = RecordingConformanceCheck {
        expected_event_count_range: ArtifactCountRange { min: 20, max: 5 },
        ..baseline_check()
    };
    assert!(matches!(
        check.validate(),
        Err(ConformanceError::ArtifactCountRangeMalformed { .. })
    ));
}

#[test]
fn recording_check_rejects_recording_id_with_whitespace() {
    let mut check = baseline_check();
    check.observed_recording.recording_id = "recording 001".to_string();
    assert!(matches!(
        check.validate(),
        Err(ConformanceError::RecordingIdMalformed { .. })
    ));
}

#[test]
fn recording_check_rejects_recording_id_that_looks_like_local_path() {
    let mut check = baseline_check();
    check.observed_recording.recording_id = "/home/user/recording".to_string();
    assert!(matches!(
        check.validate(),
        Err(ConformanceError::RecordingIdMalformed { .. })
    ));
}

#[test]
fn recording_check_rejects_recording_id_empty() {
    let mut check = baseline_check();
    check.observed_recording.recording_id = String::new();
    assert!(matches!(
        check.validate(),
        Err(ConformanceError::RecordingIdMalformed { .. })
    ));
}

#[test]
fn recording_check_rejects_e4_overclaim() {
    let mut check = baseline_check();
    check.observed_recording.evidence_tier = EvidenceTier::E4;
    assert!(matches!(
        check.validate(),
        Err(ConformanceError::RecordingEvidenceTierOverclaim { .. })
    ));
}

#[test]
fn recording_check_rejects_e3_overclaim_above_profile_ceiling() {
    let mut check = baseline_check();
    check.observed_recording.evidence_tier = EvidenceTier::E3;
    assert!(matches!(
        check.validate(),
        Err(ConformanceError::RecordingEvidenceTierOverclaim { .. })
    ));
}

#[test]
fn recording_check_rejects_missing_container_ref() {
    let mut check = baseline_check();
    check.observed_recording.artifact_refs.remove(0);
    // Plus drop frame_count to stay otherwise consistent.
    check.observed_recording.frame_count = 3;
    assert!(matches!(
        check.validate(),
        Err(ConformanceError::RecordingContainerMissing)
    ));
}

#[test]
fn recording_check_rejects_duplicate_container_ref() {
    let mut check = baseline_check();
    check
        .observed_recording
        .artifact_refs
        .push(artifact(RuntimeArtifactKind::Recording, "recording-002"));
    assert!(matches!(
        check.validate(),
        Err(ConformanceError::RecordingContainerDuplicated { .. })
    ));
}

#[test]
fn recording_check_rejects_trace_log_artifact_kind() {
    let mut check = baseline_check();
    check
        .observed_recording
        .artifact_refs
        .push(artifact(RuntimeArtifactKind::TraceLog, "trace-001"));
    assert!(matches!(
        check.validate(),
        Err(ConformanceError::RecordingArtifactKindOutsideAllowList { .. })
    ));
}

#[test]
fn recording_check_rejects_artifact_ref_with_host_path() {
    let mut check = baseline_check();
    check.observed_recording.artifact_refs[1].uri = "/home/leak/frame.png".to_string();
    assert!(matches!(
        check.validate(),
        Err(ConformanceError::RecordingArtifactHostPath { .. })
    ));
}

#[test]
fn recording_check_rejects_frame_count_mismatch_with_artifact_refs() {
    let mut check = baseline_check();
    check.observed_recording.frame_count = 7;
    assert!(matches!(
        check.validate(),
        Err(ConformanceError::RecordingFrameCountMismatch { .. })
    ));
}

#[test]
fn recording_check_rejects_duration_below_minimum() {
    let mut check = baseline_check();
    check.observed_recording.duration_ms = 100;
    assert!(matches!(
        check.validate(),
        Err(ConformanceError::RecordingDurationOutOfRange { .. })
    ));
}

#[test]
fn recording_check_rejects_duration_above_maximum() {
    let mut check = baseline_check();
    check.observed_recording.duration_ms = 5_000;
    assert!(matches!(
        check.validate(),
        Err(ConformanceError::RecordingDurationOutOfRange { .. })
    ));
}

#[test]
fn recording_check_rejects_event_count_out_of_range() {
    let mut check = baseline_check();
    check.observed_recording.audio_event_count = 100;
    assert!(matches!(
        check.validate(),
        Err(ConformanceError::RecordingEventCountOutOfRange { .. })
    ));
}

#[test]
fn recording_check_run_returns_pass_when_metadata_within_ranges() {
    let check = baseline_check();
    match check.run() {
        ResultOutcome::Pass { evidence_tier } => assert_eq!(evidence_tier, EvidenceTier::E2),
        other => panic!("expected Pass, got {other:?}"),
    }
}

#[test]
fn recording_check_run_returns_fail_with_overclaim_code_on_e4_tier() {
    let mut check = baseline_check();
    check.observed_recording.evidence_tier = EvidenceTier::E4;
    match check.run() {
        ResultOutcome::Fail { semantic_code, .. } => {
            assert_eq!(
                semantic_code,
                "utsushi.conformance.recording_evidence_tier_overclaim"
            );
        }
        other => panic!("expected Fail, got {other:?}"),
    }
}

#[test]
fn recording_check_into_conformance_result_surfaces_four_tiers() {
    let summary = baseline_check().into_conformance_result();
    assert_eq!(summary.recording_tier, EvidenceTier::E2);
    assert_eq!(summary.profile_ceiling, EvidenceTier::E2);
    assert_eq!(summary.sink_ceiling, EvidenceTier::E4);
    assert_eq!(summary.audio_sink_ceiling, EvidenceTier::E0);
    assert!(matches!(summary.outcome, ResultOutcome::Pass { .. }));
}
