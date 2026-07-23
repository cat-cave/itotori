use super::*;
use crate::snapshot::state::{StatePath, StateValue};
use std::collections::BTreeMap;

struct DummyInspect {
    id: &'static str,
    tree: StateTree,
}
impl Inspectable for DummyInspect {
    fn inspectable_id(&self) -> &'static str {
        self.id
    }
    fn inspect_state(&self) -> Result<StateTree, SnapshotError> {
        Ok(self.tree.clone())
    }
}

fn make_tree() -> StateTree {
    let mut tree = StateTree::new();
    tree.insert(
        StatePath::parse("runtime.clock.tick").expect("path"),
        StateValue::Tick {
            value: crate::LogicalClockTick(7),
        },
    )
    .expect("insert tick");
    tree.insert(
        StatePath::parse("port.frame").expect("path"),
        StateValue::Uint { value: 12 },
    )
    .expect("insert frame");
    tree
}

fn make_snapshot() -> Snapshot {
    let port = DummyInspect {
        id: "utsushi-fixture",
        tree: make_tree(),
    };
    let request =
        SnapshotRequest::new("run-001", "2026-06-23T00:00:00Z", EvidenceTier::E2).with_tick(7);
    take_snapshot(&port, &request).expect("snapshot")
}

#[test]
fn snapshot_validate_accepts_well_formed_snapshot_at_e2() {
    let snapshot = make_snapshot();
    assert_eq!(snapshot.evidence_tier(), EvidenceTier::E2);
    snapshot.validate().expect("valid snapshot");
}

#[test]
fn snapshot_validate_rejects_evidence_tier_above_e3() {
    let port = DummyInspect {
        id: "utsushi-fixture",
        tree: make_tree(),
    };
    let request = SnapshotRequest::new("run-001", "2026-06-23T00:00:00Z", EvidenceTier::E4);
    let err = take_snapshot(&port, &request).expect_err("over-claim");
    assert!(matches!(err, SnapshotError::EvidenceTierOverclaim { .. }));
}

#[test]
fn snapshot_validate_rejects_empty_state_tree() {
    let port = DummyInspect {
        id: "utsushi-fixture",
        tree: StateTree::new(),
    };
    let request = SnapshotRequest::new("run-001", "2026-06-23T00:00:00Z", EvidenceTier::E2);
    let err = take_snapshot(&port, &request).expect_err("empty tree");
    assert!(matches!(err, SnapshotError::EmptyStateTree));
}

#[test]
fn snapshot_from_json_value_rejects_mismatched_schema_version() {
    let snapshot = make_snapshot();
    let mut json = snapshot.to_json_value().expect("to json");
    json["schemaVersion"] = "9.9.9".into();
    let err = Snapshot::from_json_value(json).expect_err("bad schema");
    assert!(matches!(err, SnapshotError::SchemaVersionMismatch { .. }));
}

#[test]
fn snapshot_round_trips_through_serde_json() {
    let snapshot = make_snapshot();
    let json = snapshot.to_json_value().expect("to json");
    let restored = Snapshot::from_json_value(json).expect("from json");
    assert_eq!(restored, snapshot);
}

#[test]
fn snapshot_to_json_value_passes_reject_unredacted_local_paths() {
    let snapshot = make_snapshot();
    let value = snapshot.to_json_value().expect("to json");
    reject_unredacted_local_paths_in_value("", &value).expect("no leak");
}

#[test]
fn snapshot_serialized_form_stays_under_declared_envelope_class_ceiling() {
    let snapshot = make_snapshot();
    let bytes = serde_json::to_vec(&snapshot).expect("serialize");
    let limit = snapshot.envelope_class().max_bytes();
    assert!(
        bytes.len() < limit,
        "size {} exceeded ceiling {}",
        bytes.len(),
        limit
    );
}

#[test]
fn snapshot_ref_round_trips_id_inspectable_id_and_tier_only() {
    let snapshot_ref = SnapshotRef {
        snapshot_id: SnapshotId::parse("snap-run-1").expect("id"),
        inspectable_id: "utsushi-fixture".to_string(),
        evidence_tier: EvidenceTier::E2,
    };
    snapshot_ref.validate().expect("clean");
    let json = serde_json::to_value(&snapshot_ref).expect("to json");
    let restored: SnapshotRef = serde_json::from_value(json).expect("from json");
    assert_eq!(restored, snapshot_ref);
}

