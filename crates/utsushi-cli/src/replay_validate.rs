//! UTSUSHI-227 — `utsushi-cli replay-validate --engine reallive` command.
//!
//! Drives [`utsushi_reallive::replay_scene`] against a (patched) Seen.txt
//! path and EMITS the engine's OBSERVED output: the captured
//! [`utsushi_reallive::ReplayEvent::TextLine`] bodies (stdout) plus the
//! deterministic [`utsushi_reallive::ReplayLog`] JSON (`--print-replay-log`).
//!
//! This command performs NO substring assertion of its own. The runtime
//! evidence is validated by the caller (the localize-project driver),
//! which reads the emitted ReplayLog and asserts that the engine's
//! observed TextLine bodies reflect the REAL translated text it patched
//! into Seen.txt (recorded in `patch-report.json`). There is no
//! harness-planted sentinel: the assertion is over what the engine
//! actually decoded from the patched bytes.

use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

use utsushi_reallive::{ReplayEvent, ReplayLog, ReplayOpts};

use crate::staged_replay::replay_scene_staged;

/// Stable string naming the engine the replay-validate command targets.
/// Mirrors the `replay` subcommand's constraint — only `reallive` is
/// supported today; a typed error fires for any other value (no silent
/// fallback).
const SUPPORTED_ENGINE: &str = "reallive";

/// Stable diagnostic-code prefix printed on the success exit path (the
/// scene replayed and its observed TextLine evidence was emitted).
const REPLAY_OK_CODE: &str = "utsushi.reallive.replay_observed_textlines_emitted";

const HELP: &str = r"utsushi replay-validate — patched Seen.txt replay + observed-output emit

USAGE:
  utsushi-cli replay-validate \
    --engine reallive \
    --seen <PATH> \
    --scene <N> \
    --print-replay-log <PATH> \
    [--print-textlines]

FLAGS:
  --engine reallive           Replay engine. Only `reallive` is supported.
  --seen <PATH>               Path to a RealLive Seen.txt envelope.
  --scene <N>                 Scene id (u16) to drive through the VM.
  --print-replay-log <PATH>   Write the ReplayLog (deterministic JSON) to <PATH>.
                              This is the OBSERVED-OUTPUT evidence the caller
                              validates against the real translated text.
  --print-textlines           Also print every observed TextLine body to stdout.
  -h, --help                  Print this message and exit.

EXIT CODES:
  0  utsushi.reallive.replay_observed_textlines_emitted — scene replayed and
     its observed TextLine evidence (ReplayLog) was written.
  1  driver error (read / parse / decode / serialise / write).

VALIDATION CONTRACT:
  This command does NOT assert on any substring. The caller reads the
  emitted ReplayLog's `text_line` events and asserts that the engine's
  observed body reflects the REAL translated text patched into Seen.txt
  (the localize-project driver derives that text from patch-report.json).
";

/// Execute the `replay-validate` subcommand. The argv layout is:
///
/// ```text
/// utsushi-cli replay-validate \
///   --engine reallive \
///   --seen <PATH> \
///   --scene <N> \
///   --print-replay-log <PATH> \
///   [--print-textlines]
/// ```
///
/// Returns `Err` only when the underlying driver fails (read, parse,
/// decode) or the ReplayLog cannot be serialised/written. A scene that
/// emits zero TextLine events is NOT an error here — the caller's
/// observed-output validation surfaces that as a failed match.
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
    let print_replay_log = PathBuf::from(required_flag(args, "--print-replay-log")?);
    let print_textlines = args.iter().any(|arg| arg == "--print-textlines");

    drive(&seen_path, scene_id, &print_replay_log, print_textlines)
}

fn drive(
    seen_path: &Path,
    scene_id: u16,
    replay_log_path: &Path,
    print_textlines: bool,
) -> Result<(), Box<dyn Error>> {
    let opts = ReplayOpts::default();
    // Stage the dev-only `use_xor_2` recovery for xor2 titles (Sweetie HD,
    // compiler 110002) so the observed TextLine bodies decode REAL text
    // instead of the still-ciphered segment's mojibake. Non-xor2 titles fall
    // through to the pure-`utsushi-reallive` decode path unchanged.
    let log = replay_scene_staged(seen_path, scene_id, &opts)
        .map_err(|err| format!("utsushi.cli.replay_validate.driver: {err}"))?;

    if print_textlines {
        emit_textlines(&log);
    }

    let json = log
        .to_deterministic_json()
        .map_err(|err| format!("utsushi.cli.replay_validate.serialise: {err}"))?;
    fs::write(replay_log_path, json)
        .map_err(|err| format!("utsushi.cli.replay_validate.write: {err}"))?;

    println!(
        "{REPLAY_OK_CODE}: scene={scene_id} textline_count={}",
        log.text_line_count(),
    );
    Ok(())
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
            "--print-replay-log".into(),
            "/tmp/replay-log.json".into(),
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
            "--print-replay-log".into(),
            "/tmp/replay-log.json".into(),
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
            "--print-replay-log".into(),
            "/tmp/replay-log.json".into(),
        ];
        let err = run_replay_validate_command(&args).expect_err("scene parse must fail");
        assert!(err.to_string().contains("scene_parse"));
    }

    #[test]
    fn rejects_missing_replay_log_flag() {
        let args: Vec<String> = vec![
            "--engine".into(),
            "reallive".into(),
            "--seen".into(),
            "/tmp/nothing".into(),
            "--scene".into(),
            "1".into(),
        ];
        let err = run_replay_validate_command(&args).expect_err("missing --print-replay-log");
        assert!(err.to_string().contains("--print-replay-log"));
    }

    #[test]
    fn help_documents_observed_output_contract() {
        assert!(HELP.contains("utsushi replay-validate"));
        assert!(HELP.contains("--engine reallive"));
        assert!(HELP.contains("OBSERVED-OUTPUT evidence"));
        assert!(!HELP.contains("expect-textline-contains"));
    }

    #[test]
    fn help_request_does_not_require_replay_flags() {
        let args: Vec<String> = vec!["--help".into()];
        run_replay_validate_command(&args).expect("--help should not require --engine or --seen");
    }

    #[test]
    fn canonical_invocation_reaches_reallive_driver() {
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
            "--print-replay-log".into(),
            missing_seen_path
                .with_extension("json")
                .display()
                .to_string(),
        ];

        let err = run_replay_validate_command(&args)
            .expect_err("missing Seen.txt should fail in the replay driver");
        assert!(
            err.to_string()
                .contains("utsushi.cli.replay_validate.driver"),
            "canonical invocation should parse and reach the replay driver, got: {err}"
        );
    }
}
