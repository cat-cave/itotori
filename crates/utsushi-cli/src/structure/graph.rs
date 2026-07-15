use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};

use serde::Serialize;
use utsushi_reallive::{BytecodeElement, SceneId, decode_bytecode_stream};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Edge {
    #[serde(rename = "edgeId")]
    pub id: String,
    pub kind: &'static str,
    pub from_scene_id: SceneId,
    pub to_scene_id: Option<SceneId>,
    pub resolution: &'static str,
    pub diagnostic: Option<String>,
    pub choice_id: Option<String>,
    pub option_index: Option<u16>,
}

impl Edge {
    pub fn observed(
        from: SceneId,
        to: Option<SceneId>,
        authoritative: bool,
        diagnostic: Option<String>,
    ) -> Self {
        let resolution = if authoritative && to.is_some() {
            "resolved"
        } else {
            "unknown"
        };
        Self {
            id: format!("edge:scene-{from:04}:observed-next"),
            kind: "dispatch",
            from_scene_id: from,
            to_scene_id: if authoritative { to } else { None },
            resolution,
            diagnostic,
            choice_id: None,
            option_index: None,
        }
    }

    pub fn choice(
        from: SceneId,
        choice_id: &str,
        option_index: u16,
        target: Option<SceneId>,
        authoritative: bool,
        diagnostic: Option<String>,
    ) -> Self {
        Self {
            id: format!("edge:choice:{choice_id}"),
            kind: "choice",
            from_scene_id: from,
            to_scene_id: if authoritative { target } else { None },
            resolution: if authoritative && target.is_some() {
                "resolved"
            } else {
                "unknown"
            },
            diagnostic,
            choice_id: Some(choice_id.to_string()),
            option_index: Some(option_index),
        }
    }
}

pub(super) fn static_edges(scene_id: SceneId, bytecode: &[u8]) -> Result<Vec<Edge>, String> {
    let elements = decode_bytecode_stream(bytecode)
        .map_err(|err| format!("scene {scene_id} bytecode edge decode failed: {err}"))?;
    let by_offset: HashMap<usize, &BytecodeElement> = elements
        .iter()
        .map(|element| (element.byte_offset(), element))
        .collect();
    let mut edges = Vec::new();
    for element in &elements {
        let BytecodeElement::Command {
            module_type,
            module_id,
            opcode,
            goto_targets,
            raw_bytes,
            byte_offset,
            ..
        } = element
        else {
            continue;
        };
        if is_raw_dispatch_table(*module_type, *module_id, *opcode) {
            for (arm, target) in goto_targets.iter().enumerate() {
                let resolved = resolve_arm_cross_scene(*target as usize, &by_offset);
                edges.push(Edge {
                    id: format!("edge:scene-{scene_id:04}:table-{byte_offset}-{arm}"),
                    kind: "dispatch",
                    from_scene_id: scene_id,
                    to_scene_id: resolved,
                    resolution: if resolved.is_some() { "resolved" } else { "unknown" },
                    diagnostic: resolved.is_none().then(|| {
                        format!(
                            "static dispatch arm {arm} at byte {byte_offset} has no literal cross-scene target"
                        )
                    }),
                    choice_id: None,
                    option_index: None,
                });
            }
        } else if is_cross_scene_command(*module_type, *module_id, *opcode) {
            let resolved = literal_first_scene_arg(raw_bytes);
            edges.push(Edge {
                id: format!("edge:scene-{scene_id:04}:command-{byte_offset}"),
                kind: "dispatch",
                from_scene_id: scene_id,
                to_scene_id: resolved,
                resolution: if resolved.is_some() {
                    "resolved"
                } else {
                    "unknown"
                },
                diagnostic: resolved.is_none().then(|| {
                    format!(
                        "cross-scene command at byte {byte_offset} uses a runtime-resolved target"
                    )
                }),
                choice_id: None,
                option_index: None,
            });
        }
    }
    Ok(edges)
}

pub(super) fn merge_edges(edges: Vec<Edge>) -> Vec<Edge> {
    let mut by_id = BTreeMap::new();
    for edge in edges {
        by_id.entry(edge.id.clone()).or_insert(edge);
    }
    by_id.into_values().collect()
}

