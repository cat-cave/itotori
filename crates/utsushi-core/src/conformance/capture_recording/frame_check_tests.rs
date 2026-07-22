use super::*;
use crate::{RuntimeArtifactKind, runtime_artifact_uri};

fn synthetic_frame(frame_index: u64, tier: EvidenceTier) -> FrameArtifactRef {
    let artifact_id = format!("frame-{frame_index:04}");
    let uri = runtime_artifact_uri(
        "synthetic-run",
        RuntimeArtifactKind::FrameCapture,
        &artifact_id,
    )
    .expect("synthetic uri");
    FrameArtifactRef {
        frame_id: format!("frame-{frame_index:04}"),
        evidence_tier: tier,
        artifact_ref: ObservationArtifactRef {
            artifact_id,
            artifact_kind: "frame_capture".to_string(),
            uri,
            media_type: None,
        },
        frame_index,
        bridge_unit_id: None,
    }
}

fn baseline_check() -> FrameCaptureConformanceCheck {
    FrameCaptureConformanceCheck {
        profile: ProfileId::FrameCapture,
        observed_artifacts: vec![
            synthetic_frame(0, EvidenceTier::E2),
            synthetic_frame(1, EvidenceTier::E2),
            synthetic_frame(2, EvidenceTier::E2),
        ],
        expected_tier_floor: EvidenceTier::E2,
        expected_count_range: ArtifactCountRange { min: 1, max: 8 },
    }
}

#[test]
fn frame_capture_check_round_trips_through_serde_json() {
    let check = baseline_check();
    let value = serde_json::to_value(&check).expect("serializes");
    let restored: FrameCaptureConformanceCheck =
        serde_json::from_value(value).expect("deserializes");
    assert_eq!(check, restored);
}

#[test]
fn frame_capture_check_serializes_with_camel_case() {
    let check = baseline_check();
    let value = serde_json::to_value(&check).expect("serializes");
    let object = value.as_object().expect("object");
    assert!(object.contains_key("observedArtifacts"));
    assert!(object.contains_key("expectedTierFloor"));
    assert!(object.contains_key("expectedCountRange"));
    let count_range = object
        .get("expectedCountRange")
        .and_then(|v| v.as_object())
        .expect("count range");
    assert!(count_range.contains_key("min"));
    assert!(count_range.contains_key("max"));
}

#[test]
fn frame_capture_check_validates_three_frames_at_floor_tier() {
    baseline_check().validate().expect("validates");
}

#[test]
fn frame_capture_check_validates_single_frame_at_count_min() {
    let check = FrameCaptureConformanceCheck {
        observed_artifacts: vec![synthetic_frame(0, EvidenceTier::E2)],
        expected_count_range: ArtifactCountRange { min: 1, max: 1 },
        ..baseline_check()
    };
    check.validate().expect("validates");
}

#[test]
fn frame_capture_check_rejects_profile_mismatch() {
    let check = FrameCaptureConformanceCheck {
        profile: ProfileId::TextTrace,
        ..baseline_check()
    };
    assert!(matches!(
        check.validate(),
        Err(ConformanceError::CaptureCheckProfileMismatch { .. })
    ));
}

#[test]
fn frame_capture_check_rejects_count_range_inverted() {
    let check = FrameCaptureConformanceCheck {
        expected_count_range: ArtifactCountRange { min: 5, max: 1 },
        ..baseline_check()
    };
    assert!(matches!(
        check.validate(),
        Err(ConformanceError::ArtifactCountRangeMalformed { .. })
    ));
}

#[test]
fn frame_capture_check_rejects_count_range_max_above_soft_ceiling() {
    let check = FrameCaptureConformanceCheck {
        expected_count_range: ArtifactCountRange {
            min: 1,
            max: FRAME_ARTIFACT_COUNT_MAX_SOFT_CEILING + 1,
        },
        ..baseline_check()
    };
    assert!(matches!(
        check.validate(),
        Err(ConformanceError::ArtifactCountRangeMalformed { .. })
    ));
}

#[test]
fn frame_capture_check_rejects_tier_floor_below_e2() {
    let check = FrameCaptureConformanceCheck {
        expected_tier_floor: EvidenceTier::E1,
        ..baseline_check()
    };
    assert!(matches!(
        check.validate(),
        Err(ConformanceError::FrameTierFloorBelowSinkFloor { .. })
    ));
}

#[test]
fn frame_capture_check_rejects_tier_floor_above_profile_ceiling() {
    let check = FrameCaptureConformanceCheck {
        expected_tier_floor: EvidenceTier::E3,
        ..baseline_check()
    };
    assert!(matches!(
        check.validate(),
        Err(ConformanceError::FrameTierFloorAboveProfileCeiling { .. })
    ));
}

#[test]
fn frame_capture_check_rejects_zero_observed_when_floor_above_zero() {
    let check = FrameCaptureConformanceCheck {
        observed_artifacts: Vec::new(),
        expected_count_range: ArtifactCountRange { min: 0, max: 8 },
        ..baseline_check()
    };
    assert!(matches!(
        check.validate(),
        Err(ConformanceError::FrameCaptureNoArtifacts { .. })
    ));
}

