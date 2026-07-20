//! `utsushi-cli patch-render --engine reallive` — the composed
//! Kaifuu-patchback + Utsushi render-validate pipeline as ONE repeatable
//! config-parameterized command.
//!
//! Today two steps exist separately:
//!
//!   1. **Kaifuu patchback** — [`kaifuu_reallive::apply_translated_bundle`]
//!      takes a translated v0.2 BridgeBundle (the "translated script") and
//!      the game's pristine `Seen.txt`, and re-emits a patched `Seen.txt`
//!      whose in-scope Textout / Choice bodies carry the translation
//!      byte-correctly (everything out-of-scope byte-identical).
//!   2. **Utsushi render-validate** — [`crate::render_validate`] drives the
//!      REAL RealLive message-window render pipeline over a `Seen.txt` and
//!      emits a redacted localized-scene screenshot (E2 frame artifact) plus
//!      a deterministic JSON evidence report.
//!
//! This command composes them: given a config (project engine + data-root
//! paths + the translated bundle + the scene + the translation scope) it
//! (1) patches the translated script via Kaifuu, writes the patched
//! `Seen.txt` to an operator-chosen path (kept uncommitted under `/scratch`)
//! then (2) drives the SAME Utsushi render-validate pipeline over the patched
//! bytes to render the localized scene, emitting a REDACTED public PNG plus
//! (3) a redaction-clean JSON evidence report (ids + hashes + counts; NO raw
//! translated text, NO absolute filesystem paths).
//!
//! ENGINE-GENERAL / GAME-AGNOSTIC: every game-specific input (data root
//! scene, translated bundle, scope, output paths) is a CONFIG flag — there is
//! no hard-coded game path or scene reference. Validated first on a real
//! RealLive project (Sweetie HD) via config.
//!
//! COPYRIGHT REDACTION (PROJECT LAW): the public PNG is redacted by default
//! (real g00 image rects replaced by a synthetic marker; translated glyphs
//! stay legible). The full-fidelity private PNG is written only to the
//! gitignored private tree. The JSON evidence report carries only ids
//! sha256 hashes / counts, so it is the committable artifact; the frames are
//! not committed.

use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

use kaifuu_reallive::{
    PatchbackOpts, TranslatedBundleV02, TranslationScope, apply_translated_bundle,
};
use serde_json::{Value, json};
use utsushi_reallive::sha256_hex;

use crate::patch_render_args::{
    optional_flag, parse_dimension, parse_message_index, required_flag,
};
use crate::render_validate::{self, Params};

/// Only `reallive` is supported (no silent fallback).
const SUPPORTED_ENGINE: &str = "reallive";

/// Stable diagnostic code printed on the success exit path.
const PATCH_RENDER_OK_CODE: &str = "utsushi.reallive.patch_render_ok";

const HELP: &str = r"utsushi patch-render — composed Kaifuu patchback + Utsushi render-validate

Given a translated v0.2 BridgeBundle (the translated script) and a real
RealLive project (config: engine + data-root paths), patch the script via
Kaifuu, then render the patched localized scene via Utsushi render-validate,
emitting a REDACTED localized-scene PNG + a redaction-clean JSON evidence
report. Config-parameterized: no hard-coded game path or scene.

USAGE:
  utsushi-cli patch-render \
    --engine reallive \
    --seen <PATH> \
    --translated-bundle <PATH> \
    --scene <N> \
    --gameexe <PATH> \
    --game-dir <DIR> \
    --patched-seen-output <PATH> \
    --artifact-root <DIR> \
    [--scope dialogue|dialogue+choices] \
    [--redaction on|off] \
    [--private-artifact-root <DIR>] \
    [--bg-asset <STEM>] \
    [--expect-text-contains <SUBSTR>] [--message-index <N>] \
    [--run-id <ID>] [--width <N>] [--height <N>] \
    [--output <PATH>]