pub(super) fn resolved_fanout(edges: &[Edge], scene_id: SceneId) -> Vec<SceneId> {
    edges
        .iter()
        .filter(|edge| {
            edge.from_scene_id == scene_id
                && edge.kind == "dispatch"
                && edge.resolution == "resolved"
        })
        .filter_map(|edge| edge.to_scene_id)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

#[derive(Debug)]
pub(super) struct GraphFacts {
    pub predecessors: BTreeMap<SceneId, Vec<SceneId>>,
    pub successors: BTreeMap<SceneId, Vec<SceneId>>,
    pub reachable: BTreeSet<SceneId>,
    pub route_membership: BTreeMap<SceneId, Vec<String>>,
    pub routes: Vec<Route>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Route {
    #[serde(rename = "routeId")]
    pub id: String,
    pub entry_scene_id: SceneId,
    pub via_edge_id: Option<String>,
    pub scene_ids: Vec<SceneId>,
}

pub(super) fn graph_facts(
    entry: SceneId,
    scene_ids: &BTreeSet<SceneId>,
    edges: &mut [Edge],
) -> GraphFacts {
    for edge in edges.iter_mut() {
        if edge.resolution == "resolved"
            && edge
                .to_scene_id
                .is_some_and(|target| !scene_ids.contains(&target))
        {
            edge.resolution = "unresolved";
            edge.diagnostic = Some(format!(
                "decoded target scene {} is absent from the archive",
                edge.to_scene_id.unwrap_or_default()
            ));
        }
    }
    let mut adjacency: BTreeMap<SceneId, BTreeSet<SceneId>> = BTreeMap::new();
    let mut reverse: BTreeMap<SceneId, BTreeSet<SceneId>> = BTreeMap::new();
    for edge in edges.iter().filter(|edge| edge.resolution == "resolved") {
        if let Some(target) = edge.to_scene_id {
            adjacency
                .entry(edge.from_scene_id)
                .or_default()
                .insert(target);
            reverse
                .entry(target)
                .or_default()
                .insert(edge.from_scene_id);
        }
    }
    let reachable = walk(entry, &adjacency);

    let entry_choices: Vec<&Edge> = edges
        .iter()
        .filter(|edge| {
            edge.from_scene_id == entry && edge.kind == "choice" && edge.resolution == "resolved"
        })
        .collect();
    let mut routes = vec![Route {
        id: "route:entry".to_string(),
        entry_scene_id: entry,
        via_edge_id: None,
        scene_ids: if entry_choices.is_empty() {
            reachable.iter().copied().collect()
        } else {
            vec![entry]
        },
    }];
    if !entry_choices.is_empty() {
        for edge in entry_choices {
            let target = edge.to_scene_id.expect("resolved choice has a target");
            routes.push(Route {
                id: format!(
                    "route:{}",
                    edge.choice_id.as_deref().unwrap_or(edge.id.as_str())
                ),
                entry_scene_id: target,
                via_edge_id: Some(edge.id.clone()),
                scene_ids: walk(target, &adjacency).into_iter().collect(),
            });
        }
    }
    let mut route_membership: BTreeMap<SceneId, Vec<String>> = BTreeMap::new();
    for route in &routes {
        for scene_id in &route.scene_ids {
            route_membership
                .entry(*scene_id)
                .or_default()
                .push(route.id.clone());
        }
    }
    for memberships in route_membership.values_mut() {
        memberships.sort();
        memberships.dedup();
    }
    GraphFacts {
        predecessors: reverse
            .into_iter()
            .map(|(scene, values)| (scene, values.into_iter().collect()))
            .collect(),
        successors: adjacency
            .into_iter()
            .map(|(scene, values)| (scene, values.into_iter().collect()))
            .collect(),
        reachable,
        route_membership,
        routes,
    }
}

fn walk(start: SceneId, adjacency: &BTreeMap<SceneId, BTreeSet<SceneId>>) -> BTreeSet<SceneId> {
    let mut reached = BTreeSet::new();
    let mut queue = VecDeque::from([start]);
    while let Some(scene) = queue.pop_front() {
        if !reached.insert(scene) {
            continue;
        }
        queue.extend(adjacency.get(&scene).into_iter().flatten().copied());
    }
    reached
}

fn is_raw_dispatch_table(module_type: u8, module_id: u8, opcode: u16) -> bool {
    module_type == 0 && module_id == 1 && matches!(opcode, 3 | 4)
}

fn is_cross_scene_command(module_type: u8, module_id: u8, opcode: u16) -> bool {
    module_type == 0 && module_id == 1 && matches!(opcode, 11 | 12 | 18)
}

fn literal_first_scene_arg(raw: &[u8]) -> Option<SceneId> {
    let body = raw.get(8..)?;
    if body.first() != Some(&b'(') || body.get(1..3) != Some(&[0x24, 0xff]) {
        return None;
    }
    let scene = i32::from_le_bytes(body.get(3..7)?.try_into().ok()?);
    u16::try_from(scene).ok()
}

fn resolve_arm_cross_scene(
    start_offset: usize,
    by_offset: &HashMap<usize, &BytecodeElement>,
) -> Option<SceneId> {
    let mut seen = BTreeSet::new();
    let mut offset = start_offset;
    loop {
        if !seen.insert(offset) {
            return None;
        }
        let element = by_offset.get(&offset).copied()?;
        if let BytecodeElement::Command {
            module_type,
            module_id,
            opcode,
            raw_bytes,
            goto_targets,
            ..
        } = element
        {
            if is_cross_scene_command(*module_type, *module_id, *opcode) {
                return literal_first_scene_arg(raw_bytes);
            }
            if !goto_targets.is_empty() {
                return None;
            }
        }
        offset = element.byte_offset().checked_add(element.byte_len())?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cold_observation_never_exposes_its_candidate_target() {
        let edge = Edge::observed(7, Some(999), false, Some("cold seeded".to_string()));
        assert_eq!(edge.resolution, "unknown");
        assert_eq!(edge.to_scene_id, None);
        assert!(edge.diagnostic.is_some());
    }
}
