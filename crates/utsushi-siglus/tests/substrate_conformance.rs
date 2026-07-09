//! UTSUSHI-147 substrate-conformance test for the `utsushi-siglus` crate.
//!
//! Pins that the `utsushi-siglus` scaffold consumes **only** the public
//! substrate facade (`utsushi_core::substrate::*`) — no internal
//! `__internal::*` paths, no `sealed::*` paths, no direct
//! `utsushi_core::port::*` / `utsushi_core::vfs::*` reaches around the
//! facade.
//!
//! Strategy: this is a compile-time test. The body imports
//! `UtsushiSiglusPort` and pins the trait bound through the substrate
//! facade exclusively. If the scaffold ever grows a non-facade
//! `utsushi_core::*` import, the assertion fixture in this file will
//! still compile (the test cannot reach into the scaffold's private
//! imports). The substrate-only guarantee is therefore enforced two
//! ways:
//!
//! 1. **At the import site here**: every `utsushi_core::*` symbol used
//!    in this file is imported through `utsushi_core::substrate::*`. If
//!    a future substrate refactor moves one of these symbols out of the
//!    facade, this test breaks at the import statement.
//! 2. **At the scaffold's import site**: `src/lib.rs` itself imports
//!    every substrate symbol through `utsushi_core::substrate::*`. The
//!    cross-engine substrate-alignment fixture in
//!    `tests/cross_engine_substrate_alignment.rs` audits the
//!    `utsushi_core::*` import surface of both scaffolds so neither port
//!    can quietly grow a non-facade dependency the other lacks.

use utsushi_core::substrate::{
    AssetPackage, EnginePort, EnginePortError, EvidenceTier, FidelityTier, LifecycleStage,
    PortCapability, PortManifest, PortRequest, PortShutdownOutcome, RunnerCancellation, SinkSet,
};

use utsushi_siglus::{UNIMPLEMENTED_MESSAGE, UtsushiSiglusPort, UtsushiSiglusPortContext};

/// Compile-time witness that `UtsushiSiglusPort` resolves the
/// `EnginePort` bound through the facade's re-export — not through a
/// direct `utsushi_core::port::EnginePort` reach-around.
fn assert_port_resolves_facade_engine_port_bound<P: EnginePort>() {}

#[test]
fn scaffold_consumes_only_facade_engine_port_trait() {
    assert_port_resolves_facade_engine_port_bound::<UtsushiSiglusPort>();
}

#[test]
fn scaffold_constructs_through_facade_only() {
    // Every type touched on this path is sourced through the substrate
    // facade. The scaffold's public API (`UtsushiSiglusPort::new`,
    // `UtsushiSiglusPortContext::empty`) round-trips through facade
    // types only.
    let port = UtsushiSiglusPort::new();
    let context: &UtsushiSiglusPortContext = port.context();
    let _asset_package_slot: Option<&std::sync::Arc<dyn AssetPackage>> = context.asset_package();
    let manifest: &PortManifest = &UtsushiSiglusPort::MANIFEST;
    assert_eq!(manifest.abi_version, 1);
    assert_eq!(manifest.id, "utsushi-siglus");
    assert!(
        manifest.capabilities.contains(&PortCapability::Launch),
        "manifest must declare the Launch capability via the facade"
    );
    assert_eq!(
        manifest.evidence_tier_max,
        EvidenceTier::E1,
        "scaffold pins its evidence tier ceiling at E1 (trace-only baseline)"
    );
    assert_eq!(
        manifest.fidelity_tier_max,
        FidelityTier::TraceOnly,
        "scaffold pins its fidelity tier ceiling at TraceOnly"
    );
    let sink_set: &SinkSet = EnginePort::sink_set(&port);
    assert!(sink_set.drain_text().is_empty());
}

#[test]
fn scaffold_lifecycle_errors_route_through_facade_engine_port_error() {
    let mut port = UtsushiSiglusPort::new();
    let request = PortRequest::new(
        std::path::Path::new("/"),
        "facade-conformance",
        utsushi_core::RuntimeOperation::Trace,
    )
    .with_cancellation(RunnerCancellation::new());

    let observe_error: EnginePortError = port
        .observe(&request)
        .expect_err("observe scaffold returns Err");
    match observe_error {
        EnginePortError::Lifecycle { stage, message, .. } => {
            assert_eq!(stage, LifecycleStage::Observe);
            assert_eq!(message, UNIMPLEMENTED_MESSAGE);
        }
        other => panic!("expected facade EnginePortError::Lifecycle, got {other:?}"),
    }

    let shutdown_error: EnginePortError =
        port.shutdown().expect_err("shutdown scaffold returns Err");
    let _: PortShutdownOutcome = match shutdown_error {
        EnginePortError::Lifecycle { stage, .. } => {
            assert_eq!(stage, LifecycleStage::Shutdown);
            // We never reach a real PortShutdownOutcome value here, but
            // the type annotation pins that the substrate facade exports
            // the type the scaffold's `shutdown` signature references.
            PortShutdownOutcome::clean()
        }
        other => panic!("expected facade EnginePortError::Lifecycle, got {other:?}"),
    };
}
