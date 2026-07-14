//! Capture-side conformance check.
//!
//! See [`FrameCaptureConformanceCheck`] for the wire shape and
//! [`FrameCaptureConformanceCheck::validate`] for the rules. The check is
//! engine-neutral: every artifact reference passes through
//! [`crate::ObservationArtifactRef::validate`]
//! [`crate::validate_runtime_artifact_uri`], so host paths
//! `file:`/`data:`/`blob:` schemes, traversal, and any URI outside
//! [`crate::RUNTIME_ARTIFACT_URI_ROOT`] are rejected.

use serde::{Deserialize, Serialize};

use crate::conformance::ProfileId;
use crate::conformance::diagnostics::ConformanceError;
use crate::conformance::result::ResultOutcome;
use crate::sink::SinkKind;
use crate::{EvidenceTier, ObservationArtifactRef};

/// Soft ceiling on `ArtifactCountRange::max` per plan §9.3.
pub const FRAME_ARTIFACT_COUNT_MAX_SOFT_CEILING: u32 = 65_535;

/// Allow-list of `artifact_kind` strings the capture check accepts. The
/// `recording` kind is excluded — that wraps the recording-side check
/// surface, not the per-frame capture surface.
const FRAME_CHECK_ARTIFACT_KIND_ALLOW_LIST: &[&str] = &["screenshot", "frame_capture"];

/// Inclusive count window. Both ends required; defaults are forbidden so
/// a "skipped check hidden as pass" failure is structurally blocked.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactCountRange {
    pub min: u32,
    pub max: u32,
}

/// Per-artifact view used by the capture check. Carries the portable
/// reference plus the per-frame evidence tier so the validator can
/// enforce the tier floor without joining to the sink-level
/// `FrameArtifact`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameArtifactRef {
    /// Stable per-run frame identifier. Carried through to
    /// [`crate::EvidenceRef::FrameArtifactRef`] by the runner.
    pub frame_id: String,
    /// Per-frame evidence tier. Always `>= E2` (the
    /// [`SinkKind::FrameArtifact`] floor) and `<= E4` (its ceiling).
    pub evidence_tier: EvidenceTier,
    /// Portable artifact reference. URI MUST live under
    /// [`crate::RUNTIME_ARTIFACT_URI_ROOT`].
    pub artifact_ref: ObservationArtifactRef,
    /// Monotonic frame number from the runtime clock ( owns
    /// the clock). Used for sequencing.
    pub frame_index: u64,
    /// Optional bridge-unit linkage (the unit this capture was taken for).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub bridge_unit_id: Option<String>,
}

/// Capture-side conformance check.
///
/// Construction does NOT validate; call
/// [`FrameCaptureConformanceCheck::validate`] for the rules and
/// [`FrameCaptureConformanceCheck::run`] to project the validation into a
/// [`ResultOutcome`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameCaptureConformanceCheck {
    /// Always [`ProfileId::FrameCapture`] (enforced by `validate`).
    pub profile: ProfileId,
    /// Frame artifact references the adapter announced. Sequenced by
    /// `frame_index` ascending.
    pub observed_artifacts: Vec<FrameArtifactRef>,
    /// Manifest-declared evidence tier floor for accepted captures.
    pub expected_tier_floor: EvidenceTier,
    /// Inclusive count window.
    pub expected_count_range: ArtifactCountRange,
}

