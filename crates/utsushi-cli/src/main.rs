mod coverage_export;
mod mvmz_patched_runtime_proof;
mod mvmz_runtime_proof;
mod patch_render;
mod render_validate;
mod replay;
mod replay_registry;
mod replay_validate;
mod rpgmaker_mv_capture;
mod staged_replay;
mod structure;
mod trace_kag;

use std::path::PathBuf;
use std::sync::OnceLock;

use serde_json::{Value, json};
use utsushi_core::{
    RuntimeAdapterDescriptor, RuntimeAdapterRegistry, RuntimeOperation, RuntimeRequest, write_json,
};

const USAGE: &str = "usage: utsushi capabilities --output <path>\n       utsushi validate-reference-captures <corpus_manifest> --output <path>\n       utsushi replay --engine reallive --seen <PATH> --scene <N> --output <PATH> [--snapshot-output <PATH>]\n       utsushi replay-validate --engine reallive --seen <PATH> --scene <N> --print-replay-log <PATH> [--print-textlines]\n       utsushi render-validate --engine reallive --seen <PATH> --scene <N> --artifact-root <DIR> [--run-id <ID>] [--expect-text-contains <SUBSTR>] [--message-index <N>] [--width <N>] [--height <N>] [--output <PATH>]\n       utsushi structure --gameexe <PATH> --seen <PATH> --output <PATH> [--entry-scene <N>] [--max-scenes <N>]\n       utsushi patch-render --engine reallive --seen <PATH> --translated-bundle <PATH> --scene <N> --gameexe <PATH> --game-dir <DIR> --patched-seen-output <PATH> --artifact-root <DIR> [--scope dialogue|dialogue+choices] [--redaction on|off] [--bg-asset <STEM>] [--expect-text-contains <SUBSTR>] [--output <PATH>]\n       utsushi rpgmaker-mv-capture --game-dir <DIR> --artifact-root <DIR> --output <PATH> [--run-id <ID>] [--assert-observed-text <TEXT>]\n       utsushi review-package --patch-export <PATH> --runtime-evidence <PATH> [--replay-pack <PATH>] [--no-browser] [--no-screenshot] --output <PATH>\n       utsushi trace-kag <script.ks> --output <PATH>\n       utsushi coverage-export --read-model <PATH> --generated-at <RFC3339> --output <PATH> [--markdown-output <PATH>] [--include-gap-findings]\n       utsushi mvmz-runtime-proof --runtime-trace <PATH> --fixture-dir <DIR> [--screenshot-evidence <PATH>] --output <PATH>\n       utsushi mvmz-patched-runtime-proof --patched-runtime-trace <PATH> --patched-fixture-dir <DIR> --patch-result <PATH> --alpha-proof <PATH> [--screenshot-evidence <PATH>] --output <PATH>\n       utsushi <trace|capture|smoke> <game_dir> [--adapter <name>] [--artifact-root <path>] --output <path>";
const DEFAULT_ADAPTER_NAME: &str = utsushi_fixture::FixtureRuntimeAdapter::NAME;

static FIXTURE_RUNTIME_ADAPTER: OnceLock<utsushi_fixture::FixtureRuntimeAdapter> = OnceLock::new();
static BROWSER_LAUNCH_ADAPTER: utsushi_fixture::BrowserLaunchAdapter =
    utsushi_fixture::BrowserLaunchAdapter::new();
static NWJS_LAUNCH_ADAPTER: utsushi_fixture::NwjsLaunchAdapter =
    utsushi_fixture::NwjsLaunchAdapter::new();
