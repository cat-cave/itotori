use std::collections::{BTreeMap, BTreeSet, HashMap};

use kaifuu_reallive::{RealLiveOpcode, parse_real_bytecode_spans};
use serde_json::{Value, json};
use utsushi_core::TextLine;
use utsushi_reallive::{
    DecompressedScene, HeadlessChoicePolicy, ReplayEngine, ReplayOpts, SceneId, SelectionPrompt,
};

use super::bridge::{BridgeIndex, BridgeUnit};
use super::coverage::{Coverage, CoverageInput};
use super::graph::{self, Edge};
use super::output::{
    enrich_scenes, fill_branch_messages, message_value, runtime_only_message_value,
    selection_control_signal, unit_value,
};

#[derive(Debug)]
struct ObservedScene {
    scene_id: SceneId,
    cold_seeded: bool,
    lines: Vec<TextLine>,
    prompts: Vec<SelectionPrompt>,
    next_scene: Option<SceneId>,
}

pub(super) struct ExpandedInput<'a> {
    pub engine: ReplayEngine,
    pub decoded_scenes: &'a [DecompressedScene],
    pub loaded_scene_count: usize,
    pub bridge: &'a BridgeIndex,
    pub archive_scene_ids: &'a BTreeSet<SceneId>,
    pub entry: SceneId,
}

