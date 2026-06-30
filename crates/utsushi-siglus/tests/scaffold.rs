//! UTSUSHI-147 scaffold conformance test for the `utsushi-siglus` crate.
//!
//! Mirrors the role `utsushi-reallive/tests/scaffold.rs` plays for the
//! RealLive port. This is a **structural** smoke. It verifies:
//!
//! 1. The crate compiles with `#![forbid(unsafe_code)]` (transitively
//!    proven by the test compiling at all).
//! 2. `UtsushiSiglusPort: EnginePort` is satisfied. The bound is
//!    enforced via a generic helper function so the failure mode is a
//!    compile-time error, not a runtime panic.
//! 3. `EnginePort::sink_set` returns a `SinkSet` whose three drain
//!    methods return empty `Vec`s (no sinks registered).
//! 4. Every required lifecycle method returns the typed
//!    `EnginePortError::Lifecycle { stage, message: UNIMPLEMENTED_MESSAGE }`
//!    pinned-by-constant pair.
//! 5. The siglus_rs research-anchor boundary statement is reachable as
//!    a public `const &str` whose value carries the load-bearing
//!    phrases "siglus_rs", "research anchor", "does not depend on
//!    siglus_rs", and "does not mechanically translate".
//!
//! No author-fixture-only behavioural assertions live here. The
//! scaffold's purpose is structural.

use std::path::Path;

use utsushi_core::RuntimeOperation;
use utsushi_core::substrate::{
    EnginePort, EnginePortError, LifecycleStage, PortRequest, RunnerCancellation,
};

use utsushi_siglus::{
    SIGLUS_RS_RESEARCH_ANCHOR_BOUNDARY_STATEMENT, UNIMPLEMENTED_MESSAGE, UtsushiSiglusPort,
    UtsushiSiglusPortContext,
};

/// Generic bound-witness. Calling this with `UtsushiSiglusPort` is a
/// compile-time proof that the type implements `EnginePort`. The body is
/// intentionally empty.
fn assert_implements_engine_port<P: EnginePort>() {}

fn fresh_request<'a>(root: &'a Path, run_id: &'a str) -> PortRequest<'a> {
    PortRequest::new(root, run_id, RuntimeOperation::Trace)
        .with_cancellation(RunnerCancellation::new())
}

#[test]
fn engine_port_trait_bound_is_satisfied_at_compile_time() {
    assert_implements_engine_port::<UtsushiSiglusPort>();
}

#[test]
fn scaffold_constructs_with_default_inert_context() {
    let port = UtsushiSiglusPort::new();
    let context: &UtsushiSiglusPortContext = port.context();
    assert!(
        context.asset_package().is_none(),
        "scaffold context must start with no asset package wired"
    );
}

#[test]
fn sink_set_is_empty_and_all_drains_return_zero_items() {
    let port = UtsushiSiglusPort::new();
    let sink_set = EnginePort::sink_set(&port);
    assert!(sink_set.text().is_none(), "scaffold registers no text sink");
    assert!(
        sink_set.frame().is_none(),
        "scaffold registers no frame sink"
    );
    assert!(
        sink_set.audio().is_none(),
        "scaffold registers no audio sink"
    );
    assert!(
        sink_set.drain_text().is_empty(),
        "drain_text on empty sink set returns an empty Vec"
    );
    assert!(
        sink_set.drain_frame().is_empty(),
        "drain_frame on empty sink set returns an empty Vec"
    );
    assert!(
        sink_set.drain_audio().is_empty(),
        "drain_audio on empty sink set returns an empty Vec"
    );
}

#[test]
fn observe_returns_typed_unimplemented_lifecycle_error() {
    let mut port = UtsushiSiglusPort::new();
    let root = Path::new("/");
    let request = fresh_request(root, "scaffold-observe-run");
    let error = port
        .observe(&request)
        .expect_err("scaffold observe must return an Err");
    match error {
        EnginePortError::Lifecycle { stage, message, .. } => {
            assert_eq!(
                stage,
                LifecycleStage::Observe,
                "observe lifecycle error carries the observe stage"
            );
            assert_eq!(
                message, UNIMPLEMENTED_MESSAGE,
                "observe lifecycle error carries the pinned UNIMPLEMENTED_MESSAGE"
            );
        }
        other => panic!("expected Lifecycle error, got {other:?}"),
    }
}

