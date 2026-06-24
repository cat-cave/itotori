//! UTSUSHI-200 alpha gate 2 — `utsushi-reallive` engine-port crate scaffold.
//!
//! This crate is the **non-synthetic engine-port scaffold** that
//! demonstrates the UTSUSHI-120 substrate facade is engine-extensible
//! beyond the synthetic [`utsushi-fixture`](../utsushi_fixture/index.html)
//! port. It is intentionally a **scaffold only**: every lifecycle method
//! returns a typed [`EnginePortError::Lifecycle`] with the message
//! [`UNIMPLEMENTED_MESSAGE`] and the matching [`LifecycleStage`]. No
//! opcode handlers, no archive parsers, no VFS reads. The behavioural
//! work lands continuously after alpha (UTSUSHI-201..UTSUSHI-221).
//!
//! # Clean-room provenance
//!
//! - All RealLive format observations consumed by this crate's eventual
//!   implementation are derived from publicly archived format
//!   documentation (Haeleth's RLDEV site,
//!   `https://dev.haeleth.net/rldev.shtml`) plus the Sweetie HD bytes
//!   audited under `docs/audits/real-bytes-validation-2026-06-24.md`. No
//!   source expression is copied from RLDEV or rlvm.
//! - rlvm (`https://github.com/eglaysher/rlvm`) is a **research anchor
//!   only**. Its license is GPLv3+ and is incompatible with itotori's
//!   distribution posture if linked or derived. This crate does NOT
//!   depend on rlvm, does NOT include rlvm headers, does NOT copy rlvm's
//!   structure layouts, and does NOT mechanically translate rlvm code
//!   into Rust. If a hypothesis about RealLive's format was confirmed by
//!   reading rlvm, the hypothesis is re-derived and re-tested against
//!   Sweetie HD bytes before being encoded here.
//! - siglus_rs and xclannad are explicitly out of scope for this crate.
//!   The RealLive port targets RealLive — sibling engines get sibling
//!   port crates so cross-engine bleed is impossible at the crate-graph
//!   level.
//! - No `Command::new`, no Wine, no Windows helper, no remote helper.
//!   When the lifecycle methods grow real bodies they will consume the
//!   substrate's [`utsushi_core::substrate::AssetPackage`] surface — not
//!   the host filesystem — and emit through the substrate's
//!   [`utsushi_core::substrate::SinkSet`] sinks.
//!
//! # Substrate-facade containment
//!
//! Every `utsushi_core::*` import in this crate is sourced through
//! `utsushi_core::substrate::*`. Reaching past the facade (e.g. through
//! the legacy `utsushi_core::vfs::*` direct path, the still-public
//! `utsushi_core::port::*` re-exports, or any `__internal` / `sealed`
//! path) is rejected at audit time. The `tests/substrate_conformance.rs`
//! integration test pins this rule at the build level.
//!
//! # Surface
//!
//! - [`UtsushiReallivePort`] — the [`utsushi_core::substrate::EnginePort`]
//!   implementor. Holds an inert [`UtsushiReallivePortContext`] that the
//!   continuous-tier follow-up nodes will populate with an asset package
//!   and a scene index.
//! - [`UtsushiReallivePortContext`] — the carrier struct the eventual
//!   implementation will use to thread the asset package and the
//!   `kaifuu-reallive` scene index into the lifecycle methods. Carries
//!   `Option<...>` slots today; the post-alpha nodes will replace the
//!   `Option` with required fields once the inventory cross-reference is
//!   plumbed.
//! - [`UNIMPLEMENTED_MESSAGE`] — the typed string every lifecycle method
//!   currently returns inside [`EnginePortError::Lifecycle`]. Pinned as a
//!   public `const` so the scaffold conformance test can assert against
//!   it without string-matching the human-readable display form.
//! - [`RLVM_RESEARCH_ANCHOR_BOUNDARY_STATEMENT`] — the boundary statement
//!   carried as a public `const &str` so audit tooling (and the scaffold
//!   conformance test) can pin the no-vendoring, no-derivation posture
//!   without parsing the crate-level docstring.

