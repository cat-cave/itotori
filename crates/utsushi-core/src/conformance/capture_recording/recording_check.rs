//! Recording-side conformance check.
//!
//! See [`RecordingConformanceCheck`] for the wire shape and
//! [`RecordingConformanceCheck::validate`] for the rules.
//!
//! The recording carries metadata only — no raw bytes ever. Frame bytes
//! and the container ride through [`ObservationArtifactRef`] under
//! [`crate::RUNTIME_ARTIFACT_URI_ROOT`]; audio events are summarised by
//! count (matching the UTSUSHI-022 audio-event posture: E0 ceiling,
//! metadata only).

use serde::{Deserialize, Serialize};

use crate::conformance::ProfileId;
use crate::conformance::diagnostics::ConformanceError;
use crate::conformance::result::ResultOutcome;
use crate::sink::SinkKind;
use crate::{EvidenceTier, ObservationArtifactRef, looks_like_local_path};

use super::frame_check::ArtifactCountRange;

/// Inclusive duration window in milliseconds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DurationRangeMs {
    pub min: u64,
    pub max: u64,
}

/// Recording metadata. Narrow on purpose: no per-event URIs, no codec,
/// no mix levels — nothing that looks like playback evidence.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingMetadata {
    /// Stable per-run recording identifier.
    pub recording_id: String,
    /// Number of sequential frames captured into the recording.
    pub frame_count: u32,
    /// Number of `AudioEventSink` events captured during the recording.
    /// Metadata only — the events themselves live in the runtime
    /// evidence report under the existing UTSUSHI-022 shape.
    pub audio_event_count: u32,
    /// Recording duration in milliseconds. Monotonic from the runtime
    /// clock (UTSUSHI-021).
    pub duration_ms: u64,
    /// Overall evidence tier the adapter claims for this recording.
    pub evidence_tier: EvidenceTier,
    /// Portable artifact references composing the recording. MUST
    /// include exactly one `artifact_kind = "recording"` ref plus zero
    /// or more `artifact_kind = "frame_capture"` refs.
    pub artifact_refs: Vec<ObservationArtifactRef>,
}

/// Recording-side conformance check.
///
/// Construction does NOT validate; call
/// [`RecordingConformanceCheck::validate`] and
/// [`RecordingConformanceCheck::run`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingConformanceCheck {
    /// Always [`ProfileId::RecordingCapture`] (enforced by `validate`).
    pub profile: ProfileId,
    /// Observed recording metadata.
    pub observed_recording: RecordingMetadata,
    /// Inclusive duration window in ms.
    pub expected_duration_range: DurationRangeMs,
    /// Inclusive event count window (frame_count + audio_event_count).
    pub expected_event_count_range: ArtifactCountRange,
}

/// Soft ceiling on `ArtifactCountRange::max` per plan §9.3. Mirrors the
/// frame-check ceiling.
const EVENT_COUNT_MAX_SOFT_CEILING: u32 = 65_535;

/// Allow-list of `artifact_kind` strings that may appear inside a
/// recording metadata payload.
const RECORDING_ARTIFACT_KIND_ALLOW_LIST: &[&str] = &["recording", "frame_capture"];

