//! UTSUSHI-179 — `utsushi-rpgmaker-mv-mz` engine-port scaffold.
//!
//! # The browser IS the runtime
//!
//! RPG Maker MV and MZ ship a game as JSON event-command data (`www/data`
//! or `data`) executed by a **JavaScript** runtime — a browser or the
//! bundled **NW.js** shell. Unlike a bytecode VM (RealLive, Siglus), there
//! is no proprietary opcode stream for a Rust interpreter to decode: the
//! *browser* dispatches every `Show Text` / `Show Choices` / plugin
//! command. This port therefore carries **zero opcode handlers**
//! ([`OPCODE_HANDLER_COUNT`] `== 0`) by design, not by omission. It exists
//! to (a) declare the MV/MZ family through the `utsushi-core` substrate
//! facade + implementation-map conformance manifest, and (b) emit a
//! from-scratch [`CleanRoomAttestation`] for the browser/NW.js path.
//!
//! The sibling [`utsushi-rpgmaker-mv`](../utsushi_rpgmaker_mv/index.html)
//! crate is a *static event-data walk* (a Rust reader of the JSON command
//! list). This crate is the complementary **runtime-delegation** posture:
//! it makes no attempt to interpret commands in Rust; the browser/NW.js
//! adapter (`utsushi-cli`'s `BROWSER_LAUNCH_ADAPTER` / `NWJS_LAUNCH_ADAPTER`)
//! drives the real JS runtime, and this port's role is the audit-grade
//! conformance + clean-room-provenance surface for that path.
//!
//! # Clean-room provenance
//!
//! - No RPG Maker engine source (rpg_core / rpg_managers / rpg_objects /
//!   rpg_scenes / rpg_sprites / rpg_windows, MV or MZ) is vendored,
//!   linked, or mechanically translated into this crate.
//! - No decompiled or copyrighted engine bytes, no game project bytes, no
//!   NW.js binary are embedded. The event-command *code numbers* (101,
//!   401, 102, …) are public, widely-documented MV/MZ engine constants —
//!   and this crate does not even use them, because it dispatches nothing.
//! - The from-scratch posture is carried as reachable data
//!   ([`CLEAN_ROOM_ATTESTATION`], [`CleanRoomAttestation::emit`]) so audit
//!   tooling can pin it without scraping this docstring.
//!
//! # Substrate-facade containment
//!
//! Every `utsushi_core::*` symbol this crate consumes is sourced through
//! the public facade (`utsushi_core::substrate::*` for the runtime port
//! surface; `utsushi_core::port::impl_map::*` for the engine-neutral
//! conformance-manifest schema). This scaffold owns an empty [`SinkSet`]
//! and returns a typed [`EnginePortError::Lifecycle`] carrying
//! [`BROWSER_RUNTIME_MESSAGE`] from every lifecycle method — the honest
//! posture for "the Rust port drives nothing; the browser/NW.js runtime
//! does."

#![forbid(unsafe_code)]
#![deny(missing_debug_implementations)]

pub mod conformance;

use utsushi_core::substrate::{
    CapabilityDeclaration, CapabilityStance, EngineParityProfile, EnginePort, EnginePortError,
    EvidenceTier, FidelityTier, LifecycleStage, PortCapability, PortManifest, PortRequest,
    PortShutdownOutcome, REQUIRED_LIFECYCLE_STAGES, SinkSet,
};
// The single non-facade `utsushi_core::*` import, forced by the
// `EnginePort::capture` return type. `CaptureOutcome` is currently
// reachable only at the crate root — the substrate facade does not yet
// re-export it — so the same documented reach-around the `utsushi-siglus`
// and `utsushi-reallive` scaffolds carry is repeated here (renamed to make
// the audit site grep-pinnable). A future facade revision that lifts
// `CaptureOutcome` into `utsushi_core::substrate` drops it from all ports
// together.
use utsushi_core::CaptureOutcome as SubstrateCaptureOutcome;

/// Stable port id. Matches the `EngineFamily::RpgmakerMv` manifest prefix
/// `"utsushi-rpgmaker-mv"` (`impl_map::EngineFamily::manifest_prefix`) —
/// `"utsushi-rpgmaker-mv-mz"` starts with that prefix, so
/// [`utsushi_core::port::impl_map::validate_against_manifest`] accepts the
/// pairing. The `-mz` suffix records that the same JS-runtime port covers
/// both MV and MZ (see [`conformance`] engine-family notes).
pub const PORT_ID: &str = "utsushi-rpgmaker-mv-mz";

