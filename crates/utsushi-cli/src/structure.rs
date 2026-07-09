//! `utsushi structure` — the narrative-structure exporter subcommand.
//!
//! This is the UTSUSHI-side producer of the `utsushi.narrative-structure.v1`
//! artifact the itotori whole-game localize driver consumes as its
//! structure-informed context. It belongs here (NOT in `kaifuu extract`)
//! because deriving the real scene-dispatch order + per-scene play-order
//! message streams needs the Utsushi replay runtime — and dependencies flow
//! utsushi → kaifuu, never back. `kaifuu extract --whole-seen` produces the
//! BRIDGE; this command produces the STRUCTURE; the driver consumes them as
//! two separate, independently-produced inputs.
//!
//! CONSUMES the deterministic decode — the scene-dispatch graph, the
//! choice/branch subsystem, the `#NAMAE` speaker decode, and the per-scene
//! play-order message stream — and emits a single deterministic JSON
//! `NarrativeStructure`. Every field is READ verbatim from the decode APIs
//! (no re-inference):
//!   * scene-dispatch GRAPH — [`ReplayEngine::observe_playthrough`] follows the
//!     real `jump`/`farcall`/return edges across scene boundaries; the
//!     resulting `scene_ids()` IS the real dispatch order (the order the
//!     play-loop crossed scenes), NOT archive slot order.
//!   * per-scene MESSAGE STREAM — each segment's `play_order_lines`.
//!   * SPEAKERS — each `TextLine::speaker` (`【…】`/`#NAMAE` decode), installed
//!     via [`ReplayEngine::with_namae_resolver`].
//!   * CHOICES + BRANCHES — the play-order `select {}` option lines are tagged
//!     `text_surface = "choice:<idx>"`; per option the branch-following walk
//!     records the messages + dispatch target that option leads into.
//!
//! Usage:
//!   utsushi structure --gameexe <Gameexe.ini> --seen <Seen.txt> --output <PATH>
//!       [--entry-scene <N>] [--max-scenes <N>]
//!
//! The emitted JSON can carry copyrighted script text on real bytes, so the
//! operator writes it OUTSIDE the repo (never committed).

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use kaifuu_reallive::{RealLiveOpcode, parse_scene};
use serde_json::{Map, Value, json};
use utsushi_core::{TextLine, write_json};
use utsushi_reallive::{
    BytecodeElement, Gameexe, HeadlessChoicePolicy, ReplayOpts, SceneId, decode_bytecode_stream,
    decompress_all_scenes,
};

use crate::staged_replay::staged_engine;

const CHOICE_SURFACE_PREFIX: &str = "choice:";

// `module_sel` (module_type=0, module_id=2) SelectionControl button-object
// setup opcodes — the real-bytes marker that a scene's select is a GRAPHICAL
// button-object select rather than a plain text-window `select`/`select_w`.
// rlvm module_sel.cc: select_objbtn=4, objbtn_init=20, select_objbtn_cancel=14.
const OP_SELECT_OBJBTN: u16 = 4;
const OP_OBJBTN_INIT: u16 = 20;
const OP_SELECT_OBJBTN_CANCEL: u16 = 14;

/// Entry point dispatched from `utsushi structure`. Owns its own flag parsing.
pub fn run_structure_command(tail: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let gameexe_path = PathBuf::from(flag(tail, "--gameexe")?);
    let seen_path = PathBuf::from(flag(tail, "--seen")?);
    let output_path = PathBuf::from(flag(tail, "--output")?);
    let entry_override: Option<u16> = flag_optional(tail, "--entry-scene")
        .map(str::parse::<u16>)
        .transpose()
        .map_err(|err| -> Box<dyn std::error::Error> {
            format!("utsushi.structure.entry_scene_parse: {err}").into()
        })?;
    let max_scenes: usize = flag_optional(tail, "--max-scenes")
        .map(str::parse::<usize>)
        .transpose()
        .map_err(|err| -> Box<dyn std::error::Error> {
            format!("utsushi.structure.max_scenes_parse: {err}").into()
        })?
        .unwrap_or(256);

    let structure =
        build_narrative_structure(&gameexe_path, &seen_path, entry_override, max_scenes)?;
    write_json(&output_path, &structure)?;
    Ok(())
}

