//! UTSUSHI-147 cross-engine substrate-alignment scaffold — `utsushi-siglus`
//! engine-port crate.
//!
//! This crate is the **second non-synthetic engine-port scaffold** in the
//! Utsushi workspace. Its sole load-bearing role at the alpha gate is to
//! prove the UTSUSHI-120 substrate facade is engine-extensible *beyond*
//! the [`utsushi-reallive`](../utsushi_reallive/index.html) port: every
//! `utsushi_core::*` symbol this crate consumes is sourced through
//! `utsushi_core::substrate::*` (plus the same crate-root reach-around
//! that `utsushi-reallive` carries for `CaptureOutcome`), and the
//! `EnginePort` lifecycle surface matches the RealLive scaffold byte-for-byte
//! at the manifest level.
//!
//! Like the RealLive scaffold, this crate is intentionally a **scaffold
//! only**: every lifecycle method returns a typed
//! [`EnginePortError::Lifecycle`] with the message
//! [`UNIMPLEMENTED_MESSAGE`] and the matching [`LifecycleStage`]. No
//! opcode handlers, no archive parsers, no VFS reads. The alpha tier
//! targets a single engine family (RealLive against Sweetie HD); the
//! Siglus VM is research-only at this point. When (and only when) a
//! real Siglus port lands, it reproduces this scaffold's substrate
//! contract verbatim and then grows the behavioural surface.
//!
//! # Clean-room provenance
//!
//! - All Siglus format observations any successor node consumes are
//!   re-derived from publicly archived format documentation
//!   (SiglusExtract, GARbro, Visual Arts's own engine-evolution notes)
//!   and re-tested against bytes from a real Siglus title before being
//!   encoded. No source expression is copied from any of those projects.
//! - `xmoezzz/siglus_rs` (`https://github.com/xmoezzz/siglus_rs`) is a
//!   **research anchor only**, licensed **MPL-2.0**. This crate does NOT
//!   depend on `siglus_rs`, does NOT include `siglus_rs` headers, does
//!   NOT copy `siglus_rs`'s structure layouts, and does NOT mechanically
//!   translate `siglus_rs` code into Rust. If a hypothesis about
//!   Siglus's format was confirmed by reading `siglus_rs`, the
//!   hypothesis is re-derived and re-tested against a real Siglus
//!   title's bytes before being encoded here.
//! - `bluecookies/siglus-decompile`
//!   (`https://github.com/bluecookies/siglus-decompile`) is the clearest
//!   Siglus bytecode reference but states **no license** → treated as
//!   **all-rights-reserved, documentation-only**. `SiglusExtract`
//!   (xmoezzz) is **GPLv3**. None of these is vendored, linked, or
//!   mechanically translated.
//! - rlvm and xclannad are explicitly out of scope for this crate. The
//!   Siglus port targets Siglus — sibling engines get sibling port
//!   crates so cross-engine bleed is impossible at the crate-graph
//!   level. (The cross-engine *substrate-alignment* fixture is the only
//!   place both ports are co-loaded, and only through the facade.)
//! - No `Command::new`, no Wine, no Windows helper, no remote helper.
//!   When the lifecycle methods grow real bodies they will consume the
//!   substrate's [`utsushi_core::substrate::AssetPackage`] surface — not
//!   the host filesystem — and emit through the substrate's
//!   [`utsushi_core::substrate::SinkSet`] sinks.
//!
//! # Substrate-facade containment
//!
//! Every `utsushi_core::*` import in this crate is sourced through
//! `utsushi_core::substrate::*`. The single non-facade reach-around is
//! `utsushi_core::CaptureOutcome` (renamed [`SubstrateCaptureOutcome`]
//! to make the audit site grep-pinnable). That symbol is named by the
//! `EnginePort::capture` return type and is currently only reachable at
//! the crate root; the same omission is carried by the RealLive
//! scaffold, and the cross-engine substrate-alignment fixture asserts
//! the omission is symmetric across both engines (so a future facade
//! revision that lifts `CaptureOutcome` into `utsushi_core::substrate`
//! drops the reach-around from both engines together — never just one).
//!
//! # Surface
//!
//! - [`UtsushiSiglusPort`] — the
//!   [`utsushi_core::substrate::EnginePort`] implementor.
//! - [`UtsushiSiglusPortContext`] — the carrier struct future
//!   implementation work will use to thread an asset package and a
//!   scene index into the lifecycle methods. Carries `Option<...>`
//!   slots today.
//! - [`UNIMPLEMENTED_MESSAGE`] — the typed string every lifecycle
//!   method currently returns inside [`EnginePortError::Lifecycle`].
//!   Pinned as a public `const` so the scaffold conformance test can
//!   assert against it without string-matching the human-readable
//!   display form.
//! - [`SIGLUS_RS_RESEARCH_ANCHOR_BOUNDARY_STATEMENT`] — the clean-room
//!   boundary statement carried as a public `const &str` so audit
//!   tooling (and the cross-engine substrate-alignment fixture) can
//!   pin the no-vendoring, no-derivation posture without parsing the
//!   crate-level docstring.

