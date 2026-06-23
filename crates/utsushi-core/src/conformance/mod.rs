//! Runtime conformance contract (UTSUSHI-026).
//!
//! Engine-neutral substrate every Utsushi runtime participant uses to
//! declare what it claims to validate and to report what each declared
//! check actually produced.
//!
//! The two halves of the contract live in sibling submodules:
//!
//! - [`manifest::ConformanceManifest`] — adapter-published declaration
//!   of which profiles the adapter claims to satisfy. Built once at
//!   registration time, validated by [`manifest::ConformanceManifest::validate`].
//! - [`result::ConformanceResult`] — one outcome per profile attempted
//!   in a conformance run. The result schema distinguishes Pass / Fail /
//!   Skip / Unsupported with required semantic codes; the audit-focus
//!   item "Skipped != Pass" is structural (separate enum variants).
//!
//! [`cross_validate_results_against_manifest`] enforces the join
//! invariants: declared profiles must be attempted (no Skip / no
//! Unsupported), Pass tier must not exceed the manifest's per-profile
//! ceiling, and `Unsupported.declared_in_manifest` must agree with the
//! manifest's set membership.
//!
//! The two manifests stay structurally separated (no embedding) per
//! plan §10.1; an optional cross-check
//! ([`cross_validate_conformance_manifest_against_port_manifest`])
//! joins them at the id level when both are present.

use serde::{Deserialize, Serialize};

pub mod capture_recording;
pub mod diagnostics;
pub mod fixtures;
pub mod manifest;
pub mod result;
pub mod trace_branch;

pub use capture_recording::{
    ArtifactCountRange, CaptureCheckSummary, DurationRangeMs, FrameArtifactRef,
    FrameCaptureConformanceCheck, RecordingCheckSummary, RecordingConformanceCheck,
    RecordingMetadata, unsupported_frame_capture_result, unsupported_recording_capture_result,
};
pub use diagnostics::ConformanceError;
pub use manifest::{
    ConformanceAbiVersion, ConformanceManifest, ConformanceProfile, ProfileExtension,
    SubsystemRequirement,
};
pub use result::{ConformanceResult, EvidenceRef, ResultOutcome};

use crate::{EvidenceTier, port::PortManifest};

/// Schema version pin for the runtime conformance contract.
pub const CONFORMANCE_SCHEMA_VERSION: &str = "0.1.0-alpha";

/// Stable conformance profile identifier. The set is fixed at six
/// variants in this slice (plan §10.2); adding a profile is additive
/// (new enum variant + schema version bump).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProfileId {
    /// Adapter can produce a deterministic text trace whose ordering
    /// and bridge-unit linkage UTSUSHI-027 validates.
    TextTrace,
    /// Adapter can enumerate runtime choice / branch points and the
    /// observed traversal matches expected (UTSUSHI-027).
    BranchCapture,
    /// Adapter can take a snapshot at a logical tick and restore it
    /// (UTSUSHI-028).
    SnapshotRestore,
    /// Adapter can emit at least one frame artifact referenced through
    /// the managed runtime artifact root (UTSUSHI-029).
    FrameCapture,
    /// Adapter can emit a recording artifact referenced through the
    /// managed runtime artifact root (UTSUSHI-029).
    RecordingCapture,
    /// Adapter can drive a replay log and replay the recorded trace
    /// (UTSUSHI-021/103 substrate).
    DeterministicReplay,
}

