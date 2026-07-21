use super::*;
use crate::port::manifest::REQUIRED_LIFECYCLE_STAGES;
use crate::{EvidenceTier, FidelityTier};

const BASE_CAPS: &[PortCapability] = &[
    PortCapability::Launch,
    PortCapability::Observe,
    PortCapability::Capture,
    PortCapability::Shutdown,
];

const FULL_CAPS: &[PortCapability] = &[
    PortCapability::Launch,
    PortCapability::Observe,
    PortCapability::Capture,
    PortCapability::Shutdown,
    PortCapability::Snapshot,
    PortCapability::DeterministicReplay,
];

fn manifest(id: &'static str, capabilities: &'static [PortCapability]) -> PortManifest {
    PortManifest {
        id,
        name: "Parity Test Port",
        version: "0.0.0",
        abi_version: 1,
        capabilities,
        required_methods: REQUIRED_LIFECYCLE_STAGES,
        optional_methods: &[],
        env_schema: &[],
        fidelity_tier_max: FidelityTier::LayoutProbe,
        evidence_tier_max: EvidenceTier::E2,
        limitations: &[],
    }
}

const SNAPSHOT_PENDING: &[CapabilityDeclaration] = &[
    CapabilityDeclaration {
        capability: PortCapability::Snapshot,
        stance: CapabilityStance::Pending,
        note: "dev: snapshot machinery not yet wired",
    },
    CapabilityDeclaration {
        capability: PortCapability::DeterministicReplay,
        stance: CapabilityStance::Pending,
        note: "dev: deterministic replay not yet wired",
    },
];

#[test]
fn contract_covers_every_capability_exactly_once() {
    assert_eq!(CAPABILITY_CONTRACT.len(), CONTRACT_LEN);
    for &capability in CAPABILITY_CONTRACT {
        let occurrences = CAPABILITY_CONTRACT
            .iter()
            .filter(|&&other| other == capability)
            .count();
        assert_eq!(occurrences, 1, "{capability:?} must appear once");
    }
}

#[test]
fn parity_passes_when_gaps_are_declared_pending() {
    // One engine wires Snapshot + DeterministicReplay; the other declares
    // them dev-Pending. Green — parity via declared dev-pending.
    let full = EngineParityProfile {
        manifest: manifest("utsushi-full-port", FULL_CAPS),
        declarations: &[],
    };
    let scaffold = EngineParityProfile {
        manifest: manifest("utsushi-scaffold", BASE_CAPS),
        declarations: SNAPSHOT_PENDING,
    };
    let report = evaluate_parity(&[full, scaffold]).expect("declared-pending gaps are allowed");
    assert!(report.supported_by_any.contains(&PortCapability::Snapshot));
    assert!(report.uniform_limitations.contains(&PortCapability::Jump));
    assert_eq!(report.pending.len(), 2);
}

#[test]
fn parity_red_on_not_applicable_gap_against_peer_wired_capability() {
    // TEETH: marking a peer-supported capability permanently N/A is RED.
    const SNAPSHOT_NA: &[CapabilityDeclaration] = &[
        CapabilityDeclaration {
            capability: PortCapability::Snapshot,
            stance: CapabilityStance::NotApplicable,
            note: "permanent: this engine will never snapshot",
        },
        CapabilityDeclaration {
            capability: PortCapability::DeterministicReplay,
            stance: CapabilityStance::Pending,
            note: "dev pending",
        },
    ];
    let full = EngineParityProfile {
        manifest: manifest("utsushi-full-port", FULL_CAPS),
        declarations: &[],
    };
    let bad = EngineParityProfile {
        manifest: manifest("utsushi-bad-port", BASE_CAPS),
        declarations: SNAPSHOT_NA,
    };
    let failure = evaluate_parity(&[full, bad]).expect_err("N/A vs peer-wired must be RED");
    assert!(failure.gaps.iter().any(|gap| {
        gap.engine == "utsushi-bad-port"
            && gap.capability == PortCapability::Snapshot
            && gap.kind == ParityGapKind::ForbiddenNotApplicable
    }));
}

#[test]
fn parity_red_on_undeclared_gap_against_peer_wired_capability() {
    // TEETH: silently omitting a peer-supported capability is RED.
    let full = EngineParityProfile {
        manifest: manifest("utsushi-full-port", FULL_CAPS),
        declarations: &[],
    };
    let silent = EngineParityProfile {
        manifest: manifest("utsushi-silent-port", BASE_CAPS),
        declarations: &[], // no stance for Snapshot / DeterministicReplay
    };
    let failure = evaluate_parity(&[full, silent]).expect_err("undeclared gap must be RED");
    assert!(failure.gaps.iter().any(|gap| {
        gap.engine == "utsushi-silent-port" && gap.kind == ParityGapKind::Undeclared
    }));
}

#[test]
fn uniform_limitation_when_no_engine_wires_a_capability() {
    // No engine wires Snapshot/DeterministicReplay/Jump -> uniform, green
    // no declaration required.
    let a = EngineParityProfile {
        manifest: manifest("utsushi-port-aaa", BASE_CAPS),
        declarations: &[],
    };
    let b = EngineParityProfile {
        manifest: manifest("utsushi-port-bbb", BASE_CAPS),
        declarations: &[],
    };
    let report = evaluate_parity(&[a, b]).expect("uniform limitations are allowed");
    assert!(
        report
            .uniform_limitations
            .contains(&PortCapability::Snapshot)
    );
    assert!(report.uniform_limitations.contains(&PortCapability::Jump));
    assert!(report.pending.is_empty());
}

#[test]
fn structural_error_on_declaring_a_wired_capability() {
    const BAD: &[CapabilityDeclaration] = &[CapabilityDeclaration {
        capability: PortCapability::Launch, // already wired
        stance: CapabilityStance::Pending,
        note: "contradiction",
    }];
    let profile = EngineParityProfile {
        manifest: manifest("utsushi-contradict", BASE_CAPS),
        declarations: BAD,
    };
    assert!(matches!(
        profile.validate(),
        Err(ParityError::WiredCapabilityDeclared { .. })
    ));
    let failure = evaluate_parity(&[profile]).expect_err("structural fault must fail the gate");
    assert!(!failure.structural_errors.is_empty());
}

#[test]
fn structural_error_on_empty_declaration_note() {
    const BAD: &[CapabilityDeclaration] = &[CapabilityDeclaration {
        capability: PortCapability::Snapshot,
        stance: CapabilityStance::Pending,
        note: "   ",
    }];
    let profile = EngineParityProfile {
        manifest: manifest("utsushi-nonote", BASE_CAPS),
        declarations: BAD,
    };
    assert!(matches!(
        profile.validate(),
        Err(ParityError::DeclarationNoteMissing { .. })
    ));
}