pub(super) fn build(input: ExpandedInput<'_>) -> Result<Value, String> {
    let opts = ReplayOpts {
        step_budget: 400_000,
        stop_at_first_pause: false,
    };
    let decoded_by_scene: HashMap<SceneId, &[u8]> = input
        .decoded_scenes
        .iter()
        .map(|scene| (scene.scene_id, scene.bytecode.as_slice()))
        .collect();
    let observations =
        observe_all_scenes(&input.engine, &opts, input.archive_scene_ids, input.entry)?;
    let dispatch_order: Vec<SceneId> = observations.iter().map(|scene| scene.scene_id).collect();

    let mut edges = Vec::new();
    for scene_id in input.archive_scene_ids {
        let bytecode = decoded_by_scene
            .get(scene_id)
            .ok_or_else(|| format!("decoded bytecode missing for scene {scene_id}"))?;
        edges.extend(graph::static_edges(*scene_id, bytecode)?);
    }

    let mut scene_values = Vec::new();
    let mut observed_unit_ids = BTreeSet::new();
    let mut emitted_unit_ids = BTreeSet::new();
    for (scene_order, observation) in observations.iter().enumerate() {
        let bytecode = decoded_by_scene.get(&observation.scene_id).ok_or_else(|| {
            format!(
                "decoded bytecode missing for scene {}",
                observation.scene_id
            )
        })?;
        let mut scene_units = input.bridge.units(observation.scene_id).to_vec();
        reconcile_choice_locations(bytecode, &mut scene_units)?;
        let links = link_lines(bytecode, &scene_units, &observation.prompts)?;
        let mut messages = Vec::with_capacity(observation.lines.len());
        for (order, line) in observation.lines.iter().enumerate() {
            if let Some(unit) = links.unit_for(line) {
                observed_unit_ids.insert(unit.id.clone());
                messages.push(message_value(order, line, unit)?);
            } else {
                let asset = input.bridge.asset(observation.scene_id).ok_or_else(|| {
                    format!("bridge asset missing for scene {}", observation.scene_id)
                })?;
                messages.push(runtime_only_message_value(order, line, asset)?);
            }
        }

        let choice_groups = grouped_choices(&scene_units);
        let mut choices = Vec::new();
        for units in &choice_groups {
            for unit in units {
                let choice = unit
                    .choice
                    .as_ref()
                    .expect("grouped choices contain choice units");
                let authoritative = observation.scene_id == input.entry
                    && !observation.cold_seeded
                    && choice_groups.len() == 1;
                let target = if authoritative {
                    input
                        .engine
                        .branch_following_observation(
                            observation.scene_id,
                            &opts,
                            HeadlessChoicePolicy::Fixed(choice.option_index),
                        )
                        .first_cross_scene
                } else {
                    None
                };
                let diagnostic = if observation.cold_seeded {
                    Some("choice target is unknown because the scene was cold-seeded without caller state".to_string())
                } else if observation.scene_id != input.entry {
                    Some("choice target is unknown because replaying an already-reached scene would discard its caller state".to_string())
                } else if choice_groups.len() != 1 {
                    Some("choice target is unknown because this scene has multiple prompts and the headless policy cannot isolate a later prompt".to_string())
                } else if target.is_none() {
                    Some(
                        "choice target is unknown because no cross-scene transfer was observed"
                            .to_string(),
                    )
                } else {
                    None
                };
                let edge = Edge::choice(
                    observation.scene_id,
                    &choice.choice_id,
                    choice.option_index,
                    target,
                    authoritative,
                    diagnostic.clone(),
                );
                choices.push(json!({
                    "choiceId": choice.choice_id,
                    "choiceGroupId": choice.group_id,
                    "edgeId": edge.id,
                    "edgeResolution": edge.resolution,
                    "unresolvedEdgeDiagnostic": diagnostic,
                    "optionIndex": choice.option_index,
                    "label": unit.source_text,
                    "bridgeRef": unit.bridge_ref(),
                    "branchEntryScene": edge.to_scene_id,
                    "branchTargetSceneId": edge.to_scene_id,
                    "branchMessages": [],
                }));
                edges.push(edge);
            }
        }
        for prompt in &observation.prompts {
            for (option_index, line_id) in prompt.option_line_ids.iter().enumerate() {
                if links.choices.contains_key(line_id) {
                    continue;
                }
                let line = observation
                    .lines
                    .iter()
                    .find(|line| &line.line_id == line_id)
                    .ok_or_else(|| {
                        format!("choice line {line_id} is absent from the replay stream")
                    })?;
                let option_index = u16::try_from(option_index)
                    .map_err(|err| format!("choice option index is out of range: {err}"))?;
                let choice_id = format!(
                    "choice:runtime:scene-{:04}:prompt-{}:option-{option_index}",
                    observation.scene_id, prompt.byte_offset_in_scene
                );
                let diagnostic = "choice target is unknown because the displayed option has no static BridgeUnit"
                    .to_string();
                let edge = Edge::choice(
                    observation.scene_id,
                    &choice_id,
                    option_index,
                    None,
                    false,
                    Some(diagnostic.clone()),
                );
                choices.push(json!({
                    "choiceId": choice_id,
                    "choiceGroupId": format!(
                        "choice-group:runtime:scene-{:04}:prompt-{}",
                        observation.scene_id, prompt.byte_offset_in_scene
                    ),
                    "edgeId": edge.id,
                    "edgeResolution": edge.resolution,
                    "unresolvedEdgeDiagnostic": diagnostic,
                    "optionIndex": option_index,
                    "label": line.text,
                    "bridgeRef": null,
                    "branchEntryScene": null,
                    "branchTargetSceneId": null,
                    "branchMessages": [],
                }));
                edges.push(edge);
            }
        }

        let observed_edge = if observation.cold_seeded {
            Edge::observed(
                observation.scene_id,
                observation.next_scene,
                false,
                Some(
                    "next-scene target is unknown because the scene was cold-seeded without caller state"
                        .to_string(),
                ),
            )
        } else {
            Edge::observed(
                observation.scene_id,
                observation.next_scene,
                true,
                observation
                    .next_scene
                    .is_none()
                    .then(|| "playthrough reached no cross-scene transfer".to_string()),
            )
        };
        edges.push(observed_edge);

        let units = scene_units
            .iter()
            .map(|unit| {
                emitted_unit_ids.insert(unit.id.clone());
                unit_value(unit, &messages)
            })
            .collect::<Vec<_>>();
        scene_values.push(json!({
            "sceneId": observation.scene_id,
            "sceneRef": format!("scene:{:04}", observation.scene_id),
            "selectionControl": selection_control_signal(bytecode)?,
            "nextScene": if observation.cold_seeded { None } else { observation.next_scene },
            "dispatchFanoutScenes": [],
            "messages": messages,
            "choices": choices,
            "units": units,
            "playOrder": scene_order,
            "revealOrder": if observation.cold_seeded { None } else { Some(scene_order) },
            "observationMode": if observation.cold_seeded { "cold_seeded" } else { "entry_reached" },
            "predecessors": [],
            "successors": [],
            "reachable": false,
            "routeMembership": [],
        }));
    }

    let mut edges = graph::merge_edges(edges);
    let facts = graph::graph_facts(input.entry, input.archive_scene_ids, &mut edges);
    enrich_scenes(&mut scene_values, &edges, &facts)?;
    fill_branch_messages(&mut scene_values)?;

    let emitted_units = scene_values
        .iter()
        .map(|scene| scene["units"].as_array().map_or(0, Vec::len))
        .sum();
    let unresolved_edges = edges
        .iter()
        .filter(|edge| edge.resolution != "resolved")
        .count();
    let coverage = Coverage::validate(CoverageInput {
        archive_scenes: input.archive_scene_ids.len(),
        decoded_scenes: input.decoded_scenes.len(),
        loaded_scenes: input.loaded_scene_count,
        bridge_assets: input.bridge.asset_scene_ids.len(),
        emitted_scenes: scene_values.len(),
        archive_units: input.bridge.unit_count,
        emitted_units,
        observed_units: observed_unit_ids.len(),
        discovered_edges: edges.len(),
        emitted_edges: edges.len(),
        unresolved_edges,
    })?;
    let bridge_unit_ids: BTreeSet<&str> = input
        .bridge
        .units_by_scene
        .values()
        .flatten()
        .map(|unit| unit.id.as_str())
        .collect();
    let emitted_unit_ids: BTreeSet<&str> = emitted_unit_ids.iter().map(String::as_str).collect();
    if emitted_unit_ids != bridge_unit_ids {
        return Err(format!(
            "utsushi.structure.incomplete_unit_identity_coverage: bridge={} emitted={}",
            bridge_unit_ids.len(),
            emitted_unit_ids.len()
        ));
    }
    Ok(json!({
        "schemaVersion": "utsushi.narrative-structure.v2",
        "bridgeId": input.bridge.bridge_id,
        "sourceBundleHash": input.bridge.source_bundle_hash,
        "entryScene": input.entry,
        "sceneDispatchOrder": dispatch_order,
        "coverage": coverage,
        "routes": facts.routes,
        "edges": edges,
        "scenes": scene_values,
    }))
}

