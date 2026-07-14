//! Cross-engine capability **parity contract** + **conformance gate**.
//!
//! Feature-parity across every engine port is a CI-enforced invariant, not a
//! hope. The failure mode this module makes impossible to ship (outside dev)
//! is an engine-specific capability gap: one engine silently lacking a
//! capability another engine already exposes. Interpreter-backed ports
//! (RealLive — owns the VM) and delegation-backed scaffolds (RPG Maker
//! MV/MZ, KiriKiri XP3 — drive the real browser/NW.js/TJS runtime) must
//! expose the SAME capability surface, or the framework degrades UNIFORMLY —
//! never one engine quietly.
//!
//! # The mechanism
//!
//! 1. [`CAPABILITY_CONTRACT`] is the explicit, introspectable enumeration of
//!    the engine-port capability surface, seeded from the capabilities the
//!    [`EnginePort`](super::EnginePort) trait + adapters express **today**
//!    (the [`PortCapability`] set). A compile-time guard forces every new
//!    `PortCapability` variant into the contract, so a capability added later
//!    (embed-surface, word-wrap-metrics, jump-to-scene, hook-text
//!    inject-preview, read-state, …) is automatically swept into the parity
//!    check across all engines.
//!
//! 2. Each engine adapter publishes an [`EngineParityProfile`]: its audit
//!    [`PortManifest`] (the **wired** capability set is
//!    `manifest.capabilities` — the single source of truth) plus explicit
//!    [`CapabilityDeclaration`]s giving a [`CapabilityStance`] — `Pending`
//!    (dev-not-yet-built) or `NotApplicable` (permanent) — for capabilities
//!    it does NOT wire.
//!
//! 3. [`evaluate_parity`] is the conformance gate. It is RED when any engine
//!    lacks a capability that any OTHER engine wires, UNLESS the gap is an
//!    explicitly-declared dev `Pending`. A capability wired by ≥1 engine and
//!    marked `NotApplicable` (permanent) by another — or left undeclared —
//!    is a forbidden gap and fails the gate. A capability NO engine wires yet
//!    is a **uniform framework limitation** and is allowed.
//!
//! This distinguishes a dev-pending scaffold from a forbidden permanent gap:
//! `Pending` keeps the gate green while a delegation port is still being
//! wired, but a `Pending` capability can never silently rot into a permanent
//! one-engine gap — that flips to `NotApplicable`/undeclared and goes RED.

use std::fmt;

use super::manifest::{PortCapability, PortManifest};

/// The uniform engine-port capability surface. Seeded from the capabilities
/// the `EnginePort` trait + adapters express today. Every [`PortCapability`]
/// variant MUST appear here exactly once; the compile-time guard below fails
/// the build otherwise, so adding a variant automatically extends the gate.
pub const CAPABILITY_CONTRACT: &[PortCapability] = &[
    PortCapability::Launch,
    PortCapability::Observe,
    PortCapability::Capture,
    PortCapability::Shutdown,
    PortCapability::Jump,
    PortCapability::Snapshot,
    PortCapability::DeterministicReplay,
    PortCapability::ReplayReview,
];

/// Number of `PortCapability` variants. Guarded to equal both
/// `CAPABILITY_CONTRACT.len()` and the exhaustive match in
/// [`capability_ordinal`], so the contract cannot drift from the enum.
const CONTRACT_LEN: usize = 8;

/// Const-eval ordinal for a capability. The exhaustive `match` is the load
/// bearing part: adding a `PortCapability` variant makes this fail to compile
/// until an ordinal is assigned AND [`CONTRACT_LEN`] is bumped, which in turn
/// forces the new variant into [`CAPABILITY_CONTRACT`] via the guard block.
const fn capability_ordinal(capability: PortCapability) -> usize {
    match capability {
        PortCapability::Launch => 0,
        PortCapability::Observe => 1,
        PortCapability::Capture => 2,
        PortCapability::Shutdown => 3,
        PortCapability::Jump => 4,
        PortCapability::Snapshot => 5,
        PortCapability::DeterministicReplay => 6,
        PortCapability::ReplayReview => 7,
    }
}

