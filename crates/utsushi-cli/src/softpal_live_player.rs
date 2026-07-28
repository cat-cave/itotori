//! Persistent real-byte Softpal text player for the browser session bridge.
//!
//! A Softpal player starts only at a `POINT.DAT` designation supplied by its
//! trusted launch descriptor.  It executes that exact VM route, keeps each
//! emitted dialogue boundary in order, and rasterises only the decoded
//! speaker/text glyphs.  In particular, it does not reuse the Softpal layout
//! probe: its message-box bars and skin are not game-authored pixels.

use std::error::Error;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};

use kaifuu_softpal::{PacArchive, ScriptScan, TextDat};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use utsushi_reallive::{Framebuffer, TextLayer, WipeColour, encode_png_rgba_deterministic};
use utsushi_softpal::{SceneStep, SoftpalScene, encode_softpal_png, point_entry_offsets};

use crate::softpal_visual_assets::{SceneArt, art_frame};

const USAGE: &str = "usage: utsushi softpal-live-player --game-root <DIR> --point <N> --artifact-root <DIR> [--run-id <ID>] [--redaction on] [--reveal]";
const FRAME_WIDTH: u32 = 800;
const FRAME_HEIGHT: u32 = 600;

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
    command_offset: usize,
    private_path: PathBuf,
    public_path: PathBuf,
    private_sha256: String,
    public_sha256: String,
    source_assets: String,
}

#[derive(Debug, Clone, Copy)]
struct OracleOverlap {
    executed: usize,
    ordered: usize,
    static_count: usize,
}

pub(crate) fn run_softpal_live_player_command(args: &[String]) -> Result<(), Box<dyn Error>> {
    let game_root = PathBuf::from(required_flag(args, "--game-root")?);
    let point_id: u32 = required_flag(args, "--point")?.parse()?;
    let artifact_root = PathBuf::from(required_flag(args, "--artifact-root")?);
    let run_id = optional_flag(args, "--run-id").unwrap_or("softpal-browser-player");
    match optional_flag(args, "--redaction") {
        None | Some("on") => {}
        Some(value) => {
            return Err(format!(
                "softpal-live-player --redaction must be on; full-fidelity frames use --reveal and the private artifact path, got {value}"
            )
            .into());
        }
    }
    let reveal = args.iter().any(|arg| arg == "--reveal");
    let inputs = load_inputs(&game_root)?;
    // Decode the table before executing.  This makes a bad id a named error
    // rather than an accidental root launch or an arbitrary script offset.
    let point_count = point_entry_offsets(&inputs.points)?.len();
    if point_id == 0 || point_id as usize > point_count {
        return Err(format!(
            "softpal-live-player point {point_id} is outside the {point_count}-entry POINT.DAT table"
        )
        .into());
    }
    let scene = SoftpalScene::execute_from_point_with_points_mem_dat_and_pacs(
        &inputs.script,
        &inputs.textdat,
        &inputs.points,
        Some(&inputs.mem_dat),
        &[&inputs.data_pac, &inputs.csv_pac],
        point_id,
    )?;
    let overlap = verify_ordered_oracle_overlap(&inputs.script, &inputs.textdat, &scene)?;
    let art = SceneArt::load(&game_root)
        .map_err(|error| format!("softpal-live-player scene art: {error}"))?;
    let boundaries = render_boundaries(&scene, &artifact_root, run_id, &art)?;
    if boundaries.is_empty() {
        return Err(
            "softpal-live-player point entry emitted no renderable decoded dialogue".into(),
        );
    }
    let terminal_diagnostic = scene
        .diagnostics
        .first()
        .map(|diagnostic| diagnostic.signature.clone());
    let mut index = 0usize;
    write_response(
        &mut io::stdout(),
        response(
            &boundaries[index],
            point_id,
            index,
            reveal,
            &overlap,
            terminal_diagnostic.as_deref(),
        ),
    )?;
    for line in io::stdin().lock().lines() {
        let input: BrowserInput = serde_json::from_str(&line?)?;
        if matches!(input, BrowserInput::Close) {
            write_response(&mut io::stdout(), json!({"closed": true}))?;
            return Ok(());
        }
        match input {
            BrowserInput::Advance if index + 1 < boundaries.len() => index += 1,
            BrowserInput::Advance => {
                let diagnostic = terminal_diagnostic
                    .as_deref()
                    .unwrap_or("softpal_scene_ended");
                return Err(format!(
                    "softpal-live-player cannot advance past executed boundary: {diagnostic}"
                )
                .into());
            }
            BrowserInput::Pointer => {
                return Err(
                    "softpal-live-player has no executed pointer gate at this boundary".into(),
                );
            }
            BrowserInput::Choice { index } => {
                return Err(format!(
                    "softpal-live-player has no executed choice gate at this boundary; received {index}"
                )
                .into());
            }
            BrowserInput::Close => unreachable!(),
        }
        write_response(
            &mut io::stdout(),
            response(
                &boundaries[index],
                point_id,
                index,
                reveal,
                &overlap,
                terminal_diagnostic.as_deref(),
            ),
        )?;
    }
    Ok(())
}

