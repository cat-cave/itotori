//! Stable semantic diagnostics for the runtime conformance contract.
//!
//! Mirrors the [`crate::sink::errors`] and [`crate::vfs::diagnostics`]
//! precedents: every variant carries a stable `utsushi.conformance.*`
//! semantic code and a `codes::ALL` registry the downstream allowed-code
//! validator joins against (). The audit-focus item is
//! "Skipped != Pass": the enum below makes a manifest-declared
//! `Skip`/`Unsupported` outcome a typed rejection rather than a silent
//! omission.

use std::fmt;

use crate::EvidenceTier;

use super::ProfileId;
use super::manifest::SubsystemRequirement;

/// Stable Utsushi conformance semantic codes.
pub mod codes {
    pub const UNSUPPORTED_SCHEMA_VERSION: &str = "utsushi.conformance.unsupported_schema_version";
    pub const ADAPTER_ID_MALFORMED: &str = "utsushi.conformance.adapter_id_malformed";
    pub const UNKNOWN_ABI_VERSION: &str = "utsushi.conformance.unknown_abi_version";
    pub const MANIFEST_EMPTY: &str = "utsushi.conformance.manifest_empty";
    pub const DUPLICATE_PROFILE: &str = "utsushi.conformance.duplicate_profile";
    pub const MISSING_SUBSYSTEM: &str = "utsushi.conformance.missing_subsystem";
    pub const DUPLICATE_SUBSYSTEM: &str = "utsushi.conformance.duplicate_subsystem";
    pub const EVIDENCE_TIER_ABOVE_PROFILE_CEILING: &str =
        "utsushi.conformance.evidence_tier_above_profile_ceiling";
    pub const ORPHANED_EXTENSION: &str = "utsushi.conformance.orphaned_extension";
    pub const DUPLICATE_EXTENSION: &str = "utsushi.conformance.duplicate_extension";
    pub const EXTENSION_KEY_MALFORMED: &str = "utsushi.conformance.extension_key_malformed";
    pub const RECORDED_AT_MALFORMED: &str = "utsushi.conformance.recorded_at_malformed";
    pub const EVIDENCE_REF_INVALID: &str = "utsushi.conformance.evidence_ref_invalid";
    pub const PASS_WITHOUT_EVIDENCE: &str = "utsushi.conformance.pass_without_evidence";
    pub const MALFORMED_SEMANTIC_CODE: &str = "utsushi.conformance.malformed_semantic_code";
    pub const DECLARED_PROFILE_REPORTED_AS_UNSUPPORTED: &str =
        "utsushi.conformance.declared_profile_reported_as_unsupported";
    pub const DECLARED_PROFILE_SKIPPED: &str = "utsushi.conformance.declared_profile_skipped";
    pub const PROFILE_NOT_DECLARED: &str = "utsushi.conformance.profile_not_declared";
    pub const PROFILE_NOT_REPORTED: &str = "utsushi.conformance.profile_not_reported";
    pub const ADAPTER_ID_MISMATCH: &str = "utsushi.conformance.adapter_id_mismatch";
    pub const PASS_ABOVE_MANIFEST_CEILING: &str = "utsushi.conformance.pass_above_manifest_ceiling";

    // trace and branch conformance codes.
    pub const TRACE_TEXT_MISMATCH: &str = "utsushi.conformance.trace_text_mismatch";
    pub const TRACE_ORDER_MISMATCH: &str = "utsushi.conformance.trace_order_mismatch";
    pub const TRACE_SPEAKER_MISMATCH: &str = "utsushi.conformance.trace_speaker_mismatch";
    pub const TRACE_EVENT_MISSING: &str = "utsushi.conformance.trace_event_missing";
    pub const TRACE_EVENT_UNEXPECTED: &str = "utsushi.conformance.trace_event_unexpected";
    pub const BRIDGE_UNIT_UNLINKED: &str = "utsushi.conformance.bridge_unit_unlinked";
    pub const BRIDGE_UNIT_DIVERGENT: &str = "utsushi.conformance.bridge_unit_divergent";
    pub const BRANCH_MISSING: &str = "utsushi.conformance.branch_missing";
    pub const BRANCH_UNEXPECTED: &str = "utsushi.conformance.branch_unexpected";
    pub const BRANCH_CHOICE_PATH_MISMATCH: &str = "utsushi.conformance.branch_choice_path_mismatch";
    pub const BRANCH_OUTCOME_MISMATCH: &str = "utsushi.conformance.branch_outcome_mismatch";
    pub const TRACE_EVIDENCE_TIER_OVERCLAIM: &str =
        "utsushi.conformance.trace_evidence_tier_overclaim";