// Compile-time guard: `CAPABILITY_CONTRACT` covers every `PortCapability`
// variant exactly once. A missing or duplicated capability fails the build.
const _: () = {
    assert!(
        CAPABILITY_CONTRACT.len() == CONTRACT_LEN,
        "CAPABILITY_CONTRACT length must equal the PortCapability variant count",
    );
    let mut seen = [false; CONTRACT_LEN];
    let mut index = 0;
    while index < CAPABILITY_CONTRACT.len() {
        let ordinal = capability_ordinal(CAPABILITY_CONTRACT[index]);
        assert!(
            !seen[ordinal],
            "duplicate capability in CAPABILITY_CONTRACT"
        );
        seen[ordinal] = true;
        index += 1;
    }
    let mut ordinal = 0;
    while ordinal < CONTRACT_LEN {
        assert!(
            seen[ordinal],
            "a PortCapability variant is missing from CAPABILITY_CONTRACT",
        );
        ordinal += 1;
    }
};

/// A single engine's stance on a contract capability.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CapabilityStance {
    /// Supported today and backed by exercised machinery. Derived from
    /// [`PortManifest::capabilities`]; never spelled out in a
    /// [`CapabilityDeclaration`].
    Wired,
    /// Dev-not-yet-built. A port (typically a delegation scaffold) that WILL
    /// wire this capability but has not yet. Allowed by the gate, but recorded
    /// so it can never silently harden into a permanent one-engine gap.
    Pending,
    /// Declared permanently not-applicable to this engine. FORBIDDEN by the
    /// gate when ≥1 other engine wires the same capability — that is the
    /// silent-gap failure mode the parity invariant exists to prevent.
    NotApplicable,
}

impl CapabilityStance {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Wired => "wired",
            Self::Pending => "pending",
            Self::NotApplicable => "not_applicable",
        }
    }
}

/// Explicit stance an engine declares for a capability it does NOT wire.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CapabilityDeclaration {
    /// Capability being declared. Must be a member of [`CAPABILITY_CONTRACT`].
    pub capability: PortCapability,
    /// Declared stance. MUST be [`CapabilityStance::Pending`] or
    /// [`CapabilityStance::NotApplicable`]; declaring [`CapabilityStance::Wired`]
    /// here is a structural error (wired-ness is read from the manifest).
    pub stance: CapabilityStance,
    /// Audit-grade justification (why pending, or why permanently N/A).
    pub note: &'static str,
}

/// The parity profile an engine adapter publishes: its manifest (source of
/// wired capabilities) plus explicit declarations for the rest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EngineParityProfile {
    /// The engine's audit manifest. `manifest.capabilities` is the wired set.
    pub manifest: PortManifest,
    /// Explicit stance for capabilities the engine does NOT wire. An engine
    /// only strictly needs to declare a capability that some OTHER engine
    /// wires; the cross-engine gate treats an undeclared, peer-supported
    /// capability as a forbidden silent gap.
    pub declarations: &'static [CapabilityDeclaration],
}

impl EngineParityProfile {
    /// Stable engine/port id.
    pub fn id(&self) -> &'static str {
        self.manifest.id
    }

    /// Whether the engine wires (supports today) a capability.
    pub fn wires(&self, capability: PortCapability) -> bool {
        self.manifest.capabilities.contains(&capability)
    }

    fn declaration(&self, capability: PortCapability) -> Option<&CapabilityDeclaration> {
        self.declarations
            .iter()
            .find(|declaration| declaration.capability == capability)
    }

    /// Resolve the engine's stance on a capability: [`CapabilityStance::Wired`]
    /// (from the manifest), the declared stance, or `None` when the engine
    /// neither wires nor declares it.
    pub fn stance(&self, capability: PortCapability) -> Option<CapabilityStance> {
        if self.wires(capability) {
            return Some(CapabilityStance::Wired);
        }
        self.declaration(capability)
            .map(|declaration| declaration.stance)
    }

    /// Structural self-validation, independent of peer engines. Checks the
    /// manifest and every declaration for well-formedness.
    pub fn validate(&self) -> Result<(), ParityError> {
        let engine = self.manifest.id;
        self.manifest
            .validate()
            .map_err(|source| ParityError::ManifestInvalid {
                engine,
                source: source.to_string(),
            })?;

        for (index, declaration) in self.declarations.iter().enumerate() {
            let capability = declaration.capability;
            if !CAPABILITY_CONTRACT.contains(&capability) {
                return Err(ParityError::DeclarationOutsideContract { engine, capability });
            }
            if self.wires(capability) {
                return Err(ParityError::WiredCapabilityDeclared { engine, capability });
            }
            if declaration.stance == CapabilityStance::Wired {
                return Err(ParityError::WiredStanceDeclared { engine, capability });
            }
            if declaration.note.trim().is_empty() {
                return Err(ParityError::DeclarationNoteMissing { engine, capability });
            }
            if self.declarations[..index]
                .iter()
                .any(|earlier| earlier.capability == capability)
            {
                return Err(ParityError::DuplicateDeclaration { engine, capability });
            }
        }
        Ok(())
    }
}

