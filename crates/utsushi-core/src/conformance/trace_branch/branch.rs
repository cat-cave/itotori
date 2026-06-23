//! Branch conformance check (UTSUSHI-027 §4).
//!
//! Id-keyed comparison of an ordered set of discovered branches with
//! per-branch `choice_index_path` + `expected_outcome`. The order of the
//! observed set is intentionally NOT asserted; branch discovery is a
//! set, not a sequence. The `branch_id` keys are the join column.

use serde::{Deserialize, Serialize};

use crate::{ChoiceIndex, EvidenceTier, RuntimeArtifactKind, looks_like_local_path};

use super::super::diagnostics::{ConformanceError, codes};
use super::super::manifest::is_valid_adapter_id;
use super::super::result::{ConformanceResult, EvidenceRef, ResultOutcome};
use super::super::{CONFORMANCE_SCHEMA_VERSION, ProfileId};
use super::trace::TRACE_MISMATCH_DETAIL_BYTE_CAP;

/// Sentinel `expected_branch_id` used when an observed branch has no
/// counterpart in the golden set.
pub const UNKNOWN_GOLDEN_SENTINEL: &str = "<unknown-golden>";

/// Golden expectation for a single branch.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoldenBranch {
    pub branch_id: String,
    /// Ordered choice-index path. Non-empty at construction.
    pub choice_index_path: Vec<ChoiceIndex>,
    /// Engine-neutral outcome label. Pattern
    /// `^[a-z][a-z0-9_]{0,63}$`.
    pub expected_outcome: String,
}

/// Adapter-emitted observed branch.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservedBranch {
    pub branch_id: String,
    pub choice_index_path: Vec<ChoiceIndex>,
    pub observed_outcome: String,
}

/// Options for [`BranchConformanceCheck::run`]. Evidence emission only;
/// does not alter Pass / Fail.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct BranchCheckOptions {
    /// Optional `ReplayLog.run_id` to cite as evidence when the check
    /// passes.
    pub replay_log_run_id: Option<String>,
}

/// Branch conformance check bound to the `branch-capture` profile.
#[derive(Clone, Debug)]
pub struct BranchConformanceCheck {
    profile_id: ProfileId,
    adapter_id: String,
    golden_branches: Vec<GoldenBranch>,
    observed_branches: Vec<ObservedBranch>,
    options: BranchCheckOptions,
}

impl BranchConformanceCheck {
    pub fn new(
        adapter_id: impl Into<String>,
        golden_branches: Vec<GoldenBranch>,
        observed_branches: Vec<ObservedBranch>,
        options: BranchCheckOptions,
    ) -> Result<Self, ConformanceError> {
        let adapter_id = adapter_id.into();
        if !is_valid_adapter_id(&adapter_id) {
            return Err(ConformanceError::AdapterIdMalformed { id: adapter_id });
        }
        if golden_branches.is_empty() {
            return Err(ConformanceError::EvidenceRefInvalid {
                artifact_kind: "branch",
                reason: "golden_branches is empty".to_string(),
            });
        }
        let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for (index, branch) in golden_branches.iter().enumerate() {
            validate_branch_id_field(&branch.branch_id)?;
            if !seen.insert(branch.branch_id.as_str()) {
                return Err(ConformanceError::EvidenceRefInvalid {
                    artifact_kind: "branch",
                    reason: format!(
                        "golden_branches[{index}].branch_id duplicates {}",
                        branch.branch_id
                    ),
                });
            }
            if branch.choice_index_path.is_empty() {
                return Err(ConformanceError::EvidenceRefInvalid {
                    artifact_kind: "branch",
                    reason: format!("golden_branches[{index}].choice_index_path is empty"),
                });
            }
            if !is_valid_outcome_label(&branch.expected_outcome) {
                return Err(ConformanceError::EvidenceRefInvalid {
                    artifact_kind: "branch",
                    reason: format!(
                        "golden_branches[{index}].expected_outcome {:?} is not snake_case",
                        branch.expected_outcome
                    ),
                });
            }
        }
        if let Some(run_id) = options.replay_log_run_id.as_deref() {
            super::trace::validate_id_field("replay_log_ref", "run_id", run_id)?;
        }
        Ok(Self {
            profile_id: ProfileId::BranchCapture,
            adapter_id,
            golden_branches,
            observed_branches,
            options,
        })
    }

