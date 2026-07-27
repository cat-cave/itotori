//! Persistent stdio bridge for the browser player.
//!
//! One process owns one `LiveSession`; every JSON line is an actual user input
//! and receives the next real rasterised frame plus VM state. It deliberately
//! has no fallback to a captured PNG or an offline frame sequence.

use std::error::Error;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};
use utsushi_core::RuntimeArtifactRoot;
use utsushi_core::input::InputEvent;
use utsushi_core::substrate::AssetPackage;
use utsushi_reallive::rlop::module_sel::CHOICE_TEXT_SURFACE_PREFIX;
use utsushi_reallive::{
    ChoiceOverlay, ChoiceWindow, Gameexe, LiveSession, LiveSessionChoice, LiveSessionUpdate,
    ObjectButtonChoiceWindow, RecordingFrameArtifactSink, RenderPass, SceneEmit,
    SelectButtonLayout, TextLayer,
};

use crate::reallive_port::OnDiskG00Package;
use crate::staged_replay::staged_engine;

const USAGE: &str = "usage: utsushi live-player --seen <PATH> --scene <N> --gameexe <PATH> --g00-dir <DIR> --artifact-root <DIR> [--run-id <ID>] [--redaction on|off]";

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum BrowserInput {
    Advance,
    Choice { index: u16 },
    Close,
}

/// Run a newline-delimited JSON session. stdout is protocol-only: callers can
/// safely retain the child process and pair one response with one request.
pub(crate) fn run_live_player_command(args: &[String]) -> Result<(), Box<dyn Error>> {
    let seen = PathBuf::from(required_flag(args, "--seen")?);
    let scene: u16 = required_flag(args, "--scene")?.parse()?;
    let gameexe_path = PathBuf::from(required_flag(args, "--gameexe")?);
    let g00_dir = PathBuf::from(required_flag(args, "--g00-dir")?);
    let artifact_root = PathBuf::from(required_flag(args, "--artifact-root")?);
    let run_id = optional_flag(args, "--run-id").unwrap_or("browser-player");
    let public_redact = match optional_flag(args, "--redaction") {
        None | Some("on") => true,
        Some("off") => false,
        Some(value) => {
            return Err(format!("live-player --redaction must be on|off, got {value}").into());
        }
    };
    if !g00_dir.is_dir() {
        return Err(format!(
            "live-player g00 directory is missing: {}",
            g00_dir.display()
        )
        .into());
    }
    let gameexe = Gameexe::parse(&std::fs::read(&gameexe_path)?)?;
    let engine = staged_engine(&seen)?.with_namae_resolver(gameexe.namae_resolver());
    let assets: Arc<dyn AssetPackage> = Arc::new(OnDiskG00Package::new(g00_dir));
    let (mut session, initial) =
        engine.start_live_session_with_assets(scene, Arc::clone(&assets))?;
    let mut renderer = Renderer {
        config: gameexe.message_window(0),
        // The game's OWN choice-list placement. `None` when the title
        // declares no `#SELBTN` block; the message-window box is then the
        // documented fallback, not a synthesized layout.
        select_layout: SelectButtonLayout::from_gameexe(&gameexe, 0),
        screen_size: gameexe.screen_size_px(),
        assets,
        artifact_root: RuntimeArtifactRoot::new(&artifact_root),
        // Keep full-fidelity frames OUTSIDE the managed public root. Putting
        // them under `artifact_root` would make the root non-empty before the
        // managed-store marker is created, and the next real frame would be
        // rejected rather than silently falling back to a stale image.
        private_dir: artifact_root.with_extension("private-live-player"),
        run_id: run_id.to_string(),
        public_redact,
        current_text: None,
    };

    write_response(
        &mut io::stdout(),
        response(&mut session, initial, &mut renderer)?,
    )?;
    for line in io::stdin().lock().lines() {
        let line = line?;
        let input: BrowserInput = serde_json::from_str(&line)?;
        if matches!(input, BrowserInput::Close) {
            write_response(&mut io::stdout(), json!({"closed": true}))?;
            return Ok(());
        }
        let event = match input {
            BrowserInput::Advance => InputEvent::advance(),
            BrowserInput::Choice { index } => InputEvent::choice(index),
            BrowserInput::Close => unreachable!("handled above"),
        };
        let update = session.send(event)?;
        write_response(
            &mut io::stdout(),
            response(&mut session, update, &mut renderer)?,
        )?;
    }
    Ok(())
}

struct Renderer {
    config: utsushi_reallive::MessageWindowConfig,
    select_layout: Option<SelectButtonLayout>,
    screen_size: (u32, u32),
    assets: Arc<dyn AssetPackage>,
    artifact_root: RuntimeArtifactRoot,
    private_dir: PathBuf,
    run_id: String,
    public_redact: bool,
    /// The visible dialogue remains on screen across inputs that change VM
    /// state without emitting a replacement `TextLine` (for example a choice
    /// boundary). Each response is still newly rasterised against the current
    /// graphics stack, so it is never a stale PNG.
    current_text: Option<TextLayer>,
}

