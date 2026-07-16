//! MV/MZ browser-engine runtime-evidence adapters.
//!
//! This module owns the workspace's deliberate, scoped browser-engine
//! exception to the "no shipped `Command::new`" port posture.
//! `BrowserLaunchAdapter::run_browser` launches a real headless
//! Chromium-compatible browser (`--headless=new`, `--screenshot` or
//! `--dump-dom`) to render/observe RPG Maker MV/MZ games, and
//! `browser_detection::probe_version` runs the bounded `<binary> --version`
//! probe that resolves and validates the binary. Both spawn through
//! `utsushi_core::RuntimeLaunchCommand` (the single shipped external spawn)
//! and `BrowserLaunchAdapter` is registered as a production runtime adapter in
//! `utsushi-cli`. RPG Maker MV/MZ games are browser/NW.js JavaScript games
//! with no proprietary opcode VM, so launching the real browser runs the
//! actual engine rather than a from-scratch mimic. See
//! `docs/dev/architecture.md` ("MV/MZ runtime evidence: real-Chromium
//! policy") for the decided policy and its scope boundary; every other
//! `kaifuu`/`utsushi` engine module keeps its no-`Command::new`
//! in-process-Rust rule unchanged.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};
use utsushi_core::{
    ApproximationTier, EvidenceTier, FidelityTier, RuntimeAdapter, RuntimeAdapterDescriptor,
    RuntimeAdapterDiagnostic, RuntimeArtifactKind, RuntimeArtifactRoot, RuntimeCapability,
    RuntimeCaptureBoundary, RuntimeCaptureContext, RuntimeCaptureHook, RuntimeCaptureHooks,
    RuntimeHarnessError, RuntimeHarnessErrorKind, RuntimeLaunchCaptureHarness,
    RuntimeLaunchCapturePlan, RuntimeLaunchCommand, RuntimeOperation, RuntimeRequest,
    UtsushiResult,
};

use browser_detection::{
    BrowserUnavailabilityReason, ChromiumProbeOutcome, chromium_min_supported_version_string,
    probe_chromium,
};

#[cfg(test)]
use crate::FIXTURE_OBSERVATION_HOOK_SCHEMA_LITERAL;
#[cfg(test)]
use utsushi_core::{RuntimeCapabilityClass, RuntimePlaybackFeature};

mod browser_detection;
mod capability_contracts;
mod observe;
mod report;
use capability_contracts::{browser_capability_contract, nwjs_research_tier_contract};
use observe::{build_observed_events, parse_observed_dom};
use report::{
    BrowserReportInput, browser_capture_event, browser_frame_observation_hook_event,
    browser_runtime_report, browser_text_observation_hook_event, browser_trace_event,
};

const BROWSER_RUN_ID: &str = "019ed050-0000-7000-8000-000000001000";
const BROWSER_TRACE_ID: &str = "019ed050-0000-7000-8000-000000002000";
const BROWSER_CAPTURE_ID: &str = "019ed050-0000-7000-8000-000000003000";
const BROWSER_SCREENSHOT_ID: &str = "019ed050-0000-7000-8000-000000004000";
const BROWSER_APPROXIMATION_ID: &str = "019ed050-0000-7000-8000-000000005000";
const BROWSER_SESSION_ID: &str = "019ed050-0000-7000-8000-000000006000";
const BROWSER_OBSERVATION_TEXT_ID: &str = "019ed050-0000-7000-8000-000000007000";
const BROWSER_OBSERVATION_FRAME_ID: &str = "019ed050-0000-7000-8000-000000007100";

/// Sentinel markers the public MV/MZ fixture's runtime script wraps around the
/// machine-readable observation island it injects into the live DOM. The trace
/// probe extracts the JSON between them from the `--dump-dom` output. Because
/// the fixture only emits these markers after a real JS runtime executes, a
/// static read of the fixture source never contains them.
const OBSERVED_ISLAND_BEGIN: &str = "/*UTSUSHI-OBSERVED-BEGIN*/";
const OBSERVED_ISLAND_END: &str = "/*UTSUSHI-OBSERVED-END*/";
/// Evidence-tier discriminator distinguishing genuinely live-observed events
/// from fixture-declared reachability markers.
const OBSERVATION_SOURCE_LIVE_DOM: &str = "live_dom";
const OBSERVATION_SOURCE_FIXTURE_DECLARED: &str = "fixture_declared";
const BROWSER_VIEWPORT_WIDTH: u32 = 320;
const BROWSER_VIEWPORT_HEIGHT: u32 = 180;

