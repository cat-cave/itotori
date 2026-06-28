//! UTSUSHI-227 — `utsushi-cli replay-validate --engine reallive` command.
//!
//! Drives [`utsushi_reallive::replay_scene`] against a Seen.txt path
//! and asserts that at least one captured
//! [`utsushi_reallive::ReplayEvent::TextLine`] body carries the
//! expected substring. This generic subcommand is the active replay
//! validation surface for RealLive titles.
//!
//! The substring-source contract (acceptance criterion #1 — regression
//! sentinel) is the caller's: pick a substring unique to the patched
//! copy. The integration test
//! `crates/utsushi-reallive/tests/replay_validate_real_sweetie_hd.rs`
//! validates the contract by running the validator on both the
//! patched and the original copy and asserting only the patched copy
//! matches.

use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

use utsushi_reallive::{
    ReplayEvent, ReplayLog, ReplayOpts, ReplayValidation, replay_scene, validate_log_contains,
};

/// Stable string naming the engine the replay-validate command targets.
/// Mirrors the `replay` subcommand's constraint — only `reallive` is
/// supported today; a typed error fires for any other value (no silent
/// fallback).
const SUPPORTED_ENGINE: &str = "reallive";

/// Stable diagnostic-code prefix the subcommand prints on the success
/// exit path. Matches the reallive validator library diagnostic so a
/// pipeline matcher can grep for it consistently.
const MATCH_OK_CODE: &str = "utsushi.reallive.replay_text_match_ok";
/// Stable diagnostic-code prefix the subcommand prints on the no-match
/// exit path.
const MATCH_FAILED_CODE: &str = "utsushi.reallive.replay_text_match_failed";

const HELP: &str = r#"utsushi replay-validate — patched Seen.txt replay-and-verify smoke

USAGE:
  utsushi-cli replay-validate \
    --engine reallive \
    --seen <PATH> \
    --scene <N> \
    --expect-textline-contains <SUBSTR> \
    [--print-textlines] \
    [--print-replay-log <PATH>]

FLAGS:
  --engine reallive                   Replay engine. Only `reallive` is supported.
  --seen <PATH>                       Path to a RealLive Seen.txt envelope.
  --scene <N>                         Scene id (u16) to drive through the VM.
  --expect-textline-contains <SUBSTR> Substring expected in at least one
                                      captured TextLine event's body (UTF-8 or
                                      Shift-JIS redecode).
  --print-textlines                   Print every TextLine body to stdout.
  --print-replay-log <PATH>           Write the ReplayLog (deterministic JSON)
                                      to <PATH> in addition to validating.
  -h, --help                          Print this message and exit.

EXIT CODES:
  0  utsushi.reallive.replay_text_match_ok      — substring matched.
  1  utsushi.reallive.replay_text_match_failed  — no TextLine body matched.

SUBSTRING CONTRACT:
  The substring must be unique to the patched copy. Pick a stable excerpt
  from the first translated unit's first sentence; verify by re-running
  against the original unpatched copy and confirming it does not match.
"#;

/// Execute the `replay-validate` subcommand. The argv layout is:
///
/// ```text
/// utsushi-cli replay-validate \
///   --engine reallive \
///   --seen <PATH> \
///   --scene <N> \
///   --expect-textline-contains <SUBSTR> \
///   [--print-textlines] \
///   [--print-replay-log <PATH>]
/// ```
///
/// Returns `Err` if the underlying driver fails OR if the substring
/// does not appear in any TextLine body (so the caller's
/// non-zero-exit-on-`Err` contract surfaces a regression-sentinel
/// failure correctly).
pub fn run_replay_validate_command(args: &[String]) -> Result<(), Box<dyn Error>> {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        print!("{HELP}");
        return Ok(());
    }
    let engine = required_flag(args, "--engine")?;
    if engine != SUPPORTED_ENGINE {
        return Err(format!(
            "utsushi.cli.replay_validate.unsupported_engine: engine={engine}; only \
             {SUPPORTED_ENGINE} is supported",
        )
        .into());
    }
    let seen_path = PathBuf::from(required_flag(args, "--seen")?);
    let scene_id: u16 = required_flag(args, "--scene")?.parse().map_err(|err| {
        format!("utsushi.cli.replay_validate.scene_parse: --scene must be a u16: {err}")
    })?;
    let expected_substring = required_flag(args, "--expect-textline-contains")?.to_string();
    if expected_substring.is_empty() {
        return Err(
            "utsushi.cli.replay_validate.empty_substring: --expect-textline-contains must be \
             non-empty"
                .into(),
        );
    }
    let print_textlines = args.iter().any(|arg| arg == "--print-textlines");
    let print_replay_log = optional_flag(args, "--print-replay-log").map(PathBuf::from);

    drive(
        &seen_path,
        scene_id,
        &expected_substring,
        print_textlines,
        print_replay_log.as_deref(),
    )
}

