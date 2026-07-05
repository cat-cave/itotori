//! UTSUSHI-179 substrate-conformance test for `utsushi-rpgmaker-mv-mz`.
//!
//! Guarantees, all through the public substrate facade:
//!
//! - **Facade containment**: `RpgMakerMvMzEnginePort` resolves the `EnginePort` bound through `utsushi_core::substrate::*` (a compile-time witness), and every type touched here is a facade type.
//! - **Registration through the conformance manifest**: the port's `PortManifest` validates, the crate's `ImplementationMap` validates + promotes, and the two bind via `validate_against_manifest` (port-id + engine-family-prefix match). That binding is what "registered" means for this port (no global mutable registry).
//! - **Zero opcode handlers**: `OPCODE_HANDLER_COUNT == 0`, and every lifecycle method returns the typed browser-runtime-delegation error.
//! - **Clean-room attestation emitted**: the attestation is reachable as data, renders, and carries the load-bearing clean-room phrases.

use utsushi_core::RuntimeOperation;
use utsushi_core::port::impl_map::{
    Status, SubsystemStatus, validate, validate_against_manifest, validate_and_promote,
};
use utsushi_core::substrate::{
    EnginePort, EnginePortError, EvidenceTier, FidelityTier, LifecycleStage, PortCapability,
    PortManifest, PortRequest, RunnerCancellation, SinkSet,
};

use utsushi_rpgmaker_mv_mz::conformance::build_rpgmaker_mv_mz_impl_map;
use utsushi_rpgmaker_mv_mz::{
    BROWSER_RUNTIME_MESSAGE, CLEAN_ROOM_ATTESTATION, OPCODE_HANDLER_COUNT, PORT_ID,
    RpgMakerMvMzEnginePort,
};

/// Compile-time witness that `RpgMakerMvMzEnginePort` resolves the
/// `EnginePort` bound through the facade re-export.
fn assert_port_resolves_facade_engine_port_bound<P: EnginePort>() {}

fn fresh_request<'a>(root: &'a std::path::Path, run_id: &'a str) -> PortRequest<'a> {
    PortRequest::new(root, run_id, RuntimeOperation::Trace)
        .with_cancellation(RunnerCancellation::new())
}

#[test]
fn port_resolves_only_facade_engine_port_trait() {
    assert_port_resolves_facade_engine_port_bound::<RpgMakerMvMzEnginePort>();
}

#[test]
fn manifest_is_well_formed_through_facade_types() {
    let manifest: &PortManifest = &RpgMakerMvMzEnginePort::MANIFEST;
    assert_eq!(manifest.id, PORT_ID);
    assert_eq!(manifest.id, "utsushi-rpgmaker-mv-mz");
    assert_eq!(manifest.abi_version, 1);
    for capability in [
        PortCapability::Launch,
        PortCapability::Observe,
        PortCapability::Capture,
        PortCapability::Shutdown,
    ] {
        assert!(manifest.capabilities.contains(&capability));
    }
    assert!(!manifest.capabilities.contains(&PortCapability::Jump));
    assert_eq!(manifest.fidelity_tier_max, FidelityTier::TraceOnly);
    assert_eq!(manifest.evidence_tier_max, EvidenceTier::E1);
    manifest
        .validate()
        .expect("manifest validates structurally");
}

#[test]
fn manifest_limitations_declare_zero_opcode_browser_runtime_honestly() {
    let joined = RpgMakerMvMzEnginePort::MANIFEST
        .limitations
        .join("\n")
        .to_lowercase();
    for required in ["browser", "nw.js", "zero opcode handlers", "clean-room"] {
        assert!(
            joined.contains(required),
            "manifest limitations must honestly declare the browser/NW.js zero-opcode posture \
             (missing phrase: `{required}`); got: {:?}",
            RpgMakerMvMzEnginePort::MANIFEST.limitations
        );
    }
}