#[test]
fn launch_returns_typed_unimplemented_lifecycle_error() {
    let mut port = UtsushiSiglusPort::new();
    let root = Path::new("/");
    let request = fresh_request(root, "scaffold-launch-run");
    let error = port
        .launch(&request)
        .expect_err("scaffold launch must return an Err");
    match error {
        EnginePortError::Lifecycle { stage, message, .. } => {
            assert_eq!(stage, LifecycleStage::Launch);
            assert_eq!(message, UNIMPLEMENTED_MESSAGE);
        }
        other => panic!("expected Lifecycle error, got {other:?}"),
    }
}

#[test]
fn capture_returns_typed_unimplemented_lifecycle_error() {
    let mut port = UtsushiSiglusPort::new();
    let root = Path::new("/");
    let request = fresh_request(root, "scaffold-capture-run");
    let error = port
        .capture(&request)
        .expect_err("scaffold capture must return an Err");
    match error {
        EnginePortError::Lifecycle { stage, message, .. } => {
            assert_eq!(stage, LifecycleStage::Capture);
            assert_eq!(message, UNIMPLEMENTED_MESSAGE);
        }
        other => panic!("expected Lifecycle error, got {other:?}"),
    }
}

#[test]
fn shutdown_returns_typed_unimplemented_lifecycle_error() {
    let mut port = UtsushiSiglusPort::new();
    let error = port
        .shutdown()
        .expect_err("scaffold shutdown must return an Err");
    match error {
        EnginePortError::Lifecycle { stage, message, .. } => {
            assert_eq!(stage, LifecycleStage::Shutdown);
            assert_eq!(message, UNIMPLEMENTED_MESSAGE);
        }
        other => panic!("expected Lifecycle error, got {other:?}"),
    }
}

#[test]
fn boundary_statement_carries_required_clean_room_phrases() {
    let statement = SIGLUS_RS_RESEARCH_ANCHOR_BOUNDARY_STATEMENT;
    assert!(
        !statement.is_empty(),
        "boundary statement must be a non-empty const &str"
    );
    for required in [
        "siglus_rs",
        "research anchor",
        "does not depend on siglus_rs",
        "does not mechanically translate",
    ] {
        assert!(
            statement.contains(required),
            "boundary statement missing required phrase: {required}; got: {statement}"
        );
    }
}

#[test]
fn manifest_validates_against_substrate_rules() {
    UtsushiSiglusPort::MANIFEST
        .validate()
        .expect("UTSUSHI-147 scaffold manifest passes substrate-level structural validation");
}

#[test]
fn manifest_declares_engine_id_utsushi_siglus() {
    assert_eq!(
        UtsushiSiglusPort::MANIFEST.id,
        "utsushi-siglus",
        "Siglus port manifest must declare engine id `utsushi-siglus`",
    );
}

#[test]
fn manifest_limitations_declare_inert_design_stage_scaffold_honestly() {
    // The "second engine family" claim is contract-level only: the
    // scaffold exercises zero Siglus real bytes and validates zero
    // Siglus games. The manifest must say so out loud, so a future
    // change cannot quietly present `utsushi-siglus` as a functioning
    // second engine without first replacing this honest declaration.
    let limitations = UtsushiSiglusPort::MANIFEST.limitations;
    let joined = limitations.join("\n").to_lowercase();
    for required in [
        "scaffold only",
        "every lifecycle method returns a typed lifecycle error",
        "out of alpha scope",
    ] {
        assert!(
            joined.contains(required),
            "Siglus manifest limitations must honestly declare the inert design-stage scaffold \
             (missing phrase: `{required}`); got: {limitations:?}",
        );
    }
}
