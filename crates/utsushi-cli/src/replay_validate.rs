//! `utsushi-cli replay-validate --engine <adapter>` command.
//!
//! Engine-specific inputs remain opaque until the selected CLI adapter owns
//! them. Dispatch provenance is also requested through that selected adapter.

use std::error::Error;
use std::fs;
use std::path::PathBuf;

use utsushi_core::RuntimeAdapterRegistry;

use crate::dispatch_gate::write_dispatch_report;
use crate::replay_cli_registry::{
    ReplayCliOperation, default_cli_registry, parse_generic_request, require_semantic_path,
    run_selected_replay, selected_dispatch_report,
};
use crate::replay_registry::{emit_textlines_from_result, replay_log_json, text_line_count};

const REPLAY_OK_CODE: &str = "utsushi.reallive.replay_observed_textlines_emitted";

const HELP: &str = r"utsushi replay-validate — patched artifact replay + observed-output emit

USAGE:
  utsushi-cli replay-validate \
    --engine <adapter> \
    --artifact-root <DIR> \
    --launch-descriptor <JSON> \
    --print-replay-log <PATH> \
    [--print-textlines] \
    [--dispatch-report <PATH>] \
    [--require-semantic-reached-path]

FLAGS:
  --engine <adapter>          Required runtime-adapter discriminator.
  --artifact-root <DIR>       Generic root holding the adapter's patched artifacts.
  --launch-descriptor <JSON>  Opaque JSON descriptor interpreted by the selected adapter.
  --print-replay-log <PATH>   Write the deterministic observed replay log.
  --print-textlines           Also print every observed TextLine body to stdout.
  --dispatch-report <PATH>    Write adapter-owned branch-following dispatch provenance.
  --require-semantic-reached-path
                            Fail after writing artifacts unless the selected adapter
                            reports a natural and fully semantic path.
  -h, --help                  Print this message and exit.

VALIDATION CONTRACT:
  This command does NOT assert on any substring. The caller reads the emitted
  ReplayLog and validates that observed text reflects the patched bytes.
";

pub fn run_replay_validate_command(
    args: &[String],
    registry: &RuntimeAdapterRegistry<'_>,
) -> Result<(), Box<dyn Error>> {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        print!("{HELP}");
        return Ok(());
    }
    let (adapter_id, request) = parse_generic_request(args, "utsushi.cli.replay_validate")?;
    let print_replay_log = PathBuf::from(required_flag(args, "--print-replay-log")?);
    let print_textlines = args.iter().any(|arg| arg == "--print-textlines");
    let dispatch_report_path = optional_flag(args, "--dispatch-report").map(PathBuf::from);
    let require_semantic_reached_path = args
        .iter()
        .any(|arg| arg == "--require-semantic-reached-path");
    if require_semantic_reached_path && dispatch_report_path.is_none() {
        return Err("utsushi.cli.replay_validate.missing_flag: --dispatch-report".into());
    }

    let cli_registry = default_cli_registry();
    let result = run_selected_replay(
        registry,
        &cli_registry,
        &adapter_id,
        &request,
        ReplayCliOperation::ReplayValidate,
        "utsushi.cli.replay_validate",
    )?;
    if print_textlines {
        emit_textlines_from_result(&result, "utsushi.cli.replay_validate")?;
    }
    let replay_json = replay_log_json(&result, "utsushi.cli.replay_validate")?;
    fs::write(&print_replay_log, replay_json)
        .map_err(|err| format!("utsushi.cli.replay_validate.write: {err}"))?;

    if let Some(path) = dispatch_report_path {
        let report = selected_dispatch_report(
            registry,
            &cli_registry,
            &adapter_id,
            &request,
            "utsushi.cli.replay_validate",
        )?;
        write_dispatch_report(&path, &report)?;
        if require_semantic_reached_path {
            require_semantic_path(&report)?;
        }
    }

    let text_line_count = text_line_count(&result, "utsushi.cli.replay_validate")?;
    let scene = result
        .get("sceneId")
        .and_then(serde_json::Value::as_u64)
        .ok_or(
            "utsushi.cli.replay_validate.registry_result: selected adapter did not report a scene",
        )?;
    println!("{REPLAY_OK_CODE}: scene={scene} textline_count={text_line_count}");
    Ok(())
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
    fn rejects_unsupported_engine_from_the_selected_manifest() {
        let args: Vec<String> = vec![
            "--engine".into(),
            "siglus".into(),
            "--artifact-root".into(),
            "/tmp/nothing".into(),
            "--launch-descriptor".into(),
            "{}".into(),
            "--print-replay-log".into(),
            "/tmp/replay-log.json".into(),
        ];
        let registry = replay_registry();
        let err =
            run_replay_validate_command(&args, &registry).expect_err("siglus is not registered");
        assert!(err.to_string().contains("registry_adapter_not_found"));
    }

    #[test]
    fn rejects_missing_generic_descriptor() {
        let args: Vec<String> = vec![
            "--engine".into(),
            "reallive".into(),
            "--artifact-root".into(),
            "/tmp/nothing".into(),
            "--print-replay-log".into(),
            "/tmp/replay-log.json".into(),
        ];
        let registry = replay_registry();
        let err = run_replay_validate_command(&args, &registry).expect_err("descriptor required");
        assert!(err.to_string().contains("--launch-descriptor"));
    }

    #[test]
    fn help_documents_generic_adapter_contract() {
        assert!(HELP.contains("--engine <adapter>"));
        assert!(HELP.contains("--artifact-root <DIR>"));
        assert!(HELP.contains("--launch-descriptor <JSON>"));
        assert!(HELP.contains("OBSERVED-OUTPUT") || HELP.contains("observed-output"));
        assert!(!HELP.contains("expect-textline-contains"));
        assert!(HELP.contains("--require-semantic-reached-path"));
    }

    #[test]
    fn help_request_does_not_require_replay_flags() {
        let args: Vec<String> = vec!["--help".into()];
        let registry = replay_registry();
        run_replay_validate_command(&args, &registry)
            .expect("--help should not require --engine or descriptor");
    }

    #[test]
    fn generic_invocation_reaches_reallive_driver() {
        let missing_root = std::env::temp_dir().join(format!(
            "utsushi-cli-replay-validate-missing-root-{}",
            std::process::id()
        ));
        let args: Vec<String> = vec![
            "--engine".into(),
            "reallive".into(),
            "--artifact-root".into(),
            missing_root.display().to_string(),
            "--launch-descriptor".into(),
            r#"{"scene":1,"gameexePath":"/tmp/missing-gameexe.ini","g00Dir":"/tmp/missing-g00"}"#
                .into(),
            "--print-replay-log".into(),
            missing_root.with_extension("json").display().to_string(),
        ];

        let registry = replay_registry();
        let err = run_replay_validate_command(&args, &registry)
            .expect_err("missing artifact should fail in the replay driver");
        assert!(
            err.to_string()
                .contains("utsushi.cli.replay_validate.driver"),
            "generic invocation should reach the registry-dispatched replay driver, got: {err}"
        );
    }
}