/// Crate semantic version, sourced from Cargo metadata.
const PORT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// The number of opcode handlers this port implements: **zero**, and a
/// compile-time-pinned invariant. The browser/NW.js JS engine is the MV/MZ
/// runtime; there is no Rust opcode interpreter here. The conformance test
/// asserts this is `0`; a future change that grows a Rust dispatcher would
/// break both the assertion and this crate's clean-room posture.
pub const OPCODE_HANDLER_COUNT: usize = 0;

/// The typed message every lifecycle method returns inside
/// [`EnginePortError::Lifecycle`]. Not an "unimplemented / someday"
/// marker — it states the by-design delegation: the Rust port drives
/// nothing; the browser/NW.js runtime executes the game. Pinned as a
/// public `const` so the conformance test can assert against it without
/// string-matching the human-readable display form.
pub const BROWSER_RUNTIME_MESSAGE: &str = "utsushi-rpgmaker-mv-mz drives no runtime in Rust: the browser/NW.js JS engine is the MV/MZ \
     runtime (zero opcode handlers by design). This port is the substrate-facade conformance + \
     clean-room-attestation surface for the browser/NW.js path.";

/// The from-scratch clean-room attestation statement, carried as a
/// publicly reachable `const &str`. Audit tooling (and the conformance
/// test) can pin the load-bearing phrases without scraping the crate-level
/// docstring. Intentionally free of host-local paths.
pub const CLEAN_ROOM_ATTESTATION_STATEMENT: &str = concat!(
    "utsushi-rpgmaker-mv-mz is a from-scratch clean-room implementation. ",
    "It vendors no RPG Maker MV/MZ engine source, links no engine object code, ",
    "and mechanically translates no decompiled or copyrighted engine code. ",
    "The browser/NW.js JavaScript engine is the MV/MZ runtime, so this port carries zero opcode handlers. ",
    "No game project bytes and no NW.js binary are embedded; MV/MZ event-command code numbers are public engine constants and are not used here because this port dispatches nothing.",
);

/// A from-scratch clean-room attestation for the browser/NW.js MV/MZ path.
///
/// Reachable as the `const` [`CLEAN_ROOM_ATTESTATION`] and renderable via
/// [`CleanRoomAttestation::emit`], so the provenance posture is *data*, not
/// prose an auditor must trust a human to have read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CleanRoomAttestation {
    /// Port id the attestation covers.
    pub port_id: &'static str,
    /// The runtime path this attestation is for.
    pub runtime_path: &'static str,
    /// Number of Rust opcode handlers (must be zero — the browser runs the game).
    pub opcode_handler_count: usize,
    /// The full from-scratch clean-room statement.
    pub statement: &'static str,
}

/// The single canonical clean-room attestation for this port.
pub const CLEAN_ROOM_ATTESTATION: CleanRoomAttestation = CleanRoomAttestation {
    port_id: PORT_ID,
    runtime_path: "browser/NW.js",
    opcode_handler_count: OPCODE_HANDLER_COUNT,
    statement: CLEAN_ROOM_ATTESTATION_STATEMENT,
};

impl CleanRoomAttestation {
    /// Emit the attestation as a deterministic, host-path-free text block.
    /// This is the "emitted" clean-room attestation the acceptance calls
    /// for: a caller (or CI) can render and record it without any I/O or
    /// serde dependency.
    pub fn emit(&self) -> String {
        format!(
            "clean-room-attestation\nport-id: {}\nruntime-path: {}\nopcode-handler-count: {}\nstatement: {}",
            self.port_id, self.runtime_path, self.opcode_handler_count, self.statement,
        )
    }
}

/// RPG Maker MV/MZ browser/NW.js engine-port scaffold.
///
/// Owns an empty [`SinkSet`] (no text/frame/audio sink: this port
/// rasterises nothing and traces nothing in Rust — the browser does).
/// Every lifecycle method returns a typed [`EnginePortError::Lifecycle`]
/// carrying [`BROWSER_RUNTIME_MESSAGE`].
#[derive(Debug)]
pub struct RpgMakerMvMzEnginePort {
    sink_set: SinkSet,
}

