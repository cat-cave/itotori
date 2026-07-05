//! Golden-trace acceptance for the UTSUSHI-033 MV/MZ message + choice replay
//! PACK.
//!
//! Each case loads a synthetic pack document (a raw MV/MZ event `list[]` plus
//! the Itotori source-unit-link and route-map-alignment overlays), replays it
//! through [`utsushi_rpgmaker_mv::replay_pack`], and asserts the deterministic
//! trace against a committed golden JSON. The trace equality is the primary
//! acceptance; targeted assertions then pin the load-bearing crux:
//!
//! - message commands emit declared text events WITH source unit links,
//! - choice options align to Itotori route-map ids,
//! - an out-of-subset command surfaces a typed diagnostic (no silent skip).
//!
//! All fixtures are SYNTHETIC — hand-authored `{code, parameters}` lists using
//! the public MV/MZ command-code constants plus hand-authored Itotori
//! overlays. No copyrighted game JSON is involved. Compared as parsed
//! `Value`s so biome formatting of the golden files does not matter.

use std::path::PathBuf;

use serde_json::Value;
use utsushi_rpgmaker_mv::{DiagnosticReason, LinkedEvent, ReplayPack, UnknownPolicy, replay_pack};

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("replay")
}

fn load_pack(stem: &str) -> ReplayPack {
    let path = fixture_dir().join(format!("{stem}.pack.json"));
    let display = path.display();
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {display}: {e}"));
    let document: Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {display}: {e}"));
    ReplayPack::from_json(&document).unwrap_or_else(|e| panic!("pack {display} malformed: {e}"))
}

fn load_golden(stem: &str) -> Value {
    let path = fixture_dir().join(format!("{stem}.trace.json"));
    let display = path.display();
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {display}: {e}"));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {display}: {e}"))
}

/// Replay a pack and assert its trace JSON equals the committed golden.
fn assert_golden(stem: &str) {
    let pack = load_pack(stem);
    let outcome = replay_pack(&pack, UnknownPolicy::SkipWithDiagnostic)
        .unwrap_or_else(|d| panic!("replay {stem} unexpectedly failed: {d}"));
    let actual = outcome.to_trace_json();
    let expected = load_golden(stem);
    assert_eq!(
        actual, expected,
        "pack trace for `{stem}` diverged from golden\n actual:   {actual}\n expected: {expected}"
    );
}

#[test]
fn message_links_golden_trace() {
    assert_golden("pack_message_links");
}

#[test]
fn choice_routes_golden_trace() {
    assert_golden("pack_choice_routes");
}

#[test]
fn unsupported_pack_golden_trace() {
    assert_golden("pack_unsupported");
}

#[test]
fn message_events_carry_source_unit_links() {
    // Crux #1: every declared text event links to its source bridge unit.
    let pack = load_pack("pack_message_links");
    let outcome = replay_pack(&pack, UnknownPolicy::SkipWithDiagnostic).unwrap();
    let texts: Vec<_> = outcome
        .linked_events
        .iter()
        .filter_map(|event| match event {
            LinkedEvent::Text(text) => Some(text),
            LinkedEvent::Choice(_) => None,
        })
        .collect();
    assert_eq!(texts.len(), 2, "two message windows expected");
    for text in &texts {
        let link = text
            .link
            .as_ref()
            .expect("every text event carries a source unit link");
        assert!(
            link.source_unit_key.starts_with("mvmz."),
            "source unit key names the decoded unit"
        );
        assert!(
            link.bridge_unit_id.is_some(),
            "the minted bridge unit id is threaded through"
        );
    }
}

#[test]
fn choice_options_align_to_route_map_ids() {
    // Crux #2: each choice option aligns to an Itotori route-map id (routeKey),
    // and the two options fan out to *distinct* routes.
    let pack = load_pack("pack_choice_routes");
    let outcome = replay_pack(&pack, UnknownPolicy::SkipWithDiagnostic).unwrap();
    let choice = outcome
        .linked_events
        .iter()
        .find_map(|event| match event {
            LinkedEvent::Choice(choice) => Some(choice),
            LinkedEvent::Text(_) => None,
        })
        .expect("a choice event is present");
    assert_eq!(choice.options.len(), 2);
    let routes: Vec<&str> = choice
        .options
        .iter()
        .map(|option| {
            option
                .route_key
                .as_deref()
                .expect("every choice option aligns to a route-map id")
        })
        .collect();
    assert_eq!(routes, vec!["route.forest.yuki", "route.mountain.sora"]);
    // The option label also links back to its own source unit.
    assert!(
        choice.options.iter().all(|option| option.link.is_some()),
        "each option label links to its source unit"
    );
}

#[test]
fn unsupported_command_in_pack_is_never_silently_dropped() {
    // Crux #3: an out-of-subset command surfaces a typed diagnostic under the
    // skip policy and aborts under the fail policy — never a silent gap.
    let pack = load_pack("pack_unsupported");

    let outcome = replay_pack(&pack, UnknownPolicy::SkipWithDiagnostic).unwrap();
    assert_eq!(
        outcome.base.diagnostics.len(),
        2,
        "the 356 and 205 commands each surface a diagnostic"
    );
    assert!(
        outcome
            .base
            .diagnostics
            .iter()
            .any(|d| d.code == 356
                && d.reason == DiagnosticReason::CommandOutsideSubset { code: 356 })
    );
    assert!(
        outcome
            .base
            .diagnostics
            .iter()
            .any(|d| d.code == 205
                && d.reason == DiagnosticReason::CommandOutsideSubset { code: 205 })
    );
    // The surrounding subset still applied: the supported 121 switch took hold
    // and the linked message survived with its link.
    assert!(outcome.base.state.switch(1));
    assert_eq!(outcome.linked_events.len(), 1);

    // Fail policy: the first out-of-subset command aborts with the diagnostic.
    let err = replay_pack(&pack, UnknownPolicy::Fail).unwrap_err();
    assert_eq!(err.code, 356);
}