FLAGS:
  --engine reallive             Engine. Only `reallive` is supported.
  --seen <PATH>                 Pristine (pre-patch) source Seen.txt (real bytes).
  --translated-bundle <PATH>    Translated v0.2 BridgeBundle JSON (the translated
                                script) — each unit carries a `target.text`.
  --scene <N>                   Scene id (u16) to patch AND render.
  --gameexe <PATH>              Real Gameexe.ini (message-box geometry / colours).
  --game-dir <DIR>              Game root holding the g00 asset directory.
  --patched-seen-output <PATH>  Where the patched Seen.txt bytes are written. Keep
                                under /scratch (game-derived bytes are uncommitted).
  --artifact-root <DIR>         Managed runtime-artifact root the PUBLIC PNG is under.
  --scope dialogue|dialogue+choices
                                Translation scope (default: dialogue). Drives the
                                byte-fidelity contract: out-of-scope surfaces are
                                carried byte-identical.
  --redaction on|off            PUBLIC-frame redaction toggle (default: on).
  --private-artifact-root <DIR> Directory the PRIVATE full-fidelity PNG is written to.
  --bg-asset <STEM>             Real g00 background stem composited when the observed
                                scene set no graphics of its own.
  --expect-text-contains <S>    Select + assert the rendered message contains <S>
                                (the real translated draft). If multiple messages match,
                                pass --message-index.
  --message-index <N>           Zero-based play-order message index within the scene. Selects
                                that exact message before applying --expect-text-contains.
  --run-id <ID>                 Run id segment for the artifact URI (default: patch-render).
  --width <N> / --height <N>    Framebuffer size override (default: Gameexe screen size).
  --output <PATH>               Write the redaction-clean JSON evidence report to <PATH>.
  -h, --help                    Print this message and exit.
";

/// Execute the `patch-render` subcommand.
pub fn run_patch_render_command(args: &[String]) -> Result<(), Box<dyn Error>> {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        print!("{HELP}");
        return Ok(());
    }

    let engine = required_flag(args, "--engine")?;
    if engine != SUPPORTED_ENGINE {
        return Err(format!(
            "utsushi.cli.patch_render.unsupported_engine: engine={engine}; only \
             {SUPPORTED_ENGINE} is supported",
        )
        .into());
    }

    let seen_path = PathBuf::from(required_flag(args, "--seen")?);
    let translated_bundle_path = PathBuf::from(required_flag(args, "--translated-bundle")?);
    let scene_id: u16 = required_flag(args, "--scene")?.parse().map_err(|err| {
        format!("utsushi.cli.patch_render.scene_parse: --scene must be a u16: {err}")
    })?;
    let gameexe_path = PathBuf::from(required_flag(args, "--gameexe")?);
    let game_dir = PathBuf::from(required_flag(args, "--game-dir")?);
    let patched_seen_output = PathBuf::from(required_flag(args, "--patched-seen-output")?);
    let artifact_root = PathBuf::from(required_flag(args, "--artifact-root")?);
    let scope = parse_scope(optional_flag(args, "--scope"))?;
    let public_redact = parse_redaction(optional_flag(args, "--redaction"))?;
    let private_artifact_root = optional_flag(args, "--private-artifact-root").map(PathBuf::from);
    let bg_asset = optional_flag(args, "--bg-asset").map(str::to_string);
    let expect_text_contains = optional_flag(args, "--expect-text-contains").map(str::to_string);
    let message_index = parse_message_index(args)?;
    let run_id = optional_flag(args, "--run-id").unwrap_or("patch-render");
    let width = parse_dimension(args, "--width")?;
    let height = parse_dimension(args, "--height")?;
    let output = optional_flag(args, "--output").map(PathBuf::from);

    let report = drive(Config {
        seen_path: &seen_path,
        translated_bundle_path: &translated_bundle_path,
        scene_id,
        scope,
        gameexe_path: &gameexe_path,
        game_dir: &game_dir,
        patched_seen_output: &patched_seen_output,
        artifact_root: &artifact_root,
        run_id,
        public_redact,
        private_artifact_root: private_artifact_root.as_deref(),
        bg_asset: bg_asset.as_deref(),
        expect_text_contains: expect_text_contains.as_deref(),
        message_index,
        width,
        height,
    })?;

    if let Some(path) = output.as_deref() {
        let serialized = serde_json::to_string_pretty(&report)
            .map_err(|err| format!("utsushi.cli.patch_render.serialise: {err}"))?;
        fs::write(path, serialized)
            .map_err(|err| format!("utsushi.cli.patch_render.write: {err}"))?;
    }

    Ok(())
}