    pub fn profile_id(&self) -> ProfileId {
        self.profile_id
    }

    pub fn adapter_id(&self) -> &str {
        &self.adapter_id
    }

    pub fn run(&self) -> BranchCheckResult {
        let mut mismatches: Vec<BranchMismatch> = Vec::new();

        let observed_by_id: std::collections::HashMap<&str, &ObservedBranch> = self
            .observed_branches
            .iter()
            .map(|b| (b.branch_id.as_str(), b))
            .collect();
        let golden_ids: std::collections::HashSet<&str> = self
            .golden_branches
            .iter()
            .map(|b| b.branch_id.as_str())
            .collect();

        for golden in &self.golden_branches {
            match observed_by_id.get(golden.branch_id.as_str()) {
                None => {
                    mismatches.push(BranchMismatch::new(
                        BranchMismatchKind::Missing,
                        &golden.branch_id,
                        None,
                        "branch not present in observed set".to_string(),
                    ));
                }
                Some(observed) => {
                    if golden.choice_index_path != observed.choice_index_path {
                        let detail = format!(
                            "expected path length {} observed {}; first divergence at index {:?}",
                            golden.choice_index_path.len(),
                            observed.choice_index_path.len(),
                            first_divergence_index(
                                &golden.choice_index_path,
                                &observed.choice_index_path
                            )
                        );
                        mismatches.push(BranchMismatch::new(
                            BranchMismatchKind::ChoicePathDivergent,
                            &golden.branch_id,
                            Some(&observed.branch_id),
                            detail,
                        ));
                    }
                    if golden.expected_outcome != observed.observed_outcome {
                        let detail = format!(
                            "expected outcome {:?} observed {:?}",
                            golden.expected_outcome, observed.observed_outcome
                        );
                        mismatches.push(BranchMismatch::new(
                            BranchMismatchKind::OutcomeDifference,
                            &golden.branch_id,
                            Some(&observed.branch_id),
                            detail,
                        ));
                    }
                }
            }
        }

        for observed in &self.observed_branches {
            if !golden_ids.contains(observed.branch_id.as_str()) {
                mismatches.push(BranchMismatch::new(
                    BranchMismatchKind::Unexpected,
                    UNKNOWN_GOLDEN_SENTINEL,
                    Some(&observed.branch_id),
                    "observed branch absent from golden".to_string(),
                ));
            }
        }

        let evidence_refs = build_branch_evidence(
            &self.golden_branches,
            self.options.replay_log_run_id.as_deref(),
        );

        if mismatches.is_empty() {
            BranchCheckResult::Pass { evidence_refs }
        } else {
            BranchCheckResult::Fail {
                mismatches,
                evidence_refs,
            }
        }
    }
}

fn first_divergence_index(left: &[ChoiceIndex], right: &[ChoiceIndex]) -> Option<usize> {
    for (idx, (lhs, rhs)) in left.iter().zip(right.iter()).enumerate() {
        if lhs != rhs {
            return Some(idx);
        }
    }
    if left.len() != right.len() {
        Some(left.len().min(right.len()))
    } else {
        None
    }
}

fn build_branch_evidence(
    golden: &[GoldenBranch],
    replay_log_run_id: Option<&str>,
) -> Vec<EvidenceRef> {
    let mut refs: Vec<EvidenceRef> = Vec::new();
    for branch in golden {
        refs.push(EvidenceRef::BridgeUnit {
            bridge_unit_id: branch.branch_id.clone(),
        });
    }
    if let Some(run_id) = replay_log_run_id {
        refs.push(EvidenceRef::ReplayLogRef {
            run_id: run_id.to_string(),
        });
    }
    refs
}

/// Outcome of a branch conformance check.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BranchCheckResult {
    Pass {
        evidence_refs: Vec<EvidenceRef>,
    },
    Fail {
        mismatches: Vec<BranchMismatch>,
        evidence_refs: Vec<EvidenceRef>,
    },
}

