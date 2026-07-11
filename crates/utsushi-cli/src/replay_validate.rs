//! UTSUSHI-227 — `utsushi-cli replay-validate --engine <engine>` command.
//!
//! Routes replay through the CLI runtime adapter registry and EMITS the
//! engine's OBSERVED output: captured TextLine bodies (stdout) plus the
//! deterministic replay-log JSON (`--print-replay-log`).
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
use std::path::PathBuf;

use serde_json::json;
use utsushi_core::{
    RuntimeAdapter, RuntimeAdapterRegistry, RuntimeCapability, RuntimeOperation, RuntimeRequest,
};

use crate::dispatch_gate::{
    require_semantic_reached_path, staged_dispatch_report, write_dispatch_report,
};
use crate::replay_registry::{
    emit_textlines_from_result, replay_log_json, replay_validate_parameters, text_line_count,
};
use utsushi_reallive::ReplayOpts;

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
    [--print-textlines] \
    [--dispatch-report <PATH>] \
    [--require-semantic-reached-path]

FLAGS:
  --engine reallive           Replay engine. Only `reallive` is supported.
  --seen <PATH>               Path to a RealLive Seen.txt envelope.
  --scene <N>                 Scene id (u16) to drive through the VM.
  --print-replay-log <PATH>   Write the ReplayLog (deterministic JSON) to <PATH>.
                              This is the OBSERVED-OUTPUT evidence the caller
                              validates against the real translated text.
  --print-textlines           Also print every observed TextLine body to stdout.
  --dispatch-report <PATH>    Write branch-following dispatch provenance evidence.
  --require-semantic-reached-path
                            Fail after writing artifacts unless the staged,
                            branch-following path is natural and fully semantic.
  -h, --help                  Print this message and exit.

EXIT CODES:
  0  utsushi.reallive.replay_observed_textlines_emitted — scene replayed and
     its observed TextLine evidence (ReplayLog) was written.
  1  driver error, or strict semantic-path validation failure after artifacts.

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
pub fn run_replay_validate_command(
    args: &[String],
    registry: &RuntimeAdapterRegistry<'_>,
) -> Result<(), Box<dyn Error>> {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        print!("{HELP}");
        return Ok(());
    }
    let engine = required_flag(args, "--engine")?;
    let seen_path = PathBuf::from(required_flag(args, "--seen")?);
    let scene_id: u16 = required_flag(args, "--scene")?.parse().map_err(|err| {
        format!("utsushi.cli.replay_validate.scene_parse: --scene must be a u16: {err}")
    })?;
    let print_replay_log = PathBuf::from(required_flag(args, "--print-replay-log")?);
    let print_textlines = args.iter().any(|arg| arg == "--print-textlines");
    let dispatch_report_path = optional_flag(args, "--dispatch-report").map(PathBuf::from);
    let require_semantic_path = args
        .iter()
        .any(|arg| arg == "--require-semantic-reached-path");
    if require_semantic_path && dispatch_report_path.is_none() {
        return Err("utsushi.cli.replay_validate.missing_flag: --dispatch-report".into());
    }

    let result = run_registry_replay_validate(
        registry,
        engine,
        &seen_path,
        replay_validate_parameters(scene_id),
    )?;

    if print_textlines {
        emit_textlines_from_result(&result, "utsushi.cli.replay_validate")?;
    }

    let replay_json = replay_log_json(&result, "utsushi.cli.replay_validate")?;
    fs::write(&print_replay_log, replay_json)
        .map_err(|err| format!("utsushi.cli.replay_validate.write: {err}"))?;

    if let Some(path) = dispatch_report_path {
        let report = staged_dispatch_report(&seen_path, scene_id, &ReplayOpts::default())?;
        write_dispatch_report(&path, &report)?;
        if require_semantic_path {
            require_semantic_reached_path(&report)?;
        }
    }

    let text_line_count = text_line_count(&result, "utsushi.cli.replay_validate")?;
    println!("{REPLAY_OK_CODE}: scene={scene_id} textline_count={text_line_count}");
    Ok(())
}

