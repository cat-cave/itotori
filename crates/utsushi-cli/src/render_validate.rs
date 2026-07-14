//! `utsushi-cli render-validate --engine reallive` command.
//!
//! Drives the REAL RealLive message-window render pipeline over a
//! (localized) Seen.txt and emits a deterministic rasterized PNG
//! **screenshot** through the substrate
//! [`utsushi_core::substrate::FrameArtifactSink`] at
//! [`utsushi_core::substrate::EvidenceTier::E2`].
//!
//! The frame is the product surface, not a synthetic-fill placeholder:
//!
//!   * The scene is observed through [`utsushi_reallive::ReplayEngine::observe_for_port`]
//!     — the real branch-following PLAY-ORDER message stream, each message
//!     carrying its `NAME`-register speaker + `#NAMAE`→`#COLOR_TABLE`
//!     colour. ONE message is rendered per frame (never the whole scene
//!     concatenated).
//!   * The real g00 graphics-object stack the drive observed is composited
//!     into the full-fidelity buffer (the real decoded background art).
//!   * The message is laid out inside the game's real `#WINDOW.000`
//!     dialogue box read from `Gameexe.ini` (position / colour / alpha
//!     font-size / insets), word-wrapped at the `MOJI_CNT` boundary, with
//!     a separate `NAME_MOD=1` speaker name box in the speaker's colour.
//!
//! COPYRIGHT REDACTION (PROJECT LAW): the PUBLIC frame is redacted by
//! default — the real g00 image rects are replaced by a synthetic marker
//! so the committed PNG embeds zero source-asset pixels; the translated
//! English message glyphs stay legible. The full-fidelity PRIVATE frame
//! (real g00 art) is written only to the gitignored `.private-render`
//! tree for local visual verification, never committed.

use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::json;
use utsushi_core::RuntimeArtifactRoot;
use utsushi_core::substrate::{
    AssetBytes, AssetId, AssetKind, AssetMetadata, AssetPackage, AssetSize, CaseRule, EvidenceTier,
    PackageDescriptor, PackageKind, PackageSource, TextLine, VfsError, VfsResult,
};
use utsushi_reallive::{
    Gameexe, GraphicsObject, GraphicsObjectStack, GraphicsPlane, GraphicsScale,
    RecordingFrameArtifactSink, RedactionPolicy, RenderPass, ReplayOpts, SceneEmit, TextLayer,
    WipeColour, decode_g00, sha256_hex,
};

use crate::dispatch_gate::{
    DispatchReport, dispatch_report_from_engine, require_semantic_reached_path,
    write_dispatch_report,
};
use crate::staged_replay::staged_engine;

/// Only `reallive` is supported (no silent fallback).
const SUPPORTED_ENGINE: &str = "reallive";

/// Stable diagnostic code printed on the success exit path.
const RENDER_OK_CODE: &str = "utsushi.reallive.render_validate_screenshot_ok";

/// Step budget for the play-order port observation (a bounded headless
/// drive; the same budget the msgwin diagnostic uses).
const OBSERVE_BUDGET: u32 = 50_000;

const HELP: &str = r"utsushi render-validate — real message-window scene screenshot (E2 frame artifact)

USAGE:
  utsushi-cli render-validate \
    --engine reallive \
    --seen <PATH> \
    --scene <N> \
    --gameexe <PATH> \
    --game-dir <DIR> \
    --artifact-root <DIR> \
    [--private-artifact-root <DIR>] [--redaction on|off] \
    [--run-id <ID>] \
    [--expect-text-contains <SUBSTR>] [--message-index <N>] \
    [--width <N>] [--height <N>] \
    [--dispatch-report <PATH>] [--require-semantic-reached-path] \
    [--output <PATH>]

FLAGS:
  --engine reallive             Replay engine. Only `reallive` is supported.
  --seen <PATH>                 Path to a (localized) RealLive Seen.txt envelope.
  --scene <N>                   Scene id (u16) to observe for the play-order message stream.
  --gameexe <PATH>              Real Gameexe.ini. Drives the #WINDOW.000 message box
                                geometry/colour/font + the #NAMAE/#COLOR_TABLE speaker
                                colours. REQUIRED — the box is never hardcoded.
  --game-dir <DIR>              Game root containing the g00 asset directory; the real
                                decoded g00 stack the drive observed is composited.
  --source-seen <PATH>          Pristine (pre-patch) source Seen.txt. Recovers the REAL
                                per-speaker #NAMAE colour when a dialogue-only translation
                                rewrote the inline 【…】 name so it no longer matches the
                                Japanese #NAMAE key on the patched line.
  --bg-asset <STEM>             Real g00 background stem composited when the observed
                                play-order scene set no graphics of its own (a headless
                                dialogue drive inherits its background from a prior scene).
                                The stem's REAL decoded g00 art is cover-scaled in.
  --artifact-root <DIR>         Managed runtime-artifact root the PUBLIC PNG is written under.
  --private-artifact-root <DIR> Directory the PRIVATE full-fidelity PNG is written to.
                                Default: the repo's gitignored /.private-render/ tree. NEVER
                                committed (it carries real decoded g00 art).
  --redaction on|off            PUBLIC-frame redaction toggle (default: on). `on` replaces
                                image rects with a synthetic marker (the translated glyphs
                                stay legible); `off` publishes the full-fidelity buffer
                                (authorized local sharing only).
  --run-id <ID>                 Run id segment for the artifact URI (default: render-validate).
  --expect-text-contains <S>    Select + assert the rendered message contains <S> (the real
                                translated draft). The play-order message carrying it is the
                                one rendered. If multiple messages match, pass --message-index.
  --message-index <N>           Zero-based play-order message index within the scene. Selects
                                that exact message before applying --expect-text-contains.
  --width <N> / --height <N>    Framebuffer size override (default: the Gameexe screen size).
  --dispatch-report <PATH>      Write the machine-readable opcode-coverage report
                                (`missingKeys[]`) for the rendered scene to <PATH>.
  --require-semantic-reached-path
                                Fail non-zero (AFTER writing the frame + reports)
                                unless the rendered scene reached a natural terminus
                                through a fully-semantic branch-following path — no
                                unimplemented opcode, no catalog gap fill, no linear
                                fallback. Without this a scene that skipped a missing
                                opcode could still emit an E2 frame that hides the gap.
  --output <PATH>               Write the deterministic JSON report to <PATH>.
  -h, --help                    Print this message and exit.

