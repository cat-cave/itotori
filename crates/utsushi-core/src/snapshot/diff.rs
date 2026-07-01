//! Snapshot diff primitives.
//!
//! `diff_snapshots` produces a path-keyed [`StateDiff`] when two snapshots
//! disagree. Every change carries the full [`super::state::StatePath`] so the
//! conformance layer (UTSUSHI-028) can quote the path verbatim when it fails
//! a restore.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use super::diagnostics::SnapshotError;
use super::redaction::reject_unredacted_local_paths_in_value;
use super::snapshot::{SNAPSHOT_SCHEMA_VERSION, Snapshot, SnapshotId, SnapshotSchemaVersion};
use super::state::{StatePath, StateValue};

/// Path-keyed diff of two snapshots.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateDiff {
    pub schema_version: SnapshotSchemaVersion,
    pub left_snapshot_id: SnapshotId,
    pub right_snapshot_id: SnapshotId,
    pub inspectable_id: String,
    pub changes: Vec<StateChange>,
}

impl StateDiff {
    /// Whether the diff carries no changes.
    pub fn is_empty(&self) -> bool {
        self.changes.is_empty()
    }

    /// Iterate the changed paths in canonical (sorted) order.
    pub fn changed_paths(&self) -> impl Iterator<Item = &StatePath> {
        self.changes.iter().map(|change| &change.path)
    }

    /// Validate the diff shape: schema version pin, sorted changes,
    /// serialized form passes the local-path filter.
    pub fn validate(&self) -> Result<(), SnapshotError> {
        if self.schema_version.as_str() != SNAPSHOT_SCHEMA_VERSION {
            return Err(SnapshotError::SchemaVersionMismatch {
                observed: self.schema_version.as_str().to_string(),
                expected: SNAPSHOT_SCHEMA_VERSION,
            });
        }
        // Ensure sorted (deterministic) ordering: any two adjacent
        // changes must satisfy `prev.path < next.path`.
        for window in self.changes.windows(2) {
            if window[0].path >= window[1].path {
                return Err(SnapshotError::SerializationFailure {
                    reason: format!(
                        "state diff changes are not strictly sorted by path: {} >= {}",
                        window[0].path.as_str(),
                        window[1].path.as_str()
                    ),
                });
            }
        }
        let value =
            serde_json::to_value(self).map_err(|err| SnapshotError::SerializationFailure {
                reason: err.to_string(),
            })?;
        reject_unredacted_local_paths_in_value("", &value)?;
        Ok(())
    }
}

/// One change in a [`StateDiff`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateChange {
    pub path: StatePath,
    #[serde(flatten)]
    pub kind: StateChangeKind,
}

/// Typed kind of a single state change. The `Modified` variant carries both
/// values so downstream consumers can inspect either side.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StateChangeKind {
    /// Path is present in the `after` snapshot but absent in `before`.
    #[serde(rename_all = "camelCase")]
    Added { value: StateValue },
    /// Path is present in `before` but absent in `after`.
    #[serde(rename_all = "camelCase")]
    Removed { value: StateValue },
    /// Path exists on both sides but the value changed.
    #[serde(rename_all = "camelCase")]
    Modified { old: StateValue, new: StateValue },
}

