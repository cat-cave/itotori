//! Cross-engine capability **parity conformance gate**.
//!
//! Feature-parity across ALL engine ports is a CI-enforced invariant, not a
//! hope. This test is the enforcement point: it collects the
//! `PARITY_PROFILE` every registered engine adapter publishes and runs the
//! `utsushi-core` parity gate over the whole set. It goes RED if any engine
//! lacks a capability another engine wires, unless that gap is an
//! explicitly-declared dev-`Pending` (a delegation scaffold still being
//! wired) or a uniform framework limitation (a capability no engine wires
//! yet).
//!
//! `utsushi-cli` is the crate that can see every engine port (the three ports
//! it does not use in production are pulled in dev-only, see Cargo.toml), so
//! the gate lives here. `just ci-utsushi` runs `cargo test -p utsushi-cli`,
//! which is how this gate is wired into CI.
//!
//! To PROVE the gate has teeth, flip any engine's `Snapshot` /
//! `DeterministicReplay` declaration from `Pending` to `NotApplicable` (or
//! delete it): `parity_gate_is_green_for_the_current_engine_set` then FAILS
//! with a `ForbiddenNotApplicable` / `Undeclared` gap, because
//! `utsushi-reallive` wires those capabilities. The synthetic teeth tests in
//! `utsushi_core::port::parity` prove the same mechanism deterministically.

use utsushi_core::substrate::{
    CapabilityStance, EngineParityProfile, PortCapability, evaluate_parity,
};

use utsushi_fixture::FixtureEnginePort;
use utsushi_kirikiri_xp3::KirikiriXp3EnginePort;
use utsushi_reallive::UtsushiReallivePort;
use utsushi_rpgmaker_mv::UtsushiRpgmakerMvPort;
use utsushi_rpgmaker_mv_mz::RpgMakerMvMzEnginePort;
use utsushi_siglus::UtsushiSiglusPort;

/// Every registered engine port's parity profile. Adding a new engine-port
/// crate REQUIRES adding its `PARITY_PROFILE` here — the id-set assertion
/// below fails otherwise, so a new engine cannot silently escape the gate.
fn registered_engine_profiles() -> Vec<EngineParityProfile> {
    vec![
        FixtureEnginePort::PARITY_PROFILE,
        UtsushiReallivePort::PARITY_PROFILE,
        UtsushiSiglusPort::PARITY_PROFILE,
        KirikiriXp3EnginePort::PARITY_PROFILE,
        UtsushiRpgmakerMvPort::PARITY_PROFILE,
        RpgMakerMvMzEnginePort::PARITY_PROFILE,
    ]
}

/// The engine-port ids the gate is expected to cover. Pinned so that adding
/// an engine crate without registering its profile above (or removing one)
/// fails loudly rather than shrinking the parity surface silently.
const EXPECTED_ENGINE_PORT_IDS: &[&str] = &[
    "utsushi-fixture",
    "utsushi-reallive",
    "utsushi-siglus",
    "utsushi-kirikiri-xp3",
    "utsushi-rpgmaker-mv",
    "utsushi-rpgmaker-mv-mz",
];

#[test]
fn registered_profile_set_matches_the_expected_engine_ports() {
    let mut ids: Vec<&str> = registered_engine_profiles()
        .iter()
        .map(EngineParityProfile::id)
        .collect();
    ids.sort_unstable();
    let mut expected: Vec<&str> = EXPECTED_ENGINE_PORT_IDS.to_vec();
    expected.sort_unstable();
    assert_eq!(
        ids, expected,
        "the registered engine-port parity profile set drifted from the expected set; \
         a new engine port must register its PARITY_PROFILE in this gate",
    );
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
