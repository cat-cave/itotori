//! Surface-identity coverage for the runtime-only choice emitter.
//!
//! These pin the invariant that broke the whole export on a real archive: a
//! play loop that re-enters the same system menu observes the same prompt many
//! times, and one entry per observation collides thousands of `choiceId`s in a
//! single scene. The structure consumer keys choices by that id and rejects a
//! repeat, so a duplicate here is not cosmetic — it fails the export.

use std::collections::HashSet;

use utsushi_core::{EvidenceTier, TextLine};
use utsushi_reallive::{LongOpId, SelectionPrompt, SelectionPromptKind};

use super::runtime_only_choices;

fn line(line_id: &str, text: &str) -> TextLine {
    TextLine {
        line_id: line_id.to_string(),
        evidence_tier: EvidenceTier::E1,
        text: text.to_string(),
        speaker: None,
        color: None,
        text_surface: None,
        bridge_ref: None,
        source_asset: None,
        byte_offset_in_scene: None,
        body_shift_jis: None,
    }
}

/// One prompt display: the same byte offset and the same option line ids every
/// time the loop re-enters it.
fn prompt(byte_offset_in_scene: u32, option_line_ids: &[&str]) -> SelectionPrompt {
    SelectionPrompt {
        longop_id: LongOpId(1),
        byte_offset_in_scene,
        kind: SelectionPromptKind::Text,
        cancelable: false,
        option_line_ids: option_line_ids
            .iter()
            .copied()
            .map(str::to_string)
            .collect(),
    }
}

fn choice_ids(values: &[(serde_json::Value, crate::structure::graph::Edge)]) -> Vec<String> {
    values
        .iter()
        .map(|(value, _)| value["choiceId"].as_str().expect("choiceId").to_string())
        .collect()
}

/// The regression: a re-displayed prompt is ONE surface. Drop the dedupe and
/// this returns 200 entries carrying 2 distinct ids.
#[test]
fn a_redisplayed_prompt_emits_each_surface_once() {
    let lines = vec![line("line-0", "yes"), line("line-1", "no")];
    let prompts: Vec<SelectionPrompt> = (0..100)
        .map(|_| prompt(3141, &["line-0", "line-1"]))
        .collect();

    let emitted = runtime_only_choices(4, &prompts, &lines, &|_| false).expect("emit");
    let ids = choice_ids(&emitted);

    assert_eq!(
        ids.len(),
        2,
        "100 displays of a 2-option prompt are 2 surfaces, not {}",
        ids.len()
    );
    assert_eq!(
        ids.iter().collect::<HashSet<_>>().len(),
        ids.len(),
        "choiceId must be unique within a scene; got {ids:?}"
    );
    assert_eq!(
        ids,
        vec![
            "choice:runtime:scene-0004:prompt-3141:option-0".to_string(),
            "choice:runtime:scene-0004:prompt-3141:option-1".to_string(),
        ]
    );
}

/// Deduping must not collapse genuinely distinct surfaces: two prompts at
/// different scene byte offsets are two surfaces even with identical labels.
#[test]
fn distinct_prompt_offsets_stay_distinct_surfaces() {
    let lines = vec![line("line-0", "yes"), line("line-1", "no")];
    let prompts = vec![
        prompt(3141, &["line-0", "line-1"]),
        prompt(3907, &["line-0", "line-1"]),
        prompt(3141, &["line-0", "line-1"]),
    ];

    let ids = choice_ids(&runtime_only_choices(4, &prompts, &lines, &|_| false).expect("emit"));

    assert_eq!(ids.len(), 4, "two prompts × two options = 4 surfaces");
    assert_eq!(ids.iter().collect::<HashSet<_>>().len(), 4, "{ids:?}");
}

/// An option that already has a static BridgeUnit belongs to the bridge-linked
/// path and must not be emitted here at all.
#[test]
fn bridge_linked_options_are_left_to_the_linked_path() {
    let lines = vec![line("line-0", "yes"), line("line-1", "no")];
    let prompts = vec![prompt(3141, &["line-0", "line-1"])];

    let emitted =
        runtime_only_choices(4, &prompts, &lines, &|line_id| line_id == "line-0").expect("emit");

    assert_eq!(
        choice_ids(&emitted),
        vec!["choice:runtime:scene-0004:prompt-3141:option-1".to_string()]
    );
}

/// A prompt naming a line the replay stream never produced is a decode
/// inconsistency, not something to silently drop.
#[test]
fn a_missing_replay_line_fails_loud() {
    let prompts = vec![prompt(3141, &["line-absent"])];
    let err = runtime_only_choices(4, &prompts, &[], &|_| false).expect_err("must refuse");
    assert!(err.contains("line-absent"), "{err}");
}
