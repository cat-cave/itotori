use super::*;
use crate::EvidenceTier;
use crate::snapshot::inspectable::Inspectable;
use crate::snapshot::snapshot::{SnapshotRequest, take_snapshot};
use crate::snapshot::state::{StatePath, StateTree, StateValue};

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

fn make_tree(frame: u64) -> StateTree {
    let mut tree = StateTree::new();
    tree.insert(
        StatePath::parse("port.frame").expect("path"),
        StateValue::Uint { value: frame },
    )
    .expect("insert");
    tree
}

fn make_snapshot(snapshot_id: &str, inspectable_id: &'static str, frame: u64) -> Snapshot {
    let port = DummyInspect {
        id: inspectable_id,
        tree: make_tree(frame),
    };
    let request = SnapshotRequest::new("run-001", "2026-06-23T00:00:00Z", EvidenceTier::E2)
        .with_snapshot_id(SnapshotId::parse(snapshot_id).expect("id"));
    take_snapshot(&port, &request).expect("snapshot")
}

fn ref_for(snapshot: &Snapshot) -> SnapshotRef {
    SnapshotRef {
        snapshot_id: snapshot.snapshot_id().clone(),
        inspectable_id: snapshot.inspectable_id().to_string(),
        evidence_tier: snapshot.evidence_tier(),
    }
}

#[test]
fn in_memory_snapshot_store_round_trips_a_validated_snapshot() {
    let store = InMemorySnapshotStore::new();
    let snapshot = make_snapshot("snap-baseline-001", "utsushi-fixture", 1);
    assert!(store.is_empty());
    let prev = store.insert(snapshot.clone()).expect("insert");
    assert!(prev.is_none());
    assert_eq!(store.len(), 1);
    let resolved = store.resolve(&ref_for(&snapshot)).expect("resolve");
    assert_eq!(resolved, snapshot);
}

#[test]
fn in_memory_snapshot_store_resolve_returns_byte_equal_snapshot_to_inserted() {
    let store = InMemorySnapshotStore::new();
    let snapshot = make_snapshot("snap-baseline-001", "utsushi-fixture", 7);
    store.insert(snapshot.clone()).expect("insert");
    let resolved = store.resolve(&ref_for(&snapshot)).expect("resolve");
    let a = serde_json::to_vec(&snapshot).expect("a");
    let b = serde_json::to_vec(&resolved).expect("b");
    assert_eq!(a, b, "canonical JSON must round-trip byte-equal");
}

#[test]
fn in_memory_snapshot_store_insert_returns_previous_payload_on_overwrite() {
    let store = InMemorySnapshotStore::new();
    let first = make_snapshot("snap-baseline-001", "utsushi-fixture", 1);
    let second = make_snapshot("snap-baseline-001", "utsushi-fixture", 2);
    assert!(store.insert(first.clone()).expect("insert").is_none());
    let prev = store.insert(second.clone()).expect("overwrite");
    assert_eq!(prev, Some(first));
    let resolved = store.resolve(&ref_for(&second)).expect("resolve");
    assert_eq!(resolved, second);
}

#[test]
fn in_memory_snapshot_store_resolve_returns_not_found_when_id_absent() {
    let store = InMemorySnapshotStore::new();
    let snapshot = make_snapshot("snap-baseline-001", "utsushi-fixture", 1);
    store.insert(snapshot).expect("insert");
    let missing_ref = SnapshotRef {
        snapshot_id: SnapshotId::parse("snap-observed-001").expect("id"),
        inspectable_id: "utsushi-fixture".to_string(),
        evidence_tier: EvidenceTier::E2,
    };
    let err = store.resolve(&missing_ref).expect_err("not found");
    assert!(matches!(err, SnapshotStoreError::NotFound { .. }));
    assert_eq!(err.semantic_code(), codes::STORE_NOT_FOUND);
}