/// Compute the path-keyed diff of two snapshots.
pub fn diff_snapshots(before: &Snapshot, after: &Snapshot) -> Result<StateDiff, SnapshotError> {
    if before.schema_version().as_str() != SNAPSHOT_SCHEMA_VERSION {
        return Err(SnapshotError::SchemaVersionMismatch {
            observed: before.schema_version().as_str().to_string(),
            expected: SNAPSHOT_SCHEMA_VERSION,
        });
    }
    if after.schema_version().as_str() != SNAPSHOT_SCHEMA_VERSION {
        return Err(SnapshotError::SchemaVersionMismatch {
            observed: after.schema_version().as_str().to_string(),
            expected: SNAPSHOT_SCHEMA_VERSION,
        });
    }
    if before.inspectable_id() != after.inspectable_id() {
        return Err(SnapshotError::DiffInspectableIdMismatch {
            left: before.inspectable_id().to_string(),
            right: after.inspectable_id().to_string(),
        });
    }

    let mut all_paths: BTreeSet<&StatePath> = BTreeSet::new();
    for path in before.state_tree().paths() {
        all_paths.insert(path);
    }
    for path in after.state_tree().paths() {
        all_paths.insert(path);
    }

    let mut changes = Vec::new();
    for path in all_paths {
        match (before.state_tree().get(path), after.state_tree().get(path)) {
            (Some(left), Some(right)) if left != right => {
                changes.push(StateChange {
                    path: path.clone(),
                    kind: StateChangeKind::Modified {
                        old: left.clone(),
                        new: right.clone(),
                    },
                });
            }
            (Some(_), Some(_)) => {}
            (None, Some(right)) => {
                changes.push(StateChange {
                    path: path.clone(),
                    kind: StateChangeKind::Added {
                        value: right.clone(),
                    },
                });
            }
            (Some(left), None) => {
                changes.push(StateChange {
                    path: path.clone(),
                    kind: StateChangeKind::Removed {
                        value: left.clone(),
                    },
                });
            }
            (None, None) => unreachable!("path must come from at least one tree"),
        }
    }

    let diff = StateDiff {
        schema_version: SnapshotSchemaVersion::current(),
        left_snapshot_id: before.snapshot_id().clone(),
        right_snapshot_id: after.snapshot_id().clone(),
        inspectable_id: before.inspectable_id().to_string(),
        changes,
    };
    diff.validate()?;
    Ok(diff)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EvidenceTier;
    use crate::snapshot::inspectable::Inspectable;
    use crate::snapshot::snapshot::{SnapshotRequest, take_snapshot};
    use crate::snapshot::state::{StatePath, StateTree, StateValue};

    struct ConfigurablePort {
        tree: StateTree,
    }
    impl Inspectable for ConfigurablePort {
        fn inspectable_id(&self) -> &'static str {
            "utsushi-fixture"
        }
        fn inspect_state(&self) -> Result<StateTree, SnapshotError> {
            Ok(self.tree.clone())
        }
    }

    fn base_tree() -> StateTree {
        let mut tree = StateTree::new();
        tree.insert(
            StatePath::parse("port.frame").expect("p"),
            StateValue::Uint { value: 1 },
        )
        .expect("insert");
        tree.insert(
            StatePath::parse("metadata.adapter_name").expect("p"),
            StateValue::String {
                value: "fixture".to_string(),
            },
        )
        .expect("insert");
        tree
    }

    fn take(port: &ConfigurablePort, tick: u64) -> Snapshot {
        let request = SnapshotRequest::new("run-001", "2026-06-23T00:00:00Z", EvidenceTier::E2)
            .with_tick(tick);
        take_snapshot(port, &request).expect("snapshot")
    }

    #[test]
    fn diff_of_equal_snapshots_is_empty() {
        let port = ConfigurablePort { tree: base_tree() };
        let a = take(&port, 1);
        let b = take(&port, 1);
        let diff = diff_snapshots(&a, &b).expect("diff");
        assert!(diff.is_empty());
        assert_eq!(diff.changes.len(), 0);
    }

    #[test]
    fn diff_identifies_changed_path_for_single_int_modification() {
        let port_a = ConfigurablePort { tree: base_tree() };
        // Build tree_b mirroring tree_a but with port.frame replaced.
        // BTreeMap's `insert` errors on duplicate so we construct fresh.
        let mut tree_b = StateTree::new();
        for (path, value) in base_tree().iter() {
            let cloned_value = if path.as_str() == "port.frame" {
                StateValue::Uint { value: 99 }
            } else {
                value.clone()
            };
            tree_b.insert(path.clone(), cloned_value).expect("insert");
        }
        let port_b = ConfigurablePort { tree: tree_b };
        let snap_a = take(&port_a, 1);
        let snap_b = take(&port_b, 2);
        // The two snapshots share inspectable_id; tick only affects id.
        let diff = diff_snapshots(&snap_a, &snap_b).expect("diff");
        assert_eq!(diff.changes.len(), 1);
        let change = &diff.changes[0];
        assert_eq!(change.path.as_str(), "port.frame");
        match &change.kind {
            StateChangeKind::Modified { old, new } => {
                assert_eq!(*old, StateValue::Uint { value: 1 });
                assert_eq!(*new, StateValue::Uint { value: 99 });
            }
            other => panic!("expected Modified, got {other:?}"),
        }
    }

    #[test]
    fn diff_identifies_added_path_when_after_has_new_value() {
        let port_a = ConfigurablePort { tree: base_tree() };
        let mut tree_b = base_tree();
        tree_b
            .insert(
                StatePath::parse("port.new_field").expect("p"),
                StateValue::Bool { value: true },
            )
            .expect("insert");
        let port_b = ConfigurablePort { tree: tree_b };
        let snap_a = take(&port_a, 1);
        let snap_b = take(&port_b, 2);
        let diff = diff_snapshots(&snap_a, &snap_b).expect("diff");
        assert_eq!(diff.changes.len(), 1);
        assert_eq!(diff.changes[0].path.as_str(), "port.new_field");
        assert!(matches!(
            diff.changes[0].kind,
            StateChangeKind::Added { .. }
        ));
    }

    #[test]
    fn diff_identifies_removed_path_when_after_drops_value() {
        let mut tree_a = base_tree();
        tree_a
            .insert(
                StatePath::parse("port.extra").expect("p"),
                StateValue::Bool { value: true },
            )
            .expect("insert");
        let port_a = ConfigurablePort { tree: tree_a };
        let port_b = ConfigurablePort { tree: base_tree() };
        let snap_a = take(&port_a, 1);
        let snap_b = take(&port_b, 2);
        let diff = diff_snapshots(&snap_a, &snap_b).expect("diff");
        assert_eq!(diff.changes.len(), 1);
        assert_eq!(diff.changes[0].path.as_str(), "port.extra");
        assert!(matches!(
            diff.changes[0].kind,
            StateChangeKind::Removed { .. }
        ));
    }

    #[test]
    fn diff_with_mismatched_inspectable_id_returns_typed_error() {
        struct PortA;
        impl Inspectable for PortA {
            fn inspectable_id(&self) -> &'static str {
                "port-a"
            }
            fn inspect_state(&self) -> Result<StateTree, SnapshotError> {
                Ok(base_tree())
            }
        }
        struct PortB;
        impl Inspectable for PortB {
            fn inspectable_id(&self) -> &'static str {
                "port-b"
            }
            fn inspect_state(&self) -> Result<StateTree, SnapshotError> {
                Ok(base_tree())
            }
        }
        let req =
            SnapshotRequest::new("run-001", "2026-06-23T00:00:00Z", EvidenceTier::E2).with_tick(1);
        let snap_a = take_snapshot(&PortA, &req).expect("a");
        let snap_b = take_snapshot(&PortB, &req).expect("b");
        let err = diff_snapshots(&snap_a, &snap_b).expect_err("mismatch");
        assert!(matches!(
            err,
            SnapshotError::DiffInspectableIdMismatch { .. }
        ));
    }

    #[test]
    fn diff_changes_are_sorted_by_path_string() {
        // Build trees so that the diff would otherwise emit changes in
        // insertion order, then assert the result is sorted.
        let mut tree_a = StateTree::new();
        tree_a
            .insert(
                StatePath::parse("port.z").expect("p"),
                StateValue::Int { value: 1 },
            )
            .expect("insert");
        tree_a
            .insert(
                StatePath::parse("port.a").expect("p"),
                StateValue::Int { value: 1 },
            )
            .expect("insert");
        let port_a = ConfigurablePort { tree: tree_a };
        let port_b = ConfigurablePort {
            tree: {
                let mut tree = StateTree::new();
                tree.insert(
                    StatePath::parse("port.frame").expect("p"),
                    StateValue::Uint { value: 1 },
                )
                .expect("insert");
                tree
            },
        };
        let snap_a = take(&port_a, 1);
        let snap_b = take(&port_b, 2);
        let diff = diff_snapshots(&snap_a, &snap_b).expect("diff");
        let paths: Vec<&str> = diff
            .changes
            .iter()
            .map(|change| change.path.as_str())
            .collect();
        let mut sorted = paths.clone();
        sorted.sort_unstable();
        assert_eq!(paths, sorted);
    }

    #[test]
    fn diff_serialized_form_passes_reject_unredacted_local_paths() {
        let mut tree_a = base_tree();
        tree_a
            .insert(
                StatePath::parse("metadata.run_id").expect("p"),
                StateValue::String {
                    value: "deterministic".to_string(),
                },
            )
            .expect("insert");
        let port_a = ConfigurablePort { tree: tree_a };
        let mut tree_b = base_tree();
        tree_b
            .insert(
                StatePath::parse("metadata.run_id").expect("p"),
                StateValue::String {
                    value: "deterministic-v2".to_string(),
                },
            )
            .expect("insert");
        let port_b = ConfigurablePort { tree: tree_b };
        let snap_a = take(&port_a, 1);
        let snap_b = take(&port_b, 2);
        let diff = diff_snapshots(&snap_a, &snap_b).expect("diff");
        let value = serde_json::to_value(&diff).expect("to value");
        reject_unredacted_local_paths_in_value("", &value).expect("clean");
    }

    #[test]
    fn diff_modified_kind_carries_both_old_and_new_values_for_typed_inspection() {
        let tree_a = base_tree();
        let mut tree_b = StateTree::new();
        // Build tree_b mirroring tree_a but with port.frame replaced.
        for (path, value) in tree_a.iter() {
            let cloned = if path.as_str() == "port.frame" {
                StateValue::Uint { value: 5 }
            } else {
                value.clone()
            };
            tree_b.insert(path.clone(), cloned).expect("insert");
        }
        let port_a = ConfigurablePort {
            tree: tree_a.clone(),
        };
        let port_b = ConfigurablePort { tree: tree_b };
        let snap_a = take(&port_a, 1);
        let snap_b = take(&port_b, 2);
        let diff = diff_snapshots(&snap_a, &snap_b).expect("diff");
        let change = diff
            .changes
            .iter()
            .find(|change| change.path.as_str() == "port.frame")
            .expect("found");
        match &change.kind {
            StateChangeKind::Modified { old, new } => {
                assert_eq!(old.type_tag(), "uint");
                assert_eq!(new.type_tag(), "uint");
            }
            other => panic!("expected Modified, got {other:?}"),
        }
        let _ = tree_a;
    }
}