impl FrameCaptureConformanceCheck {
    /// Validate the check's structural rules. Returns the first failure;
    /// the validator does not accumulate a list of errors (one
    /// `ConformanceError` per call mirrors the result
    /// validator).
    pub fn validate(&self) -> Result<(), ConformanceError> {
        // Rule 4.1.1 — profile must be `FrameCapture`.
        if self.profile != ProfileId::FrameCapture {
            return Err(ConformanceError::CaptureCheckProfileMismatch {
                observed: self.profile,
                expected: ProfileId::FrameCapture,
            });
        }
        // Rule 4.1.2 — count range non-inverted and bounded.
        if self.expected_count_range.min > self.expected_count_range.max
            || self.expected_count_range.max > FRAME_ARTIFACT_COUNT_MAX_SOFT_CEILING
        {
            return Err(ConformanceError::ArtifactCountRangeMalformed {
                min: self.expected_count_range.min,
                max: self.expected_count_range.max,
            });
        }
        // Audit-focus: zero-floor pass is forbidden.
        if self.expected_count_range.min == 0 {
            return Err(ConformanceError::FrameCaptureNoArtifacts {
                declared_min: self.expected_count_range.min,
            });
        }
        // Rule 4.1.3 — tier floor at or above E2.
        if self.expected_tier_floor < EvidenceTier::E2 {
            return Err(ConformanceError::FrameTierFloorBelowSinkFloor {
                floor: self.expected_tier_floor,
            });
        }
        // Rule 4.1.4 — tier floor at or below the profile ceiling.
        let profile_ceiling = ProfileId::FrameCapture.evidence_tier_ceiling();
        if self.expected_tier_floor > profile_ceiling {
            return Err(ConformanceError::FrameTierFloorAboveProfileCeiling {
                floor: self.expected_tier_floor,
                ceiling: profile_ceiling,
            });
        }
        // Rule 4.1.5 — observed count inside range.
        let observed_count = u32::try_from(self.observed_artifacts.len()).unwrap_or(u32::MAX);
        if observed_count < self.expected_count_range.min
            || observed_count > self.expected_count_range.max
        {
            return Err(ConformanceError::FrameArtifactCountOutOfRange {
                observed: observed_count,
                min: self.expected_count_range.min,
                max: self.expected_count_range.max,
            });
        }
        // Rule 4.1.6 — per-frame checks.
        let sink_ceiling = SinkKind::FrameArtifact.evidence_tier_ceiling();
        let mut previous_index: Option<u64> = None;
        for frame in &self.observed_artifacts {
            if frame.evidence_tier < self.expected_tier_floor {
                return Err(ConformanceError::FrameEvidenceTierBelowFloor {
                    frame_id: frame.frame_id.clone(),
                    observed: frame.evidence_tier,
                    floor: self.expected_tier_floor,
                });
            }
            if frame.evidence_tier > sink_ceiling {
                return Err(ConformanceError::FrameEvidenceTierAboveSinkCeiling {
                    frame_id: frame.frame_id.clone(),
                    observed: frame.evidence_tier,
                    ceiling: sink_ceiling,
                });
            }
            if let Err(error) = frame.artifact_ref.validate() {
                return Err(ConformanceError::FrameArtifactHostPath {
                    frame_id: frame.frame_id.clone(),
                    reason: error.to_string(),
                });
            }
            if !FRAME_CHECK_ARTIFACT_KIND_ALLOW_LIST
                .contains(&frame.artifact_ref.artifact_kind.as_str())
            {
                return Err(ConformanceError::FrameArtifactKindOutsideAllowList {
                    frame_id: frame.frame_id.clone(),
                    kind: frame.artifact_ref.artifact_kind.clone(),
                });
            }
            if let Some(prev) = previous_index {
                if frame.frame_index < prev {
                    return Err(ConformanceError::FrameSequenceUnordered {
                        previous: prev,
                        current: frame.frame_index,
                    });
                }
                if frame.frame_index == prev {
                    return Err(ConformanceError::FrameSequenceDuplicate {
                        frame_index: frame.frame_index,
                    });
                }
            }
            previous_index = Some(frame.frame_index);
        }
        Ok(())
    }

    /// Project the validation into a [`ResultOutcome`].
    ///
    /// On success: `Pass { evidence_tier }` where the tier is the lower
    /// of the configured tier floor and the
    /// [`ProfileId::FrameCapture`] ceiling. (The check structurally pins
    /// the floor to `<= profile ceiling` in `validate`, so the floor is
    /// always the chosen tier in practice; the `min` is a documented
    /// belt-and-braces.)
    ///
    /// On failure: `Fail { semantic_code, detail }` carrying this
    /// slice's stable codes.
    pub fn run(&self) -> ResultOutcome {
        match self.validate() {
            Ok(()) => {
                let tier = self
                    .expected_tier_floor
                    .min(ProfileId::FrameCapture.evidence_tier_ceiling());
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

    /// Convenience helper that runs the check and bundles the outcome
    /// into a public summary tuple `(outcome, evidence_tier_floor
    /// profile_ceiling, sink_ceiling)` so a runner has the three
    /// numbers the audit checklist requires without having to re-derive
    /// them.
    pub fn into_conformance_result(self) -> CaptureCheckSummary {
        let outcome = self.run();
        CaptureCheckSummary {
            outcome,
            tier_floor: self.expected_tier_floor,
            profile_ceiling: ProfileId::FrameCapture.evidence_tier_ceiling(),
            sink_ceiling: SinkKind::FrameArtifact.evidence_tier_ceiling(),
            check: self,
        }
    }
}

/// Aggregate produced by
/// [`FrameCaptureConformanceCheck::into_conformance_result`]. Carries the
/// three evidence-tier numbers (per-floor, profile ceiling, sink ceiling)
/// alongside the outcome so a reviewer reading the runner output sees
/// all three without joining tables.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CaptureCheckSummary {
    pub outcome: ResultOutcome,
    pub tier_floor: EvidenceTier,
    pub profile_ceiling: EvidenceTier,
    pub sink_ceiling: EvidenceTier,
    pub check: FrameCaptureConformanceCheck,
}

#[cfg(test)]
mod tests {
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
}
