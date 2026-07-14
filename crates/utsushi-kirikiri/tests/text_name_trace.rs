//! Acceptance — deterministic text + name-state replay trace.
//!
//! Fixture is synthetic, authored, CC0 (`fixtures/text_and_names.ks`); no
//! retail KiriKiri bytes. Asserts:
//!
//! 1. the replay emits the expected `(message text, speaker)` sequence, with
//!    the speaker tracking the active `#name` (set, voice/display split, and
//!    bare-`#` reset);
//! 2. the same script produces byte-identical deterministic JSON across two
//!    runs;
//! 3. CROSS-VALIDATION against the independent `.ks` parser: the
//!    replay's message text + speaker sequence reproduces
//!    `kaifuu_kirikiri::parse_ks`'s authoritative dialogue-unit extraction
//!    byte-for-byte (proving the dialect reuse against real parse output
//!    not by production linkage).

use std::path::PathBuf;

use utsushi_kirikiri::{KagEncoding, KagEvent, KagOutcome, parse_kag, replay_kag};

const FIXTURE: &str = "text_and_names.ks";

fn fixture_bytes() -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .join(FIXTURE);
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

#[test]
fn deterministic_text_and_name_trace() {
    let bytes = fixture_bytes();
    let script = parse_kag(FIXTURE, &bytes);
    assert_eq!(script.encoding, KagEncoding::Utf8);
    let trace = replay_kag(&script);

    // The message stream: (text, active speaker).
    let expected: Vec<(&str, Option<&str>)> = vec![
        ("A quiet morning at the terminal.", None),
        ("Good morning, world.", Some("Alice")),
        ("This line", Some("Alice")),
        (" continues after a tag.", Some("Alice")),
        ("Ah, Alice. You are early today.", Some("Bob Sensei")),
        ("Narration returns once the speaker is cleared.", None),
    ];
    let actual: Vec<(String, Option<String>)> = trace.message_texts_with_speakers();
    let actual_ref: Vec<(&str, Option<&str>)> = actual
        .iter()
        .map(|(t, s)| (t.as_str(), s.as_deref()))
        .collect();
    assert_eq!(actual_ref, expected);

    // Name-state timeline: every `#name` transition is explicit.
    let speaker_changes: Vec<Option<&str>> = trace
        .events
        .iter()
        .filter_map(|e| match e {
            KagEvent::SpeakerChange { speaker } => Some(speaker.as_deref()),
            _ => None,
        })
        .collect();
    assert_eq!(
        speaker_changes,
        vec![Some("Alice"), Some("Bob Sensei"), None]
    );

    // Clean text+name fixture: no choices, jumps, or diagnostics.
    assert!(
        trace.diagnostics.is_empty(),
        "unexpected diagnostics: {:?}",
        trace.diagnostics
    );
    assert!(matches!(trace.outcome, KagOutcome::EndOfScript { .. }));
}

#[test]
fn same_script_yields_identical_json() {
    let bytes = fixture_bytes();
    let script = parse_kag(FIXTURE, &bytes);
    let a = replay_kag(&script).to_deterministic_json().expect("json a");
    let b = replay_kag(&script).to_deterministic_json().expect("json b");
    assert_eq!(a, b, "replay JSON must be byte-identical across runs");
    // Re-parsing the same bytes also reproduces the trace.
    let c = replay_kag(&parse_kag(FIXTURE, &bytes))
        .to_deterministic_json()
        .expect("json c");
    assert_eq!(a, c);
}

/// Cross-validation oracle: the independent parser must agree with
/// this crate's replay on `(dialogue text, speaker)`.
#[test]
fn replay_matches_kaifuu_009_dialogue_extraction() {
    let bytes = fixture_bytes();

    // This crate's replay.
    let trace = replay_kag(&parse_kag(FIXTURE, &bytes));
    let replay_pairs = trace.message_texts_with_speakers();

    // the extraction parser (the dev-dependency oracle).
    let doc = kaifuu_kirikiri::parse_ks(FIXTURE, &bytes);
    let kaifuu_pairs: Vec<(String, Option<String>)> = doc
        .dialogue_units()
        .map(|u| (u.source_text.clone(), u.speaker.clone()))
        .collect();

    assert_eq!(
        replay_pairs, kaifuu_pairs,
        "replay message/speaker stream must reproduce KAIFUU-009's dialogue units"
    );
    assert!(
        !kaifuu_pairs.is_empty(),
        "oracle produced no dialogue units"
    );
}
