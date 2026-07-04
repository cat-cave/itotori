//! UTSUSHI-037 acceptance — deterministic choice + jump replay trace.
//!
//! Fixture is synthetic, authored, CC0 (`fixtures/choices_and_jumps.ks`).
//! Asserts a `[link]…[endlink]` choice menu presents both options with the
//! `*label` each jumps to, that the deterministic selection policy picks a
//! reproducible option, and that the chosen option's jump lands on the right
//! branch (`selection 0 -> *left`, `selection 1 -> *right`). Same script +
//! same selections => byte-identical JSON.

use std::path::PathBuf;

use utsushi_kirikiri::{
    ChoiceOption, KagEvent, KagOutcome, KagReplayOpts, parse_kag, replay_kag_with_opts,
};

const FIXTURE: &str = "choices_and_jumps.ks";

fn fixture_bytes() -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .join(FIXTURE);
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

fn opts(selections: Vec<usize>) -> KagReplayOpts {
    KagReplayOpts {
        selections,
        ..KagReplayOpts::default()
    }
}

fn jumps(events: &[KagEvent]) -> Vec<(Option<String>, String)> {
    events
        .iter()
        .filter_map(|e| match e {
            KagEvent::Jump {
                from_label,
                to_label,
            } => Some((from_label.clone(), to_label.clone())),
            _ => None,
        })
        .collect()
}

fn only_choice(events: &[KagEvent]) -> (Vec<ChoiceOption>, usize) {
    let mut found = None;
    for e in events {
        if let KagEvent::Choice { options, selected } = e {
            assert!(found.is_none(), "expected exactly one choice menu");
            found = Some((options.clone(), *selected));
        }
    }
    found.expect("no choice menu recorded")
}

fn messages(events: &[KagEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|e| match e {
            KagEvent::Message { text, .. } => Some(text.clone()),
            _ => None,
        })
        .collect()
}

#[test]
fn choice_options_carry_their_jump_targets() {
    let bytes = fixture_bytes();
    let script = parse_kag(FIXTURE, &bytes);
    let trace = replay_kag_with_opts(&script, &opts(vec![0]));

    let (options, selected) = only_choice(&trace.events);
    assert_eq!(selected, 0);
    assert_eq!(
        options,
        vec![
            ChoiceOption {
                text: "Take the left road".to_string(),
                target: "left".to_string(),
            },
            ChoiceOption {
                text: "Take the right road".to_string(),
                target: "right".to_string(),
            },
        ]
    );
    assert!(trace.diagnostics.is_empty());
    assert!(matches!(trace.outcome, KagOutcome::EndOfScript { .. }));
}

#[test]
fn selection_zero_follows_left_branch() {
    let bytes = fixture_bytes();
    let script = parse_kag(FIXTURE, &bytes);
    let trace = replay_kag_with_opts(&script, &opts(vec![0]));

    assert_eq!(
        jumps(&trace.events),
        vec![
            (Some("start".to_string()), "menu".to_string()),
            (Some("menu".to_string()), "left".to_string()),
            (Some("left".to_string()), "end".to_string()),
        ]
    );
    assert_eq!(
        messages(&trace.events),
        vec![
            "Which path will you take?".to_string(),
            "The left road is quiet and cool.".to_string(),
            "And so the walk concludes.".to_string(),
        ]
    );
}

#[test]
fn selection_one_follows_right_branch() {
    let bytes = fixture_bytes();
    let script = parse_kag(FIXTURE, &bytes);
    let trace = replay_kag_with_opts(&script, &opts(vec![1]));

    assert_eq!(
        jumps(&trace.events),
        vec![
            (Some("start".to_string()), "menu".to_string()),
            (Some("menu".to_string()), "right".to_string()),
            (Some("right".to_string()), "end".to_string()),
        ]
    );
    assert_eq!(
        messages(&trace.events),
        vec![
            "Which path will you take?".to_string(),
            "The right road is bright and loud.".to_string(),
            "And so the walk concludes.".to_string(),
        ]
    );
}

#[test]
fn same_selections_yield_identical_json() {
    let bytes = fixture_bytes();
    let script = parse_kag(FIXTURE, &bytes);
    let a = replay_kag_with_opts(&script, &opts(vec![1]))
        .to_deterministic_json()
        .expect("json a");
    let b = replay_kag_with_opts(&script, &opts(vec![1]))
        .to_deterministic_json()
        .expect("json b");
    assert_eq!(a, b);

    // Different selection => different trace (the policy actually steers).
    let left = replay_kag_with_opts(&script, &opts(vec![0]))
        .to_deterministic_json()
        .expect("json left");
    assert_ne!(a, left);
}