#![forbid(unsafe_code)]
#![deny(missing_debug_implementations)]

pub mod opcode_profile;
pub mod runtime_profile;
pub mod vm;
pub mod vm_impl_map;

use std::sync::Arc;

use utsushi_core::substrate::{
    AssetPackage, EnginePort, EnginePortError, EvidenceTier, FidelityTier, LifecycleStage,
    PortCapability, PortManifest, PortRequest, PortShutdownOutcome, REQUIRED_LIFECYCLE_STAGES,
    SinkSet,
};
// `CaptureOutcome` is the typed return value of `EnginePort::capture` and
// is therefore load-bearing for any implementor. It is currently reachable
// only via the crate root (`utsushi_core::CaptureOutcome`) — the substrate
// facade in `crates/utsushi-core/src/substrate.rs` does not yet re-export
// it. This is the **single** non-facade `utsushi_core::*` import in this
// crate; it is forced by the `EnginePort::capture` signature, not chosen.
// The same reach-around lives in `utsushi-reallive::lib`. The cross-engine
// substrate-alignment fixture pins the reach-around as symmetric across
// both engines so a future facade revision that lifts `CaptureOutcome`
// into `utsushi_core::substrate` drops it from both ports together.
use utsushi_core::CaptureOutcome as SubstrateCaptureOutcome;

/// Stable port id used by the manifest and by audit tooling. Matches the
/// `EngineFamily::Siglus` -> `"utsushi-siglus"` mapping in
/// [`utsushi_core::port::impl_map::EngineFamily`].
const PORT_ID: &str = "utsushi-siglus";

/// Crate semantic version, sourced from Cargo metadata.
const PORT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Typed message every lifecycle method on the scaffold returns inside
/// [`EnginePortError::Lifecycle`]. The substrate's typed-error enum has
/// no dedicated `Unimplemented` variant, so the scaffold uses the
/// `Lifecycle { stage, message }` shape with this constant message.
///
/// When a successor node replaces a lifecycle body with real behaviour,
/// it MUST stop returning this value — the orchestration-level audit
/// looks for this exact string as a "still a scaffold" marker.
pub const UNIMPLEMENTED_MESSAGE: &str = "unimplemented: utsushi-siglus scaffold";

/// The clean-room boundary statement carried as a publicly reachable
/// `const &str`. Audit tooling and the cross-engine substrate-alignment
/// fixture can pin this without scraping the crate-level docstring.
///
/// The statement is intentionally short and free of host-local paths so
/// it passes the substrate's
/// [`utsushi_core::substrate::reject_unredacted_local_paths`] filter
/// verbatim.
///
/// Correctness note: an earlier repo statement mis-attributed the
/// project to the wrong repository owner under an incorrect license. The
/// accurate provenance, enforced here and by the siglus-25 audit-fix
/// node, is `xmoezzz/siglus_rs` under MPL-2.0.
pub const SIGLUS_RS_RESEARCH_ANCHOR_BOUNDARY_STATEMENT: &str = concat!(
    "xmoezzz/siglus_rs (https://github.com/xmoezzz/siglus_rs, MPL-2.0) is a research anchor only. ",
    "bluecookies/siglus-decompile (https://github.com/bluecookies/siglus-decompile) is the clearest ",
    "Siglus bytecode reference but states no license, so it is treated as all-rights-reserved and ",
    "documentation-only. SiglusExtract (xmoezzz) is GPLv3. utsushi-siglus does not depend on siglus_rs, ",
    "does not include siglus_rs headers, does not copy siglus_rs's structure layouts, and does not ",
    "mechanically translate any of these projects' code into Rust. Format hypotheses are re-derived and ",
    "re-tested against publicly-archived Siglus format documentation and a real Siglus title's bytes before being encoded.",
);

/// Inert context the scaffold owns. The post-alpha nodes will populate
/// the `asset_package` slot from the runner's
/// [`PortRequest::vfs`] (resolved to a typed [`AssetPackage`]).
///
/// The carrier is intentionally a struct (not a tuple) so the audit
/// surface is named: every field has a docstring, every field's type is
/// reachable from the substrate facade. No runtime configuration knobs
/// are introduced here.
#[derive(Clone, Default)]
pub struct UtsushiSiglusPortContext {
    /// Asset package the eventual implementation will read `Scene.pck`,
    /// `Resource.txt`, and per-namespace `Gameexe.dat` entries from.
    /// Wrapped in `Option<Arc<dyn AssetPackage>>` so the scaffold can be
    /// constructed without any I/O wiring; once real behaviour lands the
    /// `Option` is removed.
    asset_package: Option<Arc<dyn AssetPackage>>,
}

