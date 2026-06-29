//! ALPHA-006b — `utsushi-cli render-validate --engine reallive` command.
//!
//! Drives [`utsushi_reallive::replay_scene`] against a (localized)
//! Seen.txt, collects the localized [`ReplayEvent::TextLine`] bodies,
//! paints them as a [`TextLayer`] over a synthetic-fill graphics stack,
//! and emits a deterministic rasterized PNG **screenshot** through the
//! substrate [`utsushi_core::substrate::FrameArtifactSink`] at
//! [`utsushi_core::substrate::EvidenceTier::E2`].
//!
//! COPYRIGHT REDACTION (PROJECT LAW): the rasterizer never dereferences
//! a copyrighted g00 bitmap. Only our own synthetic `Wipe` fills and the
//! localized (translated) text layer are painted; the emitted PNG
//! embeds zero source-asset pixels. This command is the rasterized
//! successor to the text-only `replay-validate` capture surface.

use std::error::Error;
use std::path::{Path, PathBuf};

use serde_json::json;
use utsushi_core::RuntimeArtifactRoot;
use utsushi_core::substrate::EvidenceTier;
use utsushi_reallive::{
    GraphicsObject, GraphicsObjectStack, GraphicsPlane, RecordingFrameArtifactSink, RenderPass,
    ReplayEvent, ReplayOpts, TextLayer, WipeColour, replay_scene, sha256_hex,
};

/// Only `reallive` is supported (no silent fallback).
const SUPPORTED_ENGINE: &str = "reallive";

/// Stable diagnostic code printed on the success exit path.
const RENDER_OK_CODE: &str = "utsushi.reallive.render_validate_screenshot_ok";

/// Default Sweetie HD framebuffer (`SCREENSIZE_MOD=999,1280,720`).
const DEFAULT_WIDTH: u32 = 1280;
const DEFAULT_HEIGHT: u32 = 720;

/// Bounds on the painted text layer so a pathological scene cannot
/// produce an unbounded frame. Lines beyond the cap are dropped; the
/// render is a validation artifact, not a faithful typeset page.
const MAX_RENDERED_LINES: usize = 24;
const MAX_RENDERED_LINE_CHARS: usize = 64;

const HELP: &str = r#"utsushi render-validate — rasterized localized scene screenshot (E2 frame artifact)

USAGE:
  utsushi-cli render-validate \
    --engine reallive \
    --seen <PATH> \
    --scene <N> \
    --artifact-root <DIR> \
    [--run-id <ID>] \
    [--expect-text-contains <SUBSTR>] \
    [--width <N>] [--height <N>] \
    [--output <PATH>]

FLAGS:
  --engine reallive             Replay engine. Only `reallive` is supported.
  --seen <PATH>                 Path to a (localized) RealLive Seen.txt envelope.
  --scene <N>                   Scene id (u16) to drive through the VM.
  --artifact-root <DIR>         Managed runtime-artifact root the PNG is written under.
  --run-id <ID>                 Run id segment for the artifact URI (default: render-validate).
  --expect-text-contains <S>    Assert the rendered (localized) text layer contains <S>.
  --width <N> / --height <N>    Framebuffer size (default 1280x720).
  --output <PATH>               Write the deterministic JSON report to <PATH>.
  -h, --help                    Print this message and exit.

The emitted artifact is announced through the substrate FrameArtifactSink
at EvidenceTier::E2 as a `screenshot`. The rasterizer NEVER dereferences a
copyrighted g00 bitmap; only synthetic fills and the localized text layer
are painted.
"#;

/// Execute the `render-validate` subcommand.
pub fn run_render_validate_command(args: &[String]) -> Result<(), Box<dyn Error>> {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        print!("{HELP}");
        return Ok(());
    }
    let engine = required_flag(args, "--engine")?;
    if engine != SUPPORTED_ENGINE {
        return Err(format!(
            "utsushi.cli.render_validate.unsupported_engine: engine={engine}; only \
             {SUPPORTED_ENGINE} is supported",
        )
        .into());
    }
    let seen_path = PathBuf::from(required_flag(args, "--seen")?);
    let scene_id: u16 = required_flag(args, "--scene")?.parse().map_err(|err| {
        format!("utsushi.cli.render_validate.scene_parse: --scene must be a u16: {err}")
    })?;
    let artifact_root = PathBuf::from(required_flag(args, "--artifact-root")?);
    let run_id = optional_flag(args, "--run-id").unwrap_or("render-validate");
    let expect_text_contains = optional_flag(args, "--expect-text-contains").map(str::to_string);
    let width = parse_dimension(args, "--width", DEFAULT_WIDTH)?;
    let height = parse_dimension(args, "--height", DEFAULT_HEIGHT)?;
    let output = optional_flag(args, "--output").map(PathBuf::from);

    drive(Params {
        seen_path: &seen_path,
        scene_id,
        artifact_root: &artifact_root,
        run_id,
        expect_text_contains: expect_text_contains.as_deref(),
        width,
        height,
        output: output.as_deref(),
    })
}

