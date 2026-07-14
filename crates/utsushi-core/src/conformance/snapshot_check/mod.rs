//! Snapshot-restore runtime conformance check ().
//!
//! Sibling to [`crate::conformance::trace_branch`] () and
//! [`crate::conformance::capture_recording`] (). The module
//! ships the per-profile shape, validator, semantic codes, and `run`
//! helper for the [`crate::conformance::ProfileId::SnapshotRestore`]
//! profile, plus an `Unsupported` outcome helper for the path the runner
//! takes when the adapter's manifest does NOT declare the profile.
//!
//! ## Shape
//!
//! - [`check::SnapshotConformanceCheck`] — carries
//!   [`crate::SnapshotRef`] handles to the baseline and observed
//!   snapshots plus the expected evidence tier. Construction does NOT
//!   resolve or validate; call
//!   [`check::SnapshotConformanceCheck::validate`] for the structural
//!   rules and [`check::SnapshotConformanceCheck::run`] to project the
//!   validation + diff into a [`crate::conformance::ResultOutcome`].
//! - [`crate::snapshot::SnapshotStore`] (defined under
//!   [`crate::snapshot::store`]) — resolution layer for the
//!   [`crate::SnapshotRef`] handles, with typed errors only.
//!
//! ## Stable codes
//!
//! See [`codes`]. The seven codes registered here are also wired into
//! [`crate::conformance::diagnostics::codes::ALL`] so the single global
//! registry stays single-sourced. The actual state-drift code
//! (`utsushi.snapshot.state_drift`) lives in
//! [`crate::snapshot::store::codes`] because the *evidence* is a
//! state-drift report from the substrate, even though the *outcome* is
//! a conformance Fail.
//!
//! ## Unsupported handling
//!
//! Missing snapshot support is reported as
//! [`crate::conformance::ResultOutcome::Unsupported`] with the
//! [`codes::SNAPSHOT_RESTORE_UNSUPPORTED`] semantic code; the runner
//! does NOT call the check struct in that path. See
//! [`unsupported_snapshot_restore_result`].

pub mod check;
pub mod codes;

pub use check::SnapshotConformanceCheck;

use crate::conformance::result::ResultOutcome;

/// Build the `Unsupported` outcome the runner emits when the adapter's
/// manifest does NOT declare
/// [`crate::conformance::ProfileId::SnapshotRestore`].
///
/// Carries [`codes::SNAPSHOT_RESTORE_UNSUPPORTED`] and
/// `declared_in_manifest = false` so the cross-validator in
/// [`crate::conformance::cross_validate_results_against_manifest`]
/// accepts it.
pub fn unsupported_snapshot_restore_result() -> ResultOutcome {
    ResultOutcome::Unsupported {
        semantic_code: codes::SNAPSHOT_RESTORE_UNSUPPORTED.to_string(),
        declared_in_manifest: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conformance::diagnostics;

    /// Asserts every code introduced by this slice is also registered in
    /// the global [`crate::conformance::diagnostics::codes::ALL`].
    /// Catches a missing additive entry the moment it lands.
    #[test]
    fn snapshot_check_codes_all_present_in_conformance_diagnostics_all() {
        let registry: std::collections::HashSet<&'static str> =
            diagnostics::codes::ALL.iter().copied().collect();
        for code in codes::ALL {
            assert!(
                registry.contains(code),
                "code {code} missing from conformance::diagnostics::codes::ALL"
            );
        }
    }

    #[test]
    fn unsupported_snapshot_restore_result_carries_the_documented_semantic_code() {
        match unsupported_snapshot_restore_result() {
            ResultOutcome::Unsupported {
                semantic_code,
                declared_in_manifest,
            } => {
                assert_eq!(semantic_code, codes::SNAPSHOT_RESTORE_UNSUPPORTED);
                assert!(!declared_in_manifest);
            }
            other => panic!("expected Unsupported, got {other:?}"),
        }
    }
}
