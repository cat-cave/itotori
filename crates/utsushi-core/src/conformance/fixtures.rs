//! Conformance fixture builders.
//!
//! Public test-aid surface for downstream consumers (UTSUSHI-027/028/029
//! integration tests) that need a well-formed `ConformanceManifest` or
//! `ConformanceResult` to layer their own assertions on top of. The
//! builders are deterministic and engine-neutral: no XP3/KAG/RGSS3/JSON
//! engine names, no host paths, no fixture id collisions.
//!
//! The constructors are exposed unconditionally so the in-crate
//! integration tests (`cargo test -p utsushi-core`) reach them without
//! a feature pin and downstream test crates can consume them
//! transparently. The `conformance-fixtures` feature is preserved as a
//! documented opt-in marker for cross-crate consumers that want an
//! explicit dev-dep handshake.

use crate::{EvidenceTier, ObservationArtifactRef, RuntimeArtifactKind, runtime_artifact_uri};

use super::capture_recording::{
    ArtifactCountRange, DurationRangeMs, FrameArtifactRef, FrameCaptureConformanceCheck,
    RecordingConformanceCheck, RecordingMetadata, unsupported_frame_capture_result,
};
use super::manifest::{ConformanceProfile, ProfileExtension, SubsystemRequirement};
use super::result::{ConformanceResult, EvidenceRef, ResultOutcome};
use super::{CONFORMANCE_SCHEMA_VERSION, ConformanceAbiVersion, ConformanceManifest, ProfileId};

/// Canonical adapter id used by the synthetic test fixtures.
pub const SYNTHETIC_ADAPTER_ID: &str = "utsushi-synthetic";

/// Synthesise a manifest declaring the `text-trace` profile at the
/// profile-id ceiling.
pub fn synthetic_text_trace_manifest() -> ConformanceManifest {
    ConformanceManifest {
        schema_version: CONFORMANCE_SCHEMA_VERSION.to_string(),
        adapter_id: SYNTHETIC_ADAPTER_ID.to_string(),
        abi_version: ConformanceAbiVersion(1),
        supported_profiles: vec![ConformanceProfile {
            id: ProfileId::TextTrace,
            required_subsystems: vec![SubsystemRequirement::TextSink],
            evidence_tier_ceiling: EvidenceTier::E1,
        }],
        optional_extensions: Vec::new(),
    }
}

/// Synthesise a manifest declaring the `frame-capture` profile at the
/// profile-id ceiling, with a `rgba8` extension.
pub fn synthetic_frame_capture_manifest() -> ConformanceManifest {
    ConformanceManifest {
        schema_version: CONFORMANCE_SCHEMA_VERSION.to_string(),
        adapter_id: SYNTHETIC_ADAPTER_ID.to_string(),
        abi_version: ConformanceAbiVersion(1),
        supported_profiles: vec![ConformanceProfile {
            id: ProfileId::FrameCapture,
            required_subsystems: vec![
                SubsystemRequirement::FrameSink,
                SubsystemRequirement::ArtifactStore,
            ],
            evidence_tier_ceiling: EvidenceTier::E2,
        }],
        optional_extensions: vec![ProfileExtension {
            profile_id: ProfileId::FrameCapture,
            key: "rgba8".to_string(),
            note: "Adapter emits frames as 8-bit RGBA captures.".to_string(),
        }],
    }
}

/// Synthesise a pass result for the `text-trace` profile citing a
/// single text-line evidence ref.
pub fn synthetic_text_trace_pass_result() -> ConformanceResult {
    ConformanceResult {
        schema_version: CONFORMANCE_SCHEMA_VERSION.to_string(),
        adapter_id: SYNTHETIC_ADAPTER_ID.to_string(),
        profile_id: ProfileId::TextTrace,
        outcome: ResultOutcome::Pass {
            evidence_tier: EvidenceTier::E1,
        },
        evidence: vec![EvidenceRef::TextLine {
            line_id: "trace-line-001".to_string(),
        }],
        recorded_at: "2026-06-23T12:00:00Z".to_string(),
    }
}

/// Synthesise a pass result for the `frame-capture` profile citing a
/// frame capture under the managed runtime artifact root.
pub fn synthetic_frame_capture_pass_result() -> ConformanceResult {
    let uri = runtime_artifact_uri(
        "synthetic-run",
        RuntimeArtifactKind::FrameCapture,
        "frame-001",
    )
    .expect("synthetic uri");
    ConformanceResult {
        schema_version: CONFORMANCE_SCHEMA_VERSION.to_string(),
        adapter_id: SYNTHETIC_ADAPTER_ID.to_string(),
        profile_id: ProfileId::FrameCapture,
        outcome: ResultOutcome::Pass {
            evidence_tier: EvidenceTier::E2,
        },
        evidence: vec![EvidenceRef::RuntimeArtifact {
            kind: RuntimeArtifactKind::FrameCapture,
            uri,
            artifact_id: Some("frame-001".to_string()),
        }],
        recorded_at: "2026-06-23T12:00:00Z".to_string(),
    }
}

