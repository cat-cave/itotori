//! Branch conformance check ( §4).
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
    if left.len() == right.len() {
        None
    } else {
        Some(left.len().min(right.len()))
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
        .map_or(codes::BRANCH_MISSING, |first| {
            branch_mismatch_code(first.kind)
        })
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
            observed_branch_id: observed_branch_id.map(std::string::ToString::to_string),
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
        // `EvidenceRef::StatePath` () belongs to the
        // snapshot-restore profile only.
        EvidenceRef::FrameArtifactRef { .. } | EvidenceRef::StatePath { .. } => false,
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
    if value.chars().any(char::is_whitespace) {
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
#[path = "branch_tests.rs"]
mod tests;