/// Fully-resolved config for the composed patch→render drive.
pub(crate) struct Config<'a> {
    pub(crate) seen_path: &'a Path,
    pub(crate) translated_bundle_path: &'a Path,
    pub(crate) scene_id: u16,
    pub(crate) scope: TranslationScope,
    pub(crate) gameexe_path: &'a Path,
    pub(crate) game_dir: &'a Path,
    pub(crate) patched_seen_output: &'a Path,
    pub(crate) artifact_root: &'a Path,
    pub(crate) run_id: &'a str,
    pub(crate) public_redact: bool,
    pub(crate) private_artifact_root: Option<&'a Path>,
    pub(crate) bg_asset: Option<&'a str>,
    pub(crate) expect_text_contains: Option<&'a str>,
    pub(crate) message_index: Option<usize>,
    pub(crate) width: Option<u32>,
    pub(crate) height: Option<u32>,
}

/// Run the composed pipeline: Kaifuu patchback → Utsushi render-validate.
///
/// 1. Read the pristine source `Seen.txt` + the translated bundle JSON.
/// 2. Patch the translated script into the archive via
///    [`apply_translated_bundle`] under the configured [`TranslationScope`].
/// 3. Write the patched `Seen.txt` to `patched_seen_output` (uncommitted).
/// 4. Drive the SAME render-validate pipeline over the patched bytes (with
///    the pristine source as the speaker-colour recovery seen).
/// 5. Return a redaction-clean JSON evidence report (ids + sha256 + counts;
///    no raw text, no absolute paths).
pub(crate) fn drive(config: Config<'_>) -> Result<Value, Box<dyn Error>> {
    // 1. Read inputs.
    let seen_bytes = fs::read(config.seen_path).map_err(|err| {
        format!(
            "utsushi.cli.patch_render.seen_read: {}: {err}",
            config.seen_path.display()
        )
    })?;
    let bundle_bytes = fs::read(config.translated_bundle_path).map_err(|err| {
        format!(
            "utsushi.cli.patch_render.bundle_read: {}: {err}",
            config.translated_bundle_path.display()
        )
    })?;
    let bundle_value: Value = serde_json::from_slice(&bundle_bytes).map_err(|err| {
        format!("utsushi.cli.patch_render.bundle_parse: translated bundle is not valid JSON: {err}")
    })?;
    let translated = TranslatedBundleV02::from_json(&bundle_value)
        .map_err(|err| format!("utsushi.cli.patch_render.bundle_schema: {err}"))?;
    let translated_unit_count = translated.targets.len();

    // 2. Kaifuu patchback — translated script → patched Seen.txt bytes.
    let opts = PatchbackOpts::shift_jis(config.scope);
    let patched_bytes = apply_translated_bundle(&seen_bytes, &translated, &opts)
        .map_err(|err| format!("utsushi.cli.patch_render.patchback: {err}"))?;

    // 3. Persist the patched Seen.txt (kept uncommitted under /scratch by the
    //    caller). Create the parent directory so a scratch path just works.
    if let Some(parent) = config.patched_seen_output.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent).map_err(|err| {
            format!(
                "utsushi.cli.patch_render.patched_mkdir: {}: {err}",
                parent.display()
            )
        })?;
    }
    fs::write(config.patched_seen_output, &patched_bytes).map_err(|err| {
        format!(
            "utsushi.cli.patch_render.patched_write: {}: {err}",
            config.patched_seen_output.display()
        )
    })?;

    let source_seen_sha256 = sha256_hex(&seen_bytes);
    let patched_seen_sha256 = sha256_hex(&patched_bytes);

    // 4. Utsushi render-validate over the PATCHED bytes. The pristine source
    //    seen recovers the real per-speaker #NAMAE colour when a
    //    dialogue-only translation rewrote the inline name.
    // The composed patch-render surface renders the patched scene; the
    // returned dispatch-coverage is available but not re-projected here (the
    // standalone `render-validate` command owns the strict coverage gate).
    let (render_report, _coverage) = render_validate::drive(Params {
        seen_path: config.patched_seen_output,
        scene_id: config.scene_id,
        artifact_root: config.artifact_root,
        run_id: config.run_id,
        expect_text_contains: config.expect_text_contains,
        message_index: config.message_index,
        width: config.width,
        height: config.height,
        gameexe_path: config.gameexe_path,
        game_dir: config.game_dir,
        source_seen: Some(config.seen_path),
        bg_asset: config.bg_asset,
        private_artifact_root: config.private_artifact_root,
        public_redact: config.public_redact,
    })
    .map_err(|err| format!("utsushi.cli.patch_render.render: {err}"))?;

    // 5. Compose a redaction-clean evidence report: ids + hashes + counts.
    //    Deliberately re-projects the render report to DROP the absolute
    //    `artifactPath` / `privateArtifactPath` filesystem paths (those live
    //    in the standalone render-validate report only). What remains is
    //    committable: no raw translated text, no operator-private paths.
    let report = json!({
        "schemaVersion": "0.1.0",
        "command": "patch-render",
        "engine": SUPPORTED_ENGINE,
        "sceneId": config.scene_id,
        "scope": scope_str(config.scope),
        "patch": {
            "sourceSeenSha256": source_seen_sha256,
            "patchedSeenSha256": patched_seen_sha256,
            "sourceSeenBytes": seen_bytes.len(),
            "patchedSeenBytes": patched_bytes.len(),
            "translatedUnitCount": translated_unit_count,
        },
        "render": {
            "evidenceTier": render_report.get("evidenceTier").cloned().unwrap_or(Value::Null),
            "artifactKind": render_report.get("artifactKind").cloned().unwrap_or(Value::Null),
            "artifactId": render_report.get("artifactId").cloned().unwrap_or(Value::Null),
            "artifactUri": render_report.get("artifactUri").cloned().unwrap_or(Value::Null),
            "frameIndex": render_report.get("frameIndex").cloned().unwrap_or(Value::Null),
            "width": render_report.get("width").cloned().unwrap_or(Value::Null),
            "height": render_report.get("height").cloned().unwrap_or(Value::Null),
            "textlineCount": render_report.get("textlineCount").cloned().unwrap_or(Value::Null),
            "renderedLineCount": render_report.get("renderedLineCount").cloned().unwrap_or(Value::Null),
            "renderedTextSha256": render_report.get("renderedTextSha256").cloned().unwrap_or(Value::Null),
            "containsExpected": render_report.get("containsExpected").cloned().unwrap_or(Value::Null),
            "framesAnnounced": render_report.get("framesAnnounced").cloned().unwrap_or(Value::Null),
            "hasSpeakerNameBox": render_report.get("hasSpeakerNameBox").cloned().unwrap_or(Value::Null),
            "hasSpeakerColor": render_report.get("hasSpeakerColor").cloned().unwrap_or(Value::Null),
            "graphicsObjectCount": render_report.get("graphicsObjectCount").cloned().unwrap_or(Value::Null),
            "redaction": render_report.get("redaction").cloned().unwrap_or(Value::Null),
            "privateArtifactSha256": render_report.get("privateArtifactSha256").cloned().unwrap_or(Value::Null),
        },
    });

    println!(
        "{PATCH_RENDER_OK_CODE}: scene={} scope={} translated_units={} \
         patched_seen_sha256={} evidence_tier={} redaction={}",
        config.scene_id,
        scope_str(config.scope),
        translated_unit_count,
        patched_seen_sha256,
        render_report
            .get("evidenceTier")
            .and_then(Value::as_str)
            .unwrap_or("?"),
        render_report
            .get("redaction")
            .and_then(Value::as_str)
            .unwrap_or("?"),
    );

    Ok(report)
}

