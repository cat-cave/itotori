mod replay;
mod replay_validate;

use std::path::PathBuf;

use serde_json::{Value, json};
use utsushi_core::{
    RuntimeAdapterDescriptor, RuntimeAdapterRegistry, RuntimeOperation, RuntimeRequest, write_json,
};

const USAGE: &str = "usage: utsushi capabilities --output <path>\n       utsushi validate-reference-captures <corpus_manifest> --output <path>\n       utsushi replay --engine reallive --seen <PATH> --scene <N> --output <PATH> [--snapshot-output <PATH>]\n       utsushi replay-validate --engine reallive --seen <PATH> --scene <N> --expect-textline-contains <SUBSTR> [--print-textlines] [--print-replay-log <PATH>]\n       utsushi <trace|capture|smoke> <game_dir> [--adapter <name>] [--artifact-root <path>] --output <path>";
const DEFAULT_ADAPTER_NAME: &str = utsushi_fixture::FixtureRuntimeAdapter::NAME;

static FIXTURE_RUNTIME_ADAPTER: utsushi_fixture::FixtureRuntimeAdapter =
    utsushi_fixture::FixtureRuntimeAdapter;
static BROWSER_LAUNCH_ADAPTER: utsushi_fixture::BrowserLaunchAdapter =
    utsushi_fixture::BrowserLaunchAdapter::new();
static NWJS_LAUNCH_ADAPTER: utsushi_fixture::NwjsLaunchAdapter =
    utsushi_fixture::NwjsLaunchAdapter::new();

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let registry = runtime_registry();
    run_cli_with_registry(&args, &registry)
}

fn runtime_registry() -> RuntimeAdapterRegistry<'static> {
    let mut registry = RuntimeAdapterRegistry::new();
    registry
        .register(&FIXTURE_RUNTIME_ADAPTER)
        .expect("fixture runtime adapter descriptor is valid");
    registry
        .register(&BROWSER_LAUNCH_ADAPTER)
        .expect("browser launch adapter descriptor is valid");
    registry
        .register(&NWJS_LAUNCH_ADAPTER)
        .expect("NW.js capability diagnostic descriptor is valid");
    registry
}

fn run_cli_with_registry(
    args: &[String],
    registry: &RuntimeAdapterRegistry<'_>,
) -> Result<(), Box<dyn std::error::Error>> {
    match args.first().map(String::as_str) {
        Some("capabilities") => {
            validate_exact_flags(args, &[], &["--output"])?;
            let output = flag(args, "--output")?;
            write_json(&PathBuf::from(output), &capabilities_output(registry))?;
        }
        Some("validate-reference-captures") => {
            validate_exact_flags(args, &["corpus_manifest"], &["--output"])?;
            let corpus_path = PathBuf::from(args.get(1).ok_or("missing corpus_manifest")?);
            let output = flag(args, "--output")?;
            let report = utsushi_fixture::validate_reference_capture_corpus(&corpus_path)?;
            write_json(&PathBuf::from(output), &report.to_json_value()?)?;
        }
        Some("replay") => {
            // The replay subcommand owns its own flag parsing in
            // `replay::run_replay_command` because the required-flag
            // matrix differs from the trace/capture/smoke commands
            // (no positional `game_dir`, multiple required `--*`
            // flags). Skip the leading `replay` argv slot when
            // dispatching.
            let tail: Vec<String> = args.iter().skip(1).cloned().collect();
            replay::run_replay_command(&tail)?;
        }
        Some("replay-validate") => {
            // UTSUSHI-227 — sibling of `replay` that drives the same
            // pipeline and asserts an expected substring lands in at
            // least one captured TextLine body. Skips the leading
            // `replay-validate` argv slot.
            let tail: Vec<String> = args.iter().skip(1).cloned().collect();
            replay_validate::run_replay_validate_command(&tail)?;
        }
        Some(command) => {
            let operation = operation_from_command(command).ok_or(USAGE)?;
            validate_exact_flags(
                args,
                &["game_dir"],
                &["--adapter", "--artifact-root", "--output"],
            )?;
            let input_root = PathBuf::from(args.get(1).ok_or("missing game_dir")?);
            let output = flag(args, "--output")?;
            let adapter_name = selected_adapter_name(args, registry)?;
            let artifact_root = optional_flag(args, "--artifact-root").map(PathBuf::from);
            let mut request = RuntimeRequest::new(&input_root);
            if let Some(artifact_root) = artifact_root.as_deref() {
                request = request.with_artifact_root(artifact_root);
            }
            let value = registry.run(&adapter_name, operation, &request)?;
            write_json(&PathBuf::from(output), &value)?;
        }
        None => return Err(USAGE.into()),
    }
    Ok(())
}

