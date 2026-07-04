//! UTSUSHI-038 acceptance — KAG macro DEFINITION + invocation expansion (the
//! bounded `%param` subset), and the subset BOUNDARY (unresolved params and
//! runaway recursion stay typed diagnostics, never a faked expansion).
//!
//! File fixture is synthetic, authored, CC0 (`fixtures/macro_expansion.ks`);
//! the boundary cases use inline authored byte snippets so the exact shape is
//! visible in the test.

use std::path::PathBuf;

use utsushi_kirikiri::{KagEvent, KagOutcome, parse_kag, replay_kag};

const FIXTURE: &str = "macro_expansion.ks";

fn fixture_bytes() -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .join(FIXTURE);
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

fn messages(events: &[KagEvent]) -> Vec<(String, Option<String>)> {
    events
        .iter()
        .filter_map(|e| match e {
            KagEvent::Message { text, speaker } => Some((text.clone(), speaker.clone())),
            _ => None,
        })
        .collect()
}

fn speaker_changes(events: &[KagEvent]) -> Vec<Option<String>> {
    events
        .iter()
        .filter_map(|e| match e {
            KagEvent::SpeakerChange { speaker } => Some(speaker.clone()),
            _ => None,
        })
        .collect()
}

/// Acceptance (1): a macro-definition + invocation fixture → the trace shows
/// the EXPANDED body per golden (not the raw invocation, not a diagnostic).
#[test]
fn macro_invocation_expands_its_body_with_params() {
    let bytes = fixture_bytes();
    let script = parse_kag(FIXTURE, &bytes);
    let trace = replay_kag(&script);

    // The expanded body of BOTH invocations, with %who substituted.
    assert_eq!(
        messages(&trace.events),
        vec![
            ("Hello, I am Alice.".to_string(), Some("Alice".to_string())),
            ("Hello, I am Bob.".to_string(), Some("Bob".to_string())),
        ]
    );
    // The `#%who` body line expanded to a real speaker change per invocation.
    assert_eq!(
        speaker_changes(&trace.events),
        vec![Some("Alice".to_string()), Some("Bob".to_string())]
    );

    // The raw invocation tag must NOT leak as text, and expansion is NOT a
    // diagnostic.
    for (text, _) in messages(&trace.events) {
        assert!(!text.contains("greet"), "raw invocation leaked: {text}");
        assert!(!text.contains('%'), "unsubstituted param leaked: {text}");
    }
    assert!(
        trace.diagnostics.is_empty(),
        "expansion must not diagnose: {:?}",
        trace.diagnostics
    );
    assert!(matches!(trace.outcome, KagOutcome::EndOfScript { .. }));
}

/// Determinism: the same script yields byte-identical JSON.
#[test]
fn macro_expansion_is_deterministic() {
    let bytes = fixture_bytes();
    let script = parse_kag(FIXTURE, &bytes);
    let a = replay_kag(&script).to_deterministic_json().expect("json a");
    let b = replay_kag(&script).to_deterministic_json().expect("json b");
    assert_eq!(a, b);
}

/// A `%param|default` supplies a default when the invocation omits the
/// attribute, and the invocation attribute overrides the default.
#[test]
fn macro_param_default_is_honored_and_overridden() {
    let src = "[macro name=\"sign\"]\nSigned by %who|Nobody\n[endmacro]\n\
               [sign who=\"Alice\"]\n[sign]\n";
    let trace = replay_kag(&parse_kag("defaults.ks", src.as_bytes()));

    assert_eq!(
        messages(&trace.events)
            .into_iter()
            .map(|(t, _)| t)
            .collect::<Vec<_>>(),
        vec![
            "Signed by Alice".to_string(),
            "Signed by Nobody".to_string()
        ]
    );
    assert!(trace.diagnostics.is_empty(), "{:?}", trace.diagnostics);
}

/// BOUNDARY: an invocation that leaves a `%param` unresolved (no attribute, no
/// default) is NOT faked — it is a typed `unsupported_macro` diagnostic and no
/// body (and no leaked `%param`) is emitted.
#[test]
fn unresolved_macro_param_is_a_typed_diagnostic_not_a_fake() {
    let src = "[macro name=\"greet\"]\nHello, %who.\n[endmacro]\n[greet]\n";
    let trace = replay_kag(&parse_kag("unresolved.ks", src.as_bytes()));

    assert!(
        messages(&trace.events).is_empty(),
        "no body should be emitted for an unresolvable invocation"
    );
    let diags: Vec<(&str, &str)> = trace
        .diagnostics
        .iter()
        .map(|d| (d.code.as_str(), d.detail.as_str()))
        .collect();
    assert_eq!(
        diags,
        vec![("utsushi.kirikiri.kag.unsupported_macro", "greet")]
    );
}

/// BOUNDARY: a self-recursive macro cannot expand without bound; it terminates
/// deterministically with a typed `unsupported_macro` diagnostic (no hang, no
/// panic).
#[test]
fn recursive_macro_terminates_with_a_diagnostic() {
    let src = "[macro name=\"loop\"]\ntick\n[loop]\n[endmacro]\n[loop]\n";
    let trace = replay_kag(&parse_kag("recursion.ks", src.as_bytes()));

    assert!(
        trace.has_diagnostic("utsushi.kirikiri.kag.unsupported_macro"),
        "recursion guard must record a diagnostic"
    );
    // It produced SOME "tick" lines (bounded expansion) and then stopped.
    let ticks = messages(&trace.events).len();
    assert!(ticks > 0 && ticks < 1000, "bounded tick count, got {ticks}");
    assert!(matches!(trace.outcome, KagOutcome::EndOfScript { .. }));
}
