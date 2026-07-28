//! Persistent real-byte Siglus stage player for the browser session bridge.
//! It precomputes only actual text/choice boundaries from one decoded entry
//! scene, each paired with the stage state produced by that exact execution.
//! There is deliberately no image fallback: if a visible stage object cannot
//! resolve to an installed supported G00, launching fails.
use kaifuu_siglus::{
    GameexeDatEntry, SiglusSecondLayerKey, decode_gameexe_dat, decode_scene_chunk, parse_scene_pck,
    read_gameexe_header, recover_exe_angou_key,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::error::Error;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use utsushi_reallive::{Framebuffer, TextLayer, WipeColour};
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
    non_background_pixels: usize,
}

/// The Gameexe-driven portion of the Siglus message-window projection.
///
/// Stage `MWND` commands can alter this during a full VM run.  The executable
/// slice currently captures the authored text/choice boundary and the root
/// stage, but not those UI mutations, so this is the decoded `MWND.000`
/// template the reference starts from.  We deliberately draw no made-up waku
/// image: absent an executed, resolvable waku object, only actual text is
/// composited over the real stage frame.
#[derive(Debug, Clone, Copy)]
struct MessageWindowProjection {
    virtual_size: Option<(u32, u32)>,
    window_pos: (i32, i32),
    window_size: (u32, u32),
    message_pos: (i32, i32),
    message_margin: (i32, i32, i32, i32),
    moji_count: Option<(usize, usize)>,
    moji_size: u32,
    moji_space: (i32, i32),
    extend_type: i32,
}

impl Default for MessageWindowProjection {
    fn default() -> Self {
        // These are the reference runtime's documented MwndTemplate defaults;
        // they apply only when the decoded Gameexe omits the corresponding
        // template field.
        Self {
            virtual_size: None,
            window_pos: (50, 400),
            window_size: (700, 150),
            message_pos: (20, 20),
            message_margin: (20, 20, 20, 20),
            moji_count: Some((26, 3)),
            moji_size: 25,
            moji_space: (-1, 10),
            extend_type: 0,
        }
    }
}

impl MessageWindowProjection {
    fn from_gameexe(entries: &[GameexeDatEntry]) -> Self {
        let mut projection = Self::default();
        let entries = entries
            .iter()
            .map(|entry| (entry.key.to_ascii_uppercase(), entry.value.as_str()))
            .collect::<BTreeMap<_, _>>();
        let get = |key: &str| entries.get(key).copied();
        projection.virtual_size = get("SCREEN_SIZE")
            .and_then(parse_pair)
            .and_then(to_positive_pair)
            .or_else(|| {
                get("WINDOW_SIZE")
                    .and_then(parse_pair)
                    .and_then(to_positive_pair)
            });
        if let Some(value) = get("MWND.000.WINDOW_POS").and_then(parse_pair) {
            projection.window_pos = value;
        }
        if let Some(value) = get("MWND.000.WINDOW_SIZE")
            .and_then(parse_pair)
            .and_then(to_positive_pair)
        {
            projection.window_size = value;
        }
        if let Some(value) = get("MWND.000.MESSAGE_POS").and_then(parse_pair) {
            projection.message_pos = value;
        }
        if let Some(value) = get("MWND.000.MESSAGE_MARGIN").and_then(parse_quad) {
            projection.message_margin = value;
        }
        if let Some((columns, rows)) = get("MWND.000.MOJI_CNT").and_then(parse_pair) {
            projection.moji_count =
                (columns > 0 && rows > 0).then(|| (columns as usize, rows as usize));
        }
        if let Some(size) = get("MWND.000.MOJI_SIZE").and_then(parse_integer) {
            if size > 0 {
                projection.moji_size = size as u32;
            }
        }
        if let Some(value) = get("MWND.000.MOJI_SPACE").and_then(parse_pair) {
            projection.moji_space = value;
        }
        if let Some(value) = get("MWND.000.EXTEND_TYPE").and_then(parse_integer) {
            projection.extend_type = value;
        }
        projection
    }