struct SoftpalInputs {
    data_pac: Vec<u8>,
    csv_pac: Vec<u8>,
    script: Vec<u8>,
    textdat: Vec<u8>,
    points: Vec<u8>,
    mem_dat: Vec<u8>,
}

fn load_inputs(root: &Path) -> Result<SoftpalInputs, Box<dyn Error>> {
    let data_pac = std::fs::read(root.join("data.pac"))?;
    let archive = PacArchive::parse(&data_pac)?;
    let extract = |name| -> Result<Vec<u8>, Box<dyn Error>> {
        let entry = archive
            .find(name)
            .ok_or_else(|| format!("softpal-live-player data.pac is missing {name}"))?;
        Ok(archive.extract(&data_pac, entry)?.to_vec())
    };
    Ok(SoftpalInputs {
        script: extract("SCRIPT.SRC")?,
        textdat: extract("TEXT.DAT")?,
        points: extract("POINT.DAT")?,
        mem_dat: extract("MEM.DAT")?,
        data_pac,
        csv_pac: std::fs::read(root.join("csv.pac"))?,
    })
}

fn verify_ordered_oracle_overlap(
    script: &[u8],
    textdat: &[u8],
    scene: &SoftpalScene,
) -> Result<OracleOverlap, Box<dyn Error>> {
    let disassembly = ScriptScan::parse(script)?.resolve(&TextDat::parse(textdat)?);
    if !disassembly.is_fully_resolved() {
        return Err("softpal-live-player static dialogue oracle is unresolved".into());
    }
    let expected = disassembly
        .dialogue
        .iter()
        .map(|unit| unit.command_offset)
        .collect::<Vec<_>>();
    let observed = scene
        .steps
        .iter()
        .filter_map(|step| match step {
            SceneStep::Dialogue { command_offset, .. } => Some(*command_offset),
            _ => None,
        })
        .collect::<Vec<_>>();
    let mut expected_cursor = 0usize;
    let mut ordered = 0usize;
    for observed_offset in &observed {
        let Some(relative) = expected[expected_cursor..]
            .iter()
            .position(|expected_offset| expected_offset == observed_offset)
        else {
            break;
        };
        ordered += 1;
        expected_cursor += relative + 1;
    }
    if ordered != observed.len() {
        return Err(format!(
            "softpal-live-player executed text lost ordered static-oracle overlap: {ordered}/{}",
            observed.len()
        )
        .into());
    }
    Ok(OracleOverlap {
        executed: observed.len(),
        ordered,
        static_count: expected.len(),
    })
}