    // capture/recording codes. Source of truth is
    // `super::super::capture_recording::codes`; re-export here so legacy
    // dotted paths continue to resolve and so the unified `ALL` slice
    // can name each entry locally. ----
    pub use super::super::capture_recording::codes::{
        ARTIFACT_COUNT_RANGE_MALFORMED, CAPTURE_CHECK_PROFILE_MISMATCH, DURATION_RANGE_MALFORMED,
        FRAME_ARTIFACT_COUNT_OUT_OF_RANGE, FRAME_ARTIFACT_HOST_PATH,
        FRAME_ARTIFACT_KIND_OUTSIDE_ALLOW_LIST, FRAME_CAPTURE_NO_ARTIFACTS,
        FRAME_CAPTURE_UNSUPPORTED, FRAME_EVIDENCE_TIER_ABOVE_SINK_CEILING,
        FRAME_EVIDENCE_TIER_BELOW_FLOOR, FRAME_SEQUENCE_DUPLICATE, FRAME_SEQUENCE_UNORDERED,
        FRAME_TIER_FLOOR_ABOVE_PROFILE_CEILING, FRAME_TIER_FLOOR_BELOW_SINK_FLOOR,
        RECORDING_ARTIFACT_HOST_PATH, RECORDING_ARTIFACT_KIND_OUTSIDE_ALLOW_LIST,
        RECORDING_CAPTURE_UNSUPPORTED, RECORDING_CONTAINER_DUPLICATED, RECORDING_CONTAINER_MISSING,
        RECORDING_DURATION_OUT_OF_RANGE, RECORDING_EVENT_COUNT_OUT_OF_RANGE,
        RECORDING_EVIDENCE_TIER_OVERCLAIM, RECORDING_FRAME_COUNT_MISMATCH, RECORDING_ID_MALFORMED,
    };

    // snapshot conformance codes. Source of truth is
    // `super::super::snapshot_check::codes`; re-export here so legacy
    // dotted paths continue to resolve and so the unified `ALL` slice
    // can name each entry locally. ----
    pub use super::super::snapshot_check::codes::{
        SNAPSHOT_CHECK_PROFILE_MISMATCH, SNAPSHOT_DIFF_INSPECTABLE_ID_MISMATCH,
        SNAPSHOT_EVIDENCE_TIER_OVERCLAIM, SNAPSHOT_INSPECTABLE_ID_MISMATCH, SNAPSHOT_REF_INVALID,
        SNAPSHOT_RESOLUTION_FAILED, SNAPSHOT_RESTORE_UNSUPPORTED,
    };