/// Build the `utsushi.narrative-structure.v1` value for a Seen.txt archive.
///
/// The real dispatch order is the order [`ReplayEngine::observe_playthrough`]
/// crosses scenes from the entry scene — not archive slot order. Every unreached
/// archive scene the walk did not cross is intentionally NOT invented here (the
/// structure is the driven playthrough); the whole-game driver graceful-degrades
/// a unit whose scene isn't in the structure.
pub fn build_narrative_structure(
    gameexe_path: &Path,
    seen_path: &Path,
    entry_override: Option<u16>,
    max_scenes: usize,
) -> Result<Value, Box<dyn std::error::Error>> {
    let gameexe_bytes =
        std::fs::read(gameexe_path).map_err(|err| -> Box<dyn std::error::Error> {
            format!(
                "utsushi.structure.read_gameexe: {}: {err}",
                gameexe_path.display()
            )
            .into()
        })?;
    let gameexe = Gameexe::parse(&gameexe_bytes).map_err(|err| -> Box<dyn std::error::Error> {
        format!("utsushi.structure.parse_gameexe: {err}").into()
    })?;
    let seen_start = u16::try_from(
        gameexe
            .get_int("SEEN_START")
            .ok_or("utsushi.structure.missing_seen_start")?,
    )
    .map_err(|err| -> Box<dyn std::error::Error> {
        format!("utsushi.structure.seen_start_range: {err}").into()
    })?;
    let resolver = gameexe.namae_resolver();

    // Per-scene SelectionControl signal, STATICALLY decoded from each scene's
    // own bytecode (independent of headless reachability). This is the marker
    // the work-scope carve hardens the game-select identification on.
    let seen_bytes = std::fs::read(seen_path).map_err(|err| -> Box<dyn std::error::Error> {
        format!(
            "utsushi.structure.read_seen: {}: {err}",
            seen_path.display()
        )
        .into()
    })?;
    let decompressed =
        decompress_all_scenes(&seen_bytes).map_err(|err| -> Box<dyn std::error::Error> {
            format!("utsushi.structure.decompress: {err}").into()
        })?;
    let selection_control: HashMap<SceneId, &'static str> = decompressed
        .iter()
        .map(|scene| (scene.scene_id, selection_control_signal(&scene.bytecode)))
        .collect();
    let bytecode_by_scene: HashMap<SceneId, &[u8]> = decompressed
        .iter()
        .map(|scene| (scene.scene_id, scene.bytecode.as_slice()))
        .collect();

    // The replay engine with `use_xor_2` staging (Sweetie HD compiler 110002)
    // + the Gameexe `#NAMAE`/`#COLOR_TABLE` speaker resolver.
    let engine = staged_engine(seen_path)?.with_namae_resolver(resolver);

    let opts = ReplayOpts {
        step_budget: 400_000,
        stop_at_first_pause: false,
    };

    let entry = entry_override.unwrap_or(seen_start);

    // Scene-dispatch GRAPH + per-scene MESSAGE STREAM (play order, single pass)
    // + SPEAKERS — all read verbatim from observe_playthrough. `scene_ids()` IS
    // the real dispatch order.
    let playthrough = engine.observe_playthrough(entry, &opts, max_scenes);

    let mut scenes: Vec<Value> = Vec::new();
    for i in 0..playthrough.segments.len() {
        let segment = &playthrough.segments[i];
        let scene_id = segment.scene_id;
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

        let choice_indices = choice_option_indices(&segment.observation.play_order_lines);
        let mut choices: Vec<Value> = Vec::new();
        for idx in &choice_indices {
            let label = choice_label(&segment.observation.play_order_lines, *idx);
            let branch = engine.branch_following_observation(
                scene_id,
                &opts,
                HeadlessChoicePolicy::Fixed(*idx),
            );
            let branch_messages: Vec<Value> = branch
                .lines
                .iter()
                .filter(|line| !is_choice_line(line))
                .enumerate()
                .map(|(order, line)| message_json(order, line))
                .collect();
            choices.push(json!({
                "optionIndex": idx,
                "label": label,
                "branchEntryScene": match branch.first_cross_scene {
                    Some(id) => json!(id),
                    None => Value::Null,
                },
                "branchMessages": branch_messages,
            }));
        }

        let mut scene = Map::new();
        scene.insert("sceneId".into(), json!(scene_id));
        scene.insert(
            "selectionControl".into(),
            json!(selection_control.get(&scene_id).copied().unwrap_or("none")),
        );
        scene.insert(
            "nextScene".into(),
            match next_scene {
                Some(id) => json!(id),
                None => Value::Null,
            },
        );
        scene.insert(
            "dispatchFanoutScenes".into(),
            json!(
                bytecode_by_scene
                    .get(&scene_id)
                    .map(|bytecode| dispatch_fanout_scenes(bytecode))
                    .unwrap_or_default()
            ),
        );
        scene.insert("messages".into(), Value::Array(messages));
        scene.insert("choices".into(), Value::Array(choices));
        scenes.push(Value::Object(scene));
    }

    Ok(json!({
        "schemaVersion": "utsushi.narrative-structure.v1",
        "entryScene": entry,
        "sceneDispatchOrder": playthrough.scene_ids(),
        "scenes": scenes,
    }))
}

