//! Recording-side conformance check.
//!
//! See [`RecordingConformanceCheck`] for the wire shape and
//! [`RecordingConformanceCheck::validate`] for the rules.
//!
//! The recording carries metadata only — no raw bytes ever. Frame bytes
//! and the container ride through [`ObservationArtifactRef`] under
//! [`crate::RUNTIME_ARTIFACT_URI_ROOT`]; audio events are summarised by
//! count (matching the audio-event posture: E0 ceiling
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

/// Recording metadata. Narrow on purpose: no per-event URIs, no codec
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
    /// evidence report under the existing shape.
    pub audio_event_count: u32,
    /// Recording duration in milliseconds. Monotonic from the runtime
    /// clock ().
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
#[path = "recording_check_tests.rs"]
mod tests;