struct Params<'a> {
    seen_path: &'a Path,
    scene_id: u16,
    artifact_root: &'a Path,
    run_id: &'a str,
    expect_text_contains: Option<&'a str>,
    width: u32,
    height: u32,
    output: Option<&'a Path>,
}

fn drive(params: Params<'_>) -> Result<(), Box<dyn Error>> {
    // 1. Replay the (localized) scene and collect the localized text.
    let opts = ReplayOpts::default();
    let log = replay_scene(params.seen_path, params.scene_id, &opts)
        .map_err(|err| format!("utsushi.cli.render_validate.driver: {err}"))?;

    let mut rendered_lines: Vec<String> = Vec::new();
    let mut textline_count: usize = 0;
    for event in &log.events {
        if let ReplayEvent::TextLine { body_utf8, .. } = event {
            textline_count += 1;
            let trimmed = body_utf8.trim();
            if trimmed.is_empty() || rendered_lines.len() >= MAX_RENDERED_LINES {
                continue;
            }
            rendered_lines.push(truncate_chars(trimmed, MAX_RENDERED_LINE_CHARS));
        }
    }
    if rendered_lines.is_empty() {
        return Err(format!(
            "utsushi.cli.render_validate.no_text: scene={} produced no non-empty TextLine bodies \
             to render",
            params.scene_id
        )
        .into());
    }

    // The localized text the screenshot will carry (joined for hashing
    // and substring checks; never written verbatim to the report so no
    // raw source bytes can leak into an artifact).
    let rendered_text = rendered_lines.join("\n");
    let contains_expected = params
        .expect_text_contains
        .map(|needle| rendered_text.contains(needle));
    if let (Some(needle), Some(false)) = (params.expect_text_contains, contains_expected) {
        return Err(format!(
            "utsushi.cli.render_validate.expect_text_missing: rendered localized text layer does \
             not contain {needle:?}"
        )
        .into());
    }

    // 2. Build the render stack: a synthetic background fill + an Image
    //    object that is recorded but NEVER dereferenced (redaction), and
    //    the localized text layer painted on top.
    let mut stack = GraphicsObjectStack::new();
    stack
        .set(
            GraphicsPlane::Background,
            0,
            GraphicsObject::wipe(WipeColour::opaque_rgb(0x10, 0x14, 0x1c)),
        )
        .map_err(|err| format!("utsushi.cli.render_validate.stack: {err}"))?;
    // Structural redaction marker: a (would-be) scene background image.
    // The render pass keeps this a no-op; no g00 bytes are read.
    stack
        .set(
            GraphicsPlane::Background,
            1,
            GraphicsObject::image("SCENE_BG"),
        )
        .map_err(|err| format!("utsushi.cli.render_validate.stack: {err}"))?;
    let text = TextLayer::localized(rendered_lines.clone());

    // 3. Emit the deterministic screenshot through the substrate frame
    //    sink at E2.
    let mut pass = RenderPass::with_dimensions(params.width, params.height)
        .map_err(|err| format!("utsushi.cli.render_validate.render_pass: {err}"))?;
    let root = RuntimeArtifactRoot::new(params.artifact_root);
    let sink = RecordingFrameArtifactSink::new();
    let artifact = pass
        .emit_localized_screenshot(&stack, &text, &root, params.run_id, &sink)
        .map_err(|err| format!("utsushi.cli.render_validate.emit: {err}"))?;

    if artifact.evidence_tier < EvidenceTier::E2 {
        return Err(format!(
            "utsushi.cli.render_validate.evidence_floor: emitted below E2 ({:?})",
            artifact.evidence_tier
        )
        .into());
    }
    let artifact_path = root
        .artifact_path(&artifact.artifact_ref.uri)
        .map_err(|err| format!("utsushi.cli.render_validate.artifact_path: {err}"))?;

    let report = json!({
        "schemaVersion": "0.1.0",
        "engine": SUPPORTED_ENGINE,
        "sceneId": params.scene_id,
        "evidenceTier": artifact.evidence_tier.as_str(),
        "artifactKind": artifact.artifact_ref.artifact_kind,
        "artifactId": artifact.artifact_ref.artifact_id,
        "artifactUri": artifact.artifact_ref.uri,
        "artifactPath": artifact_path.display().to_string(),
        "frameIndex": artifact.frame_index,
        "width": artifact.width,
        "height": artifact.height,
        "textlineCount": textline_count,
        "renderedLineCount": rendered_lines.len(),
        "renderedTextSha256": sha256_hex(rendered_text.as_bytes()),
        "expectTextContains": params.expect_text_contains,
        "containsExpected": contains_expected,
        "framesAnnounced": sink.len(),
    });

    if let Some(path) = params.output {
        let serialized = serde_json::to_string_pretty(&report)
            .map_err(|err| format!("utsushi.cli.render_validate.serialise: {err}"))?;
        std::fs::write(path, serialized)
            .map_err(|err| format!("utsushi.cli.render_validate.write: {err}"))?;
    }

    println!(
        "{RENDER_OK_CODE}: scene={} artifact_id={} uri={} evidence_tier={} \
         rendered_lines={} textline_count={}",
        params.scene_id,
        artifact.artifact_ref.artifact_id,
        artifact.artifact_ref.uri,
        artifact.evidence_tier.as_str(),
        rendered_lines.len(),
        textline_count,
    );
    Ok(())
}

