//! Substrate-conformance test for the `utsushi-rpgmaker-mv` runtime port.
//!
//! Two guarantees:
//!
//! 1. **Facade containment** — every `utsushi_core::*` symbol this test
//!    touches is imported through `utsushi_core::substrate::*`, and the
//!    `EnginePort` bound resolves through the facade re-export (not a
//!    direct `utsushi_core::port::EnginePort` reach-around). Mirrors the
//!    `utsushi-reallive` substrate_conformance test.
//! 2. **ABI conformance** — the port passes the `utsushi-core` ABI
//!    conformance harness (`run_required_abi`): manifest validation,
//!    launch → drain observations → capture → idempotent shutdown,
//!    cancellation observance, and the undeclared-`jump` typed
//!    `CapabilityUnsupported`. Because this port does real work on launch,
//!    the harness runs against a synthetic MV project written to a
//!    tempdir.

use std::fs;
use std::path::Path;

use utsushi_core::RuntimeArtifactRoot;
use utsushi_core::port::conformance::{ConformanceFixture, JumpOutcome, run_required_abi};
use utsushi_core::substrate::{
    EnginePort, EvidenceTier, FidelityTier, PortCapability, PortEnv, PortManifest,
};

use utsushi_rpgmaker_mv::UtsushiRpgmakerMvPort;

/// Compile-time witness that `UtsushiRpgmakerMvPort` resolves the
/// `EnginePort` bound through the facade re-export.
fn assert_port_resolves_facade_engine_port_bound<P: EnginePort>() {}

#[test]
fn port_resolves_only_facade_engine_port_trait() {
    assert_port_resolves_facade_engine_port_bound::<UtsushiRpgmakerMvPort>();
}

#[test]
fn manifest_is_well_formed_through_facade_types() {
    let manifest: &PortManifest = &UtsushiRpgmakerMvPort::MANIFEST;
    assert_eq!(manifest.id, "utsushi-rpgmaker-mv");
    assert_eq!(manifest.abi_version, 1);
    assert!(manifest.capabilities.contains(&PortCapability::Launch));
    assert!(manifest.capabilities.contains(&PortCapability::Observe));
    assert!(manifest.capabilities.contains(&PortCapability::Capture));
    assert!(manifest.capabilities.contains(&PortCapability::Shutdown));
    assert!(!manifest.capabilities.contains(&PortCapability::Jump));
    assert_eq!(manifest.fidelity_tier_max, FidelityTier::TraceOnly);
    assert_eq!(manifest.evidence_tier_max, EvidenceTier::E1);
    manifest
        .validate()
        .expect("manifest validates structurally");
}

/// Write a minimal but real synthetic MV project (`www/data/`). All text
/// is clean-room invented; no game bytes.
fn write_synthetic_mv_project(input_root: &Path) {
    let data = input_root.join("www").join("data");
    fs::create_dir_all(&data).expect("create www/data");
    fs::write(
        data.join("CommonEvents.json"),
        r#"[
            null,
            { "id": 1, "name": "Intro", "list": [
                { "code": 101, "indent": 0, "parameters": ["", 0, 0, 2, "Guide"] },
                { "code": 401, "indent": 0, "parameters": ["Welcome to the synthetic project."] },
                { "code": 401, "indent": 0, "parameters": ["Follow the markers."] },
                { "code": 102, "indent": 0, "parameters": [["Begin", "Wait"], 1] },
                { "code": 0, "indent": 0, "parameters": [] }
            ] }
        ]"#,
    )
    .expect("write CommonEvents.json");
    fs::write(
        data.join("Map001.json"),
        r#"{
            "events": [
                null,
                { "id": 1, "pages": [
                    { "list": [
                        { "code": 101, "indent": 0, "parameters": ["", 0, 0, 2, "Villager"] },
                        { "code": 401, "indent": 0, "parameters": ["Nice weather today."] },
                        { "code": 105, "indent": 0, "parameters": [2, false] },
                        { "code": 405, "indent": 0, "parameters": ["The wind carries old songs."] },
                        { "code": 0, "indent": 0, "parameters": [] }
                    ] }
                ] }
            ]
        }"#,
    )
    .expect("write Map001.json");
}

#[test]
fn port_passes_required_abi_conformance() {
    let temp = tempfile::tempdir().expect("tempdir");
    let input_root = temp.path().join("project");
    write_synthetic_mv_project(&input_root);

    let artifact_root = RuntimeArtifactRoot::new(temp.path().join("artifacts"));
    artifact_root
        .prepare()
        .expect("prepare managed artifact root");

    let fixture = ConformanceFixture {
        input_root,
        artifact_root,
        env: PortEnv::new(),
        run_id: "rpgmaker-mv-conformance-0001".to_string(),
    };

    let report = run_required_abi(UtsushiRpgmakerMvPort::new, &fixture)
        .expect("rpgmaker-mv port passes required ABI conformance");

    assert_eq!(report.manifest_id, "utsushi-rpgmaker-mv");
    assert!(report.launched);
    // 4 dialogue/scrolling lines + 2 choice options = 6 observed lines.
    assert_eq!(report.observation_count, 6);
    assert!(report.captured);
    assert!(report.first_shutdown_clean);
    assert!(report.second_shutdown_idempotent);
    assert_eq!(report.jump_outcome, JumpOutcome::NotDeclared);
    assert!(report.cancellation_observed);
}