/// Parse the `--scope` flag. Absent → `DialogueOnly` (the conservative
/// default: only dialogue Textout changes). Config-driven, per project law.
fn parse_scope(value: Option<&str>) -> Result<TranslationScope, Box<dyn Error>> {
    match value {
        None | Some("dialogue") => Ok(TranslationScope::DialogueOnly),
        Some("dialogue+choices") => Ok(TranslationScope::DialogueAndChoices),
        Some(other) => Err(format!(
            "utsushi.cli.patch_render.scope_flag: --scope must be `dialogue` or \
             `dialogue+choices`, got {other:?}"
        )
        .into()),
    }
}

fn scope_str(scope: TranslationScope) -> &'static str {
    match scope {
        TranslationScope::DialogueOnly => "dialogue",
        TranslationScope::DialogueAndChoices => "dialogue+choices",
    }
}

/// Parse the `--redaction` toggle. Absent / `on` → redact (default-on per
/// [[feedback_redaction_is_a_toggle]]); `off` → full-fidelity public frame.
fn parse_redaction(value: Option<&str>) -> Result<bool, Box<dyn Error>> {
    match value {
        None | Some("on") => Ok(true),
        Some("off") => Ok(false),
        Some(other) => Err(format!(
            "utsushi.cli.patch_render.redaction_flag: --redaction must be `on` or `off`, \
             got {other:?}"
        )
        .into()),
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
            "--translated-bundle".into(),
            "/tmp/bundle.json".into(),
            "--scene".into(),
            "1".into(),
            "--gameexe".into(),
            "/tmp/Gameexe.ini".into(),
            "--game-dir".into(),
            "/tmp/game".into(),
            "--patched-seen-output".into(),
            "/tmp/patched".into(),
            "--artifact-root".into(),
            "/tmp/art".into(),
        ];
        let err = run_patch_render_command(&args).expect_err("siglus is not supported");
        assert!(err.to_string().contains("unsupported_engine"));
    }

    #[test]
    fn rejects_missing_translated_bundle() {
        let args: Vec<String> = vec![
            "--engine".into(),
            "reallive".into(),
            "--seen".into(),
            "/tmp/nothing".into(),
            "--scene".into(),
            "1".into(),
        ];
        let err = run_patch_render_command(&args).expect_err("missing --translated-bundle");
        assert!(err.to_string().contains("--translated-bundle"));
    }

    #[test]
    fn rejects_unparseable_scene_id() {
        let args: Vec<String> = vec![
            "--engine".into(),
            "reallive".into(),
            "--seen".into(),
            "/tmp/nothing".into(),
            "--translated-bundle".into(),
            "/tmp/bundle.json".into(),
            "--scene".into(),
            "notanint".into(),
            "--gameexe".into(),
            "/tmp/Gameexe.ini".into(),
            "--game-dir".into(),
            "/tmp/game".into(),
            "--patched-seen-output".into(),
            "/tmp/patched".into(),
            "--artifact-root".into(),
            "/tmp/art".into(),
        ];
        let err = run_patch_render_command(&args).expect_err("scene parse must fail");
        assert!(err.to_string().contains("scene_parse"));
    }

    #[test]
    fn parse_scope_maps_config_values() {
        assert_eq!(parse_scope(None).unwrap(), TranslationScope::DialogueOnly);
        assert_eq!(
            parse_scope(Some("dialogue")).unwrap(),
            TranslationScope::DialogueOnly
        );
        assert_eq!(
            parse_scope(Some("dialogue+choices")).unwrap(),
            TranslationScope::DialogueAndChoices
        );
        assert!(parse_scope(Some("everything")).is_err());
    }

    #[test]
    fn parse_redaction_defaults_on() {
        assert!(parse_redaction(None).unwrap());
        assert!(parse_redaction(Some("on")).unwrap());
        assert!(!parse_redaction(Some("off")).unwrap());
        assert!(parse_redaction(Some("maybe")).is_err());
    }

    #[test]
    fn parse_message_index_accepts_zero_based_index() {
        let args: Vec<String> = vec!["--message-index".into(), "1".into()];
        assert_eq!(parse_message_index(&args).unwrap(), Some(1));
    }

    #[test]
    fn parse_message_index_rejects_non_numeric_value() {
        let args: Vec<String> = vec!["--message-index".into(), "one".into()];
        let err = parse_message_index(&args).expect_err("non-numeric index must fail");
        assert!(err.to_string().contains("message_index_parse"));
    }

    #[test]
    fn help_documents_composed_surface() {
        assert!(HELP.contains("utsushi patch-render"));
        assert!(HELP.contains("--translated-bundle"));
        assert!(HELP.contains("--patched-seen-output"));
        assert!(HELP.contains("--scope dialogue|dialogue+choices"));
        assert!(HELP.contains("--message-index <N>"));
        assert!(HELP.contains("--redaction on|off"));
        assert!(HELP.contains("REDACTED"));
    }

    #[test]
    fn help_request_does_not_require_flags() {
        let args: Vec<String> = vec!["--help".into()];
        run_patch_render_command(&args).expect("--help should not require flags");
    }
}
