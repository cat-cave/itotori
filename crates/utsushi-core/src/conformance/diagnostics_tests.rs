use super::*;

fn variants() -> Vec<ConformanceError> {
    vec![
        ConformanceError::UnsupportedSchemaVersion {
            observed: "0.0.0".to_string(),
            expected: "0.2.0-alpha",
        },
        ConformanceError::AdapterIdMalformed {
            id: "Bad-Id".to_string(),
        },
        ConformanceError::UnknownAbiVersion {
            declared: 99,
            supported: &[1],
        },
        ConformanceError::ManifestEmpty,
        ConformanceError::DuplicateProfile {
            id: ProfileId::TextTrace,
        },
        ConformanceError::MissingSubsystem {
            profile: ProfileId::TextTrace,
            missing: SubsystemRequirement::TextSink,
        },
        ConformanceError::DuplicateSubsystem {
            profile: ProfileId::TextTrace,
            subsystem: SubsystemRequirement::TextSink,
        },
        ConformanceError::EvidenceTierAboveProfileCeiling {
            profile: ProfileId::TextTrace,
            claimed: EvidenceTier::E2,
            ceiling: EvidenceTier::E1,
        },
        ConformanceError::OrphanedExtension {
            key: "orphan".to_string(),
            profile_id: ProfileId::FrameCapture,
        },
        ConformanceError::DuplicateExtension {
            profile_id: ProfileId::FrameCapture,
            key: "rgba8".to_string(),
        },
        ConformanceError::ExtensionKeyMalformed {
            key: "Bad-Key".to_string(),
        },
        ConformanceError::RecordedAtMalformed {
            recorded_at: "not-a-time".to_string(),
        },
        ConformanceError::EvidenceRefInvalid {
            artifact_kind: "runtime_artifact",
            reason: "bad uri".to_string(),
        },
        ConformanceError::PassWithoutEvidence {
            profile: ProfileId::TextTrace,
        },
        ConformanceError::MalformedSemanticCode {
            code: "bogus.code".to_string(),
        },
        ConformanceError::DeclaredProfileReportedAsUnsupported {
            profile: ProfileId::TextTrace,
        },
        ConformanceError::DeclaredProfileSkipped {
            profile: ProfileId::TextTrace,
        },
        ConformanceError::ProfileNotDeclared {
            profile: ProfileId::TextTrace,
        },
        ConformanceError::ProfileNotReported {
            profile: ProfileId::TextTrace,
        },
        ConformanceError::AdapterIdMismatch {
            manifest: "utsushi-a".to_string(),
            result: "utsushi-b".to_string(),
        },
        ConformanceError::PassAboveManifestCeiling {
            profile: ProfileId::TextTrace,
            claimed: EvidenceTier::E1,
            ceiling: EvidenceTier::E0,
        },
        ConformanceError::CaptureCheckProfileMismatch {
            observed: ProfileId::TextTrace,
            expected: ProfileId::FrameCapture,
        },
        ConformanceError::ArtifactCountRangeMalformed { min: 5, max: 1 },
        ConformanceError::DurationRangeMalformed {
            min: 1_000,
            max: 500,
        },
        ConformanceError::FrameTierFloorBelowSinkFloor {
            floor: EvidenceTier::E1,
        },
        ConformanceError::FrameTierFloorAboveProfileCeiling {
            floor: EvidenceTier::E3,
            ceiling: EvidenceTier::E2,
        },
        ConformanceError::FrameArtifactCountOutOfRange {
            observed: 0,
            min: 1,
            max: 8,
        },
        ConformanceError::FrameCaptureNoArtifacts { declared_min: 0 },
        ConformanceError::FrameEvidenceTierBelowFloor {
            frame_id: "frame-0001".to_string(),
            observed: EvidenceTier::E0,
            floor: EvidenceTier::E2,
        },
        ConformanceError::FrameEvidenceTierAboveSinkCeiling {
            frame_id: "frame-0002".to_string(),
            observed: EvidenceTier::E4,
            ceiling: EvidenceTier::E4,
        },
        ConformanceError::FrameArtifactHostPath {
            frame_id: "frame-0003".to_string(),
            reason: "uri not under managed root".to_string(),
        },
        ConformanceError::FrameArtifactKindOutsideAllowList {
            frame_id: "frame-0004".to_string(),
            kind: "recording".to_string(),
        },
        ConformanceError::FrameSequenceUnordered {
            previous: 2,
            current: 1,
        },
        ConformanceError::FrameSequenceDuplicate { frame_index: 1 },
        ConformanceError::RecordingIdMalformed {
            reason: "whitespace inside id".to_string(),
        },
        ConformanceError::RecordingEvidenceTierOverclaim {
            observed: EvidenceTier::E4,
            ceiling: EvidenceTier::E2,
        },
        ConformanceError::RecordingContainerMissing,
        ConformanceError::RecordingContainerDuplicated { count: 2 },
        ConformanceError::RecordingArtifactKindOutsideAllowList {
            kind: "trace_log".to_string(),
        },
        ConformanceError::RecordingArtifactHostPath {
            reason: "uri not under managed root".to_string(),
        },
        ConformanceError::RecordingFrameCountMismatch {
            declared: 3,
            actual: 2,
        },
        ConformanceError::RecordingDurationOutOfRange {
            observed: 500,
            min: 1_000,
            max: 2_000,
        },
        ConformanceError::RecordingEventCountOutOfRange {
            observed: 1,
            min: 5,
            max: 10,
        },
        ConformanceError::SnapshotCheckProfileMismatch {
            observed: ProfileId::TextTrace,
            expected: ProfileId::SnapshotRestore,
        },
        ConformanceError::SnapshotRefInvalid {
            side: "baseline",
            reason: "malformed snapshot id".to_string(),
        },
        ConformanceError::SnapshotInspectableIdMismatch {
            baseline: "port-a".to_string(),
            observed: "port-b".to_string(),
        },
        ConformanceError::SnapshotEvidenceTierOverclaim {
            observed: EvidenceTier::E2,
            ceiling: EvidenceTier::E1,
        },
    ]
}

#[test]
fn every_conformance_error_variant_returns_a_code_in_codes_all() {
    let all: std::collections::HashSet<&'static str> = codes::ALL.iter().copied().collect();
    for variant in variants() {
        let code = variant.semantic_code();
        assert!(
            all.contains(code),
            "code {code} missing from codes::ALL (variant {variant:?})"
        );
    }
    assert_eq!(
        all.len(),
        codes::ALL.len(),
        "codes::ALL must not contain duplicates"
    );
}

#[test]
fn conformance_error_display_does_not_leak_host_paths() {
    for variant in variants() {
        let rendered = variant.to_string();
        for forbidden in ["/home/", "/tmp/", "/Users/", "/var/folders/", "file://"] {
            assert!(
                !rendered.contains(forbidden),
                "rendered={rendered} contained forbidden substring {forbidden}"
            );
        }
    }
}

#[test]
fn conformance_error_implements_std_error() {
    fn assert_std_error<E: std::error::Error>(_: &E) {}
    let error = ConformanceError::ManifestEmpty;
    assert_std_error(&error);
}
