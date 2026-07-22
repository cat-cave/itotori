//! Snapshot-restore conformance check ().
//!
//! See [`SnapshotConformanceCheck`] for the wire shape and validation
//! rules. The check is engine-neutral: it carries two [`SnapshotRef`]s
//! (id-only) and resolves them through a [`SnapshotStore`] at `run`
//! time. No screenshot, frame, or renderer surface is involved at any
//! level of the check (audit-focus structural defense for the "snapshot
//! checks requiring renderer support" item).

use serde::{Deserialize, Serialize};

use crate::EvidenceTier;
use crate::conformance::ProfileId;
use crate::conformance::diagnostics::ConformanceError;
use crate::conformance::result::{EvidenceRef, ResultOutcome};
use crate::snapshot::{
    Snapshot, SnapshotRef, SnapshotStore, SnapshotStoreError, StateDiff, diff_snapshots,
};

/// Snapshot-restore conformance check.
///
/// Construction does NOT resolve or validate; the check carries refs
/// only. Call [`SnapshotConformanceCheck::run`] (with a
/// [`SnapshotStore`]) to resolve, diff, and produce the outcome.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotConformanceCheck {
    /// Always [`ProfileId::SnapshotRestore`] (validated by
    /// [`SnapshotConformanceCheck::validate`]).
    pub profile: ProfileId,
    /// Lightweight reference to the baseline snapshot. Resolved through
    /// the [`SnapshotStore`] at `run` time.
    pub baseline: SnapshotRef,
    /// Lightweight reference to the observed snapshot. Resolved through
    /// the [`SnapshotStore`] at `run` time.
    pub observed: SnapshotRef,
    /// Evidence tier the runner expects on a `Pass`. MUST satisfy
    /// `expected_tier <= ProfileId::SnapshotRestore.evidence_tier_ceiling()`
    /// (E1). The actual tier emitted on a Pass is the minimum of
    /// `expected_tier`, the baseline tier, and the observed tier so the
    /// runner cannot dress up a low-tier snapshot pair as a high-tier
    /// pass.
    pub expected_tier: EvidenceTier,
}

impl SnapshotConformanceCheck {
    /// Validate the check's structural rules. Returns the first
    /// failure; the validator does not accumulate a list of errors (one
    /// [`ConformanceError`] per call mirrors the result
    /// validator).
    pub fn validate(&self) -> Result<(), ConformanceError> {
        if self.profile != ProfileId::SnapshotRestore {
            return Err(ConformanceError::SnapshotCheckProfileMismatch {
                observed: self.profile,
                expected: ProfileId::SnapshotRestore,
            });
        }
        self.baseline
            .validate()
            .map_err(|err| ConformanceError::SnapshotRefInvalid {
                side: "baseline",
                reason: err.to_string(),
            })?;
        self.observed
            .validate()
            .map_err(|err| ConformanceError::SnapshotRefInvalid {
                side: "observed",
                reason: err.to_string(),
            })?;
        if self.baseline.inspectable_id != self.observed.inspectable_id {
            return Err(ConformanceError::SnapshotInspectableIdMismatch {
                baseline: self.baseline.inspectable_id.clone(),
                observed: self.observed.inspectable_id.clone(),
            });
        }
        let ceiling = ProfileId::SnapshotRestore.evidence_tier_ceiling();
        if self.expected_tier > ceiling {
            return Err(ConformanceError::SnapshotEvidenceTierOverclaim {
                observed: self.expected_tier,
                ceiling,
            });
        }
        Ok(())
    }

