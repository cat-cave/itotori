//! Snapshot resolution trait (UTSUSHI-028).
//!
//! [`SnapshotStore`] is the resolution layer for
//! [`crate::RuntimeRequest::snapshot`]: a [`super::SnapshotRef`]
//! (lightweight, id-only) becomes a fully validated [`super::Snapshot`].
//! The audit-focus item the trait defends against is "silent stale or
//! empty payload" — every error is typed; the trait has no
//! `Result<Option<Snapshot>, _>` shape and no documented best-effort
//! branch.
//!
//! [`InMemorySnapshotStore`] is a stateful in-memory implementation used
//! by the synthetic fixtures and integration tests. Engine ports (out of
//! scope for this slice) implement the trait against their own backing
//! stores (artifact bundles, controlled-playback session logs); both
//! implementations share the same typed-error surface.

use std::collections::BTreeMap;
use std::fmt;
use std::sync::{Arc, Mutex};

use super::diagnostics::SnapshotError;
use super::snapshot::{SNAPSHOT_SCHEMA_VERSION, Snapshot, SnapshotId, SnapshotRef};

/// Stable Utsushi snapshot-store semantic codes.
pub mod codes {
    pub const STORE_NOT_FOUND: &str = "utsushi.snapshot.store_not_found";
    pub const STORE_MISMATCHED_SCHEMA_VERSION: &str =
        "utsushi.snapshot.store_mismatched_schema_version";
    pub const STORE_INVALID_SNAPSHOT_REF: &str = "utsushi.snapshot.store_invalid_snapshot_ref";
    pub const STORE_INSPECTABLE_ID_MISMATCH: &str =
        "utsushi.snapshot.store_inspectable_id_mismatch";
    pub const STORE_UNAVAILABLE: &str = "utsushi.snapshot.store_unavailable";
    pub const STATE_DRIFT: &str = "utsushi.snapshot.state_drift";

    /// Full set of additive UTSUSHI-028 codes (store + state-drift). The
    /// snapshot substrate's full code registry is in
    /// [`super::super::diagnostics::codes::ALL`].
    pub const ALL: &[&str] = &[
        STORE_NOT_FOUND,
        STORE_MISMATCHED_SCHEMA_VERSION,
        STORE_INVALID_SNAPSHOT_REF,
        STORE_INSPECTABLE_ID_MISMATCH,
        STORE_UNAVAILABLE,
        STATE_DRIFT,
    ];
}

/// Typed error variants the [`SnapshotStore`] surface emits. Every
/// failure is a named variant; the trait has no documented best-effort
/// branch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SnapshotStoreError {
    /// No snapshot matches the requested id. The ref is well-formed;
    /// the store simply does not hold it.
    NotFound { snapshot_id: SnapshotId },

    /// A stored payload exists at the id but its schema version does
    /// not match the substrate pin.
    MismatchedSchemaVersion {
        snapshot_id: SnapshotId,
        observed: String,
        expected: &'static str,
    },

    /// [`SnapshotRef::validate`] rejected the input ref. Wraps the
    /// underlying [`SnapshotError`] for the reviewer to inspect.
    InvalidSnapshotRef { reason: SnapshotError },

    /// A stored payload exists at the requested id but its
    /// `inspectable_id` does not match the ref's `inspectable_id`. The
    /// ref pointed at the right id but the wrong port.
    InspectableIdMismatch {
        snapshot_id: SnapshotId,
        expected: String,
        found: String,
    },

    /// Backing store unavailable (lock poison, I/O failure, etc.).
    /// Carries a short, public-string description; never a host path.
    StoreUnavailable { reason: String },
}