fn observe_all_scenes(
    engine: &ReplayEngine,
    opts: &ReplayOpts,
    archive_scene_ids: &BTreeSet<SceneId>,
    entry: SceneId,
) -> Result<Vec<ObservedScene>, String> {
    if !archive_scene_ids.contains(&entry) {
        return Err(format!("utsushi.structure.entry_missing: scene {entry}"));
    }
    let roots = std::iter::once(entry).chain(
        archive_scene_ids
            .iter()
            .copied()
            .filter(|scene| *scene != entry),
    );
    let mut visited = BTreeSet::new();
    let mut observations = Vec::new();
    for root in roots {
        if visited.contains(&root) {
            continue;
        }
        let cold_root = root != entry;
        let playthrough = engine.observe_playthrough(root, opts, archive_scene_ids.len());
        for segment in playthrough.segments {
            if !visited.insert(segment.scene_id) {
                continue;
            }
            if !segment.observation.scene.reached_natural_terminus {
                return Err(format!(
                    "utsushi.structure.replay_truncated: scene {} did not reach a natural terminus",
                    segment.scene_id
                ));
            }
            observations.push(ObservedScene {
                scene_id: segment.scene_id,
                cold_seeded: cold_root,
                lines: segment.observation.play_order_lines,
                prompts: segment.observation.selection_prompts,
                next_scene: segment.observation.first_cross_scene,
            });
        }
    }
    Ok(observations)
}

fn link_lines<'a>(
    bytecode: &[u8],
    units: &'a [BridgeUnit],
    prompts: &[SelectionPrompt],
) -> Result<LineLinks<'a>, String> {
    let mut dialogue = BTreeMap::new();
    for unit in units.iter().filter(|unit| unit.surface_kind == "dialogue") {
        if dialogue.insert(unit.byte_start, unit).is_some() {
            return Err(format!(
                "multiple dialogue BridgeUnits share byte offset {}",
                unit.byte_start
            ));
        }
    }
    let choice_groups = choice_units_by_command(bytecode, units)?;
    let mut links = HashMap::new();
    for prompt in prompts {
        if prompt.option_line_ids.is_empty() {
            continue;
        }
        let Some(choices) = choice_groups.get(&prompt.byte_offset_in_scene) else {
            continue;
        };
        for (option_index, line_id) in prompt.option_line_ids.iter().enumerate() {
            if let Some(unit) = choices.iter().find(|unit| {
                unit.choice
                    .as_ref()
                    .is_some_and(|choice| usize::from(choice.option_index) == option_index)
            }) {
                links.insert(line_id.clone(), *unit);
            }
        }
    }
    Ok(LineLinks {
        choices: links,
        dialogue,
    })
}