fn truncate_chars(input: &str, max_chars: usize) -> String {
    input.chars().take(max_chars).collect()
}

fn parse_dimension(args: &[String], name: &str, default: u32) -> Result<u32, Box<dyn Error>> {
    match optional_flag(args, name) {
        None => Ok(default),
        Some(value) => value
            .parse::<u32>()
            .map_err(|err| {
                format!("utsushi.cli.render_validate.dimension_parse: {name} must be a u32: {err}")
                    .into()
            })
            .and_then(|parsed| {
                if parsed == 0 {
                    Err(
                        format!("utsushi.cli.render_validate.dimension_zero: {name} must be > 0")
                            .into(),
                    )
                } else {
                    Ok(parsed)
                }
            }),
    }
}

fn required_flag<'a>(args: &'a [String], name: &str) -> Result<&'a str, Box<dyn Error>> {
    optional_flag(args, name)
        .ok_or_else(|| format!("utsushi.cli.render_validate.missing_flag: {name}").into())
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
    fn rejects_unsupported_engine() {
        let args: Vec<String> = vec![
            "--engine".into(),
            "siglus".into(),
            "--seen".into(),
            "/tmp/nothing".into(),
            "--scene".into(),
            "1".into(),
            "--artifact-root".into(),
            "/tmp/art".into(),
        ];
        let err = run_render_validate_command(&args).expect_err("siglus is not supported");
        assert!(err.to_string().contains("unsupported_engine"));
    }

    #[test]
    fn rejects_missing_artifact_root() {
        let args: Vec<String> = vec![
            "--engine".into(),
            "reallive".into(),
            "--seen".into(),
            "/tmp/nothing".into(),
            "--scene".into(),
            "1".into(),
        ];
        let err = run_render_validate_command(&args).expect_err("missing --artifact-root");
        assert!(err.to_string().contains("--artifact-root"));
    }

    #[test]
    fn rejects_unparseable_scene_id() {
        let args: Vec<String> = vec![
            "--engine".into(),
            "reallive".into(),
            "--seen".into(),
            "/tmp/nothing".into(),
            "--scene".into(),
            "notanint".into(),
            "--artifact-root".into(),
            "/tmp/art".into(),
        ];
        let err = run_render_validate_command(&args).expect_err("scene parse must fail");
        assert!(err.to_string().contains("scene_parse"));
    }

    #[test]
    fn rejects_zero_dimension() {
        let args: Vec<String> = vec![
            "--engine".into(),
            "reallive".into(),
            "--seen".into(),
            "/tmp/nothing".into(),
            "--scene".into(),
            "1".into(),
            "--artifact-root".into(),
            "/tmp/art".into(),
            "--width".into(),
            "0".into(),
        ];
        let err = run_render_validate_command(&args).expect_err("zero width rejected");
        assert!(err.to_string().contains("dimension_zero"));
    }

    #[test]
    fn help_documents_render_validate_surface() {
        assert!(HELP.contains("utsushi-cli render-validate"));
        assert!(HELP.contains("--engine reallive"));
        assert!(HELP.contains("EvidenceTier::E2"));
        assert!(HELP.contains("NEVER dereferences"));
    }

    #[test]
    fn help_request_does_not_require_flags() {
        let args: Vec<String> = vec!["--help".into()];
        run_render_validate_command(&args).expect("--help should not require flags");
    }

    #[test]
    fn missing_seen_reaches_replay_driver() {
        let missing = std::env::temp_dir().join(format!(
            "utsushi-cli-render-validate-missing-{}",
            std::process::id()
        ));
        let args: Vec<String> = vec![
            "--engine".into(),
            "reallive".into(),
            "--seen".into(),
            missing.display().to_string(),
            "--scene".into(),
            "1".into(),
            "--artifact-root".into(),
            missing.join("artifacts").display().to_string(),
        ];
        let err =
            run_render_validate_command(&args).expect_err("missing Seen.txt should fail in driver");
        assert!(
            err.to_string()
                .contains("utsushi.cli.render_validate.driver"),
            "expected the replay driver error, got: {err}"
        );
    }
}
