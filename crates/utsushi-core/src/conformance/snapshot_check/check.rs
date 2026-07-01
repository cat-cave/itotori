//! Snapshot-restore conformance check (UTSUSHI-028).
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
    /// [`ConformanceError`] per call mirrors the UTSUSHI-026 result
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
    /// validates the sort per UTSUSHI-023); the resulting evidence vec
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
    /// satisfies the UTSUSHI-026 "Pass without evidence" rejection.
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
mod tests {
    use super::super::codes;
    use super::*;
    use crate::snapshot::diagnostics::codes as snapshot_codes;
    use crate::snapshot::inspectable::Inspectable;
    use crate::snapshot::snapshot::{SnapshotRequest, take_snapshot};
    use crate::snapshot::state::{StatePath, StateTree, StateValue};
    use crate::snapshot::{
        InMemorySnapshotStore, SnapshotError, SnapshotId, SnapshotSchemaVersion,
    };

    const INSPECTABLE_ID: &str = "utsushi-fixture";

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

    fn tree_with_frame(frame: u64) -> StateTree {
        let mut tree = StateTree::new();
        tree.insert(
            StatePath::parse("port.frame").expect("path"),
            StateValue::Uint { value: frame },
        )
        .expect("insert");
        tree
    }

    fn tree_with_frame_and_last(frame: u64, last: &str) -> StateTree {
        let mut tree = tree_with_frame(frame);
        tree.insert(
            StatePath::parse("port.last").expect("path"),
            StateValue::String {
                value: last.to_string(),
            },
        )
        .expect("insert");
        tree
    }