ONE real play-order message (observed through the branch-following port
drive) is laid out in the game's real Gameexe message box over the real
decoded g00 stack; the private PNG carries the g00 art verbatim while the
public frame (announced through the substrate FrameArtifactSink at
EvidenceTier::E2 as a `screenshot`) is redacted by default so no
copyrighted art is published — the translated English glyphs stay legible.

The rendered scene's opcode-coverage is ALWAYS folded into the JSON report
(`coverage.missingKeys[]`) so a rendered frame never silently hides an
unimplemented opcode; `--require-semantic-reached-path` turns a coverage gap
into a non-zero exit.
";

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
    let message_index = parse_message_index(args)?;
    let width = parse_dimension_override(args, "--width")?;
    let height = parse_dimension_override(args, "--height")?;
    let output = optional_flag(args, "--output").map(PathBuf::from);
    let dispatch_report_path = optional_flag(args, "--dispatch-report").map(PathBuf::from);
    let require_semantic_path = args
        .iter()
        .any(|arg| arg == "--require-semantic-reached-path");
    let gameexe_path = PathBuf::from(required_flag(args, "--gameexe")?);
    let game_dir = PathBuf::from(required_flag(args, "--game-dir")?);
    let source_seen = optional_flag(args, "--source-seen").map(PathBuf::from);
    let bg_asset = optional_flag(args, "--bg-asset").map(str::to_string);
    let private_artifact_root = optional_flag(args, "--private-artifact-root").map(PathBuf::from);
    let public_redact = match optional_flag(args, "--redaction") {
        None | Some("on") => true,
        Some("off") => false,
        Some(other) => {
            return Err(format!(
                "utsushi.cli.render_validate.redaction_flag: --redaction must be `on` or `off`, \
                 got {other:?}"
            )
            .into());
        }
    };

    let (report, coverage) = drive(Params {
        seen_path: &seen_path,
        scene_id,
        artifact_root: &artifact_root,
        run_id,
        expect_text_contains: expect_text_contains.as_deref(),
        message_index,
        width,
        height,
        gameexe_path: &gameexe_path,
        game_dir: &game_dir,
        source_seen: source_seen.as_deref(),
        bg_asset: bg_asset.as_deref(),
        private_artifact_root: private_artifact_root.as_deref(),
        public_redact,
    })?;

    // Write the machine-readable coverage evidence + the JSON report BEFORE
    // the strict gate can fail, so the `missingKeys[]` gap is always
    // inspectable even on a non-zero exit.
    if let Some(path) = dispatch_report_path.as_deref() {
        write_dispatch_report(path, &coverage)?;
    }
    if let Some(path) = output.as_deref() {
        let serialized = serde_json::to_string_pretty(&report)
            .map_err(|err| format!("utsushi.cli.render_validate.serialise: {err}"))?;
        std::fs::write(path, serialized)
            .map_err(|err| format!("utsushi.cli.render_validate.write: {err}"))?;
    }

    // Strict opcode-coverage gate LAST: a scene that skipped an unimplemented
    // opcode fails loud (non-zero) instead of passing on the emitted E2 frame.
    if require_semantic_path {
        require_semantic_reached_path(&coverage)?;
    }
    Ok(())
}

