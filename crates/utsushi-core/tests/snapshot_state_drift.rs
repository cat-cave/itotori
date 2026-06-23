//! Integration test for the snapshot substrate's path-keyed diff claim
//! (UTSUSHI-023 §1 claim 2).
//!
//! Takes two snapshots that differ at exactly one state path, then asserts
//! `diff_snapshots` names the drifted path verbatim — not "snapshot did not
//! match". The same diff drives UTSUSHI-028's per-path conformance
//! diagnostics.

use utsushi_core::{
    EvidenceTier, Inspectable, Snapshot, SnapshotError, SnapshotRequest, StateChangeKind,
    StatePath, StateTree, StateValue, diff_snapshots, take_snapshot,
};

struct FrameOnlyPort {
    frame: u64,
}

impl Inspectable for FrameOnlyPort {
    fn inspectable_id(&self) -> &'static str {
        "utsushi-fixture-drift"
    }
    fn inspect_state(&self) -> Result<StateTree, SnapshotError> {
        let mut tree = StateTree::new();
        tree.insert(
            StatePath::parse("port.frame").expect("path"),
            StateValue::Uint { value: self.frame },
        )?;
        tree.insert(
            StatePath::parse("runtime.input.cursor").expect("path"),
            StateValue::Uint { value: 0 },
        )?;
        Ok(tree)
    }
}

fn snapshot(port: &FrameOnlyPort, tick: u64) -> Snapshot {
    let request =
        SnapshotRequest::new("run-drift", "2026-06-23T12:00:00Z", EvidenceTier::E2).with_tick(tick);
    take_snapshot(port, &request).expect("snapshot")
}

#[test]
fn mutated_state_produces_diff_naming_the_drifted_state_path() {
    let port_a = FrameOnlyPort { frame: 1 };
    let port_b = FrameOnlyPort { frame: 2 };
    let snap_a = snapshot(&port_a, 1);
    let snap_b = snapshot(&port_b, 2);
    let diff = diff_snapshots(&snap_a, &snap_b).expect("diff");
    assert_eq!(diff.changes.len(), 1);
    assert_eq!(diff.changes[0].path.as_str(), "port.frame");
    match &diff.changes[0].kind {
        StateChangeKind::Modified { old, new } => {
            assert_eq!(*old, StateValue::Uint { value: 1 });
            assert_eq!(*new, StateValue::Uint { value: 2 });
        }
        other => panic!("expected Modified change, got {other:?}"),
    }
}

#[test]
fn drift_diff_serialized_form_contains_state_path_as_string() {
    // Audit-focus: the serialized diff carries the full state path so
    // downstream conformance diagnostics can quote it verbatim.
    let port_a = FrameOnlyPort { frame: 1 };
    let port_b = FrameOnlyPort { frame: 2 };
    let snap_a = snapshot(&port_a, 1);
    let snap_b = snapshot(&port_b, 2);
    let diff = diff_snapshots(&snap_a, &snap_b).expect("diff");
    let serialized = serde_json::to_string(&diff).expect("to json");
    assert!(
        serialized.contains("\"port.frame\""),
        "serialized diff must contain the drifted path: {serialized}"
    );
}

#[test]
fn no_drift_produces_empty_diff() {
    let port = FrameOnlyPort { frame: 7 };
    let snap = snapshot(&port, 1);
    let diff = diff_snapshots(&snap, &snap).expect("diff");
    assert!(diff.is_empty());
    assert_eq!(diff.changes.len(), 0);
}
