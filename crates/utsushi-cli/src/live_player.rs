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
use utsushi_reallive::{
    Gameexe, LiveSession, LiveSessionUpdate, RecordingFrameArtifactSink, RenderPass, SceneEmit,
    TextLayer,
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
    if let Some(line) = update.emitted_lines.last() {
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
    let mut pass = RenderPass::with_dimensions(renderer.screen_size.0, renderer.screen_size.1)?
        .with_assets(Arc::clone(&renderer.assets));
    let sink = RecordingFrameArtifactSink::new();
    let screenshots = pass.emit_scene_screenshots(
        &session.graphics_stack(),
        &text,
        SceneEmit {
            root: &renderer.artifact_root,
            run_id: &format!("{}-{}", renderer.run_id, state.event_index),
            sink: &sink,
            private_dir: &renderer.private_dir,
            public_redact: renderer.public_redact,
        },
    )?;
    let path = renderer
        .artifact_root
        .artifact_path(&screenshots.public.artifact_ref.uri)?;
    let frame = json!({
        "path": path,
        "artifactId": screenshots.public.artifact_ref.artifact_id,
        "width": screenshots.public.width,
        "height": screenshots.public.height,
    });
    let wait = match state.waiting_for {
        Some(utsushi_reallive::LiveSessionWait::Advance) => json!({"type": "advance"}),
        Some(utsushi_reallive::LiveSessionWait::Choice { choice_count }) => {
            json!({"type": "choice", "choiceCount": choice_count})
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