/// Parameters for the shared RealLive render-validate drive. Exposed to the
/// crate (not just this module) so the composed `patch-render` command can
/// reuse the exact same rasterizing render pipeline on the patched Seen.txt
/// without duplicating the observe/composite/layout/emit logic.
pub(crate) struct Params<'a> {
    pub(crate) seen_path: &'a Path,
    pub(crate) scene_id: u16,
    pub(crate) artifact_root: &'a Path,
    pub(crate) run_id: &'a str,
    pub(crate) expect_text_contains: Option<&'a str>,
    /// Zero-based play-order message index within the scene. When present
    /// selection is positional first; `expect_text_contains` then asserts that
    /// the selected message is the intended patched draft.
    pub(crate) message_index: Option<usize>,
    /// Framebuffer width override; `None` uses the Gameexe screen width.
    pub(crate) width: Option<u32>,
    /// Framebuffer height override; `None` uses the Gameexe screen height.
    pub(crate) height: Option<u32>,
    pub(crate) gameexe_path: &'a Path,
    pub(crate) game_dir: &'a Path,
    /// Pristine (pre-patch) source Seen.txt. Used to recover the REAL
    /// per-speaker #NAMAE colour when a dialogue-only translation rewrote
    /// the inline 【…】 name prefix into the target language (the Japanese
    /// #NAMAE key no longer matches on the patched line). `None` renders
    /// the translated name box without a recovered colour.
    pub(crate) source_seen: Option<&'a Path>,
    /// Real g00 background stem composited when the observed play-order
    /// scene set no graphics of its own (a headless dialogue-scene drive
    /// inherits its background from a prior scene, so its own terminal
    /// stack can be empty). The named stem's REAL decoded g00 art is
    /// cover-scaled into the frame so the composite is always real art.
    pub(crate) bg_asset: Option<&'a str>,
    pub(crate) private_artifact_root: Option<&'a Path>,
    pub(crate) public_redact: bool,
}

