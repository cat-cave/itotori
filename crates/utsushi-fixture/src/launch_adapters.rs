use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};
use utsushi_core::{
    ApproximationTier, ControlledPlaybackSession, EvidenceTier, FidelityTier, RuntimeAdapter,
    RuntimeAdapterDescriptor, RuntimeAdapterDiagnostic, RuntimeArtifactKind, RuntimeArtifactRoot,
    RuntimeCapability, RuntimeCapabilityClass, RuntimeCapabilityContract, RuntimeCaptureBoundary,
    RuntimeCaptureContext, RuntimeCaptureHook, RuntimeCaptureHooks, RuntimeCapturedArtifact,
    RuntimeFeatureSupport, RuntimeHarnessError, RuntimeHarnessErrorKind,
    RuntimeLaunchCaptureHarness, RuntimeLaunchCapturePlan, RuntimeLaunchCommand, RuntimeOperation,
    RuntimePlaybackFeature, RuntimeRequest, UtsushiResult,
};

use crate::FIXTURE_OBSERVATION_HOOK_SCHEMA_LITERAL;

use browser_detection::{
    BrowserUnavailabilityReason, ChromiumProbeOutcome, chromium_min_supported_version_string,
    probe_chromium,
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

mod browser_detection {
    //! Bounded Chromium probe used by the browser launch adapter.
    //!
    //! UTSUSHI-148 enforces the orchestrator's "no optionality on claimed
    //! inputs" architectural commitment for MV/MZ alpha: probe outcomes
    //! categorize environmental misconfiguration with typed semantic codes
    //! in the engine-neutral `utsushi.browser.*` namespace, never silent
    //! skips.

    use std::env;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    use utsushi_core::RuntimeHarnessErrorKind;

    pub(super) const BROWSER_CANDIDATES: &[&str] = &[
        "chromium",
        "chromium-browser",
        "google-chrome",
        "google-chrome-stable",
        "chrome",
        "msedge",
        "microsoft-edge",
        "brave-browser",
    ];

    #[cfg(target_os = "macos")]
    pub(super) const BROWSER_PLATFORM_PATHS: &[&str] = &[
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/opt/homebrew/bin/chromium",
        "/opt/homebrew/bin/google-chrome",
    ];

    #[cfg(target_os = "windows")]
    pub(super) const BROWSER_PLATFORM_PATHS: &[&str] = &[];

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    pub(super) const BROWSER_PLATFORM_PATHS: &[&str] = &[];

    /// Minimum supported Chromium major version. The 100 floor tracks the
    /// `--headless=new` flag introduction (Chromium 109 formally, accepted
    /// from earlier builds; the 100 floor gives a safe margin). The choice
    /// of a major-version floor (not a full semver match) is documented in
    /// the descriptor limitation list.
    pub(super) const CHROMIUM_MIN_SUPPORTED_MAJOR: u32 = 100;

    pub(super) fn chromium_min_supported_version_string() -> &'static str {
        "100.0.0"
    }

    /// Bounded version-probe timeout. `<binary> --version` should complete
    /// in tens of milliseconds; a wedged binary cannot block descriptor
    /// evaluation longer than this floor.
    const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(2);

    #[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
    pub(super) enum ChromiumVersion {
        Parsed {
            major: u32,
            minor: u32,
            patch: u32,
        },
        #[default]
        Unknown,
    }

    impl ChromiumVersion {
        pub(super) fn major(self) -> Option<u32> {
            match self {
                Self::Parsed { major, .. } => Some(major),
                Self::Unknown => None,
            }
        }

        pub(super) fn version_string(self) -> String {
            match self {
                Self::Parsed {
                    major,
                    minor,
                    patch,
                } => format!("{major}.{minor}.{patch}"),
                Self::Unknown => "unknown".to_string(),
            }
        }
    }

    #[derive(Clone, Debug)]
    pub(super) struct ChromiumProbeOutcome {
        pub(super) program: PathBuf,
        pub(super) source: BrowserDetectionLabel,
        pub(super) version: ChromiumVersion,
    }

    impl ChromiumProbeOutcome {
        pub(super) fn source_label(&self) -> &'static str {
            self.source.as_str()
        }

        pub(super) fn version_string(&self) -> String {
            self.version.version_string()
        }
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    pub(super) enum BrowserUnavailabilityReason {
        NoBinaryFound {
            source: BrowserDetectionLabel,
            candidates_tried: usize,
        },
        VersionMismatch {
            source: BrowserDetectionLabel,
            detected: ChromiumVersion,
            required_major: u32,
        },
        /// No usable display surface under strict display checking
        /// (UTSUSHI-162). Produced by [`probe_display`] when the operator
        /// opts into the `UTSUSHI_STRICT_DISPLAY` activation gate and the
        /// host exposes no X11/Wayland display env var on a platform that
        /// uses that convention. Off by default, so the headless-only
        /// UTSUSHI-148 path is unchanged.
        DisplayUnavailable {
            source: BrowserDetectionLabel,
            platform: &'static str,
            probe: DisplayProbeOutcome,
        },
    }

    impl BrowserUnavailabilityReason {
        pub(super) fn semantic_code(&self) -> &'static str {
            match self {
                Self::NoBinaryFound { .. } => "utsushi.browser.chromium_unavailable",
                Self::VersionMismatch { .. } => "utsushi.browser.chromium_version_mismatch",
                Self::DisplayUnavailable { .. } => "utsushi.browser.display_unavailable",
            }
        }

        pub(super) fn harness_error_kind(&self) -> RuntimeHarnessErrorKind {
            match self {
                Self::NoBinaryFound { .. } => RuntimeHarnessErrorKind::ChromiumUnavailable,
                Self::VersionMismatch { .. } => RuntimeHarnessErrorKind::ChromiumVersionMismatch,
                Self::DisplayUnavailable { .. } => {
                    RuntimeHarnessErrorKind::ChromiumDisplayUnavailable
                }
            }
        }

        pub(super) fn source_label(&self) -> &'static str {
            match self {
                Self::NoBinaryFound { source, .. }
                | Self::VersionMismatch { source, .. }
                | Self::DisplayUnavailable { source, .. } => source.as_str(),
            }
        }

        pub(super) fn diagnostic_message(&self) -> String {
            match self {
                Self::NoBinaryFound { source, .. } => match source {
                    BrowserDetectionLabel::ConfiguredUnavailable => {
                        "Configured browser executable is not launchable; \
                         update the adapter configuration or install Chromium."
                            .to_string()
                    }
                    BrowserDetectionLabel::EnvironmentUnavailable => {
                        "UTSUSHI_BROWSER_BIN is set but does not resolve to a launchable Chromium-compatible executable."
                            .to_string()
                    }
                    _ => "No Chromium-compatible browser executable detected; \
                          install Chromium/Chrome or set UTSUSHI_BROWSER_BIN."
                        .to_string(),
                },
                Self::VersionMismatch {
                    detected,
                    required_major,
                    ..
                } => format!(
                    "Detected Chromium {detected} is below the minimum supported major version {required_major}.",
                    detected = detected.version_string(),
                ),
                Self::DisplayUnavailable { platform, .. } => format!(
                    "No usable display surface detected on {platform} under strict display checking."
                ),
            }
        }
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(super) enum DisplayProbeOutcome {
        /// Display env vars present (X11/Wayland session). Headless launch
        /// nonetheless proceeds with `--headless=new --disable-gpu --no-sandbox`.
        PresentEnv,
        /// No display env vars present but the adapter operates headlessly,
        /// so launch is not gated.
        HeadlessOnly,
        /// Strict display checking explicitly enabled and no usable surface
        /// detected. Produced under the `UTSUSHI_STRICT_DISPLAY` gate.
        UnavailableStrict,
    }

    impl DisplayProbeOutcome {
        pub(super) fn as_str(self) -> &'static str {
            match self {
                Self::PresentEnv => "present_env",
                Self::HeadlessOnly => "headless_only",
                Self::UnavailableStrict => "unavailable_strict",
            }
        }
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(super) enum BrowserDetectionLabel {
        Configured,
        ConfiguredUnavailable,
        Environment,
        EnvironmentUnavailable,
        Path,
        PlatformPath,
        Unavailable,
        VersionUnsupported,
    }

    impl BrowserDetectionLabel {
        pub(super) fn as_str(self) -> &'static str {
            match self {
                Self::Configured => "configured",
                Self::ConfiguredUnavailable => "configured_unavailable",
                Self::Environment => "environment",
                Self::EnvironmentUnavailable => "environment_unavailable",
                Self::Path => "path",
                Self::PlatformPath => "platform_path",
                Self::Unavailable => "unavailable",
                Self::VersionUnsupported => "version_unsupported",
            }
        }
    }

    /// Probe the host for a Chromium-compatible launcher and verify its
    /// reported `--version` is above the minimum supported major. The probe
    /// is bounded and does not produce runtime evidence.
    pub(super) fn probe_chromium(
        configured: Option<&Path>,
        version_override: Option<ChromiumVersion>,
    ) -> Result<ChromiumProbeOutcome, BrowserUnavailabilityReason> {
        // 1. Resolve a binary candidate against the configured/env/PATH/platform
        //    order documented in the descriptor limitation list.
        let Some((program, source)) = resolve_binary_candidate(configured) else {
            // candidates_tried = configured + env probe + PATH candidates
            // + platform paths (all attempted unsuccessfully)
            let tried = 1 // env (if absent it still counts as one slot inspected)
                + BROWSER_CANDIDATES.len()
                + BROWSER_PLATFORM_PATHS.len();
            let source = if configured.is_some() {
                BrowserDetectionLabel::ConfiguredUnavailable
            } else if env::var_os("UTSUSHI_BROWSER_BIN").is_some() {
                BrowserDetectionLabel::EnvironmentUnavailable
            } else {
                BrowserDetectionLabel::Unavailable
            };
            return Err(BrowserUnavailabilityReason::NoBinaryFound {
                source,
                candidates_tried: tried,
            });
        };

        // 2. Bounded version probe. Tests may inject a deterministic version
        //    to exercise the mismatch comparison below without spawning the
        //    real `<binary> --version` shell-out (which can race/time out
        //    under concurrent load); production always passes `None` and thus
        //    shells out to the resolved binary.
        let version = version_override
            .unwrap_or_else(|| probe_version(&program).unwrap_or(ChromiumVersion::Unknown));
        if let Some(major) = version.major()
            && major < CHROMIUM_MIN_SUPPORTED_MAJOR
        {
            return Err(BrowserUnavailabilityReason::VersionMismatch {
                source: BrowserDetectionLabel::VersionUnsupported,
                detected: version,
                required_major: CHROMIUM_MIN_SUPPORTED_MAJOR,
            });
        }

        // 3. Strict-display gate (UTSUSHI-162). Under the UTSUSHI_STRICT_DISPLAY
        //    activation gate the probe requires a usable display surface and
        //    emits DisplayUnavailable when none is detected. With the gate off
        //    (default) this is a no-op headless-only outcome, so the UTSUSHI-148
        //    headless launch path is unchanged.
        probe_display(source)?;

        Ok(ChromiumProbeOutcome {
            program,
            source,
            version,
        })
    }

    /// Activation-gate env var for strict display checking (UTSUSHI-162).
    /// Absent / falsey (unset, `""`, `0`, `false`, `off`) leaves the
    /// headless-only UTSUSHI-148 behavior untouched: no display env var is
    /// NOT an error. Truthy opts the operator into requiring a usable
    /// display surface, so a CI runner with a broken/absent display gets a
    /// typed `utsushi.browser.display_unavailable` diagnostic instead of a
    /// silent headless launch.
    const STRICT_DISPLAY_ENV: &str = "UTSUSHI_STRICT_DISPLAY";

    /// X11/Wayland session env vars whose presence signals a usable display
    /// surface on platforms that use that convention (Linux/BSD).
    const DISPLAY_ENV_VARS: &[&str] = &["WAYLAND_DISPLAY", "DISPLAY"];

    pub(super) fn strict_display_enabled() -> bool {
        env_flag_enabled(STRICT_DISPLAY_ENV)
    }

    fn env_flag_enabled(name: &str) -> bool {
        match env::var(name) {
            Ok(value) => {
                let trimmed = value.trim();
                !trimmed.is_empty()
                    && !trimmed.eq_ignore_ascii_case("0")
                    && !trimmed.eq_ignore_ascii_case("false")
                    && !trimmed.eq_ignore_ascii_case("off")
            }
            Err(_) => false,
        }
    }

    fn display_env_present() -> bool {
        DISPLAY_ENV_VARS
            .iter()
            .any(|name| env::var(name).is_ok_and(|value| !value.trim().is_empty()))
    }

    fn display_platform() -> &'static str {
        if cfg!(target_os = "macos") {
            "macos"
        } else if cfg!(target_os = "windows") {
            "windows"
        } else if cfg!(target_os = "linux") {
            "linux"
        } else {
            "unix"
        }
    }

    /// Whether the current platform advertises a usable display through the
    /// X11/Wayland `DISPLAY`/`WAYLAND_DISPLAY` env-var convention. macOS and
    /// Windows expose a native window server whose availability those env
    /// vars do not describe, so strict env-based checking cannot prove the
    /// surface is absent there and must not false-positive.
    fn platform_uses_display_env() -> bool {
        cfg!(all(unix, not(target_os = "macos")))
    }

    /// Real strict-display probe (UTSUSHI-162). Reads the activation gate and
    /// the host display env, then decides via [`evaluate_display`].
    pub(super) fn probe_display(
        source: BrowserDetectionLabel,
    ) -> Result<DisplayProbeOutcome, BrowserUnavailabilityReason> {
        evaluate_display(
            strict_display_enabled(),
            display_env_present(),
            platform_uses_display_env(),
            source,
            display_platform(),
        )
    }

    /// Pure strict-display decision, separated from the env reads in
    /// [`probe_display`] so the policy is exercised deterministically without
    /// process-env mutation.
    ///
    /// - A present display surface is always usable (`PresentEnv`).
    /// - Gate off keeps the headless-only default (`HeadlessOnly`); absence of
    ///   a display is never an error, preserving UTSUSHI-148 behavior.
    /// - Gate on with no display: on env-convention platforms this is a hard
    ///   [`BrowserUnavailabilityReason::DisplayUnavailable`]; on native-window
    ///   platforms the env signal is inapplicable, so it stays `PresentEnv`.
    pub(super) fn evaluate_display(
        strict: bool,
        display_present: bool,
        platform_uses_display_env: bool,
        source: BrowserDetectionLabel,
        platform: &'static str,
    ) -> Result<DisplayProbeOutcome, BrowserUnavailabilityReason> {
        if display_present {
            return Ok(DisplayProbeOutcome::PresentEnv);
        }
        if !strict {
            return Ok(DisplayProbeOutcome::HeadlessOnly);
        }
        if !platform_uses_display_env {
            return Ok(DisplayProbeOutcome::PresentEnv);
        }
        Err(BrowserUnavailabilityReason::DisplayUnavailable {
            source,
            platform,
            probe: DisplayProbeOutcome::UnavailableStrict,
        })
    }

    fn resolve_binary_candidate(
        configured: Option<&Path>,
    ) -> Option<(PathBuf, BrowserDetectionLabel)> {
        if let Some(path) = configured {
            if is_launchable_file(path) {
                return Some((path.to_path_buf(), BrowserDetectionLabel::Configured));
            }
            return None;
        }
        if let Ok(program) = env::var("UTSUSHI_BROWSER_BIN") {
            return resolve_program_candidate(&program)
                .map(|path| (path, BrowserDetectionLabel::Environment));
        }
        for candidate in BROWSER_CANDIDATES {
            if let Some(path) = resolve_program_candidate(candidate) {
                return Some((path, BrowserDetectionLabel::Path));
            }
        }
        for candidate in BROWSER_PLATFORM_PATHS {
            if is_launchable_file(Path::new(candidate)) {
                return Some((
                    PathBuf::from(*candidate),
                    BrowserDetectionLabel::PlatformPath,
                ));
            }
        }
        None
    }

    /// Bounded `<binary> --version` probe. Returns `None` on spawn failure,
    /// non-zero exit, output that does not parse, or timeout.
    fn probe_version(program: &Path) -> Option<ChromiumVersion> {
        let mut child = Command::new(program)
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .ok()?;

        let started = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_status)) => break,
                Ok(None) => {
                    if started.elapsed() >= VERSION_PROBE_TIMEOUT {
                        let _ = child.kill();
                        let _ = child.wait();
                        return None;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(_) => return None,
            }
        }

        let output = child.wait_with_output().ok()?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        parse_chromium_version(stdout.as_ref()).or_else(|| parse_chromium_version(stderr.as_ref()))
    }

    /// Parse a Chromium-style `--version` output of the form
    /// `"Chromium 124.0.6367.118 ..."` or `"Google Chrome 124.0.6367.118 ..."`.
    /// Returns `None` if no dotted-number token is found.
    pub(super) fn parse_chromium_version(text: &str) -> Option<ChromiumVersion> {
        for token in text.split_whitespace() {
            let parts: Vec<&str> = token.split('.').collect();
            if parts.len() < 2 {
                continue;
            }
            let parsed: Vec<u32> = parts
                .iter()
                .map(|part| part.parse::<u32>().ok())
                .take_while(Option::is_some)
                .map(Option::unwrap)
                .collect();
            if parsed.len() < 2 {
                continue;
            }
            return Some(ChromiumVersion::Parsed {
                major: parsed[0],
                minor: parsed[1],
                patch: parsed.get(2).copied().unwrap_or(0),
            });
        }
        None
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

    /// Test-only constructor for the `DisplayUnavailable` variant. The real
    /// probe ([`probe_display`]) now produces this variant under the
    /// `UTSUSHI_STRICT_DISPLAY` gate; this helper builds a deterministic
    /// instance so the wiring smoke test can assert the semantic-code /
    /// harness-kind contract without depending on host env.
    #[cfg(test)]
    pub(super) fn force_display_unavailable() -> BrowserUnavailabilityReason {
        BrowserUnavailabilityReason::DisplayUnavailable {
            source: BrowserDetectionLabel::Path,
            platform: "test",
            probe: DisplayProbeOutcome::UnavailableStrict,
        }
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

fn browser_capability_contract() -> RuntimeCapabilityContract {
    RuntimeCapabilityContract::new(
        RuntimeCapabilityClass::LaunchCapture,
        FidelityTier::LayoutProbe,
        EvidenceTier::E2,
        vec![
            RuntimeFeatureSupport::partial(
                RuntimePlaybackFeature::Launch,
                EvidenceTier::E1,
                "Launches browser-style runtime entrypoints through a bounded Chromium-compatible process. Required for MV/MZ alpha runtime evidence; a supported host environment must provide Chromium.",
                vec![
                    "Chromium binary is mandatory: PATH lookup or UTSUSHI_BROWSER_BIN. Absence is a hard utsushi.browser.chromium_unavailable error.".to_string(),
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
                    "Chromium-compatible --screenshot behaviour is part of the required launch contract.".to_string(),
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
            RuntimeFeatureSupport::partial(
                RuntimePlaybackFeature::InstrumentationHooks,
                EvidenceTier::E2,
                "Emits browser launch observation hook envelopes for text reachability and screenshot frame evidence.",
                vec![
                    "Hook events are produced by the launch adapter envelope and are not injected RPG Maker runtime callbacks."
                        .to_string(),
                ],
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
            "No raw local screenshot path is exposed in runtime evidence reports.".to_string(),
            "Chromium browser launch is required for MV/MZ alpha runtime evidence; supported host environments must provide Chromium on PATH or through UTSUSHI_BROWSER_BIN.".to_string(),
            "Environmental misconfiguration (missing/incompatible Chromium, unavailable display) is a hard error with semantic codes in the utsushi.browser.* namespace.".to_string(),
        ],
    )
}

fn nwjs_research_tier_contract() -> RuntimeCapabilityContract {
    RuntimeCapabilityContract::new(
        RuntimeCapabilityClass::StaticTrace,
        FidelityTier::TraceOnly,
        EvidenceTier::E1,
        vec![
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::Launch,
                "NW.js launch is research-tier; the harness has no stable NW.js process or capture contract.",
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::TextTrace,
                "NW.js text tracing is research-tier and requires RPG Maker runtime instrumentation hooks.",
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::FrameCapture,
                "NW.js screenshot capture is research-tier.",
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::Screenshot,
                "NW.js screenshot capture is research-tier.",
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::BranchDiscovery,
                "NW.js branch discovery is research-tier and requires runtime instrumentation hooks.",
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::Jump,
                "NW.js jump control is research-tier and requires runtime instrumentation hooks.",
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::Snapshot,
                "NW.js snapshot support is research-tier.",
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::Recording,
                "NW.js recording support is research-tier.",
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::InstrumentationHooks,
                "NW.js instrumentation hooks are research-tier.",
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::VmStateInspection,
                "NW.js VM state inspection is research-tier.",
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::ReferenceComparison,
                "NW.js reference-runtime comparison is research-tier.",
            ),
            RuntimeFeatureSupport::unsupported(
                RuntimePlaybackFeature::StaticTrace,
                "NW.js fallback is a research-tier capability diagnostic and does not emit static runtime evidence.",
            ),
        ],
        vec![
            "NW.js is research-tier and not advertised as an alpha capability; capability output reports the research-tier status under utsushi.runtime.research_tier_unsupported.".to_string(),
        ],
    )
}

struct BrowserReportInput {
    operation: RuntimeOperation,
    fidelity_tier: FidelityTier,
    evidence_tier: EvidenceTier,
    trace_events: Vec<Value>,
    observation_events: Vec<Value>,
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
        observation_events,
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

    // Only claim a layout-probe approximation when the launch actually
    // observed bridge-linked runtime events. A launch that produced no
    // instrumented DOM (the strict-proof negative control) makes no
    // approximation claim rather than an empty, invalid one.
    let approximations = if affected_bridge_unit_refs.is_empty() {
        Vec::new()
    } else {
        vec![json!({
            "approximationId": BROWSER_APPROXIMATION_ID,
            "approximationTier": ApproximationTier::LayoutProbe.as_str(),
            "scope": "browser launch adapter",
            "description": "Browser launch/capture proves bounded entrypoint reachability and screenshot production, but not RPG Maker scene instrumentation or reference-runtime fidelity.",
            "affectedBridgeUnitRefs": affected_bridge_unit_refs,
            "evidenceTierCeiling": evidence_tier.as_str()
        })]
    };

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
        "observationHookEvents": observation_events,
        "branchEvents": [],
        "captures": captures,
        "recordings": [],
        "approximations": approximations,
        "validationFindings": [],
        "referenceComparisons": [],
        "limitations": limitations
    })
}

/// Extract the observation island the fixture's runtime script injected into
/// the live post-render DOM, returning the decoded `events` array. Any DOM
/// without a well-formed island (JS never ran, render produced nothing, or the
/// caller passed a static source read) yields an empty vector — the
/// strict-proof negative control.
fn parse_observed_dom(dom: &str) -> Vec<Value> {
    let Some(start) = dom.find(OBSERVED_ISLAND_BEGIN) else {
        return Vec::new();
    };
    let after = &dom[start + OBSERVED_ISLAND_BEGIN.len()..];
    let Some(end) = after.find(OBSERVED_ISLAND_END) else {
        return Vec::new();
    };
    let json = after[..end].trim();
    let Ok(parsed) = serde_json::from_str::<Value>(json) else {
        return Vec::new();
    };
    parsed
        .get("events")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// Turn the observed DOM events into `(traceEvents, observationHookEvents)`.
///
/// The observed surface spans the RPG Maker MV/MZ runtime event kinds the
/// public fixture emits from a live render:
/// - `text` -> a trace event AND a text observation hook event,
/// - `choice` -> a choice observation hook event,
/// - `scene` -> a scene observation hook event (SceneManager/map transition),
/// - `branch` -> a branch observation hook event (conditional-branch routing).
///
/// `scene` and `branch` are carried by the existing observation-hook envelope
/// (`ObservationScenePayload` / `ObservationBranchPayload`); no schema change is
/// required to observe them beyond the UTSUSHI-102 text+choice surface.
fn build_observed_events(
    descriptor: &RuntimeAdapterDescriptor,
    source: &Value,
    observed: &[Value],
) -> (Vec<Value>, Vec<Value>) {
    let mut trace_events = Vec::new();
    let mut observation_events = Vec::new();
    for (index, event) in observed.iter().enumerate() {
        match event.get("kind").and_then(Value::as_str) {
            Some("text") => {
                if let Some(hook) = observed_text_hook_event(descriptor, source, index, event) {
                    observation_events.push(hook);
                }
                if let Some(trace) = observed_trace_event(source, index, event) {
                    trace_events.push(trace);
                }
            }
            Some("choice") => {
                if let Some(hook) = observed_choice_hook_event(descriptor, source, index, event) {
                    observation_events.push(hook);
                }
            }
            Some("scene") => {
                if let Some(hook) = observed_scene_hook_event(descriptor, source, index, event) {
                    observation_events.push(hook);
                }
            }
            Some("branch") => {
                if let Some(hook) = observed_branch_hook_event(descriptor, source, index, event) {
                    observation_events.push(hook);
                }
            }
            _ => {}
        }
    }
    (trace_events, observation_events)
}

/// Deterministic event id derived from the fixed observation-id base and the
/// observed event's position in the live DOM stream.
fn observed_event_id(index: usize) -> String {
    format!("019ed050-0000-7000-8000-0000000072{index:02}")
}

fn observed_trace_id(index: usize) -> String {
    format!("019ed050-0000-7000-8000-0000000073{index:02}")
}

/// Build a bridge reference linking an observed runtime unit key back to the
/// source unit (and therefore its bridge unit id) it corresponds to. Falls
/// back to a runtime-object reference when the key is unknown so the envelope
/// always identifies *something*.
fn observed_bridge_ref(source: &Value, unit_key: Option<&str>) -> Value {
    if let Some(unit_key) = unit_key {
        if let Some(units) = source["units"].as_array()
            && let Some(position) = units
                .iter()
                .position(|unit| unit["sourceUnitKey"].as_str() == Some(unit_key))
        {
            return json!({
                "bridgeUnitId": super::legacy_fixture_id("bridge-unit", position + 1),
                "sourceUnitKey": unit_key,
            });
        }
        return json!({ "sourceUnitKey": unit_key });
    }
    json!({ "runtimeObjectId": "utsushi:observed:unbound" })
}

fn observed_text_hook_event(
    descriptor: &RuntimeAdapterDescriptor,
    source: &Value,
    index: usize,
    observed: &Value,
) -> Option<Value> {
    let text = observed.get("text").and_then(Value::as_str)?;
    let unit_key = observed.get("unitKey").and_then(Value::as_str);
    Some(json!({
        "schemaVersion": FIXTURE_OBSERVATION_HOOK_SCHEMA_LITERAL,
        "eventId": observed_event_id(index),
        "observedAt": "2026-06-17T00:00:00.000Z",
        "eventKind": "text",
        "runtimeTargetId": super::runtime_target_id(source),
        "adapterId": super::adapter_id_value(descriptor),
        "evidenceTier": EvidenceTier::E1.as_str(),
        "observationSource": OBSERVATION_SOURCE_LIVE_DOM,
        "environment": browser_environment_value(source),
        "sourceRevision": super::source_revision_value(source),
        "bridgeRefs": [observed_bridge_ref(source, unit_key)],
        "redaction": {"status": "not_required"},
        "payload": {
            "payloadKind": "text",
            "text": text,
            "speaker": observed.get("speaker").and_then(Value::as_str),
            "textSurface": observed.get("textSurface").and_then(Value::as_str),
        },
    }))
}

fn observed_choice_hook_event(
    descriptor: &RuntimeAdapterDescriptor,
    source: &Value,
    index: usize,
    observed: &Value,
) -> Option<Value> {
    let raw_options = observed.get("options").and_then(Value::as_array)?;
    let mut options = Vec::new();
    for (option_index, option) in raw_options.iter().enumerate() {
        let label = option.get("label").and_then(Value::as_str)?;
        let option_id = option
            .get("optionId")
            .and_then(Value::as_str)
            .map_or_else(|| format!("opt-{option_index}"), str::to_string);
        let unit_key = option.get("unitKey").and_then(Value::as_str);
        options.push(json!({
            "optionId": option_id,
            "label": label,
            "bridgeRef": observed_bridge_ref(source, unit_key),
        }));
    }
    if options.is_empty() {
        return None;
    }
    let unit_key = observed.get("unitKey").and_then(Value::as_str);
    Some(json!({
        "schemaVersion": FIXTURE_OBSERVATION_HOOK_SCHEMA_LITERAL,
        "eventId": observed_event_id(index),
        "observedAt": "2026-06-17T00:00:00.000Z",
        "eventKind": "choice",
        "runtimeTargetId": super::runtime_target_id(source),
        "adapterId": super::adapter_id_value(descriptor),
        "evidenceTier": EvidenceTier::E1.as_str(),
        "observationSource": OBSERVATION_SOURCE_LIVE_DOM,
        "environment": browser_environment_value(source),
        "sourceRevision": super::source_revision_value(source),
        "bridgeRefs": [observed_bridge_ref(source, unit_key)],
        "redaction": {"status": "not_required"},
        "payload": {
            "payloadKind": "choice",
            "prompt": observed.get("prompt").and_then(Value::as_str),
            "options": options,
        },
    }))
}

/// A scene/map-transition observation hook event. RPG Maker MV/MZ drives play
/// through `SceneManager` scene changes (`Scene_Map`, `Scene_Battle`, ...); the
/// live `Window_MapName` display name (`sceneName`) is a runtime-only string
/// that determines which message stream is active. Carried by the schema's
/// `ObservationScenePayload` (`payloadKind: "scene"`).
fn observed_scene_hook_event(
    descriptor: &RuntimeAdapterDescriptor,
    source: &Value,
    index: usize,
    observed: &Value,
) -> Option<Value> {
    let scene_id = observed.get("sceneId").and_then(Value::as_str)?;
    let unit_key = observed.get("unitKey").and_then(Value::as_str);
    Some(json!({
        "schemaVersion": FIXTURE_OBSERVATION_HOOK_SCHEMA_LITERAL,
        "eventId": observed_event_id(index),
        "observedAt": "2026-06-17T00:00:00.000Z",
        "eventKind": "scene",
        "runtimeTargetId": super::runtime_target_id(source),
        "adapterId": super::adapter_id_value(descriptor),
        "evidenceTier": EvidenceTier::E1.as_str(),
        "observationSource": OBSERVATION_SOURCE_LIVE_DOM,
        "environment": browser_environment_value(source),
        "sourceRevision": super::source_revision_value(source),
        "bridgeRefs": [observed_bridge_ref(source, unit_key)],
        "redaction": {"status": "not_required"},
        "payload": {
            "payloadKind": "scene",
            "sceneId": scene_id,
            "sceneName": observed.get("sceneName").and_then(Value::as_str),
        },
    }))
}

/// A conditional-branch/route observation hook event. RPG Maker MV/MZ routes
/// play through Conditional Branch (event command 111) and choice-driven jumps;
/// the branch `label`/`destination` actually `taken` at runtime is the
/// structural spine downstream context-building consumes. Carried by the
/// schema's `ObservationBranchPayload` (`payloadKind: "branch"`).
fn observed_branch_hook_event(
    descriptor: &RuntimeAdapterDescriptor,
    source: &Value,
    index: usize,
    observed: &Value,
) -> Option<Value> {
    let branch_id = observed.get("branchId").and_then(Value::as_str)?;
    let unit_key = observed.get("unitKey").and_then(Value::as_str);
    Some(json!({
        "schemaVersion": FIXTURE_OBSERVATION_HOOK_SCHEMA_LITERAL,
        "eventId": observed_event_id(index),
        "observedAt": "2026-06-17T00:00:00.000Z",
        "eventKind": "branch",
        "runtimeTargetId": super::runtime_target_id(source),
        "adapterId": super::adapter_id_value(descriptor),
        "evidenceTier": EvidenceTier::E1.as_str(),
        "observationSource": OBSERVATION_SOURCE_LIVE_DOM,
        "environment": browser_environment_value(source),
        "sourceRevision": super::source_revision_value(source),
        "bridgeRefs": [observed_bridge_ref(source, unit_key)],
        "redaction": {"status": "not_required"},
        "payload": {
            "payloadKind": "branch",
            "branchId": branch_id,
            "label": observed.get("label").and_then(Value::as_str),
            "destination": observed.get("destination").and_then(Value::as_str),
            "taken": observed.get("taken").and_then(Value::as_bool),
        },
    }))
}

fn observed_trace_event(source: &Value, index: usize, observed: &Value) -> Option<Value> {
    let text = observed.get("text").and_then(Value::as_str)?;
    let unit_key = observed.get("unitKey").and_then(Value::as_str)?;
    Some(json!({
        "traceEventId": observed_trace_id(index),
        "eventKind": "text_observed",
        "bridgeUnitRef": observed_bridge_ref(source, Some(unit_key)),
        "frame": index + 1,
        "traceKey": unit_key,
        "observedText": text,
        "observationSource": OBSERVATION_SOURCE_LIVE_DOM,
    }))
}

fn browser_text_observation_hook_event(
    descriptor: &RuntimeAdapterDescriptor,
    source: &Value,
    unit: &Value,
    evidence_tier: EvidenceTier,
) -> UtsushiResult<Value> {
    let bridge_ref_value = super::observation_bridge_ref_value(unit, 1)?;
    Ok(json!({
        "schemaVersion": FIXTURE_OBSERVATION_HOOK_SCHEMA_LITERAL,
        "eventId": BROWSER_OBSERVATION_TEXT_ID,
        "observedAt": "2026-06-17T00:00:00.000Z",
        "eventKind": "text",
        "runtimeTargetId": super::runtime_target_id(source),
        "adapterId": super::adapter_id_value(descriptor),
        "evidenceTier": evidence_tier.as_str(),
        "observationSource": OBSERVATION_SOURCE_FIXTURE_DECLARED,
        "environment": browser_environment_value(source),
        "sourceRevision": super::source_revision_value(source),
        "bridgeRefs": [bridge_ref_value],
        "redaction": {"status": "not_required"},
        "payload": {
            "payloadKind": "text",
            "text": unit["targetText"]
                .as_str()
                .or_else(|| unit["sourceText"].as_str())
                .unwrap_or(""),
            "speaker": unit["speaker"].as_str(),
            "textSurface": unit["textSurface"].as_str(),
        },
    }))
}

fn browser_frame_observation_hook_event(
    descriptor: &RuntimeAdapterDescriptor,
    source: &Value,
    unit: &Value,
    screenshot: &RuntimeCapturedArtifact,
) -> UtsushiResult<Value> {
    let bridge_ref_value = super::observation_bridge_ref_value(unit, 1)?;
    Ok(json!({
        "schemaVersion": FIXTURE_OBSERVATION_HOOK_SCHEMA_LITERAL,
        "eventId": BROWSER_OBSERVATION_FRAME_ID,
        "observedAt": "2026-06-17T00:00:00.000Z",
        "eventKind": "frame",
        "runtimeTargetId": super::runtime_target_id(source),
        "adapterId": super::adapter_id_value(descriptor),
        "evidenceTier": EvidenceTier::E2.as_str(),
        "environment": browser_environment_value(source),
        "sourceRevision": super::source_revision_value(source),
        "bridgeRefs": [bridge_ref_value],
        "redaction": {"status": "not_required"},
        "payload": {
            "payloadKind": "frame",
            "frame": 1,
            "width": BROWSER_VIEWPORT_WIDTH,
            "height": BROWSER_VIEWPORT_HEIGHT,
            "artifactRef": screenshot.artifact_ref_json(),
        },
    }))
}

fn browser_environment_value(source: &Value) -> Value {
    json!({
        "runtime": "browser",
        "engine": "browser-smoke-fixture",
        "platform": env::consts::OS,
        "display": "browser-headless",
        "locale": source["sourceLocale"].as_str(),
    })
}

fn browser_features_used(operation: RuntimeOperation) -> Vec<RuntimePlaybackFeature> {
    match operation {
        RuntimeOperation::Trace => {
            vec![
                RuntimePlaybackFeature::Launch,
                RuntimePlaybackFeature::TextTrace,
                RuntimePlaybackFeature::InstrumentationHooks,
            ]
        }
        RuntimeOperation::Capture | RuntimeOperation::SmokeValidation => {
            vec![
                RuntimePlaybackFeature::Launch,
                RuntimePlaybackFeature::TextTrace,
                RuntimePlaybackFeature::Screenshot,
                RuntimePlaybackFeature::FrameCapture,
                RuntimePlaybackFeature::InstrumentationHooks,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::{
        Mutex, MutexGuard,
        atomic::{AtomicU64, Ordering},
    };

    static TEST_TEMP_DIR_COUNTER: AtomicU64 = AtomicU64::new(0);
    static BROWSER_PROBE_ENV_LOCK: Mutex<()> = Mutex::new(());

    fn lock_browser_probe_env() -> MutexGuard<'static, ()> {
        BROWSER_PROBE_ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn supported_test_chromium_version() -> super::browser_detection::ChromiumVersion {
        super::browser_detection::ChromiumVersion::Parsed {
            major: 124,
            minor: 0,
            patch: 6367,
        }
    }

    #[cfg(unix)]
    fn fake_browser_adapter(fake_browser: PathBuf) -> BrowserLaunchAdapter {
        BrowserLaunchAdapter::with_browser_program_and_version(
            fake_browser,
            supported_test_chromium_version(),
        )
    }

    fn temp_dir(name: &str) -> PathBuf {
        let nonce = TEST_TEMP_DIR_COUNTER.fetch_add(1, Ordering::Relaxed);
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
        let _browser_env = lock_browser_probe_env();
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
        assert!(
            descriptor
                .capability_contract
                .features
                .iter()
                .any(
                    |feature| feature.feature == RuntimePlaybackFeature::InstrumentationHooks
                        && feature.status == utsushi_core::RuntimeFeatureStatus::Partial
                        && feature.evidence_tier_ceiling == Some(EvidenceTier::E2)
                )
        );
        assert!(
            descriptor
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.diagnostic_kind == "browser_host_availability")
        );
    }

    #[test]
    fn browser_host_diagnostic_emits_error_severity_when_chromium_absent() {
        let _browser_env = lock_browser_probe_env();
        let root = temp_dir("browser-host-diagnostic");
        let private_missing_browser = root.join("private-browser-bin");
        let adapter = BrowserLaunchAdapter::with_browser_program(private_missing_browser.clone());
        let descriptor = adapter.descriptor();
        let diagnostic = descriptor
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.diagnostic_kind == "browser_host_availability")
            .unwrap()
            .to_json();

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
        let diagnostic_string = serde_json::to_string(&diagnostic).unwrap();
        assert!(!diagnostic_string.contains(root.to_string_lossy().as_ref()));
        assert!(!diagnostic_string.contains(private_missing_browser.to_string_lossy().as_ref()));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn browser_descriptor_capability_contract_marks_browser_launch_as_required_for_mv_mz_alpha() {
        let contract = super::browser_capability_contract();
        let launch_feature = contract
            .features
            .iter()
            .find(|feature| feature.feature == RuntimePlaybackFeature::Launch)
            .expect("Launch feature is present");
        assert!(
            launch_feature
                .description
                .contains("Required for MV/MZ alpha runtime evidence"),
            "Launch feature description must declare alpha requirement: {description}",
            description = launch_feature.description,
        );
        assert!(
            launch_feature
                .limitations
                .iter()
                .any(|limitation| limitation.contains("hard utsushi.browser.chromium_unavailable")),
            "Launch limitations must call out the hard semantic-code outcome: {limitations:?}",
            limitations = launch_feature.limitations,
        );
        assert!(
            contract.limitations.iter().any(|limitation| {
                limitation.contains("required for MV/MZ alpha runtime evidence")
            }),
            "Contract limitations must declare the MV/MZ alpha requirement: {limitations:?}",
            limitations = contract.limitations,
        );
        assert!(
            contract
                .limitations
                .iter()
                .any(|limitation| { limitation.contains("utsushi.browser.* namespace") }),
            "Contract limitations must reference the engine-neutral namespace: {limitations:?}",
            limitations = contract.limitations,
        );
    }

    #[test]
    fn browser_descriptor_omits_when_host_support_exists_optionality_language() {
        let _browser_env = lock_browser_probe_env();
        let adapter = BrowserLaunchAdapter::new();
        let descriptor = adapter.descriptor();
        let serialized = serde_json::to_string(&json!({
            "limitations": descriptor.limitations,
            "capabilityContract": descriptor.capability_contract.to_json(),
        }))
        .unwrap();
        for forbidden in [
            "when host support exists",
            "host-capability dependent",
            "when the host supports",
        ] {
            assert!(
                !serialized.contains(forbidden),
                "descriptor still carries optionality phrase: {forbidden}",
            );
        }
    }

    #[test]
    fn nwjs_descriptor_advertises_research_tier_status_diagnostic() {
        let adapter = NwjsLaunchAdapter::new();
        let descriptor = adapter.descriptor();

        assert_eq!(descriptor.name, NwjsLaunchAdapter::NAME);
        assert!(descriptor.capabilities.is_empty());
        let research_tier_diagnostics: Vec<_> = descriptor
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.diagnostic_kind == "research_tier_status")
            .collect();
        assert_eq!(
            research_tier_diagnostics.len(),
            1,
            "exactly one research_tier_status diagnostic is required"
        );
        let diagnostic = research_tier_diagnostics[0].to_json();
        assert_eq!(diagnostic["status"], "unsupported");
        assert_eq!(diagnostic["severity"], "info");
        assert_eq!(
            diagnostic["details"]["errorCode"],
            "utsushi.runtime.research_tier_unsupported"
        );
        assert_eq!(diagnostic["details"]["runtimeTier"], "research");
        assert_eq!(
            diagnostic["details"]["supersededBy"],
            BrowserLaunchAdapter::NAME
        );
        assert!(
            descriptor
                .capability_contract
                .features
                .iter()
                .all(|feature| feature.status == utsushi_core::RuntimeFeatureStatus::Unsupported)
        );
    }

    #[test]
    fn nwjs_descriptor_limitations_mark_research_tier_explicitly() {
        let adapter = NwjsLaunchAdapter::new();
        let descriptor = adapter.descriptor();
        let first_limitation = descriptor.limitations.first().expect("limitations present");
        assert!(
            first_limitation.contains("research-tier"),
            "first limitation must mark research-tier explicitly: {first_limitation}",
        );
        assert!(
            first_limitation.contains("not advertised as an alpha capability"),
            "first limitation must call out alpha-capability exclusion: {first_limitation}",
        );
    }

    #[cfg(unix)]
    #[test]
    fn browser_smoke_uses_core_harness_and_persists_screenshot_artifact() {
        let _browser_env = lock_browser_probe_env();
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
        let adapter = fake_browser_adapter(fake_browser);

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
        assert_eq!(
            report["observationHookEvents"][0]["schemaVersion"],
            FIXTURE_OBSERVATION_HOOK_SCHEMA_LITERAL
        );
        assert_eq!(report["observationHookEvents"][0]["eventKind"], "text");
        assert_eq!(
            report["observationHookEvents"][0]["environment"]["runtime"],
            "browser"
        );
        assert_eq!(report["observationHookEvents"][1]["eventKind"], "frame");
        let artifact_ref = &report["captures"][0]["artifactRef"];
        assert_eq!(artifact_ref["artifactKind"], "screenshot");
        assert_eq!(
            artifact_ref["uri"],
            format!(
                "artifacts/utsushi/runtime/{BROWSER_RUN_ID}/screenshots/{BROWSER_SCREENSHOT_ID}.png"
            )
        );
        assert_eq!(
            report["observationHookEvents"][1]["payload"]["artifactRef"]["uri"],
            artifact_ref["uri"]
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
        let _browser_env = lock_browser_probe_env();
        let root = temp_dir("browser-root-required");
        write_browser_smoke_fixture(&root);
        let launched_marker = root.join("launched");
        let launched_marker_arg = shell_quote_path(&launched_marker);
        let fake_browser = fake_browser(
            &root,
            &format!(
                r#"#!/bin/sh
set -eu
if [ "$1" = "--version" ]; then
  printf 'Chromium 124.0.6367.118 chromium-headless-shell\n'
  exit 0
fi
printf launched > {launched_marker_arg}
exit 0
"#,
            ),
        );
        let adapter = fake_browser_adapter(fake_browser);

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
        let _browser_env = lock_browser_probe_env();
        let root = temp_dir("browser-missing-screenshot");
        write_browser_smoke_fixture(&root);
        let artifact_root = root.join("runtime-artifacts");
        let fake_browser = fake_browser(
            &root,
            r"#!/bin/sh
set -eu
exit 0
",
        );
        let adapter = fake_browser_adapter(fake_browser);

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

    #[cfg(unix)]
    #[test]
    fn browser_capture_does_not_promote_stale_staging_screenshot() {
        let _browser_env = lock_browser_probe_env();
        let root = temp_dir("browser-stale-screenshot");
        write_browser_smoke_fixture(&root);
        let artifact_root = root.join("runtime-artifacts");
        let stale_path = RuntimeArtifactRoot::new(&artifact_root)
            .prepare_staging_file(BROWSER_RUN_ID, BROWSER_SCREENSHOT_ID, "png")
            .unwrap();
        fs::write(&stale_path, b"\x89PNG\r\n\x1a\nstale screenshot bytes\n").unwrap();
        let fake_browser = fake_browser(
            &root,
            r"#!/bin/sh
set -eu
exit 0
",
        );
        let adapter = fake_browser_adapter(fake_browser);

        let error = adapter
            .capture(&RuntimeRequest::new(&root).with_artifact_root(&artifact_root))
            .unwrap_err();
        let harness_error = error.downcast_ref::<RuntimeHarnessError>().unwrap();

        assert_eq!(harness_error.kind, RuntimeHarnessErrorKind::CaptureFailed);
        assert!(harness_error.message.contains("did not produce"));
        let artifact_uri = utsushi_core::runtime_artifact_uri(
            BROWSER_RUN_ID,
            RuntimeArtifactKind::Screenshot,
            BROWSER_SCREENSHOT_ID,
        )
        .unwrap();
        let artifact_path = RuntimeArtifactRoot::new(&artifact_root)
            .artifact_path(&artifact_uri)
            .unwrap();
        assert!(!artifact_path.exists());
        assert!(!artifact_root.join(".staging").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn browser_run_returns_chromium_unavailable_kind_when_binary_missing() {
        let _browser_env = lock_browser_probe_env();
        let root = temp_dir("browser-binary-missing");
        write_browser_smoke_fixture(&root);
        let artifact_root = root.join("runtime-artifacts");
        let bogus = root.join("does-not-exist-browser");
        let adapter = BrowserLaunchAdapter::with_browser_program(bogus.clone());

        let error = adapter
            .smoke_validate(&RuntimeRequest::new(&root).with_artifact_root(&artifact_root))
            .unwrap_err();
        let harness_error = error.downcast_ref::<RuntimeHarnessError>().unwrap();

        assert_eq!(
            harness_error.kind,
            RuntimeHarnessErrorKind::ChromiumUnavailable
        );
        assert_eq!(harness_error.code(), "runtime_browser_chromium_unavailable");
        let semantic = harness_error
            .details
            .iter()
            .find(|(key, _)| key == "semanticCode")
            .map(|(_, value)| value.as_str());
        assert_eq!(semantic, Some("utsushi.browser.chromium_unavailable"));
        let error_string = serde_json::to_string(&harness_error.to_json()).unwrap();
        assert!(!error_string.contains(bogus.to_string_lossy().as_ref()));
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    // reason: this test mutates process env via the unavoidably unsafe
    // std::env::{set_var,remove_var} (edition 2024) through a scoped EnvGuard.
    // Test-only; src stays unsafe-free.
    #[allow(unsafe_code)]
    fn browser_run_returns_chromium_unavailable_when_env_browser_bin_broken() {
        // Scoped env guard: this test sets UTSUSHI_BROWSER_BIN to a bogus
        // path, asserts the typed semantic outcome, and restores the
        // previous env value on drop. Tests that read browser probe env take
        // BROWSER_PROBE_ENV_LOCK so this scoped mutation cannot leak across
        // parallel test execution.
        struct EnvGuard {
            previous: Option<std::ffi::OsString>,
        }
        impl EnvGuard {
            fn set(value: &str) -> Self {
                let previous = env::var_os("UTSUSHI_BROWSER_BIN");
                // SAFETY: This is a deliberate, scoped mutation for a test
                // that does not run concurrently with other UTSUSHI_BROWSER_BIN
                // consumers.
                unsafe {
                    env::set_var("UTSUSHI_BROWSER_BIN", value);
                }
                Self { previous }
            }
        }
        impl Drop for EnvGuard {
            fn drop(&mut self) {
                // SAFETY: see EnvGuard::set.
                unsafe {
                    match &self.previous {
                        Some(value) => env::set_var("UTSUSHI_BROWSER_BIN", value),
                        None => env::remove_var("UTSUSHI_BROWSER_BIN"),
                    }
                }
            }
        }

        let _browser_env = lock_browser_probe_env();
        let root = temp_dir("browser-env-broken");
        write_browser_smoke_fixture(&root);
        let artifact_root = root.join("runtime-artifacts");
        let bogus = root.join("env-pointed-missing-browser");
        let _guard = EnvGuard::set(bogus.to_string_lossy().as_ref());
        let adapter = BrowserLaunchAdapter::new();

        let error = adapter
            .smoke_validate(&RuntimeRequest::new(&root).with_artifact_root(&artifact_root))
            .unwrap_err();
        let harness_error = error.downcast_ref::<RuntimeHarnessError>().unwrap();

        assert_eq!(
            harness_error.kind,
            RuntimeHarnessErrorKind::ChromiumUnavailable
        );
        let semantic = harness_error
            .details
            .iter()
            .find(|(key, _)| key == "semanticCode")
            .map(|(_, value)| value.as_str());
        assert_eq!(semantic, Some("utsushi.browser.chromium_unavailable"));
        let source = harness_error
            .details
            .iter()
            .find(|(key, _)| key == "browserSource")
            .map(|(_, value)| value.as_str());
        assert_eq!(source, Some("environment_unavailable"));
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn browser_run_returns_chromium_version_mismatch_when_version_too_old() {
        let _browser_env = lock_browser_probe_env();
        let root = temp_dir("browser-version-too-old");
        write_browser_smoke_fixture(&root);
        let artifact_root = root.join("runtime-artifacts");
        // Inject a DETERMINISTIC "too old" Chromium version (major 50 < the
        // supported floor of 100) directly into the probe, so this unit test
        // exercises the version-mismatch comparison logic WITHOUT spawning a
        // real `<binary> --version` shell-out. The prior shell-out variant was
        // intermittently flaky: under full-CI concurrency the `--version` spawn
        // could race/time out against the bounded probe timeout, returning an
        // Unknown version that PASSES the floor and falls through to a real
        // capture launch — surfacing `CaptureFailed` instead of the expected
        // `ChromiumVersionMismatch`. The fake browser's own `--version` here
        // prints a NEWER (passing) version on purpose: if this test ever
        // regressed to the real shell-out it would detect "124.*" and fail,
        // proving the injected value — not a spawned process — drives the
        // outcome. The real shell-out probe stays live for production and is
        // covered by the env-gated real-browser tests.
        let fake_browser = fake_browser(
            &root,
            r#"#!/bin/sh
set -eu
if [ "$1" = "--version" ]; then
  printf 'Chromium 124.0.6367.118 chromium-headless-shell\n'
  exit 0
fi
exit 0
"#,
        );
        let adapter = BrowserLaunchAdapter::with_browser_program_and_version(
            fake_browser,
            super::browser_detection::ChromiumVersion::Parsed {
                major: 50,
                minor: 0,
                patch: 2661,
            },
        );

        let error = adapter
            .smoke_validate(&RuntimeRequest::new(&root).with_artifact_root(&artifact_root))
            .unwrap_err();
        let harness_error = error.downcast_ref::<RuntimeHarnessError>().unwrap();

        assert_eq!(
            harness_error.kind,
            RuntimeHarnessErrorKind::ChromiumVersionMismatch
        );
        assert_eq!(
            harness_error.code(),
            "runtime_browser_chromium_version_mismatch"
        );
        let semantic = harness_error
            .details
            .iter()
            .find(|(key, _)| key == "semanticCode")
            .map(|(_, value)| value.as_str());
        assert_eq!(semantic, Some("utsushi.browser.chromium_version_mismatch"));
        let detected = harness_error
            .details
            .iter()
            .find(|(key, _)| key == "chromiumVersionDetected")
            .map(|(_, value)| value.as_str());
        assert_eq!(detected, Some("50.0.2661"));
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn browser_descriptor_does_not_invoke_browser_launch_during_version_probe() {
        let _browser_env = lock_browser_probe_env();
        let root = temp_dir("browser-probe-only-version");
        let launch_marker = root.join("launched-non-version");
        let launch_marker_arg = shell_quote_path(&launch_marker);
        let fake_browser = fake_browser(
            &root,
            &format!(
                r#"#!/bin/sh
set -eu
if [ "$1" = "--version" ]; then
  printf 'Chromium 124.0.6367.118 chromium-headless-shell\n'
  exit 0
fi
printf launched > {launch_marker_arg}
exit 0
"#,
            ),
        );
        let adapter = BrowserLaunchAdapter::with_browser_program(fake_browser);
        for _ in 0..3 {
            let _ = adapter.descriptor();
        }
        assert!(
            !launch_marker.exists(),
            "descriptor() must only invoke --version on the configured browser"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn browser_descriptor_version_probe_is_bounded_by_timeout() {
        let _browser_env = lock_browser_probe_env();
        let root = temp_dir("browser-probe-sleep");
        let fake_browser = fake_browser(
            &root,
            r#"#!/bin/sh
set -eu
if [ "$1" = "--version" ]; then
  sleep 60
fi
exit 0
"#,
        );
        let adapter = BrowserLaunchAdapter::with_browser_program(fake_browser);

        let started = std::time::Instant::now();
        let descriptor = adapter.descriptor();
        let elapsed = started.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(5),
            "descriptor() must complete under the bounded probe timeout, took {elapsed:?}",
        );
        let diagnostic = descriptor
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.diagnostic_kind == "browser_host_availability")
            .unwrap()
            .to_json();
        // A wedged --version leaves the version Unknown, which still passes
        // the major-version floor (only mismatches < CHROMIUM_MIN_SUPPORTED_MAJOR
        // are rejected); the diagnostic must therefore report available with
        // chromiumVersion == "unknown" so operators can audit the probe.
        assert_eq!(diagnostic["status"], "available");
        assert_eq!(diagnostic["details"]["chromiumVersion"], "unknown");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn nwjs_trace_returns_research_tier_unsupported_semantic_code() {
        let root = temp_dir("nwjs-trace-research");
        let adapter = NwjsLaunchAdapter::new();
        let error = adapter.trace(&RuntimeRequest::new(&root)).unwrap_err();
        let harness_error = error.downcast_ref::<RuntimeHarnessError>().unwrap();
        assert_eq!(
            harness_error.kind,
            RuntimeHarnessErrorKind::ResearchTierUnsupported
        );
        assert_eq!(harness_error.code(), "runtime_research_tier_unsupported");
        let semantic = harness_error
            .details
            .iter()
            .find(|(key, _)| key == "semanticCode")
            .map(|(_, value)| value.as_str());
        assert_eq!(semantic, Some("utsushi.runtime.research_tier_unsupported"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn nwjs_capture_and_smoke_validate_return_research_tier_unsupported() {
        let root = temp_dir("nwjs-capture-research");
        let adapter = NwjsLaunchAdapter::new();
        for op_error in [
            adapter.capture(&RuntimeRequest::new(&root)).unwrap_err(),
            adapter
                .smoke_validate(&RuntimeRequest::new(&root))
                .unwrap_err(),
        ] {
            let harness_error = op_error.downcast_ref::<RuntimeHarnessError>().unwrap();
            assert_eq!(
                harness_error.kind,
                RuntimeHarnessErrorKind::ResearchTierUnsupported
            );
            let semantic = harness_error
                .details
                .iter()
                .find(|(key, _)| key == "semanticCode")
                .map(|(_, value)| value.as_str());
            assert_eq!(semantic, Some("utsushi.runtime.research_tier_unsupported"));
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn reserved_display_unavailable_reason_carries_typed_semantic_code() {
        // Wiring smoke for the DisplayUnavailable variant: pins the semantic
        // code, harness error kind, and detail-attachment contract that the
        // real strict-display probe (UTSUSHI-162) relies on. Uses the
        // deterministic force_display_unavailable constructor so the contract
        // is asserted without depending on host display env.
        let reason = super::browser_detection::force_display_unavailable();
        assert_eq!(
            reason.semantic_code(),
            "utsushi.browser.display_unavailable"
        );
        assert_eq!(
            reason.harness_error_kind(),
            RuntimeHarnessErrorKind::ChromiumDisplayUnavailable
        );
        let harness =
            super::unavailability_harness_error(RuntimeOperation::SmokeValidation, &reason);
        let semantic = harness
            .details
            .iter()
            .find(|(key, _)| key == "semanticCode")
            .map(|(_, value)| value.as_str());
        assert_eq!(semantic, Some("utsushi.browser.display_unavailable"));
        let probe = harness
            .details
            .iter()
            .find(|(key, _)| key == "displayProbe")
            .map(|(_, value)| value.as_str());
        assert_eq!(probe, Some("unavailable_strict"));
    }

    #[test]
    fn strict_display_policy_gate_off_default_is_headless_only() {
        // Gate OFF (default): a missing display surface is NOT an error, so
        // the UTSUSHI-148 headless launch path is unchanged. Uses the pure
        // policy fn so the default is asserted deterministically regardless
        // of host env, on every platform.
        for platform_uses_display_env in [true, false] {
            let outcome = super::browser_detection::evaluate_display(
                false, // strict gate off
                false, // no display surface
                platform_uses_display_env,
                super::browser_detection::BrowserDetectionLabel::Path,
                "linux",
            );
            assert_eq!(
                outcome,
                Ok(super::browser_detection::DisplayProbeOutcome::HeadlessOnly)
            );
        }
        // A present surface is always usable, gate on or off.
        for strict in [true, false] {
            let outcome = super::browser_detection::evaluate_display(
                strict,
                true, // display present
                true,
                super::browser_detection::BrowserDetectionLabel::Path,
                "linux",
            );
            assert_eq!(
                outcome,
                Ok(super::browser_detection::DisplayProbeOutcome::PresentEnv)
            );
        }
    }

    #[test]
    fn strict_display_policy_gate_on_no_surface_emits_display_unavailable() {
        // Gate ON + no display surface on an env-convention platform -> hard
        // DisplayUnavailable carrying the typed semantic code. On a native-
        // window platform (macOS/Windows) the env signal is inapplicable, so
        // the same inputs stay PresentEnv rather than false-positive.
        let unavailable = super::browser_detection::evaluate_display(
            true,  // strict gate on
            false, // no display surface
            true,  // env-convention platform (Linux/BSD)
            super::browser_detection::BrowserDetectionLabel::Path,
            "linux",
        );
        let reason = unavailable.expect_err("strict + no surface must be an error");
        assert_eq!(
            reason.semantic_code(),
            "utsushi.browser.display_unavailable"
        );
        assert_eq!(
            reason.harness_error_kind(),
            RuntimeHarnessErrorKind::ChromiumDisplayUnavailable
        );
        let harness =
            super::unavailability_harness_error(RuntimeOperation::SmokeValidation, &reason);
        let semantic = harness
            .details
            .iter()
            .find(|(key, _)| key == "semanticCode")
            .map(|(_, value)| value.as_str());
        assert_eq!(semantic, Some("utsushi.browser.display_unavailable"));
        let probe = harness
            .details
            .iter()
            .find(|(key, _)| key == "displayProbe")
            .map(|(_, value)| value.as_str());
        assert_eq!(probe, Some("unavailable_strict"));

        // Native-window platform: same strict/no-surface inputs stay present.
        let native = super::browser_detection::evaluate_display(
            true,
            false,
            false, // native-window platform (macOS/Windows)
            super::browser_detection::BrowserDetectionLabel::Path,
            "macos",
        );
        assert_eq!(
            native,
            Ok(super::browser_detection::DisplayProbeOutcome::PresentEnv)
        );
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    // reason: this test mutates process env via the unavoidably unsafe
    // std::env::{set_var,remove_var} (edition 2024) through a scoped guard to
    // exercise the REAL env-reading strict-display probe. Test-only; src stays
    // unsafe-free.
    #[allow(unsafe_code)]
    fn real_strict_display_probe_reads_env_gate_and_emits_display_unavailable() {
        // Exercises the REAL env-backed probe_display path end to end: with the
        // UTSUSHI_STRICT_DISPLAY gate on and no DISPLAY/WAYLAND_DISPLAY, the
        // probe emits DisplayUnavailable; with the gate off (default), the
        // same no-display host is headless-only. Restores prior env on drop.
        struct EnvGuard {
            keys: Vec<(&'static str, Option<std::ffi::OsString>)>,
        }
        impl EnvGuard {
            fn capture(keys: &[&'static str]) -> Self {
                Self {
                    keys: keys.iter().map(|key| (*key, env::var_os(key))).collect(),
                }
            }
            fn set(key: &str, value: &str) {
                // SAFETY: deliberate, scoped mutation for a test that restores
                // prior values on drop; documented single-test env scope.
                unsafe {
                    env::set_var(key, value);
                }
            }
            fn remove(key: &str) {
                // SAFETY: see EnvGuard::set.
                unsafe {
                    env::remove_var(key);
                }
            }
        }
        impl Drop for EnvGuard {
            fn drop(&mut self) {
                for (key, previous) in &self.keys {
                    // SAFETY: see EnvGuard::set.
                    unsafe {
                        match previous {
                            Some(value) => env::set_var(key, value),
                            None => env::remove_var(key),
                        }
                    }
                }
            }
        }

        let _browser_env = lock_browser_probe_env();
        let _guard = EnvGuard::capture(&["UTSUSHI_STRICT_DISPLAY", "DISPLAY", "WAYLAND_DISPLAY"]);
        EnvGuard::remove("DISPLAY");
        EnvGuard::remove("WAYLAND_DISPLAY");

        // Gate off (default): no display surface is NOT an error.
        EnvGuard::remove("UTSUSHI_STRICT_DISPLAY");
        assert_eq!(
            super::browser_detection::probe_display(
                super::browser_detection::BrowserDetectionLabel::Path
            ),
            Ok(super::browser_detection::DisplayProbeOutcome::HeadlessOnly)
        );

        // Gate on: the real probe emits the typed DisplayUnavailable.
        EnvGuard::set("UTSUSHI_STRICT_DISPLAY", "1");
        let reason = super::browser_detection::probe_display(
            super::browser_detection::BrowserDetectionLabel::Path,
        )
        .expect_err("strict gate + no display env must be DisplayUnavailable");
        assert_eq!(
            reason.semantic_code(),
            "utsushi.browser.display_unavailable"
        );
        let harness =
            super::unavailability_harness_error(RuntimeOperation::SmokeValidation, &reason);
        let semantic = harness
            .details
            .iter()
            .find(|(key, _)| key == "semanticCode")
            .map(|(_, value)| value.as_str());
        assert_eq!(semantic, Some("utsushi.browser.display_unavailable"));

        // Falsey gate value is treated as off.
        EnvGuard::set("UTSUSHI_STRICT_DISPLAY", "0");
        assert_eq!(
            super::browser_detection::probe_display(
                super::browser_detection::BrowserDetectionLabel::Path
            ),
            Ok(super::browser_detection::DisplayProbeOutcome::HeadlessOnly)
        );
    }

    #[test]
    fn chromium_version_parser_accepts_standard_chromium_strings() {
        for (input, expected_major) in [
            ("Chromium 124.0.6367.118 chromium-headless-shell", 124),
            ("Google Chrome 124.0.6367.118 unknown", 124),
            ("Brave Browser 1.65.114 Chromium: 124.0.6367.118", 1),
        ] {
            let parsed =
                super::browser_detection::parse_chromium_version(input).expect("version parses");
            assert_eq!(parsed.major(), Some(expected_major));
        }
    }

    // ---- UTSUSHI-006: live MV/MZ DOM text + choice observation --------------

    fn mvmz_observation_fixture_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mvmz_observation")
    }

    /// Fake browser that genuinely *renders* the fixture: it reads the launched
    /// `file://` entrypoint, decodes the runtime base64 payload exactly as the
    /// fixture's JavaScript would, and emits the observation island on stdout
    /// (as real Chromium `--dump-dom` does after executing the page). The
    /// observed plaintext therefore only comes into existence by transforming
    /// the fixture at runtime — it is never read verbatim from the source.
    #[cfg(unix)]
    const LIVE_DOM_FAKE_BROWSER: &str = r#"#!/bin/sh
set -eu
url=""
for arg in "$@"; do
  case "$arg" in
    file://*) url="$arg" ;;
  esac
done
[ -n "$url" ] || exit 70
path="${url#file://}"
b64=$(sed -n 's|.*type="application/base64">\([A-Za-z0-9+/=]*\)</script>.*|\1|p' "$path")
[ -n "$b64" ] || exit 71
json=$(printf '%s' "$b64" | base64 -d)
printf '<!doctype html><html><body><div id="messageWindow"></div>'
printf '<script id="utsushi-observed-events" type="application/json">'
printf '/*UTSUSHI-OBSERVED-BEGIN*/%s/*UTSUSHI-OBSERVED-END*/' "$json"
printf '</script></body></html>\n'
"#;

    /// Fake browser that launches successfully but produces a DOM WITHOUT the
    /// instrumentation island (simulating a render where the page JavaScript
    /// never populated the observed events). The probe must observe nothing.
    #[cfg(unix)]
    const NO_ISLAND_FAKE_BROWSER: &str = r#"#!/bin/sh
printf '<!doctype html><html><body><div id="messageWindow">launched without instrumentation</div></body></html>\n'
"#;

    #[cfg(unix)]
    #[test]
    fn browser_trace_observes_live_dom_text_and_choice_events() {
        let _browser_env = lock_browser_probe_env();
        let work = temp_dir("browser-trace-live");
        let fixture = mvmz_observation_fixture_root();
        let fake = fake_browser(&work, LIVE_DOM_FAKE_BROWSER);
        let adapter = fake_browser_adapter(fake);

        let report = adapter.trace(&RuntimeRequest::new(&fixture)).unwrap();

        assert_eq!(report["adapterName"], BrowserLaunchAdapter::NAME);
        assert_eq!(report["status"], "passed");
        assert_eq!(report["evidenceTier"], "E1");

        let events = report["observationHookEvents"].as_array().unwrap();
        let text_events: Vec<&Value> = events.iter().filter(|e| e["eventKind"] == "text").collect();
        let choice_events: Vec<&Value> = events
            .iter()
            .filter(|e| e["eventKind"] == "choice")
            .collect();
        assert_eq!(text_events.len(), 2, "two dialogue lines are observed");
        assert_eq!(choice_events.len(), 1, "one choice is observed");

        // Live text observed from the DOM, NOT the source.json PLACEHOLDER.
        let first = text_events[0];
        assert_eq!(
            first["payload"]["text"],
            "The frost blossoms open at first light."
        );
        assert_eq!(first["payload"]["speaker"], "Yuki");
        assert_eq!(first["payload"]["textSurface"], "dialogue");
        assert_eq!(first["evidenceTier"], "E1");
        assert_eq!(first["observationSource"], "live_dom");
        assert_eq!(
            first["schemaVersion"],
            FIXTURE_OBSERVATION_HOOK_SCHEMA_LITERAL
        );

        // Full linkage: bridge unit, source revision, runtime target, adapter.
        let bridge = &first["bridgeRefs"][0];
        assert_eq!(bridge["sourceUnitKey"], "mvmz.scene1.line1");
        assert!(
            bridge["bridgeUnitId"]
                .as_str()
                .unwrap()
                .starts_with("019ed000-"),
            "text event must link to a bridge unit id: {bridge}"
        );
        assert_eq!(first["runtimeTargetId"], "fixture:mvmz-observation-fixture");
        assert_eq!(first["adapterId"]["name"], BrowserLaunchAdapter::NAME);
        assert_eq!(
            first["sourceRevision"]["sourceId"],
            "mvmz-observation-fixture"
        );

        // Choice linkage + per-option bridge refs.
        let choice = choice_events[0];
        assert_eq!(choice["observationSource"], "live_dom");
        assert_eq!(choice["evidenceTier"], "E1");
        assert_eq!(choice["payload"]["prompt"], "How do you answer Sora?");
        let options = choice["payload"]["options"].as_array().unwrap();
        assert_eq!(options.len(), 2);
        assert_eq!(options[0]["label"], "Follow her into the snow.");
        assert_eq!(options[0]["optionId"], "opt-0");
        assert_eq!(
            options[0]["bridgeRef"]["sourceUnitKey"],
            "mvmz.scene1.choice.opt0"
        );
        assert_eq!(options[1]["label"], "Stay by the warm hearth.");

        // Trace events mirror the observed text and feed the approximation refs.
        let trace_events = report["traceEvents"].as_array().unwrap();
        assert_eq!(trace_events.len(), 2);
        assert_eq!(
            trace_events[0]["observedText"],
            "The frost blossoms open at first light."
        );
        assert_eq!(trace_events[0]["observationSource"], "live_dom");
        assert_eq!(
            report["approximations"][0]["affectedBridgeUnitRefs"]
                .as_array()
                .unwrap()
                .len(),
            2
        );

        // The whole runtime evidence report is envelope-conformant.
        utsushi_core::validate_runtime_evidence_report_value(&report).unwrap();

        let _ = fs::remove_dir_all(work);
    }

    #[cfg(unix)]
    #[test]
    fn browser_trace_yields_no_observed_events_without_instrumentation_island() {
        let _browser_env = lock_browser_probe_env();
        let work = temp_dir("browser-trace-empty");
        let fixture = mvmz_observation_fixture_root();
        let fake = fake_browser(&work, NO_ISLAND_FAKE_BROWSER);
        let adapter = fake_browser_adapter(fake);

        let report = adapter.trace(&RuntimeRequest::new(&fixture)).unwrap();

        // Launch succeeded, but the render produced no observed events.
        assert_eq!(report["status"], "passed");
        assert!(
            report["observationHookEvents"]
                .as_array()
                .unwrap()
                .is_empty(),
            "a render without an instrumentation island must observe nothing"
        );
        assert!(report["traceEvents"].as_array().unwrap().is_empty());
        // A render that produced no instrumented DOM carries no runtime
        // evidence at all, so the report is not even contract-conformant:
        // there is nothing for a bypassed/static path to pass off as observed.
        let error = utsushi_core::validate_runtime_evidence_report_value(&report)
            .expect_err("an empty observation must not form a valid evidence report");
        assert!(
            error.to_string().contains("must contain"),
            "unexpected validation error: {error}"
        );

        let _ = fs::remove_dir_all(work);
    }

    #[test]
    fn static_fixture_read_cannot_satisfy_the_runtime_trace_probe() {
        let fixture = mvmz_observation_fixture_root();
        let html = fs::read_to_string(fixture.join("index.html")).unwrap();
        let source = fs::read_to_string(fixture.join("source.json")).unwrap();

        // The observed strings exist only after a runtime render; no static
        // input the probe reads contains them.
        for observed in [
            "The frost blossoms open at first light.",
            "Then let us walk before the town wakes.",
            "How do you answer Sora?",
            "Follow her into the snow.",
            "Stay by the warm hearth.",
        ] {
            assert!(
                !html.contains(observed),
                "static index.html leaked observed text: {observed}"
            );
            assert!(
                !source.contains(observed),
                "source.json leaked observed text: {observed}"
            );
        }

        // Parsing the raw static source directly yields no observed events:
        // only the live post-render DOM carries the island.
        assert!(parse_observed_dom(&html).is_empty());
        assert!(parse_observed_dom(&source).is_empty());
    }

    #[test]
    fn build_observed_events_links_each_event_to_its_bridge_unit_without_a_browser() {
        let _browser_env = lock_browser_probe_env();
        // Unit-level proof of the envelope + parse + linkage logic that does
        // not need a live browser (the CI/oracle exercises real Chromium).
        let source = json!({
            "gameId": "mvmz-observation-fixture",
            "sourceLocale": "ja-JP",
            "units": [
                {"sourceUnitKey": "mvmz.scene1.line1"},
                {"sourceUnitKey": "mvmz.scene1.choice"},
                {"sourceUnitKey": "mvmz.scene1.choice.opt0"},
            ],
        });
        let dom = concat!(
            "<html><body><script>",
            "/*UTSUSHI-OBSERVED-BEGIN*/",
            r#"{"events":[{"kind":"text","unitKey":"mvmz.scene1.line1","speaker":"Yuki","textSurface":"dialogue","text":"Hello."},{"kind":"choice","unitKey":"mvmz.scene1.choice","prompt":"Pick","options":[{"optionId":"opt-0","label":"Go","unitKey":"mvmz.scene1.choice.opt0"}]}]}"#,
            "/*UTSUSHI-OBSERVED-END*/",
            "</script></body></html>"
        );

        let observed = parse_observed_dom(dom);
        assert_eq!(observed.len(), 2);

        let descriptor = BrowserLaunchAdapter::new().descriptor();
        let (trace_events, hook_events) = build_observed_events(&descriptor, &source, &observed);
        assert_eq!(trace_events.len(), 1);
        assert_eq!(hook_events.len(), 2);

        let text = &hook_events[0];
        assert_eq!(text["eventKind"], "text");
        assert_eq!(text["payload"]["text"], "Hello.");
        assert_eq!(text["bridgeRefs"][0]["sourceUnitKey"], "mvmz.scene1.line1");
        assert!(text["bridgeRefs"][0]["bridgeUnitId"].is_string());
        assert_eq!(text["evidenceTier"], "E1");
        assert_eq!(text["observationSource"], "live_dom");
        assert_eq!(text["adapterId"]["name"], BrowserLaunchAdapter::NAME);

        let choice = &hook_events[1];
        assert_eq!(choice["eventKind"], "choice");
        assert_eq!(
            choice["payload"]["options"][0]["bridgeRef"]["sourceUnitKey"],
            "mvmz.scene1.choice.opt0"
        );
    }

    #[test]
    fn parse_observed_dom_returns_empty_for_missing_or_malformed_island() {
        assert!(parse_observed_dom("<html>no island here</html>").is_empty());
        assert!(
            parse_observed_dom("/*UTSUSHI-OBSERVED-BEGIN*/ not json /*UTSUSHI-OBSERVED-END*/")
                .is_empty()
        );
        // Begin marker but no end marker.
        assert!(parse_observed_dom("/*UTSUSHI-OBSERVED-BEGIN*/{\"events\":[]}").is_empty());
        // Well-formed but empty stream.
        assert!(
            parse_observed_dom("/*UTSUSHI-OBSERVED-BEGIN*/{\"events\":[]}/*UTSUSHI-OBSERVED-END*/")
                .is_empty()
        );
    }
}
