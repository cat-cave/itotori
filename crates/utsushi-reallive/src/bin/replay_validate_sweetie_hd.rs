//! UTSUSHI-227 — `replay-validate-sweetie-hd` binary.
//!
//! Drives [`utsushi_reallive::replay_scene`] against a (typically
//! patched) `Seen.txt`, captures the typed [`utsushi_reallive::ReplayLog`],
//! and asserts that at least one [`utsushi_reallive::ReplayEvent::TextLine`]
//! event's body carries an expected substring. Exits 0 on match,
//! non-zero on no-match (or on driver failure) so the alpha gate can be
//! wired into shell pipelines.
//!
//! # Usage
//!
//! ```text
//! cargo run -p utsushi-reallive --bin replay-validate-sweetie-hd -- \
//!   --seen <PATH> \
//!   --scene <N> \
//!   --expect-textline-contains <SUBSTR> \
//!   [--print-textlines] \
//!   [--print-replay-log <PATH>]
//! ```
//!
//! # Regression-sentinel contract
//!
//! The substring picker is the caller's contract: choose a substring
//! that does NOT appear in the ORIGINAL unpatched copy and DOES appear
//! in the patched copy. The KAIFUU-211 patchback's typical use lands
//! a translated bundle's first unit's first sentence — pull a stable
//! ASCII excerpt from that. The integration test
//! `replay_validate_real_sweetie_hd.rs` validates the sentinel survives
//! by running the validator against both copies and asserting only the
//! patched one matches.
//!
//! Linux-only: no `Command::new`, no Wine, no Windows helper, no remote
//! helper. The driver is pure Rust; the only system calls are
//! `std::fs::read` against the `--seen` path and (optionally)
//! `std::fs::write` against `--print-replay-log`.

use std::path::PathBuf;
use std::process::ExitCode;

use utsushi_reallive::{
    ReplayError, ReplayEvent, ReplayLog, ReplayOpts, ReplayValidation, replay_scene,
    validate_log_contains,
};

/// Stable diagnostic-code prefix the binary prints on the success exit
/// path. Pinned as a `&str` so any post-hoc shell test can grep for it
/// without parsing the human-readable suffix.
const MATCH_OK_CODE: &str = "utsushi.reallive.replay_text_match_ok";
/// Stable diagnostic-code prefix the binary prints on the no-match
/// exit path.
const MATCH_FAILED_CODE: &str = "utsushi.reallive.replay_text_match_failed";
/// Stable diagnostic-code prefix the binary prints when the underlying
/// driver fails (read, parse, decode).
const DRIVER_FAILED_CODE: &str = "utsushi.reallive.replay_validate.driver_failed";
/// Stable diagnostic-code prefix the binary prints on argv-parse
/// failures.
const ARGV_PARSE_CODE: &str = "utsushi.reallive.replay_validate.argv_parse";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        print_help();
        return ExitCode::SUCCESS;
    }
    let parsed = match ParsedArgs::from_argv(&args[1..]) {
        Ok(parsed) => parsed,
        Err(err) => {
            eprintln!("{ARGV_PARSE_CODE}: {err}");
            print_help();
            return ExitCode::from(2);
        }
    };
    match run(parsed) {
        Ok(exit) => exit,
        Err(err) => {
            // Driver failure (e.g. read, parse, decompress). Surface
            // the typed `ReplayError` Display via the stable code.
            eprintln!("{DRIVER_FAILED_CODE}: {err}");
            ExitCode::from(3)
        }
    }
}

/// Owned argv layout for the binary. Each field maps 1:1 to a `--flag`
/// the documented CLI surface accepts.
#[derive(Debug)]
struct ParsedArgs {
    seen_path: PathBuf,
    scene_id: u16,
    expected_substring: String,
    print_textlines: bool,
    print_replay_log: Option<PathBuf>,
}