static REALLIVE_REPLAY_ADAPTER: replay_registry::RealLiveReplayAdapter =
    replay_registry::RealLiveReplayAdapter::new();

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
        .register(FIXTURE_RUNTIME_ADAPTER.get_or_init(utsushi_fixture::FixtureRuntimeAdapter::new))
        .expect("fixture runtime adapter descriptor is valid");
    registry
        .register(&BROWSER_LAUNCH_ADAPTER)
        .expect("browser launch adapter descriptor is valid");
    registry
        .register(&NWJS_LAUNCH_ADAPTER)
        .expect("NW.js capability diagnostic descriptor is valid");
    registry
        .register(&REALLIVE_REPLAY_ADAPTER)
        .expect("RealLive replay adapter descriptor is valid");
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
            replay::run_replay_command(&tail, registry)?;
        }
        Some("replay-validate") => {
            // UTSUSHI-227 — sibling of `replay` that drives the same
            // pipeline and asserts an expected substring lands in at
            // least one captured TextLine body. Skips the leading
            // `replay-validate` argv slot.
            let tail: Vec<String> = args.iter().skip(1).cloned().collect();
            replay_validate::run_replay_validate_command(&tail, registry)?;
        }
        Some("render-validate") => {
            // ALPHA-006b — rasterized localized screenshot through the
            // substrate frame sink at E2. The rasterized successor to
            // the text-only `replay-validate` capture surface.
            let tail: Vec<String> = args.iter().skip(1).cloned().collect();
            render_validate::run_render_validate_command(&tail)?;
        }
        Some("structure") => {
            // Narrative-structure exporter — the UTSUSHI-side producer of the
            // `utsushi.narrative-structure.v1` artifact the itotori whole-game
            // localize driver consumes. Deriving the real scene-dispatch order +
            // per-scene play-order streams needs the replay runtime (utsushi's
            // job); `kaifuu extract --whole-seen` produces the BRIDGE, this
            // produces the STRUCTURE, and the driver consumes them separately.
            // Owns its own flag parsing; skips the leading `structure` argv slot.
            let tail: Vec<String> = args.iter().skip(1).cloned().collect();
            structure::run_structure_command(&tail)?;
        }
        Some("patch-render") => {
            // kaifuu-utsushi-patch-to-render-path — the COMPOSED command:
            // Kaifuu patchback (translated script -> patched Seen.txt) chained
            // into Utsushi render-validate (patched scene -> redacted localized
            // PNG + JSON evidence), config-parameterized for any RealLive
            // project. Owns its own flag parsing; skips the leading
            // `patch-render` argv slot.
            let tail: Vec<String> = args.iter().skip(1).cloned().collect();
            patch_render::run_patch_render_command(&tail)?;
        }
        Some("rpgmaker-mv-capture") => {
            // RPG Maker MV/MZ vertical-slice runtime evidence: drives the
            // `utsushi-rpgmaker-mv` E1 text-per-tick port through the
            // runner against a (patched) extracted game directory and
            // asserts the localized substring lands in the text trace.
            // Skips the leading `rpgmaker-mv-capture` argv slot.
            let tail: Vec<String> = args.iter().skip(1).cloned().collect();
            rpgmaker_mv_capture::run_rpgmaker_mv_capture_command(&tail)?;
        }
        Some("mvmz-runtime-proof") => {
            // UTSUSHI-102 — the load-bearing MV/MZ launched-runtime observation
            // proof. CONSUMES the UTSUSHI-006 browser trace-probe output (an
            // actual launched Chromium `--dump-dom`) + the static fixture source
            // + optional UTSUSHI-065 screenshot evidence, and emits a strict
            // E1-vs-static proof verdict. Exits non-zero when the trace could
            // not satisfy E1. Owns its own flag parsing; skips the leading
            // `mvmz-runtime-proof` argv slot.
            let tail: Vec<String> = args.iter().skip(1).cloned().collect();
            mvmz_runtime_proof::run_mvmz_runtime_proof_command(&tail)?;
        }
        Some("mvmz-patched-runtime-proof") => {
            // UTSUSHI-119 — the CAPSTONE MV/MZ PATCHED-output launched-runtime
            // observation proof. CONSUMES the UTSUSHI-006 trace over the PATCHED
            // fixture (real launched Chromium `--dump-dom` of the game AFTER a
            // Kaifuu patch-back), the Kaifuu PatchResult (attests the patched
            // output by hash), and the UTSUSHI-102 alpha proof, and emits a
            // strict verdict that the observed runtime text is the TRANSLATION
            // the PatchResult attests to — not the pre-patch original. Exits
            // non-zero when the trace could not satisfy the patched E1 proof.
            // Owns its own flag parsing; skips the leading argv slot.
            let tail: Vec<String> = args.iter().skip(1).cloned().collect();
            mvmz_patched_runtime_proof::run_mvmz_patched_runtime_proof_command(&tail)?;
        }
        Some("review-package") => {
            // UTSUSHI-010 — the MV/MZ alpha-proof CAPSTONE: aggregate the
            // merged proof surfaces (KAIFUU patch artifact, UTSUSHI-006 +
            // UTSUSHI-033 runtime trace evidence, UTSUSHI-065 screenshot
            // artifact refs) into one reviewer-facing evidence manifest. Owns
            // its own flag parsing because it carries boolean host-capability
            // flags (`--no-browser` / `--no-screenshot`) that the value-flag
            // `validate_exact_flags` matrix cannot express. Skips the leading
            // `review-package` argv slot.
            let tail: Vec<String> = args.iter().skip(1).cloned().collect();
            run_review_package_command(&tail)?;
        }
        Some("coverage-export") => {
            // UTSUSHI-070 — export the UTSUSHI-009 branch-coverage read model +
            // UTSUSHI-069 gap summaries as a STABLE JSON + Markdown artifact for
            // alpha reports + offline review. Takes an INJECTED `--generated-at`
            // (never a clock read) so the outputs are deterministic and
            // snapshot-testable. DATA-ONLY: launches no runtime host. Owns its
            // own flag parsing; skips the leading `coverage-export` argv slot.
            let tail: Vec<String> = args.iter().skip(1).cloned().collect();
            coverage_export::run_coverage_export_command(&tail)?;
        }
        Some("trace-kag") => {
            // UTSUSHI-008 — KAG command-trace probe for plaintext /
            // already-extracted KiriKiri/KAG `.ks` scripts. Owns its own flag
            // parsing (single positional script path + `--output`). Skips the
            // leading `trace-kag` argv slot. Plaintext ONLY — never opens or
            // decrypts a packed/encrypted XP3 archive.
            let tail: Vec<String> = args.iter().skip(1).cloned().collect();
            trace_kag::run_trace_kag_command(&tail)?;
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
            let artifact_root = if let Some(path) = optional_flag(args, "--artifact-root") {
                Some(PathBuf::from(path))
            } else if matches!(
                operation,
                RuntimeOperation::Capture | RuntimeOperation::SmokeValidation
            ) && adapter_name == DEFAULT_ADAPTER_NAME
            {
                Some(PathBuf::from(output).with_extension("artifacts"))
            } else {
                None
            };
            let mut request = RuntimeRequest::new(&input_root);
            if let Some(artifact_root) = artifact_root.as_deref() {
                request = request.with_artifact_root(artifact_root);
            }
            match registry.run(&adapter_name, operation, &request) {
                Ok(value) => write_json(&PathBuf::from(output), &value)?,
                Err(error) => {
                    // A NON-fixture input is refused with a typed
                    // `utsushi.unsupported_input_shape` diagnostic. Emit the
                    // structured diagnostic envelope as JSON on stdout, then
                    // propagate the error so the process exits non-zero (main
                    // renders the human-readable message on stderr).
                    if let Some(unsupported) =
                        error.downcast_ref::<utsushi_fixture::UnsupportedInputShape>()
                    {
                        println!(
                            "{}",
                            serde_json::to_string(&unsupported.to_diagnostic_json())?
                        );
                    }
                    return Err(error);
                }
            }
        }
        None => return Err(USAGE.into()),
    }
    Ok(())
}

