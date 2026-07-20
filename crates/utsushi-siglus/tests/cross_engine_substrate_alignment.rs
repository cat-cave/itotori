//! Cross-engine substrate alignment after the Siglus CG port became real.
//!
//! This fixture keeps the important boundary: Siglus and RealLive are sibling
//! engines that meet only at Utsushi's EnginePort/substrate surface. It does
//! not invent an in-memory mock G00 seam; real-byte coverage lives in
//! `siglus_g00_real_bytes.rs`.

use std::fs;
use std::path::Path;

use utsushi_core::substrate::{
    CapabilityStance, CaptureOutcome, EnginePort, EnginePortError, EvidenceTier, FidelityTier,
    LifecycleStage, PortCapability, PortRequest, REQUIRED_LIFECYCLE_STAGES,
};
use utsushi_core::{RuntimeArtifactRoot, RuntimeOperation};
use utsushi_reallive::{RLVM_RESEARCH_ANCHOR_BOUNDARY_STATEMENT, UtsushiReallivePort};
use utsushi_siglus::{SIGLUS_RS_RESEARCH_ANCHOR_BOUNDARY_STATEMENT, UtsushiSiglusPort};

fn assert_implements_engine_port<P: EnginePort>() {}

#[test]
fn both_ports_satisfy_the_shared_engine_port_trait() {
    assert_implements_engine_port::<UtsushiReallivePort>();
    assert_implements_engine_port::<UtsushiSiglusPort>();
    assert_eq!(
        UtsushiSiglusPort::MANIFEST.required_methods,
        REQUIRED_LIFECYCLE_STAGES
    );
    assert_eq!(
        UtsushiReallivePort::MANIFEST.required_methods,
        REQUIRED_LIFECYCLE_STAGES
    );
}

#[test]
fn siglus_manifest_declares_only_the_exercised_cg_capabilities() {
    UtsushiSiglusPort::MANIFEST
        .validate()
        .expect("Siglus manifest is valid");
    for capability in [
        PortCapability::Launch,
        PortCapability::Capture,
        PortCapability::Shutdown,
    ] {
        assert!(
            UtsushiSiglusPort::MANIFEST
                .capabilities
                .contains(&capability)
        );
        assert_eq!(
            UtsushiSiglusPort::PARITY_PROFILE.stance(capability),
            Some(CapabilityStance::Wired)
        );
    }
    assert_eq!(
        UtsushiSiglusPort::PARITY_PROFILE.stance(PortCapability::Observe),
        Some(CapabilityStance::Pending)
    );
    assert_eq!(
        UtsushiSiglusPort::MANIFEST.evidence_tier_max,
        EvidenceTier::E2
    );
    assert_eq!(
        UtsushiSiglusPort::MANIFEST.fidelity_tier_max,
        FidelityTier::LayoutProbe
    );
}

#[test]
fn unconfigured_siglus_port_reports_a_configuration_error_not_a_mock_result() {
    let artifacts = tempfile::tempdir().expect("temporary artifact root");
    let root = RuntimeArtifactRoot::new(artifacts.path().join("runtime-artifacts"));
    let mut port = UtsushiSiglusPort::new();
    let request = PortRequest::new(Path::new("."), "no-real-g00", RuntimeOperation::Capture)
        .with_artifact_root(&root);
    let error = port
        .launch(&request)
        .expect_err("asset package is mandatory");
    match error {
        EnginePortError::Lifecycle { stage, message, .. } => {
            assert_eq!(stage, LifecycleStage::Launch);
            assert!(message.contains("AssetPackage"));
        }
        other => panic!("expected configuration lifecycle error, got {other:?}"),
    }
}

#[test]
fn capture_outcome_stays_on_the_shared_facade_surface() {
    let outcome = CaptureOutcome::new("artifacts/utsushi/runtime/run/screenshots/frame.png");
    assert!(outcome.artifact_path.is_none());
}

#[test]
fn siglus_source_keeps_capture_outcome_on_the_substrate_facade() {
    let source = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/cg_port.rs"))
        .expect("read Siglus production port source");
    assert!(source.contains("utsushi_core::substrate::{"));
    assert!(source.contains("CaptureOutcome"));
    assert!(!source.contains("utsushi_core::CaptureOutcome"));
}

#[test]
fn both_ports_carry_clean_room_boundary_statements() {
    for required in ["rlvm", "research anchor", "does not mechanically translate"] {
        assert!(RLVM_RESEARCH_ANCHOR_BOUNDARY_STATEMENT.contains(required));
    }
    for required in [
        "siglus_rs",
        "research anchor",
        "does not mechanically translate",
    ] {
        assert!(SIGLUS_RS_RESEARCH_ANCHOR_BOUNDARY_STATEMENT.contains(required));
    }
}