#[derive(Clone, Debug)]
pub struct BrowserLaunchAdapter {
    browser_program: Option<PathBuf>,
    // Test-only seam: inject a deterministic Chromium version so the
    // version-mismatch comparison logic can be exercised WITHOUT spawning a
    // real `<binary> --version` shell-out. Production builds never set this
    // (the constructor that populates it is `#[cfg(test)]`), so the live probe
    // path always shells out to the real binary.
    #[cfg(test)]
    version_probe_override: Option<browser_detection::ChromiumVersion>,
}

impl BrowserLaunchAdapter {
    pub const NAME: &'static str = "utsushi-browser";

    pub const fn new() -> Self {
        Self {
            browser_program: None,
            #[cfg(test)]
            version_probe_override: None,
        }
    }

    pub fn with_browser_program(browser_program: impl Into<PathBuf>) -> Self {
        Self {
            browser_program: Some(browser_program.into()),
            #[cfg(test)]
            version_probe_override: None,
        }
    }

    /// Test-only constructor that resolves the given launchable browser binary
    /// but injects a fixed Chromium version instead of shelling out to
    /// `<binary> --version`. This makes the version-mismatch comparison logic
    /// deterministic under concurrency (the real probe spawn can race/time out
    /// under load); the real shell-out probe stays live for production and is
    /// covered by the env-gated real-browser tests.
    #[cfg(test)]
    fn with_browser_program_and_version(
        browser_program: impl Into<PathBuf>,
        version: browser_detection::ChromiumVersion,
    ) -> Self {
        Self {
            browser_program: Some(browser_program.into()),
            version_probe_override: Some(version),
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
            diagnostics: vec![self.browser_host_availability_diagnostic()],
            limitations: self.descriptor_limitations(),
        }
    }