/// A structural fault in a single [`EngineParityProfile`], surfaced before the
/// cross-engine comparison.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ParityError {
    /// The engine's manifest failed its own structural validation.
    ManifestInvalid {
        engine: &'static str,
        source: String,
    },
    /// A declaration named a capability outside [`CAPABILITY_CONTRACT`].
    DeclarationOutsideContract {
        engine: &'static str,
        capability: PortCapability,
    },
    /// A declaration named a capability the engine already wires.
    WiredCapabilityDeclared {
        engine: &'static str,
        capability: PortCapability,
    },
    /// A declaration used [`CapabilityStance::Wired`] (only manifests confer
    /// wired-ness).
    WiredStanceDeclared {
        engine: &'static str,
        capability: PortCapability,
    },
    /// A declaration carried an empty (non-audit-grade) note.
    DeclarationNoteMissing {
        engine: &'static str,
        capability: PortCapability,
    },
    /// Two declarations named the same capability.
    DuplicateDeclaration {
        engine: &'static str,
        capability: PortCapability,
    },
}

impl fmt::Display for ParityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ManifestInvalid { engine, source } => {
                write!(formatter, "engine `{engine}`: manifest invalid: {source}")
            }
            Self::DeclarationOutsideContract { engine, capability } => write!(
                formatter,
                "engine `{engine}`: declaration names `{}` which is outside the capability contract",
                capability.as_str(),
            ),
            Self::WiredCapabilityDeclared { engine, capability } => write!(
                formatter,
                "engine `{engine}`: declares a stance for `{}` which it already wires (wired-ness comes from the manifest)",
                capability.as_str(),
            ),
            Self::WiredStanceDeclared { engine, capability } => write!(
                formatter,
                "engine `{engine}`: declaration for `{}` uses the Wired stance (only the manifest confers wired-ness)",
                capability.as_str(),
            ),
            Self::DeclarationNoteMissing { engine, capability } => write!(
                formatter,
                "engine `{engine}`: declaration for `{}` has an empty note",
                capability.as_str(),
            ),
            Self::DuplicateDeclaration { engine, capability } => write!(
                formatter,
                "engine `{engine}`: duplicate declaration for `{}`",
                capability.as_str(),
            ),
        }
    }
}

impl std::error::Error for ParityError {}

/// Why a peer-supported capability is a forbidden gap for an engine.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParityGapKind {
    /// The engine marked a peer-supported capability permanently N/A.
    ForbiddenNotApplicable,
    /// The engine neither wires nor declares a peer-supported capability — a
    /// silent gap.
    Undeclared,
}

impl ParityGapKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ForbiddenNotApplicable => "forbidden_not_applicable",
            Self::Undeclared => "undeclared",
        }
    }
}

/// A forbidden parity gap: `engine` lacks `capability`, which ≥1 other engine
/// wires, and the gap is not an allowed dev `Pending`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ParityGap {
    pub engine: &'static str,
    pub capability: PortCapability,
    pub kind: ParityGapKind,
    /// The engines that DO wire the capability (why the gap is forbidden).
    pub wired_by: &'static str,
}

impl fmt::Display for ParityGap {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "engine `{}` lacks capability `{}` ({}) which is wired by [{}]",
            self.engine,
            self.capability.as_str(),
            self.kind.as_str(),
            self.wired_by,
        )
    }
}