#[test]
fn impl_map_registers_through_the_conformance_manifest() {
    // Validate + promote the map, then bind it to the port manifest. This
    // pair is the port's "registration".
    let mut map = build_rpgmaker_mv_mz_impl_map();
    validate_and_promote(&mut map).expect("impl map validates + promotes");
    assert_eq!(map.status, Status::Validated);
    assert!(map.status_disclaimer.is_some(), "audit disclaimer stamped");
    assert_eq!(map.port_id.as_str(), PORT_ID);

    validate(&map).expect("impl map is structurally valid");
    validate_against_manifest(&map, &RpgMakerMvMzEnginePort::MANIFEST)
        .expect("impl map binds to the port manifest (port-id + engine-family prefix match)");

    // The command runtime is Unsupported-in-Rust (the browser runs it).
    let runtime = map
        .subsystems
        .iter()
        .find(|subsystem| subsystem.id.as_str() == "mv-mz-command-runtime")
        .expect("MV/MZ command-runtime subsystem declared");
    assert!(matches!(
        runtime.status,
        SubsystemStatus::Unsupported { .. }
    ));
}

#[test]
fn port_has_zero_opcode_handlers() {
    assert_eq!(
        OPCODE_HANDLER_COUNT, 0,
        "the browser/NW.js runtime is the interpreter; this port must carry zero opcode handlers"
    );
    assert_eq!(CLEAN_ROOM_ATTESTATION.opcode_handler_count, 0);
}

#[test]
fn sink_set_is_empty_and_all_drains_return_zero_items() {
    let port = RpgMakerMvMzEnginePort::new();
    let sink_set: &SinkSet = EnginePort::sink_set(&port);
    assert!(sink_set.text().is_none(), "port registers no text sink");
    assert!(sink_set.frame().is_none(), "port registers no frame sink");
    assert!(sink_set.audio().is_none(), "port registers no audio sink");
    assert!(sink_set.drain_text().is_empty());
    assert!(sink_set.drain_frame().is_empty());
    assert!(sink_set.drain_audio().is_empty());
}

#[test]
fn every_lifecycle_method_returns_the_browser_runtime_delegation_error() {
    let root = std::path::Path::new("/");
    let cases: [(LifecycleStage, &str); 3] = [
        (LifecycleStage::Launch, "launch"),
        (LifecycleStage::Observe, "observe"),
        (LifecycleStage::Capture, "capture"),
    ];
    for (stage, run_id) in cases {
        let mut port = RpgMakerMvMzEnginePort::new();
        let request = fresh_request(root, run_id);
        let error = match stage {
            LifecycleStage::Launch => port.launch(&request),
            LifecycleStage::Observe => port.observe(&request),
            LifecycleStage::Capture => port.capture(&request).map(|_| ()),
            other => panic!("unexpected stage {other:?}"),
        }
        .expect_err("lifecycle method must delegate to the browser runtime with an Err");
        match error {
            EnginePortError::Lifecycle {
                stage: got_stage,
                message,
                ..
            } => {
                assert_eq!(got_stage, stage);
                assert_eq!(message, BROWSER_RUNTIME_MESSAGE);
            }
            other => panic!("expected Lifecycle error, got {other:?}"),
        }
    }

    // Shutdown too.
    let mut port = RpgMakerMvMzEnginePort::new();
    match port.shutdown().expect_err("shutdown returns Err") {
        EnginePortError::Lifecycle { stage, message, .. } => {
            assert_eq!(stage, LifecycleStage::Shutdown);
            assert_eq!(message, BROWSER_RUNTIME_MESSAGE);
        }
        other => panic!("expected Lifecycle error, got {other:?}"),
    }
}

#[test]
fn clean_room_attestation_is_emitted_with_required_phrases() {
    let attestation = RpgMakerMvMzEnginePort::new().clean_room_attestation();
    assert_eq!(attestation.port_id, PORT_ID);
    assert_eq!(attestation.runtime_path, "browser/NW.js");
    assert_eq!(attestation.opcode_handler_count, 0);

    let rendered = attestation.emit();
    assert!(rendered.contains("clean-room-attestation"));
    assert!(rendered.contains(PORT_ID));

    let statement = attestation.statement.to_lowercase();
    for required in [
        "clean-room",
        "from-scratch",
        "vendors no",
        "no engine object code",
        "decompiled",
        "browser/nw.js",
        "zero opcode handlers",
    ] {
        assert!(
            statement.contains(required),
            "clean-room attestation missing phrase `{required}`; got: {}",
            attestation.statement
        );
    }
}