    fn trace(&self, request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
        let source = super::read_source(request.input_root)?;
        let target = resolve_browser_entrypoint(request.input_root, RuntimeOperation::Trace)?;
        let outcome = self.run_browser(
            RuntimeOperation::Trace,
            &target,
            request.artifact_root,
            false,
        )?;

        // OBSERVE the live post-render DOM the browser dumped to stdout. The
        // public fixture's runtime script injects the observation island only
        // after a real JS runtime executes; a launch that produced no live DOM
        // (or a static source read) yields no observed events at all.
        let dom = outcome.stdout.as_deref().unwrap_or_default();
        let observed = parse_observed_dom(dom);
        let (trace_events, observation_events) =
            build_observed_events(&self.descriptor(), &source, &observed);

        Ok(browser_runtime_report(
            &self.descriptor(),
            &source,
            BrowserReportInput {
                operation: RuntimeOperation::Trace,
                fidelity_tier: FidelityTier::TraceOnly,
                evidence_tier: EvidenceTier::E1,
                trace_events,
                observation_events,
                captures: vec![],
                elapsed_millis: outcome.elapsed.as_millis(),
                launch_target: target.relative,
                limitation: "Browser trace observes live post-render DOM (--dump-dom) text and choice events from the public MV/MZ fixture entrypoint; observation is empty when the render produced no instrumented DOM island.",
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
                observation_events: vec![
                    browser_text_observation_hook_event(
                        &self.descriptor(),
                        &source,
                        unit,
                        EvidenceTier::E1,
                    )?,
                    browser_frame_observation_hook_event(
                        &self.descriptor(),
                        &source,
                        unit,
                        screenshot,
                    )?,
                ],
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
        // The `--dump-dom` (non-screenshot) launch writes the live post-render
        // DOM to stdout; capture it so the trace probe can OBSERVE the runtime
        // text/choice island instead of reading fixture-declared strings.
        let mut plan = RuntimeLaunchCapturePlan::new(BROWSER_RUN_ID, operation, command)
            .with_timeout(Duration::from_secs(10))
            .with_shutdown_grace(Duration::from_secs(2))
            .with_hook_timeout(Duration::from_secs(2))
            .with_stdout_capture(!persist_screenshot);
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
        match self.probe() {
            Ok(probe) => Ok(probe.program),
            Err(reason) => Err(unavailability_harness_error(operation, &reason)),
        }
    }

    /// Run the bounded Chromium probe with the adapter's configured browser
    /// path. The probe is intentionally invoked on every descriptor render
    /// and on every launch so the diagnostic reflects fresh host state
    /// (environment can change between capability listing and launch).
    fn probe(&self) -> Result<ChromiumProbeOutcome, BrowserUnavailabilityReason> {
        #[cfg(test)]
        let version_override = self.version_probe_override;
        #[cfg(not(test))]
        let version_override = None;
        probe_chromium(self.browser_program.as_deref(), version_override)
    }

    fn browser_host_availability_diagnostic(&self) -> RuntimeAdapterDiagnostic {
        match self.probe() {
            Ok(probe) => RuntimeAdapterDiagnostic::new(
                "browser_host_availability",
                "available",
                "info",
                "Chromium-compatible browser host is available for browser launch capture.",
            )
            .with_detail("capability", "browser_launch")
            .with_detail_value("hostAvailable", json!(true))
            .with_detail("browserSource", probe.source_label())
            .with_detail("chromiumVersion", probe.version_string())
            .with_detail_value(
                "requiredFor",
                json!(["trace", "capture", "smoke_validation"]),
            )
            .with_detail("errorCode", "utsushi.browser.chromium_available")
            .with_detail("pathRedaction", "raw_local_paths_omitted"),
            Err(reason) => {
                let diagnostic = RuntimeAdapterDiagnostic::new(
                    "browser_host_availability",
                    "unavailable",
                    "error",
                    reason.diagnostic_message(),
                )
                .with_detail("capability", "browser_launch")
                .with_detail_value("hostAvailable", json!(false))
                .with_detail("browserSource", reason.source_label())
                .with_detail_value(
                    "requiredFor",
                    json!(["trace", "capture", "smoke_validation"]),
                )
                .with_detail("errorCode", reason.semantic_code())
                .with_detail("pathRedaction", "raw_local_paths_omitted");
                attach_reason_details(diagnostic, &reason)
            }
        }
    }

    fn descriptor_limitations(&self) -> Vec<String> {
        let mut limitations = vec![
            "Chromium-compatible headless browser launch only; DOM instrumentation and branch control are not implemented in this adapter slice.".to_string(),
            "Screenshot bytes are ingested through the managed runtime artifact store and reported only by portable artifact URI.".to_string(),
            "RPG Maker MV/MZ support is limited to deployed browser-style entrypoints such as index.html or www/index.html.".to_string(),
            "Chromium browser launch is required for MV/MZ alpha runtime evidence; supported host environments must provide Chromium on PATH or through UTSUSHI_BROWSER_BIN.".to_string(),
            format!(
                "Environmental misconfiguration (missing or incompatible Chromium, version below {min}, unavailable display surface) is a hard error with semantic codes in the utsushi.browser.* namespace.",
                min = chromium_min_supported_version_string(),
            ),
            "Adapter-discovered common install paths are a fallback after PATH lookup and are not guaranteed; operators with custom installs must set UTSUSHI_BROWSER_BIN.".to_string(),
        ];
        match self.probe() {
            Ok(probe) => {
                limitations.push(format!(
                    "Browser executable resolved through the adapter probe (source: {source}, version: {version}).",
                    source = probe.source_label(),
                    version = probe.version_string(),
                ));
            }
            Err(reason) => limitations.push(format!(
                "Browser executable unavailable: {message}",
                message = reason.diagnostic_message(),
            )),
        }
        limitations
    }
}

fn unavailability_harness_error(
    operation: RuntimeOperation,
    reason: &BrowserUnavailabilityReason,
) -> RuntimeHarnessError {
    let kind = reason.harness_error_kind();
    let mut error = RuntimeHarnessError::new(kind, operation, reason.diagnostic_message())
        .with_detail("capability", "browser_launch")
        .with_detail("semanticCode", reason.semantic_code())
        .with_detail("browserSource", reason.source_label())
        .with_detail("pathRedaction", "raw_local_paths_omitted");
    match reason {
        BrowserUnavailabilityReason::NoBinaryFound {
            candidates_tried, ..
        } => {
            error = error.with_detail("attemptedCandidates", candidates_tried.to_string());
        }
        BrowserUnavailabilityReason::VersionMismatch {
            detected,
            required_major,
            ..
        } => {
            error = error
                .with_detail("chromiumVersionDetected", detected.version_string())
                .with_detail("chromiumVersionRequired", required_major.to_string());
        }
        BrowserUnavailabilityReason::DisplayUnavailable {
            platform, probe, ..
        } => {
            error = error
                .with_detail("platform", *platform)
                .with_detail("displayProbe", probe.as_str());
        }
    }
    error
}

fn attach_reason_details(
    diagnostic: RuntimeAdapterDiagnostic,
    reason: &BrowserUnavailabilityReason,
) -> RuntimeAdapterDiagnostic {
    match reason {
        BrowserUnavailabilityReason::NoBinaryFound {
            candidates_tried, ..
        } => diagnostic.with_detail_value("attemptedCandidates", json!(*candidates_tried)),
        BrowserUnavailabilityReason::VersionMismatch {
            detected,
            required_major,
            ..
        } => diagnostic
            .with_detail("chromiumVersionDetected", detected.version_string())
            .with_detail_value("chromiumVersionRequired", json!(*required_major)),
        BrowserUnavailabilityReason::DisplayUnavailable {
            platform, probe, ..
        } => diagnostic
            .with_detail("platform", *platform)
            .with_detail("displayProbe", probe.as_str()),
    }
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
            capability_contract: nwjs_research_tier_contract(),
            capabilities: vec![],
            approximation_tiers: vec![ApproximationTier::None],
            diagnostics: vec![
                RuntimeAdapterDiagnostic::new(
                    "research_tier_status",
                    "unsupported",
                    "info",
                    "NW.js launch is research-tier work. It is not part of the MV/MZ alpha capability surface; use BrowserLaunchAdapter for alpha runtime evidence.",
                )
                .with_detail("capability", "browser_launch")
                .with_detail("errorCode", "utsushi.runtime.research_tier_unsupported")
                .with_detail("runtimeTier", "research")
                .with_detail("supersededBy", BrowserLaunchAdapter::NAME),
            ],
            limitations: vec![
                "NW.js is research-tier and is not advertised as an alpha capability.".to_string(),
                "RPG Maker MV/MZ desktop packages need a separate bounded NW.js contract for process launch, capture timing, and screenshot extraction before this adapter can claim runtime evidence.".to_string(),
                "Use the utsushi-browser adapter for public browser-style smoke validation when a Chromium-compatible host is available.".to_string(),
            ],
        }
    }

    fn trace(&self, _request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
        Err(nwjs_research_tier_error(RuntimeOperation::Trace).into())
    }

    fn capture(&self, _request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
        Err(nwjs_research_tier_error(RuntimeOperation::Capture).into())
    }

    fn smoke_validate(&self, _request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
        Err(nwjs_research_tier_error(RuntimeOperation::SmokeValidation).into())
    }
}

fn nwjs_research_tier_error(operation: RuntimeOperation) -> RuntimeHarnessError {
    RuntimeHarnessError::new(
        RuntimeHarnessErrorKind::ResearchTierUnsupported,
        operation,
        "NW.js launch is research-tier work and is not advertised as an alpha capability.",
    )
    .with_detail("capability", "browser_launch")
    .with_detail("semanticCode", "utsushi.runtime.research_tier_unsupported")
    .with_detail("runtimeTier", "research")
    .with_detail("supersededBy", BrowserLaunchAdapter::NAME)
}

#[cfg(test)]
mod tests;