#[test]
fn in_memory_snapshot_store_resolve_returns_invalid_snapshot_ref_when_ref_malformed() {
    let store = InMemorySnapshotStore::new();
    let bad_ref = SnapshotRef {
        snapshot_id: SnapshotId::parse("snap-baseline-001").expect("id"),
        inspectable_id: "Bad Id".to_string(),
        evidence_tier: EvidenceTier::E2,
    };
    let err = store.resolve(&bad_ref).expect_err("invalid ref");
    assert!(matches!(err, SnapshotStoreError::InvalidSnapshotRef { .. }));
    assert_eq!(err.semantic_code(), codes::STORE_INVALID_SNAPSHOT_REF);
}

#[test]
fn in_memory_snapshot_store_resolve_returns_inspectable_id_mismatch_when_ref_targets_wrong_port() {
    let store = InMemorySnapshotStore::new();
    let snapshot = make_snapshot("snap-baseline-001", "utsushi-fixture", 1);
    store.insert(snapshot.clone()).expect("insert");
    // Use a valid id shape for `wrong-port` so the validator passes
    // and the store reaches the inspectable-id check.
    let wrong_ref = SnapshotRef {
        snapshot_id: snapshot.snapshot_id().clone(),
        inspectable_id: "wrong-port".to_string(),
        evidence_tier: EvidenceTier::E2,
    };
    let err = store.resolve(&wrong_ref).expect_err("mismatch");
    assert!(matches!(
        err,
        SnapshotStoreError::InspectableIdMismatch { .. }
    ));
    assert_eq!(err.semantic_code(), codes::STORE_INSPECTABLE_ID_MISMATCH);
}

#[test]
fn in_memory_snapshot_store_resolve_returns_store_unavailable_on_lock_poison() {
    let store = InMemorySnapshotStore::new();
    let snapshot = make_snapshot("snap-baseline-001", "utsushi-fixture", 1);
    store.insert(snapshot.clone()).expect("insert");
    // Poison the mutex by panicking inside a held guard.
    let cloned = store.clone();
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _guard = cloned.inner.lock().expect("first lock");
        panic!("poison");
    }));
    let err = store.resolve(&ref_for(&snapshot)).expect_err("poisoned");
    assert!(matches!(err, SnapshotStoreError::StoreUnavailable { .. }));
    assert_eq!(err.semantic_code(), codes::STORE_UNAVAILABLE);
}

#[test]
fn snapshot_store_error_semantic_code_maps_every_variant_into_codes_all() {
    let variants = [
        SnapshotStoreError::NotFound {
            snapshot_id: SnapshotId::parse("snap-a").expect("id"),
        },
        SnapshotStoreError::MismatchedSchemaVersion {
            snapshot_id: SnapshotId::parse("snap-a").expect("id"),
            observed: "0.0.1".to_string(),
            expected: SNAPSHOT_SCHEMA_VERSION,
        },
        SnapshotStoreError::InvalidSnapshotRef {
            reason: SnapshotError::EmptyStateTree,
        },
        SnapshotStoreError::InspectableIdMismatch {
            snapshot_id: SnapshotId::parse("snap-a").expect("id"),
            expected: "a".to_string(),
            found: "b".to_string(),
        },
        SnapshotStoreError::StoreUnavailable {
            reason: "mutex poisoned".to_string(),
        },
    ];
    let all: std::collections::HashSet<&'static str> = codes::ALL.iter().copied().collect();
    for variant in &variants {
        let code = variant.semantic_code();
        assert!(
            all.contains(code),
            "code {code} missing from snapshot::store::codes::ALL (variant {variant:?})"
        );
    }
}

#[test]
fn snapshot_store_error_display_does_not_leak_host_paths() {
    let variants = [
        SnapshotStoreError::NotFound {
            snapshot_id: SnapshotId::parse("snap-a").expect("id"),
        },
        SnapshotStoreError::StoreUnavailable {
            reason: "mutex poisoned".to_string(),
        },
    ];
    for variant in &variants {
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
fn in_memory_snapshot_store_is_send_and_sync() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<InMemorySnapshotStore>();
}

#[test]
fn snapshot_store_trait_object_is_send_and_sync() {
    fn assert_send_sync<T: Send + Sync + ?Sized>() {}
    assert_send_sync::<dyn SnapshotStore>();
}

#[test]
fn snapshot_store_codes_all_has_six_entries() {
    assert_eq!(codes::ALL.len(), 6);
}