impl RpgMakerMvMzEnginePort {
    /// Audit-grade manifest declaration. Mirrors [`EnginePort::MANIFEST`]
    /// for direct introspection without going through the trait.
    ///
    /// Tier ceilings pin trace-only / E1: this port proves the *family +
    /// clean-room* contract for the browser/NW.js path, not on-screen
    /// fidelity (that evidence is produced by the browser/NW.js runtime
    /// adapter, not by this Rust port).
    pub const MANIFEST: PortManifest = PortManifest {
        id: PORT_ID,
        name: "Utsushi RPG Maker MV/MZ Engine Port (browser/NW.js, zero opcode handlers)",
        version: PORT_VERSION,
        abi_version: 1,
        capabilities: &[
            PortCapability::Launch,
            PortCapability::Observe,
            PortCapability::Capture,
            PortCapability::Shutdown,
        ],
        required_methods: REQUIRED_LIFECYCLE_STAGES,
        optional_methods: &[],
        env_schema: &[],
        fidelity_tier_max: FidelityTier::TraceOnly,
        evidence_tier_max: EvidenceTier::E1,
        limitations: &[
            "The browser/NW.js JavaScript engine is the MV/MZ runtime: this port carries zero opcode handlers by design and drives no runtime in Rust. Every lifecycle method returns a typed Lifecycle error.",
            "Not an interpreter: MV/MZ event-command dispatch (Show Text 401, Show Choices 102, plugin commands 356/357, …) happens in the browser/NW.js JS runtime, never in this crate.",
            "Scope is the substrate-facade conformance manifest + a from-scratch clean-room attestation for the browser/NW.js path; runtime evidence is produced by the browser/NW.js runtime adapter, not here.",
            "Clean-room: no RPG Maker MV/MZ engine source is vendored, linked, or mechanically translated; no decompiled/copyrighted engine code, no game bytes, no NW.js binary are embedded.",
        ],
    };

    /// Cross-engine capability parity profile (UTSUSHI parity gate). This
    /// delegation scaffold wires the four required lifecycle capabilities and
    /// declares the port-driven `Snapshot` / `DeterministicReplay`
    /// capabilities (wired by `utsushi-reallive`) as dev-`Pending`: they are
    /// driven by the browser/NW.js JS runtime the delegation adapter targets,
    /// which is not yet wired here. They are NOT `NotApplicable` — the
    /// delegated runtime can snapshot/replay — so the parity gate keeps them
    /// visible as a dev gap, never a permanent hole.
    pub const PARITY_PROFILE: EngineParityProfile = EngineParityProfile {
        manifest: Self::MANIFEST,
        declarations: &[
            CapabilityDeclaration {
                capability: PortCapability::Snapshot,
                stance: CapabilityStance::Pending,
                note: "dev: snapshot/restore is driven by the delegated browser/NW.js runtime, not yet wired through this scaffold.",
            },
            CapabilityDeclaration {
                capability: PortCapability::DeterministicReplay,
                stance: CapabilityStance::Pending,
                note: "dev: deterministic replay is driven by the delegated browser/NW.js runtime, not yet wired through this scaffold.",
            },
        ],
    };

    /// Construct the scaffold with an empty sink set.
    pub fn new() -> Self {
        Self {
            sink_set: SinkSet::new(),
        }
    }

    /// The from-scratch clean-room attestation this port emits.
    pub fn clean_room_attestation(&self) -> CleanRoomAttestation {
        CLEAN_ROOM_ATTESTATION
    }
}

impl Default for RpgMakerMvMzEnginePort {
    fn default() -> Self {
        Self::new()
    }
}

impl EnginePort for RpgMakerMvMzEnginePort {
    const MANIFEST: PortManifest = Self::MANIFEST;

    fn launch(&mut self, request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        request.cancellation.check(LifecycleStage::Launch)?;
        Err(browser_runtime_lifecycle(LifecycleStage::Launch))
    }

    fn observe(&mut self, request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        request.cancellation.check(LifecycleStage::Observe)?;
        Err(browser_runtime_lifecycle(LifecycleStage::Observe))
    }

    fn sink_set(&self) -> &SinkSet {
        &self.sink_set
    }

    fn capture(
        &mut self,
        request: &PortRequest<'_>,
    ) -> Result<SubstrateCaptureOutcome, EnginePortError> {
        request.cancellation.check(LifecycleStage::Capture)?;
        Err(browser_runtime_lifecycle(LifecycleStage::Capture))
    }

    fn shutdown(&mut self) -> Result<PortShutdownOutcome, EnginePortError> {
        Err(browser_runtime_lifecycle(LifecycleStage::Shutdown))
    }
}

/// Construct the typed browser-runtime-delegation error every lifecycle
/// method returns. Centralised so the conformance test has one place to
/// pin the "the browser is the runtime" posture.
fn browser_runtime_lifecycle(stage: LifecycleStage) -> EnginePortError {
    EnginePortError::Lifecycle {
        stage,
        message: BROWSER_RUNTIME_MESSAGE.to_string(),
        source: None,
    }
}

/// Compile-time invariants: zero opcode handlers, and non-empty pinned
/// strings. The runtime mirrors live in `tests/substrate_conformance.rs`.
const _: () = {
    assert!(OPCODE_HANDLER_COUNT == 0);
    assert!(CLEAN_ROOM_ATTESTATION.opcode_handler_count == 0);
    assert!(!BROWSER_RUNTIME_MESSAGE.is_empty());
    assert!(!CLEAN_ROOM_ATTESTATION_STATEMENT.is_empty());
};