    fn scale_x(self, frame_width: u32) -> f32 {
        frame_width as f32 / self.virtual_size.map_or(frame_width, |size| size.0).max(1) as f32
    }

    fn scale_y(self, frame_height: u32) -> f32 {
        frame_height as f32 / self.virtual_size.map_or(frame_height, |size| size.1).max(1) as f32
    }

    fn scale_x_value(self, value: i32, frame_width: u32) -> u32 {
        (value.max(0) as f32 * self.scale_x(frame_width)).round() as u32
    }

    fn scale_y_value(self, value: i32, frame_height: u32) -> u32 {
        (value.max(0) as f32 * self.scale_y(frame_height)).round() as u32
    }

    fn message_rect(self, frame_width: u32, frame_height: u32) -> (u32, u32, u32, u32) {
        let x = self.scale_x_value(self.window_pos.0, frame_width);
        let y = self.scale_y_value(self.window_pos.1, frame_height);
        let width = self
            .scale_x_value(self.window_size.0 as i32, frame_width)
            .max(1);
        let height = self
            .scale_y_value(self.window_size.1 as i32, frame_height)
            .max(1);
        if self.extend_type == 1 {
            let (left, top, right, bottom) = self.message_margin;
            let origin_x = x.saturating_add(self.scale_x_value(left, frame_width));
            let origin_y = y.saturating_add(self.scale_y_value(top, frame_height));
            return (
                origin_x,
                origin_y,
                width
                    .saturating_sub(self.scale_x_value(left.saturating_add(right), frame_width))
                    .max(1),
                height
                    .saturating_sub(self.scale_y_value(top.saturating_add(bottom), frame_height))
                    .max(1),
            );
        }
        let origin_x = x.saturating_add(self.scale_x_value(self.message_pos.0, frame_width));
        let origin_y = y.saturating_add(self.scale_y_value(self.message_pos.1, frame_height));
        let (text_width, text_height) = self.moji_count.map_or_else(
            || {
                let (_, _, right, bottom) = self.message_margin;
                (
                    x.saturating_add(width)
                        .saturating_sub(origin_x)
                        .saturating_sub(self.scale_x_value(right, frame_width))
                        .max(1),
                    y.saturating_add(height)
                        .saturating_sub(origin_y)
                        .saturating_sub(self.scale_y_value(bottom, frame_height))
                        .max(1),
                )
            },
            |(columns, rows)| {
                let horizontal = self.moji_size as i32 * columns as i32
                    + self.moji_space.0 * columns.saturating_sub(1) as i32;
                let vertical = self.moji_size as i32 * rows as i32
                    + self.moji_space.1 * rows.saturating_sub(1) as i32;
                (
                    self.scale_x_value(horizontal.max(1), frame_width),
                    self.scale_y_value(vertical.max(self.moji_size as i32), frame_height),
                )
            },
        );
        (origin_x, origin_y, text_width, text_height)
    }
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
        let rendered =
            render_boundaries(&root, &artifact_root, run_id, message_window, positioned)?;
        if !rendered.is_empty() {
            boundaries = Some(rendered);
            break;
        }
    }
    let boundaries = if let Some(boundaries) = boundaries {
        boundaries
    } else if let Some(snapshots) = fallback_snapshots {
        render_boundaries(&root, &artifact_root, run_id, message_window, snapshots)?
    } else {
        let suffix = first_terminal
            .map(|error| format!("; first terminal diagnostic: {error}"))
            .unwrap_or_default();
        return Err(format!("siglus-live-player found no text/choice boundary with a real visible stage object{suffix}").into());
    };
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

