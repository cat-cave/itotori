//! Inspectable / Restorable port traits.
//!
//! Engine ports implement [`Inspectable`] to expose their controlled-playback
//! state into the snapshot substrate. Restoration is a separate trait so a
//! port that can expose state but cannot restore it surfaces a typed
//! `SnapshotError::RestoreUnsupported`, never a silent best-effort.

use super::diagnostics::SnapshotError;
use super::state::{StatePath, StateTree};

/// Engine ports implement `Inspectable` to expose their inspectable state
/// into the snapshot substrate. The trait is read-only on `&self` for the
/// inspection side; restoration is a separate trait so a port that can
/// expose state but cannot restore it surfaces typed
/// [`SnapshotError::RestoreUnsupported`].
pub trait Inspectable: Send + Sync {
    /// Stable identifier of the inspectable surface (e.g.
    /// `"utsushi-fixture"`, `"utsushi-reallive"`). Used by `Snapshot`
    /// metadata so two snapshots from different ports cannot be
    /// accidentally diffed.
    fn inspectable_id(&self) -> &'static str;

    /// Read the port's current state into a `StateTree`. Implementors
    /// MUST NOT include host paths, raw asset bytes, or process / thread
    /// identifiers; the substrate's `StateValue::Bytes` requires a hash
    /// so opaque blobs are addressable but not mirrored. The runner
    /// re-validates the produced `StateTree`.
    fn inspect_state(&self) -> Result<StateTree, SnapshotError>;
}

/// Audit-focus report produced by a successful `Restorable::restore_state`
/// call. A port either consumes a path, declares it ignored on purpose, or
/// returns a typed error. There is no third option — the `consumed_paths` /
/// `ignored_by_design` split is the "silent best effort" mitigation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RestoreReport {
    /// Paths the port consumed during restoration.
    pub consumed_paths: Vec<StatePath>,
    /// Paths the port explicitly ignored on purpose. Carrying these in the
    /// report keeps "silent best effort" structurally impossible: the
    /// runner can assert no unexpected ignore.
    pub ignored_by_design: Vec<StatePath>,
}

impl RestoreReport {
    /// Construct an empty report (no paths consumed, no paths ignored).
    pub fn empty() -> Self {
        Self {
            consumed_paths: Vec::new(),
            ignored_by_design: Vec::new(),
        }
    }
}

/// Separate trait for ports that can restore. A port that implements
/// `Inspectable` but not `Restorable` declares the inspect-only posture
/// explicitly.
pub trait Restorable: Inspectable {
    /// Restore the port to the supplied state tree.
    ///
    /// Implementors MUST:
    /// - Validate that every consumed `StatePath` belongs to a known
    ///   namespace they own. Unknown paths return
    ///   [`SnapshotError::RestoreStatePathUnknown`].
    /// - Validate that every consumed value's type matches the port's
    ///   expectation; mismatch returns
    ///   [`SnapshotError::RestoreTypeMismatch`].
    /// - Reject out-of-range or invalid values with
    ///   [`SnapshotError::RestoreValueOutOfRange`].
    /// - Never silently skip a path; every path is either consumed,
    ///   ignored-by-design (must show up in
    ///   [`RestoreReport::ignored_by_design`]), or rejected.
    fn restore_state(&mut self, state: &StateTree) -> Result<RestoreReport, SnapshotError>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::snapshot::state::StateValue;

    struct InspectOnly;
    impl Inspectable for InspectOnly {
        fn inspectable_id(&self) -> &'static str {
            "inspect-only-test"
        }
        fn inspect_state(&self) -> Result<StateTree, SnapshotError> {
            let mut tree = StateTree::new();
            tree.insert(
                StatePath::parse("port.frame").expect("path"),
                StateValue::Uint { value: 1 },
            )?;
            Ok(tree)
        }
    }

    #[test]
    fn inspect_only_port_returns_valid_state_tree() {
        let port = InspectOnly;
        let tree = port.inspect_state().expect("state");
        assert_eq!(tree.len(), 1);
    }

    #[test]
    fn restore_report_empty_is_actually_empty() {
        let report = RestoreReport::empty();
        assert!(report.consumed_paths.is_empty());
        assert!(report.ignored_by_design.is_empty());
    }

    #[test]
    fn inspectable_trait_is_object_safe_through_dyn_reference() {
        let port: &dyn Inspectable = &InspectOnly;
        assert_eq!(port.inspectable_id(), "inspect-only-test");
    }
}