#![forbid(unsafe_code)]
#![deny(missing_debug_implementations)]

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
// The audit grep that asserts no sealed / internal substrate paths are
// imported still returns zero hits — `CaptureOutcome` is a public root
// type, not an internal one. Tracked as a known facade omission that a
// follow-up
// substrate slice should fix; until then we use the root path with a
// narrow rename so the import site is grep-pinnable.
use utsushi_core::CaptureOutcome as SubstrateCaptureOutcome;

use kaifuu_reallive::{RealLiveSceneIndex, SceneEntry};

// Re-export the `kaifuu-reallive` cross-reference types so the integration
// tests (and any downstream UTSUSHI-201..UTSUSHI-221 successor) can pin
// the type identity directly off `utsushi_reallive::` without re-importing
// `kaifuu-reallive` themselves. The re-export is intentionally narrow —
// only the two cross-reference types named in the UTSUSHI-200 spec.
pub use kaifuu_reallive::{
    RealLiveSceneIndex as ReExportedSceneIndex, SceneEntry as ReExportedSceneEntry,
};

/// Stable port id used by the manifest and by audit tooling.
const PORT_ID: &str = "utsushi-reallive";

/// Crate semantic version, sourced from Cargo metadata.
const PORT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Typed message every lifecycle method on the scaffold returns inside
/// [`EnginePortError::Lifecycle`]. The substrate's typed-error enum has
/// no dedicated `Unimplemented` variant, so the scaffold uses the
/// `Lifecycle { stage, message }` shape with this constant message. The
/// scaffold conformance test asserts on the constant value, not on the
/// rendered `Display` string.
///
/// When a successor node (UTSUSHI-201..UTSUSHI-221) replaces a lifecycle
/// body with real behaviour, it MUST stop returning this value — the
/// orchestration-level audit looks for this exact string as a "still a
/// scaffold" marker.
pub const UNIMPLEMENTED_MESSAGE: &str = "unimplemented: utsushi-reallive scaffold";

/// The clean-room boundary statement carried as a publicly reachable
/// `const &str`. Audit tooling and the scaffold conformance test can pin
/// this without scraping the crate-level docstring.
///
/// The statement is intentionally short and free of host-local paths so
/// it passes the substrate's
/// [`utsushi_core::substrate::reject_unredacted_local_paths`] filter
/// verbatim.
pub const RLVM_RESEARCH_ANCHOR_BOUNDARY_STATEMENT: &str = concat!(
    "rlvm (https://github.com/eglaysher/rlvm) is a research anchor only. ",
    "utsushi-reallive does not depend on rlvm, does not include rlvm headers, ",
    "does not copy rlvm's structure layouts, and does not mechanically translate ",
    "rlvm code into Rust. Format hypotheses are re-derived and re-tested against ",
    "publicly-archived RLDEV documentation and Sweetie HD bytes before being encoded.",
);

/// Inert context the scaffold owns. The post-alpha nodes will populate
/// the `asset_package` and `scene_index` slots from the runner's
/// [`PortRequest::vfs`] (resolved to a typed [`AssetPackage`]) and from
/// a `kaifuu-reallive` archive parse, respectively.
///
/// The carrier is intentionally a struct (not a tuple) so the audit
/// surface is named: every field has a docstring, every field's type is
/// reachable from the substrate facade plus `kaifuu-reallive`. No
/// runtime configuration knobs are introduced here — the only legitimate
/// way to feed this struct is by replacing the construction call in a
/// successor node.
#[derive(Clone, Default)]
pub struct UtsushiReallivePortContext {
    /// Asset package the eventual implementation will read SEEN.TXT,
    /// Gameexe.ini, and bgm/wav/koe entries from. Wrapped in
    /// `Option<Arc<dyn AssetPackage>>` so the scaffold can be constructed
    /// without any I/O wiring; once UTSUSHI-201+ lands real behaviour,
    /// the `Option` is removed.
    asset_package: Option<Arc<dyn AssetPackage>>,
    /// The `kaifuu-reallive` scene index the eventual implementation will
    /// consume as the inventory cross-reference for bridge-unit
    /// derivation. Held as `Option<Arc<...>>` for the same reason as
    /// `asset_package`.
    scene_index: Option<Arc<RealLiveSceneIndex>>,
}