fn render_boundaries(
    root: &Path,
    artifact_root: &Path,
    run_id: &str,
    message_window: MessageWindowProjection,
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
        let mut frame = match render_siglus_stage(&snapshot.state.stage_objects, |identity| {
            load_g00(root, identity, &mut cache)
        }) {
            Ok(frame) => frame,
            Err(SiglusStageRenderError::NoVisibleObjects) => continue,
            Err(error) => return Err(error.into()),
        };
        composite_message_window(&mut frame, &snapshot.moment, message_window)?;
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
            non_background_pixels: non_background_pixel_count(&frame),
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
    let path = crate::render_validate_g00::g00_path(&root.join("g00"), &name);
    let bytes = std::fs::read(&path).map_err(|error| format!("{}: {error}", path.display()))?;
    let image = decode_siglus_g00(&bytes).map_err(|error| error.to_string())?;
    cache.insert(identity.to_string(), image.clone());
    Ok(image)
}

/// Composite the exact text or choice labels emitted at this VM boundary.
///
/// The stage frame remains untouched except where the embedded Japanese-capable
/// rasteriser paints decoded characters.  In particular, this does not invent
/// a message-window skin: the `MWND.WAKU` graphics path is not yet part of the
/// executed root-stage state, so drawing one would be a fabricated layer.
fn composite_message_window(
    frame: &mut SiglusCgFrame,
    moment: &Moment,
    projection: MessageWindowProjection,
) -> Result<(), Box<dyn Error>> {
    let (origin_x, origin_y, _text_width, _text_height) =
        projection.message_rect(frame.width, frame.height);
    let scale = (projection.moji_size as f32 * projection.scale_y(frame.height))
        .round()
        .max(1.0) as u32;
    let line_height = ((projection.moji_size as i32 + projection.moji_space.1).max(1) as f32
        * projection.scale_y(frame.height))
    .round()
    .max(scale as f32) as u32;
    let lines = match moment {
        Moment::Text { text, .. } => {
            wrap_message_text(text, projection.moji_count.map(|count| count.0))
        }
        Moment::Choice { options, .. } => options
            .iter()
            .enumerate()
            .flat_map(|(index, option)| {
                let prefix = if index == 0 { "> " } else { "  " };
                wrap_message_text(option, projection.moji_count.map(|count| count.0))
                    .into_iter()
                    .enumerate()
                    .map(move |(line, text)| {
                        if line == 0 {
                            format!("{prefix}{text}")
                        } else {
                            format!("  {text}")
                        }
                    })
            })
            .collect(),
    };
    if lines.iter().all(|line: &String| line.is_empty()) {
        return Err("siglus-live-player reached an empty authored message boundary".into());
    }
    let mut text_surface = Framebuffer::new(frame.width, frame.height);
    let painted = text_surface.draw_text(&TextLayer {
        lines,
        origin_x,
        origin_y,
        scale,
        colour: WipeColour::WHITE,
        backdrop: None,
        name_box: None,
        line_height: Some(line_height),
    });
    if painted == 0 {
        return Err("siglus-live-player decoded message text painted zero pixels".into());
    }
    source_over_frame(&mut frame.pixels_rgba, text_surface.pixels())?;
    Ok(())
}

/// Wrap with the reference `MOJI_CNT` cell count.  The glyph rasteriser still
/// owns glyph shape; this only preserves the authored character order at the
/// text-area's decoded column boundary.
fn wrap_message_text(text: &str, column_count: Option<usize>) -> Vec<String> {
    let Some(column_count) = column_count.filter(|count| *count > 0) else {
        return text.split('\n').map(ToOwned::to_owned).collect();
    };
    let mut lines = vec![String::new()];
    let mut columns = 0usize;
    for character in text.chars() {
        if character == '\n' {
            lines.push(String::new());
            columns = 0;
            continue;
        }
        let width =
            usize::from(!(character.is_ascii() || matches!(character as u32, 0xff61..=0xff9f))) + 1;
        if columns > 0 && columns + width > column_count {
            lines.push(String::new());
            columns = 0;
        }
        lines
            .last_mut()
            .expect("message lines is never empty")
            .push(character);
        columns += width;
    }
    lines
}