/// An allowed dev-pending gap, reported (never a violation).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ParityPending {
    pub engine: &'static str,
    pub capability: PortCapability,
    pub note: &'static str,
}

/// The green outcome of the parity gate.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParityReport {
    /// Capabilities wired by ≥1 engine (the parity floor every engine must
    /// meet or declare `Pending` against).
    pub supported_by_any: Vec<PortCapability>,
    /// Capabilities NO engine wires yet — uniform framework limitations
    /// (allowed; the whole framework lacks them uniformly).
    pub uniform_limitations: Vec<PortCapability>,
    /// Allowed dev-pending gaps, per engine.
    pub pending: Vec<ParityPending>,
}

/// The red outcome: structural faults and/or forbidden gaps.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParityFailure {
    pub structural_errors: Vec<ParityError>,
    pub gaps: Vec<ParityGap>,
}

impl fmt::Display for ParityFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(
            formatter,
            "engine-port capability parity gate FAILED ({} structural error(s), {} forbidden gap(s)):",
            self.structural_errors.len(),
            self.gaps.len(),
        )?;
        for error in &self.structural_errors {
            writeln!(formatter, "  - structural: {error}")?;
        }
        for gap in &self.gaps {
            writeln!(formatter, "  - gap: {gap}")?;
        }
        Ok(())
    }
}

impl std::error::Error for ParityFailure {}

/// The parity conformance gate. Returns a [`ParityReport`] when every engine
/// is at parity (or its gaps are declared dev-`Pending`, or a capability is a
/// uniform framework limitation), and a [`ParityFailure`] otherwise.
///
/// A gap is a [`ParityFailure`] when a capability wired by ≥1 engine is marked
/// [`CapabilityStance::NotApplicable`] (permanent) by another engine, or left
/// undeclared by it. A dev [`CapabilityStance::Pending`] gap is allowed and
/// only reported. A capability no engine wires is a uniform framework
/// limitation and is allowed.
pub fn evaluate_parity(profiles: &[EngineParityProfile]) -> Result<ParityReport, ParityFailure> {
    let mut structural_errors = Vec::new();
    for profile in profiles {
        if let Err(error) = profile.validate() {
            structural_errors.push(error);
        }
    }

    // Capabilities wired by at least one engine, in contract order.
    let mut supported_by_any = Vec::new();
    let mut uniform_limitations = Vec::new();
    for &capability in CAPABILITY_CONTRACT {
        if profiles.iter().any(|profile| profile.wires(capability)) {
            supported_by_any.push(capability);
        } else {
            uniform_limitations.push(capability);
        }
    }

    let mut gaps = Vec::new();
    let mut pending = Vec::new();
    for profile in profiles {
        for &capability in &supported_by_any {
            match profile.stance(capability) {
                Some(CapabilityStance::Wired) => {}
                Some(CapabilityStance::Pending) => {
                    let note = profile
                        .declaration(capability)
                        .map_or("", |declaration| declaration.note);
                    pending.push(ParityPending {
                        engine: profile.id(),
                        capability,
                        note,
                    });
                }
                Some(CapabilityStance::NotApplicable) => gaps.push(ParityGap {
                    engine: profile.id(),
                    capability,
                    kind: ParityGapKind::ForbiddenNotApplicable,
                    wired_by: first_wiring_engine(profiles, capability),
                }),
                None => gaps.push(ParityGap {
                    engine: profile.id(),
                    capability,
                    kind: ParityGapKind::Undeclared,
                    wired_by: first_wiring_engine(profiles, capability),
                }),
            }
        }
    }

    if structural_errors.is_empty() && gaps.is_empty() {
        Ok(ParityReport {
            supported_by_any,
            uniform_limitations,
            pending,
        })
    } else {
        Err(ParityFailure {
            structural_errors,
            gaps,
        })
    }
}

fn first_wiring_engine(
    profiles: &[EngineParityProfile],
    capability: PortCapability,
) -> &'static str {
    profiles
        .iter()
        .find(|profile| profile.wires(capability))
        .map_or("<none>", EngineParityProfile::id)
}

#[cfg(test)]
mod tests {
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
}