/// Synthesise a manifest declaring both the `frame-capture` and
/// `recording-capture` profiles at the per-profile ceiling. Used by the
/// UTSUSHI-029 paired manifest+results fixtures.
pub fn synthetic_capture_recording_manifest() -> ConformanceManifest {
    ConformanceManifest {
        schema_version: CONFORMANCE_SCHEMA_VERSION.to_string(),
        adapter_id: SYNTHETIC_ADAPTER_ID.to_string(),
        abi_version: ConformanceAbiVersion(1),
        supported_profiles: vec![
            ConformanceProfile {
                id: ProfileId::FrameCapture,
                required_subsystems: vec![
                    SubsystemRequirement::FrameSink,
                    SubsystemRequirement::ArtifactStore,
                ],
                evidence_tier_ceiling: EvidenceTier::E2,
            },
            ConformanceProfile {
                id: ProfileId::RecordingCapture,
                required_subsystems: vec![
                    SubsystemRequirement::FrameSink,
                    SubsystemRequirement::ArtifactStore,
                ],
                evidence_tier_ceiling: EvidenceTier::E2,
            },
        ],
        optional_extensions: Vec::new(),
    }
}

/// Synthesise a frame-capture check carrying three frame refs at E2,
/// all under the managed runtime artifact root, with `frame_index = 0,
/// 1, 2`.
pub fn synthetic_frame_capture_check_three_artifacts_at_e2() -> FrameCaptureConformanceCheck {
    FrameCaptureConformanceCheck {
        profile: ProfileId::FrameCapture,
        observed_artifacts: (0..3u64).map(synthetic_frame_artifact_ref_at_e2).collect(),
        expected_tier_floor: EvidenceTier::E2,
        expected_count_range: ArtifactCountRange { min: 1, max: 8 },
    }
}

