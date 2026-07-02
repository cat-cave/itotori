//! Structural conformance test for the real [`UtsushiReallivePort`].
//!
//! (Formerly the UTSUSHI-200 *scaffold* smoke that pinned an inert port
//! returning `UNIMPLEMENTED_MESSAGE` on every lifecycle method. That
//! scaffold was the substrate-honesty gap the re-grounding flagged and is
//! now deleted — the port is the real substrate-sink producer.) This test
//! verifies the structural surface:
//!
//! 1. The crate compiles with `#![forbid(unsafe_code)]`.
//! 2. `UtsushiReallivePort: EnginePort` is satisfied (compile-time bound).
//! 3. `EnginePort::sink_set` registers all THREE substrate sinks
//!    (text / frame / audio) as `Supported` — the port is NOT an empty
//!    `SinkSet`.
//! 4. The manifest declares the driven capabilities (incl. `Snapshot` +
//!    `DeterministicReplay`) and passes substrate structural validation.
//! 5. The rlvm research-anchor boundary statement is reachable.

#[path = "support/port_support.rs"]
mod port_support;

use std::sync::Arc;

use utsushi_core::substrate::{
    AssetPackage, EnginePort, EvidenceTier, FidelityTier, PortCapability, SinkCapability,
};

use utsushi_reallive::{RLVM_RESEARCH_ANCHOR_BOUNDARY_STATEMENT, UtsushiReallivePort};

use port_support::{NullAssetPackage, synthetic_engine};

/// Compile-time proof that the type implements `EnginePort`.
fn assert_implements_engine_port<P: EnginePort>() {}

fn build_port() -> UtsushiReallivePort {
    let assets: Arc<dyn AssetPackage> = Arc::new(NullAssetPackage);
    UtsushiReallivePort::new(synthetic_engine(), assets, 1)
}

#[test]
fn port_implements_engine_port() {
    assert_implements_engine_port::<UtsushiReallivePort>();
}

#[test]
fn port_registers_all_three_substrate_sinks() {
    let port = build_port();
    let summary = port.sink_set().capabilities();
    assert!(
        matches!(summary.text, SinkCapability::Supported { .. }),
        "port must register a text sink"
    );
    assert!(
        matches!(summary.frame, SinkCapability::Supported { .. }),
        "port must register a frame sink"
    );
    assert!(
        matches!(summary.audio, SinkCapability::Supported { .. }),
        "port must register an audio sink"
    );
}

#[test]
fn manifest_declares_driven_capabilities_and_validates() {
    let manifest = &UtsushiReallivePort::MANIFEST;
    assert_eq!(manifest.id, "utsushi-reallive");
    assert_eq!(manifest.abi_version, 1);
    assert_eq!(manifest.fidelity_tier_max, FidelityTier::LayoutProbe);
    assert_eq!(manifest.evidence_tier_max, EvidenceTier::E2);
    for capability in [
        PortCapability::Launch,
        PortCapability::Observe,
        PortCapability::Capture,
        PortCapability::Shutdown,
        PortCapability::Snapshot,
        PortCapability::DeterministicReplay,
    ] {
        assert!(
            manifest.capabilities.contains(&capability),
            "manifest must declare {capability:?}"
        );
    }
    manifest
        .validate()
        .expect("real port manifest passes substrate-level structural validation");
}

#[test]
fn rlvm_boundary_statement_carries_load_bearing_phrases() {
    let statement = RLVM_RESEARCH_ANCHOR_BOUNDARY_STATEMENT;
    for phrase in [
        "research anchor",
        "does not depend on rlvm",
        "does not mechanically translate",
    ] {
        assert!(
            statement.contains(phrase),
            "boundary statement must carry the phrase {phrase:?}: {statement}"
        );
    }
}