/// Drive the real RealLive render-validate pipeline for one scene and
/// return the deterministic JSON evidence report. Emits the redacted
/// public PNG (+ the gitignored private full-fidelity PNG) through the
/// substrate frame sink at E2 as a side effect; the report is redaction
/// aware but carries the artifact filesystem paths for the standalone CLI
/// (the composed `patch-render` command re-projects a path-free subset).
///
/// Returns the JSON evidence report PLUS the rendered scene's
/// [`DispatchReport`] opcode-coverage. The coverage is also folded into the
/// JSON report (`coverage.missingKeys[]`) so a rendered frame never silently
/// hides an unimplemented opcode; the caller applies the strict
/// `--require-semantic-reached-path` gate on the returned coverage.
pub(crate) fn drive(
    params: Params<'_>,
) -> Result<(serde_json::Value, DispatchReport), Box<dyn Error>> {
    // 1. Parse the real Gameexe.ini → the #WINDOW.000 message-box config
    //    the game's declared virtual screen size the config coordinates
    //    live in, and the #NAMAE → #COLOR_TABLE speaker/colour resolver.
    //    Nothing about the box is hardcoded.
    let gameexe_bytes = fs::read(params.gameexe_path).map_err(|err| {
        format!(
            "utsushi.cli.render_validate.gameexe_read: {}: {err}",
            params.gameexe_path.display()
        )
    })?;
    let gameexe = Gameexe::parse(&gameexe_bytes)
        .map_err(|err| format!("utsushi.cli.render_validate.gameexe_parse: {err}"))?;
    let config = gameexe.message_window(0);
    let screen_size = gameexe.screen_size_px();

    // 2. Stage a ReplayEngine (dev-only `use_xor_2` recovery for encrypted
    //    titles; no-op for plaintext), install the #NAMAE resolver, and
    //    observe the REAL branch-following PLAY-ORDER message stream for
    //    the scene — each message carries its NAME-register speaker and
    //    resolved dialogue colour. This is what the message window renders
    //    one-per-frame (NOT the doubled two-pass catalogue).
    let engine = staged_engine(params.seen_path)
        .map_err(|err| format!("utsushi.cli.render_validate.driver: {err}"))?
        .with_namae_resolver(gameexe.namae_resolver());
    let opts = ReplayOpts {
        step_budget: OBSERVE_BUDGET,
        stop_at_first_pause: false,
    };
    let observation = engine.observe_for_port(params.scene_id, &opts);
    let play_order = &observation.play_order_lines;
    let textline_count = play_order.len();
    if play_order.is_empty() {
        return Err(format!(
            "utsushi.cli.render_validate.no_text: scene={} produced no play-order message to \
             render",
            params.scene_id
        )
        .into());
    }

    // 3. Select the ONE message to render. A caller that needs per-unit proof
    //    supplies --message-index so duplicate/prefix-overlapping drafts select
    //    their own play-order line, then --expect-text-contains is asserted
    //    against that exact line. Without an index, substring selection remains
    //    available for one-off callers but rejects ambiguous multi-matches.
    let (chosen_index, chosen) = select_play_order_message(
        play_order,
        params.scene_id,
        params.expect_text_contains,
        params.message_index,
    )?;
    let contains_expected = params
        .expect_text_contains
        .map(|needle| chosen.text.contains(needle));

    // Speaker + colour + rendered body. When the engine already resolved a
    // #NAMAE speaker on the (patched) line, honour it. Otherwise, a
    // dialogue-only translation has rewritten the inline 【…】 name prefix
    // into the target language (e.g. 【菊次朗】→【Kazuto】), which no longer
    // matches the Japanese #NAMAE key — so split the translated inline name
    // into the NAME_MOD name box ourselves, and recover the REAL
    // per-speaker colour from the PRISTINE source Seen (the #NAMAE colour is
    // a property of the character, untouched by dialogue-only patchback).
    // The source play-order aligns 1:1 with the patched one (same scene
    // same structure), so the colour at the same index is this speaker's.
    let (rendered_text, speaker, resolved_color) = if chosen.speaker.is_some() {
        (chosen.text.clone(), chosen.speaker.clone(), chosen.color)
    } else {
        let (inline_name, body) = split_inline_name(&chosen.text);
        let source_color = params
            .source_seen
            .map(|source_seen| {
                source_speaker_color_at(
                    source_seen,
                    params.scene_id,
                    chosen_index,
                    &gameexe.namae_resolver(),
                )
            })
            .transpose()?
            .flatten();
        (body, inline_name, source_color)
    };
    let text_color = resolved_color.map(|[r, g, b]| WipeColour::opaque_rgb(r, g, b));

    // 4. Composite REAL decoded g00 art. Prefer the graphics stack the
    //    drive OBSERVED (the engine's real terminal state). A headless
    //    dialogue-scene drive can inherit its background from a prior scene
    //    and set no graphics of its own, leaving an empty terminal stack;
    //    in that case composite the named --bg-asset stem's REAL decoded
    //    g00 art (cover-scaled) so the frame is never a synthetic fill.
    let g00_dir = find_g00_dir(params.game_dir).ok_or_else(|| {
        format!(
            "utsushi.cli.render_validate.g00_dir_missing: no g00 directory found under {}",
            params.game_dir.display()
        )
    })?;

    // Render at the game's real screen size (so the config-driven box lines
    // up with the g00 art) unless an explicit override is given.
    let frame_width = params.width.unwrap_or(screen_size.0);
    let frame_height = params.height.unwrap_or(screen_size.1);
    let frame_size = (frame_width, frame_height);

    let observed_stack = &observation.scene.graphics_stack;
    let mut fallback_stack = GraphicsObjectStack::new();
    let composited_bg_asset = if observed_stack.is_empty() {
        let bg_stem = params.bg_asset.ok_or_else(|| {
            format!(
                "utsushi.cli.render_validate.no_graphics: scene {} observed no graphics and no \
                 --bg-asset was supplied to composite a real g00 background",
                params.scene_id
            )
        })?;
        // Decode the real g00 up front to size the cover scale (fail typed
        // if the named stem is missing/undecodable — never a fake fill).
        let raw = fs::read(g00_dir.join(format!("{bg_stem}.g00")))
            .map_err(|err| format!("utsushi.cli.render_validate.bg_read: {bg_stem}.g00: {err}"))?;
        let (img, _warns) = decode_g00(&raw).map_err(|err| {
            format!("utsushi.cli.render_validate.bg_decode: {bg_stem}.g00: {err}")
        })?;
        let scale = cover_scale(frame_size, img.width, img.height);
        fallback_stack
            .set(
                GraphicsPlane::Background,
                0,
                GraphicsObject::wipe(WipeColour::opaque_rgb(0x08, 0x08, 0x0c)),
            )
            .map_err(|err| format!("utsushi.cli.render_validate.stack: {err}"))?;
        let mut bg = GraphicsObject::image(bg_stem.to_string());
        bg.scale = GraphicsScale {
            x_thousandths: scale,
            y_thousandths: scale,
        };
        fallback_stack
            .set(GraphicsPlane::Background, 1, bg)
            .map_err(|err| format!("utsushi.cli.render_validate.stack: {err}"))?;
        Some(bg_stem.to_string())
    } else {
        None
    };
    let stack = if composited_bg_asset.is_some() {
        &fallback_stack
    } else {
        observed_stack
    };
    let assets: Arc<dyn AssetPackage> = Arc::new(OnDiskG00Package::new(g00_dir));

    // 5. Lay the ONE message into the real Gameexe message box: word-wrapped
    //    body in the speaker's colour + a NAME_MOD=1 speaker name box.
    let text = TextLayer::message_window_colored(
        &rendered_text,
        speaker.as_deref(),
        text_color,
        &config,
        screen_size,
        frame_size,
    );

    // 6. Emit the private full-fidelity PNG + the public (redacted by
    //    default) screenshot through the substrate frame sink at E2.
    let mut pass = RenderPass::with_dimensions(frame_size.0, frame_size.1)
        .map_err(|err| format!("utsushi.cli.render_validate.render_pass: {err}"))?
        .with_assets(assets);
    let root = RuntimeArtifactRoot::new(params.artifact_root);
    let sink = RecordingFrameArtifactSink::new();
    let private_dir = private_artifact_dir(params.private_artifact_root, params.run_id);
    let shots = pass
        .emit_scene_screenshots(
            stack,
            &text,
            SceneEmit {
                root: &root,
                run_id: params.run_id,
                sink: &sink,
                private_dir: &private_dir,
                public_redact: params.public_redact,
            },
        )
        .map_err(|err| format!("utsushi.cli.render_validate.emit: {err}"))?;
    let artifact = &shots.public;

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

    // Re-run the opcode/dispatch COVERAGE gate over the SAME branch-following
    // pass the play-order observation drove (same engine, same step budget)
    // so a scene that skipped an unimplemented opcode is surfaced rather than
    // hidden behind the emitted E2 frame. Folded into the report below and
    // gated on by the caller's `--require-semantic-reached-path`.
    let coverage = dispatch_report_from_engine(&engine, params.scene_id, &opts);

    // One real play-order message rendered per frame; the speaker + colour
    // presence is recorded (never the raw speaker/text) so the evidence
    // shows the message-window subsystem exercised the NAME box + colour.
    let has_speaker = speaker
        .as_deref()
        .map(str::trim)
        .is_some_and(|s| !s.is_empty());
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
        "renderedLineCount": 1,
        "renderedMessageIndex": chosen_index,
        "renderedTextSha256": sha256_hex(rendered_text.as_bytes()),
        "expectTextContains": params.expect_text_contains,
        "containsExpected": contains_expected,
        "framesAnnounced": sink.len(),
        "hasSpeakerNameBox": has_speaker && config.name_mod == 1,
        "hasSpeakerColor": text_color.is_some(),
        "graphicsObjectCount": stack.len(),
        "compositedBgAsset": composited_bg_asset,
        "bgSource": if composited_bg_asset.is_some() { "bg-asset" } else { "observed-stack" },
        "redaction": if shots.redaction == RedactionPolicy::Redact { "on" } else { "off" },
        "privateArtifactPath": shots.private_png_path.display().to_string(),
        "privateArtifactSha256": shots.private_png_sha256,
        "coverage": coverage.to_json(),
    });

    println!(
        "{RENDER_OK_CODE}: scene={} artifact_id={} uri={} evidence_tier={} \
         play_order_messages={} name_box={} color={} redaction={} private={} \
         coverage_terminus={} missing_opcodes={}",
        params.scene_id,
        artifact.artifact_ref.artifact_id,
        artifact.artifact_ref.uri,
        artifact.evidence_tier.as_str(),
        textline_count,
        has_speaker && config.name_mod == 1,
        text_color.is_some(),
        if shots.redaction == RedactionPolicy::Redact {
            "on"
        } else {
            "off"
        },
        shots.private_png_path.display(),
        coverage.terminus,
        coverage.missing_count,
    );
    Ok((report, coverage))
}