/// Resolve raw `goto_on` / `goto_case` table arms to the first explicit
/// cross-scene `jump` / `farcall` target they reach. The raw table pointers are
/// intra-scene byte offsets, so the structure JSON emits only scene ids after a
/// bounded local walk resolves a real scene-level transfer.
fn dispatch_fanout_scenes(bytecode: &[u8]) -> Vec<SceneId> {
    let Ok(elements) = decode_bytecode_stream(bytecode) else {
        return Vec::new();
    };
    let by_offset: HashMap<usize, &BytecodeElement> = elements
        .iter()
        .map(|element| (element.byte_offset(), element))
        .collect();
    let mut scenes = BTreeSet::new();
    for element in &elements {
        let BytecodeElement::Command {
            module_type,
            module_id,
            opcode,
            goto_targets,
            ..
        } = element
        else {
            continue;
        };
        if !is_raw_dispatch_table(*module_type, *module_id, *opcode) {
            continue;
        }
        for target in goto_targets {
            if let Some(scene) = resolve_arm_cross_scene(*target as usize, &by_offset) {
                scenes.insert(scene);
            }
        }
    }
    scenes.into_iter().collect()
}

fn is_raw_dispatch_table(module_type: u8, module_id: u8, opcode: u16) -> bool {
    module_type == 0 && module_id == 1 && matches!(opcode, 3 | 4)
}

fn element_next_offset(element: &BytecodeElement) -> usize {
    element.byte_offset().saturating_add(element.byte_len())
}

fn resolve_arm_cross_scene(
    start_offset: usize,
    by_offset: &HashMap<usize, &BytecodeElement>,
) -> Option<SceneId> {
    let mut queue = vec![start_offset];
    let mut seen = BTreeSet::new();
    let mut steps = 0usize;
    while let Some(offset) = queue.pop() {
        if steps >= 64 || !seen.insert(offset) {
            continue;
        }
        steps += 1;
        let Some(element) = by_offset.get(&offset).copied() else {
            continue;
        };
        if let BytecodeElement::Command {
            module_type,
            module_id,
            opcode,
            raw_bytes,
            goto_targets,
            ..
        } = element
        {
            if let Some(scene) = cross_scene_target(*module_type, *module_id, *opcode, raw_bytes) {
                return Some(scene);
            }
            for target in goto_targets {
                queue.push(*target as usize);
            }
        }
        queue.push(element_next_offset(element));
    }
    None
}

fn cross_scene_target(
    module_type: u8,
    module_id: u8,
    opcode: u16,
    raw_bytes: &[u8],
) -> Option<SceneId> {
    if module_type != 0 || module_id != 1 {
        return None;
    }
    let ints = int_literals(raw_bytes);
    let scene = match opcode {
        // `jump(scene[, entrypoint])`, `farcall(scene[, entrypoint])`, and
        // `farcall_with(scene, entrypoint, args...)`.
        11 | 12 | 18 => ints.first().copied(),
        // Older farcall-family command shape:
        // `farcall(return_scene, return_pc, target_scene, target_pc)`.
        0x20 => ints.get(2).copied(),
        _ => None,
    }?;
    u16::try_from(scene).ok().filter(|scene| *scene != 0)
}