impl BranchCheckResult {
    pub fn into_conformance_result(
        self,
        adapter_id: &str,
        evidence_tier: EvidenceTier,
        recorded_at: &str,
    ) -> Result<ConformanceResult, ConformanceError> {
        if !is_valid_adapter_id(adapter_id) {
            return Err(ConformanceError::AdapterIdMalformed {
                id: adapter_id.to_string(),
            });
        }
        let ceiling = ProfileId::BranchCapture.evidence_tier_ceiling();
        if evidence_tier > ceiling {
            return Err(ConformanceError::EvidenceTierAboveProfileCeiling {
                profile: ProfileId::BranchCapture,
                claimed: evidence_tier,
                ceiling,
            });
        }
        let (outcome, evidence) = match self {
            Self::Pass { evidence_refs } => {
                for evidence in &evidence_refs {
                    if !accepts_branch_capture_evidence(evidence) {
                        return Err(ConformanceError::MalformedSemanticCode {
                            code: codes::TRACE_EVIDENCE_TIER_OVERCLAIM.to_string(),
                        });
                    }
                }
                (ResultOutcome::Pass { evidence_tier }, evidence_refs)
            }
            Self::Fail {
                mismatches,
                evidence_refs,
            } => {
                for evidence in &evidence_refs {
                    if !accepts_branch_capture_evidence(evidence) {
                        return Err(ConformanceError::MalformedSemanticCode {
                            code: codes::TRACE_EVIDENCE_TIER_OVERCLAIM.to_string(),
                        });
                    }
                }
                let (code, detail) = summarise_branch_failure(&mismatches);
                (
                    ResultOutcome::Fail {
                        semantic_code: code,
                        detail,
                    },
                    evidence_refs,
                )
            }
        };
        let result = ConformanceResult {
            schema_version: CONFORMANCE_SCHEMA_VERSION.to_string(),
            adapter_id: adapter_id.to_string(),
            profile_id: ProfileId::BranchCapture,
            outcome,
            evidence,
            recorded_at: recorded_at.to_string(),
        };
        result.validate()?;
        Ok(result)
    }
}

fn summarise_branch_failure(mismatches: &[BranchMismatch]) -> (String, String) {
    let total = mismatches.len();
    let mut missing = 0usize;
    let mut unexpected = 0usize;
    let mut path = 0usize;
    let mut outcome = 0usize;
    for mismatch in mismatches {
        match mismatch.kind {
            BranchMismatchKind::Missing => missing += 1,
            BranchMismatchKind::Unexpected => unexpected += 1,
            BranchMismatchKind::ChoicePathDivergent => path += 1,
            BranchMismatchKind::OutcomeDifference => outcome += 1,
        }
    }
    let dominant_code = mismatches
        .first()
        .map(|first| branch_mismatch_code(first.kind))
        .unwrap_or(codes::BRANCH_MISSING)
        .to_string();
    let mut detail = format!(
        "{total} branch mismatches: missing={missing} unexpected={unexpected} \
         choice_path_divergent={path} outcome_difference={outcome}"
    );
    if detail.len() > TRACE_MISMATCH_DETAIL_BYTE_CAP {
        let mut cap = TRACE_MISMATCH_DETAIL_BYTE_CAP;
        while !detail.is_char_boundary(cap) {
            cap -= 1;
        }
        detail.truncate(cap);
    }
    (dominant_code, detail)
}

/// Per-branch mismatch diagnostic.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchMismatch {
    pub kind: BranchMismatchKind,
    pub expected_branch_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_branch_id: Option<String>,
    pub detail: String,
}