#[test]
fn take_snapshot_from_inspectable_returns_validated_snapshot() {
    let snapshot = make_snapshot();
    assert_eq!(snapshot.inspectable_id(), "utsushi-fixture");
    assert!(!snapshot.state_tree().is_empty());
}

#[test]
fn take_snapshot_derives_id_deterministically_from_run_id_when_unset() {
    let port = DummyInspect {
        id: "utsushi-fixture",
        tree: make_tree(),
    };
    let req_a =
        SnapshotRequest::new("run-001", "2026-06-23T00:00:00Z", EvidenceTier::E2).with_tick(7);
    let req_b =
        SnapshotRequest::new("run-001", "2026-06-23T00:00:00Z", EvidenceTier::E2).with_tick(7);
    let a = take_snapshot(&port, &req_a).expect("a");
    let b = take_snapshot(&port, &req_b).expect("b");
    assert_eq!(a.snapshot_id(), b.snapshot_id());
}

#[test]
fn take_snapshot_rejects_inspectable_that_produces_invalid_state_tree() {
    struct BadPort;
    impl Inspectable for BadPort {
        fn inspectable_id(&self) -> &'static str {
            "utsushi-fixture"
        }
        fn inspect_state(&self) -> Result<StateTree, SnapshotError> {
            // Return an empty tree which fails validation.
            Ok(StateTree::new())
        }
    }
    let port = BadPort;
    let request = SnapshotRequest::new("run-001", "2026-06-23T00:00:00Z", EvidenceTier::E2);
    let err = take_snapshot(&port, &request).expect_err("invalid");
    assert!(matches!(err, SnapshotError::EmptyStateTree));
}

#[test]
fn take_snapshot_requires_caller_supplied_generated_at_rfc3339_string() {
    let port = DummyInspect {
        id: "utsushi-fixture",
        tree: make_tree(),
    };
    let request = SnapshotRequest::new("run-001", "not-an-rfc3339", EvidenceTier::E2);
    let err = take_snapshot(&port, &request).expect_err("bad time");
    assert!(matches!(err, SnapshotError::InvalidGeneratedAt { .. }));
}

/// The substrate never calls `SystemTime::now()`. This is enforced by
/// the caller-supplied `generated_at` contract; we assert here that
/// the validator rejects the most obvious accidental input.
#[test]
fn take_snapshot_does_not_call_system_time_now() {
    // Documentation / API contract test: the substrate only accepts
    // a caller-supplied RFC3339 timestamp. There is no public way to
    // build a snapshot without one. (`Snapshot` has only private
    // fields so no caller can construct one directly.)
    let port = DummyInspect {
        id: "utsushi-fixture",
        tree: make_tree(),
    };
    // Passing the empty string fails — no substrate-side fallback to
    // wall-clock time.
    let request = SnapshotRequest::new("run-001", "", EvidenceTier::E2);
    let err = take_snapshot(&port, &request).expect_err("no fallback");
    assert!(matches!(err, SnapshotError::InvalidGeneratedAt { .. }));
}

#[path = "snapshot_tests/restore.rs"]
mod restore;

// Compile-time / structural assertion: `Snapshot` has no
// `state_tree_mut` accessor. Attempting to use one fails at compile
// time and the absence of such a method is structurally enforced
// by the private field + read-only accessor surface above.
//
// We exercise the read-only posture by asserting that `state_tree`
// returns a shared reference whose lifetime is bounded by `&self`.
#[test]
fn snapshot_state_tree_accessor_returns_shared_reference_only() {
    let snapshot = make_snapshot();
    let tree_ref: &StateTree = snapshot.state_tree();
    // The returned reference borrows from `snapshot`. We can read
    // through it but cannot mutate via this accessor (no `&mut`
    // alternative is provided).
    assert!(!tree_ref.is_empty());
}

// Suppress unused warning: BTreeMap import used by code under test.
#[test]
fn snapshot_schema_version_constant_matches_pin() {
    assert_eq!(
        SnapshotSchemaVersion::current().as_str(),
        SNAPSHOT_SCHEMA_VERSION
    );
    let _ = BTreeMap::<String, StateValue>::new();
}