fn int_literals(raw_bytes: &[u8]) -> Vec<i32> {
    let mut values = Vec::new();
    let mut i = 0usize;
    while i + 6 <= raw_bytes.len() {
        if raw_bytes[i] == 0x24 && raw_bytes[i + 1] == 0xff {
            values.push(i32::from_le_bytes([
                raw_bytes[i + 2],
                raw_bytes[i + 3],
                raw_bytes[i + 4],
                raw_bytes[i + 5],
            ]));
            i += 6;
        } else {
            i += 1;
        }
    }
    values
}

fn selection_control_signal(bytecode: &[u8]) -> &'static str {
    let Ok(ops) = parse_scene(bytecode) else {
        return "none";
    };
    let mut has_button_object = false;
    let mut has_text_choice = false;
    for op in &ops {
        match op {
            RealLiveOpcode::SelectionControl { opcode }
                if matches!(
                    *opcode,
                    OP_SELECT_OBJBTN | OP_OBJBTN_INIT | OP_SELECT_OBJBTN_CANCEL
                ) =>
            {
                has_button_object = true;
            }
            RealLiveOpcode::Choice { .. } => has_text_choice = true,
            _ => {}
        }
    }
    if has_button_object {
        "button-object"
    } else if has_text_choice {
        "text-window"
    } else {
        "none"
    }
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

fn flag<'a>(args: &'a [String], name: &str) -> Result<&'a str, Box<dyn std::error::Error>> {
    flag_optional(args, name).ok_or_else(|| -> Box<dyn std::error::Error> {
        format!("utsushi.structure.missing_flag: {name}").into()
    })
}

fn flag_optional<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|idx| args.get(idx + 1))
        .map(String::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MODULE_JMP_TYPE: u8 = 0;
    const MODULE_JMP_ID: u8 = 1;
    const OPCODE_GOTO_ON: u16 = 3;
    const OPCODE_JUMP: u16 = 11;
    const STORE_REGISTER: [u8; 2] = [0x24, 0xC8];

    fn command_header(module_type: u8, module_id: u8, opcode: u16, arg_count: u16) -> Vec<u8> {
        vec![
            0x23,
            module_type,
            module_id,
            opcode as u8,
            (opcode >> 8) as u8,
            arg_count as u8,
            (arg_count >> 8) as u8,
            0,
        ]
    }

    fn jump_to_scene(scene: i32) -> Vec<u8> {
        let mut bytes = command_header(MODULE_JMP_TYPE, MODULE_JMP_ID, OPCODE_JUMP, 1);
        bytes.push(b'(');
        bytes.extend_from_slice(&[0x24, 0xff]);
        bytes.extend_from_slice(&scene.to_le_bytes());
        bytes.push(b')');
        bytes
    }

    #[test]
    fn dispatch_fanout_scenes_resolves_raw_dispatch_arms_to_cross_scene_jumps() {
        let first_jump = jump_to_scene(7000);
        let second_jump = jump_to_scene(500);
        let first_jump_offset = 8 + 4 + 1 + 8 + 1;
        let second_jump_offset = first_jump_offset + first_jump.len();

        let mut bytes = command_header(MODULE_JMP_TYPE, MODULE_JMP_ID, OPCODE_GOTO_ON, 2);
        bytes.push(b'(');
        bytes.extend_from_slice(&STORE_REGISTER);
        bytes.push(b')');
        bytes.push(b'{');
        bytes.extend_from_slice(&(first_jump_offset as u32).to_le_bytes());
        bytes.extend_from_slice(&(second_jump_offset as u32).to_le_bytes());
        bytes.push(b'}');
        bytes.extend_from_slice(&first_jump);
        bytes.extend_from_slice(&second_jump);

        assert_eq!(dispatch_fanout_scenes(&bytes), vec![500, 7000]);
    }
}