fn render_boundaries(
    scene: &SoftpalScene,
    artifact_root: &Path,
    run_id: &str,
    art: &SceneArt,
) -> Result<Vec<RenderedBoundary>, Box<dyn Error>> {
    let private_root = artifact_root
        .with_extension("private-softpal-live-player")
        .join(run_id);
    let public_root = artifact_root.join("softpal-live-player").join(run_id);
    std::fs::create_dir_all(&private_root)?;
    std::fs::create_dir_all(&public_root)?;
    let mut boundaries = Vec::new();
    for step in &scene.steps {
        let SceneStep::Dialogue {
            command_offset,
            speaker,
            text,
        } = step
        else {
            continue;
        };
        let private = encode_softpal_png(&art_frame(art, speaker.as_deref(), text)?)?;
        // The managed browser frame retains only a sparse glyph projection.
        // It is derived from the same decoded characters (not a placeholder or
        // window shape), while the readable 24px frame is written solely to
        // the sibling private artifact path selected by `--reveal`.
        let public = render_decoded_text(
            speaker.as_deref(),
            text,
            2,
            WipeColour::opaque_rgb(112, 112, 112),
        )?;
        let index = boundaries.len();
        let private_path = private_root.join(format!("frame-{index:04}.png"));
        let public_path = public_root.join(format!("frame-{index:04}.png"));
        std::fs::write(&private_path, &private)?;
        std::fs::write(&public_path, &public)?;
        boundaries.push(RenderedBoundary {
            command_offset: *command_offset,
            private_sha256: sha256(&private),
            public_sha256: sha256(&public),
            private_path,
            public_path,
            source_assets: art.description(),
        });
    }
    Ok(boundaries)
}

/// Rasterise the real decoded speaker/text and no guessed Softpal surface.
fn render_decoded_text(
    speaker: Option<&str>,
    text: &str,
    scale: u32,
    colour: WipeColour,
) -> Result<Vec<u8>, Box<dyn Error>> {
    let mut lines = Vec::new();
    if let Some(speaker) = speaker.filter(|speaker| !speaker.trim().is_empty()) {
        lines.push(speaker.to_string());
    }
    lines.extend(text.split('\n').map(ToOwned::to_owned));
    if lines.iter().all(|line| line.trim().is_empty()) {
        return Err("softpal-live-player reached an empty decoded dialogue boundary".into());
    }
    let mut frame = Framebuffer::new(FRAME_WIDTH, FRAME_HEIGHT);
    let painted = frame.draw_text(&TextLayer {
        lines,
        origin_x: 16,
        origin_y: 16,
        scale,
        colour,
        backdrop: None,
        name_box: None,
        line_height: None,
    });
    if painted == 0 {
        return Err("softpal-live-player decoded dialogue painted zero pixels".into());
    }
    Ok(encode_png_rgba_deterministic(&frame))
}

fn response(
    boundary: &RenderedBoundary,
    point_id: u32,
    event_index: usize,
    reveal: bool,
    overlap: &OracleOverlap,
    terminal_diagnostic: Option<&str>,
) -> Value {
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
    let ended = event_index + 1 == overlap.executed;
    json!({
        "scene": point_id,
        "instructionPointer": boundary.command_offset,
        "eventIndex": event_index,
        "waitingFor": if ended { Value::Null } else { json!({"type":"advance"}) },
        "ended": ended,
        "terminalDiagnostic": if ended { terminal_diagnostic } else { None },
        "oracleOverlap": {"executed": overlap.executed, "ordered": overlap.ordered, "static": overlap.static_count},
        "frame": {"path": path, "artifactId": artifact_id, "width": FRAME_WIDTH, "height": FRAME_HEIGHT, "sourceAssets": boundary.source_assets},
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decoded_text_rasterisation_changes_each_boundary_frame() {
        // Mutation proof: deleting the real glyph compositor makes both
        // transparent canvases identical, so this test fails rather than
        // accepting a player that only reports synthetic progression.
        let first = render_decoded_text(None, "first executed line", 24, WipeColour::WHITE)
            .expect("first decoded line rasterises");
        let second = render_decoded_text(None, "second executed line", 24, WipeColour::WHITE)
            .expect("second decoded line rasterises");
        assert_ne!(
            sha256(&first),
            sha256(&second),
            "distinct decoded dialogue must produce distinct rendered frames"
        );
    }
}
