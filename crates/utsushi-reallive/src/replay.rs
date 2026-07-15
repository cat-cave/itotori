//! Alpha-defining end-to-end Sweetie HD scene-1
//! text-replay smoke.
//!
//! Drives a RealLive `Seen.txt` envelope through the full →
//! decode + dispatch chain, collecting a typed
//! [`ReplayLog`] that records [`ReplayEvent::TextLine`]
//! [`ReplayEvent::Pause`] / [`ReplayEvent::UnknownOpcode`] observations
//! against scene #0001. This is the alpha-gate evidence for the
//! utsushi-reallive vertical: real bytes → real `TextLine` → typed log.
//!
//! # Substrate-honesty posture
//!
//! - **Fail-soft on unknown opcodes.** Unknown commands record an
//!   [`ReplayEvent::UnknownOpcode`] and ADVANCE; the run reaches first
//!   text output before any unknown stops it. A `ReplayOutcome` of
//!   `FatalDiagnostic` is reserved for an unrecoverable VM error (e.g.
//!   a bytecode-decode failure or a scene-index miss), not for an
//!   unknown opcode.
//! - **Byte-deterministic JSON.** [`ReplayLog::to_deterministic_json`]
//!   serialises with sorted keys, no floats, byte arrays as
//!   lowercase-hex strings. Two invocations of [`replay_scene`] on the
//!   same Seen.txt produce identical JSON.
//! - **Snapshot/restore at any tick boundary.** The
//!   [`replay_until_first_pause`] helper drives until the first Pause
//!   event (or end of scene), then takes a substrate
//!   [`utsushi_core::substrate::Snapshot`] of the VM through the
//!   `Inspectable` impl in `crate::vm`. The snapshot round-trips
//!   identically into a fresh VM (acceptance criterion #2).
//! - **No silent fallbacks.** Every error path is typed
//!   [`ReplayError`]. Read failures, parse failures, decode failures
//!   and decompression failures all surface as named variants.
//! - **No `unwrap()` clusters in production code.** Synthetic tests
//!   still use `expect()` for ergonomics, but the production driver
//!   propagates every failure through `?`.

use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use utsushi_core::substrate::{
    SinkCapability, SinkResult, Snapshot, SnapshotError, SnapshotRequest, TextLine,
    TextSurfaceSink, restore_snapshot, take_snapshot,
};
use utsushi_core::{EvidenceTier, SnapshotEnvelope};

use utsushi_core::clock::LogicalClockTick;

use crate::audio::AudioEventEmitter;
use crate::jump::{JumpError, JumpLanding, JumpTarget};
use crate::rlop::module_audio::{AudioRuntime, register_audio_rlops};
use crate::rlop::module_catalog::register_catalog_rlops;
use crate::rlop::module_ctrl::{
    register_control_flow_branch_following, register_control_flow_linear_walk,
};
use crate::rlop::module_mem::register_mem_rlops;
use crate::rlop::module_msg::{
    MSG_MODULE_ID, MSG_MODULE_TYPE, MsgRuntime, OPCODE_LINE_BREAK, dispatch_textout_at,
    register_text_rlops,
};
use crate::rlop::module_obj::GraphicsRuntime;
use crate::rlop::module_render::register_render_rlops;
use crate::rlop::module_sel::{SelRuntime, register_sel_rlops};
use crate::rlop::module_str::{StrRuntime, register_str_rlops};
use crate::rlop::module_sys::{SysRuntime, register_sys_rlops};
use crate::rlop::{
    AlwaysReadyScheduler, DispatchOutcome, HeadlessChoicePolicy, HeadlessInputScheduler,
    RlopImplementationProvenance, RlopKey, RlopRegistry,
};
use crate::vm::{InMemorySceneStore, SceneId, SceneStore, StepOutcome, Vm, VmEvent};

mod branch;
pub use branch::{
    BranchFollowingObservation, BranchReplayReport, BranchTerminus, ControlTransferCounts,
    PortObservation, SceneObservation, ScenePlaySegment, ScenePlaythrough,
};
use branch::{PassObservation, PassTermination, select_port_pass};

/// Stable schema version for [`ReplayLog`]. Pinned so a future bump is
/// detected at restore time by any consumer that deserialises the JSON.
pub const REPLAY_LOG_SCHEMA_VERSION: &str = "utsushi-reallive-replay-log/0.2.0-alpha";

/// Default step budget for [`replay_scene`]. Sized so the Sweetie HD
/// scene-1 walk reaches the first Shift-JIS textout run plus its
/// trailing `msg.pause`, while still terminating deterministically on a
/// pathological synthetic scene.
pub const DEFAULT_REPLAY_STEP_BUDGET: u32 = 10_000;

/// Knobs for [`replay_scene`]. Default-construct for normal usage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplayOpts {
    /// Maximum number of VM `step_many` iterations. Pinned at
    /// [`DEFAULT_REPLAY_STEP_BUDGET`] by default.
    pub step_budget: u32,
    /// Stop after the first Pause event lands. Useful for the
    /// "snapshot at first pause" round-trip test where the caller wants
    /// to capture the VM at a deterministic tick.
    pub stop_at_first_pause: bool,
}

impl Default for ReplayOpts {
    fn default() -> Self {
        Self {
            step_budget: DEFAULT_REPLAY_STEP_BUDGET,
            stop_at_first_pause: false,
        }
    }
}

