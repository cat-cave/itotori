//! Persistent real-byte Siglus stage player for the browser session bridge.
//!
//! It precomputes only actual text/choice boundaries from one decoded entry
//! scene, each paired with the stage state produced by that exact execution.
//! There is deliberately no image fallback: if a visible stage object cannot
//! resolve to an installed supported G00, launching fails.

use std::collections::{BTreeMap, HashMap};
use std::error::Error;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};

use kaifuu_siglus::{
    SiglusSecondLayerKey, decode_scene_chunk, parse_scene_pck, recover_exe_angou_key,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use utsushi_siglus::scene_vm::{
    ExecutionOutcome, Moment, SceneProgram, StageSnapshot, TitleProgram, VmState,
    execute_title_scene_with_stage_snapshots_observed,
};
use utsushi_siglus::{
    SiglusCgFrame, SiglusG00Image, SiglusG00Kind, SiglusStageRenderError, decode_siglus_g00,
    encode_siglus_png, render_siglus_cg, render_siglus_stage,
};

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
    let (title, scene_ids) = load_title(&root)?;
    let selected = if scene == 0 { scene_ids } else { vec![scene] };
    let mut boundaries = None;
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
        if snapshots.is_empty() {
            continue;
        }
        let rendered = render_boundaries(&root, &artifact_root, run_id, snapshots)?;
        if !rendered.is_empty() {
            boundaries = Some(rendered);
            break;
        }
    }
    let boundaries = boundaries.ok_or_else(|| {
        let suffix = first_terminal
            .map(|error| format!("; first terminal diagnostic: {error}"))
            .unwrap_or_default();
        format!("siglus-live-player found no text/choice boundary with a real visible stage object{suffix}")
    })?;
    let mut index = 0usize;
    write_response(
        &mut io::stdout(),
        response(&boundaries[index], index, reveal, false),
    )?;
    for line in io::stdin().lock().lines() {
        let input: BrowserInput = serde_json::from_str(&line?)?;
        if matches!(input, BrowserInput::Close) {
            write_response(&mut io::stdout(), json!({"closed": true}))?;
            return Ok(());
        }
        let boundary = &boundaries[index];
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
        }
        write_response(
            &mut io::stdout(),
            response(
                &boundaries[index],
                index,
                reveal,
                index + 1 == boundaries.len(),
            ),
        )?;
    }
    Ok(())
}

fn load_title(root: &Path) -> Result<(TitleProgram, Vec<u32>), Box<dyn Error>> {
    let pack = std::fs::read(root.join("Scene.pck"))?;
    let executable = std::fs::read(root.join("SiglusEngine.exe"))?;
    let index = parse_scene_pck(&pack)?;
    let key = recover_exe_angou_key(
        &executable,
        &SiglusSecondLayerKey::from_secret_ref("secret://utsushi/siglus-live-player"),
    )?;
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
    ))
}

fn render_boundaries(
    root: &Path,
    artifact_root: &Path,
    run_id: &str,
    snapshots: Vec<StageSnapshot>,
) -> Result<Vec<RenderedBoundary>, Box<dyn Error>> {
    let private_root = artifact_root
        .with_extension("private-siglus-live-player")
        .join(run_id);
    let public_root = artifact_root.join("siglus-live-player").join(run_id);
    std::fs::create_dir_all(&private_root)?;
    std::fs::create_dir_all(&public_root)?;
    let mut cache = HashMap::new();
    let mut boundaries = Vec::new();
    for snapshot in snapshots {
        let frame = match render_siglus_stage(&snapshot.state.stage_objects, |identity| {
            load_g00(root, identity, &mut cache)
        }) {
            Ok(frame) => frame,
            Err(SiglusStageRenderError::NoVisibleObjects) => continue,
            Err(error) => return Err(error.into()),
        };
        let public = redact_frame(&frame)?;
        let private_png = encode_siglus_png(&frame)?;
        let public_png = encode_siglus_png(&public)?;
        let index = boundaries.len();
        let private_path = private_root.join(format!("frame-{index:04}.png"));
        let public_path = public_root.join(format!("frame-{index:04}.png"));
        std::fs::write(&private_path, &private_png)?;
        std::fs::write(&public_path, &public_png)?;
        boundaries.push(RenderedBoundary {
            snapshot,
            private_path,
            public_path,
            private_sha256: sha256(&private_png),
            public_sha256: sha256(&public_png),
            width: frame.width,
            height: frame.height,
        });
    }
    Ok(boundaries)
}

fn load_g00(
    root: &Path,
    identity: &str,
    cache: &mut HashMap<String, SiglusG00Image>,
) -> Result<SiglusG00Image, String> {
    if let Some(image) = cache.get(identity) {
        return Ok(image.clone());
    }
    let name = if identity.to_ascii_lowercase().ends_with(".g00") {
        identity.to_string()
    } else {
        format!("{identity}.g00")
    };
    let path = root.join("g00").join(name);
    let bytes = std::fs::read(&path).map_err(|error| format!("{}: {error}", path.display()))?;
    let image = decode_siglus_g00(&bytes).map_err(|error| error.to_string())?;
    cache.insert(identity.to_string(), image.clone());
    Ok(image)
}

fn redact_frame(frame: &SiglusCgFrame) -> Result<SiglusCgFrame, Box<dyn Error>> {
    let image = SiglusG00Image {
        kind: SiglusG00Kind::RawBgr,
        width: frame.width,
        height: frame.height,
        pixels_rgba: frame.pixels_rgba.clone(),
        layers: Vec::new(),
    };
    Ok(render_siglus_cg(&image, Default::default())?)
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
        "frame": {"path": path, "artifactId": artifact_id, "width": boundary.width, "height": boundary.height},
    })
}

fn sha256(bytes: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(bytes);
    format!("{:x}", digest.finalize())
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
