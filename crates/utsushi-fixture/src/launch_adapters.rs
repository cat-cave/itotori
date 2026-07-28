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

mod browser;
pub use browser::BrowserLaunchAdapter;
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