    fn snapshot_with(snapshot_id: &str, tree: StateTree) -> Snapshot {
        let port = DummyInspect {
            id: INSPECTABLE_ID,
            tree,
        };
        let request = SnapshotRequest::new("run-001", "2026-06-23T00:00:00Z", EvidenceTier::E1)
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

    fn populated_store(baseline: &Snapshot, observed: &Snapshot) -> InMemorySnapshotStore {
        let store = InMemorySnapshotStore::new();
        store.insert(baseline.clone()).expect("insert baseline");
        store.insert(observed.clone()).expect("insert observed");
        store
    }

    fn baseline_check(baseline: &Snapshot, observed: &Snapshot) -> SnapshotConformanceCheck {
        SnapshotConformanceCheck {
            profile: ProfileId::SnapshotRestore,
            baseline: ref_for(baseline),
            observed: ref_for(observed),
            expected_tier: EvidenceTier::E1,
        }
    }

    #[test]
    fn snapshot_conformance_check_round_trips_through_serde_json() {
        let baseline = snapshot_with("snap-baseline-001", tree_with_frame(1));
        let observed = snapshot_with("snap-observed-001", tree_with_frame(1));
        let check = baseline_check(&baseline, &observed);
        let value = serde_json::to_value(&check).expect("serializes");
        let restored: SnapshotConformanceCheck =
            serde_json::from_value(value).expect("deserializes");
        assert_eq!(restored, check);
    }

    #[test]
    fn snapshot_conformance_check_serializes_with_camel_case() {
        let baseline = snapshot_with("snap-baseline-001", tree_with_frame(1));
        let observed = snapshot_with("snap-observed-001", tree_with_frame(1));
        let check = baseline_check(&baseline, &observed);
        let value = serde_json::to_value(&check).expect("serializes");
        let object = value.as_object().expect("object");
        for key in ["profile", "baseline", "observed", "expectedTier"] {
            assert!(
                object.contains_key(key),
                "expected camelCase key {key} in {value:?}"
            );
        }
    }

    #[test]
    fn snapshot_restore_profile_required_subsystems_does_not_include_frame_sink_or_artifact_store()
    {
        let required = ProfileId::SnapshotRestore.required_subsystems();
        assert!(
            !required.contains(&crate::conformance::SubsystemRequirement::FrameSink),
            "snapshot conformance must not require FrameSink"
        );
        assert!(
            !required.contains(&crate::conformance::SubsystemRequirement::ArtifactStore),
            "snapshot conformance must not require ArtifactStore"
        );
        assert!(
            required.contains(&crate::conformance::SubsystemRequirement::SnapshotPrimitives),
            "snapshot conformance must require SnapshotPrimitives"
        );
    }

    #[test]
    fn snapshot_restore_profile_evidence_tier_ceiling_is_e1() {
        assert_eq!(
            ProfileId::SnapshotRestore.evidence_tier_ceiling(),
            EvidenceTier::E1
        );
    }

    #[test]
    fn snapshot_conformance_check_validates_well_formed_baseline_and_observed_refs() {
        let baseline = snapshot_with("snap-baseline-001", tree_with_frame(1));
        let observed = snapshot_with("snap-observed-001", tree_with_frame(1));
        baseline_check(&baseline, &observed)
            .validate()
            .expect("validates");
    }

    #[test]
    fn snapshot_conformance_check_runs_pass_on_identical_baseline_and_observed() {
        let baseline = snapshot_with("snap-baseline-001", tree_with_frame(1));
        let observed = snapshot_with("snap-observed-001", tree_with_frame(1));
        let store = populated_store(&baseline, &observed);
        let outcome = baseline_check(&baseline, &observed).run(&store);
        match outcome {
            ResultOutcome::Pass { evidence_tier } => assert_eq!(evidence_tier, EvidenceTier::E1),
            other => panic!("expected Pass, got {other:?}"),
        }
    }

    #[test]
    fn snapshot_conformance_check_pass_tier_clamps_to_minimum_of_three_tier_sources() {
        // Lower the observed snapshot's tier to E0 so the clamp picks
        // E0, regardless of `expected_tier`.
        let baseline = snapshot_with("snap-baseline-001", tree_with_frame(1));
        let port = DummyInspect {
            id: INSPECTABLE_ID,
            tree: tree_with_frame(1),
        };
        let request = SnapshotRequest::new("run-001", "2026-06-23T00:00:00Z", EvidenceTier::E0)
            .with_snapshot_id(SnapshotId::parse("snap-observed-001").expect("id"));
        let observed = take_snapshot(&port, &request).expect("e0 snapshot");
        let store = populated_store(&baseline, &observed);
        let check = SnapshotConformanceCheck {
            profile: ProfileId::SnapshotRestore,
            baseline: ref_for(&baseline),
            observed: ref_for(&observed),
            expected_tier: EvidenceTier::E1,
        };
        let outcome = check.run(&store);
        match outcome {
            ResultOutcome::Pass { evidence_tier } => assert_eq!(evidence_tier, EvidenceTier::E0),
            other => panic!("expected Pass, got {other:?}"),
        }
    }

    #[test]
    fn snapshot_conformance_check_rejects_wrong_profile() {
        let baseline = snapshot_with("snap-baseline-001", tree_with_frame(1));
        let observed = snapshot_with("snap-observed-001", tree_with_frame(1));
        let mut check = baseline_check(&baseline, &observed);
        check.profile = ProfileId::TextTrace;
        let err = check.validate().expect_err("wrong profile");
        assert!(matches!(
            err,
            ConformanceError::SnapshotCheckProfileMismatch { .. }
        ));
        assert_eq!(err.semantic_code(), codes::SNAPSHOT_CHECK_PROFILE_MISMATCH);
    }

    #[test]
    fn snapshot_conformance_check_rejects_malformed_baseline_ref() {
        let baseline = snapshot_with("snap-baseline-001", tree_with_frame(1));
        let observed = snapshot_with("snap-observed-001", tree_with_frame(1));
        let mut check = baseline_check(&baseline, &observed);
        check.baseline.inspectable_id = "Bad Id".to_string();
        let err = check.validate().expect_err("malformed baseline");
        match err {
            ConformanceError::SnapshotRefInvalid { side, .. } => assert_eq!(side, "baseline"),
            other => panic!("expected SnapshotRefInvalid, got {other:?}"),
        }
    }

    #[test]
    fn snapshot_conformance_check_rejects_malformed_observed_ref() {
        let baseline = snapshot_with("snap-baseline-001", tree_with_frame(1));
        let observed = snapshot_with("snap-observed-001", tree_with_frame(1));
        let mut check = baseline_check(&baseline, &observed);
        check.observed.inspectable_id = "Bad Id".to_string();
        let err = check.validate().expect_err("malformed observed");
        match err {
            ConformanceError::SnapshotRefInvalid { side, .. } => assert_eq!(side, "observed"),
            other => panic!("expected SnapshotRefInvalid, got {other:?}"),
        }
    }

    #[test]
    fn snapshot_conformance_check_rejects_mismatched_baseline_and_observed_inspectable_ids() {
        let baseline = snapshot_with("snap-baseline-001", tree_with_frame(1));
        let observed = snapshot_with("snap-observed-001", tree_with_frame(1));
        let mut check = baseline_check(&baseline, &observed);
        check.observed.inspectable_id = "other-port".to_string();
        let err = check.validate().expect_err("mismatch");
        assert!(matches!(
            err,
            ConformanceError::SnapshotInspectableIdMismatch { .. }
        ));
        assert_eq!(err.semantic_code(), codes::SNAPSHOT_INSPECTABLE_ID_MISMATCH);
    }

    #[test]
    fn snapshot_conformance_check_rejects_expected_tier_above_profile_ceiling() {
        let baseline = snapshot_with("snap-baseline-001", tree_with_frame(1));
        let observed = snapshot_with("snap-observed-001", tree_with_frame(1));
        let mut check = baseline_check(&baseline, &observed);
        check.expected_tier = EvidenceTier::E2;
        let err = check.validate().expect_err("overclaim");
        assert!(matches!(
            err,
            ConformanceError::SnapshotEvidenceTierOverclaim { .. }
        ));
        assert_eq!(err.semantic_code(), codes::SNAPSHOT_EVIDENCE_TIER_OVERCLAIM);
    }

    #[test]
    fn snapshot_conformance_check_fails_with_state_path_evidence_when_baseline_differs_from_observed()
     {
        // The audit-focus headline negative-case test.
        let baseline = snapshot_with("snap-baseline-001", tree_with_frame(1));
        let observed = snapshot_with("snap-observed-001", tree_with_frame(99));
        let store = populated_store(&baseline, &observed);
        let check = baseline_check(&baseline, &observed);
        let outcome = check.run(&store);
        match &outcome {
            ResultOutcome::Fail { semantic_code, .. } => {
                assert_eq!(semantic_code, snapshot_codes::STATE_DRIFT);
            }
            other => panic!("expected Fail, got {other:?}"),
        }
        // Recompute the diff and confirm the verbatim path evidence.
        let resolved_baseline = store.resolve(&ref_for(&baseline)).expect("baseline");
        let resolved_observed = store.resolve(&ref_for(&observed)).expect("observed");
        let diff = diff_snapshots(&resolved_baseline, &resolved_observed).expect("diff");
        let evidence = SnapshotConformanceCheck::state_path_evidence_from_diff(&diff);
        assert_eq!(
            evidence,
            vec![EvidenceRef::StatePath {
                path: "port.frame".to_string(),
            }]
        );
    }

    #[test]
    fn snapshot_conformance_check_fails_with_one_state_path_per_drifted_path_for_two_path_drift() {
        let baseline = snapshot_with("snap-baseline-001", tree_with_frame_and_last(1, "before"));
        let observed = snapshot_with("snap-observed-001", tree_with_frame_and_last(99, "after"));
        let store = populated_store(&baseline, &observed);
        let check = baseline_check(&baseline, &observed);
        let outcome = check.run(&store);
        assert!(matches!(outcome, ResultOutcome::Fail { .. }));
        let resolved_baseline = store.resolve(&ref_for(&baseline)).expect("baseline");
        let resolved_observed = store.resolve(&ref_for(&observed)).expect("observed");
        let diff = diff_snapshots(&resolved_baseline, &resolved_observed).expect("diff");
        let evidence = SnapshotConformanceCheck::state_path_evidence_from_diff(&diff);
        assert_eq!(evidence.len(), 2);
        let paths: Vec<&str> = evidence
            .iter()
            .map(|e| match e {
                EvidenceRef::StatePath { path } => path.as_str(),
                _ => panic!("not state_path"),
            })
            .collect();
        let mut sorted = paths.clone();
        sorted.sort_unstable();
        assert_eq!(paths, sorted, "evidence must be sorted ascending");
        assert_eq!(paths, vec!["port.frame", "port.last"]);
    }

    #[test]
    fn snapshot_conformance_check_fails_when_state_diff_is_non_empty() {
        // Broader invariant: any non-empty diff produces a Fail.
        let baseline = snapshot_with("snap-baseline-001", tree_with_frame(1));
        let observed = snapshot_with("snap-observed-001", tree_with_frame(2));
        let store = populated_store(&baseline, &observed);
        let outcome = baseline_check(&baseline, &observed).run(&store);
        assert!(matches!(outcome, ResultOutcome::Fail { .. }));
    }

    #[test]
    fn snapshot_conformance_check_run_returns_fail_with_store_not_found_when_baseline_missing() {
        let baseline = snapshot_with("snap-baseline-001", tree_with_frame(1));
        let observed = snapshot_with("snap-observed-001", tree_with_frame(1));
        let store = InMemorySnapshotStore::new();
        // Only insert observed; baseline is missing.
        store.insert(observed.clone()).expect("insert observed");
        let outcome = baseline_check(&baseline, &observed).run(&store);
        match outcome {
            ResultOutcome::Fail {
                semantic_code,
                detail,
            } => {
                assert_eq!(semantic_code, snapshot_codes::STORE_NOT_FOUND);
                assert!(detail.starts_with("baseline:"), "detail={detail}");
            }
            other => panic!("expected Fail, got {other:?}"),
        }
    }

    #[test]
    fn snapshot_conformance_check_run_returns_fail_with_store_mismatched_schema_version_for_stale_observed()
     {
        // Build a store that returns MismatchedSchemaVersion for the
        // observed side.
        #[derive(Debug)]
        struct StaleSchemaStore {
            baseline: Snapshot,
            observed_id: SnapshotId,
        }
        impl SnapshotStore for StaleSchemaStore {
            fn resolve(&self, reference: &SnapshotRef) -> Result<Snapshot, SnapshotStoreError> {
                if reference.snapshot_id == *self.baseline.snapshot_id() {
                    return Ok(self.baseline.clone());
                }
                Err(SnapshotStoreError::MismatchedSchemaVersion {
                    snapshot_id: self.observed_id.clone(),
                    observed: "0.0.1".to_string(),
                    expected: crate::SNAPSHOT_SCHEMA_VERSION,
                })
            }
        }
        let baseline = snapshot_with("snap-baseline-001", tree_with_frame(1));
        let observed = snapshot_with("snap-observed-001", tree_with_frame(1));
        let store = StaleSchemaStore {
            baseline: baseline.clone(),
            observed_id: observed.snapshot_id().clone(),
        };
        let outcome = baseline_check(&baseline, &observed).run(&store);
        match outcome {
            ResultOutcome::Fail { semantic_code, .. } => {
                assert_eq!(
                    semantic_code,
                    snapshot_codes::STORE_MISMATCHED_SCHEMA_VERSION
                );
            }
            other => panic!("expected Fail, got {other:?}"),
        }
        // Reference the type so the compiler doesn't elide it.
        let _ = SnapshotSchemaVersion::current();
    }

    #[test]
    fn snapshot_conformance_check_run_returns_fail_with_store_inspectable_id_mismatch_for_wrong_port_resolve()
     {
        // Build a store that holds a baseline under a different
        // inspectable id; the in-memory store rejects on resolve.
        let baseline_wrong = {
            let port = DummyInspect {
                id: "different-port",
                tree: tree_with_frame(1),
            };
            let request = SnapshotRequest::new("run-001", "2026-06-23T00:00:00Z", EvidenceTier::E1)
                .with_snapshot_id(SnapshotId::parse("snap-baseline-001").expect("id"));
            take_snapshot(&port, &request).expect("snapshot")
        };
        let observed = snapshot_with("snap-observed-001", tree_with_frame(1));
        let store = InMemorySnapshotStore::new();
        store.insert(baseline_wrong).expect("insert baseline_wrong");
        store.insert(observed.clone()).expect("insert observed");
        let check = SnapshotConformanceCheck {
            profile: ProfileId::SnapshotRestore,
            baseline: SnapshotRef {
                snapshot_id: SnapshotId::parse("snap-baseline-001").expect("id"),
                // Ref claims `utsushi-fixture` but stored snapshot's
                // inspectable id is `different-port`.
                inspectable_id: INSPECTABLE_ID.to_string(),
                evidence_tier: EvidenceTier::E1,
            },
            observed: ref_for(&observed),
            expected_tier: EvidenceTier::E1,
        };
        let outcome = check.run(&store);
        match outcome {
            ResultOutcome::Fail { semantic_code, .. } => {
                assert_eq!(semantic_code, snapshot_codes::STORE_INSPECTABLE_ID_MISMATCH);
            }
            other => panic!("expected Fail, got {other:?}"),
        }
    }

    #[test]
    fn snapshot_conformance_check_run_never_returns_pass_when_store_resolution_fails() {
        // Property-style: ten failure injections through a mock store.
        #[derive(Debug)]
        struct MockStore {
            err: SnapshotStoreError,
        }
        impl SnapshotStore for MockStore {
            fn resolve(&self, _: &SnapshotRef) -> Result<Snapshot, SnapshotStoreError> {
                Err(self.err.clone())
            }
        }
        let baseline = snapshot_with("snap-baseline-001", tree_with_frame(1));
        let observed = snapshot_with("snap-observed-001", tree_with_frame(1));
        let check = baseline_check(&baseline, &observed);
        let failures = [
            SnapshotStoreError::NotFound {
                snapshot_id: baseline.snapshot_id().clone(),
            },
            SnapshotStoreError::MismatchedSchemaVersion {
                snapshot_id: baseline.snapshot_id().clone(),
                observed: "0.0.1".to_string(),
                expected: crate::SNAPSHOT_SCHEMA_VERSION,
            },
            SnapshotStoreError::InvalidSnapshotRef {
                reason: SnapshotError::EmptyStateTree,
            },
            SnapshotStoreError::InspectableIdMismatch {
                snapshot_id: baseline.snapshot_id().clone(),
                expected: "a".to_string(),
                found: "b".to_string(),
            },
            SnapshotStoreError::StoreUnavailable {
                reason: "mutex poisoned".to_string(),
            },
        ];
        // Run each failure twice to satisfy the "ten injections"
        // documentation; each must produce a Fail outcome.
        let mut iterations = 0;
        for err in failures.iter().cycle().take(10) {
            iterations += 1;
            let store = MockStore { err: err.clone() };
            let outcome = check.run(&store);
            assert!(
                matches!(outcome, ResultOutcome::Fail { .. }),
                "expected Fail, got {outcome:?}"
            );
        }
        assert_eq!(iterations, 10);
    }

    #[test]
    fn snapshot_conformance_check_serialized_form_passes_reject_unredacted_local_paths() {
        let baseline = snapshot_with("snap-baseline-001", tree_with_frame(1));
        let observed = snapshot_with("snap-observed-001", tree_with_frame(99));
        let check = baseline_check(&baseline, &observed);
        let value = serde_json::to_value(&check).expect("serializes");
        crate::redaction::reject_unredacted_local_paths("snapshotConformanceCheck", &value)
            .expect("clean");
        let store = populated_store(&baseline, &observed);
        let baseline_resolved = store.resolve(&ref_for(&baseline)).expect("baseline");
        let observed_resolved = store.resolve(&ref_for(&observed)).expect("observed");
        let diff = diff_snapshots(&baseline_resolved, &observed_resolved).expect("diff");
        let evidence = SnapshotConformanceCheck::state_path_evidence_from_diff(&diff);
        let evidence_value = serde_json::to_value(&evidence).expect("serializes evidence");
        crate::redaction::reject_unredacted_local_paths("evidence", &evidence_value)
            .expect("evidence clean");
    }

    #[test]
    fn snapshot_conformance_check_evidence_vec_contains_no_runtime_artifact_or_screenshot_kind() {
        let baseline = snapshot_with("snap-baseline-001", tree_with_frame(1));
        let observed = snapshot_with("snap-observed-001", tree_with_frame(99));
        let store = populated_store(&baseline, &observed);
        let baseline_resolved = store.resolve(&ref_for(&baseline)).expect("baseline");
        let observed_resolved = store.resolve(&ref_for(&observed)).expect("observed");
        let diff = diff_snapshots(&baseline_resolved, &observed_resolved).expect("diff");
        let evidence = SnapshotConformanceCheck::state_path_evidence_from_diff(&diff);
        for entry in &evidence {
            assert!(
                matches!(entry, EvidenceRef::StatePath { .. }),
                "evidence entry must be StatePath, got {entry:?}"
            );
        }
    }
}