impl BranchMismatch {
    fn new(
        kind: BranchMismatchKind,
        expected_branch_id: &str,
        observed_branch_id: Option<&str>,
        detail: String,
    ) -> Self {
        let mut detail = detail;
        if looks_like_local_path(&detail) {
            detail = format!("<redacted {} bytes>", detail.len());
        }
        if detail.len() > TRACE_MISMATCH_DETAIL_BYTE_CAP {
            let mut cap = TRACE_MISMATCH_DETAIL_BYTE_CAP;
            while !detail.is_char_boundary(cap) {
                cap -= 1;
            }
            detail.truncate(cap);
        }
        Self {
            kind,
            expected_branch_id: expected_branch_id.to_string(),
            observed_branch_id: observed_branch_id.map(|s| s.to_string()),
            detail,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BranchMismatchKind {
    Missing,
    Unexpected,
    ChoicePathDivergent,
    OutcomeDifference,
}

pub fn branch_mismatch_code(kind: BranchMismatchKind) -> &'static str {
    match kind {
        BranchMismatchKind::Missing => codes::BRANCH_MISSING,
        BranchMismatchKind::Unexpected => codes::BRANCH_UNEXPECTED,
        BranchMismatchKind::ChoicePathDivergent => codes::BRANCH_CHOICE_PATH_MISMATCH,
        BranchMismatchKind::OutcomeDifference => codes::BRANCH_OUTCOME_MISMATCH,
    }
}

pub fn accepts_branch_capture_evidence(evidence: &EvidenceRef) -> bool {
    match evidence {
        EvidenceRef::TextLine { .. }
        | EvidenceRef::BridgeUnit { .. }
        | EvidenceRef::ReplayLogRef { .. }
        | EvidenceRef::ImplMapFixture { .. } => true,
        EvidenceRef::FrameArtifactRef { .. } => false,
        EvidenceRef::RuntimeArtifact { kind, .. } => matches!(
            kind,
            RuntimeArtifactKind::TraceLog | RuntimeArtifactKind::ConformanceReport
        ),
    }
}

fn validate_branch_id_field(value: &str) -> Result<(), ConformanceError> {
    if value.is_empty() {
        return Err(ConformanceError::EvidenceRefInvalid {
            artifact_kind: "branch",
            reason: "branch_id is empty".to_string(),
        });
    }
    if value.chars().any(|c| c.is_whitespace()) {
        return Err(ConformanceError::EvidenceRefInvalid {
            artifact_kind: "branch",
            reason: "branch_id contains whitespace".to_string(),
        });
    }
    if looks_like_local_path(value) {
        return Err(ConformanceError::EvidenceRefInvalid {
            artifact_kind: "branch",
            reason: "branch_id looks like a local path".to_string(),
        });
    }
    Ok(())
}

fn is_valid_outcome_label(label: &str) -> bool {
    if label.is_empty() || label.len() > 64 {
        return false;
    }
    let bytes = label.as_bytes();
    if !bytes[0].is_ascii_lowercase() {
        return false;
    }
    bytes
        .iter()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn baseline_golden() -> Vec<GoldenBranch> {
        vec![
            GoldenBranch {
                branch_id: "branch-001".to_string(),
                choice_index_path: vec![ChoiceIndex(0), ChoiceIndex(1)],
                expected_outcome: "happy_end".to_string(),
            },
            GoldenBranch {
                branch_id: "branch-002".to_string(),
                choice_index_path: vec![ChoiceIndex(1), ChoiceIndex(0)],
                expected_outcome: "true_route".to_string(),
            },
            GoldenBranch {
                branch_id: "branch-003".to_string(),
                choice_index_path: vec![ChoiceIndex(0), ChoiceIndex(0), ChoiceIndex(2)],
                expected_outcome: "branch_to_chapter_2".to_string(),
            },
        ]
    }

    fn baseline_observed() -> Vec<ObservedBranch> {
        vec![
            ObservedBranch {
                branch_id: "branch-001".to_string(),
                choice_index_path: vec![ChoiceIndex(0), ChoiceIndex(1)],
                observed_outcome: "happy_end".to_string(),
            },
            ObservedBranch {
                branch_id: "branch-002".to_string(),
                choice_index_path: vec![ChoiceIndex(1), ChoiceIndex(0)],
                observed_outcome: "true_route".to_string(),
            },
            ObservedBranch {
                branch_id: "branch-003".to_string(),
                choice_index_path: vec![ChoiceIndex(0), ChoiceIndex(0), ChoiceIndex(2)],
                observed_outcome: "branch_to_chapter_2".to_string(),
            },
        ]
    }

    fn baseline_check() -> BranchConformanceCheck {
        BranchConformanceCheck::new(
            "utsushi-synthetic",
            baseline_golden(),
            baseline_observed(),
            BranchCheckOptions::default(),
        )
        .expect("baseline constructs")
    }

    #[test]
    fn branch_check_new_accepts_well_formed_input() {
        baseline_check();
    }

    #[test]
    fn branch_check_new_rejects_empty_golden_branches() {
        let error = BranchConformanceCheck::new(
            "utsushi-synthetic",
            Vec::new(),
            Vec::new(),
            BranchCheckOptions::default(),
        )
        .expect_err("empty golden rejected");
        assert!(matches!(
            error,
            ConformanceError::EvidenceRefInvalid {
                artifact_kind: "branch",
                ..
            }
        ));
    }

    #[test]
    fn branch_check_new_rejects_duplicate_golden_branch_id() {
        let mut golden = baseline_golden();
        golden[1].branch_id = golden[0].branch_id.clone();
        let error = BranchConformanceCheck::new(
            "utsushi-synthetic",
            golden,
            baseline_observed(),
            BranchCheckOptions::default(),
        )
        .expect_err("duplicate rejected");
        assert!(matches!(
            error,
            ConformanceError::EvidenceRefInvalid {
                artifact_kind: "branch",
                ..
            }
        ));
    }

    #[test]
    fn branch_check_new_rejects_empty_choice_path_in_golden() {
        let mut golden = baseline_golden();
        golden[0].choice_index_path.clear();
        let error = BranchConformanceCheck::new(
            "utsushi-synthetic",
            golden,
            baseline_observed(),
            BranchCheckOptions::default(),
        )
        .expect_err("empty path rejected");
        assert!(matches!(
            error,
            ConformanceError::EvidenceRefInvalid {
                artifact_kind: "branch",
                ..
            }
        ));
    }

    #[test]
    fn branch_check_new_rejects_outcome_label_with_uppercase() {
        let mut golden = baseline_golden();
        golden[0].expected_outcome = "BadOutcome".to_string();
        let error = BranchConformanceCheck::new(
            "utsushi-synthetic",
            golden,
            baseline_observed(),
            BranchCheckOptions::default(),
        )
        .expect_err("uppercase outcome rejected");
        assert!(matches!(
            error,
            ConformanceError::EvidenceRefInvalid {
                artifact_kind: "branch",
                ..
            }
        ));
    }

    #[test]
    fn branch_check_run_passes_with_matching_branches_in_same_order() {
        assert!(matches!(
            baseline_check().run(),
            BranchCheckResult::Pass { .. }
        ));
    }

    #[test]
    fn branch_check_run_passes_with_matching_branches_in_reversed_order() {
        let mut observed = baseline_observed();
        observed.reverse();
        let check = BranchConformanceCheck::new(
            "utsushi-synthetic",
            baseline_golden(),
            observed,
            BranchCheckOptions::default(),
        )
        .expect("constructs");
        assert!(matches!(check.run(), BranchCheckResult::Pass { .. }));
    }

    #[test]
    fn branch_check_run_pass_emits_replay_log_ref_when_options_set() {
        let check = BranchConformanceCheck::new(
            "utsushi-synthetic",
            baseline_golden(),
            baseline_observed(),
            BranchCheckOptions {
                replay_log_run_id: Some("run-001".to_string()),
            },
        )
        .expect("constructs");
        let BranchCheckResult::Pass { evidence_refs } = check.run() else {
            panic!("expected Pass");
        };
        assert!(
            evidence_refs
                .iter()
                .any(|e| matches!(e, EvidenceRef::ReplayLogRef { .. })),
            "{evidence_refs:?}"
        );
    }

    #[test]
    fn branch_check_run_pass_omits_replay_log_ref_when_options_none() {
        let BranchCheckResult::Pass { evidence_refs } = baseline_check().run() else {
            panic!("expected Pass");
        };
        assert!(
            !evidence_refs
                .iter()
                .any(|e| matches!(e, EvidenceRef::ReplayLogRef { .. }))
        );
    }

    #[test]
    fn branch_check_run_fails_with_missing_branch() {
        let mut observed = baseline_observed();
        observed.pop();
        let check = BranchConformanceCheck::new(
            "utsushi-synthetic",
            baseline_golden(),
            observed,
            BranchCheckOptions::default(),
        )
        .expect("constructs");
        let BranchCheckResult::Fail { mismatches, .. } = check.run() else {
            panic!("expected Fail");
        };
        assert!(
            mismatches
                .iter()
                .any(|m| matches!(m.kind, BranchMismatchKind::Missing))
        );
    }

    #[test]
    fn branch_check_run_fails_with_unexpected_branch() {
        let mut observed = baseline_observed();
        observed.push(ObservedBranch {
            branch_id: "branch-extra".to_string(),
            choice_index_path: vec![ChoiceIndex(9)],
            observed_outcome: "extra".to_string(),
        });
        let check = BranchConformanceCheck::new(
            "utsushi-synthetic",
            baseline_golden(),
            observed,
            BranchCheckOptions::default(),
        )
        .expect("constructs");
        let BranchCheckResult::Fail { mismatches, .. } = check.run() else {
            panic!("expected Fail");
        };
        let unexpected = mismatches
            .iter()
            .find(|m| matches!(m.kind, BranchMismatchKind::Unexpected))
            .expect("Unexpected present");
        assert_eq!(unexpected.expected_branch_id, UNKNOWN_GOLDEN_SENTINEL);
    }

    #[test]
    fn branch_check_run_fails_with_choice_path_divergence_on_length() {
        let mut observed = baseline_observed();
        observed[0].choice_index_path.push(ChoiceIndex(5));
        let check = BranchConformanceCheck::new(
            "utsushi-synthetic",
            baseline_golden(),
            observed,
            BranchCheckOptions::default(),
        )
        .expect("constructs");
        let BranchCheckResult::Fail { mismatches, .. } = check.run() else {
            panic!("expected Fail");
        };
        assert!(
            mismatches
                .iter()
                .any(|m| matches!(m.kind, BranchMismatchKind::ChoicePathDivergent))
        );
    }

    #[test]
    fn branch_check_run_fails_with_choice_path_divergence_on_element() {
        let mut observed = baseline_observed();
        observed[0].choice_index_path[0] = ChoiceIndex(99);
        let check = BranchConformanceCheck::new(
            "utsushi-synthetic",
            baseline_golden(),
            observed,
            BranchCheckOptions::default(),
        )
        .expect("constructs");
        let BranchCheckResult::Fail { mismatches, .. } = check.run() else {
            panic!("expected Fail");
        };
        assert!(
            mismatches
                .iter()
                .any(|m| matches!(m.kind, BranchMismatchKind::ChoicePathDivergent))
        );
    }

    #[test]
    fn branch_check_run_fails_with_outcome_difference() {
        let mut observed = baseline_observed();
        observed[0].observed_outcome = "other_end".to_string();
        let check = BranchConformanceCheck::new(
            "utsushi-synthetic",
            baseline_golden(),
            observed,
            BranchCheckOptions::default(),
        )
        .expect("constructs");
        let BranchCheckResult::Fail { mismatches, .. } = check.run() else {
            panic!("expected Fail");
        };
        assert!(
            mismatches
                .iter()
                .any(|m| matches!(m.kind, BranchMismatchKind::OutcomeDifference))
        );
    }

    #[test]
    fn branch_check_run_collects_all_mismatches_not_only_the_first() {
        let mut observed = baseline_observed();
        observed[0].choice_index_path[0] = ChoiceIndex(99);
        observed[0].observed_outcome = "other_end".to_string();
        observed.pop(); // remove branch-003
        observed.push(ObservedBranch {
            branch_id: "branch-extra".to_string(),
            choice_index_path: vec![ChoiceIndex(0)],
            observed_outcome: "extra".to_string(),
        });
        let check = BranchConformanceCheck::new(
            "utsushi-synthetic",
            baseline_golden(),
            observed,
            BranchCheckOptions::default(),
        )
        .expect("constructs");
        let BranchCheckResult::Fail { mismatches, .. } = check.run() else {
            panic!("expected Fail");
        };
        let kinds: std::collections::HashSet<BranchMismatchKind> =
            mismatches.iter().map(|m| m.kind).collect();
        assert!(kinds.contains(&BranchMismatchKind::ChoicePathDivergent));
        assert!(kinds.contains(&BranchMismatchKind::OutcomeDifference));
        assert!(kinds.contains(&BranchMismatchKind::Missing));
        assert!(kinds.contains(&BranchMismatchKind::Unexpected));
    }

    #[test]
    fn branch_mismatch_kind_to_code_is_exhaustive_over_enum_variants() {
        for kind in [
            BranchMismatchKind::Missing,
            BranchMismatchKind::Unexpected,
            BranchMismatchKind::ChoicePathDivergent,
            BranchMismatchKind::OutcomeDifference,
        ] {
            let code = branch_mismatch_code(kind);
            assert!(code.starts_with("utsushi.conformance."));
        }
    }

    #[test]
    fn branch_mismatch_codes_are_all_members_of_codes_all() {
        let all: std::collections::HashSet<&'static str> = codes::ALL.iter().copied().collect();
        for kind in [
            BranchMismatchKind::Missing,
            BranchMismatchKind::Unexpected,
            BranchMismatchKind::ChoicePathDivergent,
            BranchMismatchKind::OutcomeDifference,
        ] {
            assert!(all.contains(branch_mismatch_code(kind)));
        }
    }

    #[test]
    fn branch_into_conformance_result_emits_pass_with_bridge_unit_evidence() {
        let result = baseline_check().run();
        let lowered = result
            .into_conformance_result(
                "utsushi-synthetic",
                EvidenceTier::E1,
                "2026-06-23T12:00:00Z",
            )
            .expect("lowers");
        assert_eq!(lowered.profile_id, ProfileId::BranchCapture);
        assert!(matches!(lowered.outcome, ResultOutcome::Pass { .. }));
        assert!(
            lowered
                .evidence
                .iter()
                .any(|e| matches!(e, EvidenceRef::BridgeUnit { .. }))
        );
    }

    #[test]
    fn branch_into_conformance_result_rejects_evidence_tier_above_e1() {
        let result = baseline_check().run();
        let error = result
            .into_conformance_result(
                "utsushi-synthetic",
                EvidenceTier::E2,
                "2026-06-23T12:00:00Z",
            )
            .expect_err("rejected");
        assert!(matches!(
            error,
            ConformanceError::EvidenceTierAboveProfileCeiling { .. }
        ));
    }

    #[test]
    fn branch_into_conformance_result_rejects_screenshot_runtime_artifact() {
        let uri = crate::runtime_artifact_uri(
            "synthetic-run",
            RuntimeArtifactKind::Screenshot,
            "shot-001",
        )
        .expect("uri");
        let result = BranchCheckResult::Pass {
            evidence_refs: vec![EvidenceRef::RuntimeArtifact {
                kind: RuntimeArtifactKind::Screenshot,
                uri,
                artifact_id: Some("shot-001".to_string()),
            }],
        };
        let error = result
            .into_conformance_result(
                "utsushi-synthetic",
                EvidenceTier::E1,
                "2026-06-23T12:00:00Z",
            )
            .expect_err("rejected");
        assert!(matches!(
            error,
            ConformanceError::MalformedSemanticCode { ref code, .. }
                if code == codes::TRACE_EVIDENCE_TIER_OVERCLAIM
        ));
    }

    #[test]
    fn branch_pass_result_round_trips_through_conformance_schema_v0_1() {
        let lowered = baseline_check()
            .run()
            .into_conformance_result(
                "utsushi-synthetic",
                EvidenceTier::E1,
                "2026-06-23T12:00:00Z",
            )
            .expect("lowers");
        let value = lowered.to_json_value().expect("serializes");
        let restored = ConformanceResult::from_json_value(value).expect("round-trips");
        assert_eq!(restored, lowered);
    }

    #[test]
    fn accepts_branch_capture_evidence_rejects_frame_artifact() {
        let evidence = EvidenceRef::FrameArtifactRef {
            frame_id: "frame-1".to_string(),
        };
        assert!(!accepts_branch_capture_evidence(&evidence));
    }
}
