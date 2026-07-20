//! Substrate conformance for the Siglus G00/CG EnginePort slice.

use utsushi_core::RuntimeOperation;
use utsushi_core::substrate::{
    AssetPackage, CapabilityStance, EnginePort, EnginePortError, EvidenceTier, FidelityTier,
    LifecycleStage, PortCapability, PortRequest, RunnerCancellation, SinkSet,
};
use utsushi_siglus::{UtsushiSiglusPort, UtsushiSiglusPortContext};

fn assert_port_resolves_facade_engine_port_bound<P: EnginePort>() {}

#[test]
fn port_consumes_the_facade_engine_port_contract() {
    assert_port_resolves_facade_engine_port_bound::<UtsushiSiglusPort>();
    let port = UtsushiSiglusPort::new();
    let context: &UtsushiSiglusPortContext = port.context();
    let _: Option<&std::sync::Arc<dyn AssetPackage>> = context.asset_package();
    let sinks: &SinkSet = EnginePort::sink_set(&port);
    assert!(sinks.drain_frame().is_empty());
}

#[test]
fn manifest_honestly_declares_the_real_capture_slice() {
    let manifest = UtsushiSiglusPort::MANIFEST;
    manifest.validate().expect("valid port manifest");
    assert!(manifest.capabilities.contains(&PortCapability::Launch));
    assert!(manifest.capabilities.contains(&PortCapability::Capture));
    assert_eq!(manifest.evidence_tier_max, EvidenceTier::E1);
    assert_eq!(manifest.fidelity_tier_max, FidelityTier::TraceOnly);
    let profile = UtsushiSiglusPort::PARITY_PROFILE;
    assert_eq!(
        profile.stance(PortCapability::Capture),
        Some(CapabilityStance::Wired)
    );
    assert_eq!(
        profile.stance(PortCapability::Observe),
        Some(CapabilityStance::Pending)
    );
}

#[test]
fn unconfigured_port_fails_with_configuration_not_scaffold_marker() {
    let mut port = UtsushiSiglusPort::new();
    let request = PortRequest::new(
        std::path::Path::new("."),
        "facade-conformance",
        RuntimeOperation::Capture,
    )
    .with_cancellation(RunnerCancellation::new());
    let error = port
        .launch(&request)
        .expect_err("configuration is required");
    match error {
        EnginePortError::Lifecycle { stage, message, .. } => {
            assert_eq!(stage, LifecycleStage::Launch);
            assert!(message.contains("AssetPackage"));
        }
        other => panic!("expected configuration lifecycle error, got {other:?}"),
    }
}