/// Parse an optional `--width` / `--height` dimension override. Absent →
/// `None` (the caller falls back to the Gameexe screen size); present →
/// parsed and rejected if zero.
fn parse_dimension_override(args: &[String], name: &str) -> Result<Option<u32>, Box<dyn Error>> {
    match optional_flag(args, name) {
        None => Ok(None),
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
                    Ok(Some(parsed))
                }
            }),
    }
}

fn parse_message_index(args: &[String]) -> Result<Option<usize>, Box<dyn Error>> {
    optional_flag(args, "--message-index")
        .map(|value| {
            value.parse::<usize>().map_err(|err| {
                format!(
                    "utsushi.cli.render_validate.message_index_parse: --message-index must be a \
                     zero-based usize: {err}"
                )
                .into()
            })
        })
        .transpose()
}

fn select_play_order_message<'a>(
    play_order: &'a [TextLine],
    scene_id: u16,
    expect_text_contains: Option<&str>,
    message_index: Option<usize>,
) -> Result<(usize, &'a TextLine), Box<dyn Error>> {
    if let Some(index) = message_index {
        let chosen = play_order.get(index).ok_or_else(|| {
            format!(
                "utsushi.cli.render_validate.message_index_oob: scene {scene_id} has {} \
                 play-order message(s), cannot select index {index}",
                play_order.len()
            )
        })?;
        if let Some(needle) = expect_text_contains
            && !chosen.text.contains(needle)
        {
            return Err(format!(
                "utsushi.cli.render_validate.expect_text_missing_at_index: play-order message \
                 index {index} in scene {scene_id} does not contain {needle:?}",
            )
            .into());
        }
        return Ok((index, chosen));
    }

    match expect_text_contains {
        Some(needle) => {
            let mut matches = play_order
                .iter()
                .enumerate()
                .filter(|(_, line)| line.text.contains(needle));
            let first = matches.next().ok_or_else(|| {
                format!(
                    "utsushi.cli.render_validate.expect_text_missing: no play-order message in \
                     scene {scene_id} contains {needle:?}",
                )
            })?;
            if let Some((second_index, _)) = matches.next() {
                return Err(format!(
                    "utsushi.cli.render_validate.expect_text_ambiguous: more than one \
                     play-order message in scene {scene_id} contains {needle:?}; first indices \
                     are {} and {second_index}; pass --message-index",
                    first.0
                )
                .into());
            }
            Ok(first)
        }
        None => Ok((0, &play_order[0])),
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

/// Resolve the directory the PRIVATE full-fidelity PNG is written to.
/// When `--private-artifact-root` is not supplied, default to the repo's
/// gitignored `/.private-render/render-validate/<run_id>/` tree (which
/// lives under `/scratch` in the agent worktree) so the real-art frame is
/// never committed.
fn private_artifact_dir(explicit: Option<&Path>, run_id: &str) -> PathBuf {
    if let Some(dir) = explicit {
        dir.to_path_buf()
    } else {
        let workspace_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .map_or_else(|| PathBuf::from("."), Path::to_path_buf);
        workspace_root
            .join(".private-render")
            .join("render-validate")
            .join(run_id)
    }
}

/// Split a leading full-width lenticular `【…】` speaker prefix off a
/// message body. Returns `(Some(inner_name), remaining_body)` when the
/// text opens with `【…】` (the RealLive inline-name convention this game
/// uses); otherwise `(None, text_verbatim)`. Mirrors the engine's own
/// prefix strip — used when a dialogue-only translation rewrote the name
/// so it no longer matches the #NAMAE table and the engine left it inline.
fn split_inline_name(text: &str) -> (Option<String>, String) {
    const OPEN: char = '\u{3010}'; // 【
    const CLOSE: char = '\u{3011}'; // 】
    if let Some(rest) = text.strip_prefix(OPEN)
        && let Some(close_idx) = rest.find(CLOSE)
    {
        let name = rest[..close_idx].trim().to_string();
        let body = rest[close_idx + CLOSE.len_utf8()..].to_string();
        if !name.is_empty() {
            return (Some(name), body);
        }
    }
    (None, text.to_string())
}

/// Observe the PRISTINE source scene and return the engine-resolved
/// per-speaker colour of the play-order message at `index`. The source
/// #NAMAE name is untranslated, so the engine resolves it here; the colour
/// is the character's, unchanged by a dialogue-only patchback, so it is the
/// real colour for the same-index patched (translated) message.
fn source_speaker_color_at(
    source_seen: &Path,
    scene_id: u16,
    index: usize,
    resolver: &utsushi_reallive::NamaeResolver,
) -> Result<Option<[u8; 3]>, Box<dyn Error>> {
    let engine = staged_engine(source_seen)
        .map_err(|err| format!("utsushi.cli.render_validate.source_driver: {err}"))?
        .with_namae_resolver(resolver.clone());
    let opts = ReplayOpts {
        step_budget: OBSERVE_BUDGET,
        stop_at_first_pause: false,
    };
    let observation = engine.observe_for_port(scene_id, &opts);
    Ok(observation
        .play_order_lines
        .get(index)
        .and_then(|line| line.color))
}

/// Scale (thousandths) that makes a `src_w x src_h` source fill the
/// `frame` (cover — no letterbox): the larger of the two axis ratios.
/// Mirrors the `render_diag` example's cover fit.
fn cover_scale(frame: (u32, u32), src_w: u32, src_h: u32) -> i32 {
    let sx = (u64::from(frame.0) * 1000) / u64::from(src_w.max(1));
    let sy = (u64::from(frame.1) * 1000) / u64::from(src_h.max(1));
    i32::try_from(sx.max(sy)).unwrap_or(i32::MAX)
}

/// Breadth-first search from `game_dir` (bounded depth 4) for a
/// directory whose ASCII-case-folded name is `g00` that contains at
/// least one `*.g00` file. Handles both `REALLIVEDATA/g00` (Sweetie HD)
/// and top-level `G00` (Kanon) layouts.
fn find_g00_dir(game_dir: &Path) -> Option<PathBuf> {
    let mut frontier = vec![(game_dir.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = frontier.pop() {
        let is_g00 = dir
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("g00"));
        if is_g00 && dir_has_g00_file(&dir) {
            return Some(dir);
        }
        if depth < 4
            && let Ok(entries) = fs::read_dir(&dir)
        {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    frontier.push((path, depth + 1));
                }
            }
        }
    }
    None
}

fn dir_has_g00_file(dir: &Path) -> bool {
    fs::read_dir(dir).is_ok_and(|entries| {
        entries.flatten().any(|entry| {
            entry
                .path()
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("g00"))
        })
    })
}

