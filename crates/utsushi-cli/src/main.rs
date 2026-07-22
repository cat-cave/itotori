mod conform;
mod coverage_export;
mod dispatch_gate;
mod fixture_runtime;
mod flag_parse;
mod kag_plaintext_replay;
mod mvmz_patched_runtime_proof;
mod mvmz_runtime_proof;
mod patch_render;
mod patch_render_args;
mod reallive_port;
mod render_validate;
mod replay;
mod replay_cli_registry;
mod replay_registry;
mod replay_validate;
mod rpgmaker_mv_capture;
mod runtime_skip;
mod staged_replay;
mod structure;
mod trace_kag;

use std::path::PathBuf;

use fixture_runtime::runtime_registry;
use flag_parse::{flag, optional_flag, validate_exact_flags};
use serde_json::{Value, json};
use utsushi_core::{
    RuntimeAdapterDescriptor, RuntimeAdapterRegistry, RuntimeOperation, RuntimeRequest, write_json,
};
use utsushi_fixture::FixtureEnginePort;

const USAGE: &str = "usage: utsushi capabilities --output <path> [--skip-browser]\n       utsushi validate-reference-captures <corpus_manifest> --output <path>\n       utsushi replay --engine <adapter> --artifact-root <DIR> --launch-descriptor <JSON> --output <PATH>\n       utsushi replay-validate --engine <adapter> --artifact-root <DIR> --launch-descriptor <JSON> --print-replay-log <PATH> [--print-textlines] [--dispatch-report <PATH>] [--require-semantic-reached-path]\n       utsushi render-validate --engine reallive --seen <PATH> --scene <N> --artifact-root <DIR> [--run-id <ID>] [--expect-text-contains <SUBSTR>] [--message-index <N>] [--width <N>] [--height <N>] [--output <PATH>]\n       utsushi structure --gameexe <PATH> --seen <PATH> --output <PATH> [--entry-scene <N>] [--max-scenes <N>]\n       utsushi patch-render --engine reallive --seen <PATH> --translated-bundle <PATH> --scene <N> --gameexe <PATH> --game-dir <DIR> --patched-seen-output <PATH> --artifact-root <DIR> [--scope dialogue|dialogue+choices] [--redaction on|off] [--bg-asset <STEM>] [--expect-text-contains <SUBSTR>] [--output <PATH>]\n       utsushi rpgmaker-mv-capture --game-dir <DIR> --artifact-root <DIR> --output <PATH> [--run-id <ID>] [--assert-observed-text <TEXT>]\n       utsushi review-package --patch-export <PATH> --runtime-evidence <PATH> [--replay-pack <PATH>] [--no-browser] [--no-screenshot] --output <PATH>\n       utsushi trace-kag <script.ks> --output <PATH>\n       utsushi coverage-export --read-model <PATH> --generated-at <RFC3339> --output <PATH> [--markdown-output <PATH>] [--include-gap-findings]\n       utsushi mvmz-runtime-proof --runtime-trace <PATH> --fixture-dir <DIR> [--screenshot-evidence <PATH>] --output <PATH>\n       utsushi mvmz-patched-runtime-proof --patched-runtime-trace <PATH> --patched-fixture-dir <DIR> --patch-result <PATH> --alpha-proof <PATH> [--screenshot-evidence <PATH>] --output <PATH>\n       utsushi conform <game_dir> [--adapter <name>] --output <path>\n       utsushi <trace|capture|smoke> <game_dir> [--adapter <name>] [--artifact-root <path>] --output <path>\n       utsushi smoke <game_dir> --adapter <browser-adapter> --output <path> [--artifact-root <path>] [--skip-browser]";
const DEFAULT_ADAPTER_NAME: &str = FixtureEnginePort::MANIFEST.id;

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

