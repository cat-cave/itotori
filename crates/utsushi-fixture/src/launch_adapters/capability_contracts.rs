//! Capability-contract builders for the browser and NW.js launch adapters.

use utsushi_core::{
    EvidenceTier, FidelityTier, RuntimeCapabilityClass, RuntimeCapabilityContract,
    RuntimeFeatureSupport, RuntimePlaybackFeature,
};

pub(super) fn browser_capability_contract() -> RuntimeCapabilityContract {
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

pub(super) fn nwjs_research_tier_contract() -> RuntimeCapabilityContract {
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
