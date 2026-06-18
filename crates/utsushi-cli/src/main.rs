use std::path::PathBuf;

use serde_json::{Value, json};
use utsushi_core::{
    RuntimeAdapterDescriptor, RuntimeAdapterRegistry, RuntimeOperation, RuntimeRequest, write_json,
};

const USAGE: &str = "usage: utsushi capabilities --output <path>\n       utsushi <trace|capture|smoke> <game_dir> [--adapter <name>] [--artifact-root <path>] --output <path>";
const DEFAULT_ADAPTER_NAME: &str = utsushi_fixture::FixtureRuntimeAdapter::NAME;

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let registry = utsushi_fixture::registry();
    run_cli_with_registry(&args, &registry)
}

fn run_cli_with_registry(
    args: &[String],
    registry: &RuntimeAdapterRegistry<'_>,
) -> Result<(), Box<dyn std::error::Error>> {
    match args.first().map(String::as_str) {
        Some("capabilities") => {
            let output = flag(args, "--output")?;
            write_json(&PathBuf::from(output), &capabilities_output(registry))?;
        }
        Some(command) => {
            let operation = operation_from_command(command).ok_or(USAGE)?;
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

    fn args(values: &[&Path]) -> Vec<String> {
        values
            .iter()
            .map(|value| value.display().to_string())
            .collect()
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
        let _ = fs::remove_dir_all(root);
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
}