impl SnapshotStoreError {
    /// Stable `utsushi.snapshot.*` semantic code for this variant.
    pub fn semantic_code(&self) -> &'static str {
        match self {
            Self::NotFound { .. } => codes::STORE_NOT_FOUND,
            Self::MismatchedSchemaVersion { .. } => codes::STORE_MISMATCHED_SCHEMA_VERSION,
            Self::InvalidSnapshotRef { .. } => codes::STORE_INVALID_SNAPSHOT_REF,
            Self::InspectableIdMismatch { .. } => codes::STORE_INSPECTABLE_ID_MISMATCH,
            Self::StoreUnavailable { .. } => codes::STORE_UNAVAILABLE,
        }
    }
}

impl fmt::Display for SnapshotStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = self.semantic_code();
        match self {
            Self::NotFound { snapshot_id } => {
                write!(formatter, "{code}: snapshot_id={}", snapshot_id.as_str())
            }
            Self::MismatchedSchemaVersion {
                snapshot_id,
                observed,
                expected,
            } => write!(
                formatter,
                "{code}: snapshot_id={} observed={observed} expected={expected}",
                snapshot_id.as_str()
            ),
            Self::InvalidSnapshotRef { reason } => {
                write!(formatter, "{code}: reason={reason}")
            }
            Self::InspectableIdMismatch {
                snapshot_id,
                expected,
                found,
            } => write!(
                formatter,
                "{code}: snapshot_id={} expected={expected} found={found}",
                snapshot_id.as_str()
            ),
            Self::StoreUnavailable { reason } => {
                write!(formatter, "{code}: reason={reason}")
            }
        }
    }
}

impl std::error::Error for SnapshotStoreError {}

/// Resolution layer for [`crate::RuntimeRequest::snapshot`]
/// ([`Option<SnapshotRef>`]).
///
/// The store is the single substrate seam at which a [`SnapshotRef`]
/// (lightweight, id-only) becomes a fully validated [`Snapshot`]. The
/// audit-focus item the trait defends against is "silent stale or empty
/// payload": every error is typed; the trait has no
/// `Result<Option<Snapshot>, _>` shape and no documented best-effort
/// branch.
///
/// Contract for [`SnapshotStore::resolve`]:
///
/// - Returns `Ok(snapshot)` only when
///   `snapshot.validate()` succeeds AND
///   `snapshot.snapshot_id() == reference.snapshot_id` AND
///   `snapshot.inspectable_id() == reference.inspectable_id` AND
///   `snapshot.schema_version().as_str() == SNAPSHOT_SCHEMA_VERSION`.
/// - Returns `Err(SnapshotStoreError::NotFound { snapshot_id })` when no
///   snapshot matches the requested id (NEVER a stale payload, NEVER an
///   empty [`Snapshot`]).
/// - Returns `Err(SnapshotStoreError::MismatchedSchemaVersion { ... })`
///   when a stored payload exists but its `schema_version` does not
///   match the pin.
/// - Returns `Err(SnapshotStoreError::InvalidSnapshotRef { ... })` when
///   [`SnapshotRef::validate`] fails.
/// - Returns `Err(SnapshotStoreError::InspectableIdMismatch { ... })`
///   when a stored payload exists at the id but its inspectable id
///   diverges from the ref.
/// - Returns `Err(SnapshotStoreError::StoreUnavailable { ... })` on
///   backing-store failures (I/O, lock poison, etc.); never silently
///   returns success.
///
/// `Send + Sync` because the runner shares the store across threads
/// (the synthetic in-memory implementation uses an `Arc<Mutex<_>>`
/// internally; engine-port implementations may use a different sync
/// primitive but must remain `Send + Sync`).
pub trait SnapshotStore: Send + Sync + fmt::Debug {
    /// Resolve a snapshot ref to a fully validated snapshot. See the
    /// trait docs for the contract.
    fn resolve(&self, reference: &SnapshotRef) -> Result<Snapshot, SnapshotStoreError>;
}