    /// Resolve both refs through the store, compute the diff, and
    /// project the outcome.
    ///
    /// Contract:
    ///
    /// - Validation failure on the check itself → `Fail` with the
    ///   matching semantic code.
    /// - Store error on either resolve → `Fail` with the store error's
    ///   semantic code; never `Pass`.
    /// - Substrate error on the diff → `Fail` with the substrate's
    ///   semantic code.
    /// - Empty diff → `Pass` at the minimum of the three tier sources
    ///   (`expected_tier`, baseline tier, observed tier).
    /// - Non-empty diff → `Fail` with
    ///   [`crate::snapshot::store::codes::STATE_DRIFT`]. The runner
    ///   pulls one [`EvidenceRef::StatePath`] entry per drifted path
    ///   via [`SnapshotConformanceCheck::state_path_evidence_from_diff`].
    pub fn run(&self, store: &dyn SnapshotStore) -> ResultOutcome {
        if let Err(err) = self.validate() {
            return ResultOutcome::Fail {
                semantic_code: err.semantic_code().to_string(),
                detail: err.to_string(),
            };
        }
        let baseline = match store.resolve(&self.baseline) {
            Ok(snapshot) => snapshot,
            Err(err) => return store_error_to_fail("baseline", &err),
        };
        let observed = match store.resolve(&self.observed) {
            Ok(snapshot) => snapshot,
            Err(err) => return store_error_to_fail("observed", &err),
        };
        let diff = match diff_snapshots(&baseline, &observed) {
            Ok(diff) => diff,
            Err(err) => {
                return ResultOutcome::Fail {
                    semantic_code: err.semantic_code().to_string(),
                    detail: err.to_string(),
                };
            }
        };
        if diff.is_empty() {
            return ResultOutcome::Pass {
                evidence_tier: self.tier_floor(&baseline, &observed),
            };
        }
        ResultOutcome::Fail {
            semantic_code: crate::snapshot::store::codes::STATE_DRIFT.to_string(),
            detail: format!("snapshot drift: {} path(s) differ", diff.changes.len()),
        }
    }

    /// Map every [`StateDiff::changed_paths`] entry to an
    /// [`EvidenceRef::StatePath`].
    ///
    /// The runner calls this after [`SnapshotConformanceCheck::run`]
    /// returns `Fail` with the
    /// [`crate::snapshot::store::codes::STATE_DRIFT`] code; the runner
    /// uses these to populate the [`crate::ConformanceResult::evidence`]
    /// vec. The diff's `changed_paths()` iterator is sorted (the diff
    /// validates the sort; the resulting evidence vec
    /// inherits the sort. This is the audit-focus defense for "state
    /// drift reported too vaguely": every drifted path is quoted
    /// verbatim, no summarization, no truncation.
    pub fn state_path_evidence_from_diff(diff: &StateDiff) -> Vec<EvidenceRef> {
        diff.changed_paths()
            .map(|path| EvidenceRef::StatePath {
                path: path.as_str().to_string(),
            })
            .collect()
    }

    /// Build a deterministic load-bearing [`EvidenceRef::StatePath`]
    /// from the baseline snapshot's first sorted path. The runner uses
    /// this on `Pass` so the [`crate::ConformanceResult`] envelope
    /// satisfies the "Pass without evidence" rejection.
    /// Returns `None` if the snapshot's state tree is empty (the
    /// substrate rejects this at construction time, so it should not
    /// occur in practice).
    pub fn pass_evidence_for(snapshot: &Snapshot) -> Option<EvidenceRef> {
        snapshot
            .state_tree()
            .paths()
            .next()
            .map(|path| EvidenceRef::StatePath {
                path: path.as_str().to_string(),
            })
    }

    fn tier_floor(&self, baseline: &Snapshot, observed: &Snapshot) -> EvidenceTier {
        self.expected_tier
            .min(baseline.evidence_tier())
            .min(observed.evidence_tier())
    }
}

fn store_error_to_fail(side: &'static str, err: &SnapshotStoreError) -> ResultOutcome {
    ResultOutcome::Fail {
        semantic_code: err.semantic_code().to_string(),
        detail: format!("{side}: {err}"),
    }
}

#[cfg(test)]
#[path = "check_tests.rs"]
mod tests;
