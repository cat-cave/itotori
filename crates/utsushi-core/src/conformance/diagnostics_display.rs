use super::*;

use std::fmt;

impl fmt::Display for ConformanceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = self.semantic_code();
        match self {
            Self::UnsupportedSchemaVersion { observed, expected } => {
                write!(formatter, "{code}: observed={observed} expected={expected}")
            }
            Self::AdapterIdMalformed { id } => write!(formatter, "{code}: id={id}"),
            Self::UnknownAbiVersion {
                declared,
                supported,
            } => write!(
                formatter,
                "{code}: declared={declared} supported={supported:?}"
            ),
            Self::ManifestEmpty => write!(formatter, "{code}: no profiles declared"),
            Self::DuplicateProfile { id } => {
                write!(formatter, "{code}: profile={}", id.as_str())
            }
            Self::MissingSubsystem { profile, missing } => write!(
                formatter,
                "{code}: profile={} missing={}",
                profile.as_str(),
                missing.as_str()
            ),
            Self::DuplicateSubsystem { profile, subsystem } => write!(
                formatter,
                "{code}: profile={} subsystem={}",
                profile.as_str(),
                subsystem.as_str()
            ),
            Self::EvidenceTierAboveProfileCeiling {
                profile,
                claimed,
                ceiling,
            }
            | Self::PassAboveManifestCeiling {
                profile,
                claimed,
                ceiling,
            } => write!(
                formatter,
                "{code}: profile={} claimed={} ceiling={}",
                profile.as_str(),
                claimed.as_str(),
                ceiling.as_str()
            ),
            Self::OrphanedExtension { key, profile_id } => write!(
                formatter,
                "{code}: key={key} profile={}",
                profile_id.as_str()
            ),
            Self::DuplicateExtension { profile_id, key } => write!(
                formatter,
                "{code}: profile={} key={key}",
                profile_id.as_str()
            ),
            Self::ExtensionKeyMalformed { key } => write!(formatter, "{code}: key={key}"),
            Self::RecordedAtMalformed { recorded_at } => {
                write!(formatter, "{code}: recorded_at={recorded_at}")
            }
            Self::EvidenceRefInvalid {
                artifact_kind,
                reason,
            } => write!(
                formatter,
                "{code}: artifact_kind={artifact_kind} reason={reason}"
            ),
            Self::PassWithoutEvidence { profile }
            | Self::DeclaredProfileReportedAsUnsupported { profile }
            | Self::DeclaredProfileSkipped { profile }
            | Self::ProfileNotDeclared { profile }
            | Self::ProfileNotReported { profile } => {
                write!(formatter, "{code}: profile={}", profile.as_str())
            }
            Self::MalformedSemanticCode { code: bad_code } => {
                write!(formatter, "{code}: code={bad_code}")
            }
            Self::AdapterIdMismatch { manifest, result } => write!(
                formatter,
                "{code}: manifest_adapter_id={manifest} result_adapter_id={result}"
            ),
            Self::CaptureCheckProfileMismatch { observed, expected }
            | Self::SnapshotCheckProfileMismatch { observed, expected } => write!(
                formatter,
                "{code}: observed={} expected={}",
                observed.as_str(),
                expected.as_str()
            ),
            Self::ArtifactCountRangeMalformed { min, max } => {
                write!(formatter, "{code}: min={min} max={max}")
            }
            Self::DurationRangeMalformed { min, max } => {
                write!(formatter, "{code}: min={min} max={max}")
            }
            Self::FrameTierFloorBelowSinkFloor { floor } => {
                write!(formatter, "{code}: floor={}", floor.as_str())
            }
            Self::FrameTierFloorAboveProfileCeiling { floor, ceiling } => write!(
                formatter,
                "{code}: floor={} ceiling={}",
                floor.as_str(),
                ceiling.as_str()
            ),
            Self::FrameArtifactCountOutOfRange { observed, min, max }
            | Self::RecordingEventCountOutOfRange { observed, min, max } => {
                write!(formatter, "{code}: observed={observed} min={min} max={max}")
            }
            // reason: identical Display body to the u32 *OutOfRange arms above
            // but `observed`/`min`/`max` are u64 here, so folding it into the
            // same `|` pattern would not type-check.
            #[allow(clippy::match_same_arms)]
            Self::RecordingDurationOutOfRange { observed, min, max } => {
                write!(formatter, "{code}: observed={observed} min={min} max={max}")
            }
            Self::FrameCaptureNoArtifacts { declared_min } => {
                write!(formatter, "{code}: declared_min={declared_min}")
            }
            Self::FrameEvidenceTierBelowFloor {
                frame_id,
                observed,
                floor,
            } => write!(
                formatter,
                "{code}: frame_id={frame_id} observed={} floor={}",
                observed.as_str(),
                floor.as_str()
            ),
            Self::FrameEvidenceTierAboveSinkCeiling {
                frame_id,
                observed,
                ceiling,
            } => write!(
                formatter,
                "{code}: frame_id={frame_id} observed={} ceiling={}",
                observed.as_str(),
                ceiling.as_str()
            ),
            Self::FrameArtifactHostPath { frame_id, reason } => {
                write!(formatter, "{code}: frame_id={frame_id} reason={reason}")
            }
            Self::FrameArtifactKindOutsideAllowList { frame_id, kind } => {
                write!(formatter, "{code}: frame_id={frame_id} kind={kind}")
            }
            Self::FrameSequenceUnordered { previous, current } => {
                write!(formatter, "{code}: previous={previous} current={current}")
            }
            Self::FrameSequenceDuplicate { frame_index } => {
                write!(formatter, "{code}: frame_index={frame_index}")
            }
            Self::RecordingIdMalformed { reason } => write!(formatter, "{code}: reason={reason}"),
            Self::RecordingEvidenceTierOverclaim { observed, ceiling }
            | Self::SnapshotEvidenceTierOverclaim { observed, ceiling } => write!(
                formatter,
                "{code}: observed={} ceiling={}",
                observed.as_str(),
                ceiling.as_str()
            ),
            Self::RecordingContainerMissing => {
                write!(formatter, "{code}: no recording-kind artifact ref present")
            }
            Self::RecordingContainerDuplicated { count } => {
                write!(formatter, "{code}: count={count}")
            }
            Self::RecordingArtifactKindOutsideAllowList { kind } => {
                write!(formatter, "{code}: kind={kind}")
            }
            Self::RecordingArtifactHostPath { reason } => {
                write!(formatter, "{code}: reason={reason}")
            }
            Self::RecordingFrameCountMismatch { declared, actual } => {
                write!(formatter, "{code}: declared={declared} actual={actual}")
            }
            Self::SnapshotRefInvalid { side, reason } => {
                write!(formatter, "{code}: side={side} reason={reason}")
            }
            Self::SnapshotInspectableIdMismatch { baseline, observed } => {
                write!(formatter, "{code}: baseline={baseline} observed={observed}")
            }
        }
    }
}