/// Stateful in-memory snapshot store backing the synthetic fixtures and
/// integration tests. Stores [`Snapshot`]s keyed by [`SnapshotId`];
/// resolution is `O(log n)`. Internally uses an
/// [`Arc<Mutex<BTreeMap<_, _>>>`] so the store is `Send + Sync` and
/// cheap to clone.
#[derive(Clone, Default)]
pub struct InMemorySnapshotStore {
    inner: Arc<Mutex<BTreeMap<SnapshotId, Snapshot>>>,
}

impl fmt::Debug for InMemorySnapshotStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let len = self
            .inner
            .lock()
            .map(|guard| guard.len())
            .unwrap_or_default();
        formatter
            .debug_struct("InMemorySnapshotStore")
            .field("len", &len)
            .finish()
    }
}

impl InMemorySnapshotStore {
    /// Construct an empty store.
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert a snapshot, returning the previously stored snapshot at
    /// the same id if any (so callers can detect overwrites). Validates
    /// the snapshot end-to-end before insertion; rejects payloads that
    /// would otherwise round-trip as `MismatchedSchemaVersion`.
    pub fn insert(&self, snapshot: Snapshot) -> Result<Option<Snapshot>, SnapshotStoreError> {
        snapshot.validate().map_err(|err| match err {
            SnapshotError::SchemaVersionMismatch { observed, expected } => {
                SnapshotStoreError::MismatchedSchemaVersion {
                    snapshot_id: snapshot.snapshot_id().clone(),
                    observed,
                    expected,
                }
            }
            other => SnapshotStoreError::InvalidSnapshotRef { reason: other },
        })?;
        let mut guard = self.lock_inner()?;
        let key = snapshot.snapshot_id().clone();
        Ok(guard.insert(key, snapshot))
    }

    /// Number of snapshots currently stored. Returns `0` if the lock is
    /// poisoned (callers that need the typed `StoreUnavailable` should
    /// route through [`SnapshotStore::resolve`] instead).
    pub fn len(&self) -> usize {
        self.inner.lock().map_or(0, |guard| guard.len())
    }

    /// Whether the store contains no snapshots.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn lock_inner(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, BTreeMap<SnapshotId, Snapshot>>, SnapshotStoreError> {
        self.inner
            .lock()
            .map_err(|_| SnapshotStoreError::StoreUnavailable {
                reason: "in-memory snapshot store mutex poisoned".to_string(),
            })
    }
}

impl SnapshotStore for InMemorySnapshotStore {
    fn resolve(&self, reference: &SnapshotRef) -> Result<Snapshot, SnapshotStoreError> {
        if let Err(err) = reference.validate() {
            return Err(SnapshotStoreError::InvalidSnapshotRef { reason: err });
        }
        let guard = self.lock_inner()?;
        let snapshot = guard.get(&reference.snapshot_id).cloned().ok_or_else(|| {
            SnapshotStoreError::NotFound {
                snapshot_id: reference.snapshot_id.clone(),
            }
        })?;
        drop(guard);

        if snapshot.schema_version().as_str() != SNAPSHOT_SCHEMA_VERSION {
            return Err(SnapshotStoreError::MismatchedSchemaVersion {
                snapshot_id: reference.snapshot_id.clone(),
                observed: snapshot.schema_version().as_str().to_string(),
                expected: SNAPSHOT_SCHEMA_VERSION,
            });
        }
        if snapshot.inspectable_id() != reference.inspectable_id {
            return Err(SnapshotStoreError::InspectableIdMismatch {
                snapshot_id: reference.snapshot_id.clone(),
                expected: reference.inspectable_id.clone(),
                found: snapshot.inspectable_id().to_string(),
            });
        }
        snapshot
            .validate()
            .map_err(|err| SnapshotStoreError::InvalidSnapshotRef { reason: err })?;
        Ok(snapshot)
    }
}

#[cfg(test)]
mod tests {
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
    fn in_memory_snapshot_store_resolve_returns_inspectable_id_mismatch_when_ref_targets_wrong_port()
     {
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
}