fn run_cli_with_registry(
    args: &[String],
    registry: &RuntimeAdapterRegistry<'_>,
) -> Result<(), Box<dyn std::error::Error>> {
    match args.first().map(String::as_str) {
        Some("capabilities") => {
            validate_exact_flags(
                args,
                &[],
                &["--output"],
                &[runtime_skip::BROWSER_SKIP_FLAG],
                USAGE,
            )?;
            let output = flag(args, "--output", USAGE)?;
            let skip_browser = runtime_skip::has_flag(args, runtime_skip::BROWSER_SKIP_FLAG);
            let skipped = runtime_skip::browser_launch_adapter_names(registry);
            let report = capabilities_output(registry, skip_browser, skipped)?;
            write_json(&PathBuf::from(output), &report)?;
        }
        Some("validate-reference-captures") => {
            validate_exact_flags(args, &["corpus_manifest"], &["--output"], &[], USAGE)?;
            let corpus_path = PathBuf::from(args.get(1).ok_or("missing corpus_manifest")?);
            let output = flag(args, "--output", USAGE)?;
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
            // sibling of `replay` that drives the same
            // pipeline and asserts an expected substring lands in at
            // least one captured TextLine body. Skips the leading
            // `replay-validate` argv slot.
            let tail: Vec<String> = args.iter().skip(1).cloned().collect();
            replay_validate::run_replay_validate_command(&tail, registry)?;
        }
        Some("render-validate") => {
            // rasterized localized screenshot through the
            // substrate frame sink at E2. The rasterized successor to
            // the text-only `replay-validate` capture surface.
            let tail: Vec<String> = args.iter().skip(1).cloned().collect();
            render_validate::run_render_validate_command(&tail)?;
        }
        Some("structure") => {
            // Narrative-structure exporter — the UTSUSHI-side producer of the
            // narrative-structure artifact the itotori whole-game localize
            // driver consumes. Deriving the real scene-dispatch order and
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
            // the load-bearing MV/MZ launched-runtime observation
            // proof. CONSUMES the browser trace-probe output (an
            // actual launched Chromium `--dump-dom`) + the static fixture source
            // optional screenshot evidence, and emits a strict
            // E1-vs-static proof verdict. Exits non-zero when the trace could
            // not satisfy E1. Owns its own flag parsing; skips the leading
            // `mvmz-runtime-proof` argv slot.
            let tail: Vec<String> = args.iter().skip(1).cloned().collect();
            mvmz_runtime_proof::run_mvmz_runtime_proof_command(&tail)?;
        }
        Some("mvmz-patched-runtime-proof") => {
            // the CAPSTONE MV/MZ PATCHED-output launched-runtime
            // observation proof. CONSUMES the trace over the PATCHED
            // fixture (real launched Chromium `--dump-dom` of the game AFTER a
            // Kaifuu patch-back), the Kaifuu PatchResult (attests the patched
            // output by hash), and the alpha proof, and emits a
            // strict verdict that the observed runtime text is the TRANSLATION
            // the PatchResult attests to — not the pre-patch original. Exits
            // non-zero when the trace could not satisfy the patched E1 proof.
            // Owns its own flag parsing; skips the leading argv slot.
            let tail: Vec<String> = args.iter().skip(1).cloned().collect();
            mvmz_patched_runtime_proof::run_mvmz_patched_runtime_proof_command(&tail)?;
        }
        Some("review-package") => {
            // the MV/MZ alpha-proof CAPSTONE: aggregate the
            // merged proof surfaces (KAIFUU patch artifact,
            // runtime trace evidence, screenshot
            // artifact refs) into one reviewer-facing evidence manifest. Owns
            // its own flag parsing because it carries boolean host-capability
            // flags (`--no-browser` / `--no-screenshot`) that the value-flag
            // `validate_exact_flags` matrix cannot express. Skips the leading
            // `review-package` argv slot.
            let tail: Vec<String> = args.iter().skip(1).cloned().collect();
            run_review_package_command(&tail)?;
        }
        Some("coverage-export") => {
            // export the branch-coverage read model
            // gap summaries as a STABLE JSON + Markdown artifact for
            // alpha reports + offline review. Takes an INJECTED `--generated-at`
            // (never a clock read) so the outputs are deterministic and
            // snapshot-testable. DATA-ONLY: launches no runtime host. Owns its
            // own flag parsing; skips the leading `coverage-export` argv slot.
            let tail: Vec<String> = args.iter().skip(1).cloned().collect();
            coverage_export::run_coverage_export_command(&tail)?;
        }
        Some("conform") => {
            let tail: Vec<String> = args.iter().skip(1).cloned().collect();
            conform::run_conform_command(&tail)?;
        }
        Some("trace-kag") => {
            let tail: Vec<String> = args.iter().skip(1).cloned().collect();
            trace_kag::run_trace_kag_command(&tail)?;
        }
        Some("run") => {
            let tail: Vec<String> = args.iter().skip(1).cloned().collect();
            kag_plaintext_replay::run_kag_plaintext_replay_command(&tail)?;
        }
        Some(command) => {
            let operation = operation_from_command(command).ok_or(USAGE)?;
            let bool_flags = runtime_skip::browser_skip_flag_for(operation);
            validate_exact_flags(
                args,
                &["game_dir"],
                &["--adapter", "--artifact-root", "--output"],
                bool_flags,
                USAGE,
            )?;
            let input_root = PathBuf::from(args.get(1).ok_or("missing game_dir")?);
            let output = flag(args, "--output", USAGE)?;
            let adapter_name = selected_adapter_name(args, registry)?;
            if runtime_skip::try_write_runtime_skip_report(
                args,
                registry,
                &adapter_name,
                &PathBuf::from(output),
            )? {
                return Ok(());
            }
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
                    if let Some(unsupported) = unsupported_input_shape(error.as_ref()) {
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

fn unsupported_input_shape<'a>(
    error: &'a (dyn std::error::Error + 'static),
) -> Option<&'a utsushi_fixture::UnsupportedInputShape> {
    let mut current = Some(error);
    while let Some(error) = current {
        if let Some(unsupported) = error.downcast_ref::<utsushi_fixture::UnsupportedInputShape>() {
            return Some(unsupported);
        }
        current = std::error::Error::source(error);
    }
    None
}

/// review-package manifest export.
///
/// Reads the three MV/MZ proof surfaces from disk (KAIFUU patch export
/// runtime evidence report, optional replay-pack trace)
/// and writes the aggregated review-package manifest. Host capabilities default
/// to a fully-supported alpha host; `--no-browser` / `--no-screenshot` model an
/// unsupported host so the manifest records screenshot evidence as an honest
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

    let patch_export = PathBuf::from(flag(tail, "--patch-export", USAGE)?);
    let runtime_evidence = PathBuf::from(flag(tail, "--runtime-evidence", USAGE)?);
    let replay_pack = optional_flag(tail, "--replay-pack").map(PathBuf::from);
    let output = PathBuf::from(flag(tail, "--output", USAGE)?);

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

fn capabilities_output(
    registry: &RuntimeAdapterRegistry<'_>,
    skip_browser: bool,
    skipped_adapter_names: Vec<String>,
) -> Result<Value, Box<dyn std::error::Error>> {
    let runtime_adapters = registry
        .descriptors()
        .into_iter()
        .map(descriptor_output)
        .collect::<Vec<_>>();
    let base = json!({"schemaVersion": "0.1.0", "runtimeAdapters": runtime_adapters});
    runtime_skip::augment_capabilities_with_skip(base, skip_browser, skipped_adapter_names)
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

#[cfg(test)]
#[path = "main/tests.rs"]
mod tests;
