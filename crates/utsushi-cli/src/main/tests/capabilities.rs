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

    fn report(&self, operation: &'static str, request: &RuntimeRequest<'_>) -> Value {
        self.calls.borrow_mut().push(operation);
        json!({
            "adapterName": TEST_ADAPTER_NAME,
            "operation": operation,
            "inputRoot": request.input_root.display().to_string(),
            "artifactRoot": request.artifact_root.map(|path| path.display().to_string())
        })
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
        Ok(self.report("trace", request))
    }

    fn capture(&self, request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
        Ok(self.report("capture", request))
    }

    fn smoke_validate(&self, request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
        Ok(self.report("smoke", request))
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
                "Live screenshots are outside the CLI dispatch test adapter contract; \
                 rasterized screenshots come from the separate render-validate command, \
                 not this adapter's capture().",
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

fn registry_with(adapter: &dyn RuntimeAdapter) -> RuntimeAdapterRegistry<'_> {
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