impl ProfileId {
    /// All canonical profile ids in declaration order.
    pub const ALL: &'static [ProfileId] = &[
        ProfileId::TextTrace,
        ProfileId::BranchCapture,
        ProfileId::SnapshotRestore,
        ProfileId::FrameCapture,
        ProfileId::RecordingCapture,
        ProfileId::DeterministicReplay,
    ];

    /// Stable kebab-case wire identifier.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TextTrace => "text-trace",
            Self::BranchCapture => "branch-capture",
            Self::SnapshotRestore => "snapshot-restore",
            Self::FrameCapture => "frame-capture",
            Self::RecordingCapture => "recording-capture",
            Self::DeterministicReplay => "deterministic-replay",
        }
    }

    /// Substrate subsystems this profile requires (an adapter's
    /// declared `required_subsystems` MUST be a superset).
    pub fn required_subsystems(self) -> &'static [SubsystemRequirement] {
        match self {
            Self::TextTrace => &[SubsystemRequirement::TextSink],
            Self::BranchCapture => &[SubsystemRequirement::TextSink],
            Self::SnapshotRestore => &[SubsystemRequirement::SnapshotPrimitives],
            Self::FrameCapture => &[
                SubsystemRequirement::FrameSink,
                SubsystemRequirement::ArtifactStore,
            ],
            Self::RecordingCapture => &[
                SubsystemRequirement::FrameSink,
                SubsystemRequirement::ArtifactStore,
            ],
            Self::DeterministicReplay => &[
                SubsystemRequirement::ReplayLog,
                SubsystemRequirement::Clock,
                SubsystemRequirement::TextSink,
            ],
        }
    }

    /// Maximum evidence tier this profile may ever claim, independent
    /// of the adapter's manifest ceiling.
    pub fn evidence_tier_ceiling(self) -> EvidenceTier {
        match self {
            Self::TextTrace
            | Self::BranchCapture
            | Self::SnapshotRestore
            | Self::DeterministicReplay => EvidenceTier::E1,
            Self::FrameCapture | Self::RecordingCapture => EvidenceTier::E2,
        }
    }
}

/// Enforce the manifest+results join rules.
///
/// Audit-focus invariants enforced here:
/// - Every declared profile MUST be reported.
/// - A declared profile MUST NOT be reported as `Skip` (the headline
///   defense for "skipped != pass" surfaced through the runner side).
/// - `Unsupported.declared_in_manifest` MUST agree with the manifest's
///   set membership.
/// - `Pass.evidence_tier` MUST NOT exceed the manifest's per-profile
///   ceiling.
/// - Results that report a profile id absent from the manifest are
///   rejected (no orphan results).
pub fn cross_validate_results_against_manifest(
    manifest: &ConformanceManifest,
    results: &[ConformanceResult],
) -> Result<(), ConformanceError> {
    manifest.validate()?;

    let declared: std::collections::HashSet<ProfileId> =
        manifest.supported_profiles.iter().map(|p| p.id).collect();

    let mut reported: std::collections::HashSet<ProfileId> = std::collections::HashSet::new();

    for result in results {
        result.validate()?;
        if result.adapter_id != manifest.adapter_id {
            return Err(ConformanceError::AdapterIdMismatch {
                manifest: manifest.adapter_id.clone(),
                result: result.adapter_id.clone(),
            });
        }
        reported.insert(result.profile_id);

        let profile_declared = declared.contains(&result.profile_id);

        match &result.outcome {
            ResultOutcome::Pass { evidence_tier } => {
                if !profile_declared {
                    return Err(ConformanceError::ProfileNotDeclared {
                        profile: result.profile_id,
                    });
                }
                let manifest_profile = manifest
                    .profile(result.profile_id)
                    .expect("declared profile present");
                if *evidence_tier > manifest_profile.evidence_tier_ceiling {
                    return Err(ConformanceError::PassAboveManifestCeiling {
                        profile: result.profile_id,
                        claimed: *evidence_tier,
                        ceiling: manifest_profile.evidence_tier_ceiling,
                    });
                }
            }
            ResultOutcome::Fail { .. } => {
                if !profile_declared {
                    return Err(ConformanceError::ProfileNotDeclared {
                        profile: result.profile_id,
                    });
                }
            }
            ResultOutcome::Skip { .. } => {
                if profile_declared {
                    return Err(ConformanceError::DeclaredProfileSkipped {
                        profile: result.profile_id,
                    });
                }
            }
            ResultOutcome::Unsupported {
                declared_in_manifest,
                ..
            } => {
                // declared_in_manifest = true with a declared profile is
                // already rejected by ConformanceResult::validate as
                // DeclaredProfileReportedAsUnsupported. Here we catch
                // the symmetric false claim (declared_in_manifest = true
                // for an undeclared profile) AND the case where
                // declared_in_manifest = false but the profile is in
                // fact declared.
                if profile_declared {
                    return Err(ConformanceError::DeclaredProfileReportedAsUnsupported {
                        profile: result.profile_id,
                    });
                }
                if *declared_in_manifest {
                    // Profile is not declared but the result claims it
                    // is. Symmetric false claim.
                    return Err(ConformanceError::ProfileNotDeclared {
                        profile: result.profile_id,
                    });
                }
            }
        }
    }

    for profile in &manifest.supported_profiles {
        if !reported.contains(&profile.id) {
            return Err(ConformanceError::ProfileNotReported {
                profile: profile.id,
            });
        }
    }

    Ok(())
}

