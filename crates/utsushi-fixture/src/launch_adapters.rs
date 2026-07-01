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
const BROWSER_VIEWPORT_WIDTH: u32 = 320;
const BROWSER_VIEWPORT_HEIGHT: u32 = 180;

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
                observation_events: vec![browser_text_observation_hook_event(
                    &self.descriptor(),
                    &source,
                    unit,
                    EvidenceTier::E1,
                )?],
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
        probe_chromium(self.browser_program.as_deref())
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
        /// Reserved semantic-code variant; the gate that produces this
        /// reason (strict display checking) is intentionally not exposed
        /// in UTSUSHI-148. Tests exercise the variant via
        /// [`force_display_unavailable`] so the wiring (semantic code,
        /// harness error kind, diagnostic detail attachment) stays
        /// live under workspace clippy.
        // reason: reserved harness error variant kept live under workspace clippy; not constructed on every path yet.
        #[allow(dead_code)]
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
    // reason: reserved enum variant kept for API symmetry; see DisplayUnavailable note above.
    #[allow(dead_code)]
    pub(super) enum DisplayProbeOutcome {
        /// Display env vars present (X11/Wayland session). Headless launch
        /// nonetheless proceeds with `--headless=new --disable-gpu --no-sandbox`.
        PresentEnv,
        /// No display env vars present but the adapter operates headlessly,
        /// so launch is not gated.
        HeadlessOnly,
        /// Strict display checking explicitly enabled and no usable surface
        /// detected. Reserved; not produced in the default UTSUSHI-148 path.
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

        // 2. Bounded version probe.
        let version = probe_version(&program).unwrap_or(ChromiumVersion::Unknown);
        if let Some(major) = version.major()
            && major < CHROMIUM_MIN_SUPPORTED_MAJOR
        {
            return Err(BrowserUnavailabilityReason::VersionMismatch {
                source: BrowserDetectionLabel::VersionUnsupported,
                detected: version,
                required_major: CHROMIUM_MIN_SUPPORTED_MAJOR,
            });
        }

        Ok(ChromiumProbeOutcome {
            program,
            source,
            version,
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

    /// Test-only constructor for the reserved `DisplayUnavailable` variant.
    /// Production callers never produce this variant; the helper exists so
    /// downstream tests can assert the semantic code wiring is correct
    /// without flipping any production gate.
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
        let root = temp_dir("browser-root-required");
        write_browser_smoke_fixture(&root);
        let launched_marker = root.join("launched");
        let launched_marker_arg = shell_quote_path(&launched_marker);
        // Bounded probe invokes `--version`; that must NOT trip the launched
        // marker — only a full capture launch (with --screenshot or --dump-dom)
        // counts as "launched" for the purposes of this assertion.
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
            r"#!/bin/sh
set -eu
exit 0
",
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

    #[cfg(unix)]
    #[test]
    fn browser_capture_does_not_promote_stale_staging_screenshot() {
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
        let adapter = BrowserLaunchAdapter::with_browser_program(fake_browser);

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
        // previous env value on drop. Tests that read the same env var
        // must serialize through a single-threaded test runner OR avoid
        // setting it concurrently; we accept that here as a known
        // single-test scope.
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
        let root = temp_dir("browser-version-too-old");
        write_browser_smoke_fixture(&root);
        let artifact_root = root.join("runtime-artifacts");
        let fake_browser = fake_browser(
            &root,
            r#"#!/bin/sh
set -eu
if [ "$1" = "--version" ]; then
  printf 'Chromium 50.0.2661.102 unknown\n'
  exit 0
fi
exit 0
"#,
        );
        let adapter = BrowserLaunchAdapter::with_browser_program(fake_browser);

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
        // Reserved variant smoke. UTSUSHI-148 documents
        // BrowserUnavailabilityReason::DisplayUnavailable as registered but
        // not produced in production paths; this test pins the semantic
        // code, harness error kind, and detail-attachment wiring so a
        // follow-up node that flips the production gate inherits a working
        // contract.
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
}