    /// Full set of stable conformance semantic codes. Conformance
    /// schemas that gate runtime diagnostics by allowed-code list
    /// include each of these.
    pub const ALL: &[&str] = &[
        // substrate (manifest + result envelope).
        UNSUPPORTED_SCHEMA_VERSION,
        ADAPTER_ID_MALFORMED,
        UNKNOWN_ABI_VERSION,
        MANIFEST_EMPTY,
        DUPLICATE_PROFILE,
        MISSING_SUBSYSTEM,
        DUPLICATE_SUBSYSTEM,
        EVIDENCE_TIER_ABOVE_PROFILE_CEILING,
        ORPHANED_EXTENSION,
        DUPLICATE_EXTENSION,
        EXTENSION_KEY_MALFORMED,
        RECORDED_AT_MALFORMED,
        EVIDENCE_REF_INVALID,
        PASS_WITHOUT_EVIDENCE,
        MALFORMED_SEMANTIC_CODE,
        DECLARED_PROFILE_REPORTED_AS_UNSUPPORTED,
        DECLARED_PROFILE_SKIPPED,
        PROFILE_NOT_DECLARED,
        PROFILE_NOT_REPORTED,
        ADAPTER_ID_MISMATCH,
        PASS_ABOVE_MANIFEST_CEILING,
        // trace/branch.
        TRACE_TEXT_MISMATCH,
        TRACE_ORDER_MISMATCH,
        TRACE_SPEAKER_MISMATCH,
        TRACE_EVENT_MISSING,
        TRACE_EVENT_UNEXPECTED,
        BRIDGE_UNIT_UNLINKED,
        BRIDGE_UNIT_DIVERGENT,
        BRANCH_MISSING,
        BRANCH_UNEXPECTED,
        BRANCH_CHOICE_PATH_MISMATCH,
        BRANCH_OUTCOME_MISMATCH,
        TRACE_EVIDENCE_TIER_OVERCLAIM,
        // capture/recording.
        FRAME_CAPTURE_UNSUPPORTED,
        RECORDING_CAPTURE_UNSUPPORTED,
        FRAME_CAPTURE_NO_ARTIFACTS,
        FRAME_ARTIFACT_HOST_PATH,
        RECORDING_ARTIFACT_HOST_PATH,
        RECORDING_EVIDENCE_TIER_OVERCLAIM,
        FRAME_EVIDENCE_TIER_BELOW_FLOOR,
        FRAME_EVIDENCE_TIER_ABOVE_SINK_CEILING,
        CAPTURE_CHECK_PROFILE_MISMATCH,
        ARTIFACT_COUNT_RANGE_MALFORMED,
        DURATION_RANGE_MALFORMED,
        FRAME_TIER_FLOOR_BELOW_SINK_FLOOR,
        FRAME_TIER_FLOOR_ABOVE_PROFILE_CEILING,
        FRAME_ARTIFACT_COUNT_OUT_OF_RANGE,
        FRAME_ARTIFACT_KIND_OUTSIDE_ALLOW_LIST,
        FRAME_SEQUENCE_UNORDERED,
        FRAME_SEQUENCE_DUPLICATE,
        RECORDING_ID_MALFORMED,
        RECORDING_CONTAINER_MISSING,
        RECORDING_CONTAINER_DUPLICATED,
        RECORDING_ARTIFACT_KIND_OUTSIDE_ALLOW_LIST,
        RECORDING_FRAME_COUNT_MISMATCH,
        RECORDING_DURATION_OUT_OF_RANGE,
        RECORDING_EVENT_COUNT_OUT_OF_RANGE,
        // snapshot conformance.
        SNAPSHOT_RESTORE_UNSUPPORTED,
        SNAPSHOT_CHECK_PROFILE_MISMATCH,
        SNAPSHOT_REF_INVALID,
        SNAPSHOT_INSPECTABLE_ID_MISMATCH,
        SNAPSHOT_EVIDENCE_TIER_OVERCLAIM,
        SNAPSHOT_DIFF_INSPECTABLE_ID_MISMATCH,
        SNAPSHOT_RESOLUTION_FAILED,
    ];
}

