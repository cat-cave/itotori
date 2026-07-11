//! UTSUSHI-181 — `utsushi-kirikiri-xp3` engine-port scaffold.
//!
//! # The KiriKiri/KAG TJS engine IS the runtime
//!
//! KiriKiri ships a game as KAG script (`.ks`) plus TJS code inside an **XP3**
//! archive; the **native KiriKiri2 / KirikiriZ** shell (or a browser
//! reimplementation) executes every `@` tag / `[macro]` / `*label` jump.
//! Unlike a bytecode VM (RealLive, Siglus), there is no proprietary opcode
//! stream for a Rust interpreter to decode: the **TJS runtime** dispatches
//! every KAG tag. This port therefore carries **zero opcode handlers**
//! ([`OPCODE_HANDLER_COUNT`] `== 0`) by design, not by omission. It exists to
//! (a) declare the KiriKiri/KAG family through the `utsushi-core` substrate
//! facade + implementation-map conformance manifest, and (b) emit a
//! from-scratch [`CleanRoomAttestation`] for the KAG plaintext (`.ks`) path.
//!
//! The sibling [`utsushi-kirikiri`](../utsushi_kirikiri/index.html) crate is a
//! *static KAG plaintext replay skeleton* (a Rust reader of the already-
//! extracted `.ks` control flow). This crate is the complementary
//! **runtime-delegation** posture: it makes no attempt to interpret KAG/TJS in
//! Rust; the native/browser KiriKiri runtime drives the real game, and this
//! port's role is the audit-grade conformance + clean-room-provenance surface
//! for that path.
//!
//! # Clean-room provenance (KAG plaintext path)
//!
//! - No KiriKiri / KirikiriZ / TJS engine source (the KAG plugin, `krkr*`
//!   sources, the TJS2 interpreter) is vendored, linked, or mechanically
//!   translated into this crate.
//! - No decompiled or copyrighted engine bytes, no game project bytes, and no
//!   XP3 container bytes are embedded. The KAG tag names (`@text`, `@ruby`,
//!   `[l]`, `[p]`, …) are public, widely-documented KAG constructs — and this
//!   crate does not even use them, because it dispatches nothing.
//! - The `.ks` scripts this path concerns are **plaintext** (already extracted
//!   from a plain XP3 by the Kaifuu owner of the bytes); this port neither
//!   parses the XP3 container nor touches a key.
//! - The from-scratch posture is carried as reachable data
//!   ([`CLEAN_ROOM_ATTESTATION`], [`CleanRoomAttestation::emit`]) so audit
//!   tooling can pin it without scraping this docstring.
//!
//! # Substrate-facade containment
//!
//! Every `utsushi_core::*` symbol this crate consumes is sourced through the
//! public facade (`utsushi_core::substrate::*` for the runtime port surface;
//! `utsushi_core::port::impl_map::*` for the engine-neutral conformance-
//! manifest schema). This scaffold owns an empty [`SinkSet`] and returns a
//! typed [`EnginePortError::Lifecycle`] carrying [`KAG_RUNTIME_MESSAGE`] from
//! every lifecycle method — the honest posture for "the Rust port drives
//! nothing; the native/browser KiriKiri TJS runtime does."

#![forbid(unsafe_code)]
#![deny(missing_debug_implementations)]

pub mod conformance;

use utsushi_core::substrate::{
    CapabilityDeclaration, CapabilityStance, CaptureOutcome as SubstrateCaptureOutcome,
    EngineParityProfile, EnginePort, EnginePortError, EvidenceTier, FidelityTier, LifecycleStage,
    PortCapability, PortManifest, PortRequest, PortShutdownOutcome, REQUIRED_LIFECYCLE_STAGES,
    SinkSet,
};

/// Stable port id. Matches the `EngineFamily::KirikiriKag` manifest prefix
/// `"utsushi-kirikiri"` (`impl_map::EngineFamily::manifest_prefix`) —
/// `"utsushi-kirikiri-xp3"` starts with that prefix, so
/// [`utsushi_core::port::impl_map::validate_against_manifest`] accepts the
/// pairing. The `-xp3` suffix records that this port's scope is the KAG
/// plaintext path carried by the XP3 container (see [`conformance`]
/// engine-family notes).
pub const PORT_ID: &str = "utsushi-kirikiri-xp3";