/// One observation produced during a replay walk. The variants cover
/// the alpha-gate evidence the spec node lists (TextLine, Pause
/// UnknownOpcode, Tick).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReplayEvent {
    /// A typed [`TextLine`] fired through the substrate
    /// [`TextSurfaceSink`]. The body bytes are recorded as raw
    /// Shift-JIS, and the UTF-8 decode is recorded alongside so a
    /// downstream consumer can verify both halves.
    TextLine {
        /// pc the textout run started at (byte offset within the
        /// decompressed scene bytecode).
        byte_offset_in_scene: u32,
        /// Raw Shift-JIS body bytes — verbatim from the
        /// `BytecodeElement::Textout` element.
        body_shift_jis: Vec<u8>,
        /// UTF-8 decode of the body — `String::from_utf8_lossy`
        /// equivalent through `encoding_rs::SHIFT_JIS`. The leading
        /// `【…】` speaker prefix (when resolved) is STRIPPED here so the
        /// body is just the dialogue; `body_shift_jis` retains the
        /// verbatim bytes.
        body_utf8: String,
        /// Resolved speaker display name, when the line opened with a
        /// recognised `【…】` `#NAMAE` name prefix (or a
        /// nameOpen/nameClose bracket). `None` for narration.
        #[serde(skip_serializing_if = "Option::is_none")]
        speaker: Option<String>,
        /// Resolved per-speaker dialogue text colour (RGB) from
        /// `#COLOR_TABLE[#NAMAE.color_table_index]`. `None` when no
        /// speaker was resolved.
        #[serde(skip_serializing_if = "Option::is_none")]
        color: Option<[u8; 3]>,
    },
    /// A `msg.pause` opcode landed and the VM emitted a
    /// [`crate::DispatchOutcome::Yield`]. The pc is recorded so a
    /// snapshot-at-pause caller can correlate the event with the VM
    /// state.
    Pause {
        /// pc immediately following the `msg.pause` command (the byte
        /// the VM advances to after enqueuing the longop).
        byte_offset_in_scene: u32,
    },
    /// A `Command` element targeted a `(module_type, module_id, opcode)`
    /// the registry does not know. The VM advanced past it; this event
    /// names the key so the alpha audit trail records the unknown
    /// opcode density without halting the run.
    UnknownOpcode {
        /// pc where the command sits.
        byte_offset_in_scene: u32,
        /// Module type byte from the Command header.
        module_type: u8,
        /// Module id byte from the Command header.
        module_id: u8,
        /// Opcode (`u16 LE` from the Command header).
        opcode: u16,
    },
    /// A command resolved only through the observed-command catalog gap fill.
    /// The VM advanced, but no semantic implementation claimed the tuple.
    CatalogFallback {
        /// pc where the command sits.
        byte_offset_in_scene: u32,
        /// Module type byte from the Command header.
        module_type: u8,
        /// Module id byte from the Command header.
        module_id: u8,
        /// Opcode (`u16 LE` from the Command header).
        opcode: u16,
    },
    /// Heartbeat marker recorded at every step so the deterministic-JSON
    /// equality check has more than just first-pause evidence to
    /// compare. Records the cumulative `executed` count from
    /// `Vm::step_many`.
    Tick {
        /// Cumulative step count at this tick.
        count: u32,
    },
}

/// Terminal outcome of a [`replay_scene`] run. Named variants only —
/// there is no `Other(String)` fallback.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum ReplayOutcome {
    /// The replay stopped at the first `msg.pause` opcode (per
    /// [`ReplayOpts::stop_at_first_pause`]).
    FirstPauseReached {
        /// Number of recorded events when the pause landed.
        events: u32,
    },
    /// The replay exhausted [`ReplayOpts::step_budget`] without
    /// reaching end-of-scene.
    BudgetExhausted {
        /// Number of recorded events at the budget boundary.
        events: u32,
    },
    /// The VM's pc reached the end of the scene bytecode.
    EndOfScene {
        /// Number of recorded events at end-of-scene.
        events: u32,
    },
    /// A typed VM error halted the run before first text output. The
    /// pc and the typed semantic code are recorded so the alpha audit
    /// trail can pin the site without parsing the human-readable
    /// `Display` form.
    FatalDiagnostic {
        /// Stable semantic code (e.g. `utsushi.reallive.vm.unaligned_pc`).
        code: String,
        /// pc where the failure occurred.
        byte_offset_in_scene: u32,
    },
}

/// Typed log produced by [`replay_scene`]. Serialise via
/// [`ReplayLog::to_deterministic_json`] for the byte-stable JSON
/// surface; serde-default is fine for debugging.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayLog {
    /// Stable schema label. Equals [`REPLAY_LOG_SCHEMA_VERSION`].
    pub schema_version: String,
    /// Scene id the replay was driven against.
    pub scene_id: u16,
    /// Ordered list of observations the walk produced.
    pub events: Vec<ReplayEvent>,
    /// Terminal outcome of the walk.
    pub final_outcome: ReplayOutcome,
}

mod implementation;
pub use implementation::{
    DecompressedScene, ReplayEngine, ReplayError, SceneStoreBundle, SceneStoreStats,
    SnapshotIdentityReport, build_scene_store, build_scene_store_from_decompressed,
    decompress_all_scenes, full_registry_rlop_count, replay_scene, replay_scene_bytes,
    replay_until_first_pause, restore_into_fresh_vm, verify_snapshot_restore_each_tick,
};
