//! ALPHA-006b — `utsushi-cli render-validate --engine reallive` command.
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
//!     dialogue box read from `Gameexe.ini` (position / colour / alpha /
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
    PackageDescriptor, PackageKind, PackageSource, VfsError, VfsResult,
};
use utsushi_reallive::{
    Gameexe, GraphicsObject, GraphicsObjectStack, GraphicsPlane, GraphicsScale,
    RecordingFrameArtifactSink, RedactionPolicy, RenderPass, ReplayOpts, SceneEmit, TextLayer,
    WipeColour, decode_g00, sha256_hex,
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
    [--expect-text-contains <SUBSTR>] \
    [--width <N>] [--height <N>] \
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
                                one rendered.
  --width <N> / --height <N>    Framebuffer size override (default: the Gameexe screen size).
  --output <PATH>               Write the deterministic JSON report to <PATH>.
  -h, --help                    Print this message and exit.

ONE real play-order message (observed through the branch-following port
drive) is laid out in the game's real Gameexe message box over the real
decoded g00 stack; the private PNG carries the g00 art verbatim while the
public frame (announced through the substrate FrameArtifactSink at
EvidenceTier::E2 as a `screenshot`) is redacted by default so no
copyrighted art is published — the translated English glyphs stay legible.
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
    let width = parse_dimension_override(args, "--width")?;
    let height = parse_dimension_override(args, "--height")?;
    let output = optional_flag(args, "--output").map(PathBuf::from);
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

    drive(Params {
        seen_path: &seen_path,
        scene_id,
        artifact_root: &artifact_root,
        run_id,
        expect_text_contains: expect_text_contains.as_deref(),
        width,
        height,
        output: output.as_deref(),
        gameexe_path: &gameexe_path,
        game_dir: &game_dir,
        source_seen: source_seen.as_deref(),
        bg_asset: bg_asset.as_deref(),
        private_artifact_root: private_artifact_root.as_deref(),
        public_redact,
    })
}

struct Params<'a> {
    seen_path: &'a Path,
    scene_id: u16,
    artifact_root: &'a Path,
    run_id: &'a str,
    expect_text_contains: Option<&'a str>,
    /// Framebuffer width override; `None` uses the Gameexe screen width.
    width: Option<u32>,
    /// Framebuffer height override; `None` uses the Gameexe screen height.
    height: Option<u32>,
    output: Option<&'a Path>,
    gameexe_path: &'a Path,
    game_dir: &'a Path,
    /// Pristine (pre-patch) source Seen.txt. Used to recover the REAL
    /// per-speaker #NAMAE colour when a dialogue-only translation rewrote
    /// the inline 【…】 name prefix into the target language (the Japanese
    /// #NAMAE key no longer matches on the patched line). `None` renders
    /// the translated name box without a recovered colour.
    source_seen: Option<&'a Path>,
    /// Real g00 background stem composited when the observed play-order
    /// scene set no graphics of its own (a headless dialogue-scene drive
    /// inherits its background from a prior scene, so its own terminal
    /// stack can be empty). The named stem's REAL decoded g00 art is
    /// cover-scaled into the frame so the composite is always real art.
    bg_asset: Option<&'a str>,
    private_artifact_root: Option<&'a Path>,
    public_redact: bool,
}

fn drive(params: Params<'_>) -> Result<(), Box<dyn Error>> {
    // 1. Parse the real Gameexe.ini → the #WINDOW.000 message-box config,
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

    // 3. Select the ONE message to render. When --expect-text-contains is
    //    given (the real translated draft), render the play-order message
    //    that carries it — the honest proof that the localized English is
    //    what the box shows. Fail typed when no message carries it (a real
    //    round-trip mismatch, not a silently substituted frame). Otherwise
    //    render the first play-order message.
    let (chosen_index, chosen) = match params.expect_text_contains {
        Some(needle) => play_order
            .iter()
            .enumerate()
            .find(|(_, line)| line.text.contains(needle))
            .ok_or_else(|| {
                format!(
                    "utsushi.cli.render_validate.expect_text_missing: no play-order message in \
                     scene {} contains {needle:?}",
                    params.scene_id
                )
            })?,
        None => (0, &play_order[0]),
    };
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
    // The source play-order aligns 1:1 with the patched one (same scene,
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
    });

    if let Some(path) = params.output {
        let serialized = serde_json::to_string_pretty(&report)
            .map_err(|err| format!("utsushi.cli.render_validate.serialise: {err}"))?;
        std::fs::write(path, serialized)
            .map_err(|err| format!("utsushi.cli.render_validate.write: {err}"))?;
    }

    println!(
        "{RENDER_OK_CODE}: scene={} artifact_id={} uri={} evidence_tier={} \
         play_order_messages={} name_box={} color={} redaction={} private={}",
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
    );
    Ok(())
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
        assert!(HELP.contains("redacted by default"));
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
}
