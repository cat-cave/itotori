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
    GraphicsObject, GraphicsObjectStack, GraphicsPlane, RecordingFrameArtifactSink,
    RedactionPolicy, RenderPass, ReplayEvent, ReplayOpts, SceneEmit, TextLayer, WipeColour,
    sha256_hex,
};

use crate::staged_replay::replay_scene_staged;

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

const HELP: &str = r"utsushi render-validate — rasterized localized scene screenshot (E2 frame artifact)

USAGE:
  utsushi-cli render-validate \
    --engine reallive \
    --seen <PATH> \
    --scene <N> \
    --artifact-root <DIR> \
    [--game-dir <DIR>] [--bg-asset <STEM>] \
    [--private-artifact-root <DIR>] [--redaction on|off] \
    [--run-id <ID>] \
    [--expect-text-contains <SUBSTR>] \
    [--width <N>] [--height <N>] \
    [--output <PATH>]

FLAGS:
  --engine reallive             Replay engine. Only `reallive` is supported.
  --seen <PATH>                 Path to a (localized) RealLive Seen.txt envelope.
  --scene <N>                   Scene id (u16) to drive through the VM.
  --artifact-root <DIR>         Managed runtime-artifact root the PUBLIC PNG is written under.
  --game-dir <DIR>              Game root containing the g00 asset directory. When given
                                with --bg-asset, the real g00 background is composited.
  --bg-asset <STEM>             g00 asset stem (e.g. BACK) composited as the scene background.
  --private-artifact-root <DIR> Directory the PRIVATE full-fidelity PNG is written to.
                                Default: the repo's gitignored /.private-render/ tree. NEVER
                                committed (it carries real decoded g00 art).
  --redaction on|off            PUBLIC-frame redaction toggle (default: on). `on` replaces
                                image rects with a synthetic marker; `off` publishes the
                                full-fidelity buffer (authorized local sharing only).
  --run-id <ID>                 Run id segment for the artifact URI (default: render-validate).
  --expect-text-contains <S>    Assert the rendered (localized) text layer contains <S>.
  --width <N> / --height <N>    Framebuffer size (default 1280x720).
  --output <PATH>               Write the deterministic JSON report to <PATH>.
  -h, --help                    Print this message and exit.

The render pass composites the REAL decoded g00 background into the
full-fidelity buffer; the private PNG carries it verbatim while the public
frame (announced through the substrate FrameArtifactSink at EvidenceTier::E2
as a `screenshot`) is redacted by default so no copyrighted art is published.
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
    let width = parse_dimension(args, "--width", DEFAULT_WIDTH)?;
    let height = parse_dimension(args, "--height", DEFAULT_HEIGHT)?;
    let output = optional_flag(args, "--output").map(PathBuf::from);
    let game_dir = optional_flag(args, "--game-dir").map(PathBuf::from);
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
        game_dir: game_dir.as_deref(),
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
    width: u32,
    height: u32,
    output: Option<&'a Path>,
    game_dir: Option<&'a Path>,
    bg_asset: Option<&'a str>,
    private_artifact_root: Option<&'a Path>,
    public_redact: bool,
}

fn drive(params: Params<'_>) -> Result<(), Box<dyn Error>> {
    // 1. Replay the (localized) scene and collect the localized text.
    //    Stage the dev-only `use_xor_2` recovery for xor2 titles so the
    //    rendered text layer is built from REAL decoded text (not the
    //    still-ciphered segment's mojibake).
    let opts = ReplayOpts::default();
    let log = replay_scene_staged(params.seen_path, params.scene_id, &opts)
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

    // 2. Build the render stack: a synthetic background fill, the REAL
    //    g00 scene background (when a game dir + bg asset are supplied),
    //    and the localized text layer painted on top.
    let mut stack = GraphicsObjectStack::new();
    stack
        .set(
            GraphicsPlane::Background,
            0,
            GraphicsObject::wipe(WipeColour::opaque_rgb(0x10, 0x14, 0x1c)),
        )
        .map_err(|err| format!("utsushi.cli.render_validate.stack: {err}"))?;

    // Bind a real g00 asset package + composite the named scene
    // background when both --game-dir and --bg-asset are supplied.
    let mut assets: Option<Arc<dyn AssetPackage>> = None;
    let mut composited_bg_asset: Option<String> = None;
    if let (Some(game_dir), Some(bg_asset)) = (params.game_dir, params.bg_asset) {
        let g00_dir = find_g00_dir(game_dir).ok_or_else(|| {
            format!(
                "utsushi.cli.render_validate.g00_dir_missing: no g00 directory found under {}",
                game_dir.display()
            )
        })?;
        assets = Some(Arc::new(OnDiskG00Package::new(g00_dir)));
        stack
            .set(
                GraphicsPlane::Background,
                1,
                GraphicsObject::image(bg_asset.to_string()),
            )
            .map_err(|err| format!("utsushi.cli.render_validate.stack: {err}"))?;
        composited_bg_asset = Some(bg_asset.to_string());
    }
    let text = TextLayer::localized(rendered_lines.clone());

    // 3. Emit the private full-fidelity PNG + the public (redacted by
    //    default) screenshot through the substrate frame sink at E2.
    let mut pass = RenderPass::with_dimensions(params.width, params.height)
        .map_err(|err| format!("utsushi.cli.render_validate.render_pass: {err}"))?;
    if let Some(assets) = assets {
        pass = pass.with_assets(assets);
    }
    let root = RuntimeArtifactRoot::new(params.artifact_root);
    let sink = RecordingFrameArtifactSink::new();
    let private_dir = private_artifact_dir(params.private_artifact_root, params.run_id);
    let shots = pass
        .emit_scene_screenshots(
            &stack,
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
        "compositedBgAsset": composited_bg_asset,
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
         rendered_lines={} textline_count={} redaction={} private={}",
        params.scene_id,
        artifact.artifact_ref.artifact_id,
        artifact.artifact_ref.uri,
        artifact.evidence_tier.as_str(),
        rendered_lines.len(),
        textline_count,
        if shots.redaction == RedactionPolicy::Redact {
            "on"
        } else {
            "off"
        },
        shots.private_png_path.display(),
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