/// Minimal [`AssetPackage`] resolving `g00/<STEM>.g00` against a real
/// on-disk g00 directory. Reads via `std::fs`; never indexes the whole
/// game tree (a one-shot CLI render must not walk `koe/` and `wav/`).
#[derive(Debug)]
struct OnDiskG00Package {
    g00_dir: PathBuf,
}

impl OnDiskG00Package {
    fn new(g00_dir: PathBuf) -> Self {
        Self { g00_dir }
    }

    fn host_path(&self, id: &AssetId) -> PathBuf {
        let logical = id.path();
        let stem = logical.strip_prefix("g00/").unwrap_or(logical);
        self.g00_dir.join(stem)
    }
}

impl AssetPackage for OnDiskG00Package {
    fn id(&self) -> &'static str {
        "render-validate-on-disk-g00"
    }

    fn descriptor(&self) -> PackageDescriptor {
        PackageDescriptor {
            id: self.id().to_string(),
            kind: PackageKind::Plaintext,
            case_rule: CaseRule::Sensitive,
            source: PackageSource::PublicName(self.id().to_string()),
            revision: None,
        }
    }

    fn case_rule(&self) -> CaseRule {
        CaseRule::Sensitive
    }

    fn resolve(&self, logical: &str) -> VfsResult<AssetId> {
        AssetId::from_parts(self.id(), logical)
    }

    fn exists(&self, id: &AssetId) -> VfsResult<bool> {
        Ok(self.host_path(id).exists())
    }

    fn stat(&self, id: &AssetId) -> VfsResult<AssetMetadata> {
        let meta = fs::metadata(self.host_path(id))
            .map_err(|_| VfsError::AssetMissing { id: id.clone() })?;
        Ok(AssetMetadata {
            id: id.clone(),
            kind: AssetKind::File,
            size: AssetSize::Bytes(meta.len()),
            revision: None,
        })
    }

    fn open(&self, id: &AssetId) -> VfsResult<AssetBytes> {
        let bytes =
            fs::read(self.host_path(id)).map_err(|_| VfsError::AssetMissing { id: id.clone() })?;
        Ok(AssetBytes::from(bytes))
    }

    fn list(&self, _prefix: &AssetId) -> VfsResult<Vec<AssetId>> {
        Ok(Vec::new())
    }
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
        // The redaction toggle + private/public split is documented.
        assert!(HELP.contains("--redaction on|off"));
        assert!(HELP.contains("--private-artifact-root"));
        assert!(HELP.contains("--message-index"));
        assert!(HELP.contains("redacted by default"));
        // The opcode-coverage gate surface is documented.
        assert!(HELP.contains("--require-semantic-reached-path"));
        assert!(HELP.contains("--dispatch-report"));
        assert!(HELP.contains("missingKeys"));
    }

    #[test]
    fn help_request_does_not_require_flags() {
        let args: Vec<String> = vec!["--help".into()];
        run_render_validate_command(&args).expect("--help should not require flags");
    }

    #[test]
    fn requires_gameexe_flag() {
        let args: Vec<String> = vec![
            "--engine".into(),
            "reallive".into(),
            "--seen".into(),
            "/tmp/nothing".into(),
            "--scene".into(),
            "1".into(),
            "--artifact-root".into(),
            "/tmp/art".into(),
            "--game-dir".into(),
            "/tmp/game".into(),
        ];
        let err = run_render_validate_command(&args).expect_err("--gameexe is required");
        assert!(
            err.to_string().contains("--gameexe"),
            "expected the missing --gameexe flag error, got: {err}"
        );
    }

    #[test]
    fn requires_game_dir_flag() {
        let args: Vec<String> = vec![
            "--engine".into(),
            "reallive".into(),
            "--seen".into(),
            "/tmp/nothing".into(),
            "--scene".into(),
            "1".into(),
            "--artifact-root".into(),
            "/tmp/art".into(),
            "--gameexe".into(),
            "/tmp/Gameexe.ini".into(),
        ];
        let err = run_render_validate_command(&args).expect_err("--game-dir is required");
        assert!(
            err.to_string().contains("--game-dir"),
            "expected the missing --game-dir flag error, got: {err}"
        );
    }

    #[test]
    fn missing_gameexe_file_surfaces_read_error() {
        let missing = std::env::temp_dir().join(format!(
            "utsushi-cli-render-validate-missing-{}",
            std::process::id()
        ));
        let args: Vec<String> = vec![
            "--engine".into(),
            "reallive".into(),
            "--seen".into(),
            missing.join("Seen.txt").display().to_string(),
            "--scene".into(),
            "1".into(),
            "--gameexe".into(),
            missing.join("Gameexe.ini").display().to_string(),
            "--game-dir".into(),
            missing.display().to_string(),
            "--artifact-root".into(),
            missing.join("artifacts").display().to_string(),
        ];
        let err = run_render_validate_command(&args)
            .expect_err("missing Gameexe.ini should fail before the replay driver");
        assert!(
            err.to_string()
                .contains("utsushi.cli.render_validate.gameexe_read"),
            "expected the gameexe read error, got: {err}"
        );
    }

    #[test]
    fn positional_message_index_checks_expected_text_on_that_line() {
        let play_order = vec![
            text_line("line-0", "Same localized line."),
            text_line("line-1", "Broken second line."),
        ];
        let err =
            select_play_order_message(&play_order, 6010, Some("Same localized line."), Some(1))
                .expect_err("index 1 must not be accepted just because index 0 matches");
        assert!(
            err.to_string().contains("expect_text_missing_at_index"),
            "expected indexed missing-text diagnostic, got: {err}"
        );
    }

    #[test]
    fn positional_message_index_selects_duplicate_occurrence() {
        let play_order = vec![
            text_line("line-0", "Same localized line."),
            text_line("line-1", "Same localized line."),
        ];
        let (index, chosen) =
            select_play_order_message(&play_order, 6010, Some("Same localized line."), Some(1))
                .expect("second duplicate occurrence is selected by index");
        assert_eq!(index, 1);
        assert_eq!(chosen.line_id, "line-1");
    }

    #[test]
    fn substring_selection_without_index_rejects_duplicate_matches() {
        let play_order = vec![
            text_line("line-0", "Same localized line."),
            text_line("line-1", "Same localized line."),
        ];
        let err = select_play_order_message(&play_order, 6010, Some("Same localized"), None)
            .expect_err("duplicate substring matches require a message index");
        assert!(
            err.to_string().contains("expect_text_ambiguous"),
            "expected ambiguous substring diagnostic, got: {err}"
        );
    }

    fn text_line(line_id: &str, text: &str) -> TextLine {
        TextLine {
            line_id: line_id.to_string(),
            evidence_tier: EvidenceTier::E1,
            text: text.to_string(),
            speaker: None,
            color: None,
            text_surface: None,
            bridge_ref: None,
            source_asset: None,
            byte_offset_in_scene: None,
            body_shift_jis: None,
        }
    }

    // --- Opcode-coverage gate (the green-against-mock gap closure) ---
    //
    // `render-validate`'s `drive` computes coverage over the SAME
    // branch-following pass through `dispatch_report_from_engine`, and the
    // command applies `require_semantic_reached_path` as its
    // `--require-semantic-reached-path` gate. These tests exercise that exact
    // seam on synthetic in-memory scenes (no on-disk archive / Gameexe / g00
    // needed): a scene referencing an unimplemented opcode still reaches a
    // natural terminus and emits text, but the gate must FAIL loud with the
    // machine-readable `missingKeys[]`; a fully-covered scene must PASS.

    use std::collections::HashSet;
    use utsushi_reallive::{
        BytecodeElement, InMemorySceneStore, MSG_MODULE_ID, MSG_MODULE_TYPE, OPCODE_LINE_BREAK,
        ReplayEngine, ReplayOpts, Scene,
    };

    use crate::dispatch_gate::{dispatch_report_from_engine, require_semantic_reached_path};

    /// A single 8-byte RealLive `Command` element for `(module_type
    /// module_id, opcode)` at `byte_offset`. Mirrors the reallive replay
    /// helper: branch-following dispatches on the decoded header fields.
    fn command_element(
        module_type: u8,
        module_id: u8,
        opcode: u16,
        byte_offset: usize,
    ) -> BytecodeElement {
        let mut raw_bytes = vec![0, module_type, module_id];
        raw_bytes.extend_from_slice(&opcode.to_le_bytes());
        raw_bytes.extend_from_slice(&[0, 0, 0]);
        BytecodeElement::Command {
            module_type,
            module_id,
            opcode,
            arg_count: 0,
            overload: 0,
            goto_targets: Vec::new(),
            goto_case_exprs: Vec::new(),
            raw_bytes,
            byte_offset,
            byte_len: 8,
        }
    }

    fn engine_with_single_command(module_type: u8, module_id: u8, opcode: u16) -> ReplayEngine {
        let scene = Scene::new(1, vec![command_element(module_type, module_id, opcode, 0)])
            .expect("synthetic single-command scene");
        let mut store = InMemorySceneStore::new();
        store.insert(scene);
        ReplayEngine::from_store(store, HashSet::new())
    }

    #[test]
    fn coverage_gate_fails_on_scene_with_missing_opcode() {
        // (2, 250, 9) is not an implemented RealLive opcode — it surfaces as a
        // `MissingRlop` and folds into `unknown_opcode_keys`.
        let engine = engine_with_single_command(2, 250, 9);
        let coverage = dispatch_report_from_engine(&engine, 1, &ReplayOpts::default());

        assert_eq!(
            coverage.missing_keys,
            vec![(2, 250, 9)],
            "the unimplemented opcode must be reported as a missing key",
        );
        // The rendered frame would still emit (natural terminus), so a naive
        // check would pass — the gate must catch the gap.
        let error = require_semantic_reached_path(&coverage)
            .expect_err("a scene with a missing opcode must fail the coverage gate");
        let message = error.to_string();
        assert!(
            message.contains("missing_keys=[(2, 250, 9)]"),
            "the gate failure must carry the machine-readable missing key: {message}",
        );
        assert!(
            message.contains("missing_count=1"),
            "the gate failure must report the missing-opcode count: {message}",
        );
    }

    #[test]
    fn coverage_gate_passes_on_fully_covered_scene() {
        // A single recognised message line-break: dispatches semantically, no
        // missing opcode, no catalog gap fill, natural terminus.
        let engine = engine_with_single_command(MSG_MODULE_TYPE, MSG_MODULE_ID, OPCODE_LINE_BREAK);
        let coverage = dispatch_report_from_engine(&engine, 1, &ReplayOpts::default());

        assert!(
            coverage.missing_keys.is_empty(),
            "a fully-covered scene has no missing opcodes: {:?}",
            coverage.missing_keys,
        );
        assert!(
            coverage.catalog_fallback_keys.is_empty(),
            "a fully-covered scene has no catalog gap fills: {:?}",
            coverage.catalog_fallback_keys,
        );
        require_semantic_reached_path(&coverage)
            .expect("a fully-covered scene must pass the coverage gate cleanly");

        // Coverage is folded into the JSON evidence report (honest by default).
        let json = coverage.to_json();
        assert_eq!(json["missingCount"], 0);
        assert_eq!(json["missingKeys"].as_array().unwrap().len(), 0);
    }
}