fn source_over_frame(destination: &mut [u8], source: &[u8]) -> Result<(), Box<dyn Error>> {
    if destination.len() != source.len() || destination.len() % 4 != 0 {
        return Err("siglus-live-player text surface dimensions disagreed with stage frame".into());
    }
    for (destination, source) in destination.chunks_exact_mut(4).zip(source.chunks_exact(4)) {
        let source_alpha = u32::from(source[3]);
        if source_alpha == 0 {
            continue;
        }
        let destination_alpha = u32::from(destination[3]);
        let output_alpha = source_alpha + (destination_alpha * (255 - source_alpha) + 127) / 255;
        for channel in 0..3 {
            let numerator = u32::from(source[channel]) * source_alpha * 255
                + u32::from(destination[channel]) * destination_alpha * (255 - source_alpha);
            destination[channel] = (numerator / (output_alpha * 255)).min(255) as u8;
        }
        destination[3] = output_alpha as u8;
    }
    Ok(())
}

fn parse_integer(value: &str) -> Option<i32> {
    value.trim().trim_matches('"').parse().ok()
}

fn parse_pair(value: &str) -> Option<(i32, i32)> {
    let values = value
        .trim()
        .trim_matches('"')
        .split(',')
        .map(str::trim)
        .map(str::parse::<i32>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    (values.len() >= 2).then_some((values[0], values[1]))
}

fn parse_quad(value: &str) -> Option<(i32, i32, i32, i32)> {
    let values = value
        .trim()
        .trim_matches('"')
        .split(',')
        .map(str::trim)
        .map(str::parse::<i32>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    (values.len() >= 4).then_some((values[0], values[1], values[2], values[3]))
}

fn to_positive_pair(value: (i32, i32)) -> Option<(u32, u32)> {
    (value.0 > 0 && value.1 > 0).then_some((value.0 as u32, value.1 as u32))
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
        "frame": {"path": path, "artifactId": artifact_id, "width": boundary.width, "height": boundary.height, "nonBackgroundPixels": boundary.non_background_pixels},
    })
}

fn sha256(bytes: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(bytes);
    format!("{:x}", digest.finalize())
}

