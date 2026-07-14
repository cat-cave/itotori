//! Golden-trace acceptance for the MV/MZ replay skeleton.
//!
//! Each case loads a synthetic MV/MZ event `list[]` fixture, replays it
//! through the declared subset, and asserts the deterministic trace against a
//! committed golden JSON. A final case proves an out-of-subset command
//! surfaces a *semantic* diagnostic rather than being silently dropped.
//!
//! All fixtures are SYNTHETIC — hand-authored `{code, indent, parameters}`
//! lists using the public MV/MZ command-code constants. No copyrighted game
//! JSON is involved.

use std::path::PathBuf;

use serde_json::Value;
use utsushi_rpgmaker_mv::replay::{
    DiagnosticReason, DiagnosticSeverity, UnknownPolicy, replay_event_list,
};

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("replay")
}

fn load_event_list(stem: &str) -> Vec<Value> {
    let path = fixture_dir().join(format!("{stem}.events.json"));
    let display = path.display();
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {display}: {e}"));
    serde_json::from_str::<Value>(&raw)
        .unwrap_or_else(|e| panic!("parse {display}: {e}"))
        .as_array()
        .expect("event fixture is a JSON array")
        .clone()
}

fn load_golden(stem: &str) -> Value {
    let path = fixture_dir().join(format!("{stem}.trace.json"));
    let display = path.display();
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {display}: {e}"));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {display}: {e}"))
}

/// Replay a fixture and assert its trace JSON equals the committed golden.
/// Compared as parsed `Value`s so key order / whitespace do not matter.
fn assert_golden(stem: &str) {
    let list = load_event_list(stem);
    let outcome = replay_event_list(&list, UnknownPolicy::SkipWithDiagnostic)
        .unwrap_or_else(|d| panic!("replay {stem} unexpectedly failed: {d}"));
    let actual = outcome.to_trace_json();
    let expected = load_golden(stem);
    assert_eq!(
        actual, expected,
        "replay trace for `{stem}` diverged from golden\n actual:   {actual}\n expected: {expected}"
    );
}

#[test]
fn show_text_and_choices_golden_trace() {
    // Command 101/401/102 fixture → golden text + choice trace.
    assert_golden("show_text_choices");
}

#[test]
fn switch_variable_golden_state_trace() {
    // Command 121/122 fixture → golden switch/variable state trace.
    assert_golden("switch_variable");
}

#[test]
fn unknown_command_golden_trace_includes_diagnostics() {
    // Fixture mixes subset commands with out-of-subset 356/111 → golden trace
    // carries the surviving events AND the semantic diagnostics.
    assert_golden("unknown_command");
}

#[test]
fn unknown_command_is_never_silently_dropped() {
    // The load-bearing acceptance: an out-of-subset command must be VISIBLE.
    let list = load_event_list("unknown_command");

    // Skip policy: the command survives as a typed diagnostic, not a silent
    // gap. There is exactly one 356 and one 111 outside the subset.
    let outcome = replay_event_list(&list, UnknownPolicy::SkipWithDiagnostic).unwrap();
    assert_eq!(
        outcome.diagnostics.len(),
        2,
        "out-of-subset commands must each surface a diagnostic, not vanish"
    );
    assert!(
        outcome
            .diagnostics
            .iter()
            .all(|d| d.severity == DiagnosticSeverity::Unsupported)
    );
    assert!(
        outcome
            .diagnostics
            .iter()
            .any(|d| d.code == 356
                && d.reason == DiagnosticReason::CommandOutsideSubset { code: 356 })
    );

    // Fail policy: the first out-of-subset command aborts with the diagnostic
    // as the error — the antithesis of a silent skip.
    let err = replay_event_list(&list, UnknownPolicy::Fail).unwrap_err();
    assert_eq!(err.code, 356);
    assert_eq!(
        err.reason,
        DiagnosticReason::CommandOutsideSubset { code: 356 }
    );
}