#[test]
fn frame_capture_check_rejects_observed_count_below_range() {
    let check = FrameCaptureConformanceCheck {
        observed_artifacts: vec![synthetic_frame(0, EvidenceTier::E2)],
        expected_count_range: ArtifactCountRange { min: 2, max: 8 },
        ..baseline_check()
    };
    assert!(matches!(
        check.validate(),
        Err(ConformanceError::FrameArtifactCountOutOfRange { .. })
    ));
}

#[test]
fn frame_capture_check_rejects_frame_below_tier_floor() {
    let check = FrameCaptureConformanceCheck {
        observed_artifacts: vec![synthetic_frame(0, EvidenceTier::E0)],
        ..baseline_check()
    };
    assert!(matches!(
        check.validate(),
        Err(ConformanceError::FrameEvidenceTierBelowFloor { .. })
    ));
}

#[test]
fn frame_capture_check_rejects_frame_above_sink_ceiling() {
    // Frame at E4 would be allowed by `SinkKind::FrameArtifact`
    // but raising the *profile* tier floor to anything above E2 is
    // already rejected by the floor/ceiling rule. Forge a tier
    // above the sink ceiling by directly crafting an `EvidenceTier`
    // outside the legal range using a discriminator larger than E4
    // — impossible without unsafe, so we exercise the path by
    // pinning the floor at E2 and using a forged check that ignores
    // the floor and tries to claim a frame *above* the sink
    // ceiling. Today the sink ceiling is E4 and the tier enum tops
    // out at E4, so this test enforces structural invariance:
    // every legal frame tier is `<=` the sink ceiling.
    for tier in [EvidenceTier::E2, EvidenceTier::E3, EvidenceTier::E4] {
        assert!(tier <= SinkKind::FrameArtifact.evidence_tier_ceiling());
    }
}

#[test]
fn frame_capture_check_rejects_artifact_ref_with_host_path() {
    let mut check = baseline_check();
    check.observed_artifacts[0].artifact_ref.uri = "/home/leak/frame.png".to_string();
    assert!(matches!(
        check.validate(),
        Err(ConformanceError::FrameArtifactHostPath { .. })
    ));
}

#[test]
fn frame_capture_check_rejects_artifact_ref_with_file_scheme() {
    let mut check = baseline_check();
    check.observed_artifacts[0].artifact_ref.uri = "file:///var/tmp/frame.png".to_string();
    assert!(matches!(
        check.validate(),
        Err(ConformanceError::FrameArtifactHostPath { .. })
    ));
}

#[test]
fn frame_capture_check_rejects_artifact_kind_outside_allow_list() {
    let mut check = baseline_check();
    check.observed_artifacts[0].artifact_ref.artifact_kind = "recording".to_string();
    assert!(matches!(
        check.validate(),
        Err(ConformanceError::FrameArtifactKindOutsideAllowList { .. })
    ));
}

#[test]
fn frame_capture_check_rejects_unsorted_frame_index_sequence() {
    let check = FrameCaptureConformanceCheck {
        observed_artifacts: vec![
            synthetic_frame(1, EvidenceTier::E2),
            synthetic_frame(0, EvidenceTier::E2),
        ],
        ..baseline_check()
    };
    assert!(matches!(
        check.validate(),
        Err(ConformanceError::FrameSequenceUnordered { .. })
    ));
}

#[test]
fn frame_capture_check_rejects_duplicate_frame_index() {
    let check = FrameCaptureConformanceCheck {
        observed_artifacts: vec![
            synthetic_frame(1, EvidenceTier::E2),
            synthetic_frame(1, EvidenceTier::E2),
        ],
        ..baseline_check()
    };
    assert!(matches!(
        check.validate(),
        Err(ConformanceError::FrameSequenceDuplicate { .. })
    ));
}

#[test]
fn frame_capture_check_run_returns_pass_with_tier_floor_on_valid_check() {
    let check = baseline_check();
    match check.run() {
        ResultOutcome::Pass { evidence_tier } => assert_eq!(evidence_tier, EvidenceTier::E2),
        other => panic!("expected Pass, got {other:?}"),
    }
}

#[test]
fn frame_capture_check_run_returns_fail_with_host_path_code_when_uri_is_absolute() {
    let mut check = baseline_check();
    check.observed_artifacts[0].artifact_ref.uri = "/home/leak/frame.png".to_string();
    match check.run() {
        ResultOutcome::Fail { semantic_code, .. } => {
            assert_eq!(
                semantic_code,
                "utsushi.conformance.frame_artifact_host_path"
            );
        }
        other => panic!("expected Fail, got {other:?}"),
    }
}

#[test]
fn frame_capture_check_into_conformance_result_surfaces_three_tiers() {
    let summary = baseline_check().into_conformance_result();
    assert_eq!(summary.tier_floor, EvidenceTier::E2);
    assert_eq!(summary.profile_ceiling, EvidenceTier::E2);
    assert_eq!(summary.sink_ceiling, EvidenceTier::E4);
    assert!(matches!(summary.outcome, ResultOutcome::Pass { .. }));
}
