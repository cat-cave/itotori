use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};
use utsushi_core::{
    ApproximationTier, ControlledPlaybackSession, EvidenceTier, FidelityTier, RuntimeAdapter,
    RuntimeAdapterDescriptor, RuntimeArtifactKind, RuntimeArtifactRoot, RuntimeCapability,
    RuntimeCapabilityClass, RuntimeCapabilityContract, RuntimeCaptureBoundary,
    RuntimeCaptureContext, RuntimeCaptureHook, RuntimeCaptureHooks, RuntimeCapturedArtifact,
    RuntimeFeatureSupport, RuntimeHarnessError, RuntimeHarnessErrorKind,
    RuntimeLaunchCaptureHarness, RuntimeLaunchCapturePlan, RuntimeLaunchCommand, RuntimeOperation,
    RuntimePlaybackFeature, RuntimeRequest, UtsushiResult,
};

const BROWSER_RUN_ID: &str = "019ed050-0000-7000-8000-000000001000";
const BROWSER_TRACE_ID: &str = "019ed050-0000-7000-8000-000000002000";
const BROWSER_CAPTURE_ID: &str = "019ed050-0000-7000-8000-000000003000";
const BROWSER_SCREENSHOT_ID: &str = "019ed050-0000-7000-8000-000000004000";
const BROWSER_APPROXIMATION_ID: &str = "019ed050-0000-7000-8000-000000005000";
const BROWSER_SESSION_ID: &str = "019ed050-0000-7000-8000-000000006000";
const BROWSER_VIEWPORT_WIDTH: u32 = 320;
const BROWSER_VIEWPORT_HEIGHT: u32 = 180;

const BROWSER_CANDIDATES: &[&str] = &[
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
    "chrome",
    "msedge",
    "microsoft-edge",
    "brave-browser",
];

#[derive(Clone, Debug)]
pub struct BrowserLaunchAdapter {
    browser_program: Option<PathBuf>,
}

impl BrowserLaunchAdapter {
    pub const NAME: &'static str = "utsushi-browser";

    pub const fn new() -> Self {
        Self {
            browser_program: None,
        }
    }

    pub fn with_browser_program(browser_program: impl Into<PathBuf>) -> Self {
        Self {
            browser_program: Some(browser_program.into()),
        }
    }
}

impl Default for BrowserLaunchAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl RuntimeAdapter for BrowserLaunchAdapter {
    fn descriptor(&self) -> RuntimeAdapterDescriptor {
        let mut limitations = vec![
            "Chromium-compatible headless browser launch only; DOM instrumentation and branch control are not implemented in this adapter slice.".to_string(),
            "Screenshot bytes are ingested through the managed runtime artifact store and reported only by portable artifact URI.".to_string(),
            "RPG Maker MV/MZ support is limited to deployed browser-style entrypoints such as index.html or www/index.html.".to_string(),
        ];
        limitations.push(match self.browser_detection_label() {
            BrowserDetectionLabel::Configured => {
                "Browser executable configured explicitly for this adapter instance.".to_string()
            }
            BrowserDetectionLabel::Environment => {
                "Browser executable configured through UTSUSHI_BROWSER_BIN.".to_string()
            }
            BrowserDetectionLabel::Path => {
                "Browser executable can be discovered from PATH.".to_string()
            }
            BrowserDetectionLabel::Unavailable => {
                "No Chromium-compatible browser executable detected; set UTSUSHI_BROWSER_BIN to enable browser launch smoke validation.".to_string()
            }
        });

        RuntimeAdapterDescriptor {
            name: Self::NAME.to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            fidelity_tier: FidelityTier::LayoutProbe,
            evidence_tier_ceiling: EvidenceTier::E2,
            capability_contract: browser_capability_contract(),
            capabilities: vec![
                RuntimeCapability::Trace,
                RuntimeCapability::FrameCapture,
                RuntimeCapability::SmokeValidation,
            ],
            approximation_tiers: vec![ApproximationTier::LayoutProbe],
            limitations,
        }
    }