impl UtsushiReallivePortContext {
    /// Build an inert context. The scaffold uses this; successor nodes
    /// will introduce typed builder methods that require the asset
    /// package + scene index to be present.
    pub fn empty() -> Self {
        Self::default()
    }

    /// Optional accessor exposed so audit tooling can inspect whether a
    /// context has been hydrated. Returns `None` while the scaffold is
    /// inert.
    pub fn asset_package(&self) -> Option<&Arc<dyn AssetPackage>> {
        self.asset_package.as_ref()
    }

    /// Optional accessor for the cross-reference [`RealLiveSceneIndex`].
    /// Returns `None` while the scaffold is inert.
    pub fn scene_index(&self) -> Option<&Arc<RealLiveSceneIndex>> {
        self.scene_index.as_ref()
    }

    /// Number of [`SceneEntry`] rows the cross-reference scene index
    /// carries, if any. Exposed so the scaffold conformance test can
    /// pin "the scaffold's inert context reports zero cross-reference
    /// entries" without poking at the `Option` directly.
    pub fn cross_reference_entry_count(&self) -> usize {
        self.scene_index
            .as_ref()
            .map(|index| index.entries.len())
            .unwrap_or(0)
    }
}

impl std::fmt::Debug for UtsushiReallivePortContext {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("UtsushiReallivePortContext")
            .field(
                "asset_package",
                &self
                    .asset_package
                    .as_ref()
                    .map(|_| "<present>")
                    .unwrap_or("<absent>"),
            )
            .field("scene_index_entries", &self.cross_reference_entry_count())
            .finish()
    }
}

/// Engine port scaffold for the RealLive runtime. Implements
/// [`utsushi_core::substrate::EnginePort`] with a typed
/// [`EnginePortError::Lifecycle`] return on every lifecycle method.
///
/// The struct owns an empty [`SinkSet`] (no text/frame/audio sinks
/// registered) and an inert [`UtsushiReallivePortContext`]. Both are
/// intentionally minimal — the scaffold's purpose is structural, not
/// behavioural.
#[derive(Debug)]
pub struct UtsushiReallivePort {
    context: UtsushiReallivePortContext,
    sink_set: SinkSet,
}

impl UtsushiReallivePort {
    /// Audit-grade manifest declaration. Mirrors
    /// [`EnginePort::MANIFEST`] for direct introspection without going
    /// through the trait.
    pub const MANIFEST: PortManifest = PortManifest {
        id: PORT_ID,
        name: "Utsushi RealLive Engine Port (scaffold)",
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
            "UTSUSHI-200 scaffold only: every lifecycle method returns a typed Lifecycle error.",
            "rlvm is referenced as a research anchor only; no rlvm source is vendored, linked, or mechanically translated.",
            "Real Seen.txt / scene-header / decompressor / VM behaviour lands in UTSUSHI-201..UTSUSHI-221 (continuous tier).",
        ],
    };

    /// Construct the scaffold with an inert context and an empty sink
    /// set. The successor nodes will replace this with typed
    /// constructors that demand a hydrated [`UtsushiReallivePortContext`].
    pub fn new() -> Self {
        Self {
            context: UtsushiReallivePortContext::empty(),
            sink_set: SinkSet::new(),
        }
    }

    /// Borrow the (inert) context. Exposed so the conformance test can
    /// assert the cross-reference accessor returns zero without going
    /// through the lifecycle.
    pub fn context(&self) -> &UtsushiReallivePortContext {
        &self.context
    }
}

impl Default for UtsushiReallivePort {
    fn default() -> Self {
        Self::new()
    }
}

impl EnginePort for UtsushiReallivePort {
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
    assert!(!RLVM_RESEARCH_ANCHOR_BOUNDARY_STATEMENT.is_empty());
    assert!(!UNIMPLEMENTED_MESSAGE.is_empty());
};

// Reference re-exports so the originals are not flagged as unused while
// the scaffold lifecycle bodies are inert.
#[doc(hidden)]
pub fn __doctest_kaifuu_scene_entry_kind() -> std::marker::PhantomData<SceneEntry> {
    std::marker::PhantomData
}
