//! Trace and branch conformance checks (UTSUSHI-027).
//!
//! Two executable checks that ride on top of the UTSUSHI-026 manifest +
//! result contract — the only checks that the `text-trace` and
//! `branch-capture` profiles authorise:
//!
//! - [`trace::TraceConformanceCheck`] compares a golden ordered text
//!   trace against an observed text trace and emits typed per-event
//!   mismatches.
//! - [`branch::BranchConformanceCheck`] compares a golden ordered set of
//!   branches (with per-branch choice-index path + expected outcome)
//!   against the observed set, id-keyed.
//!
//! Both checks lower into a [`crate::ConformanceResult`] via
//! `into_conformance_result()` and surface every diagnostic through a
//! stable `utsushi.conformance.*` semantic code registered in
//! [`super::diagnostics::codes::ALL`].
//!
//! The substrate's audit-focus invariants enforced here:
//!
//! - Trace evidence is text-trace only: the
//!   [`trace::accepts_text_trace_evidence`] filter rejects
//!   `EvidenceRef::FrameArtifactRef` and screenshot / frame-capture /
//!   recording `RuntimeArtifact` kinds. The trace check has no
//!   screenshot or render-fidelity claim. E1 ceiling.
//! - Every observed text event carries a `bridge_unit_id`. A `None`
//!   surfaces as the [`trace::TraceMismatchKind::BridgeUnitUnlinked`]
//!   typed Fail with stable code
//!   `utsushi.conformance.bridge_unit_unlinked`.
//! - Missing branches surface as the
//!   [`branch::BranchMismatchKind::Missing`] typed Fail with stable code
//!   `utsushi.conformance.branch_missing` — never Skip.
//! - Per-event mismatches are exhaustive: the comparison loop never
//!   short-circuits inside a single event, and the result's
//!   `mismatches` list is never truncated. Each
//!   [`trace::TraceMismatch::detail`] is capped at 256 bytes so the
//!   worst-case output stays bounded.

pub mod branch;
pub mod fixtures;
pub mod trace;

pub use branch::{
    BranchCheckOptions, BranchCheckResult, BranchConformanceCheck, BranchMismatch,
    BranchMismatchKind, GoldenBranch, ObservedBranch, accepts_branch_capture_evidence,
    branch_mismatch_code,
};
pub use trace::{
    BEYOND_GOLDEN_SENTINEL, GoldenTextEvent, ObservedTextEvent, TextNormalisation,
    TraceCheckOptions, TraceCheckResult, TraceConformanceCheck, TraceMismatch, TraceMismatchKind,
    accepts_text_trace_evidence, trace_mismatch_code,
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conformance::diagnostics::codes;

    #[test]
    fn every_new_trace_code_is_member_of_codes_all() {
        let all: std::collections::HashSet<&'static str> = codes::ALL.iter().copied().collect();
        for kind in [
            TraceMismatchKind::TextDifference,
            TraceMismatchKind::OrderShift,
            TraceMismatchKind::BridgeUnitUnlinked,
            TraceMismatchKind::BridgeUnitDivergent,
            TraceMismatchKind::SpeakerMismatch,
            TraceMismatchKind::Missing,
            TraceMismatchKind::Unexpected,
        ] {
            let code = trace_mismatch_code(kind);
            assert!(
                all.contains(code),
                "trace mismatch code {code} missing from codes::ALL (kind {kind:?})"
            );
        }
        assert!(all.contains(codes::TRACE_EVIDENCE_TIER_OVERCLAIM));
        assert!(all.contains(codes::BRIDGE_UNIT_UNLINKED));
        assert!(all.contains(codes::BRIDGE_UNIT_DIVERGENT));
    }

    #[test]
    fn every_new_branch_code_is_member_of_codes_all() {
        let all: std::collections::HashSet<&'static str> = codes::ALL.iter().copied().collect();
        for kind in [
            BranchMismatchKind::Missing,
            BranchMismatchKind::Unexpected,
            BranchMismatchKind::ChoicePathDivergent,
            BranchMismatchKind::OutcomeDifference,
        ] {
            let code = branch_mismatch_code(kind);
            assert!(
                all.contains(code),
                "branch mismatch code {code} missing from codes::ALL (kind {kind:?})"
            );
        }
    }

    #[test]
    fn trace_mismatch_codes_match_existing_utsushi_conformance_pattern() {
        let new_codes = [
            codes::TRACE_TEXT_MISMATCH,
            codes::TRACE_ORDER_MISMATCH,
            codes::TRACE_SPEAKER_MISMATCH,
            codes::TRACE_EVENT_MISSING,
            codes::TRACE_EVENT_UNEXPECTED,
            codes::BRIDGE_UNIT_UNLINKED,
            codes::BRIDGE_UNIT_DIVERGENT,
            codes::BRANCH_MISSING,
            codes::BRANCH_UNEXPECTED,
            codes::BRANCH_CHOICE_PATH_MISMATCH,
            codes::BRANCH_OUTCOME_MISMATCH,
            codes::TRACE_EVIDENCE_TIER_OVERCLAIM,
        ];
        for code in new_codes {
            assert!(
                code.starts_with("utsushi.conformance."),
                "code {code} must use utsushi.conformance prefix"
            );
            let parts: Vec<&str> = code.split('.').collect();
            assert_eq!(parts.len(), 3, "code {code} must have three segments");
            let reason = parts[2];
            assert!(!reason.is_empty());
            assert!(
                reason
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
                "code {code} reason segment must be snake_case ascii"
            );
            assert!(
                reason.as_bytes()[0].is_ascii_lowercase(),
                "code {code} reason must start with lowercase letter"
            );
        }
    }

    #[test]
    fn new_codes_have_no_duplicates_in_codes_all() {
        let all: Vec<&'static str> = codes::ALL.to_vec();
        let set: std::collections::HashSet<&'static str> = all.iter().copied().collect();
        assert_eq!(
            all.len(),
            set.len(),
            "codes::ALL must not contain duplicates"
        );
    }
}
