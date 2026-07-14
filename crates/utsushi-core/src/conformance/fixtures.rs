//! Conformance fixture builders.
//!
//! Public test-aid surface for downstream consumers (
//! integration tests) that need a well-formed `ConformanceManifest` or
//! `ConformanceResult` to layer their own assertions on top of. The
//! builders are deterministic and engine-neutral: no XP3/KAG/RGSS3/JSON
//! engine names, no host paths, no fixture id collisions.
//!
//! The constructors are part of the default public conformance surface:
//! in-crate integration tests and downstream test crates use the same
//! engine-neutral builders without a Cargo feature handshake.

use crate::snapshot::{
    InMemorySnapshotStore, Snapshot, SnapshotId, SnapshotRef, SnapshotRequest, SnapshotStore,
    SnapshotStoreError, StatePath, StateTree, StateValue, take_snapshot,
};
use crate::{
    EvidenceTier, Inspectable, ObservationArtifactRef, RuntimeArtifactKind, SnapshotError,
    runtime_artifact_uri,
};

use super::capture_recording::{
    ArtifactCountRange, DurationRangeMs, FrameArtifactRef, FrameCaptureConformanceCheck,
    RecordingConformanceCheck, RecordingMetadata, unsupported_frame_capture_result,
};
use super::manifest::{ConformanceProfile, ProfileExtension, SubsystemRequirement};
use super::result::{ConformanceResult, EvidenceRef, ResultOutcome};
use super::snapshot_check::{SnapshotConformanceCheck, unsupported_snapshot_restore_result};
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
/// paired manifest+results fixtures.
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