/// Diagnostic variants emitted by the conformance manifest and result
/// validators. Each variant is a stable conformance signal; never
/// silent. Audit-focus invariants ("Skipped != Pass"
/// "declared profile cannot be Skip/Unsupported") are enforced by the
/// `DeclaredProfile*` variants below.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConformanceError {
    /// `schema_version` field did not match the literal pin.
    UnsupportedSchemaVersion {
        observed: String,
        expected: &'static str,
    },
    /// Adapter id did not match the lowercase kebab pattern.
    AdapterIdMalformed { id: String },
    /// Conformance ABI version is not in `SUPPORTED_ABI_VERSIONS`.
    UnknownAbiVersion {
        declared: u32,
        supported: &'static [u32],
    },
    /// Manifest declared no profiles.
    ManifestEmpty,
    /// Two `ConformanceProfile` entries share the same id.
    DuplicateProfile { id: ProfileId },
    /// Profile is missing a substrate subsystem its `ProfileId` requires.
    MissingSubsystem {
        profile: ProfileId,
        missing: SubsystemRequirement,
    },
    /// Profile declared the same subsystem twice.
    DuplicateSubsystem {
        profile: ProfileId,
        subsystem: SubsystemRequirement,
    },
    /// Profile or result claimed an evidence tier above the profile-id
    /// ceiling.
    EvidenceTierAboveProfileCeiling {
        profile: ProfileId,
        claimed: EvidenceTier,
        ceiling: EvidenceTier,
    },
    /// Extension referenced a profile id that is not declared.
    OrphanedExtension { key: String, profile_id: ProfileId },
    /// Two extensions on the same profile share the same key.
    DuplicateExtension { profile_id: ProfileId, key: String },
    /// Extension key did not match the lowercase kebab pattern.
    ExtensionKeyMalformed { key: String },
    /// `recorded_at` did not parse as RFC3339.
    RecordedAtMalformed { recorded_at: String },
    /// Evidence ref failed structural validation (URI shape, whitespace
    /// or local-path leak).
    EvidenceRefInvalid {
        artifact_kind: &'static str,
        reason: String,
    },
    /// Pass outcome carried no evidence references.
    PassWithoutEvidence { profile: ProfileId },
    /// Outcome `semantic_code` did not match the provider-namespaced
    /// shape regex.
    MalformedSemanticCode { code: String },
    /// `Unsupported.declared_in_manifest == true`. A declared profile
    /// cannot be Unsupported.
    DeclaredProfileReportedAsUnsupported { profile: ProfileId },
    /// Manifest declared the profile but the result reported `Skip`.
    DeclaredProfileSkipped { profile: ProfileId },
    /// Result reported a profile that is not in the manifest.
    ProfileNotDeclared { profile: ProfileId },
    /// Manifest declared the profile but no result reported it.
    ProfileNotReported { profile: ProfileId },
    /// Result adapter id did not match manifest adapter id.
    AdapterIdMismatch { manifest: String, result: String },
    /// Pass outcome tier exceeds the manifest's per-profile ceiling.
    PassAboveManifestCeiling {
        profile: ProfileId,
        claimed: EvidenceTier,
        ceiling: EvidenceTier,
    },
    /// Capture or recording check carried a profile id that does not
    /// match the check kind.
    CaptureCheckProfileMismatch {
        observed: ProfileId,
        expected: ProfileId,
    },
    /// `ArtifactCountRange { min, max }` had `min > max` or `max`
    /// exceeded the soft ceiling.
    ArtifactCountRangeMalformed { min: u32, max: u32 },
    /// `DurationRangeMs { min, max }` had `min > max`.
    DurationRangeMalformed { min: u64, max: u64 },
    /// Capture check declared a tier floor below the
    /// `SinkKind::FrameArtifact` floor of E2.
    FrameTierFloorBelowSinkFloor { floor: EvidenceTier },
    /// Capture check declared a tier floor above the
    /// `ProfileId::FrameCapture` ceiling.
    FrameTierFloorAboveProfileCeiling {
        floor: EvidenceTier,
        ceiling: EvidenceTier,
    },
    /// Observed frame count fell outside the expected range.
    FrameArtifactCountOutOfRange { observed: u32, min: u32, max: u32 },
    /// Capture check declared `min == 0` (zero-floor pass forbidden).
    FrameCaptureNoArtifacts { declared_min: u32 },
    /// A frame's evidence tier sat below the configured floor.
    FrameEvidenceTierBelowFloor {
        frame_id: String,
        observed: EvidenceTier,
        floor: EvidenceTier,
    },
    /// A frame's evidence tier sat above the
    /// `SinkKind::FrameArtifact` ceiling of E4.
    FrameEvidenceTierAboveSinkCeiling {
        frame_id: String,
        observed: EvidenceTier,
        ceiling: EvidenceTier,
    },
    /// A frame artifact ref failed the portable-URI validator.
    FrameArtifactHostPath { frame_id: String, reason: String },
    /// A frame artifact's `artifact_kind` was outside the
    /// `["screenshot", "frame_capture"]` allow list.
    FrameArtifactKindOutsideAllowList { frame_id: String, kind: String },
    /// Frame sequencing was not strictly ascending on `frame_index`.
    FrameSequenceUnordered { previous: u64, current: u64 },
    /// Two frames shared the same `frame_index`.
    FrameSequenceDuplicate { frame_index: u64 },
    /// Recording id was empty, whitespace-laden, or path-shaped.
    RecordingIdMalformed { reason: String },
    /// Recording metadata claimed an evidence tier above the
    /// `ProfileId::RecordingCapture` ceiling.
    RecordingEvidenceTierOverclaim {
        observed: EvidenceTier,
        ceiling: EvidenceTier,
    },
    /// Recording artifact set did not include the recording container ref.
    RecordingContainerMissing,
    /// Recording artifact set carried more than one recording container ref.
    RecordingContainerDuplicated { count: u32 },
    /// A recording artifact's `artifact_kind` was outside the
    /// `["recording", "frame_capture"]` allow list.
    RecordingArtifactKindOutsideAllowList { kind: String },
    /// A recording artifact ref failed the portable-URI validator.
    RecordingArtifactHostPath { reason: String },
    /// Recording `frame_count` did not equal the count of frame-capture
    /// artifact refs.
    RecordingFrameCountMismatch { declared: u32, actual: u32 },
    /// Recording `duration_ms` sat outside `expected_duration_range`.
    RecordingDurationOutOfRange { observed: u64, min: u64, max: u64 },
    /// Recording event count (`frame_count + audio_event_count`) sat
    /// outside `expected_event_count_range`.
    RecordingEventCountOutOfRange { observed: u32, min: u32, max: u32 },
    /// Snapshot conformance check carried a profile id other than
    /// [`ProfileId::SnapshotRestore`].
    SnapshotCheckProfileMismatch {
        observed: ProfileId,
        expected: ProfileId,
    },
    /// `SnapshotRef::validate` rejected the baseline or observed ref on
    /// the snapshot conformance check.
    SnapshotRefInvalid { side: &'static str, reason: String },
    /// Baseline and observed `SnapshotRef`s on the snapshot conformance
    /// check disagreed on `inspectable_id` — diffing snapshots from
    /// different inspectable surfaces is meaningless.
    SnapshotInspectableIdMismatch { baseline: String, observed: String },
    /// Snapshot conformance check declared `expected_tier` above the
    /// [`ProfileId::SnapshotRestore`] ceiling.
    SnapshotEvidenceTierOverclaim {
        observed: EvidenceTier,
        ceiling: EvidenceTier,
    },
}

