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
use std::fmt;
use std::fs;
use std::path::Path;
use std::path::PathBuf;

use serde_json::json;
use utsushi_core::{
    RuntimeAdapter, RuntimeAdapterRegistry, RuntimeCapability, RuntimeOperation, RuntimeRequest,
};

use crate::replay_registry::{
    emit_textlines_from_result, replay_log_json, replay_validate_parameters, text_line_count,
};

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
    [--require-zero-unknown]

FLAGS:
  --engine reallive           Replay engine. Only `reallive` is supported.
  --seen <PATH>               Path to a RealLive Seen.txt envelope.
  --scene <N>                 Scene id (u16) to drive through the VM.
  --print-replay-log <PATH>   Write the ReplayLog (deterministic JSON) to <PATH>.
                              This is the OBSERVED-OUTPUT evidence the caller
                              validates against the real translated text.
  --print-textlines           Also print every observed TextLine body to stdout.
  --require-zero-unknown      Fail after writing the replay artifact when replay
                              observed one or more unknown opcode tuples.
  -h, --help                  Print this message and exit.

EXIT CODES:
  0  utsushi.reallive.replay_observed_textlines_emitted — scene replayed and
     its observed TextLine evidence (ReplayLog) was written.
  1  driver error (read / parse / decode / serialise / write), or strict
     unknown-opcode validation failure after the replay artifact is written.

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
///   [--print-textlines] \
///   [--require-zero-unknown]
/// ```
///
/// Returns `Err` when the underlying driver fails (read, parse, decode), the
/// ReplayLog cannot be serialised/written, or strict mode observes an unknown
/// opcode. A scene that emits zero TextLine events is NOT an error here — the
/// caller's observed-output validation surfaces that as a failed match.
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
    let require_zero_unknown = args.iter().any(|arg| arg == "--require-zero-unknown");

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
    write_replay_artifact_then_apply_unknown_opcode_gate(
        &replay_json,
        &print_replay_log,
        require_zero_unknown,
    )?;

    let text_line_count = text_line_count(&result, "utsushi.cli.replay_validate")?;
    println!("{REPLAY_OK_CODE}: scene={scene_id} textline_count={text_line_count}");
    Ok(())
}

/// Typed strict-mode failure. It deliberately exposes only aggregate count and
/// sorted, de-duplicated opcode tuple identifiers; it never includes replay
/// text, game bytes, or filesystem paths.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplayUnknownOpcodeGateError {
    count: usize,
    keys: Vec<(u8, u8, u16)>,
}

impl fmt::Display for ReplayUnknownOpcodeGateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "utsushi.cli.replay_validate.unknown_opcode_gate: count={} keys=[",
            self.count
        )?;
        for (index, (module_type, module_id, opcode)) in self.keys.iter().enumerate() {
            if index > 0 {
                write!(formatter, ",")?;
            }
            write!(formatter, "({module_type},{module_id},{opcode})")?;
        }
        write!(formatter, "]")
    }
}

impl Error for ReplayUnknownOpcodeGateError {}

fn write_replay_artifact_then_apply_unknown_opcode_gate(
    replay_json: &str,
    output_path: &Path,
    require_zero_unknown: bool,
) -> Result<(), Box<dyn Error>> {
    fs::write(output_path, replay_json)
        .map_err(|err| format!("utsushi.cli.replay_validate.write: {err}"))?;
    if require_zero_unknown {
        require_zero_unknown_opcodes(replay_json)?;
    }
    Ok(())
}

fn require_zero_unknown_opcodes(replay_json: &str) -> Result<(), ReplayUnknownOpcodeGateError> {
    let replay_log: serde_json::Value = serde_json::from_str(replay_json).map_err(|_| {
        // The replay artifact came from this command's registry result. If its
        // typed replay-log contract is violated, fail closed without echoing
        // the artifact (which may contain private game data).
        ReplayUnknownOpcodeGateError {
            count: 0,
            keys: Vec::new(),
        }
    })?;
    let events = replay_log
        .get("events")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| ReplayUnknownOpcodeGateError {
            count: 0,
            keys: Vec::new(),
        })?;
    let mut count = 0;
    let mut keys = Vec::new();
    for event in events {
        if event.get("kind").and_then(serde_json::Value::as_str) != Some("unknown_opcode") {
            continue;
        }
        let module_type = event
            .get("moduleType")
            .and_then(serde_json::Value::as_u64)
            .and_then(|value| u8::try_from(value).ok());
        let module_id = event
            .get("moduleId")
            .and_then(serde_json::Value::as_u64)
            .and_then(|value| u8::try_from(value).ok());
        let opcode = event
            .get("opcode")
            .and_then(serde_json::Value::as_u64)
            .and_then(|value| u16::try_from(value).ok());
        let Some((module_type, module_id, opcode)) = module_type
            .zip(module_id)
            .zip(opcode)
            .map(|((module_type, module_id), opcode)| (module_type, module_id, opcode))
        else {
            return Err(ReplayUnknownOpcodeGateError {
                count: 0,
                keys: Vec::new(),
            });
        };
        count += 1;
        keys.push((module_type, module_id, opcode));
    }
    if count == 0 {
        return Ok(());
    }
    keys.sort_unstable();
    keys.dedup();
    Err(ReplayUnknownOpcodeGateError { count, keys })
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
    use utsushi_reallive::{REPLAY_LOG_SCHEMA_VERSION, ReplayEvent, ReplayLog, ReplayOutcome};

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
        assert!(HELP.contains("--require-zero-unknown"));
    }

    fn synthetic_replay_log_with_unknowns() -> String {
        ReplayLog {
            schema_version: REPLAY_LOG_SCHEMA_VERSION.to_string(),
            scene_id: 1,
            events: vec![
                ReplayEvent::Tick { count: 1 },
                ReplayEvent::UnknownOpcode {
                    byte_offset_in_scene: 4,
                    module_type: 2,
                    module_id: 3,
                    opcode: 4,
                },
                ReplayEvent::UnknownOpcode {
                    byte_offset_in_scene: 8,
                    module_type: 2,
                    module_id: 3,
                    opcode: 4,
                },
                ReplayEvent::UnknownOpcode {
                    byte_offset_in_scene: 12,
                    module_type: 5,
                    module_id: 6,
                    opcode: 7,
                },
            ],
            final_outcome: ReplayOutcome::EndOfScene { events: 4 },
        }
        .to_deterministic_json()
        .expect("synthetic ReplayLog serialises")
    }

    #[test]
    fn unknown_opcode_gate_is_diagnostic_by_default_and_strict_after_artifact_write() {
        let replay_json = synthetic_replay_log_with_unknowns();
        let tempdir = tempfile::tempdir().expect("create tempdir");
        let default_artifact = tempdir.path().join("default-replay-log.json");
        let strict_artifact = tempdir.path().join("strict-replay-log.json");

        write_replay_artifact_then_apply_unknown_opcode_gate(
            &replay_json,
            &default_artifact,
            false,
        )
        .expect("default mode retains diagnostic/success behavior");
        assert_eq!(fs::read_to_string(&default_artifact).unwrap(), replay_json);

        let error = write_replay_artifact_then_apply_unknown_opcode_gate(
            &replay_json,
            &strict_artifact,
            true,
        )
        .expect_err("strict mode rejects observed unknown opcodes");
        assert_eq!(fs::read_to_string(&strict_artifact).unwrap(), replay_json);
        assert_eq!(
            error.to_string(),
            "utsushi.cli.replay_validate.unknown_opcode_gate: count=3 keys=[(2,3,4),(5,6,7)]"
        );
        assert!(!error.to_string().contains("byte_offset"));
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