    fn trace(&self, request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
        let source = super::read_source(request.input_root)?;
        let unit = super::first_unit(&source)?;
        let target = resolve_browser_entrypoint(request.input_root, RuntimeOperation::Trace)?;
        let outcome = self.run_browser(
            RuntimeOperation::Trace,
            &target,
            request.artifact_root,
            false,
        )?;

        Ok(browser_runtime_report(
            &self.descriptor(),
            &source,
            BrowserReportInput {
                operation: RuntimeOperation::Trace,
                fidelity_tier: FidelityTier::TraceOnly,
                evidence_tier: EvidenceTier::E1,
                trace_events: vec![browser_trace_event(unit)?],
                captures: vec![],
                elapsed_millis: outcome.elapsed.as_millis(),
                launch_target: target.relative,
                limitation: "Browser trace confirms a bounded headless launch of the public fixture entrypoint; text observation is fixture-declared until DOM hooks land.",
            },
        ))
    }

    fn capture(&self, request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
        self.browser_capture_report(RuntimeOperation::Capture, request)
    }

    fn smoke_validate(&self, request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
        self.browser_capture_report(RuntimeOperation::SmokeValidation, request)
    }
}

impl BrowserLaunchAdapter {
    fn browser_capture_report(
        &self,
        operation: RuntimeOperation,
        request: &RuntimeRequest<'_>,
    ) -> UtsushiResult<Value> {
        let source = super::read_source(request.input_root)?;
        let unit = super::first_unit(&source)?;
        let target = resolve_browser_entrypoint(request.input_root, operation)?;
        let outcome = self.run_browser(operation, &target, request.artifact_root, true)?;
        let screenshot = outcome
            .artifacts
            .iter()
            .find(|artifact| artifact.artifact_kind == RuntimeArtifactKind::Screenshot)
            .ok_or_else(|| {
                RuntimeHarnessError::new(
                    RuntimeHarnessErrorKind::CaptureFailed,
                    operation,
                    "browser process exited successfully but did not produce a screenshot artifact",
                )
            })?;

        Ok(browser_runtime_report(
            &self.descriptor(),
            &source,
            BrowserReportInput {
                operation,
                fidelity_tier: FidelityTier::LayoutProbe,
                evidence_tier: EvidenceTier::E2,
                trace_events: vec![browser_trace_event(unit)?],
                captures: vec![browser_capture_event(unit, screenshot)?],
                elapsed_millis: outcome.elapsed.as_millis(),
                launch_target: target.relative,
                limitation: "Browser capture is live headless screenshot evidence from a Chromium-compatible launch path, without DOM hooks, jump control, or reference-runtime comparison.",
            },
        ))
    }

    fn run_browser(
        &self,
        operation: RuntimeOperation,
        target: &BrowserLaunchTarget,
        artifact_root: Option<&Path>,
        persist_screenshot: bool,
    ) -> Result<utsushi_core::RuntimeLaunchCaptureOutcome, RuntimeHarnessError> {
        let browser_program = self.resolve_browser_program(operation)?;
        let mut args = vec![
            "--headless=new".to_string(),
            "--disable-gpu".to_string(),
            "--no-sandbox".to_string(),
            "--hide-scrollbars".to_string(),
            format!("--window-size={BROWSER_VIEWPORT_WIDTH},{BROWSER_VIEWPORT_HEIGHT}"),
        ];
        let screenshot_staging = if persist_screenshot {
            let Some(artifact_root) = artifact_root else {
                return Err(RuntimeHarnessError::new(
                    RuntimeHarnessErrorKind::ArtifactStoreUnavailable,
                    operation,
                    "browser screenshot capture requires a managed runtime artifact root",
                )
                .with_detail("capability", "browser_screenshot_capture"));
            };
            let root = RuntimeArtifactRoot::new(artifact_root);
            let screenshot_path = root
                .prepare_staging_file(BROWSER_RUN_ID, BROWSER_SCREENSHOT_ID, "png")
                .map_err(|error| {
                    RuntimeHarnessError::new(
                        RuntimeHarnessErrorKind::ArtifactWriteFailed,
                        operation,
                        format!("failed to prepare browser screenshot staging path: {error}"),
                    )
                })?;
            args.push(format!("--screenshot={}", screenshot_path.display()));
            Some((root, screenshot_path))
        } else {
            args.push("--dump-dom".to_string());
            None
        };
        args.push(target.url.clone());
        let command = RuntimeLaunchCommand::new(browser_program).args(args);
        let mut plan = RuntimeLaunchCapturePlan::new(BROWSER_RUN_ID, operation, command)
            .with_timeout(Duration::from_secs(10))
            .with_shutdown_grace(Duration::from_secs(2))
            .with_hook_timeout(Duration::from_secs(2));
        if let Some(artifact_root) = artifact_root {
            plan = plan.with_artifact_root(artifact_root);
        }

        let mut hooks = RuntimeCaptureHooks::new();
        if let Some((_, screenshot_path)) = &screenshot_staging {
            hooks.push(BrowserScreenshotHook {
                screenshot_path: screenshot_path.clone(),
            });
        }
        let harness = RuntimeLaunchCaptureHarness::new();
        let result = harness.run(&plan, &mut hooks);
        if let Some((root, _)) = &screenshot_staging
            && let Err(cleanup_error) = root.cleanup_staging_run(BROWSER_RUN_ID)
        {
            return match result {
                Ok(_) => Err(RuntimeHarnessError::new(
                    RuntimeHarnessErrorKind::ArtifactWriteFailed,
                    operation,
                    format!("failed to clean browser screenshot staging path: {cleanup_error}"),
                )
                .with_detail("capability", "browser_screenshot_capture")),
                Err(error) => {
                    Err(error
                        .with_detail("screenshotStagingCleanupError", cleanup_error.to_string()))
                }
            };
        }
        result
    }