/// Helper: build one frame artifact ref at E2 with `frame_index = i`
/// and `frame_id = format!("frame-{i:04}")`.
pub fn synthetic_frame_artifact_ref_at_e2(frame_index: u64) -> FrameArtifactRef {
    let artifact_id = format!("frame-{:04}", frame_index);
    let uri = runtime_artifact_uri(
        "synthetic-run",
        RuntimeArtifactKind::FrameCapture,
        &artifact_id,
    )
    .expect("synthetic uri");
    FrameArtifactRef {
        frame_id: artifact_id.clone(),
        evidence_tier: EvidenceTier::E2,
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

/// Synthesise a recording check with one container ref + three
/// frame-capture refs, `frame_count=3`, `audio_event_count=4`,
/// `duration_ms=1500`, claimed tier E2.
pub fn synthetic_recording_check_metadata_only() -> RecordingConformanceCheck {
    let frame_refs: Vec<ObservationArtifactRef> = (1..=3u32)
        .map(|i| {
            let id = format!("frame-{:04}", i);
            let uri = runtime_artifact_uri("synthetic-run", RuntimeArtifactKind::FrameCapture, &id)
                .expect("uri");
            ObservationArtifactRef {
                artifact_id: id.clone(),
                artifact_kind: "frame_capture".to_string(),
                uri,
                media_type: None,
            }
        })
        .collect();
    let recording_uri = runtime_artifact_uri(
        "synthetic-run",
        RuntimeArtifactKind::Recording,
        "recording-001",
    )
    .expect("uri");
    let mut refs = vec![ObservationArtifactRef {
        artifact_id: "recording-001".to_string(),
        artifact_kind: "recording".to_string(),
        uri: recording_uri,
        media_type: None,
    }];
    refs.extend(frame_refs);
    RecordingConformanceCheck {
        profile: ProfileId::RecordingCapture,
        observed_recording: RecordingMetadata {
            recording_id: "recording-001".to_string(),
            frame_count: 3,
            audio_event_count: 4,
            duration_ms: 1_500,
            evidence_tier: EvidenceTier::E2,
            artifact_refs: refs,
        },
        expected_duration_range: DurationRangeMs {
            min: 1_000,
            max: 2_000,
        },
        expected_event_count_range: ArtifactCountRange { min: 5, max: 10 },
    }
}

/// Synthesise the `Unsupported` result the runner emits when the
/// adapter's manifest does NOT declare [`ProfileId::FrameCapture`]. The
/// companion manifest does NOT declare frame capture; the
/// cross-validator accepts this pair.
pub fn synthetic_frame_capture_unsupported_result() -> ConformanceResult {
    ConformanceResult {
        schema_version: CONFORMANCE_SCHEMA_VERSION.to_string(),
        adapter_id: SYNTHETIC_ADAPTER_ID.to_string(),
        profile_id: ProfileId::FrameCapture,
        outcome: unsupported_frame_capture_result(),
        evidence: Vec::new(),
        recorded_at: "2026-06-23T12:00:00Z".to_string(),
    }
}

/// Synthesise a frame-capture check with a host-path URI on the first
/// artifact. Used by the audit-focus "host path in artifact ref"
/// fixture (plan §6.4).
pub fn synthetic_frame_capture_check_with_host_path() -> FrameCaptureConformanceCheck {
    let mut check = synthetic_frame_capture_check_three_artifacts_at_e2();
    check.observed_artifacts[0].artifact_ref.uri = "/home/leak/frame.png".to_string();
    check
}

/// Synthesise a recording check whose recording-level tier overclaims
/// at E4. Used by the audit-focus "evidence tier overclaim" fixture
/// (plan §6.5).
pub fn synthetic_recording_check_with_e4_overclaim() -> RecordingConformanceCheck {
    let mut check = synthetic_recording_check_metadata_only();
    check.observed_recording.evidence_tier = EvidenceTier::E4;
    check
}

/// Synthesise a frame-capture pass result that pairs with the
/// frame-capture check from
/// [`synthetic_frame_capture_check_three_artifacts_at_e2`]. Used for
/// the paired manifest+results fixture (§6.6).
pub fn synthetic_frame_capture_pass_from_check() -> ConformanceResult {
    let uri = runtime_artifact_uri(
        "synthetic-run",
        RuntimeArtifactKind::FrameCapture,
        "frame-0000",
    )
    .expect("uri");
    ConformanceResult {
        schema_version: CONFORMANCE_SCHEMA_VERSION.to_string(),
        adapter_id: SYNTHETIC_ADAPTER_ID.to_string(),
        profile_id: ProfileId::FrameCapture,
        outcome: ResultOutcome::Pass {
            evidence_tier: EvidenceTier::E2,
        },
        evidence: vec![EvidenceRef::RuntimeArtifact {
            kind: RuntimeArtifactKind::FrameCapture,
            uri,
            artifact_id: Some("frame-0000".to_string()),
        }],
        recorded_at: "2026-06-23T12:00:00Z".to_string(),
    }
}

/// Synthesise a recording-capture pass result that pairs with the
/// recording check from
/// [`synthetic_recording_check_metadata_only`]. Used for the paired
/// manifest+results fixture (§6.6).
pub fn synthetic_recording_pass_from_check() -> ConformanceResult {
    let uri = runtime_artifact_uri(
        "synthetic-run",
        RuntimeArtifactKind::Recording,
        "recording-001",
    )
    .expect("uri");
    ConformanceResult {
        schema_version: CONFORMANCE_SCHEMA_VERSION.to_string(),
        adapter_id: SYNTHETIC_ADAPTER_ID.to_string(),
        profile_id: ProfileId::RecordingCapture,
        outcome: ResultOutcome::Pass {
            evidence_tier: EvidenceTier::E2,
        },
        evidence: vec![EvidenceRef::RuntimeArtifact {
            kind: RuntimeArtifactKind::Recording,
            uri,
            artifact_id: Some("recording-001".to_string()),
        }],
        recorded_at: "2026-06-23T12:00:00Z".to_string(),
    }
}

/// Synthesise the audit-focus paired manifest+results fixture: a
/// manifest declaring both capture profiles plus one Pass result per
/// profile.
pub fn synthetic_capture_recording_paired_manifest_and_results()
-> (ConformanceManifest, Vec<ConformanceResult>) {
    (
        synthetic_capture_recording_manifest(),
        vec![
            synthetic_frame_capture_pass_from_check(),
            synthetic_recording_pass_from_check(),
        ],
    )
}

/// Negative twin of [`synthetic_capture_recording_paired_manifest_and_results`]:
/// lowers the manifest's recording profile ceiling to E1 while the
/// recording Pass result still claims E2, exercising the
/// `PassAboveManifestCeiling` cross-validator reject.
pub fn synthetic_capture_recording_paired_negative() -> (ConformanceManifest, Vec<ConformanceResult>)
{
    let (mut manifest, results) = synthetic_capture_recording_paired_manifest_and_results();
    if let Some(recording) = manifest
        .supported_profiles
        .iter_mut()
        .find(|p| p.id == ProfileId::RecordingCapture)
    {
        recording.evidence_tier_ceiling = EvidenceTier::E1;
    }
    (manifest, results)
}

/// Normalize the `recordedAt` field on a serialized result to a
/// canonical sentinel. Use this in golden fixture comparisons so the
/// volatile timestamp does not break round-trip equality. (Documented
/// in plan §10.5.)
pub fn normalize_recorded_at(value: &mut serde_json::Value, sentinel: &str) {
    if let Some(object) = value.as_object_mut()
        && let Some(recorded_at) = object.get_mut("recordedAt")
    {
        *recorded_at = serde_json::Value::String(sentinel.to_string());
    }
}

#[cfg(test)]
mod tests {
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

    // ---- UTSUSHI-029 capture/recording fixtures ----

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
        let error =
            crate::conformance::cross_validate_results_against_manifest(&manifest, &results)
                .expect_err("expected PassAboveManifestCeiling");
        assert!(matches!(
            error,
            crate::conformance::ConformanceError::PassAboveManifestCeiling { .. }
        ));
    }
}
