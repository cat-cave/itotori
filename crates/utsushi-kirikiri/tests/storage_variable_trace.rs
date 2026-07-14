//! Acceptance — the supported storage-variable subset: simple
//! `f.`/`sf.` `[eval]` assignments and bare-variable `[emb]` reads, with state
//! visible as VariableSet/EmbeddedValue events + the final `variables`
//! snapshot, and the subset BOUNDARY (out-of-subset expressions and unbound
//! reads stay typed diagnostics, never faked values).
//!
//! File fixture is synthetic, authored, CC0 (`fixtures/storage_variables.ks`);
//! boundary cases use inline authored byte snippets.

use std::path::PathBuf;

use utsushi_kirikiri::{KagEvent, KagOutcome, VarValue, parse_kag, replay_kag};

const FIXTURE: &str = "storage_variables.ks";

fn fixture_bytes() -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .join(FIXTURE);
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

fn sets(events: &[KagEvent]) -> Vec<(String, VarValue)> {
    events
        .iter()
        .filter_map(|e| match e {
            KagEvent::VariableSet { name, value } => Some((name.clone(), value.clone())),
            _ => None,
        })
        .collect()
}

fn embeds(events: &[KagEvent]) -> Vec<(String, VarValue)> {
    events
        .iter()
        .filter_map(|e| match e {
            KagEvent::EmbeddedValue { name, value } => Some((name.clone(), value.clone())),
            _ => None,
        })
        .collect()
}

/// Acceptance (3): a supported storage assignment is visible in the trace
/// snapshot, and a later read reflects it (the `[emb]` after two increments
/// reads 2, proving reads observe prior writes).
#[test]
fn supported_storage_ops_are_visible_and_reads_reflect_writes() {
    let bytes = fixture_bytes();
    let script = parse_kag(FIXTURE, &bytes);
    let trace = replay_kag(&script);

    // Ordered assignment timeline: literal, two increments, a string, a copy.
    assert_eq!(
        sets(&trace.events),
        vec![
            ("f.count".to_string(), VarValue::Int(0)),
            ("f.count".to_string(), VarValue::Int(1)),
            ("f.count".to_string(), VarValue::Int(2)),
            ("f.name".to_string(), VarValue::Str("Alice".to_string())),
            ("sf.copy".to_string(), VarValue::Int(2)),
        ]
    );

    // The `[emb]` reads happen AFTER the writes and reflect current state.
    assert_eq!(
        embeds(&trace.events),
        vec![
            ("f.count".to_string(), VarValue::Int(2)),
            ("f.name".to_string(), VarValue::Str("Alice".to_string())),
        ]
    );

    // Final snapshot (trace metadata) holds the cumulative state.
    assert_eq!(trace.variable("f.count"), Some(&VarValue::Int(2)));
    assert_eq!(
        trace.variable("f.name"),
        Some(&VarValue::Str("Alice".to_string()))
    );
    assert_eq!(trace.variable("sf.copy"), Some(&VarValue::Int(2)));

    // Pure storage/text fixture: no diagnostics.
    assert!(
        trace.diagnostics.is_empty(),
        "unexpected diagnostics: {:?}",
        trace.diagnostics
    );
    assert!(matches!(trace.outcome, KagOutcome::EndOfScript { .. }));
}

/// Determinism: the same script yields byte-identical JSON, and the snapshot
/// is serialised in the trace.
#[test]
fn storage_trace_is_deterministic_and_snapshot_serialises() {
    let bytes = fixture_bytes();
    let script = parse_kag(FIXTURE, &bytes);
    let a = replay_kag(&script).to_deterministic_json().expect("json a");
    let b = replay_kag(&script).to_deterministic_json().expect("json b");
    assert_eq!(a, b);
    // The snapshot + a typed value are present in the JSON surface.
    assert!(a.contains("\"variables\""), "snapshot missing from JSON");
    assert!(a.contains("\"f.count\""), "variable name missing from JSON");
    assert!(a.contains("\"int\""), "typed value missing from JSON");
}

/// BOUNDARY: reading/copying an UNBOUND variable is not defaulted to a fake
/// `0`/`""` — it is a typed `unresolved_variable` diagnostic.
#[test]
fn unbound_variable_read_is_unresolved_not_faked() {
    // `f.count` is never assigned before this increment reads it.
    let src = "[eval exp=\"f.count = f.count + 1\"]\n[emb exp=\"f.missing\"]\n";
    let trace = replay_kag(&parse_kag("unbound.ks", src.as_bytes()));

    let diags: Vec<(&str, &str)> = trace
        .diagnostics
        .iter()
        .map(|d| (d.code.as_str(), d.detail.as_str()))
        .collect();
    assert_eq!(
        diags,
        vec![
            ("utsushi.kirikiri.kag.unresolved_variable", "f.count"),
            ("utsushi.kirikiri.kag.unresolved_variable", "f.missing"),
        ]
    );
    // Nothing was assigned and nothing was embedded (no faked value).
    assert!(sets(&trace.events).is_empty());
    assert!(embeds(&trace.events).is_empty());
    assert!(trace.variables.is_empty());
}

/// BOUNDARY: expressions just past the supported shape stay
/// `unsupported_tjs_expression` — multiplication, a non-`f.`/`sf.` target, a
/// comparison, and a compound `[emb]` read.
#[test]
fn out_of_subset_expressions_are_unsupported_tjs() {
    let cases = [
        "[eval exp=\"f.x = f.y * 2\"]\n", // multiplication
        "[eval exp=\"game.x = 1\"]\n",    // non-f./sf. target
        "[eval exp=\"f.x == 1\"]\n",      // comparison, not an assignment
        "[emb exp=\"f.a + f.b\"]\n",      // compound read
    ];
    for src in cases {
        let trace = replay_kag(&parse_kag("oos.ks", src.as_bytes()));
        assert!(
            trace.has_diagnostic("utsushi.kirikiri.kag.unsupported_tjs_expression"),
            "expected unsupported_tjs_expression for: {src:?} (got {:?})",
            trace.diagnostics
        );
        assert!(
            trace.variables.is_empty(),
            "no state should change: {src:?}"
        );
    }
}

/// A single spaced `-` counter and a string→string copy both work (rounding
/// out the supported RHS forms exercised).
#[test]
fn subtraction_counter_and_variable_copy_work() {
    let src = "[eval exp=\"f.n = 5\"]\n[eval exp=\"f.n = f.n - 2\"]\n\
               [eval exp='f.s = \"hi\"']\n[eval exp=\"f.t = f.s\"]\n";
    let trace = replay_kag(&parse_kag("copy.ks", src.as_bytes()));

    assert_eq!(trace.variable("f.n"), Some(&VarValue::Int(3)));
    assert_eq!(
        trace.variable("f.t"),
        Some(&VarValue::Str("hi".to_string()))
    );
    assert!(trace.diagnostics.is_empty(), "{:?}", trace.diagnostics);
}
