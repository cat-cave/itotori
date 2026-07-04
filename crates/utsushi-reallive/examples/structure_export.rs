//! Narrative-structure exporter (`itotori-structure-informed-context-building`).
//!
//! CONSUMES the deterministic Kaifuu/Utsushi decode — the scene-dispatch
//! graph, the choice/branch subsystem, the `#NAMAE` speaker decode, and the
//! per-scene play-order message stream — and emits a single deterministic
//! JSON `NarrativeStructure` artifact. The itotori context-building stage
//! CONSUMES that KNOWN structure (it does NOT re-infer structure from the
//! prose): per-scene summaries, a route/branch map, and character-arc
//! tracking are all built from this artifact downstream.
//!
//! Every field here is READ verbatim from the decode APIs — no re-inference:
//!   * scene-dispatch GRAPH — [`ReplayEngine::observe_playthrough`] follows
//!     the real `jump`/`farcall`/return edges across scene boundaries and
//!     records each segment's `first_cross_scene` (the "next scene").
//!   * per-scene MESSAGE STREAM — each segment's
//!     [`PortObservation::play_order_lines`] (single-pass play order).
//!   * SPEAKERS — each [`TextLine::speaker`] (the `【…】`/`#NAMAE` decode),
//!     installed via [`ReplayEngine::with_namae_resolver`].
//!   * CHOICES + BRANCHES — the play-order `select {}` option lines are
//!     tagged `text_surface = "choice:<idx>"`; for each option index the
//!     branch-following walk under [`HeadlessChoicePolicy::Fixed`] records
//!     which subsequent messages that choice leads into.
//!
//! Run (real bytes, READ-ONLY; the emitted JSON carries copyrighted text so
//! it is written OUTSIDE the repo, never committed):
//!   cargo run -p utsushi-reallive --example structure_export -- \
//!     <Gameexe.ini> <Seen.txt> [max_scenes] > /scratch/.../structure.json

use std::collections::BTreeSet;
use std::path::PathBuf;

use serde_json::{Map, Value, json};
use utsushi_core::TextLine;
use utsushi_reallive::{
    Gameexe, HeadlessChoicePolicy, ReplayEngine, ReplayOpts, build_scene_store_from_decompressed,
    decompress_all_scenes,
};