/// Optional cross-check pairing the conformance manifest with the
/// engine port manifest.
///
/// Returns `Ok(())` if either side is missing information rather than
/// implicit failure — adapters that ship without a [`PortManifest`]
/// (launch-host wrappers) simply skip this helper.
pub fn cross_validate_conformance_manifest_against_port_manifest(
    conformance: &ConformanceManifest,
    port: &PortManifest,
) -> Result<(), ConformanceError> {
    if conformance.adapter_id != port.id {
        return Err(ConformanceError::AdapterIdMismatch {
            manifest: conformance.adapter_id.clone(),
            result: port.id.to_string(),
        });
    }
    for profile in &conformance.supported_profiles {
        if profile.evidence_tier_ceiling > port.evidence_tier_max {
            return Err(ConformanceError::EvidenceTierAboveProfileCeiling {
                profile: profile.id,
                claimed: profile.evidence_tier_ceiling,
                ceiling: port.evidence_tier_max,
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_id_required_subsystems_text_trace_includes_text_sink() {
        assert!(
            ProfileId::TextTrace
                .required_subsystems()
                .contains(&SubsystemRequirement::TextSink)
        );
    }

    #[test]
    fn profile_id_required_subsystems_frame_capture_includes_frame_sink_and_artifact_store() {
        let required = ProfileId::FrameCapture.required_subsystems();
        assert!(required.contains(&SubsystemRequirement::FrameSink));
        assert!(required.contains(&SubsystemRequirement::ArtifactStore));
    }

    #[test]
    fn profile_id_required_subsystems_snapshot_restore_includes_snapshot_primitives() {
        assert!(
            ProfileId::SnapshotRestore
                .required_subsystems()
                .contains(&SubsystemRequirement::SnapshotPrimitives)
        );
    }

    #[test]
    fn profile_id_required_subsystems_deterministic_replay_includes_replay_log_and_clock() {
        let required = ProfileId::DeterministicReplay.required_subsystems();
        assert!(required.contains(&SubsystemRequirement::ReplayLog));
        assert!(required.contains(&SubsystemRequirement::Clock));
    }

    #[test]
    fn profile_id_evidence_tier_ceiling_text_trace_is_e1() {
        assert_eq!(
            ProfileId::TextTrace.evidence_tier_ceiling(),
            EvidenceTier::E1
        );
    }

    #[test]
    fn profile_id_evidence_tier_ceiling_frame_capture_is_e2() {
        assert_eq!(
            ProfileId::FrameCapture.evidence_tier_ceiling(),
            EvidenceTier::E2
        );
    }

    #[test]
    fn profile_id_as_str_is_kebab_case_for_every_variant() {
        for id in ProfileId::ALL {
            let rendered = id.as_str();
            assert!(
                !rendered.is_empty(),
                "profile id {id:?} as_str must not be empty"
            );
            assert!(
                rendered
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
                "profile id {id:?} as_str {rendered} must be kebab-case"
            );
            assert!(
                rendered.as_bytes()[0].is_ascii_lowercase(),
                "profile id {id:?} as_str {rendered} must start with lowercase letter"
            );
        }
    }

    #[test]
    fn profile_id_round_trips_through_serde_in_kebab_case() {
        for id in ProfileId::ALL {
            let value = serde_json::to_value(id).expect("serializes");
            let rendered = value.as_str().expect("serialized as string");
            assert_eq!(rendered, id.as_str(), "kebab-case shape mismatch");
            let restored: ProfileId = serde_json::from_value(value).expect("deserializes");
            assert_eq!(restored, *id);
        }
    }

    #[test]
    fn profile_id_required_subsystems_all_match_known_set() {
        // Sanity: every required subsystem is one of the declared enum
        // variants. The match in `SubsystemRequirement` makes this
        // automatic but the test guards against future drift.
        for id in ProfileId::ALL {
            for sub in id.required_subsystems() {
                let _ = sub.as_str();
            }
        }
    }
}
