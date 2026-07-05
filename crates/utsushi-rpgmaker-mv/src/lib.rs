//! `utsushi-rpgmaker-mv` — the RPG Maker MV/MZ runtime port crate.
//!
//! This crate is the **second real (non-scaffold) engine-port** in the
//! Utsushi workspace and the runtime half of the MV/MZ loop: the impl-map
//! already names it (`EngineFamily::RpgmakerMv -> "utsushi-rpgmaker-mv"`,
//! `utsushi_core::port::impl_map`'s validator), and the positive impl-map
//! fixture declares `cargo test -p utsushi-rpgmaker-mv`. ALPHA-001's
//! runtime evidence / feedback / rerun loop for MV/MZ runs against this
//! port.
//!
//! Unlike the `utsushi-reallive` and `utsushi-siglus` scaffolds (every
//! lifecycle method returns a typed `Lifecycle` "unimplemented" error),
//! this port's lifecycle methods do real work — see [`UtsushiRpgmakerMvPort`].
//!
//! # What is real vs deferred
//!
//! **Real (exercised) runtime surfaces:**
//! - `launch` resolves the project's data directory (MV `www/data/`, MZ
//!   `data/`) and parses the real MV/MZ event-command lists
//!   (`events[].pages[].list[]`, `CommonEvents[].list[]`).
//! - `observe` emits the runtime text stream — `Show Text` (101 setup +
//!   401 lines, with the MZ speaker name), `Show Scrolling Text` (405),
//!   and `Show Choices` (102) — one `TextLine` per tick, in deterministic
//!   dispatch order, into the text sink at evidence tier E1.
//! - `capture` materialises a deterministic trace-log artifact under the
//!   runner-provided managed artifact root.
//! - `shutdown` is idempotent (`Clean` then `AlreadyShutDown`).
//! - [`utsushi_core::substrate::Inspectable`] exposes the playback cursor
//!   and loaded inventory into the snapshot substrate.
//!
//! **Deferred (honestly not yet exercised):**
//! - No live JS interpretation on the *port's* `observe` path: that walk is a
//!   static event-stream pass, so conditional branches are not evaluated, all
//!   choice options are surfaced in declaration order, and variable/switch
//!   state is not threaded. Pins the `observe` path at trace-only / E1.
//!   (The [`replay`] module is a separate narrow skeleton that *does* thread
//!   deterministic switch/variable state across a declared command subset and
//!   surfaces out-of-subset commands as typed diagnostics; it is not yet wired
//!   into the `observe` lifecycle.)
//! - No frame rasterisation (JS DOM/canvas) and no audio: both sinks are
//!   declared `Unsupported`. Screenshot/frame capture is a future node.
//! - Script (355/655) / Plugin (356/357) command text is not extracted.
//! - Inspect-only: [`Inspectable`] is implemented, `Restorable` is not.
//!
//! # Clean-room provenance
//!
//! - The MV/MZ event-command-code numbers (`101`, `401`, `405`, `102`,
//!   `105`) are public RPG Maker MV/MZ engine constants documented across
//!   the community wikis. No game-specific bytes inform the parser.
//! - This crate intentionally does **not** depend on `kaifuu-rpgmaker`.
//!   The runtime port owns its own event-data parser even though the
//!   format it recognises is identical, so a regression in one project
//!   cannot poison the other — the same architectural rule
//!   `utsushi-reallive` carries against `kaifuu-reallive`.
//! - No `Command::new`, no NW.js, no browser, no remote helper: the port
//!   reads the project's data files and walks them in-process.
//!
//! # Substrate-facade containment
//!
//! Every `utsushi_core::*` import is sourced through
//! `utsushi_core::substrate::*`, with three documented reach-arounds the
//! facade does not yet re-export (`CaptureOutcome`, `runtime_artifact_uri`,
//! `RuntimeArtifactKind`) — each forced by the `capture` lifecycle and the
//! managed-artifact-store contract. See `port.rs`.

#![forbid(unsafe_code)]

pub mod event_data;
pub mod port;
pub mod replay;

pub use event_data::{DataDir, DataLayout, EventDataError, MessageLine, PlaybackProgram, TextRole};
pub use port::{RpgmakerMvObservationSinks, RpgmakerMvTextSink, UtsushiRpgmakerMvPort};
pub use replay::{
    DiagnosticReason, DiagnosticSeverity, ReplayDiagnostic, ReplayEvent, ReplayOutcome,
    ReplayState, UnknownPolicy, replay_event_list,
};

// `missing_debug_implementations` is denied crate-wide; the port struct
// holds a `SinkSet` (which is `Debug`) plus parsed program state, so a
// derived `Debug` would require `SinkSet: Debug`. Provide a hand-rolled
// `Debug` that surfaces the audit-relevant cursor without leaking sink
// internals or game text.
impl std::fmt::Debug for UtsushiRpgmakerMvPort {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("UtsushiRpgmakerMvPort")
            .field("layout", &self.layout())
            .field("lines_total", &self.lines_total())
            .field("lines_emitted", &self.lines_emitted())
            .finish()
    }
}
