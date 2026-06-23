//! Integration tests that load the synthetic trace/branch JSON fixtures
//! committed under `tests/fixtures/conformance/trace_branch/`.
//!
//! Each test corresponds 1:1 to a fixture file and asserts that the
//! constructed check produces the expected Pass/Fail shape and that the
//! mismatch kind set matches the fixture's name. The fixtures are
//! checked in as JSON so reviewers can read them as data and a future
//! TypeScript schema mirror has a clear input.

use std::path::PathBuf;

use serde_json::Value;

use utsushi_core::conformance::trace_branch::{
    branch::{BranchCheckResult, BranchMismatchKind},
    fixtures::{branch_check_from_json, trace_check_from_json},
    trace::{TraceCheckResult, TraceMismatchKind},
};

fn fixture_path(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("conformance")
        .join("trace_branch")
        .join(relative)
}

fn load_fixture(relative: &str) -> Value {
    let path = fixture_path(relative);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|_| panic!("read fixture {}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|_| panic!("parse fixture {}", path.display()))
}

fn run_trace_fixture(relative: &str) -> TraceCheckResult {
    let value = load_fixture(relative);
    let check = trace_check_from_json(value)
        .unwrap_or_else(|err| panic!("fixture {relative} constructs: {err}"));
    check.run()
}

fn run_branch_fixture(relative: &str) -> BranchCheckResult {
    let value = load_fixture(relative);
    let check = branch_check_from_json(value)
        .unwrap_or_else(|err| panic!("fixture {relative} constructs: {err}"));
    check.run()
}

#[test]
fn positive_matching_trace_fixture_passes() {
    let result = run_trace_fixture("positive/matching_trace.json");
    assert!(
        matches!(result, TraceCheckResult::Pass { .. }),
        "expected Pass, got {result:?}"
    );
}

#[test]
fn positive_matching_branches_fixture_passes() {
    let result = run_branch_fixture("positive/matching_branches.json");
    assert!(
        matches!(result, BranchCheckResult::Pass { .. }),
        "expected Pass, got {result:?}"
    );
}

#[test]
fn positive_matching_trace_with_speakers_passes() {
    let result = run_trace_fixture("positive/matching_trace_with_speakers.json");
    assert!(
        matches!(result, TraceCheckResult::Pass { .. }),
        "expected Pass, got {result:?}"
    );
}

#[test]
fn negative_text_diff_fixture_fails_with_text_difference() {
    let TraceCheckResult::Fail { mismatches, .. } = run_trace_fixture("negative/text_diff.json")
    else {
        panic!("expected Fail");
    };
    assert!(
        mismatches
            .iter()
            .any(|m| matches!(m.kind, TraceMismatchKind::TextDifference)),
        "{mismatches:?}"
    );
}

#[test]
fn negative_order_shift_fixture_fails_with_order_shift() {
    let TraceCheckResult::Fail { mismatches, .. } = run_trace_fixture("negative/order_shift.json")
    else {
        panic!("expected Fail");
    };
    assert!(
        mismatches
            .iter()
            .any(|m| matches!(m.kind, TraceMismatchKind::OrderShift)),
        "{mismatches:?}"
    );
}

#[test]
fn negative_bridge_unit_unlinked_fixture_fails_with_bridge_unit_unlinked() {
    let TraceCheckResult::Fail { mismatches, .. } =
        run_trace_fixture("negative/bridge_unit_unlinked.json")
    else {
        panic!("expected Fail");
    };
    assert!(
        mismatches
            .iter()
            .any(|m| matches!(m.kind, TraceMismatchKind::BridgeUnitUnlinked)),
        "{mismatches:?}"
    );
}

#[test]
fn negative_bridge_unit_divergent_fixture_fails_with_bridge_unit_divergent() {
    let TraceCheckResult::Fail { mismatches, .. } =
        run_trace_fixture("negative/bridge_unit_divergent.json")
    else {
        panic!("expected Fail");
    };
    assert!(
        mismatches
            .iter()
            .any(|m| matches!(m.kind, TraceMismatchKind::BridgeUnitDivergent)),
        "{mismatches:?}"
    );
}

#[test]
fn negative_speaker_mismatch_fixture_fails_with_speaker_mismatch() {
    let TraceCheckResult::Fail { mismatches, .. } =
        run_trace_fixture("negative/speaker_mismatch.json")
    else {
        panic!("expected Fail");
    };
    assert!(
        mismatches
            .iter()
            .any(|m| matches!(m.kind, TraceMismatchKind::SpeakerMismatch)),
        "{mismatches:?}"
    );
}

#[test]
fn negative_trace_event_missing_fixture_fails_with_missing_kind() {
    let TraceCheckResult::Fail { mismatches, .. } =
        run_trace_fixture("negative/trace_event_missing.json")
    else {
        panic!("expected Fail");
    };
    assert!(
        mismatches
            .iter()
            .any(|m| matches!(m.kind, TraceMismatchKind::Missing)),
        "{mismatches:?}"
    );
}

#[test]
fn negative_trace_event_unexpected_fixture_fails_with_unexpected_kind() {
    let TraceCheckResult::Fail { mismatches, .. } =
        run_trace_fixture("negative/trace_event_unexpected.json")
    else {
        panic!("expected Fail");
    };
    assert!(
        mismatches
            .iter()
            .any(|m| matches!(m.kind, TraceMismatchKind::Unexpected)),
        "{mismatches:?}"
    );
}

#[test]
fn negative_branch_missing_fixture_fails_with_branch_missing() {
    let BranchCheckResult::Fail { mismatches, .. } =
        run_branch_fixture("negative/branch_missing.json")
    else {
        panic!("expected Fail");
    };
    assert!(
        mismatches
            .iter()
            .any(|m| matches!(m.kind, BranchMismatchKind::Missing)),
        "{mismatches:?}"
    );
}

#[test]
fn negative_branch_unexpected_fixture_fails_with_unexpected_branch() {
    let BranchCheckResult::Fail { mismatches, .. } =
        run_branch_fixture("negative/branch_unexpected.json")
    else {
        panic!("expected Fail");
    };
    assert!(
        mismatches
            .iter()
            .any(|m| matches!(m.kind, BranchMismatchKind::Unexpected)),
        "{mismatches:?}"
    );
}

#[test]
fn negative_branch_choice_path_divergent_fixture_fails_with_choice_path_mismatch() {
    let BranchCheckResult::Fail { mismatches, .. } =
        run_branch_fixture("negative/branch_choice_path_divergent.json")
    else {
        panic!("expected Fail");
    };
    assert!(
        mismatches
            .iter()
            .any(|m| matches!(m.kind, BranchMismatchKind::ChoicePathDivergent)),
        "{mismatches:?}"
    );
}

#[test]
fn negative_branch_outcome_difference_fixture_fails_with_outcome_mismatch() {
    let BranchCheckResult::Fail { mismatches, .. } =
        run_branch_fixture("negative/branch_outcome_difference.json")
    else {
        panic!("expected Fail");
    };
    assert!(
        mismatches
            .iter()
            .any(|m| matches!(m.kind, BranchMismatchKind::OutcomeDifference)),
        "{mismatches:?}"
    );
}