/// Synthesise a frame-capture check carrying three frame refs at E2
/// all under the managed runtime artifact root, with `frame_index = 0
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
    let artifact_id = format!("frame-{frame_index:04}");
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
/// frame-capture refs, `frame_count=3`, `audio_event_count=4`
/// `duration_ms=1500`, claimed tier E2.
pub fn synthetic_recording_check_metadata_only() -> RecordingConformanceCheck {
    let frame_refs: Vec<ObservationArtifactRef> = (1..=3u32)
        .map(|i| {
            let id = format!("frame-{i:04}");
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

/// Canonical inspectable id used by the snapshot conformance fixtures.
pub const SNAPSHOT_FIXTURE_INSPECTABLE_ID: &str = "utsushi-fixture";

#[derive(Debug)]
struct SnapshotFixturePort {
    tree: StateTree,
}

impl Inspectable for SnapshotFixturePort {
    fn inspectable_id(&self) -> &'static str {
        SNAPSHOT_FIXTURE_INSPECTABLE_ID
    }
    fn inspect_state(&self) -> Result<StateTree, SnapshotError> {
        Ok(self.tree.clone())
    }
}

fn snapshot_fixture_tree(frame: u64) -> StateTree {
    let mut tree = StateTree::new();
    tree.insert(
        StatePath::parse("port.frame").expect("path"),
        StateValue::Uint { value: frame },
    )
    .expect("insert");
    tree
}

fn snapshot_fixture_tree_with_last(frame: u64, last: &str) -> StateTree {
    let mut tree = snapshot_fixture_tree(frame);
    tree.insert(
        StatePath::parse("port.last").expect("path"),
        StateValue::String {
            value: last.to_string(),
        },
    )
    .expect("insert");
    tree
}

fn build_snapshot(snapshot_id: &str, tree: StateTree) -> Snapshot {
    let port = SnapshotFixturePort { tree };
    let request = SnapshotRequest::new("synthetic-run", "2026-06-23T12:00:00Z", EvidenceTier::E1)
        .with_snapshot_id(SnapshotId::parse(snapshot_id).expect("id"));
    take_snapshot(&port, &request).expect("snapshot")
}

fn ref_for_snapshot(snapshot: &Snapshot) -> SnapshotRef {
    SnapshotRef {
        snapshot_id: snapshot.snapshot_id().clone(),
        inspectable_id: snapshot.inspectable_id().to_string(),
        evidence_tier: snapshot.evidence_tier(),
    }
}

/// Synthesise a snapshot conformance check pair (check + populated
/// store) where the baseline and observed snapshots are identical (no
/// drift).
pub fn synthetic_snapshot_check_identical_baseline_and_observed()
-> (SnapshotConformanceCheck, InMemorySnapshotStore) {
    let baseline = build_snapshot("snap-baseline-001", snapshot_fixture_tree(1));
    let observed = build_snapshot("snap-observed-001", snapshot_fixture_tree(1));
    let store = InMemorySnapshotStore::new();
    store.insert(baseline.clone()).expect("insert baseline");
    store.insert(observed.clone()).expect("insert observed");
    let check = SnapshotConformanceCheck {
        profile: ProfileId::SnapshotRestore,
        baseline: ref_for_snapshot(&baseline),
        observed: ref_for_snapshot(&observed),
        expected_tier: EvidenceTier::E1,
    };
    (check, store)
}

/// Synthesise the mutated-snapshot check pair: observed differs from
/// baseline at `port.frame`. This is the audit-focus negative fixture.
pub fn synthetic_snapshot_check_observed_drifts_at_port_frame()
-> (SnapshotConformanceCheck, InMemorySnapshotStore) {
    let baseline = build_snapshot("snap-baseline-001", snapshot_fixture_tree(1));
    let observed = build_snapshot("snap-observed-001", snapshot_fixture_tree(99));
    let store = InMemorySnapshotStore::new();
    store.insert(baseline.clone()).expect("insert baseline");
    store.insert(observed.clone()).expect("insert observed");
    let check = SnapshotConformanceCheck {
        profile: ProfileId::SnapshotRestore,
        baseline: ref_for_snapshot(&baseline),
        observed: ref_for_snapshot(&observed),
        expected_tier: EvidenceTier::E1,
    };
    (check, store)
}

/// Synthesise the two-path drift check pair: observed differs at both
/// `port.frame` and `port.last`.
pub fn synthetic_snapshot_check_observed_drifts_at_two_paths()
-> (SnapshotConformanceCheck, InMemorySnapshotStore) {
    let baseline = build_snapshot(
        "snap-baseline-001",
        snapshot_fixture_tree_with_last(1, "before"),
    );
    let observed = build_snapshot(
        "snap-observed-001",
        snapshot_fixture_tree_with_last(99, "after"),
    );
    let store = InMemorySnapshotStore::new();
    store.insert(baseline.clone()).expect("insert baseline");
    store.insert(observed.clone()).expect("insert observed");
    let check = SnapshotConformanceCheck {
        profile: ProfileId::SnapshotRestore,
        baseline: ref_for_snapshot(&baseline),
        observed: ref_for_snapshot(&observed),
        expected_tier: EvidenceTier::E1,
    };
    (check, store)
}

/// Synthesise the missing-baseline pair: the store contains only the
/// observed snapshot. The check's `run` resolves to `Fail` with
/// `utsushi.snapshot.store_not_found`.
pub fn synthetic_snapshot_check_baseline_missing_from_store()
-> (SnapshotConformanceCheck, InMemorySnapshotStore) {
    let baseline = build_snapshot("snap-baseline-001", snapshot_fixture_tree(1));
    let observed = build_snapshot("snap-observed-001", snapshot_fixture_tree(1));
    let store = InMemorySnapshotStore::new();
    store.insert(observed.clone()).expect("insert observed");
    let check = SnapshotConformanceCheck {
        profile: ProfileId::SnapshotRestore,
        baseline: ref_for_snapshot(&baseline),
        observed: ref_for_snapshot(&observed),
        expected_tier: EvidenceTier::E1,
    };
    (check, store)
}

/// Custom store that returns
/// [`SnapshotStoreError::MismatchedSchemaVersion`] for the observed
/// snapshot. Used by the mismatched-schema-version fixture.
#[derive(Debug)]
pub struct SnapshotFixtureStaleStore {
    baseline: Snapshot,
    observed_id: SnapshotId,
}

impl SnapshotStore for SnapshotFixtureStaleStore {
    fn resolve(&self, reference: &SnapshotRef) -> Result<Snapshot, SnapshotStoreError> {
        if reference.snapshot_id == *self.baseline.snapshot_id() {
            return Ok(self.baseline.clone());
        }
        Err(SnapshotStoreError::MismatchedSchemaVersion {
            snapshot_id: self.observed_id.clone(),
            observed: "0.0.1".to_string(),
            expected: crate::SNAPSHOT_SCHEMA_VERSION,
        })
    }
}

/// Synthesise the mismatched-schema-version fixture: the observed
/// snapshot's stored payload has a schema version mismatch.
pub fn synthetic_snapshot_check_observed_has_mismatched_schema_version()
-> (SnapshotConformanceCheck, SnapshotFixtureStaleStore) {
    let baseline = build_snapshot("snap-baseline-001", snapshot_fixture_tree(1));
    let observed = build_snapshot("snap-observed-001", snapshot_fixture_tree(1));
    let store = SnapshotFixtureStaleStore {
        baseline: baseline.clone(),
        observed_id: observed.snapshot_id().clone(),
    };
    let check = SnapshotConformanceCheck {
        profile: ProfileId::SnapshotRestore,
        baseline: ref_for_snapshot(&baseline),
        observed: ref_for_snapshot(&observed),
        expected_tier: EvidenceTier::E1,
    };
    (check, store)
}

/// Synthesise a snapshot check whose baseline and observed refs disagree
/// on `inspectable_id`. The check rejects at validate time.
pub fn synthetic_snapshot_check_with_mismatched_inspectable_ids() -> SnapshotConformanceCheck {
    let baseline = build_snapshot("snap-baseline-001", snapshot_fixture_tree(1));
    let observed = build_snapshot("snap-observed-001", snapshot_fixture_tree(1));
    let mut check = SnapshotConformanceCheck {
        profile: ProfileId::SnapshotRestore,
        baseline: ref_for_snapshot(&baseline),
        observed: ref_for_snapshot(&observed),
        expected_tier: EvidenceTier::E1,
    };
    check.baseline.inspectable_id = "port-a".to_string();
    check.observed.inspectable_id = "port-b".to_string();
    check
}

/// Synthesise a snapshot check whose `profile` field is wrong.
pub fn synthetic_snapshot_check_with_wrong_profile() -> SnapshotConformanceCheck {
    let (mut check, _store) = synthetic_snapshot_check_identical_baseline_and_observed();
    check.profile = ProfileId::TextTrace;
    check
}

/// Synthesise the `Unsupported` result the runner emits when the
/// adapter's manifest does NOT declare [`ProfileId::SnapshotRestore`].
pub fn synthetic_snapshot_restore_unsupported_result() -> ConformanceResult {
    ConformanceResult {
        schema_version: CONFORMANCE_SCHEMA_VERSION.to_string(),
        adapter_id: SYNTHETIC_ADAPTER_ID.to_string(),
        profile_id: ProfileId::SnapshotRestore,
        outcome: unsupported_snapshot_restore_result(),
        evidence: Vec::new(),
        recorded_at: "2026-06-23T12:00:00Z".to_string(),
    }
}

/// Synthesise a manifest declaring the `snapshot-restore` profile at
/// the profile-id ceiling (E1).
pub fn synthetic_snapshot_restore_manifest() -> ConformanceManifest {
    ConformanceManifest {
        schema_version: CONFORMANCE_SCHEMA_VERSION.to_string(),
        adapter_id: SYNTHETIC_ADAPTER_ID.to_string(),
        abi_version: ConformanceAbiVersion(1),
        supported_profiles: vec![ConformanceProfile {
            id: ProfileId::SnapshotRestore,
            required_subsystems: vec![SubsystemRequirement::SnapshotPrimitives],
            evidence_tier_ceiling: EvidenceTier::E1,
        }],
        optional_extensions: Vec::new(),
    }
}

/// Synthesise a pass result for the `snapshot-restore` profile citing
/// a single [`EvidenceRef::StatePath`] (the audit-focus evidence shape
/// for this slice).
pub fn synthetic_snapshot_restore_pass_result() -> ConformanceResult {
    ConformanceResult {
        schema_version: CONFORMANCE_SCHEMA_VERSION.to_string(),
        adapter_id: SYNTHETIC_ADAPTER_ID.to_string(),
        profile_id: ProfileId::SnapshotRestore,
        outcome: ResultOutcome::Pass {
            evidence_tier: EvidenceTier::E1,
        },
        evidence: vec![EvidenceRef::StatePath {
            path: "port.frame".to_string(),
        }],
        recorded_at: "2026-06-23T12:00:00Z".to_string(),
    }
}

/// Synthesise the audit-focus paired manifest+results fixture for
/// snapshot-restore: manifest declaring snapshot-restore at E1 plus
/// one Pass result.
pub fn synthetic_snapshot_paired_manifest_and_results()
-> (ConformanceManifest, Vec<ConformanceResult>) {
    (
        synthetic_snapshot_restore_manifest(),
        vec![synthetic_snapshot_restore_pass_result()],
    )
}

/// Negative twin: pass result claims E2 while the manifest ceiling
/// remains E1, exercising the tier-overclaim cross-validator reject.
pub fn synthetic_snapshot_paired_negative() -> (ConformanceManifest, Vec<ConformanceResult>) {
    let (manifest, mut results) = synthetic_snapshot_paired_manifest_and_results();
    if let Some(result) = results.first_mut()
        && let ResultOutcome::Pass { evidence_tier } = &mut result.outcome
    {
        *evidence_tier = EvidenceTier::E2;
    }
    (manifest, results)
}

/// Build a populated [`InMemorySnapshotStore`] for use by external test
/// suites that want to reuse the same baseline/observed shape. Inserts
/// both the baseline and the observed (identical) snapshots.
pub fn synthetic_in_memory_snapshot_store() -> InMemorySnapshotStore {
    let baseline = build_snapshot("snap-baseline-001", snapshot_fixture_tree(1));
    let observed = build_snapshot("snap-observed-001", snapshot_fixture_tree(1));
    let store = InMemorySnapshotStore::new();
    store.insert(baseline).expect("insert baseline");
    store.insert(observed).expect("insert observed");
    store
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

    #[test]
    fn synthetic_snapshot_check_identical_baseline_and_observed_validates() {
        let (check, _store) = synthetic_snapshot_check_identical_baseline_and_observed();
        check.validate().expect("validates");
    }

    #[test]
    fn synthetic_snapshot_check_identical_baseline_and_observed_runs_pass() {
        let (check, store) = synthetic_snapshot_check_identical_baseline_and_observed();
        let outcome = check.run(&store);
        match outcome {
            ResultOutcome::Pass { evidence_tier } => assert_eq!(evidence_tier, EvidenceTier::E1),
            other => panic!("expected Pass, got {other:?}"),
        }
    }

    #[test]
    fn synthetic_snapshot_check_observed_drifts_at_port_frame_runs_fail_with_state_drift() {
        let (check, store) = synthetic_snapshot_check_observed_drifts_at_port_frame();
        let outcome = check.run(&store);
        match outcome {
            ResultOutcome::Fail { semantic_code, .. } => {
                assert_eq!(semantic_code, "utsushi.snapshot.state_drift");
            }
            other => panic!("expected Fail, got {other:?}"),
        }
    }

    #[test]
    fn synthetic_snapshot_check_observed_drifts_at_port_frame_evidence_quotes_path_verbatim() {
        let (check, store) = synthetic_snapshot_check_observed_drifts_at_port_frame();
        let baseline = store.resolve(&check.baseline).expect("baseline");
        let observed = store.resolve(&check.observed).expect("observed");
        let diff = crate::diff_snapshots(&baseline, &observed).expect("diff");
        let evidence = SnapshotConformanceCheck::state_path_evidence_from_diff(&diff);
        assert_eq!(
            evidence,
            vec![EvidenceRef::StatePath {
                path: "port.frame".to_string(),
            }]
        );
    }

    #[test]
    fn synthetic_snapshot_check_observed_drifts_at_two_paths_evidence_is_sorted() {
        let (check, store) = synthetic_snapshot_check_observed_drifts_at_two_paths();
        let baseline = store.resolve(&check.baseline).expect("baseline");
        let observed = store.resolve(&check.observed).expect("observed");
        let diff = crate::diff_snapshots(&baseline, &observed).expect("diff");
        let evidence = SnapshotConformanceCheck::state_path_evidence_from_diff(&diff);
        let paths: Vec<&str> = evidence
            .iter()
            .map(|e| match e {
                EvidenceRef::StatePath { path } => path.as_str(),
                _ => panic!("not state_path"),
            })
            .collect();
        let mut sorted = paths.clone();
        sorted.sort_unstable();
        assert_eq!(paths, sorted, "evidence must be sorted ascending");
        assert_eq!(paths, vec!["port.frame", "port.last"]);
    }

    #[test]
    fn synthetic_snapshot_check_baseline_missing_from_store_runs_fail_with_not_found() {
        let (check, store) = synthetic_snapshot_check_baseline_missing_from_store();
        let outcome = check.run(&store);
        match outcome {
            ResultOutcome::Fail { semantic_code, .. } => {
                assert_eq!(semantic_code, "utsushi.snapshot.store_not_found");
            }
            other => panic!("expected Fail, got {other:?}"),
        }
    }

    #[test]
    fn synthetic_snapshot_check_observed_has_mismatched_schema_version_runs_fail_with_typed_code() {
        let (check, store) = synthetic_snapshot_check_observed_has_mismatched_schema_version();
        let outcome = check.run(&store);
        match outcome {
            ResultOutcome::Fail { semantic_code, .. } => {
                assert_eq!(
                    semantic_code,
                    "utsushi.snapshot.store_mismatched_schema_version"
                );
            }
            other => panic!("expected Fail, got {other:?}"),
        }
    }

    #[test]
    fn synthetic_snapshot_check_with_mismatched_inspectable_ids_fails_validation() {
        let check = synthetic_snapshot_check_with_mismatched_inspectable_ids();
        let err = check.validate().expect_err("expected inspectable mismatch");
        assert_eq!(
            err.semantic_code(),
            crate::conformance::snapshot_check::codes::SNAPSHOT_INSPECTABLE_ID_MISMATCH
        );
    }

    #[test]
    fn synthetic_snapshot_check_with_wrong_profile_fails_validation() {
        let check = synthetic_snapshot_check_with_wrong_profile();
        let err = check.validate().expect_err("expected profile mismatch");
        assert_eq!(
            err.semantic_code(),
            crate::conformance::snapshot_check::codes::SNAPSHOT_CHECK_PROFILE_MISMATCH
        );
    }

    #[test]
    fn synthetic_snapshot_restore_unsupported_result_cross_validates_against_undeclared_manifest() {
        let result = synthetic_snapshot_restore_unsupported_result();
        result.validate().expect("validates");
        // Pair with the text-trace manifest (which does NOT declare
        // snapshot-restore) plus the text-trace pass result so every
        // declared profile gets reported.
        let manifest = synthetic_text_trace_manifest();
        crate::conformance::cross_validate_results_against_manifest(
            &manifest,
            &[synthetic_text_trace_pass_result(), result],
        )
        .expect("cross-validates");
    }

    #[test]
    fn synthetic_snapshot_paired_manifest_and_results_cross_validates() {
        let (manifest, results) = synthetic_snapshot_paired_manifest_and_results();
        crate::conformance::cross_validate_results_against_manifest(&manifest, &results)
            .expect("cross-validates");
    }

    #[test]
    fn synthetic_snapshot_paired_negative_rejects_tier_above_manifest_ceiling() {
        let (manifest, results) = synthetic_snapshot_paired_negative();
        let error =
            crate::conformance::cross_validate_results_against_manifest(&manifest, &results)
                .expect_err("expected PassAboveManifestCeiling or overclaim");
        // The result's standalone validator catches the tier overclaim
        // first because `evidence_tier` exceeds the profile-id ceiling
        // (E1). Either error is admissible — what matters is the
        // negative twin is rejected.
        assert!(
            matches!(
                error,
                crate::conformance::ConformanceError::PassAboveManifestCeiling { .. }
                    | crate::conformance::ConformanceError::EvidenceTierAboveProfileCeiling { .. }
            ),
            "expected tier overclaim error, got {error:?}"
        );
    }

    #[test]
    fn synthetic_in_memory_snapshot_store_returns_inserted_snapshots_for_known_ids() {
        let store = synthetic_in_memory_snapshot_store();
        assert_eq!(store.len(), 2);
        let baseline_ref = crate::snapshot::SnapshotRef {
            snapshot_id: crate::snapshot::SnapshotId::parse("snap-baseline-001").expect("id"),
            inspectable_id: SNAPSHOT_FIXTURE_INSPECTABLE_ID.to_string(),
            evidence_tier: EvidenceTier::E1,
        };
        let resolved = store.resolve(&baseline_ref).expect("resolve");
        assert_eq!(resolved.snapshot_id().as_str(), "snap-baseline-001");
    }
}