fn operation_from_command(command: &str) -> Option<RuntimeOperation> {
    match command {
        "trace" => Some(RuntimeOperation::Trace),
        "capture" => Some(RuntimeOperation::Capture),
        "smoke" => Some(RuntimeOperation::SmokeValidation),
        _ => None,
    }
}

fn selected_adapter_name(
    args: &[String],
    registry: &RuntimeAdapterRegistry<'_>,
) -> Result<String, Box<dyn std::error::Error>> {
    if let Some(adapter_name) = optional_flag(args, "--adapter") {
        return Ok(adapter_name.to_string());
    }

    let descriptors = registry.descriptors();
    match descriptors.as_slice() {
        [descriptor] => Ok(descriptor.name.clone()),
        [] => Err("no runtime adapters registered".into()),
        _ if descriptors
            .iter()
            .any(|descriptor| descriptor.name == DEFAULT_ADAPTER_NAME) =>
        {
            Ok(DEFAULT_ADAPTER_NAME.to_string())
        }
        _ => Err("multiple runtime adapters registered; pass --adapter <name>".into()),
    }
}

fn capabilities_output(registry: &RuntimeAdapterRegistry<'_>) -> Value {
    let runtime_adapters = registry
        .descriptors()
        .into_iter()
        .map(descriptor_output)
        .collect::<Vec<_>>();
    json!({
        "schemaVersion": "0.1.0",
        "runtimeAdapters": runtime_adapters
    })
}

fn descriptor_output(descriptor: RuntimeAdapterDescriptor) -> Value {
    let runtime_capabilities = descriptor.capability_contract.to_json();
    json!({
        "adapterName": descriptor.name,
        "adapterVersion": descriptor.version,
        "fidelityTier": descriptor.fidelity_tier.as_str(),
        "evidenceTierCeiling": descriptor.evidence_tier_ceiling.as_str(),
        "runtimeCapabilities": runtime_capabilities,
        "capabilities": descriptor
            .capabilities
            .into_iter()
            .map(|capability| capability.as_str())
            .collect::<Vec<_>>(),
        "approximationTiers": descriptor
            .approximation_tiers
            .into_iter()
            .map(|approximation_tier| approximation_tier.as_str())
            .collect::<Vec<_>>(),
        "diagnostics": descriptor
            .diagnostics
            .into_iter()
            .map(|diagnostic| diagnostic.to_json())
            .collect::<Vec<_>>(),
        "limitations": descriptor.limitations
    })
}

fn flag<'a>(args: &'a [String], name: &str) -> Result<&'a str, Box<dyn std::error::Error>> {
    optional_flag(args, name).ok_or_else(|| format!("missing flag {name}").into())
}

fn optional_flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|index| args.get(index + 1))
        .map(String::as_str)
}