    fn resolve_browser_program(
        &self,
        operation: RuntimeOperation,
    ) -> Result<PathBuf, RuntimeHarnessError> {
        if let Some(program) = &self.browser_program {
            return Ok(program.clone());
        }
        if let Ok(program) = env::var("UTSUSHI_BROWSER_BIN") {
            if let Some(path) = resolve_program_candidate(&program) {
                return Ok(path);
            }
            return Err(RuntimeHarnessError::new(
                RuntimeHarnessErrorKind::LaunchFailed,
                operation,
                "UTSUSHI_BROWSER_BIN does not point to a launchable browser executable",
            )
            .with_detail("capability", "browser_launch")
            .with_detail("browserSource", "env"));
        }
        if let Some(path) = BROWSER_CANDIDATES
            .iter()
            .find_map(|candidate| resolve_program_candidate(candidate))
        {
            return Ok(path);
        }
        Err(RuntimeHarnessError::new(
            RuntimeHarnessErrorKind::LaunchFailed,
            operation,
            "no Chromium-compatible browser executable detected; set UTSUSHI_BROWSER_BIN or install Chromium/Chrome",
        )
        .with_detail("capability", "browser_launch")
        .with_detail("browserSource", "path"))
    }

    fn browser_detection_label(&self) -> BrowserDetectionLabel {
        if self.browser_program.is_some() {
            return BrowserDetectionLabel::Configured;
        }
        if env::var("UTSUSHI_BROWSER_BIN")
            .ok()
            .and_then(|program| resolve_program_candidate(&program))
            .is_some()
        {
            return BrowserDetectionLabel::Environment;
        }
        if BROWSER_CANDIDATES
            .iter()
            .any(|candidate| resolve_program_candidate(candidate).is_some())
        {
            return BrowserDetectionLabel::Path;
        }
        BrowserDetectionLabel::Unavailable
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BrowserDetectionLabel {
    Configured,
    Environment,
    Path,
    Unavailable,
}

#[derive(Clone, Debug)]
struct BrowserLaunchTarget {
    relative: String,
    url: String,
}

fn resolve_browser_entrypoint(
    input_root: &Path,
    operation: RuntimeOperation,
) -> Result<BrowserLaunchTarget, RuntimeHarnessError> {
    for relative in ["index.html", "www/index.html"] {
        let path = input_root.join(relative);
        if path.is_file() {
            let canonical = path.canonicalize().map_err(|error| {
                RuntimeHarnessError::new(
                    RuntimeHarnessErrorKind::InvalidPlan,
                    operation,
                    "failed to resolve browser launch entrypoint",
                )
                .with_detail("ioKind", error.kind().to_string())
            })?;
            return Ok(BrowserLaunchTarget {
                relative: relative.to_string(),
                url: file_url(&canonical),
            });
        }
    }

    Err(RuntimeHarnessError::new(
        RuntimeHarnessErrorKind::InvalidPlan,
        operation,
        "browser launch adapter requires index.html or www/index.html under the input root",
    )
    .with_detail("capability", "browser_launch"))
}

fn file_url(path: &Path) -> String {
    let path_string = path.to_string_lossy();
    let escaped = path_string
        .replace('%', "%25")
        .replace(' ', "%20")
        .replace('#', "%23")
        .replace('?', "%3F");
    if escaped.starts_with('/') {
        format!("file://{escaped}")
    } else {
        format!("file:///{escaped}")
    }
}

struct BrowserScreenshotHook {
    screenshot_path: PathBuf,
}

impl RuntimeCaptureHook for BrowserScreenshotHook {
    fn boundary(&self) -> RuntimeCaptureBoundary {
        RuntimeCaptureBoundary::AfterExit
    }

    fn capture(&mut self, context: &mut RuntimeCaptureContext) -> Result<(), RuntimeHarnessError> {
        if !self.screenshot_path.is_file() {
            return Ok(());
        }
        let bytes = fs::read(&self.screenshot_path).map_err(|error| {
            RuntimeHarnessError::capture_failed(
                context.operation,
                "failed to read browser screenshot output",
            )
            .with_detail("ioKind", error.kind().to_string())
        })?;
        context.write_artifact(
            RuntimeArtifactKind::Screenshot,
            BROWSER_SCREENSHOT_ID,
            Some("image/png".to_string()),
            &bytes,
        )?;
        Ok(())
    }
}

pub struct NwjsLaunchAdapter;

impl NwjsLaunchAdapter {
    pub const NAME: &'static str = "utsushi-nwjs";

    pub const fn new() -> Self {
        Self
    }
}

impl Default for NwjsLaunchAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl RuntimeAdapter for NwjsLaunchAdapter {
    fn descriptor(&self) -> RuntimeAdapterDescriptor {
        RuntimeAdapterDescriptor {
            name: Self::NAME.to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            fidelity_tier: FidelityTier::TraceOnly,
            evidence_tier_ceiling: EvidenceTier::E1,
            capability_contract: nwjs_unsupported_capability_contract(),
            capabilities: vec![],
            approximation_tiers: vec![ApproximationTier::None],
            limitations: vec![
                "NW.js launch/capture is explicitly unsupported in this adapter slice.".to_string(),
                "RPG Maker MV/MZ desktop packages need a separate bounded NW.js contract for process launch, capture timing, and screenshot extraction before this adapter can claim runtime evidence.".to_string(),
                "Use the utsushi-browser adapter for public browser-style smoke validation when a Chromium-compatible host is available.".to_string(),
            ],
        }
    }

    fn trace(&self, _request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
        Err("NW.js launch/capture is unsupported by the utsushi-nwjs capability diagnostic".into())
    }
}

fn browser_capability_contract() -> RuntimeCapabilityContract {
    RuntimeCapabilityContract::new(
        RuntimeCapabilityClass::LaunchCapture,
        FidelityTier::LayoutProbe,
        EvidenceTier::E2,
        vec![
            RuntimeFeatureSupport::partial(
                RuntimePlaybackFeature::Launch,
                EvidenceTier::E1,
                "Launches browser-style runtime entrypoints through a bounded Chromium-compatible process.",
                vec![
                    "Host must provide Chromium/Chrome or UTSUSHI_BROWSER_BIN.".to_string(),
                    "Launch is headless and does not yet inject RPG Maker observation hooks."
                        .to_string(),
                ],
            ),
            RuntimeFeatureSupport::partial(
                RuntimePlaybackFeature::TextTrace,
                EvidenceTier::E1,
                "Emits fixture-declared trace reachability after a bounded browser launch.",
                vec![
                    "The adapter does not inspect DOM text or RPG Maker scene state yet."
                        .to_string(),
                ],
            ),
            RuntimeFeatureSupport::partial(
                RuntimePlaybackFeature::Screenshot,
                EvidenceTier::E2,
                "Captures a headless browser screenshot and stores it through the runtime artifact store.",
                vec![
                    "Chromium-compatible --screenshot behavior is required on the host."
                        .to_string(),
                ],
            ),
            RuntimeFeatureSupport::partial(
                RuntimePlaybackFeature::FrameCapture,
                EvidenceTier::E2,
                "Reports the browser screenshot as frame capture evidence for smoke validation.",
                vec!["No pixel comparison or layout oracle is applied.".to_string()],
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::StaticTrace,
                "The browser adapter launches a runtime process rather than reading static-only fixture state.",
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::BranchDiscovery,
                "Branch discovery requires RPG Maker runtime instrumentation hooks.",
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::Jump,
                "Jump-to-moment control requires RPG Maker runtime instrumentation hooks.",
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::Snapshot,
                "Snapshot save and restore are not implemented for browser launch smoke validation.",
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::Recording,
                "Playback recording is not implemented for browser launch smoke validation.",
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::InstrumentationHooks,
                "Observation hooks are planned for the RPG Maker MV/MZ adapter layer, not this launch slice.",
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::VmStateInspection,
                "The browser launch adapter does not inspect RPG Maker or JavaScript VM state.",
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::ReferenceComparison,
                "Reference-runtime comparison is outside the browser launch adapter contract.",
            ),
        ],
        vec![
            "Browser support is host-capability dependent and limited to launch/capture smoke validation.".to_string(),
            "No raw local screenshot path is exposed in runtime evidence reports.".to_string(),
        ],
    )
}

fn nwjs_unsupported_capability_contract() -> RuntimeCapabilityContract {
    RuntimeCapabilityContract::new(
        RuntimeCapabilityClass::StaticTrace,
        FidelityTier::TraceOnly,
        EvidenceTier::E1,
        vec![
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::Launch,
                "NW.js launch is unsupported until the harness has a stable NW.js process and capture contract.",
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::TextTrace,
                "NW.js text tracing requires RPG Maker runtime instrumentation hooks.",
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::FrameCapture,
                "NW.js screenshot capture is unsupported in this slice.",
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::Screenshot,
                "NW.js screenshot capture is unsupported in this slice.",
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::BranchDiscovery,
                "NW.js branch discovery requires runtime instrumentation hooks.",
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::Jump,
                "NW.js jump control requires runtime instrumentation hooks.",
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::Snapshot,
                "NW.js snapshot support is unsupported in this slice.",
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::Recording,
                "NW.js recording support is unsupported in this slice.",
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::InstrumentationHooks,
                "NW.js instrumentation hooks are not implemented in this slice.",
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::VmStateInspection,
                "NW.js VM state inspection is unsupported in this slice.",
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::ReferenceComparison,
                "NW.js reference-runtime comparison is unsupported in this slice.",
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::StaticTrace,
                "NW.js fallback is a capability diagnostic only and does not emit static runtime evidence.",
            ),
        ],
        vec![
            "NW.js is intentionally registered as unsupported so capability output is explicit rather than silently missing.".to_string(),
        ],
    )
}

struct BrowserReportInput {
    operation: RuntimeOperation,
    fidelity_tier: FidelityTier,
    evidence_tier: EvidenceTier,
    trace_events: Vec<Value>,
    captures: Vec<Value>,
    elapsed_millis: u128,
    launch_target: String,
    limitation: &'static str,
}

fn browser_runtime_report(
    descriptor: &RuntimeAdapterDescriptor,
    source: &Value,
    input: BrowserReportInput,
) -> Value {
    let BrowserReportInput {
        operation,
        fidelity_tier,
        evidence_tier,
        trace_events,
        captures,
        elapsed_millis,
        launch_target,
        limitation,
    } = input;
    let affected_bridge_unit_refs = trace_events
        .iter()
        .filter_map(|event| event.get("bridgeUnitRef").cloned())
        .collect::<Vec<_>>();
    let mut limitations = descriptor.limitations.clone();
    limitations.push(limitation.to_string());
    limitations.push(format!(
        "Browser launch target was recorded as repository-relative fixture entrypoint {launch_target}; raw local paths are omitted from report metadata."
    ));
    limitations.push(format!(
        "Browser launch completed in {elapsed_millis} ms under the core bounded process harness."
    ));

    json!({
        "schemaVersion": "0.2.0",
        "runtimeReportId": BROWSER_RUN_ID,
        "sourceLocale": source["sourceLocale"].as_str().unwrap_or("und"),
        "adapterName": descriptor.name,
        "adapterVersion": descriptor.version,
        "fidelityTier": fidelity_tier.as_str(),
        "evidenceTier": evidence_tier.as_str(),
        "runtimeCapabilities": descriptor.capability_contract.to_json(),
        "controlledPlaybackSession": ControlledPlaybackSession {
            session_id: BROWSER_SESSION_ID.to_string(),
            adapter_name: descriptor.name.clone(),
            adapter_version: descriptor.version.clone(),
            capability_class: descriptor.capability_contract.capability_class,
            requested_operation: operation,
            status: "passed".to_string(),
            fidelity_tier,
            evidence_tier,
            features_used: browser_features_used(operation),
            limitations: limitations.clone(),
        }.to_json(),
        "status": "passed",
        "createdAt": "2026-06-17T00:00:00.000Z",
        "traceEvents": trace_events,
        "branchEvents": [],
        "captures": captures,
        "recordings": [],
        "approximations": [
            {
                "approximationId": BROWSER_APPROXIMATION_ID,
                "approximationTier": ApproximationTier::LayoutProbe.as_str(),
                "scope": "browser launch adapter",
                "description": "Browser launch/capture proves bounded entrypoint reachability and screenshot production, but not RPG Maker scene instrumentation or reference-runtime fidelity.",
                "affectedBridgeUnitRefs": affected_bridge_unit_refs,
                "evidenceTierCeiling": evidence_tier.as_str()
            }
        ],
        "validationFindings": [],
        "referenceComparisons": [],
        "limitations": limitations
    })
}

fn browser_features_used(operation: RuntimeOperation) -> Vec<RuntimePlaybackFeature> {
    match operation {
        RuntimeOperation::Trace => {
            vec![
                RuntimePlaybackFeature::Launch,
                RuntimePlaybackFeature::TextTrace,
            ]
        }
        RuntimeOperation::Capture | RuntimeOperation::SmokeValidation => {
            vec![
                RuntimePlaybackFeature::Launch,
                RuntimePlaybackFeature::TextTrace,
                RuntimePlaybackFeature::Screenshot,
                RuntimePlaybackFeature::FrameCapture,
            ]
        }
        RuntimeOperation::BranchDiscovery => vec![RuntimePlaybackFeature::BranchDiscovery],
    }
}

fn browser_trace_event(unit: &Value) -> UtsushiResult<Value> {
    Ok(json!({
        "traceEventId": BROWSER_TRACE_ID,
        "eventKind": "text_observed",
        "bridgeUnitRef": super::bridge_unit_ref(unit, 1)?,
        "frame": 1,
        "traceKey": super::require_str(unit, "sourceUnitKey")?,
        "observedText": unit["targetText"]
            .as_str()
            .or_else(|| unit["sourceText"].as_str())
            .unwrap_or("")
    }))
}

fn browser_capture_event(
    unit: &Value,
    screenshot: &RuntimeCapturedArtifact,
) -> UtsushiResult<Value> {
    Ok(json!({
        "captureId": BROWSER_CAPTURE_ID,
        "bridgeUnitRef": super::bridge_unit_ref(unit, 1)?,
        "evidenceTier": EvidenceTier::E2.as_str(),
        "frame": 1,
        "width": BROWSER_VIEWPORT_WIDTH,
        "height": BROWSER_VIEWPORT_HEIGHT,
        "artifactRef": screenshot.artifact_ref_json()
    }))
}

fn resolve_program_candidate(program: &str) -> Option<PathBuf> {
    if program.trim().is_empty() {
        return None;
    }
    let path = Path::new(program);
    if program.contains('/') || program.contains('\\') {
        return is_launchable_file(path).then(|| path.to_path_buf());
    }
    env::var_os("PATH")
        .into_iter()
        .flat_map(|path_var| env::split_paths(&path_var).collect::<Vec<_>>())
        .flat_map(|dir| {
            executable_names(program)
                .into_iter()
                .map(move |name| dir.join(name))
        })
        .find(|candidate| is_launchable_file(candidate))
}

fn executable_names(program: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        let has_extension = Path::new(program).extension().is_some();
        if has_extension {
            return vec![program.to_string()];
        }
        return vec![format!("{program}.exe"), program.to_string()];
    }
    #[cfg(not(windows))]
    {
        vec![program.to_string()]
    }
}