fn run_registry_replay_validate(
    registry: &RuntimeAdapterRegistry<'_>,
    engine: &str,
    seen_path: &std::path::Path,
    parameters: serde_json::Value,
) -> Result<serde_json::Value, Box<dyn Error>> {
    let descriptor = registry.adapter(engine).map(RuntimeAdapter::descriptor);
    let Some(descriptor) = descriptor else {
        return Err(registry_diagnostic(
            "utsushi.cli.replay_validate.registry_adapter_not_found",
            engine,
            "no runtime adapter is registered for the requested replay engine",
            registry,
        )
        .into());
    };
    if !descriptor.supports(RuntimeCapability::ReplayReview) {
        return Err(registry_diagnostic(
            "utsushi.cli.replay_validate.registry_capability_unsupported",
            engine,
            "registered runtime adapter does not support replay_review",
            registry,
        )
        .into());
    }
    let request = RuntimeRequest::new(seen_path).with_parameters(parameters);
    registry.run(engine, RuntimeOperation::ReplayReview, &request)
}

fn registry_diagnostic(
    code: &str,
    engine: &str,
    message: &str,
    registry: &RuntimeAdapterRegistry<'_>,
) -> String {
    json!({
        "diagnostic": {
            "code": code,
            "engine": engine,
            "requiredCapability": RuntimeCapability::ReplayReview.as_str(),
            "message": message,
            "registeredAdapters": registry.descriptors().into_iter().map(|descriptor| {
                let capabilities = descriptor
                    .capabilities
                    .into_iter()
                    .map(RuntimeCapability::as_str)
                    .collect::<Vec<_>>();
                json!({
                    "name": descriptor.name,
                    "capabilities": capabilities,
                })
            }).collect::<Vec<_>>(),
        }
    })
    .to_string()
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
    use crate::replay_registry::RealLiveReplayAdapter;

    fn replay_registry() -> RuntimeAdapterRegistry<'static> {
        static ADAPTER: RealLiveReplayAdapter = RealLiveReplayAdapter::new();
        let mut registry = RuntimeAdapterRegistry::new();
        registry.register(&ADAPTER).expect("register adapter");
        registry
    }

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
        let registry = replay_registry();
        let err =
            run_replay_validate_command(&args, &registry).expect_err("siglus is not supported");
        assert!(err.to_string().contains("registry_adapter_not_found"));
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
        let registry = replay_registry();
        let err = run_replay_validate_command(&args, &registry).expect_err("missing --seen");
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
        let registry = replay_registry();
        let err = run_replay_validate_command(&args, &registry).expect_err("scene parse must fail");
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
        let registry = replay_registry();
        let err =
            run_replay_validate_command(&args, &registry).expect_err("missing --print-replay-log");
        assert!(err.to_string().contains("--print-replay-log"));
    }

    #[test]
    fn help_documents_observed_output_contract() {
        assert!(HELP.contains("utsushi replay-validate"));
        assert!(HELP.contains("--engine reallive"));
        assert!(HELP.contains("OBSERVED-OUTPUT evidence"));
        assert!(!HELP.contains("expect-textline-contains"));
        assert!(HELP.contains("--require-semantic-reached-path"));
    }

    #[test]
    fn help_request_does_not_require_replay_flags() {
        let args: Vec<String> = vec!["--help".into()];
        let registry = replay_registry();
        run_replay_validate_command(&args, &registry)
            .expect("--help should not require --engine or --seen");
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

        let registry = replay_registry();
        let err = run_replay_validate_command(&args, &registry)
            .expect_err("missing Seen.txt should fail in the replay driver");
        assert!(
            err.to_string()
                .contains("utsushi.cli.replay_validate.driver"),
            "canonical invocation should parse and reach the registry-dispatched replay driver, \
             got: {err}"
        );
    }
}