/// Crate semantic version, sourced from Cargo metadata.
const PORT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// The number of opcode handlers this port implements: **zero**, and a
/// compile-time-pinned invariant. The native/browser KiriKiri TJS engine is
/// the KAG runtime; there is no Rust opcode interpreter here. The conformance
/// test asserts this is `0`; a future change that grows a Rust dispatcher
/// would break both the assertion and this crate's clean-room posture.
pub const OPCODE_HANDLER_COUNT: usize = 0;

/// The typed message every lifecycle method returns inside
/// [`EnginePortError::Lifecycle`]. Not an "unimplemented / someday" marker —
/// it states the by-design delegation: the Rust port drives nothing; the
/// native/browser KiriKiri TJS runtime executes the game. Pinned as a public
/// `const` so the conformance test can assert against it without string-
/// matching the human-readable display form.
pub const KAG_RUNTIME_MESSAGE: &str = "utsushi-kirikiri-xp3 drives no runtime in Rust: the native KiriKiri2/KirikiriZ (or a browser \
     reimplementation) TJS engine is the KiriKiri/KAG runtime (zero opcode handlers by design). This \
     port is the substrate-facade conformance + clean-room-attestation surface for the KAG plaintext \
     (.ks) path.";

/// The from-scratch clean-room attestation statement, carried as a publicly
/// reachable `const &str`. Audit tooling (and the conformance test) can pin
/// the load-bearing phrases without scraping the crate-level docstring.
/// Intentionally free of host-local paths.
pub const CLEAN_ROOM_ATTESTATION_STATEMENT: &str = concat!(
    "utsushi-kirikiri-xp3 is a from-scratch clean-room implementation. ",
    "It vendors no KiriKiri/KirikiriZ/TJS engine source, links no engine object code, ",
    "and mechanically translates no decompiled or copyrighted engine code. ",
    "The native KiriKiri (or a browser reimplementation) TJS engine is the KiriKiri/KAG runtime, so this port carries zero opcode handlers. ",
    "The KAG scripts this path concerns are plaintext .ks members already extracted from a plain XP3 by the byte owner; this port never parses the XP3 container and never touches a key. ",
    "No game project bytes and no XP3 container bytes are embedded; KAG tag names are public constructs and are not used here because this port dispatches nothing.",
);

/// A from-scratch clean-room attestation for the KAG plaintext (`.ks`) path.
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
    /// Number of Rust opcode handlers (must be zero — the TJS runtime runs the game).
    pub opcode_handler_count: usize,
    /// The full from-scratch clean-room statement.
    pub statement: &'static str,
}

/// The single canonical clean-room attestation for this port.
pub const CLEAN_ROOM_ATTESTATION: CleanRoomAttestation = CleanRoomAttestation {
    port_id: PORT_ID,
    runtime_path: "kirikiri-kag/tjs (native/browser)",
    opcode_handler_count: OPCODE_HANDLER_COUNT,
    statement: CLEAN_ROOM_ATTESTATION_STATEMENT,
};

impl CleanRoomAttestation {
    /// Emit the attestation as a deterministic, host-path-free text block.
    /// This is the "emitted" clean-room attestation the acceptance calls for:
    /// a caller (or CI) can render and record it without any I/O or serde
    /// dependency.
    pub fn emit(&self) -> String {
        format!(
            "clean-room-attestation\nport-id: {}\nruntime-path: {}\nopcode-handler-count: {}\nstatement: {}",
            self.port_id, self.runtime_path, self.opcode_handler_count, self.statement,
        )
    }
}

/// KiriKiri XP3/KAG native-or-browser engine-port scaffold.
///
/// Owns an empty [`SinkSet`] (no text/frame/audio sink: this port rasterises
/// nothing and traces nothing in Rust — the TJS runtime does). Every lifecycle
/// method returns a typed [`EnginePortError::Lifecycle`] carrying
/// [`KAG_RUNTIME_MESSAGE`].
#[derive(Debug)]
pub struct KirikiriXp3EnginePort {
    sink_set: SinkSet,
}