fn is_launchable_file(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = env::temp_dir().join(format!(
            "utsushi-launch-adapter-{name}-{}-{nonce}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_browser_smoke_fixture(root: &Path) {
        fs::write(
            root.join("source.json"),
            r#"{
  "gameId": "browser-smoke-fixture",
  "title": "Browser Smoke Fixture",
  "sourceLocale": "ja-JP",
  "units": [
    {
      "sourceUnitKey": "browser.smoke.001",
      "speaker": "Narrator",
      "textSurface": "dialogue",
      "sourceText": "ブラウザ起動確認。",
      "targetText": "Browser launch confirmed.",
      "protectedSpans": []
    }
  ]
}
"#,
        )
        .unwrap();
        fs::write(
            root.join("index.html"),
            "<!doctype html><html><head><meta charset=\"utf-8\"><title>Utsushi Browser Smoke</title></head><body><main>Browser launch confirmed.</main></body></html>\n",
        )
        .unwrap();
    }

    #[cfg(unix)]
    fn fake_browser(root: &Path, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let path = root.join("fake-browser.sh");
        let mut file = fs::File::create(&path).unwrap();
        file.write_all(body.as_bytes()).unwrap();
        let mut permissions = file.metadata().unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&path, permissions).unwrap();
        path
    }

    #[cfg(unix)]
    fn shell_quote_path(path: &Path) -> String {
        format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
    }

    #[test]
    fn browser_descriptor_reports_launch_capture_capability() {
        let adapter = BrowserLaunchAdapter::new();
        let descriptor = adapter.descriptor();

        assert_eq!(descriptor.name, BrowserLaunchAdapter::NAME);
        assert!(descriptor.supports(RuntimeCapability::Trace));
        assert!(descriptor.supports(RuntimeCapability::FrameCapture));
        assert!(descriptor.supports(RuntimeCapability::SmokeValidation));
        assert!(descriptor.uses_approximation(ApproximationTier::LayoutProbe));
        assert_eq!(
            descriptor.capability_contract.capability_class,
            RuntimeCapabilityClass::LaunchCapture
        );
        assert!(
            descriptor
                .capability_contract
                .features
                .iter()
                .any(
                    |feature| feature.feature == RuntimePlaybackFeature::Screenshot
                        && feature.status != utsushi_core::RuntimeFeatureStatus::Unsupported
                )
        );
    }

    #[test]
    fn nwjs_descriptor_is_explicit_unsupported_fallback() {
        let adapter = NwjsLaunchAdapter::new();
        let descriptor = adapter.descriptor();

        assert_eq!(descriptor.name, NwjsLaunchAdapter::NAME);
        assert!(descriptor.capabilities.is_empty());
        assert!(
            descriptor
                .limitations
                .iter()
                .any(|limitation| limitation.contains("explicitly unsupported"))
        );
        assert!(
            descriptor
                .capability_contract
                .features
                .iter()
                .all(|feature| feature.status == utsushi_core::RuntimeFeatureStatus::Unsupported)
        );
    }

    #[cfg(unix)]
    #[test]
    fn browser_smoke_uses_core_harness_and_persists_screenshot_artifact() {
        let root = temp_dir("browser-smoke");
        write_browser_smoke_fixture(&root);
        let artifact_root = root.join("runtime-artifacts");
        let observed_screenshot_path = root.join("observed-screenshot-path");
        let observed_screenshot_path_arg = shell_quote_path(&observed_screenshot_path);
        let fake_browser = fake_browser(
            &root,
            &format!(
                r#"#!/bin/sh
set -eu
screenshot=""
for arg in "$@"; do
  case "$arg" in
    --screenshot=*) screenshot="${{arg#--screenshot=}}" ;;
  esac
done
if [ -z "$screenshot" ]; then
  exit 64
fi
mkdir -p "$(dirname "$screenshot")"
printf '%s' "$screenshot" > {observed_screenshot_path_arg}
printf '\211PNG\r\n\032\nutsushi fake browser screenshot\n' > "$screenshot"
"#,
            ),
        );
        let adapter = BrowserLaunchAdapter::with_browser_program(fake_browser);

        let report = adapter
            .smoke_validate(&RuntimeRequest::new(&root).with_artifact_root(&artifact_root))
            .unwrap();

        assert_eq!(report["adapterName"], BrowserLaunchAdapter::NAME);
        assert_eq!(report["status"], "passed");
        assert_eq!(report["evidenceTier"], "E2");
        assert_eq!(
            report["controlledPlaybackSession"]["requestedOperation"],
            "smoke_validation"
        );
        assert_eq!(report["captures"].as_array().unwrap().len(), 1);
        let artifact_ref = &report["captures"][0]["artifactRef"];
        assert_eq!(artifact_ref["artifactKind"], "screenshot");
        assert_eq!(
            artifact_ref["uri"],
            format!(
                "artifacts/utsushi/runtime/{BROWSER_RUN_ID}/screenshots/{BROWSER_SCREENSHOT_ID}.png"
            )
        );
        assert!(artifact_ref.get("localPath").is_none());
        assert!(artifact_ref.get("data").is_none());
        assert!(artifact_ref.get("bytes").is_none());
        let artifact_path = utsushi_core::RuntimeArtifactRoot::new(&artifact_root)
            .artifact_path(artifact_ref["uri"].as_str().unwrap())
            .unwrap();
        assert!(artifact_path.starts_with(&artifact_root));
        assert!(artifact_path.is_file());
        assert!(fs::read(&artifact_path).unwrap().starts_with(b"\x89PNG"));
        let browser_screenshot_path =
            PathBuf::from(fs::read_to_string(&observed_screenshot_path).unwrap());
        assert!(browser_screenshot_path.starts_with(&artifact_root));
        assert!(!browser_screenshot_path.exists());
        assert!(!artifact_root.join(".staging").exists());
        let report_string = serde_json::to_string(&report).unwrap();
        assert!(!report_string.contains(root.to_string_lossy().as_ref()));
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn browser_capture_requires_managed_artifact_root_before_launch() {
        let root = temp_dir("browser-root-required");
        write_browser_smoke_fixture(&root);
        let launched_marker = root.join("launched");
        let launched_marker_arg = shell_quote_path(&launched_marker);
        let fake_browser = fake_browser(
            &root,
            &format!(
                r#"#!/bin/sh
set -eu
printf launched > {launched_marker_arg}
exit 0
"#,
            ),
        );
        let adapter = BrowserLaunchAdapter::with_browser_program(fake_browser);

        let error = adapter.capture(&RuntimeRequest::new(&root)).unwrap_err();
        let harness_error = error.downcast_ref::<RuntimeHarnessError>().unwrap();

        assert_eq!(
            harness_error.kind,
            RuntimeHarnessErrorKind::ArtifactStoreUnavailable
        );
        assert_eq!(harness_error.code(), "runtime_artifact_store_unavailable");
        assert!(!launched_marker.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn browser_capture_reports_semantic_failure_when_screenshot_is_missing() {
        let root = temp_dir("browser-missing-screenshot");
        write_browser_smoke_fixture(&root);
        let artifact_root = root.join("runtime-artifacts");
        let fake_browser = fake_browser(
            &root,
            r#"#!/bin/sh
set -eu
exit 0
"#,
        );
        let adapter = BrowserLaunchAdapter::with_browser_program(fake_browser);

        let error = adapter
            .capture(&RuntimeRequest::new(&root).with_artifact_root(&artifact_root))
            .unwrap_err();
        let harness_error = error.downcast_ref::<RuntimeHarnessError>().unwrap();

        assert_eq!(harness_error.kind, RuntimeHarnessErrorKind::CaptureFailed);
        assert_eq!(harness_error.code(), "runtime_capture_failed");
        assert!(harness_error.message.contains("did not produce"));
        assert!(!artifact_root.join(".staging").exists());
        let _ = fs::remove_dir_all(root);
    }
}