fn drive(
    seen_path: &Path,
    scene_id: u16,
    expected_substring: &str,
    print_textlines: bool,
    print_replay_log: Option<&Path>,
) -> Result<(), Box<dyn Error>> {
    let opts = ReplayOpts::default();
    let log = replay_scene(seen_path, scene_id, &opts)
        .map_err(|err| format!("utsushi.cli.replay_validate.driver: {err}"))?;

    if print_textlines {
        emit_textlines(&log);
    }
    if let Some(path) = print_replay_log {
        let json = log
            .to_deterministic_json()
            .map_err(|err| format!("utsushi.cli.replay_validate.serialise: {err}"))?;
        fs::write(path, json).map_err(|err| format!("utsushi.cli.replay_validate.write: {err}"))?;
    }

    match validate_log_contains(&log, expected_substring) {
        ReplayValidation::Matched {
            matching_event_index,
            body_utf8,
        } => {
            println!(
                "{MATCH_OK_CODE}: scene={scene_id} substring={expected_substring:?} \
                 matching_event_index={matching_event_index} body_utf8={body_utf8:?}",
            );
            Ok(())
        }
        ReplayValidation::NoMatch {
            textline_count,
            sample_bodies,
        } => {
            println!(
                "{MATCH_FAILED_CODE}: scene={scene_id} substring={expected_substring:?} \
                 textline_count={textline_count}",
            );
            // Mirror the library validator's diagnostic posture:
            // ReplayLog JSON to stderr.
            match log.to_deterministic_json() {
                Ok(json) => {
                    eprintln!("--- ReplayLog (deterministic JSON) ---");
                    eprintln!("{json}");
                }
                Err(err) => {
                    eprintln!(
                        "utsushi.cli.replay_validate.serialise: failed to render ReplayLog \
                         for no-match diagnostic: {err}"
                    );
                }
            }
            eprintln!("--- Sample TextLine bodies ({}) ---", sample_bodies.len());
            for (index, body) in sample_bodies.iter().enumerate() {
                eprintln!("  [{index}] {body:?}");
            }
            Err(format!(
                "utsushi.cli.replay_validate.no_match: scene={scene_id} \
                 substring={expected_substring:?} textline_count={textline_count}"
            )
            .into())
        }
    }
}

fn emit_textlines(log: &ReplayLog) {
    let mut count: usize = 0;
    for event in &log.events {
        if let ReplayEvent::TextLine {
            byte_offset_in_scene,
            body_utf8,
            ..
        } = event
        {
            println!("textline[{count}] pc=0x{byte_offset_in_scene:04x} body={body_utf8:?}");
            count += 1;
        }
    }
    println!("textline_total={count}");
}

fn required_flag<'a>(args: &'a [String], name: &str) -> Result<&'a str, Box<dyn Error>> {
    optional_flag(args, name)
        .ok_or_else(|| format!("utsushi.cli.replay_validate.missing_flag: {name}").into())
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
            "--expect-textline-contains".into(),
            "STELLA".into(),
        ];
        let err = run_replay_validate_command(&args).expect_err("siglus is not supported");
        assert!(err.to_string().contains("unsupported_engine"));
    }

    #[test]
    fn rejects_missing_seen_flag() {
        let args: Vec<String> = vec![
            "--engine".into(),
            "reallive".into(),
            "--scene".into(),
            "1".into(),
            "--expect-textline-contains".into(),
            "STELLA".into(),
        ];
        let err = run_replay_validate_command(&args).expect_err("missing --seen");
        assert!(err.to_string().contains("--seen"));
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
            "--expect-textline-contains".into(),
            "STELLA".into(),
        ];
        let err = run_replay_validate_command(&args).expect_err("scene parse must fail");
        assert!(err.to_string().contains("scene_parse"));
    }

    #[test]
    fn rejects_empty_expected_substring() {
        let args: Vec<String> = vec![
            "--engine".into(),
            "reallive".into(),
            "--seen".into(),
            "/tmp/nothing".into(),
            "--scene".into(),
            "1".into(),
            "--expect-textline-contains".into(),
            "".into(),
        ];
        let err = run_replay_validate_command(&args).expect_err("empty substring rejected");
        assert!(err.to_string().contains("empty_substring"));
    }

    #[test]
    fn help_documents_generic_alpha_replay_path() {
        assert!(HELP.contains("utsushi-cli replay-validate"));
        assert!(HELP.contains("--engine reallive"));
        assert!(HELP.contains("--expect-textline-contains <SUBSTR>"));
        assert!(HELP.contains("unique to the patched copy"));
    }

    #[test]
    fn help_request_does_not_require_replay_flags() {
        let args: Vec<String> = vec!["--help".into()];
        run_replay_validate_command(&args).expect("--help should not require --engine or --seen");
    }

    #[test]
    fn canonical_generic_alpha_invocation_reaches_reallive_driver() {
        let missing_seen_path = std::env::temp_dir().join(format!(
            "utsushi-cli-replay-validate-missing-seen-{}",
            std::process::id()
        ));
        let args: Vec<String> = vec![
            "--engine".into(),
            "reallive".into(),
            "--seen".into(),
            missing_seen_path.display().to_string(),
            "--scene".into(),
            "1".into(),
            "--expect-textline-contains".into(),
            "STELLA-ALPHA-EN-US-SENTINEL".into(),
            "--print-replay-log".into(),
            missing_seen_path.with_extension("json").display().to_string(),
        ];

        let err = run_replay_validate_command(&args)
            .expect_err("missing Seen.txt should fail in the replay driver");
        assert!(
            err.to_string()
                .contains("utsushi.cli.replay_validate.driver"),
            "canonical generic invocation should parse and reach the replay driver, got: {err}"
        );
    }
}