impl ParsedArgs {
    /// Parse `argv` (excluding the program name). Every required flag
    /// is checked; unknown flags are rejected so a future flag rename
    /// surfaces loudly instead of silently no-oping.
    fn from_argv(argv: &[String]) -> Result<Self, String> {
        let mut seen_path: Option<PathBuf> = None;
        let mut scene_id: Option<u16> = None;
        let mut expected_substring: Option<String> = None;
        let mut print_textlines = false;
        let mut print_replay_log: Option<PathBuf> = None;
        let mut iter = argv.iter();
        while let Some(arg) = iter.next() {
            match arg.as_str() {
                "--seen" => {
                    let value = iter
                        .next()
                        .ok_or_else(|| "missing value for --seen".to_string())?;
                    seen_path = Some(PathBuf::from(value));
                }
                "--scene" => {
                    let value = iter
                        .next()
                        .ok_or_else(|| "missing value for --scene".to_string())?;
                    let parsed: u16 = value
                        .parse()
                        .map_err(|err| format!("--scene must be a u16: {err}"))?;
                    scene_id = Some(parsed);
                }
                "--expect-textline-contains" => {
                    let value = iter.next().ok_or_else(|| {
                        "missing value for --expect-textline-contains".to_string()
                    })?;
                    expected_substring = Some(value.clone());
                }
                "--print-textlines" => {
                    print_textlines = true;
                }
                "--print-replay-log" => {
                    let value = iter
                        .next()
                        .ok_or_else(|| "missing value for --print-replay-log".to_string())?;
                    print_replay_log = Some(PathBuf::from(value));
                }
                other => {
                    return Err(format!("unknown flag: {other}"));
                }
            }
        }
        let seen_path = seen_path.ok_or_else(|| "--seen is required".to_string())?;
        let scene_id = scene_id.ok_or_else(|| "--scene is required".to_string())?;
        let expected_substring = expected_substring
            .ok_or_else(|| "--expect-textline-contains is required".to_string())?;
        if expected_substring.is_empty() {
            return Err("--expect-textline-contains must be non-empty".to_string());
        }
        Ok(Self {
            seen_path,
            scene_id,
            expected_substring,
            print_textlines,
            print_replay_log,
        })
    }
}

fn run(args: ParsedArgs) -> Result<ExitCode, ReplayError> {
    let opts = ReplayOpts::default();
    let log = replay_scene(&args.seen_path, args.scene_id, &opts)?;

    if args.print_textlines {
        print_textlines(&log);
    }

    if let Some(path) = args.print_replay_log.as_deref() {
        let json = log.to_deterministic_json()?;
        std::fs::write(path, json).map_err(|err| ReplayError::SerializeFailure {
            reason: format!(
                "failed to write --print-replay-log target {}: {err}",
                path.display()
            ),
        })?;
    }

    let validation = validate_log_contains(&log, &args.expected_substring);
    match validation {
        ReplayValidation::Matched {
            matching_event_index,
            body_utf8,
        } => {
            println!(
                "{MATCH_OK_CODE}: scene={scene} substring={substring:?} \
                 matching_event_index={matching_event_index} body_utf8={body_utf8:?}",
                scene = args.scene_id,
                substring = args.expected_substring,
            );
            Ok(ExitCode::SUCCESS)
        }
        ReplayValidation::NoMatch {
            textline_count,
            sample_bodies,
        } => {
            // Stdout carries the stable code so any pipeline matcher
            // can detect the failure without parsing stderr.
            println!(
                "{MATCH_FAILED_CODE}: scene={scene} substring={substring:?} \
                 textline_count={textline_count}",
                scene = args.scene_id,
                substring = args.expected_substring,
            );
            // Full ReplayLog JSON to stderr per the spec, so a CI log
            // capture preserves the alpha-audit evidence.
            match log.to_deterministic_json() {
                Ok(json) => {
                    eprintln!("--- ReplayLog (deterministic JSON) ---");
                    eprintln!("{json}");
                }
                Err(err) => {
                    eprintln!(
                        "{DRIVER_FAILED_CODE}: failed to serialise ReplayLog for no-match \
                         diagnostic: {err}"
                    );
                }
            }
            eprintln!("--- Sample TextLine bodies ({}) ---", sample_bodies.len());
            for (index, body) in sample_bodies.iter().enumerate() {
                eprintln!("  [{index}] {body:?}");
            }
            Ok(ExitCode::from(1))
        }
    }
}

