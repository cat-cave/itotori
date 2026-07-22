use super::*;

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