impl UtsushiSiglusPortContext {
    /// Build an inert context. The scaffold uses this; successor nodes
    /// will introduce typed builder methods that require the asset
    /// package to be present.
    pub fn empty() -> Self {
        Self::default()
    }

    /// Optional accessor exposed so audit tooling can inspect whether a
    /// context has been hydrated. Returns `None` while the scaffold is
    /// inert.
    pub fn asset_package(&self) -> Option<&Arc<dyn AssetPackage>> {
        self.asset_package.as_ref()
    }
}

impl std::fmt::Debug for UtsushiSiglusPortContext {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("UtsushiSiglusPortContext")
            .field(
                "asset_package",
                &self
                    .asset_package
                    .as_ref()
                    .map_or("<absent>", |_| "<present>"),
            )
            .finish()
    }
}

/// Engine port scaffold for the Siglus runtime. Implements
/// [`utsushi_core::substrate::EnginePort`] with a typed
/// [`EnginePortError::Lifecycle`] return on every lifecycle method.
///
/// The struct owns an empty [`SinkSet`] (no text/frame/audio sinks
/// registered) and an inert [`UtsushiSiglusPortContext`]. Both are
/// intentionally minimal — the scaffold's purpose is structural, not
/// behavioural.
#[derive(Debug)]
pub struct UtsushiSiglusPort {
    context: UtsushiSiglusPortContext,
    sink_set: SinkSet,
}

impl UtsushiSiglusPort {
    /// Audit-grade manifest declaration. Mirrors
    /// [`EnginePort::MANIFEST`] for direct introspection without going
    /// through the trait.
    pub const MANIFEST: PortManifest = PortManifest {
        id: PORT_ID,
        name: "Utsushi Siglus Engine Port (scaffold)",
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
            "UTSUSHI-147 cross-engine substrate-alignment scaffold only: every lifecycle method returns a typed Lifecycle error.",
            "siglus_rs is referenced as a research anchor only; no siglus_rs source is vendored, linked, or mechanically translated.",
            "Real Siglus VM behaviour is out of alpha scope; this scaffold pins the substrate-facade contract a future behavioural Siglus port must reproduce.",
        ],
    };

    /// Construct the scaffold with an inert context and an empty sink
    /// set.
    pub fn new() -> Self {
        Self {
            context: UtsushiSiglusPortContext::empty(),
            sink_set: SinkSet::new(),
        }
    }

    /// Borrow the (inert) context. Exposed so the conformance test can
    /// assert the asset-package accessor returns `None` without going
    /// through the lifecycle.
    pub fn context(&self) -> &UtsushiSiglusPortContext {
        &self.context
    }
}

impl Default for UtsushiSiglusPort {
    fn default() -> Self {
        Self::new()
    }
}

impl EnginePort for UtsushiSiglusPort {
    const MANIFEST: PortManifest = Self::MANIFEST;

    fn launch(&mut self, request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        request.cancellation.check(LifecycleStage::Launch)?;
        Err(unimplemented_lifecycle(LifecycleStage::Launch))
    }

    fn observe(&mut self, request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        request.cancellation.check(LifecycleStage::Observe)?;
        Err(unimplemented_lifecycle(LifecycleStage::Observe))
    }

    fn sink_set(&self) -> &SinkSet {
        &self.sink_set
    }

    fn capture(
        &mut self,
        request: &PortRequest<'_>,
    ) -> Result<SubstrateCaptureOutcome, EnginePortError> {
        request.cancellation.check(LifecycleStage::Capture)?;
        Err(unimplemented_lifecycle(LifecycleStage::Capture))
    }

    fn shutdown(&mut self) -> Result<PortShutdownOutcome, EnginePortError> {
        Err(unimplemented_lifecycle(LifecycleStage::Shutdown))
    }
}

/// Construct the typed scaffold-marker error every lifecycle method
/// returns. Centralised so the conformance test (and the eventual
/// successor nodes) have one place to look when checking whether a
/// stage is "still a scaffold".
fn unimplemented_lifecycle(stage: LifecycleStage) -> EnginePortError {
    EnginePortError::Lifecycle {
        stage,
        message: UNIMPLEMENTED_MESSAGE.to_string(),
        source: None,
    }
}

/// Compile-time assertion that the boundary statement is non-empty.
/// The runtime mirror lives in `tests/scaffold.rs`.
const _: () = {
    assert!(!SIGLUS_RS_RESEARCH_ANCHOR_BOUNDARY_STATEMENT.is_empty());
    assert!(!UNIMPLEMENTED_MESSAGE.is_empty());
};
