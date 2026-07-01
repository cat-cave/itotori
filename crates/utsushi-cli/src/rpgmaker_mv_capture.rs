//! RPG Maker MV/MZ runtime-evidence capture command for the
//! vertical-slice loop (`utsushi rpgmaker-mv-capture`).
//!
//! Drives [`UtsushiRpgmakerMvPort`] (E1 text-per-tick, trace-only) through
//! the `utsushi-core` [`Runner`] against a (patched/delta-applied)
//! extracted RPG Maker MV/MZ game directory, writes the text-trace capture
//! artifact under a managed [`RuntimeArtifactRoot`], and — when
//! `--expect-textline-contains <SUBSTR>` is supplied — asserts that
//! substring lands in at least one emitted `TextLine` body. This mirrors
//! the RealLive `replay-validate` contract for the MV/MZ engine family so
//! the localize-project driver can close the loop with runtime evidence.
//!
//! The emitted summary carries counts + the capture-artifact pointer and
//! the caller-provided ASCII sentinel only — never verbatim game text.

use std::error::Error;
use std::path::PathBuf;

use serde_json::json;
use utsushi_core::port::runner::Runner;
use utsushi_core::substrate::PortRequest;
use utsushi_core::{RuntimeArtifactRoot, RuntimeOperation, write_json};
use utsushi_rpgmaker_mv::UtsushiRpgmakerMvPort;

/// Stable diagnostic codes mirroring the RealLive replay-validate surface.
const MATCH_OK_CODE: &str = "utsushi.rpgmaker_mv.replay_text_match_ok";
const MATCH_FAILED_CODE: &str = "utsushi.rpgmaker_mv.replay_text_match_failed";

const HELP: &str = r"utsushi rpgmaker-mv-capture — RPG Maker MV/MZ text-trace runtime evidence

Usage:
  utsushi rpgmaker-mv-capture \
    --game-dir <DIR> \
    --artifact-root <DIR> \
    --output <PATH> \
    [--run-id <ID>] \
    [--expect-textline-contains <SUBSTR>]

  --game-dir <DIR>                    Extracted MV (`www/data/`) or MZ (`data/`) tree.
  --artifact-root <DIR>               Managed root for the capture artifact.
  --output <PATH>                     Runtime-evidence summary JSON.
  --run-id <ID>                       Trace run id (default rpgmaker-mv-mz-evidence-0001).
  --expect-textline-contains <SUBSTR> Fail unless some emitted TextLine contains SUBSTR.

Exit codes:
  0  utsushi.rpgmaker_mv.replay_text_match_ok      — substring matched (or no expectation).
  1  utsushi.rpgmaker_mv.replay_text_match_failed  — no TextLine body matched.
";

/// Execute the `rpgmaker-mv-capture` subcommand. Argv excludes the leading
/// `rpgmaker-mv-capture` token.
pub fn run_rpgmaker_mv_capture_command(args: &[String]) -> Result<(), Box<dyn Error>> {
    if args.iter().any(|arg| arg == "-h" || arg == "--help") {
        print!("{HELP}");
        return Ok(());
    }

    let game_dir = PathBuf::from(required_flag(args, "--game-dir")?);
    let artifact_root_path = PathBuf::from(required_flag(args, "--artifact-root")?);
    let output = PathBuf::from(required_flag(args, "--output")?);
    let run_id = optional_flag(args, "--run-id").unwrap_or("rpgmaker-mv-mz-evidence-0001");
    let expect = optional_flag(args, "--expect-textline-contains");

    let artifact_root = RuntimeArtifactRoot::new(&artifact_root_path);
    artifact_root.prepare()?;

    let runner = Runner::new();
    let mut port = UtsushiRpgmakerMvPort::new();
    let request = PortRequest::new(&game_dir, run_id, RuntimeOperation::Capture)
        .with_artifact_root(&artifact_root);
    let outcome = runner
        .run_capture(&mut port, &request)
        .map_err(|err| -> Box<dyn Error> {
            format!("utsushi.rpgmaker_mv.capture: {err}").into()
        })?;

    let texts: Vec<&str> = outcome
        .observations
        .iter()
        .flat_map(|observation| observation.text.iter().map(|line| line.text.as_str()))
        .collect();
    let line_count = texts.len();

    let artifact_path = outcome
        .capture
        .as_ref()
        .and_then(|capture| capture.artifact_path.clone());

    let matched = expect.map(|substr| texts.iter().any(|text| text.contains(substr)));
    let match_code = match matched {
        Some(false) => MATCH_FAILED_CODE,
        _ => MATCH_OK_CODE,
    };

    let summary = json!({
        "schema": "utsushi.rpgmaker-mv.runtime-evidence.v0",
        "portId": "utsushi-rpgmaker-mv",
        "runId": run_id,
        "lineCount": line_count,
        "captureArtifact": artifact_path.as_ref().map(|path| path.display().to_string()),
        "expectTextlineContains": expect,
        "matched": matched,
        "matchCode": match_code,
    });
    write_json(&output, &summary)?;

    if matched == Some(false) {
        return Err(format!(
            "{MATCH_FAILED_CODE}: no emitted TextLine contained the expected substring (lines={line_count})"
        )
        .into());
    }

    eprintln!(
        "utsushi rpgmaker-mv-capture: lines={line_count} matched={} matchCode={match_code}",
        matched.map_or_else(|| "n/a".to_string(), |value| value.to_string()),
    );
    Ok(())
}

fn required_flag<'a>(args: &'a [String], name: &str) -> Result<&'a str, Box<dyn Error>> {
    optional_flag(args, name).ok_or_else(|| format!("missing required flag {name}").into())
}

fn optional_flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|index| args.get(index + 1))
        .map(String::as_str)
}