impl RecordingConformanceCheck {
    /// Validate the check's structural rules.
    pub fn validate(&self) -> Result<(), ConformanceError> {
        // Rule 4.2.1 — profile must be `RecordingCapture`.
        if self.profile != ProfileId::RecordingCapture {
            return Err(ConformanceError::CaptureCheckProfileMismatch {
                observed: self.profile,
                expected: ProfileId::RecordingCapture,
            });
        }
        // Rule 4.2.2 — duration window non-inverted.
        if self.expected_duration_range.min > self.expected_duration_range.max {
            return Err(ConformanceError::DurationRangeMalformed {
                min: self.expected_duration_range.min,
                max: self.expected_duration_range.max,
            });
        }
        // Rule 4.2.3 — event count window non-inverted and bounded.
        if self.expected_event_count_range.min > self.expected_event_count_range.max
            || self.expected_event_count_range.max > EVENT_COUNT_MAX_SOFT_CEILING
        {
            return Err(ConformanceError::ArtifactCountRangeMalformed {
                min: self.expected_event_count_range.min,
                max: self.expected_event_count_range.max,
            });
        }
        // Rule 4.2.4 — recording id well-formed.
        let id = &self.observed_recording.recording_id;
        if id.is_empty() {
            return Err(ConformanceError::RecordingIdMalformed {
                reason: "recording_id is empty".to_string(),
            });
        }
        if id.chars().any(char::is_whitespace) {
            return Err(ConformanceError::RecordingIdMalformed {
                reason: "recording_id contains whitespace".to_string(),
            });
        }
        if looks_like_local_path(id) {
            return Err(ConformanceError::RecordingIdMalformed {
                reason: "recording_id looks like a local path".to_string(),
            });
        }
        // Rule 4.2.5 — recording tier within profile ceiling.
        let profile_ceiling = ProfileId::RecordingCapture.evidence_tier_ceiling();
        if self.observed_recording.evidence_tier > profile_ceiling {
            return Err(ConformanceError::RecordingEvidenceTierOverclaim {
                observed: self.observed_recording.evidence_tier,
                ceiling: profile_ceiling,
            });
        }
        // Frame-side ceiling shares the `SinkKind::FrameArtifact` clamp
        // so a check that opted around the profile ceiling above could
        // not silently exceed the sink ceiling either; this is the
        // belt-and-braces side of the overclaim defense.
        let sink_ceiling = SinkKind::FrameArtifact.evidence_tier_ceiling();
        if self.observed_recording.evidence_tier > sink_ceiling {
            return Err(ConformanceError::RecordingEvidenceTierOverclaim {
                observed: self.observed_recording.evidence_tier,
                ceiling: sink_ceiling,
            });
        }
        // Rule 4.2.6 / 4.2.7 — exactly one container ref, all others
        // frame_capture, no other kinds.
        let mut container_count: u32 = 0;
        let mut frame_capture_count: u32 = 0;
        for artifact in &self.observed_recording.artifact_refs {
            if !RECORDING_ARTIFACT_KIND_ALLOW_LIST.contains(&artifact.artifact_kind.as_str()) {
                return Err(ConformanceError::RecordingArtifactKindOutsideAllowList {
                    kind: artifact.artifact_kind.clone(),
                });
            }
            // Rule 4.2.8 — every artifact ref portable.
            if let Err(error) = artifact.validate() {
                return Err(ConformanceError::RecordingArtifactHostPath {
                    reason: error.to_string(),
                });
            }
            match artifact.artifact_kind.as_str() {
                "recording" => container_count = container_count.saturating_add(1),
                "frame_capture" => frame_capture_count = frame_capture_count.saturating_add(1),
                // Allow-list checked above; unreachable.
                _ => {}
            }
        }
        if container_count == 0 {
            return Err(ConformanceError::RecordingContainerMissing);
        }
        if container_count > 1 {
            return Err(ConformanceError::RecordingContainerDuplicated {
                count: container_count,
            });
        }
        // Rule 4.2.9 — declared frame_count == counted frame_capture refs.
        if self.observed_recording.frame_count != frame_capture_count {
            return Err(ConformanceError::RecordingFrameCountMismatch {
                declared: self.observed_recording.frame_count,
                actual: frame_capture_count,
            });
        }
        // Rule 4.2.10 — duration inside window.
        if self.observed_recording.duration_ms < self.expected_duration_range.min
            || self.observed_recording.duration_ms > self.expected_duration_range.max
        {
            return Err(ConformanceError::RecordingDurationOutOfRange {
                observed: self.observed_recording.duration_ms,
                min: self.expected_duration_range.min,
                max: self.expected_duration_range.max,
            });
        }
        // Rule 4.2.11 — frame_count + audio_event_count inside window.
        let event_total = self
            .observed_recording
            .frame_count
            .saturating_add(self.observed_recording.audio_event_count);
        if event_total < self.expected_event_count_range.min
            || event_total > self.expected_event_count_range.max
        {
            return Err(ConformanceError::RecordingEventCountOutOfRange {
                observed: event_total,
                min: self.expected_event_count_range.min,
                max: self.expected_event_count_range.max,
            });
        }
        Ok(())
    }

    /// Project the validation into a [`ResultOutcome`].
    pub fn run(&self) -> ResultOutcome {
        match self.validate() {
            Ok(()) => {
                let tier = self
                    .observed_recording
                    .evidence_tier
                    .min(ProfileId::RecordingCapture.evidence_tier_ceiling());
                ResultOutcome::Pass {
                    evidence_tier: tier,
                }
            }
            Err(error) => ResultOutcome::Fail {
                semantic_code: error.semantic_code().to_string(),
                detail: error.to_string(),
            },
        }
    }

    /// Convenience helper: runs the check, returns the outcome alongside
    /// the three tier numbers (per-recording, profile ceiling, sink
    /// ceiling) so a reviewer sees the audit-required tiers inline.
    pub fn into_conformance_result(self) -> RecordingCheckSummary {
        let outcome = self.run();
        RecordingCheckSummary {
            outcome,
            recording_tier: self.observed_recording.evidence_tier,
            profile_ceiling: ProfileId::RecordingCapture.evidence_tier_ceiling(),
            sink_ceiling: SinkKind::FrameArtifact.evidence_tier_ceiling(),
            audio_sink_ceiling: SinkKind::AudioEvent.evidence_tier_ceiling(),
            check: self,
        }
    }
}

/// Aggregate produced by [`RecordingConformanceCheck::into_conformance_result`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecordingCheckSummary {
    pub outcome: ResultOutcome,
    pub recording_tier: EvidenceTier,
    pub profile_ceiling: EvidenceTier,
    pub sink_ceiling: EvidenceTier,
    /// `SinkKind::AudioEvent.evidence_tier_ceiling()` — pinned at E0
    /// today. Surfaced so a reviewer reading the runner output can see
    /// the audio surface stays metadata-only.
    pub audio_sink_ceiling: EvidenceTier,
    pub check: RecordingConformanceCheck,
}

#[cfg(test)]
mod tests {
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
        let restored: RecordingConformanceCheck =
            serde_json::from_value(value).expect("deserializes");
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
}