const CHOICE_SURFACE_PREFIX: &str = "choice:";

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!(
            "usage: structure_export <Gameexe.ini> <Seen.txt> [max_scenes]\n\
             emits a deterministic NarrativeStructure JSON on stdout"
        );
        std::process::exit(2);
    }
    let gameexe_path = PathBuf::from(&args[1]);
    let seen_path = PathBuf::from(&args[2]);
    let max_scenes: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(8);

    let gameexe_bytes = std::fs::read(&gameexe_path).expect("read Gameexe.ini");
    let gameexe = Gameexe::parse(&gameexe_bytes).expect("parse Gameexe.ini");
    let seen_start = u16::try_from(gameexe.get_int("SEEN_START").expect("Gameexe #SEEN_START"))
        .expect("SEEN_START fits u16");
    let resolver = gameexe.namae_resolver();

    let seen_bytes = std::fs::read(&seen_path).expect("read Seen.txt");
    let index_len = utsushi_reallive::RealSceneIndex::parse(&seen_bytes)
        .expect("parse scene index")
        .entries
        .len();
    let decompressed = decompress_all_scenes(&seen_bytes).expect("decompress scenes");
    let (store, shift_jis, _stats) =
        build_scene_store_from_decompressed(&decompressed, index_len).expect("build scene store");
    let engine = ReplayEngine::from_store(store, shift_jis).with_namae_resolver(resolver);

    let opts = ReplayOpts {
        step_budget: 400_000,
        stop_at_first_pause: false,
    };

    // `survey`: print per-scene (message, choice) counts to stderr so the
    // operator can pick a rich story entry scene. Read-only reconnaissance;
    // no copyrighted text is emitted (counts only).
    if args.get(3).map(String::as_str) == Some("survey") {
        for scene_id in engine.scene_ids() {
            let obs = engine.observe_for_port(scene_id, &opts);
            let choices = choice_option_indices(&obs.play_order_lines).len();
            let msgs = obs
                .play_order_lines
                .iter()
                .filter(|l| !is_choice_line(l))
                .count();
            if msgs > 0 || choices > 0 {
                eprintln!(
                    "scene {scene_id}: messages={msgs} choiceOptions={choices} next={:?}",
                    obs.first_cross_scene
                );
            }
        }
        return;
    }

    // Entry scene: explicit override (arg 4) else Gameexe #SEEN_START.
    let entry = args
        .get(4)
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(seen_start);

    // Scene-dispatch GRAPH + per-scene MESSAGE STREAM (play order, single
    // pass) + SPEAKERS — all read verbatim from observe_playthrough.
    let playthrough = engine.observe_playthrough(entry, &opts, max_scenes);

    let mut scenes: Vec<Value> = Vec::new();
    for i in 0..playthrough.segments.len() {
        let segment = &playthrough.segments[i];
        let scene_id = segment.scene_id;
        // The "next scene" is this segment's followed cross-scene dispatch
        // target; fall back to the next segment in dispatch order.
        let next_scene = segment
            .observation
            .first_cross_scene
            .or_else(|| playthrough.segments.get(i + 1).map(|next| next.scene_id));

        let messages: Vec<Value> = segment
            .observation
            .play_order_lines
            .iter()
            .enumerate()
            .map(|(order, line)| message_json(order, line))
            .collect();

        // CHOICES + BRANCHES: the play-order option lines are tagged
        // `choice:<idx>`. For each distinct option index the branch-following
        // walk under Fixed(idx) records which messages that choice leads into.
        let choice_indices = choice_option_indices(&segment.observation.play_order_lines);
        let mut choices: Vec<Value> = Vec::new();
        for idx in &choice_indices {
            let label = choice_label(&segment.observation.play_order_lines, *idx);
            let branch_lines =
                engine.branch_following_lines(scene_id, &opts, HeadlessChoicePolicy::Fixed(*idx));
            let branch_messages: Vec<Value> = branch_lines
                .iter()
                .filter(|line| !is_choice_line(line))
                .enumerate()
                .map(|(order, line)| message_json(order, line))
                .collect();
            choices.push(json!({
                "optionIndex": idx,
                "label": label,
                "branchMessages": branch_messages,
            }));
        }

        let mut scene = Map::new();
        scene.insert("sceneId".into(), json!(scene_id));
        scene.insert(
            "nextScene".into(),
            match next_scene {
                Some(id) => json!(id),
                None => Value::Null,
            },
        );
        scene.insert("messages".into(), Value::Array(messages));
        scene.insert("choices".into(), Value::Array(choices));
        scenes.push(Value::Object(scene));
    }

    let out = json!({
        "schemaVersion": "utsushi.narrative-structure.v1",
        "entryScene": entry,
        "sceneDispatchOrder": playthrough.scene_ids(),
        "scenes": scenes,
    });

    println!(
        "{}",
        serde_json::to_string_pretty(&out).expect("serialize narrative structure")
    );
}

fn message_json(order: usize, line: &TextLine) -> Value {
    let mut msg = Map::new();
    msg.insert("order".into(), json!(order));
    match &line.speaker {
        Some(name) => msg.insert("speaker".into(), json!(name)),
        None => msg.insert("speaker".into(), Value::Null),
    };
    msg.insert("text".into(), json!(line.text));
    match &line.text_surface {
        Some(surface) => msg.insert("textSurface".into(), json!(surface)),
        None => msg.insert("textSurface".into(), Value::Null),
    };
    Value::Object(msg)
}

fn is_choice_line(line: &TextLine) -> bool {
    line.text_surface
        .as_deref()
        .is_some_and(|s| s.starts_with(CHOICE_SURFACE_PREFIX))
}

/// The distinct option indices offered by this scene's `select {}` prompt(s),
/// read from the `choice:<idx>` play-order tags (ascending, de-duplicated).
fn choice_option_indices(lines: &[TextLine]) -> Vec<u16> {
    let mut set: BTreeSet<u16> = BTreeSet::new();
    for line in lines {
        if let Some(surface) = line.text_surface.as_deref()
            && let Some(rest) = surface.strip_prefix(CHOICE_SURFACE_PREFIX)
        {
            // `choice:<idx>` optionally suffixed with `/<hint>`; take the
            // leading integer.
            let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
            if let Ok(idx) = digits.parse::<u16>() {
                set.insert(idx);
            }
        }
    }
    set.into_iter().collect()
}

fn choice_label(lines: &[TextLine], idx: u16) -> String {
    let tag = format!("{CHOICE_SURFACE_PREFIX}{idx}");
    lines
        .iter()
        .find(|line| {
            line.text_surface
                .as_deref()
                .is_some_and(|s| s == tag || s.starts_with(&format!("{tag}/")))
        })
        .map(|line| line.text.clone())
        .unwrap_or_default()
}