fn validate_exact_flags(
    args: &[String],
    positional_labels: &[&str],
    allowed_flags: &[&str],
) -> Result<(), Box<dyn std::error::Error>> {
    let expected_positionals = 1 + positional_labels.len();
    if args.len() < expected_positionals {
        let missing = positional_labels[args.len().saturating_sub(1)];
        return Err(format!("missing {missing}; {USAGE}").into());
    }
    for index in 1..expected_positionals {
        if args[index].starts_with("--") {
            return Err(format!("missing {}; {USAGE}", positional_labels[index - 1]).into());
        }
    }

    let mut seen_flags = std::collections::HashSet::new();
    let mut index = expected_positionals;
    while index < args.len() {
        let flag = args[index].as_str();
        if !flag.starts_with("--") {
            return Err(format!("unexpected argument {flag}; {USAGE}").into());
        }
        if !allowed_flags.contains(&flag) {
            return Err(format!("unknown flag {flag}; {USAGE}").into());
        }
        if !seen_flags.insert(flag) {
            return Err(format!("duplicate flag {flag}; {USAGE}").into());
        }
        let Some(value) = args.get(index + 1) else {
            return Err(format!("missing value for flag {flag}; {USAGE}").into());
        };
        if value.starts_with("--") {
            return Err(format!("missing value for flag {flag}; {USAGE}").into());
        }
        index += 2;
    }

    for required_flag in allowed_flags.iter().filter(|flag| **flag == "--output") {
        if !seen_flags.contains(required_flag) {
            return Err(format!("missing flag {required_flag}; {USAGE}").into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::rc::Rc;
    use std::time::{SystemTime, UNIX_EPOCH};
    use utsushi_core::{
        ApproximationTier, EvidenceTier, FidelityTier, RuntimeAdapter, RuntimeCapability,
        RuntimeCapabilityClass, RuntimeCapabilityContract, RuntimeFeatureSupport,
        RuntimePlaybackFeature, UtsushiResult,
    };

    const TEST_ADAPTER_NAME: &str = "test-runtime";

    struct RecordingRuntimeAdapter {
        calls: Rc<RefCell<Vec<&'static str>>>,
    }

    impl RecordingRuntimeAdapter {
        fn new(calls: Rc<RefCell<Vec<&'static str>>>) -> Self {
            Self { calls }
        }

        fn report(
            &self,
            operation: &'static str,
            request: &RuntimeRequest<'_>,
        ) -> UtsushiResult<Value> {
            self.calls.borrow_mut().push(operation);
            Ok(json!({
                "adapterName": TEST_ADAPTER_NAME,
                "operation": operation,
                "inputRoot": request.input_root.display().to_string(),
                "artifactRoot": request.artifact_root.map(|path| path.display().to_string())
            }))
        }
    }

    impl RuntimeAdapter for RecordingRuntimeAdapter {
        fn descriptor(&self) -> RuntimeAdapterDescriptor {
            RuntimeAdapterDescriptor {
                name: TEST_ADAPTER_NAME.to_string(),
                version: "0.0.0-test".to_string(),
                fidelity_tier: FidelityTier::LayoutProbe,
                evidence_tier_ceiling: EvidenceTier::E2,
                capability_contract: test_capability_contract(),
                capabilities: vec![
                    RuntimeCapability::Trace,
                    RuntimeCapability::FrameCapture,
                    RuntimeCapability::SmokeValidation,
                ],
                approximation_tiers: vec![ApproximationTier::DeterministicFixture],
                diagnostics: vec![],
                limitations: vec!["test runtime adapter".to_string()],
            }
        }

        fn trace(&self, request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
            self.report("trace", request)
        }

        fn capture(&self, request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
            self.report("capture", request)
        }

        fn smoke_validate(&self, request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
            self.report("smoke", request)
        }
    }

    fn test_capability_contract() -> RuntimeCapabilityContract {
        RuntimeCapabilityContract::new(
            RuntimeCapabilityClass::LaunchCapture,
            FidelityTier::LayoutProbe,
            EvidenceTier::E2,
            vec![
                RuntimeFeatureSupport::supported(
                    RuntimePlaybackFeature::StaticTrace,
                    EvidenceTier::E1,
                    "Records test runtime trace dispatches.",
                ),
                RuntimeFeatureSupport::supported(
                    RuntimePlaybackFeature::TextTrace,
                    EvidenceTier::E1,
                    "Records test runtime smoke validation dispatches.",
                ),
                RuntimeFeatureSupport::partial(
                    RuntimePlaybackFeature::FrameCapture,
                    EvidenceTier::E2,
                    "Records test runtime capture dispatches without producing live engine frames.",
                    vec![
                        "Frame capture is a CLI dispatch test report, not a screenshot."
                            .to_string(),
                    ],
                ),
                RuntimeFeatureSupport::unsupported(
                    RuntimePlaybackFeature::BranchDiscovery,
                    "Branch discovery is outside the CLI dispatch test adapter contract.",
                ),
                RuntimeFeatureSupport::unsupported(
                    RuntimePlaybackFeature::Jump,
                    "Controlled jumps are outside the CLI dispatch test adapter contract.",
                ),
                RuntimeFeatureSupport::unsupported(
                    RuntimePlaybackFeature::Snapshot,
                    "Snapshot save and restore are outside the CLI dispatch test adapter contract.",
                ),
                RuntimeFeatureSupport::unsupported(
                    RuntimePlaybackFeature::Screenshot,
                    "Live screenshots are outside the CLI dispatch test adapter contract.",
                ),
                RuntimeFeatureSupport::unsupported(
                    RuntimePlaybackFeature::Recording,
                    "Playback recording is outside the CLI dispatch test adapter contract.",
                ),
                RuntimeFeatureSupport::unsupported(
                    RuntimePlaybackFeature::InstrumentationHooks,
                    "Instrumentation hooks are outside the CLI dispatch test adapter contract.",
                ),
                RuntimeFeatureSupport::unsupported(
                    RuntimePlaybackFeature::VmStateInspection,
                    "VM state inspection is outside the CLI dispatch test adapter contract.",
                ),
                RuntimeFeatureSupport::unsupported(
                    RuntimePlaybackFeature::ReferenceComparison,
                    "Reference comparison is outside the CLI dispatch test adapter contract.",
                ),
            ],
            vec!["Test runtime adapter for CLI dispatch coverage only.".to_string()],
        )
    }

    fn temp_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("utsushi-cli-{name}-{}-{nonce}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn registry_with<'a>(adapter: &'a dyn RuntimeAdapter) -> RuntimeAdapterRegistry<'a> {
        let mut registry = RuntimeAdapterRegistry::new();
        registry.register(adapter).unwrap();
        registry
    }

    fn empty_registry() -> RuntimeAdapterRegistry<'static> {
        RuntimeAdapterRegistry::new()
    }

    fn args(values: &[&Path]) -> Vec<String> {
        values
            .iter()
            .map(|value| value.display().to_string())
            .collect()
    }

    fn write_fixture_source(game_dir: &Path) {
        fs::create_dir_all(game_dir).unwrap();
        fs::write(
            game_dir.join("source.json"),
            r#"{
  "gameId": "cli-smoke-fixture",
  "title": "CLI Smoke Fixture",
  "sourceLocale": "ja-JP",
  "units": [
    {
      "sourceUnitKey": "cli.smoke.001",
      "speaker": "Narrator",
      "textSurface": "dialogue",
      "sourceText": "確認。",
      "targetText": "Confirmed.",
      "protectedSpans": []
    }
  ]
}
"#,
        )
        .unwrap();
    }

    #[test]
    fn capabilities_command_reports_registered_adapter_metadata() {
        let root = temp_dir("capabilities");
        let calls = Rc::new(RefCell::new(Vec::new()));
        let adapter = RecordingRuntimeAdapter::new(calls);
        let registry = registry_with(&adapter);
        let output = root.join("capabilities.json");

        run_cli_with_registry(
            &[
                "capabilities".to_string(),
                "--output".to_string(),
                output.display().to_string(),
            ],
            &registry,
        )
        .unwrap();

        let report: Value = serde_json::from_str(&fs::read_to_string(&output).unwrap()).unwrap();
        assert_eq!(report["schemaVersion"], "0.1.0");
        assert_eq!(
            report["runtimeAdapters"][0]["adapterName"],
            TEST_ADAPTER_NAME
        );
        assert_eq!(report["runtimeAdapters"][0]["fidelityTier"], "layout_probe");
        assert_eq!(report["runtimeAdapters"][0]["evidenceTierCeiling"], "E2");
        assert_eq!(
            report["runtimeAdapters"][0]["approximationTiers"][0],
            "deterministic_fixture"
        );
        assert!(
            report["runtimeAdapters"][0]["capabilities"]
                .as_array()
                .unwrap()
                .iter()
                .any(|capability| capability == "frame_capture")
        );
        assert_eq!(
            report["runtimeAdapters"][0]["diagnostics"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn capabilities_command_reports_browser_required_diagnostic_at_error_severity() {
        let root = temp_dir("browser-host-diagnostic");
        let private_missing_browser = root.join("private-browser-bin");
        let adapter = utsushi_fixture::BrowserLaunchAdapter::with_browser_program(
            private_missing_browser.clone(),
        );
        let registry = registry_with(&adapter);
        let output = root.join("capabilities.json");

        run_cli_with_registry(
            &[
                "capabilities".to_string(),
                "--output".to_string(),
                output.display().to_string(),
            ],
            &registry,
        )
        .unwrap();

        let report: Value = serde_json::from_str(&fs::read_to_string(&output).unwrap()).unwrap();
        let adapter_report = &report["runtimeAdapters"][0];
        assert_eq!(
            adapter_report["adapterName"],
            utsushi_fixture::BrowserLaunchAdapter::NAME
        );
        assert!(
            adapter_report["capabilities"]
                .as_array()
                .unwrap()
                .iter()
                .any(|capability| capability == "frame_capture")
        );
        let diagnostic = adapter_report["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .find(|diagnostic| diagnostic["diagnosticKind"] == "browser_host_availability")
            .unwrap();
        assert_eq!(diagnostic["status"], "unavailable");
        assert_eq!(diagnostic["severity"], "error");
        assert_eq!(diagnostic["details"]["hostAvailable"], false);
        assert_eq!(
            diagnostic["details"]["browserSource"],
            "configured_unavailable"
        );
        assert_eq!(
            diagnostic["details"]["requiredFor"],
            json!(["trace", "capture", "smoke_validation"])
        );
        assert_eq!(
            diagnostic["details"]["errorCode"],
            "utsushi.browser.chromium_unavailable"
        );
        assert_eq!(diagnostic["details"]["capability"], "browser_launch");
        let report_string = serde_json::to_string(&report).unwrap();
        assert!(!report_string.contains(root.to_string_lossy().as_ref()));
        assert!(!report_string.contains(private_missing_browser.to_string_lossy().as_ref()));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn capabilities_command_reports_nwjs_as_research_tier() {
        let root = temp_dir("nwjs-research-tier");
        let adapter = utsushi_fixture::NwjsLaunchAdapter::new();
        let registry = registry_with(&adapter);
        let output = root.join("capabilities.json");

        run_cli_with_registry(
            &[
                "capabilities".to_string(),
                "--output".to_string(),
                output.display().to_string(),
            ],
            &registry,
        )
        .unwrap();

        let report: Value = serde_json::from_str(&fs::read_to_string(&output).unwrap()).unwrap();
        let adapter_report = &report["runtimeAdapters"][0];
        assert_eq!(
            adapter_report["adapterName"],
            utsushi_fixture::NwjsLaunchAdapter::NAME
        );
        assert_eq!(adapter_report["capabilities"].as_array().unwrap().len(), 0);
        let diagnostic = adapter_report["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .find(|diagnostic| diagnostic["diagnosticKind"] == "research_tier_status")
            .expect("research_tier_status diagnostic is required");
        assert_eq!(diagnostic["status"], "unsupported");
        assert_eq!(diagnostic["severity"], "info");
        assert_eq!(
            diagnostic["details"]["errorCode"],
            "utsushi.runtime.research_tier_unsupported"
        );
        assert_eq!(diagnostic["details"]["runtimeTier"], "research");
        assert_eq!(diagnostic["details"]["capability"], "browser_launch");
        assert_eq!(
            diagnostic["details"]["supersededBy"],
            utsushi_fixture::BrowserLaunchAdapter::NAME
        );
        let first_limitation = adapter_report["limitations"]
            .as_array()
            .unwrap()
            .first()
            .and_then(Value::as_str)
            .unwrap();
        assert!(
            first_limitation.contains("research-tier"),
            "first limitation must mark research-tier: {first_limitation}",
        );
        assert!(
            first_limitation.contains("not advertised as an alpha capability"),
            "first limitation must call out alpha exclusion: {first_limitation}",
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn capabilities_command_keeps_paths_redacted_in_all_new_diagnostics() {
        // Parameterized over (broken UTSUSHI_BROWSER_BIN-equivalent
        // configured path, broken configured path, NW.js research-tier).
        // Each path-sensitive scenario must produce a capability JSON whose
        // serialized representation does not contain the operator-private
        // temp-dir prefix.
        for scenario in ["browser-broken-configured", "nwjs-research"] {
            let root = temp_dir(scenario);
            let output = root.join("capabilities.json");
            let private_path = root.join("private-browser-bin");
            let report: Value = match scenario {
                "browser-broken-configured" => {
                    let adapter = utsushi_fixture::BrowserLaunchAdapter::with_browser_program(
                        private_path.clone(),
                    );
                    let registry = registry_with(&adapter);
                    run_cli_with_registry(
                        &[
                            "capabilities".to_string(),
                            "--output".to_string(),
                            output.display().to_string(),
                        ],
                        &registry,
                    )
                    .unwrap();
                    serde_json::from_str(&fs::read_to_string(&output).unwrap()).unwrap()
                }
                "nwjs-research" => {
                    let adapter = utsushi_fixture::NwjsLaunchAdapter::new();
                    let registry = registry_with(&adapter);
                    run_cli_with_registry(
                        &[
                            "capabilities".to_string(),
                            "--output".to_string(),
                            output.display().to_string(),
                        ],
                        &registry,
                    )
                    .unwrap();
                    serde_json::from_str(&fs::read_to_string(&output).unwrap()).unwrap()
                }
                _ => unreachable!(),
            };
            let report_string = serde_json::to_string(&report).unwrap();
            assert!(
                !report_string.contains(root.to_string_lossy().as_ref()),
                "scenario {scenario} leaked temp-dir prefix into capability JSON",
            );
            assert!(
                !report_string.contains(private_path.to_string_lossy().as_ref()),
                "scenario {scenario} leaked private adapter path into capability JSON",
            );
            let _ = fs::remove_dir_all(root);
        }
    }

    #[test]
    fn runtime_commands_dispatch_through_supplied_registry() {
        let root = temp_dir("dispatch");
        let game_dir = root.join("game");
        fs::create_dir_all(&game_dir).unwrap();
        let calls = Rc::new(RefCell::new(Vec::new()));
        let adapter = RecordingRuntimeAdapter::new(Rc::clone(&calls));
        let registry = registry_with(&adapter);
        let output = root.join("capture.json");

        run_cli_with_registry(
            &[
                "capture".to_string(),
                game_dir.display().to_string(),
                "--adapter".to_string(),
                TEST_ADAPTER_NAME.to_string(),
                "--output".to_string(),
                output.display().to_string(),
            ],
            &registry,
        )
        .unwrap();

        let report: Value = serde_json::from_str(&fs::read_to_string(&output).unwrap()).unwrap();
        assert_eq!(report["adapterName"], TEST_ADAPTER_NAME);
        assert_eq!(report["operation"], "capture");
        assert_eq!(
            report["inputRoot"],
            game_dir.as_path().display().to_string()
        );
        assert!(report["artifactRoot"].is_null());
        assert_eq!(&*calls.borrow(), &["capture"]);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn runtime_commands_default_to_single_registered_adapter() {
        let root = temp_dir("single-adapter");
        let game_dir = root.join("game");
        fs::create_dir_all(&game_dir).unwrap();
        let calls = Rc::new(RefCell::new(Vec::new()));
        let adapter = RecordingRuntimeAdapter::new(Rc::clone(&calls));
        let registry = registry_with(&adapter);
        let output = root.join("smoke.json");

        run_cli_with_registry(
            &args(&[
                Path::new("smoke"),
                game_dir.as_path(),
                Path::new("--output"),
                output.as_path(),
            ]),
            &registry,
        )
        .unwrap();

        let report: Value = serde_json::from_str(&fs::read_to_string(&output).unwrap()).unwrap();
        assert_eq!(report["adapterName"], TEST_ADAPTER_NAME);
        assert_eq!(report["operation"], "smoke");
        assert_eq!(&*calls.borrow(), &["smoke"]);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn smoke_command_defaults_to_fixture_adapter_from_cli_runtime_registry() {
        let root = temp_dir("fixture-smoke-output");
        let game_dir = root.join("game");
        write_fixture_source(&game_dir);
        let output = root.join("smoke.json");
        let registry = runtime_registry();

        run_cli_with_registry(
            &args(&[
                Path::new("smoke"),
                game_dir.as_path(),
                Path::new("--output"),
                output.as_path(),
            ]),
            &registry,
        )
        .unwrap();

        let report: Value = serde_json::from_str(&fs::read_to_string(&output).unwrap()).unwrap();
        assert_eq!(
            report["adapterName"],
            utsushi_fixture::FixtureRuntimeAdapter::NAME
        );
        assert_eq!(report["observationHookEvents"].as_array().unwrap().len(), 2);
        assert!(
            report["runtimeCapabilities"]["features"]
                .as_array()
                .unwrap()
                .iter()
                .any(|feature| {
                    feature["feature"] == "instrumentation_hooks"
                        && feature["status"] == "partial"
                        && feature["evidenceTierCeiling"] == "E2"
                })
        );
        assert!(
            report["controlledPlaybackSession"]["featuresUsed"]
                .as_array()
                .unwrap()
                .iter()
                .any(|feature| feature == "instrumentation_hooks")
        );
        assert_eq!(report["observationHookEvents"][0]["eventKind"], "text");
        assert_eq!(
            report["observationHookEvents"][0]["schemaVersion"],
            utsushi_fixture::FIXTURE_OBSERVATION_HOOK_SCHEMA_LITERAL
        );
        assert_eq!(report["observationHookEvents"][1]["eventKind"], "frame");
        assert!(output.is_file());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn runtime_commands_reject_unknown_adapter_from_cli_runtime_registry() {
        let root = temp_dir("unknown-adapter");
        let game_dir = root.join("game");
        fs::create_dir_all(&game_dir).unwrap();
        let output = root.join("trace.json");
        let registry = runtime_registry();

        let error = run_cli_with_registry(
            &args(&[
                Path::new("trace"),
                game_dir.as_path(),
                Path::new("--adapter"),
                Path::new("missing-runtime"),
                Path::new("--output"),
                output.as_path(),
            ]),
            &registry,
        )
        .unwrap_err()
        .to_string();

        assert!(error.contains("runtime adapter not registered: missing-runtime"));
        assert!(!output.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn runtime_commands_pass_optional_artifact_root_to_adapter() {
        let root = temp_dir("artifact-root");
        let game_dir = root.join("game");
        let artifact_root = root.join("runtime-artifacts");
        fs::create_dir_all(&game_dir).unwrap();
        let calls = Rc::new(RefCell::new(Vec::new()));
        let adapter = RecordingRuntimeAdapter::new(Rc::clone(&calls));
        let registry = registry_with(&adapter);
        let output = root.join("capture.json");

        run_cli_with_registry(
            &args(&[
                Path::new("capture"),
                game_dir.as_path(),
                Path::new("--adapter"),
                Path::new(TEST_ADAPTER_NAME),
                Path::new("--artifact-root"),
                artifact_root.as_path(),
                Path::new("--output"),
                output.as_path(),
            ]),
            &registry,
        )
        .unwrap();

        let report: Value = serde_json::from_str(&fs::read_to_string(&output).unwrap()).unwrap();
        assert_eq!(
            report["artifactRoot"],
            artifact_root.as_path().display().to_string()
        );
        assert_eq!(&*calls.borrow(), &["capture"]);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn validate_reference_captures_command_writes_validation_report() {
        let root = temp_dir("reference-capture-validation");
        let output = root.join("validation-report.json");
        let corpus_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/public/utsushi-reference-captures/reference-capture-corpus.json");
        let registry = empty_registry();

        run_cli_with_registry(
            &args(&[
                Path::new("validate-reference-captures"),
                corpus_path.as_path(),
                Path::new("--output"),
                output.as_path(),
            ]),
            &registry,
        )
        .unwrap();

        let report: Value = serde_json::from_str(&fs::read_to_string(&output).unwrap()).unwrap();
        assert_eq!(report["schemaVersion"], "0.1.0");
        assert_eq!(report["fixturesValidated"], 1);
        assert_eq!(report["artifactsValidated"], 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn validate_reference_captures_rejects_unknown_and_trailing_args() {
        let corpus_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/public/utsushi-reference-captures/reference-capture-corpus.json");
        let output = PathBuf::from("validation-report.json");
        let registry = empty_registry();

        let unknown = run_cli_with_registry(
            &args(&[
                Path::new("validate-reference-captures"),
                corpus_path.as_path(),
                Path::new("--bogus"),
                output.as_path(),
                Path::new("--output"),
                output.as_path(),
            ]),
            &registry,
        )
        .unwrap_err()
        .to_string();
        assert!(unknown.contains("unknown flag --bogus"));

        let trailing = run_cli_with_registry(
            &args(&[
                Path::new("validate-reference-captures"),
                corpus_path.as_path(),
                Path::new("extra"),
                Path::new("--output"),
                output.as_path(),
            ]),
            &registry,
        )
        .unwrap_err()
        .to_string();
        assert!(trailing.contains("unexpected argument extra"));
    }
}