struct LineLinks<'a> {
    choices: HashMap<String, &'a BridgeUnit>,
    dialogue: BTreeMap<u64, &'a BridgeUnit>,
}

impl<'a> LineLinks<'a> {
    fn unit_for(&self, line: &TextLine) -> Option<&'a BridgeUnit> {
        self.choices.get(&line.line_id).copied().or_else(|| {
            line.byte_offset_in_scene
                .and_then(|offset| self.dialogue.get(&u64::from(offset)).copied())
        })
    }
}

fn choice_units_by_command<'a>(
    bytecode: &[u8],
    units: &'a [BridgeUnit],
) -> Result<BTreeMap<u32, Vec<&'a BridgeUnit>>, String> {
    let mut choices_by_command = BTreeMap::new();
    for unit in units
        .iter()
        .filter(|unit| unit.surface_kind == "choice_label")
    {
        choices_by_command
            .entry(unit.choice_command_offset.unwrap_or(unit.byte_start))
            .or_insert_with(Vec::new)
            .push(unit);
    }
    let mut groups = BTreeMap::new();
    let mut cursor = 0u64;
    for (opcode, width) in parse_real_bytecode_spans(bytecode).map_err(|err| err.to_string())? {
        if let RealLiveOpcode::Choice { choices } = opcode {
            let mut group = choices_by_command.remove(&cursor).unwrap_or_default();
            group.sort_by_key(|unit| unit.choice.as_ref().map(|choice| choice.option_index));
            for unit in &group {
                let choice = unit
                    .choice
                    .as_ref()
                    .ok_or("choice unit lost choice context")?;
                if usize::from(choice.option_index) >= choices.len() {
                    return Err(format!(
                        "BridgeUnit {} option {} exceeds decoded choice count {} at byte {cursor}",
                        unit.id,
                        choice.option_index,
                        choices.len()
                    ));
                }
            }
            groups.insert(cursor as u32, group);
        }
        cursor = cursor.saturating_add(width as u64);
    }
    if let Some((offset, _)) = choices_by_command.into_iter().next() {
        return Err(format!(
            "bridge choice units at byte {offset} have no decoded choice command"
        ));
    }
    Ok(groups)
}

fn reconcile_choice_locations(bytecode: &[u8], units: &mut [BridgeUnit]) -> Result<(), String> {
    let mut matched = BTreeSet::new();
    let mut cursor = 0u64;
    for (opcode, width) in parse_real_bytecode_spans(bytecode).map_err(|err| err.to_string())? {
        if let RealLiveOpcode::Choice { choices } = opcode {
            for unit in units.iter_mut().filter(|unit| {
                unit.surface_kind == "choice_label" && unit.choice_command_offset == Some(cursor)
            }) {
                let choice = unit
                    .choice
                    .as_ref()
                    .ok_or("choice unit lost choice context")?;
                let decoded = choices.get(usize::from(choice.option_index)).ok_or_else(|| {
                    format!(
                        "BridgeUnit {} option {} exceeds decoded choice count {} at byte {cursor}",
                        unit.id,
                        choice.option_index,
                        choices.len()
                    )
                })?;
                unit.byte_start = decoded.byte_offset;
                unit.byte_end = decoded.byte_offset + decoded.bytes.len() as u64;
                matched.insert(unit.id.clone());
            }
        }
        cursor = cursor.saturating_add(width as u64);
    }
    if let Some(unit) = units
        .iter()
        .find(|unit| unit.surface_kind == "choice_label" && !matched.contains(&unit.id))
    {
        return Err(format!(
            "BridgeUnit {} has no matching decoded choice command",
            unit.id
        ));
    }
    Ok(())
}

fn grouped_choices(units: &[BridgeUnit]) -> Vec<Vec<&BridgeUnit>> {
    let mut groups: BTreeMap<&str, Vec<&BridgeUnit>> = BTreeMap::new();
    for unit in units {
        if let Some(choice) = &unit.choice {
            groups.entry(&choice.group_id).or_default().push(unit);
        }
    }
    let mut groups: Vec<Vec<&BridgeUnit>> = groups.into_values().collect();
    for group in &mut groups {
        group.sort_by_key(|unit| unit.choice.as_ref().map(|choice| choice.option_index));
    }
    groups.sort_by_key(|group| group.first().map(|unit| unit.byte_start));
    groups
}
