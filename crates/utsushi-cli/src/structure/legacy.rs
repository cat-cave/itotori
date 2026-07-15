use std::collections::{BTreeSet, HashMap};

use serde_json::{Map, Value, json};
use utsushi_core::TextLine;
use utsushi_reallive::{
    DecompressedScene, HeadlessChoicePolicy, ReplayEngine, ReplayOpts, SceneId,
};

use super::graph;
use super::output::selection_control_signal;

const CHOICE_SURFACE_PREFIX: &str = "choice:";
const BRANCH_PREVIEW_MESSAGES: usize = 40;

pub(super) fn build(
    engine: &ReplayEngine,
    decoded_scenes: &[DecompressedScene],
    entry: SceneId,
) -> Result<Value, String> {
    let opts = ReplayOpts {
        step_budget: 400_000,
        stop_at_first_pause: false,
    };
    let all_scene_ids: BTreeSet<SceneId> =
        decoded_scenes.iter().map(|scene| scene.scene_id).collect();
    let bytecode_by_scene: HashMap<SceneId, &[u8]> = decoded_scenes
        .iter()
        .map(|scene| (scene.scene_id, scene.bytecode.as_slice()))
        .collect();
    let roots = std::iter::once(entry).chain(
        all_scene_ids
            .iter()
            .copied()
            .filter(|scene| *scene != entry),
    );
    let mut scenes = Vec::new();
    let mut dispatch_order = Vec::new();
    let mut visited = BTreeSet::new();
    for root in roots {
        if visited.contains(&root) {
            continue;
        }
        let playthrough = engine.observe_playthrough(root, &opts, all_scene_ids.len());
        for (index, segment) in playthrough.segments.iter().enumerate() {
            if !visited.insert(segment.scene_id) {
                continue;
            }
            if !segment.observation.scene.reached_natural_terminus {
                return Err(format!(
                    "utsushi.structure.replay_truncated: scene {} did not reach a natural terminus",
                    segment.scene_id
                ));
            }
            let bytecode = bytecode_by_scene.get(&segment.scene_id).ok_or_else(|| {
                format!("decoded bytecode missing for scene {}", segment.scene_id)
            })?;
            scenes.push(scene_value(
                engine,
                &opts,
                segment.scene_id,
                segment.observation.first_cross_scene.or_else(|| {
                    playthrough
                        .segments
                        .get(index + 1)
                        .map(|next| next.scene_id)
                }),
                &segment.observation.play_order_lines,
                bytecode,
            )?);
            dispatch_order.push(segment.scene_id);
        }
    }
    if visited != all_scene_ids {
        return Err(format!(
            "utsushi.structure.incomplete_scene_coverage: archive={} emitted={}",
            all_scene_ids.len(),
            visited.len()
        ));
    }
    Ok(json!({
        "schemaVersion": "utsushi.narrative-structure.v1",
        "entryScene": entry,
        "sceneDispatchOrder": dispatch_order,
        "scenes": scenes,
    }))
}

fn scene_value(
    engine: &ReplayEngine,
    opts: &ReplayOpts,
    scene_id: SceneId,
    next_scene: Option<SceneId>,
    lines: &[TextLine],
    bytecode: &[u8],
) -> Result<Value, String> {
    let messages: Vec<Value> = lines
        .iter()
        .enumerate()
        .map(|(order, line)| legacy_message(order, line))
        .collect();
    let mut choices = Vec::new();
    for index in choice_option_indices(lines) {
        let branch =
            engine.branch_following_observation(scene_id, opts, HeadlessChoicePolicy::Fixed(index));
        let branch_messages =
            dedup_consecutive(branch.lines.iter().filter(|line| !is_choice_line(line)))
                .into_iter()
                .take(BRANCH_PREVIEW_MESSAGES)
                .enumerate()
                .map(|(order, line)| legacy_message(order, line))
                .collect::<Vec<_>>();
        choices.push(json!({
            "optionIndex": index,
            "label": choice_label(lines, index),
            "branchEntryScene": branch.first_cross_scene,
            "branchMessages": branch_messages,
        }));
    }
    let static_edges = graph::static_edges(scene_id, bytecode)?;
    Ok(json!({
        "sceneId": scene_id,
        "selectionControl": selection_control_signal(bytecode)?,
        "nextScene": next_scene,
        "dispatchFanoutScenes": graph::resolved_fanout(&static_edges, scene_id),
        "messages": messages,
        "choices": choices,
    }))
}

fn legacy_message(order: usize, line: &TextLine) -> Value {
    let mut message = Map::new();
    message.insert("order".into(), json!(order));
    message.insert(
        "speaker".into(),
        line.speaker
            .as_ref()
            .map_or(Value::Null, |value| json!(value)),
    );
    message.insert("text".into(), json!(line.text));
    message.insert(
        "textSurface".into(),
        line.text_surface
            .as_ref()
            .map_or(Value::Null, |value| json!(value)),
    );
    Value::Object(message)
}

fn choice_option_indices(lines: &[TextLine]) -> Vec<u16> {
    lines
        .iter()
        .filter_map(|line| line.text_surface.as_deref())
        .filter_map(|surface| surface.strip_prefix(CHOICE_SURFACE_PREFIX))
        .filter_map(|rest| {
            rest.chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>()
                .parse()
                .ok()
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn choice_label(lines: &[TextLine], index: u16) -> String {
    let tag = format!("{CHOICE_SURFACE_PREFIX}{index}");
    lines
        .iter()
        .find(|line| {
            line.text_surface
                .as_deref()
                .is_some_and(|surface| surface == tag || surface.starts_with(&format!("{tag}/")))
        })
        .map(|line| line.text.clone())
        .unwrap_or_default()
}

fn is_choice_line(line: &TextLine) -> bool {
    line.text_surface
        .as_deref()
        .is_some_and(|surface| surface.starts_with(CHOICE_SURFACE_PREFIX))
}

fn dedup_consecutive<'a>(lines: impl Iterator<Item = &'a TextLine>) -> Vec<&'a TextLine> {
    let mut output: Vec<&TextLine> = Vec::new();
    for line in lines {
        let duplicate = output
            .last()
            .is_some_and(|prior| prior.speaker == line.speaker && prior.text == line.text);
        if !duplicate {
            output.push(line);
        }
    }
    output
}
