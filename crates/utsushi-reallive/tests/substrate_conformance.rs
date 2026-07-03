//! Substrate-facade conformance test.
//!
//! Pins that the `utsushi-reallive` port consumes the public substrate
//! facade (`utsushi_core::substrate::*`) for its substrate types — no
//! internal `__internal::*` / `sealed::*` paths, no direct
//! `utsushi_core::port::*` / `utsushi_core::vfs::*` reaches around the
//! facade.
//!
//! Strategy: every `utsushi_core::*` substrate symbol used in this file is
//! imported through `utsushi_core::substrate::*`. If a future substrate
//! refactor moves one of these symbols out of the facade, this test breaks
//! at the import statement. It pairs with the acceptance grep that asserts
//! `src/lib.rs` / `src/engine_port.rs` reach `utsushi_core` substrate types
//! through the facade (the only non-facade root types they touch —
//! `CaptureOutcome`, `RuntimeArtifactRoot`, `runtime_artifact_uri` — are
//! public crate-root types the facade does not (yet) re-export, exactly as
//! `render_pipeline.rs` reaches them).

#[path = "support/port_support.rs"]
mod port_support;

use std::sync::Arc;

use utsushi_core::substrate::{
    AssetPackage, EnginePort, EvidenceTier, FidelityTier, PortCapability, PortManifest, SinkSet,
};

use utsushi_reallive::{MessageWindowConfig, UtsushiReallivePort};

use port_support::{NullAssetPackage, synthetic_engine};

/// Compile-time witness that `UtsushiReallivePort` resolves the
/// `EnginePort` bound through the facade's re-export — not through a
/// direct `utsushi_core::port::EnginePort` reach-around.
fn assert_port_resolves_facade_engine_port_bound<P: EnginePort>() {}

fn build_port() -> UtsushiReallivePort {
    let assets: Arc<dyn AssetPackage> = Arc::new(NullAssetPackage);
    UtsushiReallivePort::new(
        synthetic_engine(),
        assets,
        1,
        MessageWindowConfig::default(),
        (1280, 720),
    )
}

#[test]
fn port_consumes_only_facade_engine_port_trait() {
    assert_port_resolves_facade_engine_port_bound::<UtsushiReallivePort>();
}

#[test]
fn port_constructs_through_facade_only() {
    let port = build_port();
    let manifest: &PortManifest = &UtsushiReallivePort::MANIFEST;
    assert_eq!(manifest.abi_version, 1);
    assert_eq!(manifest.id, "utsushi-reallive");
    assert!(
        manifest.capabilities.contains(&PortCapability::Launch),
        "manifest must declare the Launch capability via the facade"
    );
    assert_eq!(
        manifest.evidence_tier_max,
        EvidenceTier::E2,
        "port pins its evidence tier ceiling at E2 (frame-artifact capable)"
    );
    assert_eq!(
        manifest.fidelity_tier_max,
        FidelityTier::LayoutProbe,
        "port pins its fidelity tier ceiling at LayoutProbe"
    );
    // The sink set the port exposes is a facade `SinkSet` carrying the
    // three registered sinks.
    let sink_set: &SinkSet = EnginePort::sink_set(&port);
    let summary = sink_set.capabilities();
    assert!(matches!(
        summary.text,
        utsushi_core::substrate::SinkCapability::Supported { .. }
    ));
}