impl KirikiriXp3EnginePort {
    /// Audit-grade manifest declaration. Mirrors [`EnginePort::MANIFEST`] for
    /// direct introspection without going through the trait.
    ///
    /// Tier ceilings pin trace-only / E1: this port proves the *family +
    /// clean-room* contract for the KAG plaintext path, not on-screen fidelity
    /// (that evidence is produced by the native/browser KiriKiri runtime
    /// adapter, not by this Rust port).
    pub const MANIFEST: PortManifest = PortManifest {
        id: PORT_ID,
        name: "Utsushi KiriKiri XP3/KAG Engine Port (native/browser TJS, zero opcode handlers)",
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
            "The native KiriKiri (or a browser reimplementation) TJS engine is the KiriKiri/KAG runtime: this port carries zero opcode handlers by design and drives no runtime in Rust. Every lifecycle method returns a typed Lifecycle error.",
            "Not an interpreter: KAG tag dispatch (@text, @ruby, [l], [p], *label jumps, TJS [iscript]) happens in the native/browser KiriKiri TJS runtime, never in this crate.",
            "Scope is the substrate-facade conformance manifest + a from-scratch clean-room attestation for the KAG plaintext (.ks) path; runtime evidence is produced by the native/browser KiriKiri runtime adapter, not here.",
            "Clean-room: no KiriKiri/KirikiriZ/TJS engine source is vendored, linked, or mechanically translated; no decompiled/copyrighted engine code, no game bytes, no XP3 container bytes are embedded. This port never parses the XP3 container and never touches a key.",
        ],
    };

    /// Cross-engine capability parity profile (UTSUSHI parity gate). This
    /// delegation scaffold wires the four required lifecycle capabilities and
    /// declares the port-driven `Snapshot` / `DeterministicReplay`
    /// capabilities (wired by `utsushi-reallive`) as dev-`Pending`: they are
    /// driven by the native/browser KiriKiri TJS runtime the delegation
    /// adapter targets, which is not yet wired here. They are NOT
    /// `NotApplicable` — the delegated runtime can snapshot/replay — so the
    /// parity gate keeps them visible as a dev gap, never a permanent hole.
    pub const PARITY_PROFILE: EngineParityProfile = EngineParityProfile {
        manifest: Self::MANIFEST,
        declarations: &[
            CapabilityDeclaration {
                capability: PortCapability::Snapshot,
                stance: CapabilityStance::Pending,
                note: "dev: snapshot/restore is driven by the delegated native/browser KiriKiri runtime, not yet wired through this scaffold.",
            },
            CapabilityDeclaration {
                capability: PortCapability::DeterministicReplay,
                stance: CapabilityStance::Pending,
                note: "dev: deterministic replay is driven by the delegated native/browser KiriKiri runtime, not yet wired through this scaffold.",
            },
            CapabilityDeclaration {
                capability: PortCapability::ReplayReview,
                stance: CapabilityStance::Pending,
                note: "dev: replay-review evidence is driven by the delegated native/browser KiriKiri runtime, not yet wired through this scaffold.",
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

impl Default for KirikiriXp3EnginePort {
    fn default() -> Self {
        Self::new()
    }
}

impl EnginePort for KirikiriXp3EnginePort {
    const MANIFEST: PortManifest = Self::MANIFEST;

    fn launch(&mut self, request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        request.cancellation.check(LifecycleStage::Launch)?;
        Err(kag_runtime_lifecycle(LifecycleStage::Launch))
    }

    fn observe(&mut self, request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        request.cancellation.check(LifecycleStage::Observe)?;
        Err(kag_runtime_lifecycle(LifecycleStage::Observe))
    }

    fn sink_set(&self) -> &SinkSet {
        &self.sink_set
    }

    fn capture(
        &mut self,
        request: &PortRequest<'_>,
    ) -> Result<SubstrateCaptureOutcome, EnginePortError> {
        request.cancellation.check(LifecycleStage::Capture)?;
        Err(kag_runtime_lifecycle(LifecycleStage::Capture))
    }

    fn shutdown(&mut self) -> Result<PortShutdownOutcome, EnginePortError> {
        Err(kag_runtime_lifecycle(LifecycleStage::Shutdown))
    }
}

/// Construct the typed KAG-runtime-delegation error every lifecycle method
/// returns. Centralised so the conformance test has one place to pin the "the
/// native/browser KiriKiri TJS runtime is the runtime" posture.
fn kag_runtime_lifecycle(stage: LifecycleStage) -> EnginePortError {
    EnginePortError::Lifecycle {
        stage,
        message: KAG_RUNTIME_MESSAGE.to_string(),
        source: None,
    }
}

/// Compile-time invariants: zero opcode handlers, and non-empty pinned
/// strings. The runtime mirrors live in `tests/substrate_conformance.rs`.
const _: () = {
    assert!(OPCODE_HANDLER_COUNT == 0);
    assert!(CLEAN_ROOM_ATTESTATION.opcode_handler_count == 0);
    assert!(!KAG_RUNTIME_MESSAGE.is_empty());
    assert!(!CLEAN_ROOM_ATTESTATION_STATEMENT.is_empty());
};