fn non_background_pixel_count(frame: &SiglusCgFrame) -> usize {
    frame
        .pixels_rgba
        .first_chunk::<4>()
        .map_or(0, |background| {
            frame
                .pixels_rgba
                .chunks_exact(4)
                .filter(|pixel| pixel[..3] != background[..3])
                .count()
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
mod tests {
    use super::*;
    #[path = "siglus_live_player_scan_tests.rs"]
    mod scan;

    fn opaque_black_frame() -> SiglusCgFrame {
        SiglusCgFrame {
            width: 800,
            height: 600,
            pixels_rgba: vec![0, 0, 0, 255].repeat(800 * 600),
        }
    }

    #[test]
    fn authored_boundary_text_changes_the_composited_stage_frame() {
        let mut first = opaque_black_frame();
        let mut second = opaque_black_frame();
        composite_message_window(
            &mut first,
            &Moment::Text {
                scene_id: 7,
                offset: 11,
                speaker: None,
                text: "最初の実行済みメッセージ".to_string(),
            },
            MessageWindowProjection::default(),
        )
        .expect("the authored text boundary must rasterise onto its real stage frame");
        composite_message_window(
            &mut second,
            &Moment::Text {
                scene_id: 7,
                offset: 12,
                speaker: None,
                text: "次の実行済みメッセージ".to_string(),
            },
            MessageWindowProjection::default(),
        )
        .expect("a later authored text boundary must rasterise onto its real stage frame");

        assert_ne!(
            first.pixels_rgba, second.pixels_rgba,
            "deleting message-window compositing makes distinct authored boundaries produce the same stage-only frame"
        );
    }

    #[test]
    fn decoded_mwnd_template_controls_message_projection() {
        let projection = MessageWindowProjection::from_gameexe(&[
            GameexeDatEntry {
                key: "SCREEN_SIZE".to_string(),
                value: "1280, 720".to_string(),
            },
            GameexeDatEntry {
                key: "MWND.000.WINDOW_POS".to_string(),
                value: "100, 500".to_string(),
            },
            GameexeDatEntry {
                key: "MWND.000.MESSAGE_POS".to_string(),
                value: "30, 40".to_string(),
            },
            GameexeDatEntry {
                key: "MWND.000.MOJI_SIZE".to_string(),
                value: "32".to_string(),
            },
        ]);

        assert_eq!(projection.message_rect(2560, 1440).0, 260);
        assert_eq!(projection.message_rect(2560, 1440).1, 1080);
        assert_eq!(projection.moji_size, 32);
    }

    #[test]
    fn real_siglus_positioned_message_boundary_is_measured() {
        let Some(root) = std::env::var_os("ITOTORI_REAL_GAME_ROOT_SIGLUS").map(PathBuf::from)
        else {
            return;
        };
        let (title, scene_ids, _) = load_title(&root).expect("load real Siglus title");
        let mut text_scenes = 0usize;
        let mut positioned_scenes = 0usize;
        let mut renderable_scenes = 0usize;
        let mut positioned_renderable_scenes = 0usize;
        let mut text_boundaries = 0usize;
        let mut background_scenes = 0usize;
        let mut nonblack_background_text_scenes = 0usize;
        let mut detailed_background_text_scenes = 0usize;
        let mut positioned_boundaries = 0usize;
        let mut renderable_boundaries = 0usize;
        let mut positioned_renderable_boundary_count = 0usize;
        let mut positioned_renderable_boundaries = Vec::new();
        for scene_id in scene_ids {
            let mut state = VmState::default();
            let snapshots = match execute_title_scene_with_stage_snapshots_observed(
                &title, scene_id, &mut state,
            )
            .expect("execute title scene")
            {
                ExecutionOutcome::Complete(report) | ExecutionOutcome::Terminal { report, .. } => {
                    report.stage_snapshots
                }
            };
            if snapshots.is_empty() {
                continue;
            }
            text_scenes += 1;
            text_boundaries += snapshots.len();
            let (has_background, nonblack, detailed) =
                scan::scene_background_stats(&root, &snapshots);
            background_scenes += usize::from(has_background);
            nonblack_background_text_scenes += usize::from(nonblack);
            detailed_background_text_scenes += usize::from(detailed);
            let positioned = snapshots.iter().any(has_nondefault_stage_position);
            let renderable = snapshots
                .iter()
                .any(|snapshot| has_renderable_stage(&root, snapshot));
            positioned_scenes += usize::from(positioned);
            renderable_scenes += usize::from(renderable);
            positioned_renderable_scenes += usize::from(positioned && renderable);
            let boundary_count = snapshots
                .iter()
                .filter(|snapshot| {
                    has_nondefault_stage_position(snapshot) && has_renderable_stage(&root, snapshot)
                })
                .count();
            positioned_boundaries += snapshots
                .iter()
                .filter(|snapshot| has_nondefault_stage_position(snapshot))
                .count();
            renderable_boundaries += snapshots
                .iter()
                .filter(|snapshot| has_renderable_stage(&root, snapshot))
                .count();
            positioned_renderable_boundary_count += boundary_count;
            if boundary_count > 0 {
                positioned_renderable_boundaries.push((scene_id, boundary_count));
            }
        }
        eprintln!(
            "REAL siglus player boundaries: text_scenes={text_scenes} background_scenes={background_scenes} nonblack_background_text_scenes={nonblack_background_text_scenes} detailed_background_text_scenes={detailed_background_text_scenes} positioned_scenes={positioned_scenes} renderable_scenes={renderable_scenes} positioned_renderable_scenes={positioned_renderable_scenes} text_boundaries={text_boundaries} positioned_boundaries={positioned_boundaries} renderable_boundaries={renderable_boundaries} positioned_renderable_boundary_count={positioned_renderable_boundary_count} positioned_renderable_boundaries={positioned_renderable_boundaries:?}"
        );
        assert!(
            positioned_scenes > 0,
            "real title must retain positioned text boundaries"
        );
    }
}