fn print_textlines(log: &ReplayLog) {
    let mut count = 0usize;
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

fn print_help() {
    let help = r#"replay-validate-sweetie-hd — UTSUSHI-227 patched-Seen.txt replay-and-verify smoke

USAGE:
  replay-validate-sweetie-hd \
    --seen <PATH> \
    --scene <N> \
    --expect-textline-contains <SUBSTR> \
    [--print-textlines] \
    [--print-replay-log <PATH>]

FLAGS:
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
  1  utsushi.reallive.replay_text_match_failed  — no TextLine body matched
                                                  (full ReplayLog written to
                                                  stderr).
  2  utsushi.reallive.replay_validate.argv_parse — argv parse error.
  3  utsushi.reallive.replay_validate.driver_failed — read/parse/decode
                                                       failed in the driver.

SUBSTRING CONTRACT (acceptance criterion #1 — regression sentinel):
  The substring must be unique to the patched copy. Pick a stable excerpt
  from the FIRST translated unit's FIRST sentence; verify by re-running
  this binary against the ORIGINAL unpatched copy and confirming exit 1.

LINUX-ONLY: this binary does not invoke Wine, NW.js, browser, or any
Windows binary. The driver is pure Rust over the substrate facade.
"#;
    print!("{help}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argv_parse_rejects_missing_required_flags() {
        let argv: Vec<String> = vec!["--seen".to_string(), "/tmp/x".to_string()];
        let err = ParsedArgs::from_argv(&argv).expect_err("missing flags must be rejected");
        assert!(err.contains("--scene") || err.contains("--expect-textline-contains"));
    }

    #[test]
    fn argv_parse_rejects_empty_expected_substring() {
        let argv: Vec<String> = vec![
            "--seen".into(),
            "/tmp/x".into(),
            "--scene".into(),
            "1".into(),
            "--expect-textline-contains".into(),
            "".into(),
        ];
        let err = ParsedArgs::from_argv(&argv).expect_err("empty substring must be rejected");
        assert!(err.contains("must be non-empty"));
    }

    #[test]
    fn argv_parse_rejects_unknown_flag() {
        let argv: Vec<String> = vec![
            "--seen".into(),
            "/tmp/x".into(),
            "--scene".into(),
            "1".into(),
            "--expect-textline-contains".into(),
            "STELLA".into(),
            "--bogus".into(),
        ];
        let err = ParsedArgs::from_argv(&argv).expect_err("unknown flag must be rejected");
        assert!(err.contains("--bogus"));
    }

    #[test]
    fn argv_parse_accepts_full_canonical_invocation() {
        let argv: Vec<String> = vec![
            "--seen".into(),
            "/tmp/Seen.txt".into(),
            "--scene".into(),
            "1".into(),
            "--expect-textline-contains".into(),
            "STELLA-ALPHA-227-EN-US".into(),
            "--print-textlines".into(),
            "--print-replay-log".into(),
            "/tmp/replay.json".into(),
        ];
        let parsed = ParsedArgs::from_argv(&argv).expect("parse");
        assert_eq!(parsed.seen_path, PathBuf::from("/tmp/Seen.txt"));
        assert_eq!(parsed.scene_id, 1);
        assert_eq!(parsed.expected_substring, "STELLA-ALPHA-227-EN-US");
        assert!(parsed.print_textlines);
        assert_eq!(
            parsed.print_replay_log,
            Some(PathBuf::from("/tmp/replay.json"))
        );
    }

    #[test]
    fn argv_parse_rejects_non_u16_scene() {
        let argv: Vec<String> = vec![
            "--seen".into(),
            "/tmp/x".into(),
            "--scene".into(),
            "notanint".into(),
            "--expect-textline-contains".into(),
            "STELLA".into(),
        ];
        let err = ParsedArgs::from_argv(&argv).expect_err("non-u16 must be rejected");
        assert!(err.contains("u16"));
    }
}
