use super::*;

pub(super) const INSPECTABLE_ID: &str = "utsushi-fixture";
const BASELINE_ID: &str = "smoke-snapshot-001";
const OBSERVED_ID: &str = "smoke-observed-001";
pub(super) const BASELINE_TICK: u64 = 7;
pub(super) const SMOKE_RUN_ID: &str = "fixture-snapshot-restore-smoke";

/// Inline inspectable port driving the smoke fixture. Carries a pre-built
/// `StateTree` so the test can construct multiple snapshot variants from
/// the same template.
struct SmokeInspect {
    tree: StateTree,
}

impl SmokeInspect {
    fn new(tree: StateTree) -> Self {
        Self { tree }
    }
}

impl Inspectable for SmokeInspect {
    fn inspectable_id(&self) -> &'static str {
        INSPECTABLE_ID
    }

    fn inspect_state(&self) -> Result<StateTree, SnapshotError> {
        Ok(self.tree.clone())
    }
}

/// Canonical baseline state entries. The substrate's `StatePath`
/// validator pins the top-level segment to a known [`StateNamespace`]
/// (`runtime`, `replay`, `bridge`, `vfs`, `port`, `metadata`), so the
/// smoke uses public, namespaced paths that any engine port could emit.
fn canonical_entries() -> Vec<(&'static str, StateValue)> {
    vec![
        (
            "bridge.scene_id",
            StateValue::String {
                value: "scene-loop-entry".to_string(),
            },
        ),
        ("bridge.scene_position_line", StateValue::Uint { value: 12 }),
        ("runtime.flags_read_count", StateValue::Uint { value: 4 }),
        (
            "port.inventory_slot_0",
            StateValue::String {
                value: "scene-token-a".to_string(),
            },
        ),
    ]
}

/// Build the canonical baseline `StateTree` shared by every test.
fn baseline_state_tree() -> StateTree {
    let mut tree = StateTree::new();
    for (path, value) in canonical_entries() {
        tree.insert(StatePath::parse(path).expect("baseline path"), value)
            .expect("insert canonical");
    }
    tree
}

pub(super) fn baseline_snapshot() -> Snapshot {
    let port = SmokeInspect::new(baseline_state_tree());
    let request = SnapshotRequest::new(SMOKE_RUN_ID, "2026-06-23T00:00:00Z", EvidenceTier::E1)
        .with_snapshot_id(SnapshotId::parse(BASELINE_ID).expect("baseline id"))
        .with_tick(BASELINE_TICK);
    take_snapshot(&port, &request).expect("baseline snapshot")
}

pub(super) fn observed_snapshot_identical_to_baseline() -> Snapshot {
    let port = SmokeInspect::new(baseline_state_tree());
    let request = SnapshotRequest::new(SMOKE_RUN_ID, "2026-06-23T00:00:00Z", EvidenceTier::E1)
        .with_snapshot_id(SnapshotId::parse(OBSERVED_ID).expect("observed id"))
        .with_tick(BASELINE_TICK);
    take_snapshot(&port, &request).expect("observed snapshot")
}

pub(super) fn observed_snapshot_with_drift(mutations: &[(&str, StateValue)]) -> Snapshot {
    // The substrate's `StateTree::insert` rejects duplicates, so we build
    // a fresh tree from the canonical entries with mutation overrides
    // applied. The canonical entry list is the source of truth here.
    let mut tree = StateTree::new();
    for (path, default_value) in canonical_entries() {
        let mutation = mutations
            .iter()
            .find(|(mutated_path, _)| *mutated_path == path)
            .map(|(_, value)| value.clone());
        let value = mutation.unwrap_or_else(|| default_value.clone());
        tree.insert(StatePath::parse(path).expect("canonical path"), value)
            .expect("insert canonical");
    }
    let port = SmokeInspect::new(tree);
    let request = SnapshotRequest::new(SMOKE_RUN_ID, "2026-06-23T00:00:00Z", EvidenceTier::E1)
        .with_snapshot_id(SnapshotId::parse(OBSERVED_ID).expect("observed id"))
        .with_tick(BASELINE_TICK);
    take_snapshot(&port, &request).expect("observed snapshot")
}

pub(super) fn snapshot_ref(snapshot: &Snapshot) -> SnapshotRef {
    SnapshotRef {
        snapshot_id: snapshot.snapshot_id().clone(),
        inspectable_id: snapshot.inspectable_id().to_string(),
        evidence_tier: snapshot.evidence_tier(),
    }
}

pub(super) fn populated_store(baseline: &Snapshot, observed: &Snapshot) -> InMemorySnapshotStore {
    let store = InMemorySnapshotStore::new();
    store.insert(baseline.clone()).expect("insert baseline");
    store.insert(observed.clone()).expect("insert observed");
    store
}

pub(super) fn build_check(baseline: &Snapshot, observed: &Snapshot) -> SnapshotConformanceCheck {
    SnapshotConformanceCheck {
        profile: ProfileId::SnapshotRestore,
        baseline: snapshot_ref(baseline),
        observed: snapshot_ref(observed),
        expected_tier: EvidenceTier::E1,
    }
}
