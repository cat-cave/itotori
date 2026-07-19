//! Structural and clean-room smoke coverage for the Siglus CG port.

use std::path::Path;

use utsushi_core::RuntimeOperation;
use utsushi_core::substrate::{
    EnginePort, EnginePortError, LifecycleStage, PortRequest, PortShutdownStatus,
    RunnerCancellation,
};
use utsushi_siglus::{SIGLUS_RS_RESEARCH_ANCHOR_BOUNDARY_STATEMENT, UtsushiSiglusPort};

fn assert_implements_engine_port<P: EnginePort>() {}

#[test]
fn engine_port_trait_bound_is_satisfied_at_compile_time() {
    assert_implements_engine_port::<UtsushiSiglusPort>();
}

#[test]
fn default_port_requires_real_asset_configuration() {
    let mut port = UtsushiSiglusPort::new();
    let request = PortRequest::new(Path::new("."), "missing-asset", RuntimeOperation::Capture)
        .with_cancellation(RunnerCancellation::new());
    let error = port.launch(&request).expect_err("no package configured");
    match error {
        EnginePortError::Lifecycle { stage, message, .. } => {
            assert_eq!(stage, LifecycleStage::Launch);
            assert!(message.contains("AssetPackage"));
        }
        other => panic!("expected configuration error, got {other:?}"),
    }
}

#[test]
fn shutdown_is_idempotent_after_the_capture_slice() {
    let mut port = UtsushiSiglusPort::new();
    assert_eq!(port.shutdown().unwrap().status, PortShutdownStatus::Clean);
    assert_eq!(
        port.shutdown().unwrap().status,
        PortShutdownStatus::AlreadyShutDown
    );
}

#[test]
fn boundary_statement_carries_required_clean_room_phrases() {
    let statement = SIGLUS_RS_RESEARCH_ANCHOR_BOUNDARY_STATEMENT;
    for required in [
        "siglus_rs",
        "research anchor",
        "does not depend on siglus_rs",
        "does not mechanically translate",
    ] {
        assert!(
            statement.contains(required),
            "missing boundary phrase: {required}"
        );
    }
}