impl ConformanceError {
    /// Stable `utsushi.conformance.*` semantic code for this variant.
    pub fn semantic_code(&self) -> &'static str {
        match self {
            Self::UnsupportedSchemaVersion { .. } => codes::UNSUPPORTED_SCHEMA_VERSION,
            Self::AdapterIdMalformed { .. } => codes::ADAPTER_ID_MALFORMED,
            Self::UnknownAbiVersion { .. } => codes::UNKNOWN_ABI_VERSION,
            Self::ManifestEmpty => codes::MANIFEST_EMPTY,
            Self::DuplicateProfile { .. } => codes::DUPLICATE_PROFILE,
            Self::MissingSubsystem { .. } => codes::MISSING_SUBSYSTEM,
            Self::DuplicateSubsystem { .. } => codes::DUPLICATE_SUBSYSTEM,
            Self::EvidenceTierAboveProfileCeiling { .. } => {
                codes::EVIDENCE_TIER_ABOVE_PROFILE_CEILING
            }
            Self::OrphanedExtension { .. } => codes::ORPHANED_EXTENSION,
            Self::DuplicateExtension { .. } => codes::DUPLICATE_EXTENSION,
            Self::ExtensionKeyMalformed { .. } => codes::EXTENSION_KEY_MALFORMED,
            Self::RecordedAtMalformed { .. } => codes::RECORDED_AT_MALFORMED,
            Self::EvidenceRefInvalid { .. } => codes::EVIDENCE_REF_INVALID,
            Self::PassWithoutEvidence { .. } => codes::PASS_WITHOUT_EVIDENCE,
            Self::MalformedSemanticCode { .. } => codes::MALFORMED_SEMANTIC_CODE,
            Self::DeclaredProfileReportedAsUnsupported { .. } => {
                codes::DECLARED_PROFILE_REPORTED_AS_UNSUPPORTED
            }
            Self::DeclaredProfileSkipped { .. } => codes::DECLARED_PROFILE_SKIPPED,
            Self::ProfileNotDeclared { .. } => codes::PROFILE_NOT_DECLARED,
            Self::ProfileNotReported { .. } => codes::PROFILE_NOT_REPORTED,
            Self::AdapterIdMismatch { .. } => codes::ADAPTER_ID_MISMATCH,
            Self::PassAboveManifestCeiling { .. } => codes::PASS_ABOVE_MANIFEST_CEILING,
            Self::CaptureCheckProfileMismatch { .. } => codes::CAPTURE_CHECK_PROFILE_MISMATCH,
            Self::ArtifactCountRangeMalformed { .. } => codes::ARTIFACT_COUNT_RANGE_MALFORMED,
            Self::DurationRangeMalformed { .. } => codes::DURATION_RANGE_MALFORMED,
            Self::FrameTierFloorBelowSinkFloor { .. } => codes::FRAME_TIER_FLOOR_BELOW_SINK_FLOOR,
            Self::FrameTierFloorAboveProfileCeiling { .. } => {
                codes::FRAME_TIER_FLOOR_ABOVE_PROFILE_CEILING
            }
            Self::FrameArtifactCountOutOfRange { .. } => codes::FRAME_ARTIFACT_COUNT_OUT_OF_RANGE,
            Self::FrameCaptureNoArtifacts { .. } => codes::FRAME_CAPTURE_NO_ARTIFACTS,
            Self::FrameEvidenceTierBelowFloor { .. } => codes::FRAME_EVIDENCE_TIER_BELOW_FLOOR,
            Self::FrameEvidenceTierAboveSinkCeiling { .. } => {
                codes::FRAME_EVIDENCE_TIER_ABOVE_SINK_CEILING
            }
            Self::FrameArtifactHostPath { .. } => codes::FRAME_ARTIFACT_HOST_PATH,
            Self::FrameArtifactKindOutsideAllowList { .. } => {
                codes::FRAME_ARTIFACT_KIND_OUTSIDE_ALLOW_LIST
            }
            Self::FrameSequenceUnordered { .. } => codes::FRAME_SEQUENCE_UNORDERED,
            Self::FrameSequenceDuplicate { .. } => codes::FRAME_SEQUENCE_DUPLICATE,
            Self::RecordingIdMalformed { .. } => codes::RECORDING_ID_MALFORMED,
            Self::RecordingEvidenceTierOverclaim { .. } => codes::RECORDING_EVIDENCE_TIER_OVERCLAIM,
            Self::RecordingContainerMissing => codes::RECORDING_CONTAINER_MISSING,
            Self::RecordingContainerDuplicated { .. } => codes::RECORDING_CONTAINER_DUPLICATED,
            Self::RecordingArtifactKindOutsideAllowList { .. } => {
                codes::RECORDING_ARTIFACT_KIND_OUTSIDE_ALLOW_LIST
            }
            Self::RecordingArtifactHostPath { .. } => codes::RECORDING_ARTIFACT_HOST_PATH,
            Self::RecordingFrameCountMismatch { .. } => codes::RECORDING_FRAME_COUNT_MISMATCH,
            Self::RecordingDurationOutOfRange { .. } => codes::RECORDING_DURATION_OUT_OF_RANGE,
            Self::RecordingEventCountOutOfRange { .. } => codes::RECORDING_EVENT_COUNT_OUT_OF_RANGE,
            Self::SnapshotCheckProfileMismatch { .. } => codes::SNAPSHOT_CHECK_PROFILE_MISMATCH,
            Self::SnapshotRefInvalid { .. } => codes::SNAPSHOT_REF_INVALID,
            Self::SnapshotInspectableIdMismatch { .. } => codes::SNAPSHOT_INSPECTABLE_ID_MISMATCH,
            Self::SnapshotEvidenceTierOverclaim { .. } => codes::SNAPSHOT_EVIDENCE_TIER_OVERCLAIM,
        }
    }
}

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

impl std::error::Error for ConformanceError {}

#[cfg(test)]
mod tests {
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
}