fn response(
    session: &mut LiveSession,
    update: LiveSessionUpdate,
    renderer: &mut Renderer,
) -> Result<Value, Box<dyn Error>> {
    let state = update.state;
    // The dialogue layer must hold the last DIALOGUE line. A choice
    // prompt also emits each of its options through the text sink; taking
    // the last emitted line unconditionally puts one option in the
    // message box, indistinguishable from narration, while the other
    // options are never shown at all. Options are rendered by the choice
    // overlay below instead, off the parked longop.
    if let Some(line) = update
        .emitted_lines
        .iter()
        .rev()
        .find(|line| !is_choice_option(line))
    {
        renderer.current_text = Some(TextLayer::message_window_colored(
            &line.text,
            line.speaker.as_deref(),
            line.color
                .map(|[r, g, b]| utsushi_reallive::WipeColour::opaque_rgb(r, g, b)),
            &renderer.config,
            renderer.screen_size,
            renderer.screen_size,
        ));
    }
    let text = renderer.current_text.as_ref().cloned().unwrap_or_else(|| {
        TextLayer::message_window(
            "",
            None,
            &renderer.config,
            renderer.screen_size,
            renderer.screen_size,
        )
    });
    // The selection affordance for the gate the VM is actually parked on.
    // Built from the longop's own options, so the frame shows EVERY option
    // at its own coordinates plus which one is focused.
    let choice = session.pending_choice();
    let text_choice = match &choice {
        // `#SELBTN` placement when the game declares it — option `k` at
        // `BASEPOS + k * REPPOS`. A game with no select block falls back
        // to the message-window box.
        Some(LiveSessionChoice::Text { options }) => Some(match renderer.select_layout {
            Some(layout) => ChoiceWindow::from_select_buttons(
                options,
                0,
                layout,
                &renderer.config,
                renderer.screen_size,
                renderer.screen_size,
            ),
            None => ChoiceWindow::from_config(
                options,
                0,
                &renderer.config,
                renderer.screen_size,
                renderer.screen_size,
            ),
        }),
        _ => None,
    };
    let button_choice = match &choice {
        Some(LiveSessionChoice::ObjectButtons { options }) if !options.is_empty() => {
            Some(ObjectButtonChoiceWindow::from_metadata(options.clone(), 0))
        }
        _ => None,
    };
    let overlay = match (&text_choice, &button_choice) {
        (Some(window), _) => Some(ChoiceOverlay::Text(window)),
        (_, Some(window)) => Some(ChoiceOverlay::ObjectButtons(window)),
        _ => None,
    };

    let mut pass = RenderPass::with_dimensions(renderer.screen_size.0, renderer.screen_size.1)?
        .with_assets(Arc::clone(&renderer.assets));
    let sink = RecordingFrameArtifactSink::new();
    let run_id = format!("{}-{}", renderer.run_id, state.event_index);
    let mut emit = SceneEmit::frame(
        &renderer.artifact_root,
        &run_id,
        &sink,
        &renderer.private_dir,
        renderer.public_redact,
    );
    if let Some(overlay) = overlay {
        emit = emit.with_choice(overlay);
    }
    let screenshots = pass.emit_scene_screenshots(&session.graphics_stack(), &text, emit)?;
    let path = renderer
        .artifact_root
        .artifact_path(&screenshots.public.artifact_ref.uri)?;
    let frame = json!({
        "path": path,
        "artifactId": screenshots.public.artifact_ref.artifact_id,
        "width": screenshots.public.width,
        "height": screenshots.public.height,
    });
    // Options travel with the gate so the browser labels each button with
    // the REAL option text. Without them every button reads "choice N" and
    // a two-option prompt is two indistinguishable controls.
    let options: Vec<String> = match &choice {
        Some(LiveSessionChoice::Text { options }) => options.clone(),
        Some(LiveSessionChoice::ObjectButtons { options }) => options
            .iter()
            .map(|option| option.art.asset_key.clone())
            .collect(),
        None => Vec::new(),
    };
    let wait = match state.waiting_for {
        Some(utsushi_reallive::LiveSessionWait::Advance) => json!({"type": "advance"}),
        Some(utsushi_reallive::LiveSessionWait::Choice { choice_count }) => {
            json!({"type": "choice", "choiceCount": choice_count, "options": options})
        }
        None => Value::Null,
    };
    Ok(json!({
        "scene": state.scene,
        "instructionPointer": state.pc,
        "eventIndex": state.event_index,
        "waitingFor": wait,
        "ended": state.ended,
        "frame": frame,
    }))
}

/// Whether an emitted line is one of a choice prompt's OPTIONS rather
/// than dialogue. The selection runtime tags every option line with a
/// `choice:<index>` text surface; nothing else in the engine uses that
/// prefix, and no engine-specific or title-specific knowledge is applied.
fn is_choice_option(line: &utsushi_core::sink::TextLine) -> bool {
    line.text_surface
        .as_deref()
        .is_some_and(|surface| surface.starts_with(CHOICE_TEXT_SURFACE_PREFIX))
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
