//! Snapshot resolution trait ().
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

    /// Full set of additive codes (store + state-drift). The
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
/// - Returns `Err(SnapshotStoreError::MismatchedSchemaVersion {... })`
///   when a stored payload exists but its `schema_version` does not
///   match the pin.
/// - Returns `Err(SnapshotStoreError::InvalidSnapshotRef {... })` when
///   [`SnapshotRef::validate`] fails.
/// - Returns `Err(SnapshotStoreError::InspectableIdMismatch {... })`
///   when a stored payload exists at the id but its inspectable id
///   diverges from the ref.
/// - Returns `Err(SnapshotStoreError::StoreUnavailable {... })` on
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
#[path = "store_tests.rs"]
mod tests;
