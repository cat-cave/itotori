//! Persistent real-byte Siglus stage player for the browser session bridge.
//! It precomputes only actual text/choice boundaries from one decoded entry
//! scene, each paired with the stage state produced by that exact execution.
//! There is deliberately no image fallback: if a visible stage object cannot
//! resolve to an installed supported G00, launching fails.

mod render;

use kaifuu_siglus::{
    SiglusSecondLayerKey, decode_gameexe_dat, decode_scene_chunk, parse_scene_pck,
    read_gameexe_header, recover_exe_angou_key,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::error::Error;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use utsushi_siglus::SiglusG00Image;
use utsushi_siglus::scene_vm::{
    ExecutionOutcome, Moment, SceneProgram, StageSnapshot, TitleProgram, VmState,
    execute_title_scene_with_stage_snapshots_observed,
};

use self::render::{MessageWindowProjection, render_boundary};
#[cfg(test)]
use self::render::{composite_message_window, load_g00, non_background_pixel_count};
#[cfg(test)]
use utsushi_siglus::{SiglusCgFrame, decode_siglus_g00, render_siglus_stage};

const USAGE: &str = "usage: utsushi siglus-live-player --game-root <DIR> --scene <N> --artifact-root <DIR> [--run-id <ID>] [--redaction on] [--reveal]";

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum BrowserInput {
    Advance,
    Pointer,
    Choice { index: u16 },
    Close,
}

#[derive(Debug)]
struct RenderedBoundary {
    snapshot: StageSnapshot,
    private_path: PathBuf,
    public_path: PathBuf,
    private_sha256: String,
    public_sha256: String,
    width: u32,
    height: u32,
    non_background_pixels: usize,
}

pub(crate) fn run_siglus_live_player_command(args: &[String]) -> Result<(), Box<dyn Error>> {
    let root = PathBuf::from(required_flag(args, "--game-root")?);
    let scene: u32 = required_flag(args, "--scene")?.parse()?;
    let artifact_root = PathBuf::from(required_flag(args, "--artifact-root")?);
    let run_id = optional_flag(args, "--run-id").unwrap_or("siglus-browser-player");
    match optional_flag(args, "--redaction") {
        None | Some("on") => {}
        Some(value) => {
            return Err(
                format!("siglus-live-player --redaction must be on; full-fidelity frames use --reveal and the private artifact path, got {value}").into(),
            );
        }
    }
    // `--reveal` only selects the authorized response file below. Rendering
    // always emits a redacted managed artifact and a sibling private frame.
    let reveal = args.iter().any(|arg| arg == "--reveal");
    let (title, scene_ids, message_window) = load_title(&root)?;
    let selected = if scene == 0 { scene_ids } else { vec![scene] };
    let mut boundaries = None;
    let mut fallback_snapshots = None;
    let mut first_terminal = None;
    for candidate in selected {
        let mut state = VmState::default();
        let outcome =
            execute_title_scene_with_stage_snapshots_observed(&title, candidate, &mut state)?;
        let snapshots = match outcome {
            ExecutionOutcome::Complete(report) => report.stage_snapshots,
            ExecutionOutcome::Terminal { report, error } => {
                first_terminal.get_or_insert(error.to_string());
                report.stage_snapshots
            }
        };
        let renderable = snapshots
            .into_iter()
            .filter(|snapshot| has_renderable_stage(&root, snapshot))
            .collect::<Vec<_>>();
        if renderable.is_empty() {
            continue;
        }
        // Prefer an executed text boundary with a non-default authored
        // placement. If none exists, retain the first fully renderable
        // authored boundary without inventing a position for it.
        let positioned = renderable
            .iter()
            .filter(|snapshot| has_nondefault_stage_position(snapshot))
            .cloned()
            .collect::<Vec<_>>();
        if positioned.is_empty() {
            fallback_snapshots.get_or_insert(renderable);
            continue;
        }
        boundaries = Some(positioned);
        break;
    }
    let boundaries = if let Some(boundaries) = boundaries {
        boundaries
    } else if let Some(snapshots) = fallback_snapshots {
        snapshots
    } else {
        let suffix = first_terminal
            .map(|error| format!("; first terminal diagnostic: {error}"))
            .unwrap_or_default();
        return Err(format!("siglus-live-player found no text/choice boundary with a real visible stage object{suffix}").into());
    };
    let mut index = 0usize;
    let mut cache = HashMap::<String, SiglusG00Image>::new();
    let mut rendered = render_boundary(
        &root,
        &artifact_root,
        run_id,
        message_window,
        boundaries[index].clone(),
        index,
        &mut cache,
    )?;
    write_response(&mut io::stdout(), response(&rendered, index, reveal, false))?;
    for line in io::stdin().lock().lines() {
        let input: BrowserInput = serde_json::from_str(&line?)?;
        if matches!(input, BrowserInput::Close) {
            write_response(&mut io::stdout(), json!({"closed": true}))?;
            return Ok(());
        }
        let boundary = &rendered;
        match (&boundary.snapshot.moment, input) {
            (Moment::Choice { options, .. }, BrowserInput::Choice { index: 0 })
                if !options.is_empty() => {}
            (Moment::Choice { .. }, BrowserInput::Choice { index }) => {
                return Err(format!(
                    "siglus-live-player only executed authored choice index 0; received {index}"
                )
                .into());
            }
            (Moment::Choice { .. }, _) => {
                return Err(
                    "siglus-live-player requires choice input at this authored gate".into(),
                );
            }
            (_, BrowserInput::Advance) => {}
            (_, BrowserInput::Pointer) => {
                return Err(
                    "siglus-live-player has no authored pointer gate at this boundary".into(),
                );
            }
            (_, BrowserInput::Choice { .. }) => {
                return Err(
                    "siglus-live-player has no authored choice gate at this boundary".into(),
                );
            }
            (_, BrowserInput::Close) => unreachable!(),
        }
        if index + 1 < boundaries.len() {
            index += 1;
            rendered = render_boundary(
                &root,
                &artifact_root,
                run_id,
                message_window,
                boundaries[index].clone(),
                index,
                &mut cache,
            )?;
        }
        write_response(
            &mut io::stdout(),
            response(&rendered, index, reveal, index + 1 == boundaries.len()),
        )?;
    }
    Ok(())
}

fn has_renderable_stage(root: &Path, snapshot: &StageSnapshot) -> bool {
    let visible = snapshot
        .state
        .stage_objects
        .values()
        .flat_map(|slots| slots.values())
        .filter(|object| object.active && object.visible)
        .collect::<Vec<_>>();
    !visible.is_empty()
        && visible.iter().all(|object| {
            object.identity.as_ref().is_some_and(|identity| {
                let file = if identity.to_ascii_lowercase().ends_with(".g00") {
                    identity.clone()
                } else {
                    format!("{identity}.g00")
                };
                crate::render_validate_g00::g00_path(&root.join("g00"), &file).is_file()
            })
        })
}

fn has_nondefault_stage_position(snapshot: &StageSnapshot) -> bool {
    snapshot
        .state
        .stage_objects
        .values()
        .flat_map(|slots| slots.values())
        .any(|object| {
            object.active
                && object.visible
                && object.identity.is_some()
                && (object.geometry.x != 0 || object.geometry.y != 0 || object.geometry.z != 0)
        })
}

fn load_title(
    root: &Path,
) -> Result<(TitleProgram, Vec<u32>, MessageWindowProjection), Box<dyn Error>> {
    let pack = std::fs::read(root.join("Scene.pck"))?;
    let executable = std::fs::read(root.join("SiglusEngine.exe"))?;
    let gameexe = std::fs::read(root.join("Gameexe.dat"))?;
    let index = parse_scene_pck(&pack)?;
    let key = recover_exe_angou_key(
        &executable,
        &SiglusSecondLayerKey::from_secret_ref("secret://utsushi/siglus-live-player"),
    )?;
    let gameexe_key =
        (read_gameexe_header(&gameexe)?.exe_angou_mode != 0).then_some(key.material());
    let gameexe = decode_gameexe_dat(&gameexe, gameexe_key)?;
    let message_window = MessageWindowProjection::from_gameexe(&gameexe.entries);
    let mut programs = Vec::with_capacity(index.entries.len());
    let names = index
        .entries
        .iter()
        .filter_map(|entry| entry.scene_name.clone().map(|name| (name, entry.scene_id)))
        .collect::<BTreeMap<_, _>>();
    for entry in &index.entries {
        let start = entry.byte_offset as usize;
        let end = start + entry.byte_len as usize;
        let payload = decode_scene_chunk(
            entry.scene_id,
            &pack[start..end],
            index.extra_key_use,
            index.extra_key_use.then_some(key.material()),
        )?;
        programs.push(SceneProgram::from_payload(entry.scene_id, &payload)?);
    }
    let scene_ids = index.entries.iter().map(|entry| entry.scene_id).collect();
    Ok((
        TitleProgram::from_scenes_with_names(
            programs,
            names.into_iter().collect(),
            &index.included_commands,
        )?,
        scene_ids,
        message_window,
    ))
}

fn response(boundary: &RenderedBoundary, event_index: usize, reveal: bool, ended: bool) -> Value {
    let (path, artifact_id) = if reveal {
        (
            &boundary.private_path,
            format!("private:{}", boundary.private_sha256),
        )
    } else {
        (
            &boundary.public_path,
            format!("public:{}", boundary.public_sha256),
        )
    };
    let waiting_for = if ended {
        Value::Null
    } else {
        match &boundary.snapshot.moment {
            Moment::Choice { options, .. } => {
                json!({"type":"choice", "choiceCount": options.len(), "options": options})
            }
            Moment::Text { .. } => json!({"type":"advance"}),
        }
    };
    json!({
        "scene": boundary.snapshot.scene_id,
        "instructionPointer": boundary.snapshot.instruction_pointer,
        "eventIndex": event_index,
        "waitingFor": waiting_for,
        "ended": ended,
        "frame": {"path": path, "artifactId": artifact_id, "width": boundary.width, "height": boundary.height, "nonBackgroundPixels": boundary.non_background_pixels},
    })
}

fn write_response(out: &mut impl Write, value: Value) -> Result<(), Box<dyn Error>> {
    writeln!(out, "{}", serde_json::to_string(&value)?)?;
    out.flush()?;
    Ok(())
}

fn required_flag<'a>(args: &'a [String], name: &str) -> Result<&'a str, Box<dyn Error>> {
    optional_flag(args, name).ok_or_else(|| format!("{USAGE}; missing {name}").into())
}

fn optional_flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|index| args.get(index + 1))
        .map(String::as_str)
}

#[cfg(test)]
#[path = "siglus_live_player/tests.rs"]
mod tests;
