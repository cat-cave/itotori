//! UTSUSHI-037 + UTSUSHI-038 acceptance — constructs OUTSIDE the supported
//! macro/storage subset surface as typed SEMANTIC diagnostics (not a crash,
//! not a silent skip, not a faked value). This pins the SUBSET BOUNDARY: each
//! `[eval]`/`[emb]` here is deliberately just past the supported form.
//!
//! Fixture is synthetic, authored, CC0 (`fixtures/unsupported_tjs.ks`). It
//! exercises an out-of-subset `[eval]` (a `*` multiplication) and `[emb]` (a
//! compound `f.a + f.b` read), an `[if]…[endif]` TJS conditional, an
//! `[iscript]…[endscript]` TJS block, an `[erasemacro]` runtime macro op, a
//! cross-`storage=` jump, and an unknown widget tag. Each must produce a
//! distinct typed diagnostic, plain text must still replay around them, and
//! the run must NOT panic.

use std::path::PathBuf;

use utsushi_kirikiri::{KagEvent, KagOutcome, parse_kag, replay_kag};

const FIXTURE: &str = "unsupported_tjs.ks";

fn fixture_bytes() -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .join(FIXTURE);
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

#[test]
fn unsupported_constructs_emit_typed_semantic_diagnostics() {
    let bytes = fixture_bytes();
    let script = parse_kag(FIXTURE, &bytes);
    let trace = replay_kag(&script);

    // Exact, ordered diagnostic stream: (code, detail).
    let actual: Vec<(&str, &str)> = trace
        .diagnostics
        .iter()
        .map(|d| (d.code.as_str(), d.detail.as_str()))
        .collect();
    assert_eq!(
        actual,
        vec![
            ("utsushi.kirikiri.kag.unsupported_tjs_expression", "eval"),
            ("utsushi.kirikiri.kag.unsupported_tjs_expression", "emb"),
            ("utsushi.kirikiri.kag.unsupported_tjs_conditional", "if"),
            ("utsushi.kirikiri.kag.unsupported_tjs_conditional", "endif"),
            ("utsushi.kirikiri.kag.unsupported_tjs_block", "iscript"),
            ("utsushi.kirikiri.kag.unsupported_macro", "erasemacro"),
            (
                "utsushi.kirikiri.kag.unsupported_cross_storage_jump",
                "other_scene.ks",
            ),
            ("utsushi.kirikiri.kag.unsupported_command", "unknownwidget"),
        ],
    );

    // Each acceptance-named code is present (queryable, not just positional).
    for code in [
        "utsushi.kirikiri.kag.unsupported_tjs_expression",
        "utsushi.kirikiri.kag.unsupported_tjs_block",
        "utsushi.kirikiri.kag.unsupported_macro",
        "utsushi.kirikiri.kag.unsupported_cross_storage_jump",
    ] {
        assert!(trace.has_diagnostic(code), "missing diagnostic: {code}");
    }
}

#[test]
fn plain_text_still_replays_around_diagnostics() {
    let bytes = fixture_bytes();
    let trace = replay_kag(&parse_kag(FIXTURE, &bytes));

    let messages: Vec<String> = trace
        .events
        .iter()
        .filter_map(|e| match e {
            KagEvent::Message { text, .. } => Some(text.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(
        messages,
        vec![
            "Plain narration replays fine.".to_string(),
            // The conditional is not evaluated, so its body replays linearly.
            "Conditional body text.".to_string(),
            "Narration after the diagnostics.".to_string(),
        ],
    );

    // The TJS `[iscript]` body ("var x = 10;" etc.) is swallowed whole — it
    // must NEVER leak into the message stream.
    for m in &messages {
        assert!(!m.contains("var x"), "TJS source leaked into text: {m}");
        assert!(!m.contains("f.total"), "TJS source leaked into text: {m}");
    }

    // The run completes (fail-soft advance), it does not halt on a diagnostic.
    assert!(matches!(trace.outcome, KagOutcome::EndOfScript { .. }));
}

#[test]
fn diagnostics_are_deterministic() {
    let bytes = fixture_bytes();
    let script = parse_kag(FIXTURE, &bytes);
    let a = replay_kag(&script).to_deterministic_json().expect("json a");
    let b = replay_kag(&script).to_deterministic_json().expect("json b");
    assert_eq!(a, b);
}