/// UTSUSHI-010 review-package manifest export.
///
/// Reads the three MV/MZ proof surfaces from disk (KAIFUU patch export,
/// UTSUSHI-065 runtime evidence report, optional UTSUSHI-033 replay-pack trace)
/// and writes the aggregated review-package manifest. Host capabilities default
/// to a fully-supported alpha host; `--no-browser` / `--no-screenshot` model an
/// unsupported host so the manifest records screenshot evidence as an honest,
/// non-silent limitation + semantic diagnostic rather than omitting it.
fn run_review_package_command(tail: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    const VALUE_FLAGS: &[&str] = &[
        "--patch-export",
        "--runtime-evidence",
        "--replay-pack",
        "--output",
    ];
    const BOOL_FLAGS: &[&str] = &["--no-browser", "--no-screenshot"];

    // Strict flag validation: reject unknown flags and missing values rather
    // than silently ignoring them.
    let mut index = 0;
    while index < tail.len() {
        let arg = tail[index].as_str();
        if BOOL_FLAGS.contains(&arg) {
            index += 1;
            continue;
        }
        if VALUE_FLAGS.contains(&arg) {
            let value = tail.get(index + 1);
            if value.is_none_or(|value| value.starts_with("--")) {
                return Err(format!("missing value for flag {arg}; {USAGE}").into());
            }
            index += 2;
            continue;
        }
        return Err(format!("unexpected argument {arg}; {USAGE}").into());
    }

    let patch_export = PathBuf::from(flag(tail, "--patch-export")?);
    let runtime_evidence = PathBuf::from(flag(tail, "--runtime-evidence")?);
    let replay_pack = optional_flag(tail, "--replay-pack").map(PathBuf::from);
    let output = PathBuf::from(flag(tail, "--output")?);

    let browser_available = !tail.iter().any(|arg| arg == "--no-browser");
    // Screenshot capture requires a browser; `--no-browser` implies no
    // screenshot capture even without an explicit `--no-screenshot`.
    let screenshot_capture = browser_available && !tail.iter().any(|arg| arg == "--no-screenshot");
    let host = utsushi_fixture::mv_mz_review_package::HostCapabilities {
        browser_available,
        screenshot_capture,
    };

    let manifest = utsushi_fixture::mv_mz_review_package::mv_mz_review_package_manifest_from_paths(
        &patch_export,
        &runtime_evidence,
        replay_pack.as_deref(),
        host,
    )?;
    write_json(&output, &manifest)?;
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
            .map(utsushi_core::RuntimeCapability::as_str)
            .collect::<Vec<_>>(),
        "approximationTiers": descriptor
            .approximation_tiers
            .into_iter()
            .map(utsushi_core::ApproximationTier::as_str)
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
        assert_eq!(report["operation"], "smoke_validation");
        let observations = report["sinkObservations"].as_array().unwrap();
        assert_eq!(observations.len(), 2);
        assert_eq!(observations[0]["sink"], "text_surface");
        assert_eq!(observations[1]["sink"], "frame_artifact");
        assert_eq!(report["captures"].as_array().unwrap().len(), 1);
        let default_artifact_root = output.with_extension("artifacts");
        let artifact_uri = report["captures"][0]["artifactUri"].as_str().unwrap();
        let artifact_path = utsushi_core::RuntimeArtifactRoot::new(&default_artifact_root)
            .artifact_path(artifact_uri)
            .unwrap();
        assert!(artifact_path.is_file());
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
    fn coverage_export_command_writes_json_and_markdown() {
        let root = temp_dir("coverage-export");
        let read_model = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(
            "../utsushi-core/tests/fixtures/conformance/branch_coverage/coverage_status.json",
        );
        let json_output = root.join("export.json");
        let markdown_output = root.join("export.md");
        let registry = empty_registry();

        run_cli_with_registry(
            &args(&[
                Path::new("coverage-export"),
                Path::new("--read-model"),
                read_model.as_path(),
                Path::new("--generated-at"),
                Path::new("2026-07-05T00:00:00Z"),
                Path::new("--output"),
                json_output.as_path(),
                Path::new("--markdown-output"),
                markdown_output.as_path(),
                Path::new("--include-gap-findings"),
            ]),
            &registry,
        )
        .unwrap();

        let export: Value =
            serde_json::from_str(&fs::read_to_string(&json_output).unwrap()).unwrap();
        assert_eq!(
            export["schemaVersion"],
            "utsushi.branch_coverage_export.v0.1"
        );
        // Generated-at is the INJECTED value, not a clock read.
        assert_eq!(export["generatedAt"], "2026-07-05T00:00:00Z");
        assert_eq!(export["adapterId"], "utsushi-synthetic");
        // Read model rides through with branch/route/trace/status fields.
        assert_eq!(export["readModel"]["records"].as_array().unwrap().len(), 4);
        assert_eq!(export["readModel"]["summary"]["visited"], 1);
        // Gap counts always present; findings included on opt-in.
        assert_eq!(export["gaps"]["summary"]["gapCount"], 2);
        assert_eq!(export["gaps"]["findings"].as_array().unwrap().len(), 2);

        let markdown = fs::read_to_string(&markdown_output).unwrap();
        assert!(markdown.contains("# Branch Coverage Export"));
        assert!(markdown.contains("2026-07-05T00:00:00Z"));
        assert!(markdown.contains("## Gap Findings"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn coverage_export_command_rejects_malformed_generated_at() {
        let root = temp_dir("coverage-export-bad-generated-at");
        let read_model = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(
            "../utsushi-core/tests/fixtures/conformance/branch_coverage/coverage_status.json",
        );
        let json_output = root.join("export.json");
        let registry = empty_registry();

        let error = run_cli_with_registry(
            &args(&[
                Path::new("coverage-export"),
                Path::new("--read-model"),
                read_model.as_path(),
                Path::new("--generated-at"),
                Path::new(""),
                Path::new("--output"),
                json_output.as_path(),
            ]),
            &registry,
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("generated-at"));
        assert!(!json_output.exists());
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
