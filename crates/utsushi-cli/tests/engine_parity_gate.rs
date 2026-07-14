//! Cross-engine capability **parity conformance gate**.
//!
//! Feature-parity across ALL engine ports is a CI-enforced invariant, not a
//! hope. This test is the enforcement point: `build.rs` scans every
//! `utsushi-*` workspace crate that depends on `utsushi-core` and implements
//! `EnginePort`, generates imports for each discovered `PARITY_PROFILE`, and
//! this test runs the `utsushi-core` parity gate over that generated set. It
//! goes RED if any engine lacks a capability another engine wires, unless that
//! gap is an explicitly-declared dev-`Pending` (a delegation scaffold still
//! being wired) or a uniform framework limitation (a capability no engine
//! wires yet).
//!
//! `utsushi-cli` is the crate that can see every engine port (ports it does
//! not use in production are pulled in dev-only, see Cargo.toml), so the gate
//! lives here. `just ci-utsushi` runs `cargo test -p utsushi-cli`, which is
//! how this gate is wired into CI. Adding a new `EnginePort` crate without
//! making it visible to this crate, exporting its port type, or publishing a
//! `PARITY_PROFILE` fails during the generated registry build/compile.
//!
//! To PROVE the gate has teeth, flip any engine's `Snapshot`
//! `DeterministicReplay` declaration from `Pending` to `NotApplicable` (or
//! delete it): `parity_gate_is_green_for_the_current_engine_set` then FAILS
//! with a `ForbiddenNotApplicable` / `Undeclared` gap, because
//! `utsushi-reallive` wires those capabilities. The synthetic teeth tests in
//! `utsushi_core::port::parity` prove the same mechanism deterministically.

use utsushi_core::substrate::{
    CapabilityStance, EngineParityProfile, PortCapability, evaluate_parity,
};

use utsushi_fixture::FixtureEnginePort;
use utsushi_reallive::UtsushiReallivePort;

include!(concat!(env!("OUT_DIR"), "/engine_parity_registry.rs"));

#[test]
fn generated_profile_set_matches_the_discovered_engine_ports() {
    let profiles = registered_engine_profiles();
    let ids: Vec<&str> = profiles.iter().map(EngineParityProfile::id).collect();
    assert_eq!(
        ids.len(),
        DISCOVERED_ENGINE_PORT_IMPLS.len(),
        "the generated registry must emit one parity profile per discovered EnginePort impl",
    );
    for ((crate_name, type_name), profile) in DISCOVERED_ENGINE_PORT_IMPLS.iter().zip(&profiles) {
        assert_eq!(
            profile.id(),
            *crate_name,
            "generated profile for {crate_name}::{type_name} should carry the crate's stable port id",
        );
    }
}

#[test]
fn parity_gate_is_green_for_the_current_engine_set() {
    let profiles = registered_engine_profiles();
    let report = match evaluate_parity(&profiles) {
        Ok(report) => report,
        Err(failure) => panic!("engine-port capability parity gate is RED:\n{failure}"),
    };

    // The four required lifecycle capabilities plus RealLive's port-driven
    // Snapshot / DeterministicReplay are all wired by >=1 engine.
    for capability in [
        PortCapability::Launch,
        PortCapability::Observe,
        PortCapability::Capture,
        PortCapability::Shutdown,
        PortCapability::Snapshot,
        PortCapability::DeterministicReplay,
    ] {
        assert!(
            report.supported_by_any.contains(&capability),
            "{capability:?} should be wired by at least one engine",
        );
    }

    // Jump is wired by no engine today: a uniform framework limitation.
    assert!(
        report.uniform_limitations.contains(&PortCapability::Jump),
        "Jump should be a uniform framework limitation (no engine wires it yet)",
    );

    // Every non-RealLive engine declares Snapshot + DeterministicReplay as
    // dev-Pending; those are the allowed gaps keeping the gate green.
    assert!(
        !report.pending.is_empty(),
        "the current engine set has declared dev-pending gaps (Snapshot / DeterministicReplay)",
    );
    assert!(
        report
            .pending
            .iter()
            .any(|pending| pending.capability == PortCapability::Snapshot),
        "Snapshot should appear as a declared dev-pending gap for the scaffold ports",
    );
}

#[test]
fn every_registered_profile_is_structurally_valid() {
    for profile in registered_engine_profiles() {
        profile.validate().unwrap_or_else(|error| {
            panic!(
                "profile `{}` is structurally invalid: {error}",
                profile.id()
            )
        });
    }
}

/// Teeth on the REAL engine set: cloning the live profiles and flipping one
/// scaffold's `Snapshot` declaration from `Pending` to `NotApplicable` makes
/// the gate go RED, because `utsushi-reallive` wires `Snapshot`. This proves
/// the gate rejects a permanent one-engine gap without mutating the shipped
/// profiles.
#[test]
fn gate_goes_red_when_a_real_engine_marks_a_peer_wired_capability_not_applicable() {
    // Build a profile set where the fixture permanently disclaims Snapshot.
    const FIXTURE_SNAPSHOT_NA: &[utsushi_core::substrate::CapabilityDeclaration] = &[
        utsushi_core::substrate::CapabilityDeclaration {
            capability: PortCapability::Snapshot,
            stance: CapabilityStance::NotApplicable,
            note: "TEETH PROBE: permanently disclaim a capability RealLive wires",
        },
        utsushi_core::substrate::CapabilityDeclaration {
            capability: PortCapability::DeterministicReplay,
            stance: CapabilityStance::Pending,
            note: "dev pending",
        },
    ];
    let tampered = EngineParityProfile {
        manifest: FixtureEnginePort::MANIFEST,
        declarations: FIXTURE_SNAPSHOT_NA,
    };
    let profiles = vec![UtsushiReallivePort::PARITY_PROFILE, tampered];

    let failure = evaluate_parity(&profiles)
        .expect_err("marking a peer-wired capability NotApplicable must fail the gate");
    assert!(
        failure.gaps.iter().any(|gap| {
            gap.engine == "utsushi-fixture" && gap.capability == PortCapability::Snapshot
        }),
        "the forbidden gap should name the offending engine + capability; got: {failure}",
    );
}
