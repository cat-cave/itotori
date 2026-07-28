use super::*;
use crate::{first_unit, read_source};

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
    pub(super) fn with_browser_program_and_version(
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
        let source = read_source(request.input_root)?;
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
        let source = read_source(request.input_root)?;
        let unit = first_unit(&source)?;
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
