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
use crate::staged_replay::staged_engine;
use utsushi_reallive::{BranchReplayReport, BranchTerminus, HeadlessChoicePolicy, ReplayOpts};

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
        let report = staged_dispatch_report(&seen_path, scene_id)?;
        write_dispatch_report(&path, &report)?;
        if require_semantic_path {
            require_semantic_reached_path(&report)?;
        }
    }

    let text_line_count = text_line_count(&result, "utsushi.cli.replay_validate")?;
    println!("{REPLAY_OK_CODE}: scene={scene_id} textline_count={text_line_count}");
    Ok(())
}

const DISPATCH_REPORT_SCHEMA_VERSION: &str = "utsushi.cli.replay-dispatch-report/0.1.0";

#[derive(Debug, Clone, PartialEq, Eq)]
struct DispatchReport {
    schema_version: String,
    traversal: &'static str,
    policy: &'static str,
    linear_fallback: bool,
    terminus: &'static str,
    missing_count: usize,
    missing_keys: Vec<(u8, u8, u16)>,
    catalog_fallback_count: usize,
    catalog_fallback_keys: Vec<(u8, u8, u16)>,
}

fn staged_dispatch_report(
    seen_path: &Path,
    scene_id: u16,
) -> Result<DispatchReport, Box<dyn Error>> {
    let engine = staged_engine(seen_path)?;
    let report = engine.branch_following_report(
        scene_id,
        &ReplayOpts::default(),
        HeadlessChoicePolicy::AlwaysFirst,
    );
    Ok(DispatchReport::from_branch_report(&report))
}

impl DispatchReport {
    fn from_branch_report(report: &BranchReplayReport) -> Self {
        Self {
            schema_version: DISPATCH_REPORT_SCHEMA_VERSION.to_string(),
            traversal: "branch_following",
            policy: "always_first",
            linear_fallback: false,
            terminus: branch_terminus_kind(&report.terminus),
            missing_count: report.unknown_opcode_keys.len(),
            missing_keys: report.unknown_opcode_keys.clone(),
            catalog_fallback_count: report.catalog_fallback_keys.len(),
            catalog_fallback_keys: report.catalog_fallback_keys.clone(),
        }
    }
}

fn branch_terminus_kind(terminus: &BranchTerminus) -> &'static str {
    match terminus {
        BranchTerminus::EndOfScene => "end_of_scene",
        BranchTerminus::ReturnedToCaller => "returned_to_caller",
        BranchTerminus::BudgetExhausted => "budget_exhausted",
        BranchTerminus::SceneNotFound(_) => "scene_not_found",
        BranchTerminus::EntrypointNotFound(_, _) => "entrypoint_not_found",
        BranchTerminus::EventGatedSpin { .. } => "event_gated_spin",
        BranchTerminus::OtherFatal(_) => "other_fatal",
    }
}

fn write_dispatch_report(path: &Path, report: &DispatchReport) -> Result<(), Box<dyn Error>> {
    let json = serde_json::to_string_pretty(&json!({
        "schemaVersion": report.schema_version,
        "traversal": report.traversal,
        "policy": report.policy,
        "linearFallback": report.linear_fallback,
        "terminus": report.terminus,
        "missingCount": report.missing_count,
        "missingKeys": report.missing_keys,
        "catalogFallbackCount": report.catalog_fallback_count,
        "catalogFallbackKeys": report.catalog_fallback_keys,
    }))
    .map_err(|err| format!("utsushi.cli.replay_validate.dispatch_report_serialise: {err}"))?;
    fs::write(path, json)
        .map_err(|err| format!("utsushi.cli.replay_validate.dispatch_report_write: {err}"))?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SemanticPathUnavailable {
    report: DispatchReport,
}

impl fmt::Display for SemanticPathUnavailable {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "utsushi.cli.replay_validate.semantic_path_unavailable: terminus={} linear_fallback={} missing_count={} missing_keys={:?} catalog_fallback_count={} catalog_fallback_keys={:?}",
            self.report.terminus,
            self.report.linear_fallback,
            self.report.missing_count,
            self.report.missing_keys,
            self.report.catalog_fallback_count,
            self.report.catalog_fallback_keys,
        )
    }
}

impl Error for SemanticPathUnavailable {}

fn require_semantic_reached_path(report: &DispatchReport) -> Result<(), SemanticPathUnavailable> {
    let natural = matches!(report.terminus, "end_of_scene" | "returned_to_caller");
    if natural
        && !report.linear_fallback
        && report.missing_keys.is_empty()
        && report.catalog_fallback_keys.is_empty()
    {
        return Ok(());
    }
    Err(SemanticPathUnavailable {
        report: report.clone(),
    })
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

    fn synthetic_dispatch_report(
        missing_keys: Vec<(u8, u8, u16)>,
        catalog_fallback_keys: Vec<(u8, u8, u16)>,
        linear_fallback: bool,
    ) -> DispatchReport {
        DispatchReport {
            schema_version: DISPATCH_REPORT_SCHEMA_VERSION.to_string(),
            traversal: "branch_following",
            policy: "always_first",
            linear_fallback,
            terminus: "end_of_scene",
            missing_count: missing_keys.len(),
            missing_keys,
            catalog_fallback_count: catalog_fallback_keys.len(),
            catalog_fallback_keys,
        }
    }

    #[test]
    fn strict_semantic_gate_writes_artifacts_before_tuple_only_failure() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let replay_path = tempdir.path().join("replay.json");
        let dispatch_path = tempdir.path().join("dispatch.json");
        fs::write(&replay_path, "{\"events\":[]}").expect("write replay artifact");
        let report = synthetic_dispatch_report(vec![(2, 3, 4)], vec![(5, 6, 7)], false);
        write_dispatch_report(&dispatch_path, &report).expect("write dispatch artifact");
        let error = require_semantic_reached_path(&report).expect_err("fallback is unavailable");
        assert!(replay_path.exists());
        assert!(dispatch_path.exists());
        let message = error.to_string();
        assert!(message.contains("missing_keys=[(2, 3, 4)]"));
        assert!(message.contains("catalog_fallback_keys=[(5, 6, 7)]"));
        assert!(!message.contains("replay.json"));
    }

    #[test]
    fn strict_semantic_gate_rejects_linear_fallback_without_missing_tuples() {
        let report = synthetic_dispatch_report(Vec::new(), Vec::new(), true);
        let error = require_semantic_reached_path(&report).expect_err("linear-only is unavailable");
        assert!(error.to_string().contains("linear_fallback=true"));
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
