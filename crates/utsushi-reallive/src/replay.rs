//! UTSUSHI-220 — alpha-defining end-to-end Sweetie HD scene-1
//! text-replay smoke.
//!
//! Drives a RealLive `Seen.txt` envelope through the full UTSUSHI-201 →
//! UTSUSHI-210 decode + dispatch chain, collecting a typed
//! [`ReplayLog`] that records [`ReplayEvent::TextLine`] /
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
//!   [`ReplayError`]. Read failures, parse failures, decode failures,
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

use crate::audio::{AudioEvent as RealliveAudioEvent, AudioEventEmitter};
use crate::bytecode_element::{BytecodeElement, TextoutEncoding, decode_bytecode_stream};
use crate::decompressor::AvgDecompressor;
use crate::graphics_objects::GraphicsObjectStack;
use crate::jump::{JumpError, JumpLanding, JumpTarget};
use crate::rlop::module_audio::{AudioRuntime, register_audio_rlops};
use crate::rlop::module_catalog::register_catalog_rlops;
use crate::rlop::module_ctrl::{
    register_control_flow_branch_following, register_control_flow_linear_walk,
};
use crate::rlop::module_mem::register_mem_rlops;
use crate::rlop::module_msg::{
    MSG_MODULE_ID, MSG_MODULE_TYPE, MsgRuntime, OPCODE_LINE_BREAK, dispatch_textout,
    register_text_rlops,
};
use crate::rlop::module_obj::GraphicsRuntime;
use crate::rlop::module_render::register_render_rlops;
use crate::rlop::module_sel::{SelRuntime, register_sel_rlops};
use crate::rlop::module_str::{StrRuntime, register_str_rlops};
use crate::rlop::module_sys::{SysRuntime, register_sys_rlops};
use crate::rlop::{
    AlwaysReadyScheduler, DispatchOutcome, HeadlessChoicePolicy, HeadlessInputScheduler, RlopKey,
    RlopRegistry,
};
use crate::scene_header::{SCENE_HEADER_BYTE_LEN, SceneHeader};
use crate::scene_index::RealSceneIndex;
use crate::vm::{InMemorySceneStore, Scene, SceneId, SceneStore, StepOutcome, Vm, VmEvent};

/// Stable schema version for [`ReplayLog`]. Pinned so a future bump is
/// detected at restore time by any consumer that deserialises the JSON.
pub const REPLAY_LOG_SCHEMA_VERSION: &str = "utsushi-reallive-replay-log/0.1.0-alpha";

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
/// the alpha-gate evidence the spec node lists (TextLine, Pause,
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

impl ReplayLog {
    /// Serialise to byte-deterministic JSON: sorted keys at every
    /// level, no floats, byte arrays as lowercase-hex strings.
    ///
    /// The serialisation is the canonical surface a downstream consumer
    /// hashes / diffs. Acceptance criterion #1 — two runs against the
    /// same Seen.txt produce identical output here.
    pub fn to_deterministic_json(&self) -> Result<String, ReplayError> {
        let value = self.to_canonical_value();
        // `serde_json::to_string_pretty` writes object keys in
        // insertion order, so the canonical builder below must insert
        // keys in sorted order to guarantee determinism. The pretty
        // formatter pins indentation at 2 spaces, which is stable
        // across serde_json versions.
        let mut out = Vec::with_capacity(1024);
        let formatter = serde_json::ser::PrettyFormatter::with_indent(b"  ");
        let mut ser = serde_json::Serializer::with_formatter(&mut out, formatter);
        value
            .serialize(&mut ser)
            .map_err(|err| ReplayError::SerializeFailure {
                reason: err.to_string(),
            })?;
        String::from_utf8(out).map_err(|err| ReplayError::SerializeFailure {
            reason: format!("non-utf8 in serialised JSON: {err}"),
        })
    }

    /// Number of [`ReplayEvent::TextLine`] events recorded. Acceptance
    /// criterion #0 — the real-bytes Sweetie HD scene-1 run produces
    /// `text_line_count() >= 1`.
    pub fn text_line_count(&self) -> usize {
        self.events
            .iter()
            .filter(|event| matches!(event, ReplayEvent::TextLine { .. }))
            .count()
    }

    /// Number of [`ReplayEvent::UnknownOpcode`] events. Used by the
    /// real-bytes test to report the fail-soft warning density.
    pub fn unknown_opcode_count(&self) -> usize {
        self.events
            .iter()
            .filter(|event| matches!(event, ReplayEvent::UnknownOpcode { .. }))
            .count()
    }

    /// Sorted, de-duplicated list of every `(module_type, module_id,
    /// opcode)` the replay could not dispatch (each recorded as a
    /// [`ReplayEvent::UnknownOpcode`]). The full-scene acceptance test
    /// asserts this is EMPTY — an unknown opcode is a HARD failure of the
    /// traversal, never a silent fail-soft advance.
    pub fn unknown_opcode_keys(&self) -> Vec<(u8, u8, u16)> {
        let mut keys: Vec<(u8, u8, u16)> = self
            .events
            .iter()
            .filter_map(|event| match event {
                ReplayEvent::UnknownOpcode {
                    module_type,
                    module_id,
                    opcode,
                    ..
                } => Some((*module_type, *module_id, *opcode)),
                _ => None,
            })
            .collect();
        keys.sort_unstable();
        keys.dedup();
        keys
    }

    /// First non-empty Shift-JIS-decoded body, or `None` if no TextLine
    /// produced a non-empty decode. The real-bytes test prints this as
    /// the alpha-defining evidence.
    pub fn first_text_line_utf8(&self) -> Option<&str> {
        for event in &self.events {
            if let ReplayEvent::TextLine { body_utf8, .. } = event
                && !body_utf8.is_empty()
            {
                return Some(body_utf8);
            }
        }
        None
    }

    /// Build a [`serde_json::Value`] with sorted keys and hex byte
    /// arrays. Centralised so the deterministic-JSON path and the
    /// snapshot-round-trip path agree on the canonical shape.
    fn to_canonical_value(&self) -> serde_json::Value {
        let mut events = Vec::with_capacity(self.events.len());
        for event in &self.events {
            events.push(event_to_canonical_value(event));
        }
        let outcome_value = outcome_to_canonical_value(&self.final_outcome);
        let mut map = serde_json::Map::new();
        // Insert in sorted order so the BTreeMap-like layout is
        // preserved by serde_json::Map (which is order-preserving).
        map.insert("events".to_string(), serde_json::Value::Array(events));
        map.insert("finalOutcome".to_string(), outcome_value);
        map.insert(
            "schemaVersion".to_string(),
            serde_json::Value::String(self.schema_version.clone()),
        );
        map.insert(
            "sceneId".to_string(),
            serde_json::Value::Number(self.scene_id.into()),
        );
        serde_json::Value::Object(sort_map_keys(map))
    }
}

fn event_to_canonical_value(event: &ReplayEvent) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    match event {
        ReplayEvent::TextLine {
            byte_offset_in_scene,
            body_shift_jis,
            body_utf8,
            speaker,
            color,
        } => {
            map.insert(
                "bodyShiftJisHex".to_string(),
                serde_json::Value::String(bytes_to_hex(body_shift_jis)),
            );
            map.insert(
                "bodyUtf8".to_string(),
                serde_json::Value::String(body_utf8.clone()),
            );
            map.insert(
                "byteOffsetInScene".to_string(),
                serde_json::Value::Number((*byte_offset_in_scene).into()),
            );
            if let Some(color) = color {
                map.insert(
                    "color".to_string(),
                    serde_json::Value::Array(
                        color
                            .iter()
                            .map(|channel| serde_json::Value::Number((*channel).into()))
                            .collect(),
                    ),
                );
            }
            map.insert(
                "kind".to_string(),
                serde_json::Value::String("text_line".to_string()),
            );
            if let Some(speaker) = speaker {
                map.insert(
                    "speaker".to_string(),
                    serde_json::Value::String(speaker.clone()),
                );
            }
        }
        ReplayEvent::Pause {
            byte_offset_in_scene,
        } => {
            map.insert(
                "byteOffsetInScene".to_string(),
                serde_json::Value::Number((*byte_offset_in_scene).into()),
            );
            map.insert(
                "kind".to_string(),
                serde_json::Value::String("pause".to_string()),
            );
        }
        ReplayEvent::UnknownOpcode {
            byte_offset_in_scene,
            module_type,
            module_id,
            opcode,
        } => {
            map.insert(
                "byteOffsetInScene".to_string(),
                serde_json::Value::Number((*byte_offset_in_scene).into()),
            );
            map.insert(
                "kind".to_string(),
                serde_json::Value::String("unknown_opcode".to_string()),
            );
            map.insert(
                "moduleId".to_string(),
                serde_json::Value::Number((*module_id).into()),
            );
            map.insert(
                "moduleType".to_string(),
                serde_json::Value::Number((*module_type).into()),
            );
            map.insert(
                "opcode".to_string(),
                serde_json::Value::Number((*opcode).into()),
            );
        }
        ReplayEvent::Tick { count } => {
            map.insert(
                "count".to_string(),
                serde_json::Value::Number((*count).into()),
            );
            map.insert(
                "kind".to_string(),
                serde_json::Value::String("tick".to_string()),
            );
        }
    }
    serde_json::Value::Object(sort_map_keys(map))
}

fn outcome_to_canonical_value(outcome: &ReplayOutcome) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    match outcome {
        ReplayOutcome::FirstPauseReached { events } => {
            map.insert(
                "events".to_string(),
                serde_json::Value::Number((*events).into()),
            );
            map.insert(
                "outcome".to_string(),
                serde_json::Value::String("first_pause_reached".to_string()),
            );
        }
        ReplayOutcome::BudgetExhausted { events } => {
            map.insert(
                "events".to_string(),
                serde_json::Value::Number((*events).into()),
            );
            map.insert(
                "outcome".to_string(),
                serde_json::Value::String("budget_exhausted".to_string()),
            );
        }
        ReplayOutcome::EndOfScene { events } => {
            map.insert(
                "events".to_string(),
                serde_json::Value::Number((*events).into()),
            );
            map.insert(
                "outcome".to_string(),
                serde_json::Value::String("end_of_scene".to_string()),
            );
        }
        ReplayOutcome::FatalDiagnostic {
            code,
            byte_offset_in_scene,
        } => {
            map.insert(
                "byteOffsetInScene".to_string(),
                serde_json::Value::Number((*byte_offset_in_scene).into()),
            );
            map.insert("code".to_string(), serde_json::Value::String(code.clone()));
            map.insert(
                "outcome".to_string(),
                serde_json::Value::String("fatal_diagnostic".to_string()),
            );
        }
    }
    serde_json::Value::Object(sort_map_keys(map))
}

fn sort_map_keys(
    map: serde_json::Map<String, serde_json::Value>,
) -> serde_json::Map<String, serde_json::Value> {
    let mut entries: Vec<(String, serde_json::Value)> = map.into_iter().collect();
    entries.sort_by(|(a, _), (b, _)| a.cmp(b));
    let mut out = serde_json::Map::with_capacity(entries.len());
    for (key, value) in entries {
        out.insert(key, value);
    }
    out
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(nibble_to_hex(byte >> 4));
        out.push(nibble_to_hex(byte & 0x0F));
    }
    out
}

fn nibble_to_hex(nibble: u8) -> char {
    match nibble {
        0..=9 => (b'0' + nibble) as char,
        10..=15 => (b'a' + (nibble - 10)) as char,
        _ => '?',
    }
}

/// Typed errors raised by [`replay_scene`] and its helpers.
///
/// Every failure path is a named variant — no `Other(String)`, no
/// `unwrap()`. Acceptance criterion #3 — unknown opcodes do NOT surface
/// here; they become [`ReplayEvent::UnknownOpcode`] entries instead.
#[derive(Debug, thiserror::Error)]
pub enum ReplayError {
    /// `std::fs::read` on the Seen.txt path failed.
    #[error("utsushi.reallive.replay.read_failed: path={path} reason={reason}")]
    ReadFailed {
        /// Display form of the path that failed. Caller controls
        /// whether this is a host-local path; the alpha-gate
        /// redaction filter passes the human-readable form unchanged.
        path: String,
        /// Underlying I/O error message.
        reason: String,
    },
    /// The scene-id was not present in the Seen.txt directory.
    #[error("utsushi.reallive.replay.scene_not_found: scene={scene}")]
    SceneNotFound {
        /// Scene id the caller asked for.
        scene: u16,
    },
    /// The scene-index parse failed.
    #[error("utsushi.reallive.replay.scene_index_parse: {reason}")]
    SceneIndexParse {
        /// Reason string.
        reason: String,
    },
    /// The scene header parse failed.
    #[error("utsushi.reallive.replay.scene_header_parse: scene={scene} reason={reason}")]
    SceneHeaderParse {
        /// Scene id.
        scene: u16,
        /// Reason string.
        reason: String,
    },
    /// AVG32 decompression failed.
    #[error("utsushi.reallive.replay.decompress_failed: scene={scene} reason={reason}")]
    DecompressFailed {
        /// Scene id.
        scene: u16,
        /// Reason string.
        reason: String,
    },
    /// Bytecode element decoding failed.
    #[error("utsushi.reallive.replay.bytecode_decode: scene={scene} reason={reason}")]
    BytecodeDecode {
        /// Scene id.
        scene: u16,
        /// Reason string.
        reason: String,
    },
    /// The scene was empty after decoding (zero elements).
    #[error("utsushi.reallive.replay.empty_scene: scene={scene}")]
    EmptyScene {
        /// Scene id.
        scene: u16,
    },
    /// Slice math overflowed (scene byte offsets / lengths exceed
    /// `usize`). Should never fire on real RealLive archives; surfaced
    /// for completeness so the unwrap-free contract holds.
    #[error("utsushi.reallive.replay.slice_overflow: scene={scene} reason={reason}")]
    SliceOverflow {
        /// Scene id.
        scene: u16,
        /// Reason string.
        reason: String,
    },
    /// Substrate snapshot path failed (used by
    /// [`replay_until_first_pause`]).
    #[error("utsushi.reallive.replay.snapshot_failure: {reason}")]
    SnapshotFailure {
        /// Reason string.
        reason: String,
    },
    /// Deterministic JSON serialisation failed.
    #[error("utsushi.reallive.replay.serialize_failure: {reason}")]
    SerializeFailure {
        /// Reason string.
        reason: String,
    },
}

impl From<SnapshotError> for ReplayError {
    fn from(err: SnapshotError) -> Self {
        Self::SnapshotFailure {
            reason: err.to_string(),
        }
    }
}

/// In-replay TextSurfaceSink that buffers emitted lines under a
/// `Mutex` so the dispatch loop can drain them at every step boundary.
#[derive(Default)]
struct ReplayTextSink {
    lines: Mutex<Vec<TextLine>>,
}

impl TextSurfaceSink for ReplayTextSink {
    fn capability(&self) -> SinkCapability {
        SinkCapability::Supported {
            evidence_tier_ceiling: EvidenceTier::E1,
        }
    }

    fn emit_line(&self, line: TextLine) -> SinkResult<()> {
        line.validate()?;
        self.lines
            .lock()
            .expect("ReplayTextSink mutex poisoned")
            .push(line);
        Ok(())
    }
}

impl ReplayTextSink {
    /// Take (and clear) the buffered lines. Used by the play-order
    /// observation to recover the branch-following text stream.
    fn take_lines(&self) -> Vec<TextLine> {
        std::mem::take(&mut *self.lines.lock().expect("ReplayTextSink mutex poisoned"))
    }
}

impl std::fmt::Debug for ReplayTextSink {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ReplayTextSink")
            .field(
                "buffered_lines",
                &self.lines.lock().map_or(0, |guard| guard.len()),
            )
            .finish()
    }
}

impl ReplayTextSink {
    fn drain(&self) -> Vec<TextLine> {
        let mut guard = self.lines.lock().expect("ReplayTextSink mutex poisoned");
        std::mem::take(&mut *guard)
    }
}

/// The fully-assembled replay context: VM + registry + sinks. Kept as a
/// private struct so the public entry points expose only their typed
/// return shapes.
struct ReplayContext {
    vm: Vm,
    store: InMemorySceneStore,
    registry: RlopRegistry,
    runtime: Arc<MsgRuntime>,
    sink: Arc<ReplayTextSink>,
    /// Byte offsets of every Shift-JIS-tagged textout run, keyed by the
    /// `(scene_id, byte_offset)` pair so a multi-scene traversal drives
    /// `dispatch_textout` only when the VM's *current* scene/pc lands on
    /// a Shift-JIS run.
    shift_jis_textout_offsets: HashSet<(SceneId, u32)>,
}

/// The multi-scene store, its `(scene, offset)` Shift-JIS textout set,
/// and the build diagnostics — the tuple [`build_scene_store`] returns.
pub type SceneStoreBundle = (InMemorySceneStore, HashSet<(SceneId, u32)>, SceneStoreStats);

/// Diagnostic counts produced while building the multi-scene store.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SceneStoreStats {
    /// Populated directory slots observed in the Seen.txt index.
    pub populated: usize,
    /// Scenes that decompressed + decoded into a non-empty element list
    /// and were inserted into the store.
    pub loaded: usize,
    /// Populated scenes that failed to decompress / decode / were empty
    /// and were skipped. A cross-scene Jump/FarCall into a skipped scene
    /// surfaces as a typed `SceneNotFound` at the VM layer, so skips are
    /// never silent.
    pub skipped: usize,
}

/// One decoded scene: its id, decompressed bytecode elements, and the
/// byte offsets of its Shift-JIS-tagged textout runs. Produced by
/// [`decode_one_scene`] and consumed by [`build_scene_store`].
struct DecodedScene {
    scene: Scene,
    shift_jis_offsets: Vec<u32>,
}

/// One decompressed-but-not-yet-decoded scene: its id, plaintext
/// `compiler_version` (decides `use_xor_2`), and its AVG32-decompressed
/// bytecode. This is the seam a real-bytes test uses to interpose the
/// dev-only `kaifuu-reallive` `use_xor_2` segment-cipher recovery between
/// the first-level AVG32 inflate (owned here) and the bytecode decode:
/// the test decompresses the whole archive via [`decompress_all_scenes`],
/// hands the eligible scenes to the recovery, then rebuilds the store via
/// [`build_scene_store_from_decompressed`]. No key material lives in this
/// crate.
#[derive(Debug, Clone)]
pub struct DecompressedScene {
    /// Scene-directory slot id.
    pub scene_id: SceneId,
    /// Plaintext compiler version from the scene header.
    pub compiler_version: u32,
    /// AVG32-decompressed (still `use_xor_2`-ciphered, when eligible)
    /// bytecode bytes.
    pub bytecode: Vec<u8>,
}

/// Decompress a single scene blob: slice its compressed bytecode and run
/// the AVG32 first-level XOR + LZSS inflate. Returns the plaintext
/// compiler version plus the decompressed bytecode. The second-level
/// `use_xor_2` segment cipher (Sweetie HD, compiler `110002`) is NOT
/// applied here — a caller that needs it interposes the dev-only
/// `kaifuu-reallive` recovery on [`DecompressedScene::bytecode`].
fn decompress_one_scene(blob: &[u8], scene_id: SceneId) -> Result<DecompressedScene, ReplayError> {
    if blob.len() < SCENE_HEADER_BYTE_LEN {
        return Err(ReplayError::SceneHeaderParse {
            scene: scene_id,
            reason: format!(
                "scene blob length {} is shorter than {SCENE_HEADER_BYTE_LEN}-byte header",
                blob.len()
            ),
        });
    }
    let (header, _header_warnings) =
        SceneHeader::parse(blob).map_err(|err| ReplayError::SceneHeaderParse {
            scene: scene_id,
            reason: err.to_string(),
        })?;
    let bytecode_offset = header.bytecode_offset as usize;
    let compressed_len = header.bytecode_compressed_size as usize;
    let compressed_end =
        bytecode_offset
            .checked_add(compressed_len)
            .ok_or(ReplayError::SliceOverflow {
                scene: scene_id,
                reason: format!(
                    "bytecode_offset {bytecode_offset} + compressed_len {compressed_len} \
                     overflows usize",
                ),
            })?;
    if compressed_end > blob.len() {
        return Err(ReplayError::SliceOverflow {
            scene: scene_id,
            reason: format!(
                "compressed_end {compressed_end} exceeds blob.len() {}",
                blob.len()
            ),
        });
    }
    let compressed = &blob[bytecode_offset..compressed_end];

    let (decompressed, _decompress_warnings) = AvgDecompressor::new()
        .decompress(
            compressed,
            header.bytecode_uncompressed_size,
            None,
            header.compiler_version,
        )
        .map_err(|err| ReplayError::DecompressFailed {
            scene: scene_id,
            reason: err.to_string(),
        })?;
    Ok(DecompressedScene {
        scene_id,
        compiler_version: header.compiler_version,
        bytecode: decompressed,
    })
}

/// Decode already-decompressed (and, when applicable, `use_xor_2`-
/// decrypted) bytecode into a [`DecodedScene`].
fn decode_decompressed(
    decompressed: &[u8],
    scene_id: SceneId,
) -> Result<DecodedScene, ReplayError> {
    let elements =
        decode_bytecode_stream(decompressed).map_err(|err| ReplayError::BytecodeDecode {
            scene: scene_id,
            reason: err.to_string(),
        })?;
    if elements.is_empty() {
        return Err(ReplayError::EmptyScene { scene: scene_id });
    }

    // Pre-walk: collect the byte offsets of every Shift-JIS-tagged
    // textout run. The dispatch loop drives `dispatch_textout` only when
    // the VM's (scene, pc) lands on a Shift-JIS run.
    let mut shift_jis_offsets: Vec<u32> = Vec::new();
    for element in &elements {
        if let BytecodeElement::Textout {
            encoding_hint,
            byte_offset,
            ..
        } = element
            && matches!(encoding_hint, TextoutEncoding::ShiftJis)
        {
            shift_jis_offsets.push(u32::try_from(*byte_offset).unwrap_or(u32::MAX));
        }
    }

    let scene =
        Scene::new(scene_id, elements).ok_or(ReplayError::EmptyScene { scene: scene_id })?;
    Ok(DecodedScene {
        scene,
        shift_jis_offsets,
    })
}

/// Decompress + decode a single scene blob (no `use_xor_2` recovery).
fn decode_one_scene(blob: &[u8], scene_id: SceneId) -> Result<DecodedScene, ReplayError> {
    let decompressed = decompress_one_scene(blob, scene_id)?;
    decode_decompressed(&decompressed.bytecode, scene_id)
}

/// Decompress EVERY populated scene of a Seen.txt envelope through the
/// AVG32 first-level inflate, returning one [`DecompressedScene`] per
/// scene that decompressed cleanly. Scenes whose blob slice / header /
/// inflate fails are dropped (the same skip policy as
/// [`build_scene_store`]); the returned count vs the index length is the
/// caller's skip diagnostic.
///
/// This is the entry point a real-bytes test uses to stage the dev-only
/// `use_xor_2` recovery: decompress here, decrypt the eligible scenes
/// externally, then rebuild via [`build_scene_store_from_decompressed`].
pub fn decompress_all_scenes(seen_bytes: &[u8]) -> Result<Vec<DecompressedScene>, ReplayError> {
    let index = RealSceneIndex::parse(seen_bytes).map_err(|err| ReplayError::SceneIndexParse {
        reason: err.to_string(),
    })?;
    let mut out = Vec::with_capacity(index.entries.len());
    for entry in &index.entries {
        let scene_id = entry.scene_id;
        if let Ok(decompressed) =
            slice_scene_blob(seen_bytes, scene_id, entry.byte_offset, entry.byte_len)
                .and_then(|blob| decompress_one_scene(blob, scene_id))
        {
            out.push(decompressed);
        }
    }
    Ok(out)
}

/// Build a multi-scene store from a list of already-decompressed (and,
/// when applicable, `use_xor_2`-decrypted) scenes. `populated` should be
/// the Seen.txt index length so [`SceneStoreStats::skipped`] reflects the
/// scenes that did not survive decompress + decode.
pub fn build_scene_store_from_decompressed(
    scenes: &[DecompressedScene],
    populated: usize,
) -> Result<SceneStoreBundle, ReplayError> {
    let mut store = InMemorySceneStore::new();
    let mut shift_jis_textout_offsets: HashSet<(SceneId, u32)> = HashSet::new();
    let mut loaded = 0usize;
    for scene in scenes {
        // A scene that fails to decode is SKIPPED (reflected in
        // `skipped`), never silently masked: a cross-scene reference into
        // it would surface a typed `SceneNotFound` at the VM layer.
        if let Ok(decoded) = decode_decompressed(&scene.bytecode, scene.scene_id) {
            for offset in decoded.shift_jis_offsets {
                shift_jis_textout_offsets.insert((scene.scene_id, offset));
            }
            store.insert(decoded.scene);
            loaded += 1;
        }
    }
    let stats = SceneStoreStats {
        populated,
        loaded,
        skipped: populated.saturating_sub(loaded),
    };
    Ok((store, shift_jis_textout_offsets, stats))
}

/// Locate + slice one populated scene's blob out of the Seen.txt
/// envelope by its directory entry. Returns a typed slice-overflow error
/// if the declared range exceeds the envelope.
fn slice_scene_blob(
    seen_bytes: &[u8],
    scene_id: SceneId,
    byte_offset: u64,
    byte_len: u32,
) -> Result<&[u8], ReplayError> {
    let blob_start = usize::try_from(byte_offset).map_err(|_| ReplayError::SliceOverflow {
        scene: scene_id,
        reason: format!("byte_offset {byte_offset} exceeds usize::MAX"),
    })?;
    let blob_len = byte_len as usize;
    let blob_end = blob_start
        .checked_add(blob_len)
        .ok_or(ReplayError::SliceOverflow {
            scene: scene_id,
            reason: format!("blob_start {blob_start} + byte_len {blob_len} overflows usize"),
        })?;
    if blob_end > seen_bytes.len() {
        return Err(ReplayError::SliceOverflow {
            scene: scene_id,
            reason: format!(
                "blob_end {blob_end} exceeds seen_bytes.len() {}",
                seen_bytes.len()
            ),
        });
    }
    Ok(&seen_bytes[blob_start..blob_end])
}

/// Build a MULTI-scene [`InMemorySceneStore`] from EVERY populated scene
/// in a Seen.txt envelope so cross-scene Jump/FarCall resolves against a
/// real archive. Returns the store, the Shift-JIS textout offset set
/// keyed by `(scene, offset)`, and diagnostic [`SceneStoreStats`].
///
/// A scene that fails to decompress / decode / is empty is SKIPPED (and
/// counted in [`SceneStoreStats::skipped`]) rather than aborting the
/// whole build — an unresolved cross-scene jump into a skipped scene
/// surfaces as a typed `SceneNotFound` at the VM layer, so a genuine gap
/// is never silently masked.
pub fn build_scene_store(seen_bytes: &[u8]) -> Result<SceneStoreBundle, ReplayError> {
    let index = RealSceneIndex::parse(seen_bytes).map_err(|err| ReplayError::SceneIndexParse {
        reason: err.to_string(),
    })?;
    let mut store = InMemorySceneStore::new();
    let mut shift_jis_textout_offsets: HashSet<(SceneId, u32)> = HashSet::new();
    let mut loaded = 0usize;
    let mut skipped = 0usize;
    let populated = index.entries.len();
    for entry in &index.entries {
        let scene_id = entry.scene_id;
        let decoded = slice_scene_blob(seen_bytes, scene_id, entry.byte_offset, entry.byte_len)
            .and_then(|blob| decode_one_scene(blob, scene_id));
        match decoded {
            Ok(decoded) => {
                for offset in decoded.shift_jis_offsets {
                    shift_jis_textout_offsets.insert((scene_id, offset));
                }
                store.insert(decoded.scene);
                loaded += 1;
            }
            Err(_) => {
                skipped += 1;
            }
        }
    }
    let stats = SceneStoreStats {
        populated,
        loaded,
        skipped,
    };
    Ok((store, shift_jis_textout_offsets, stats))
}

/// Mount ALL NINE opcode-module registrars onto a fresh registry.
///
/// This is the acceptance-criterion-#1 surface: `rg -n
/// 'register_.*_rlops' src/replay.rs` shows all families
/// (`register_text_rlops`, `register_control_flow_rlops`,
/// `register_render_rlops`, `register_audio_rlops`,
/// `register_sel_rlops`, `register_sys_rlops`, `register_mem_rlops`,
/// `register_str_rlops`). The text family threads the supplied
/// [`MsgRuntime`]; every other family is backed by a fixed-seed runtime
/// so the traversal is byte-deterministic (the `sys` clock/RNG is seeded
/// from `LogicalClockTick(0)`).
///
/// The per-family runtimes are cloned into the registry's op table, so
/// they stay alive for the registry's lifetime without the caller
/// holding a separate handle.
/// Which `module_jmp` control-flow registrar a registry mount installs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ControlFlowMount {
    /// Exhaustive-linear-walk cataloguing (`Advance` dispatch): VISIT
    /// every command; never follow a branch. Used by the whole-store
    /// opcode-coverage replay.
    LinearWalk,
    /// Real branch-FOLLOWING execution: goto/gosub/farcall rewrite the
    /// pc / call stack / scene. Used by the headless branch-execution
    /// replay.
    BranchFollowing,
}

fn mount_full_registry(
    sink: Arc<dyn TextSurfaceSink>,
    msg_runtime: Arc<MsgRuntime>,
) -> RlopRegistry {
    mount_registry(sink, msg_runtime, ControlFlowMount::LinearWalk)
}

/// Mount all nine opcode families + the catalog gap-fill, choosing the
/// `module_jmp` control-flow registrar per `control_flow`. Shared by the
/// cataloguing ([`ControlFlowMount::LinearWalk`]) and branch-following
/// ([`ControlFlowMount::BranchFollowing`]) replay paths so every OTHER
/// family (text/grp/obj/audio/sel/sys/mem/str) is identical between them.
fn mount_registry(
    sink: Arc<dyn TextSurfaceSink>,
    msg_runtime: Arc<MsgRuntime>,
    control_flow: ControlFlowMount,
) -> RlopRegistry {
    mount_registry_handles(sink, msg_runtime, control_flow).registry
}

/// The full 9-module registry plus the shared audio + graphics runtimes
/// it drives. [`mount_registry`] discards the runtime handles; the
/// engine-port observation path ([`ReplayEngine::observe_scene`]) RETAINS
/// them so an [`crate::UtsushiReallivePort`] can emit the audio events and
/// the terminal graphics-object stack through the substrate audio + frame
/// sinks. Text flows through the caller-supplied [`TextSurfaceSink`]
/// during the drive, so no text handle is returned here.
struct RegistryHandles {
    registry: RlopRegistry,
    audio: Arc<AudioRuntime>,
    graphics: Arc<GraphicsRuntime>,
}

/// Mount all nine opcode families + the catalog gap-fill, returning the
/// registry ALONGSIDE the shared audio + graphics runtimes. Single source
/// of truth for the registry composition: [`mount_registry`] delegates
/// here and drops the handles, so the cataloguing / branch-following /
/// engine-port paths all mount byte-identical op tables.
fn mount_registry_handles(
    sink: Arc<dyn TextSurfaceSink>,
    msg_runtime: Arc<MsgRuntime>,
    control_flow: ControlFlowMount,
) -> RegistryHandles {
    let mut registry = RlopRegistry::new();

    // Text (msg) + control-flow. The cataloguing replay mounts control
    // flow in EXHAUSTIVE-LINEAR-WALK mode (real numbering, `Advance`
    // dispatch) so it visits every command and never spins on input-gated
    // loops; the branch-following replay mounts the REAL branch semantics
    // so a scene EXECUTES its actual control flow.
    register_text_rlops(&mut registry, msg_runtime);
    match control_flow {
        ControlFlowMount::LinearWalk => {
            register_control_flow_linear_walk(&mut registry);
        }
        ControlFlowMount::BranchFollowing => {
            register_control_flow_branch_following(&mut registry);
        }
    }

    // Graphics: the REAL-numbered render family (module_grp DCs +
    // backgrounds, object creation/setters/management) all share one
    // GraphicsRuntime. Registered under all three lattice types so it
    // fires on real bytes regardless of the compiler's module_type
    // artifact; mounted BEFORE the catalog gap-fill so no render op is
    // shadowed by an `Advance` stub.
    let graphics_runtime = Arc::new(GraphicsRuntime::new());
    register_render_rlops(&mut registry, Arc::clone(&graphics_runtime));

    // Audio.
    let audio_emitter = Arc::new(AudioEventEmitter::new());
    let audio_runtime = Arc::new(AudioRuntime::new(audio_emitter));
    register_audio_rlops(&mut registry, Arc::clone(&audio_runtime));

    // Selection (choices). Backed by the same text sink so choice lines
    // surface through the substrate text surface.
    let sel_runtime = Arc::new(SelRuntime::with_sink(Arc::clone(&sink)));
    register_sel_rlops(&mut registry, sel_runtime);

    // System (fixed-seed clock/RNG → deterministic replay).
    let sys_runtime = Arc::new(SysRuntime::new(LogicalClockTick(0)));
    register_sys_rlops(&mut registry, sys_runtime);

    // Memory (no runtime).
    register_mem_rlops(&mut registry);

    // String ops.
    let str_runtime = Arc::new(StrRuntime::new(sink));
    register_str_rlops(&mut registry, str_runtime);

    // Real-bytes opcode-catalog completion: gap-fill every
    // `(module_type, module_id, opcode)` tuple observed on the proven
    // corpora that the nine per-family tables above do not already claim,
    // so a full-scene replay traverses with ZERO unknown opcodes. Mounted
    // LAST and gap-fill-only, so it never shadows a real-semantics op.
    register_catalog_rlops(&mut registry);

    RegistryHandles {
        registry,
        audio: audio_runtime,
        graphics: graphics_runtime,
    }
}

/// Number of RLOps registered by a full 9-module mount. Runtime proof
/// (beyond the source-level `rg`) that all nine registrars actually run
/// and populate the shared registry.
pub fn full_registry_rlop_count() -> usize {
    let sink: Arc<ReplayTextSink> = Arc::new(ReplayTextSink::default());
    let sink_dyn: Arc<dyn TextSurfaceSink> = Arc::clone(&sink) as Arc<dyn TextSurfaceSink>;
    let runtime = Arc::new(MsgRuntime::with_sink(Arc::clone(&sink_dyn)));
    mount_full_registry(sink_dyn, runtime).len()
}

/// Decode a Seen.txt envelope and stage a [`ReplayContext`] positioned
/// at `(scene_id, 0)` against a MULTI-scene store holding every
/// populated scene. Centralised so [`replay_scene`] and
/// [`replay_until_first_pause`] consume the same build path.
fn stage_replay_context(seen_bytes: &[u8], scene_id: u16) -> Result<ReplayContext, ReplayError> {
    let (store, shift_jis_textout_offsets, _stats) = build_scene_store(seen_bytes)?;
    if store.fetch(scene_id).is_none() {
        return Err(ReplayError::SceneNotFound { scene: scene_id });
    }

    let sink: Arc<ReplayTextSink> = Arc::new(ReplayTextSink::default());
    let sink_dyn: Arc<dyn TextSurfaceSink> = Arc::clone(&sink) as Arc<dyn TextSurfaceSink>;
    let runtime = Arc::new(MsgRuntime::with_sink(Arc::clone(&sink_dyn)));
    let registry = mount_full_registry(sink_dyn, Arc::clone(&runtime));

    let vm = Vm::new(scene_id, 0);

    Ok(ReplayContext {
        vm,
        store,
        registry,
        runtime,
        sink,
        shift_jis_textout_offsets,
    })
}

impl ReplayContext {
    /// Drive this context's VM through [`drive_loop`], borrowing the
    /// owned store/registry/sink/runtime.
    fn drive(&mut self, opts: &ReplayOpts, scene_id: u16) -> ReplayLog {
        let refs = DriveRefs {
            store: &self.store,
            registry: &self.registry,
            runtime: &self.runtime,
            sink: &self.sink,
            shift_jis: &self.shift_jis_textout_offsets,
        };
        drive_loop(&mut self.vm, &refs, opts, scene_id)
    }
}

/// A reusable replay engine over ONE multi-scene store: decompress +
/// decode the whole Seen.txt archive ONCE, then replay from any scene id
/// without re-inflating the archive. Each [`ReplayEngine::replay_from`]
/// mounts a fresh 9-module registry + fresh VM/sink so per-scene runs are
/// independent and byte-deterministic (the `sys` clock/RNG re-seeds from
/// `LogicalClockTick(0)` every call).
///
/// Also accepts an externally-built store via [`ReplayEngine::from_store`]
/// — the path a real-bytes test uses to feed scenes whose second-level
/// segment cipher (`use_xor_2` titles) was decrypted by the dev-only
/// `kaifuu-reallive` recovery before staging.
#[derive(Debug)]
pub struct ReplayEngine {
    store: InMemorySceneStore,
    shift_jis: HashSet<(SceneId, u32)>,
    stats: SceneStoreStats,
    /// Optional `#NAMAE` + `#COLOR_TABLE` speaker resolver, installed into
    /// every per-run [`MsgRuntime`] so the `Textout` → `TextLine` path
    /// resolves a leading `【…】` name prefix into a speaker + text
    /// colour. `None` (the default) leaves lines speaker-less unless the
    /// scene emits nameOpen/nameClose brackets.
    speaker_resolver: Option<Arc<crate::gameexe::NamaeResolver>>,
}

impl ReplayEngine {
    /// Build an engine by decompressing + decoding every populated scene
    /// of a Seen.txt envelope through the pure-utsushi decode path.
    pub fn from_seen_bytes(seen_bytes: &[u8]) -> Result<Self, ReplayError> {
        let (store, shift_jis, stats) = build_scene_store(seen_bytes)?;
        Ok(Self {
            store,
            shift_jis,
            stats,
            speaker_resolver: None,
        })
    }

    /// Install a `#NAMAE` + `#COLOR_TABLE` speaker resolver (built from
    /// the game's `Gameexe.ini` via [`crate::Gameexe::namae_resolver`]).
    /// Every subsequent replay / observation run resolves a leading
    /// `【…】` name prefix into a speaker + dialogue text colour.
    #[must_use]
    pub fn with_namae_resolver(mut self, resolver: crate::gameexe::NamaeResolver) -> Self {
        self.speaker_resolver = Some(Arc::new(resolver));
        self
    }

    /// Build an engine over a pre-decoded store. `shift_jis` names the
    /// `(scene, byte_offset)` pairs at which Shift-JIS textout runs begin
    /// (so text surfaces through the substrate sink).
    pub fn from_store(store: InMemorySceneStore, shift_jis: HashSet<(SceneId, u32)>) -> Self {
        let stats = SceneStoreStats {
            populated: store.len(),
            loaded: store.len(),
            skipped: 0,
        };
        Self {
            store,
            shift_jis,
            stats,
            speaker_resolver: None,
        }
    }

    /// Diagnostic store-build counts.
    pub fn stats(&self) -> SceneStoreStats {
        self.stats
    }

    /// Every scene id present in the store, ascending.
    pub fn scene_ids(&self) -> Vec<SceneId> {
        self.store.scene_ids()
    }

    /// Verify snapshot/restore identity at every tick boundary while
    /// driving `scene_id` to its terminus against THIS engine's store.
    ///
    /// The engine-based counterpart to the free
    /// [`verify_snapshot_restore_each_tick`] — used by real-bytes tests
    /// whose store was staged externally (e.g. `use_xor_2` titles whose
    /// scenes were decrypted before staging), where the free function's
    /// pure-`utsushi` rebuild path would not resolve the scene.
    pub fn verify_snapshot_restore_each_tick(
        &self,
        scene_id: SceneId,
        opts: &ReplayOpts,
    ) -> Result<SnapshotIdentityReport, ReplayError> {
        let sink: Arc<ReplayTextSink> = Arc::new(ReplayTextSink::default());
        let sink_dyn: Arc<dyn TextSurfaceSink> = Arc::clone(&sink) as Arc<dyn TextSurfaceSink>;
        let runtime = Arc::new(MsgRuntime::with_sink(Arc::clone(&sink_dyn)));
        let registry = mount_full_registry(sink_dyn, runtime);
        let mut vm = Vm::new(scene_id, 0);
        let mut scheduler = AlwaysReadyScheduler;
        snapshot_identity_loop(
            &mut vm,
            &self.store,
            &registry,
            &mut scheduler,
            opts,
            scene_id,
        )
    }

    /// Replay from `scene_id` to its terminus against the shared store.
    /// A fresh 9-module registry, VM, and text sink are built per call.
    pub fn replay_from(&self, scene_id: SceneId, opts: &ReplayOpts) -> ReplayLog {
        let sink: Arc<ReplayTextSink> = Arc::new(ReplayTextSink::default());
        let sink_dyn: Arc<dyn TextSurfaceSink> = Arc::clone(&sink) as Arc<dyn TextSurfaceSink>;
        let runtime = Arc::new(MsgRuntime::with_sink(Arc::clone(&sink_dyn)));
        runtime.set_speaker_resolver(self.speaker_resolver.clone());
        let registry = mount_full_registry(sink_dyn, Arc::clone(&runtime));
        let mut vm = Vm::new(scene_id, 0);
        let refs = DriveRefs {
            store: &self.store,
            registry: &registry,
            runtime: &runtime,
            sink: &sink,
            shift_jis: &self.shift_jis,
        };
        drive_loop(&mut vm, &refs, opts, scene_id)
    }

    /// Drive `scene_id` to its natural terminus by EXECUTING real control
    /// flow (jumps / calls FOLLOWED, not linear-walked), using a
    /// deterministic headless [`HeadlessInputScheduler`] to advance past
    /// pause / wait-for-click yields and to resolve choices by `policy`.
    ///
    /// This is the branch-following counterpart to [`Self::replay_from`]
    /// (which linear-walks for cataloguing): a fresh registry mounts the
    /// REAL `module_jmp` branch semantics
    /// ([`register_control_flow_branch_following`]) in place of the
    /// exhaustive-linear-walk registrar, so the VM follows the scene's
    /// ACTUAL Jump / Subroutine / FarCall transfers across the multi-scene
    /// store. Returns a typed [`BranchReplayReport`] recording the
    /// terminus, the executed control-transfer counts, and the
    /// input-provider activity.
    pub fn branch_following_report(
        &self,
        scene_id: SceneId,
        opts: &ReplayOpts,
        policy: HeadlessChoicePolicy,
    ) -> BranchReplayReport {
        let sink: Arc<ReplayTextSink> = Arc::new(ReplayTextSink::default());
        let sink_dyn: Arc<dyn TextSurfaceSink> = Arc::clone(&sink) as Arc<dyn TextSurfaceSink>;
        let runtime = Arc::new(MsgRuntime::with_sink(Arc::clone(&sink_dyn)));
        runtime.set_speaker_resolver(self.speaker_resolver.clone());
        let registry = mount_registry(
            sink_dyn,
            Arc::clone(&runtime),
            ControlFlowMount::BranchFollowing,
        );
        let mut vm = Vm::new(scene_id, 0);
        let mut scheduler = HeadlessInputScheduler::new(policy);
        let refs = DriveRefs {
            store: &self.store,
            registry: &registry,
            runtime: &runtime,
            sink: &sink,
            shift_jis: &self.shift_jis,
        };
        drive_branch_following(&mut vm, &refs, &mut scheduler, opts, scene_id)
    }

    /// Drive `scene_id` branch-following under `policy`, capturing the
    /// play-order [`TextLine`] stream (single pass, no doubling) — including
    /// the `select` prompt's choice-option lines (tagged
    /// `text_surface = "choice:<idx>"`) and the branch text the resolved
    /// choice leads into.
    ///
    /// This is the seam the choice-ACT proof drives: running the SAME scene
    /// under [`HeadlessChoicePolicy::Fixed`]`(0)` vs `Fixed(1)` yields
    /// DIFFERENT subsequent messages, proving that acting on option K drives
    /// the branch for option K (not always-first). Unlike
    /// [`Self::branch_following_report`] (which returns only a text-line
    /// COUNT), this returns the actual lines so a caller can diff the
    /// branches.
    pub fn branch_following_lines(
        &self,
        scene_id: SceneId,
        opts: &ReplayOpts,
        policy: HeadlessChoicePolicy,
    ) -> Vec<TextLine> {
        self.branch_following_observation(scene_id, opts, policy)
            .lines
    }

    /// Like [`Self::branch_following_lines`], but ALSO reports the first
    /// cross-scene dispatch target the resolved branch followed
    /// (`first_cross_scene` — the real `jump` / `farcall` / `goto_on($store)`
    /// entry the option transfers into). For a `select` prompt this is the
    /// scene each option DISPATCHES INTO — i.e. for the archive's opening
    /// game-select (Sweetie HD: the base-game vs fandisk pick) each option's
    /// `branch_entry_scene` is the ROOT of that work's scene subtree. The
    /// itotori work-scope carve consumes this to root a per-WORK narrative
    /// structure from the decode (never a hardcoded work list).
    pub fn branch_following_observation(
        &self,
        scene_id: SceneId,
        opts: &ReplayOpts,
        policy: HeadlessChoicePolicy,
    ) -> BranchFollowingObservation {
        let mut scheduler = HeadlessInputScheduler::new(policy);
        self.branch_following_observation_with_scheduler(scene_id, opts, &mut scheduler)
    }

    /// Drive `scene_id` branch-following under an arbitrary
    /// [`LongOpScheduler`](crate::rlop::LongOpScheduler), capturing the
    /// play-order [`TextLine`] stream and the first cross-scene dispatch
    /// target — like [`Self::branch_following_observation`], but with the
    /// caller supplying the input scheduler.
    ///
    /// This is the interactive-bridge seam: pass a
    /// [`crate::input_bridge::BridgeScheduler`] driven by a headless / user /
    /// replay [`crate::input_bridge::InputSource`] and a HUMAN (or a captured
    /// input log) drives the advance / choice / navigation decisions the walk
    /// makes, instead of the built-in headless auto policy. Because the
    /// observable playthrough (the text-line stream + branch taken) is a pure
    /// function of the scheduler's commits, replaying a captured input log
    /// reproduces the identical observation.
    pub fn branch_following_observation_with_scheduler(
        &self,
        scene_id: SceneId,
        opts: &ReplayOpts,
        scheduler: &mut dyn crate::rlop::LongOpScheduler,
    ) -> BranchFollowingObservation {
        let sink: Arc<ReplayTextSink> = Arc::new(ReplayTextSink::default());
        let pass = self.observe_pass(
            scene_id,
            opts,
            ControlFlowMount::BranchFollowing,
            Arc::clone(&sink) as Arc<dyn TextSurfaceSink>,
            scheduler,
        );
        BranchFollowingObservation {
            lines: sink.take_lines(),
            first_cross_scene: pass.first_cross_scene,
        }
    }

    /// Jump / RESUME the RealLive runtime to a decode-resolved
    /// [`JumpTarget`](crate::JumpTarget), landing on the expected frame / state
    /// DETERMINISTICALLY so a reviewer can jump to the spot and annotate it
    /// reproducibly. Engine-general and game-agnostic: the target is resolved
    /// from THIS engine's decoded scene structure, never a hardcoded scene ref.
    ///
    /// Two resolution mechanisms, both deterministic:
    ///
    /// - **Positional seek** ([`JumpTarget::Scene`](crate::JumpTarget::Scene) /
    ///   [`JumpTarget::Line`](crate::JumpTarget::Line)) — resolve a `(scene, pc)`
    ///   straight out of the decoded dispatch graph (scene start = `pc 0`; a
    ///   source line = its
    ///   [`MetaLine`](crate::BytecodeElement::MetaLine) marker's byte offset via
    ///   [`resolve_line_pc`](crate::resolve_line_pc)) and land the runtime there.
    ///   The landing is identical by construction.
    /// - **Execution fast-forward** ([`JumpTarget::Frame`](crate::JumpTarget::Frame))
    ///   — drive the real branch-following play-order execution from the scene
    ///   start under the deterministic headless input policy, fast-forwarding
    ///   through the intervening execution until the Nth rendered message
    ///   surfaces, then land on it. Because the drive is a pure function of the
    ///   store (deterministic scheduler + fixed-seed clock/RNG), the Nth frame
    ///   and the VM state at it are identical every run.
    ///
    /// Returns a typed [`JumpError`](crate::JumpError) for an absent scene, an
    /// undeclared source line, or a frame index the play-order stream never
    /// reaches — never a silent land-at-zero.
    pub fn jump_to(
        &self,
        target: &JumpTarget,
        opts: &ReplayOpts,
    ) -> Result<JumpLanding, JumpError> {
        match *target {
            JumpTarget::Scene { scene } => self.seek_position(scene, 0, *target),
            JumpTarget::Line { scene, line_number } => {
                let decoded = self
                    .store
                    .fetch(scene)
                    .ok_or(JumpError::SceneNotFound(scene))?;
                let pc = crate::jump::resolve_line_pc(decoded, line_number)
                    .ok_or(JumpError::LineNotFound { scene, line_number })?;
                self.seek_position(scene, pc, *target)
            }
            JumpTarget::Frame { scene, frame_index } => {
                self.drive_to_frame(scene, frame_index, opts)
            }
        }
    }

    /// Land the runtime at `(scene, pc)` positionally (no execution drive) and
    /// report the deterministic landing. Shared by the scene / line seek arms
    /// of [`Self::jump_to`]. A `(scene, pc)` seek is reproducible by
    /// construction: the fresh VM at that position always folds to the same
    /// [`Vm::control_fingerprint`].
    fn seek_position(
        &self,
        scene: SceneId,
        pc: u32,
        target: JumpTarget,
    ) -> Result<JumpLanding, JumpError> {
        if self.store.fetch(scene).is_none() {
            return Err(JumpError::SceneNotFound(scene));
        }
        let vm = Vm::new(scene, pc);
        Ok(JumpLanding {
            target,
            scene,
            pc,
            control_fingerprint: vm.control_fingerprint(),
            frame_index: None,
            landed_line: None,
            steps_fast_forwarded: 0,
        })
    }

    /// Fast-forward the real play-order execution from `scene_id`'s start until
    /// the `frame_index`-th (0-based) rendered message surfaces, landing on it.
    ///
    /// The frame stream is defined EXACTLY as [`Self::observe_for_port`]'s
    /// play-order: the real branch-following pass when it reaches dialogue,
    /// else the single-pass linear byte-order catalogue (the fallback for a
    /// title whose dialogue sits behind a headless-gated menu — e.g. Kanon's
    /// `#SEEN_START` title spin). So a `Frame` target is engine-general: it
    /// lands on the same message the port would render one-per-frame, whether
    /// the game reaches dialogue by branch-following or only by catalogue.
    ///
    /// Deterministic: each pass mounts fixed op tables and a fixed input policy
    /// (branch = [`HeadlessChoicePolicy::AlwaysFirst`], linear =
    /// [`AlwaysReadyScheduler`]), so the emitted stream — and the VM state at
    /// each frame — is a pure function of the store. The landed line therefore
    /// equals `observe_for_port(scene, opts).play_order_lines[frame_index]`
    /// exactly.
    fn drive_to_frame(
        &self,
        scene_id: SceneId,
        frame_index: usize,
        opts: &ReplayOpts,
    ) -> Result<JumpLanding, JumpError> {
        if self.store.fetch(scene_id).is_none() {
            return Err(JumpError::SceneNotFound(scene_id));
        }
        // Pass 1: real branch-following play order. `Err(emitted)` names how
        // many frames the pass produced before it ended.
        match self.drive_frame_pass(
            scene_id,
            frame_index,
            opts,
            ControlFlowMount::BranchFollowing,
        ) {
            Ok(landing) => return Ok(landing),
            // Branch-following DID reach dialogue but not this far — the branch
            // stream IS the play order; the frame is genuinely beyond it.
            Err(emitted) if emitted > 0 => {
                return Err(JumpError::FrameNotReached {
                    scene: scene_id,
                    requested: frame_index,
                    available: emitted,
                });
            }
            // Branch reached NO dialogue: fall through to the linear catalogue,
            // exactly as `observe_for_port`'s play-order fallback does.
            Err(_) => {}
        }
        // Pass 2: single-pass linear byte-order catalogue (play-order fallback).
        self.drive_frame_pass(scene_id, frame_index, opts, ControlFlowMount::LinearWalk)
            .map_err(|emitted| JumpError::FrameNotReached {
                scene: scene_id,
                requested: frame_index,
                available: emitted,
            })
    }

    /// Drive ONE play-order pass (`control_flow`) from `scene_id`'s start,
    /// draining messages step-by-step and landing on `frame_index` when it
    /// surfaces. Returns `Ok(landing)` with the VM state at that frame, or
    /// `Err(emitted)` naming how many frames the pass produced before it ended.
    /// The text-flush and scheduler exactly mirror [`Self::observe_pass`] for
    /// the same `control_flow`, so the emitted stream is byte-identical to the
    /// port's play-order stream.
    fn drive_frame_pass(
        &self,
        scene_id: SceneId,
        frame_index: usize,
        opts: &ReplayOpts,
        control_flow: ControlFlowMount,
    ) -> Result<JumpLanding, usize> {
        let sink: Arc<ReplayTextSink> = Arc::new(ReplayTextSink::default());
        let sink_dyn: Arc<dyn TextSurfaceSink> = Arc::clone(&sink) as Arc<dyn TextSurfaceSink>;
        let runtime = Arc::new(MsgRuntime::with_sink(Arc::clone(&sink_dyn)));
        runtime.set_speaker_resolver(self.speaker_resolver.clone());
        let handles = mount_registry_handles(sink_dyn, Arc::clone(&runtime), control_flow);

        // Match `observe_for_port`'s per-pass scheduler exactly.
        let mut headless = HeadlessInputScheduler::new(HeadlessChoicePolicy::AlwaysFirst);
        let mut always_ready = AlwaysReadyScheduler;
        let scheduler: &mut dyn crate::rlop::LongOpScheduler = match control_flow {
            ControlFlowMount::BranchFollowing => &mut headless,
            ControlFlowMount::LinearWalk => &mut always_ready,
        };

        // Construct the landing for the target frame from the current VM state.
        let land = |vm: &Vm, line: &TextLine, steps: u32| JumpLanding {
            target: JumpTarget::Frame {
                scene: scene_id,
                frame_index,
            },
            scene: vm.scene(),
            pc: vm.pc(),
            control_fingerprint: vm.control_fingerprint(),
            frame_index: Some(frame_index),
            landed_line: Some(line.clone()),
            steps_fast_forwarded: steps,
        };

        let mut vm = Vm::new(scene_id, 0);
        let mut lines: Vec<TextLine> = Vec::new();
        let mut steps: u32 = 0;
        loop {
            if steps >= opts.step_budget {
                break;
            }
            let pc_before = vm.pc();
            let scene_before = vm.scene();
            let Ok(step) = vm.step(&self.store, &handles.registry, scheduler) else {
                break;
            };
            match step {
                StepOutcome::Advanced { event } => {
                    if let VmEvent::Textout { raw_bytes } = &event
                        && self.shift_jis.contains(&(scene_before, pc_before))
                    {
                        dispatch_textout(&runtime, raw_bytes);
                        if let Some(op) = handles.registry.get(RlopKey::new(
                            MSG_MODULE_TYPE,
                            MSG_MODULE_ID,
                            OPCODE_LINE_BREAK,
                        )) {
                            let _ = op.dispatch(&mut vm, &[]);
                        }
                    }
                    steps = steps.saturating_add(1);
                }
                StepOutcome::LongOpResumed { .. } => {
                    steps = steps.saturating_add(1);
                }
                StepOutcome::EndOfScene { .. }
                | StepOutcome::Halted
                | StepOutcome::Suspended { .. } => break,
            }
            let _ = vm.take_warnings();
            // Drain the messages this step surfaced. Landing on the target
            // frame captures the VM state at exactly that point.
            lines.extend(sink.drain());
            if lines.len() > frame_index {
                return Ok(land(&vm, &lines[frame_index], steps));
            }
        }
        // Sweep any messages flushed on the terminating step.
        lines.extend(sink.drain());
        if lines.len() > frame_index {
            return Ok(land(&vm, &lines[frame_index], steps));
        }
        Err(lines.len())
    }

    /// Observe `scene_id` through the shared store while RETAINING the
    /// audio + graphics runtimes, so an engine port can emit the observed
    /// text, audio events, and terminal graphics-object stack through the
    /// three substrate sinks. Text flows into the supplied `text_sink`
    /// during the drive (the caller drains it afterwards).
    ///
    /// This is the production seam [`crate::UtsushiReallivePort`] drives.
    /// It runs TWO real passes into the same `text_sink`, unioning their
    /// observations, because the two modes surface complementary evidence:
    ///
    /// 1. **Branch-following execution** — the REAL engine path: FOLLOWS
    ///    goto/gosub/farcall across the multi-scene store (a rich opening
    ///    that farcalls into dialogue surfaces its whole executed text +
    ///    audio + composited graphics here).
    /// 2. **Exhaustive linear-walk cataloguing** — VISITS every command of
    ///    the entry scene in byte order (guarantees the scene's own
    ///    textouts / audio opcodes surface even when the executed path
    ///    farcalls out before reaching them, or spins on a headless-blocked
    ///    title menu).
    ///
    /// The union is the honest "everything this scene really produces"
    /// observation. Each pass is bounded by `opts.step_budget`.
    pub fn observe_scene(
        &self,
        scene_id: SceneId,
        opts: &ReplayOpts,
        text_sink: Arc<dyn TextSurfaceSink>,
    ) -> SceneObservation {
        // Pass 1: real branch-following execution.
        let mut branch_scheduler = HeadlessInputScheduler::new(HeadlessChoicePolicy::AlwaysFirst);
        let branch = self
            .observe_pass(
                scene_id,
                opts,
                ControlFlowMount::BranchFollowing,
                Arc::clone(&text_sink),
                &mut branch_scheduler,
            )
            .scene;
        // Pass 2: exhaustive linear-walk cataloguing.
        let mut linear_scheduler = AlwaysReadyScheduler;
        let linear = self
            .observe_pass(
                scene_id,
                opts,
                ControlFlowMount::LinearWalk,
                text_sink,
                &mut linear_scheduler,
            )
            .scene;

        let mut audio_events = branch.audio_events;
        audio_events.extend(linear.audio_events);
        // Prefer the executed-path graphics state; fall back to the
        // catalogued stack when the executed path composited nothing.
        let graphics_stack = if branch.graphics_stack.is_empty() {
            linear.graphics_stack
        } else {
            branch.graphics_stack
        };
        SceneObservation {
            audio_events,
            graphics_stack,
            steps: branch.steps.saturating_add(linear.steps),
            reached_natural_terminus: branch.reached_natural_terminus
                || linear.reached_natural_terminus,
        }
    }

    /// Observe `scene_id` for an engine PORT: recover the REAL play-order
    /// message stream separately from the frame/audio observation.
    ///
    /// The defect this replaces: [`Self::observe_scene`] drains the union
    /// of the branch-following AND linear-catalogue passes into ONE text
    /// sink, so the port saw every message ~twice (the doubled
    /// "everything this scene produces" catalogue, not the play order).
    ///
    /// Here the two passes are captured SEPARATELY (never unioned) and the
    /// play-order stream is chosen — SINGLE pass, so no message is doubled:
    ///
    /// 1. **Branch-following** (the REAL engine path a player walks) is the
    ///    true play order. When the headless drive reaches dialogue, its
    ///    emitted [`TextLine`]s — in order, single pass — ARE
    ///    [`PortObservation::play_order_lines`].
    /// 2. **Linear-catalogue** (every command of the scene in byte order,
    ///    single pass) is the WORKAROUND for titles whose real dialogue is
    ///    gated behind a menu/選択 the headless input-provider cannot walk
    ///    into (e.g. Kanon's `#SEEN_START` title scene branch-follows into
    ///    a spin before any message). The byte-order catalogue surfaces
    ///    each message ONCE, so it is still a faithful single-pass stream —
    ///    it is used for `play_order_lines` ONLY when the branch pass
    ///    reached no dialogue. It is NEVER added to the branch stream (that
    ///    union was the ~2× inflation defect).
    ///
    /// Graphics + audio are taken from the executed (branch) path, backfilled
    /// from the linear catalogue only when the branch path composited/played
    /// nothing before yielding.
    pub fn observe_for_port(&self, scene_id: SceneId, opts: &ReplayOpts) -> PortObservation {
        // Pass 1: branch-following = real play order. Capture its text.
        let branch_sink: Arc<ReplayTextSink> = Arc::new(ReplayTextSink::default());
        let mut branch_scheduler = HeadlessInputScheduler::new(HeadlessChoicePolicy::AlwaysFirst);
        let branch_pass = self.observe_pass(
            scene_id,
            opts,
            ControlFlowMount::BranchFollowing,
            Arc::clone(&branch_sink) as Arc<dyn TextSurfaceSink>,
            &mut branch_scheduler,
        );
        let first_cross_scene = branch_pass.first_cross_scene;
        let branch = branch_pass.scene;
        let branch_lines = branch_sink.take_lines();

        // Pass 2: linear byte-order catalogue. Capture its text SEPARATELY
        // (single pass) so it can serve as the play-order fallback; it is
        // used for graphics/audio backfill regardless.
        let linear_sink: Arc<ReplayTextSink> = Arc::new(ReplayTextSink::default());
        let mut linear_scheduler = AlwaysReadyScheduler;
        let linear = self
            .observe_pass(
                scene_id,
                opts,
                ControlFlowMount::LinearWalk,
                Arc::clone(&linear_sink) as Arc<dyn TextSurfaceSink>,
                &mut linear_scheduler,
            )
            .scene;

        // Choose the play order: branch when it reached dialogue, else the
        // single-pass byte-order catalogue. NEVER both (no doubling).
        let play_order_lines = if branch_lines.is_empty() {
            linear_sink.take_lines()
        } else {
            branch_lines
        };

        let mut audio_events = branch.audio_events;
        audio_events.extend(linear.audio_events);
        let graphics_stack = if branch.graphics_stack.is_empty() {
            linear.graphics_stack
        } else {
            branch.graphics_stack
        };
        PortObservation {
            play_order_lines,
            first_cross_scene,
            scene: SceneObservation {
                audio_events,
                graphics_stack,
                steps: branch.steps.saturating_add(linear.steps),
                reached_natural_terminus: branch.reached_natural_terminus
                    || linear.reached_natural_terminus,
            },
        }
    }

    /// Follow the real RealLive scene-dispatch ACROSS scene boundaries to
    /// produce a bounded, continuous MULTI-SCENE play-order stream — the
    /// play-loop a player walks THROUGH the game, not one scene in isolation.
    ///
    /// Starting from `entry`, each scene is observed with
    /// [`Self::observe_for_port`] (its own single-pass play-order messages +
    /// its own composited background / audio). The next scene is the FIRST
    /// cross-scene dispatch target that scene's branch-following walk followed
    /// ([`PortObservation::first_cross_scene`] — a real `jump` / `farcall` /
    /// entrypoint resolution into a scene present in the store). The loop
    /// chains into it and continues, so scene A's messages are followed by
    /// scene B's messages in the correct dispatch order.
    ///
    /// Bounded three ways so it renders a playable through-line rather than
    /// the whole game: at most `max_scenes` scenes are observed; a scene id
    /// already visited stops the chain (loop guard — a scene that dispatches
    /// back to an ancestor does not spin); and each scene's own observation
    /// is bounded by `opts.step_budget`. A scene whose dispatch stays within
    /// itself (no cross-scene transfer) ends the chain naturally.
    ///
    /// `max_scenes` is clamped to ≥ 1 (a playthrough observes at least its
    /// entry scene). The returned [`ScenePlaythrough`] preserves dispatch
    /// order and records the distinct scene ids the play-loop crossed.
    pub fn observe_playthrough(
        &self,
        entry: SceneId,
        opts: &ReplayOpts,
        max_scenes: usize,
    ) -> ScenePlaythrough {
        let max_scenes = max_scenes.max(1);
        let mut segments: Vec<ScenePlaySegment> = Vec::new();
        let mut visited: std::collections::HashSet<SceneId> = std::collections::HashSet::new();
        let mut current = Some(entry);
        while let Some(scene_id) = current {
            if segments.len() >= max_scenes {
                break;
            }
            // Loop guard: a scene that dispatches back to an already-observed
            // scene stops the chain (no infinite re-entry).
            if !visited.insert(scene_id) {
                break;
            }
            let observation = self.observe_for_port(scene_id, opts);
            let next = observation.first_cross_scene;
            segments.push(ScenePlaySegment {
                scene_id,
                observation,
            });
            current = next.filter(|target| !visited.contains(target));
        }
        ScenePlaythrough { segments }
    }

    /// One observation pass: mount the `control_flow` registry (retaining
    /// the audio + graphics runtimes), drive `scene_id` with `scheduler`,
    /// dispatching every Shift-JIS `Textout` into `text_sink`. Also reports
    /// the first cross-scene dispatch target the pass followed (only the
    /// branch-following mount can leave the start scene), so the play-loop
    /// can chain into the next scene.
    fn observe_pass(
        &self,
        scene_id: SceneId,
        opts: &ReplayOpts,
        control_flow: ControlFlowMount,
        text_sink: Arc<dyn TextSurfaceSink>,
        scheduler: &mut dyn crate::rlop::LongOpScheduler,
    ) -> PassObservation {
        let runtime = Arc::new(MsgRuntime::with_sink(Arc::clone(&text_sink)));
        runtime.set_speaker_resolver(self.speaker_resolver.clone());
        let handles = mount_registry_handles(text_sink, Arc::clone(&runtime), control_flow);
        let mut vm = Vm::new(scene_id, 0);
        let mut steps: u32 = 0;
        let mut reached_natural_terminus = false;
        let mut first_cross_scene: Option<SceneId> = None;
        loop {
            if steps >= opts.step_budget {
                break;
            }
            let pc_before = vm.pc();
            let scene_before = vm.scene();
            let Ok(step) = vm.step(&self.store, &handles.registry, scheduler) else {
                break;
            };
            match step {
                StepOutcome::Advanced { event } => {
                    // The VM emits `Textout` events; the driver dispatches
                    // the Shift-JIS run through the text family + a
                    // line-break flush so the decoded line surfaces through
                    // the caller's substrate `TextSurfaceSink`.
                    if let VmEvent::Textout { raw_bytes } = &event
                        && self.shift_jis.contains(&(scene_before, pc_before))
                    {
                        dispatch_textout(&runtime, raw_bytes);
                        if let Some(op) = handles.registry.get(RlopKey::new(
                            MSG_MODULE_TYPE,
                            MSG_MODULE_ID,
                            OPCODE_LINE_BREAK,
                        )) {
                            let _ = op.dispatch(&mut vm, &[]);
                        }
                    }
                    // Record the first cross-scene dispatch boundary the pass
                    // followed (a real `jump` / `farcall` / entrypoint
                    // resolution into a scene present in the store).
                    let scene_now = vm.scene();
                    if first_cross_scene.is_none() && scene_now != scene_id {
                        first_cross_scene = Some(scene_now);
                    }
                    steps = steps.saturating_add(1);
                }
                StepOutcome::LongOpResumed { .. } => {
                    steps = steps.saturating_add(1);
                }
                StepOutcome::EndOfScene { .. } | StepOutcome::Halted => {
                    reached_natural_terminus = true;
                    break;
                }
                StepOutcome::Suspended { .. } => break,
            }
            // Drain warnings so the VM's buffer does not grow unbounded.
            let _ = vm.take_warnings();
        }
        let audio_events = handles.audio.emitter().store().drain_in_order();
        let graphics_stack = handles.graphics.state_snapshot().stack;
        PassObservation {
            scene: SceneObservation {
                audio_events,
                graphics_stack,
                steps,
                reached_natural_terminus,
            },
            first_cross_scene,
        }
    }

    /// Snapshot/restore identity at every tick boundary while driving
    /// `scene_id` to its terminus with the BRANCH-FOLLOWING registry +
    /// the deterministic headless input-provider. The branch-following
    /// counterpart to [`Self::verify_snapshot_restore_each_tick`].
    pub fn verify_branch_snapshot_restore_each_tick(
        &self,
        scene_id: SceneId,
        opts: &ReplayOpts,
        policy: HeadlessChoicePolicy,
    ) -> Result<SnapshotIdentityReport, ReplayError> {
        let sink: Arc<ReplayTextSink> = Arc::new(ReplayTextSink::default());
        let sink_dyn: Arc<dyn TextSurfaceSink> = Arc::clone(&sink) as Arc<dyn TextSurfaceSink>;
        let runtime = Arc::new(MsgRuntime::with_sink(Arc::clone(&sink_dyn)));
        let registry = mount_registry(sink_dyn, runtime, ControlFlowMount::BranchFollowing);
        let mut vm = Vm::new(scene_id, 0);
        let mut scheduler = HeadlessInputScheduler::new(policy);
        snapshot_identity_loop(
            &mut vm,
            &self.store,
            &registry,
            &mut scheduler,
            opts,
            scene_id,
        )
    }
}

/// Drive a Seen.txt envelope through the VM and return a typed
/// [`ReplayLog`]. The driver is the alpha-defining entry point: every
/// downstream "scene 1 emits a TextLine" assertion goes through here.
///
/// # Pipeline
///
/// 1. Read `seen_path` into memory.
/// 2. [`RealSceneIndex::parse`] → locate the entry for `scene_id`.
/// 3. Slice the scene blob; [`SceneHeader::parse`].
/// 4. Slice the compressed bytecode;
///    [`AvgDecompressor::decompress`].
/// 5. [`decode_bytecode_stream`] → typed bytecode elements.
/// 6. Mount [`register_text_rlops`] + [`register_control_flow_rlops`]
///    on an [`RlopRegistry`], thread an
///    [`ReplayTextSink`]-backed [`MsgRuntime`] through the text family.
/// 7. Drive [`Vm::step_many`] with the configured budget, recording a
///    [`ReplayEvent`] per observation.
/// 8. Drain the sink + runtime warnings into the [`ReplayLog`].
///
/// # Fail-soft posture
///
/// Unknown opcodes are recorded as [`ReplayEvent::UnknownOpcode`] and
/// the VM advances; a [`crate::VmError`] from the dispatch loop becomes
/// a [`ReplayOutcome::FatalDiagnostic`]; the budget boundary becomes a
/// [`ReplayOutcome::BudgetExhausted`].
pub fn replay_scene(
    seen_path: &Path,
    scene_id: u16,
    opts: &ReplayOpts,
) -> Result<ReplayLog, ReplayError> {
    let bytes = fs::read(seen_path).map_err(|err| ReplayError::ReadFailed {
        path: seen_path.display().to_string(),
        reason: err.to_string(),
    })?;
    drive_replay(&bytes, scene_id, opts)
}

/// Same as [`replay_scene`] but consumes the Seen.txt bytes directly.
/// Useful for the synthetic test path which builds an envelope in
/// memory rather than touching the filesystem.
pub fn replay_scene_bytes(
    seen_bytes: &[u8],
    scene_id: u16,
    opts: &ReplayOpts,
) -> Result<ReplayLog, ReplayError> {
    drive_replay(seen_bytes, scene_id, opts)
}

/// Drive [`replay_scene`] until the first `msg.pause` lands (or the
/// scene ends), then snapshot the VM through the substrate
/// [`Inspectable`] surface. Returns the log plus the typed
/// [`Snapshot`] payload. The snapshot round-trips identically into a
/// fresh VM — acceptance criterion #2.
pub fn replay_until_first_pause(
    seen_path: &Path,
    scene_id: u16,
) -> Result<(ReplayLog, Snapshot), ReplayError> {
    let bytes = fs::read(seen_path).map_err(|err| ReplayError::ReadFailed {
        path: seen_path.display().to_string(),
        reason: err.to_string(),
    })?;
    let opts = ReplayOpts {
        step_budget: DEFAULT_REPLAY_STEP_BUDGET,
        stop_at_first_pause: true,
    };
    let mut ctx = stage_replay_context(&bytes, scene_id)?;
    let log = ctx.drive(&opts, scene_id);
    let snapshot = snapshot_vm(&ctx.vm)?;
    Ok((log, snapshot))
}

fn drive_replay(
    seen_bytes: &[u8],
    scene_id: u16,
    opts: &ReplayOpts,
) -> Result<ReplayLog, ReplayError> {
    let mut ctx = stage_replay_context(seen_bytes, scene_id)?;
    Ok(ctx.drive(opts, scene_id))
}

/// Outcome of [`verify_snapshot_restore_each_tick`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotIdentityReport {
    /// Number of tick boundaries at which the snapshot round-trip was
    /// verified identical (includes the pre-first-step boundary).
    pub ticks_verified: u32,
    /// Terminal outcome the traversal reached.
    pub terminus: ReplayOutcome,
}

/// Drive a full scene to its terminus and, at EVERY tick boundary
/// (before the first step, and after each `Advanced` / `LongOpResumed`
/// step), assert the VM's substrate snapshot round-trips byte-identically
/// into a fresh VM. Acceptance criterion #3 (snapshot/restore identity
/// holds at every tick boundary).
///
/// Returns the count of verified boundaries plus the terminus, or a typed
/// [`ReplayError::SnapshotFailure`] naming the first tick whose round-trip
/// diverged.
pub fn verify_snapshot_restore_each_tick(
    seen_bytes: &[u8],
    scene_id: u16,
    opts: &ReplayOpts,
) -> Result<SnapshotIdentityReport, ReplayError> {
    let mut ctx = stage_replay_context(seen_bytes, scene_id)?;
    let mut scheduler = AlwaysReadyScheduler;
    snapshot_identity_loop(
        &mut ctx.vm,
        &ctx.store,
        &ctx.registry,
        &mut scheduler,
        opts,
        scene_id,
    )
}

/// Drive `vm` against `store`/`registry` to its terminus with `scheduler`,
/// asserting the substrate snapshot round-trips byte-identically at every
/// tick boundary. Shared by the cataloguing snapshot-identity checks (with
/// [`AlwaysReadyScheduler`]) and the branch-following one (with
/// [`HeadlessInputScheduler`]).
fn snapshot_identity_loop(
    vm: &mut Vm,
    store: &dyn SceneStore,
    registry: &RlopRegistry,
    scheduler: &mut dyn crate::rlop::LongOpScheduler,
    opts: &ReplayOpts,
    scene_id: u16,
) -> Result<SnapshotIdentityReport, ReplayError> {
    let mut steps_executed: u32 = 0;
    let mut ticks_verified: u32 = 0;

    // Verify the pre-first-step boundary too.
    assert_snapshot_round_trip(vm, scene_id, ticks_verified)?;
    ticks_verified += 1;

    let terminus = loop {
        if steps_executed >= opts.step_budget {
            break ReplayOutcome::BudgetExhausted { events: 0 };
        }
        let pc_before = vm.pc();
        let step = match vm.step(store, registry, scheduler) {
            Ok(step) => step,
            Err(err) => {
                break ReplayOutcome::FatalDiagnostic {
                    code: vm_error_semantic_code(&err).to_string(),
                    byte_offset_in_scene: pc_before,
                };
            }
        };
        // Drain warnings so the VM's internal buffer does not grow
        // unboundedly across the walk (it is not part of the snapshot).
        let _ = vm.take_warnings();
        match step {
            StepOutcome::Advanced { .. } | StepOutcome::LongOpResumed { .. } => {
                steps_executed = steps_executed.saturating_add(1);
                assert_snapshot_round_trip(vm, scene_id, ticks_verified)?;
                ticks_verified += 1;
            }
            StepOutcome::Suspended { .. } => {
                break ReplayOutcome::BudgetExhausted { events: 0 };
            }
            StepOutcome::EndOfScene { .. } | StepOutcome::Halted => {
                break ReplayOutcome::EndOfScene { events: 0 };
            }
        }
    };

    Ok(SnapshotIdentityReport {
        ticks_verified,
        terminus,
    })
}

/// Snapshot `vm`, restore into a fresh VM, re-snapshot, and assert the
/// two state trees serialise byte-equally. Returns a typed
/// [`ReplayError::SnapshotFailure`] naming `tick` on divergence.
fn assert_snapshot_round_trip(vm: &Vm, scene_id: u16, tick: u32) -> Result<(), ReplayError> {
    let snapshot = snapshot_vm(vm)?;
    let restored = restore_into_fresh_vm(&snapshot, scene_id)?;
    let restored_snapshot = snapshot_vm(&restored)?;
    let original_json = snapshot
        .to_json_value()
        .map_err(|err| ReplayError::SnapshotFailure {
            reason: err.to_string(),
        })?;
    let restored_json =
        restored_snapshot
            .to_json_value()
            .map_err(|err| ReplayError::SnapshotFailure {
                reason: err.to_string(),
            })?;
    if original_json.get("stateTree") != restored_json.get("stateTree") {
        return Err(ReplayError::SnapshotFailure {
            reason: format!(
                "snapshot/restore identity diverged at tick {tick}: restored VM state tree \
                 does not equal original"
            ),
        });
    }
    Ok(())
}

/// Borrowed view of the pieces [`drive_loop`] needs, so a [`ReplayEngine`]
/// can drive many scenes against ONE store without re-decompressing the
/// whole archive per scene.
struct DriveRefs<'a> {
    store: &'a InMemorySceneStore,
    registry: &'a RlopRegistry,
    runtime: &'a Arc<MsgRuntime>,
    sink: &'a ReplayTextSink,
    shift_jis: &'a HashSet<(SceneId, u32)>,
}

fn drive_loop(vm: &mut Vm, refs: &DriveRefs<'_>, opts: &ReplayOpts, scene_id: u16) -> ReplayLog {
    let mut events: Vec<ReplayEvent> = Vec::new();
    let mut scheduler = AlwaysReadyScheduler;
    let mut steps_executed: u32 = 0;
    let mut text_emitted: u32 = 0;
    let mut first_pause_seen = false;

    let outcome: ReplayOutcome = loop {
        if steps_executed >= opts.step_budget {
            break ReplayOutcome::BudgetExhausted {
                events: events.len() as u32,
            };
        }
        let pc_before = vm.pc();
        let scene_before = vm.scene();
        let step = vm.step(refs.store, refs.registry, &mut scheduler);
        let step = match step {
            Ok(step) => step,
            Err(err) => {
                // Typed VM error halts the run. The pc is the value
                // recorded *before* the step, since the error means
                // the step never landed.
                break ReplayOutcome::FatalDiagnostic {
                    code: vm_error_semantic_code(&err).to_string(),
                    byte_offset_in_scene: pc_before,
                };
            }
        };

        events.push(ReplayEvent::Tick {
            count: steps_executed,
        });

        match step {
            StepOutcome::Advanced { event } => {
                match event {
                    VmEvent::Textout { raw_bytes }
                        if refs.shift_jis.contains(&(scene_before, pc_before)) =>
                    {
                        dispatch_textout(refs.runtime, &raw_bytes);
                        // Flush immediately via OPCODE_LINE_BREAK so
                        // each Shift-JIS run surfaces as a distinct
                        // TextLine before any control opcode lands.
                        // Mirrors the UTSUSHI-209 real-bytes test
                        // strategy — keeps the per-run audit trail
                        // honest.
                        if let Some(op) = refs.registry.get(RlopKey::new(
                            MSG_MODULE_TYPE,
                            MSG_MODULE_ID,
                            OPCODE_LINE_BREAK,
                        )) {
                            let _ = op.dispatch(vm, &[]);
                        }
                        // Drain any sink emissions produced by the
                        // flush and convert to TextLine events with
                        // the original Shift-JIS bytes as evidence.
                        for line in refs.sink.drain() {
                            let body_shift_jis = raw_bytes.clone();
                            events.push(ReplayEvent::TextLine {
                                byte_offset_in_scene: pc_before,
                                body_shift_jis,
                                body_utf8: line.text,
                                speaker: line.speaker,
                                color: line.color,
                            });
                            text_emitted = text_emitted.saturating_add(1);
                        }
                    }
                    VmEvent::CommandDispatched { key, outcome }
                        if key.module_type == MSG_MODULE_TYPE
                            && key.module_id == MSG_MODULE_ID
                            && key.opcode == crate::rlop::module_msg::OPCODE_PAUSE
                            && matches!(outcome, crate::DispatchOutcome::Yield { .. }) =>
                    {
                        // Pause yield → log a Pause event. Unknown
                        // opcodes surface through the VM warning stream
                        // (the dispatch path records a fail-soft
                        // MissingRlop warning and returns an Advance
                        // outcome on the caller's behalf).
                        events.push(ReplayEvent::Pause {
                            byte_offset_in_scene: vm.pc(),
                        });
                        first_pause_seen = true;
                    }
                    _ => {}
                }
                // Pull any newly-arrived MissingRlop warnings from the
                // VM and convert them into UnknownOpcode events. The
                // warning carries the typed key + the pc the miss
                // landed at, which is exactly what the spec demands.
                let warnings = vm.take_warnings();
                for warning in warnings {
                    if let crate::VmWarning::MissingRlop { key, pc, .. } = warning {
                        events.push(ReplayEvent::UnknownOpcode {
                            byte_offset_in_scene: pc,
                            module_type: key.module_type,
                            module_id: key.module_id,
                            opcode: key.opcode,
                        });
                    }
                }
            }
            StepOutcome::LongOpResumed { .. } => {}
            StepOutcome::Suspended { .. } => {
                // AlwaysReadyScheduler should never produce Suspended,
                // but if it ever does (e.g. a future scheduler swap),
                // bail out as BudgetExhausted to keep the loop bounded.
                break ReplayOutcome::BudgetExhausted {
                    events: events.len() as u32,
                };
            }
            StepOutcome::EndOfScene { .. } | StepOutcome::Halted => {
                break ReplayOutcome::EndOfScene {
                    events: events.len() as u32,
                };
            }
        }

        steps_executed = steps_executed.saturating_add(1);

        if opts.stop_at_first_pause && first_pause_seen {
            break ReplayOutcome::FirstPauseReached {
                events: events.len() as u32,
            };
        }
    };

    let _ = text_emitted;

    ReplayLog {
        schema_version: REPLAY_LOG_SCHEMA_VERSION.to_string(),
        scene_id,
        events,
        final_outcome: outcome,
    }
}

/// Counts of the real control-flow transfers a branch-following replay
/// EXECUTED — the evidence that jumps/calls were FOLLOWED (not
/// linear-walked). A linear walk would record ZERO of every field; a
/// branch-following walk records non-zero transfers and, crucially,
/// backward jumps + cross-scene transfers a linear walk can never produce.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlTransferCounts {
    /// Intra-scene `goto`-family jumps executed (pc rewritten within the
    /// same scene).
    pub intra_scene_jumps: u64,
    /// Of `intra_scene_jumps`, how many jumped BACKWARD (target pc < the
    /// jumping command's pc) — a loop/re-entry a linear walk cannot make.
    pub backward_jumps: u64,
    /// Cross-scene `jump` transfers executed (target scene differs).
    pub cross_scene_jumps: u64,
    /// Intra-scene `gosub` subroutine calls executed.
    pub subroutine_calls: u64,
    /// Cross-scene `farcall` calls executed.
    pub far_calls: u64,
    /// `ret` returns executed (subroutine frame popped).
    pub returns: u64,
    /// `rtl` returns executed (far-call frame popped).
    pub returns_from_call: u64,
}

impl ControlTransferCounts {
    /// Total control transfers executed. `> 0` proves the walk FOLLOWED
    /// branches rather than linear-walking.
    pub fn total(&self) -> u64 {
        self.intra_scene_jumps
            + self.cross_scene_jumps
            + self.subroutine_calls
            + self.far_calls
            + self.returns
            + self.returns_from_call
    }
}

/// How a branch-following walk terminated.
///
/// A RealLive scene reaches its natural end in one of two ways: it runs
/// off the end of its bytecode / halts (`EndOfScene`), or — for a scene
/// that is itself a subroutine (entered by the parent via `farcall` /
/// `gosub`) — it executes its top-level `ret` / `rtl`. Driven STANDALONE
/// (with an empty call stack, rather than being called into), that
/// top-level return pops an empty stack; the driver classifies it as
/// [`BranchTerminus::ReturnedToCaller`] — a NATURAL terminus, not a fault,
/// because the scene ran its real control flow to its return point. Both
/// are natural termini ([`BranchTerminus::is_natural`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BranchTerminus {
    /// pc ran past the end of the scene, or a `Halt` was executed.
    EndOfScene,
    /// A top-level `ret` / `rtl` popped the (empty) call stack — the
    /// standalone-driven subroutine scene returned to its notional caller.
    ReturnedToCaller,
    /// A cross-scene `jump` / `farcall` targeted a scene absent from the
    /// store (for the proven corpora: a scene the bytecode decoder has not
    /// yet recovered, or a genuinely-absent sentinel scene). NOT a natural
    /// terminus — records the missing target.
    SceneNotFound(SceneId),
    /// A cross-scene transfer named an entrypoint the target scene does
    /// not declare.
    EntrypointNotFound(SceneId, u16),
    /// The step budget was exhausted (e.g. an event-gated spin loop a
    /// headless walk cannot break). NOT a natural terminus.
    BudgetExhausted,
    /// A deterministic infinite loop was PROVEN (the walk re-entered an
    /// identical `(scene, pc, stack, memory)` fingerprint) AND the
    /// event-flag model could not break it: even after modelling the
    /// polled event as fired (taking the loop's exit edge), the walk
    /// returned to the same provable-spin fingerprint. This is the
    /// bounded-progress typed diagnostic — a scene that genuinely cannot
    /// progress under the headless model, naming exactly where it is
    /// stuck, in place of a silent [`Self::BudgetExhausted`]. NOT a
    /// natural terminus.
    EventGatedSpin {
        /// Scene the walk was stuck spinning in.
        scene: SceneId,
        /// pc at the proven-spin fingerprint.
        pc: u32,
        /// How many deterministic events the model fired before giving
        /// up on this scene (each is a suppressed loop-closing transfer).
        modeled_events: u64,
    },
    /// Any other typed VM error (carries the stable semantic code).
    OtherFatal(String),
}

impl BranchTerminus {
    /// Whether this terminus is a NATURAL end of execution (the scene ran
    /// its real control flow to completion), as opposed to a gap
    /// (unresolved cross-scene target / budget spin / fault).
    pub fn is_natural(&self) -> bool {
        matches!(self, Self::EndOfScene | Self::ReturnedToCaller)
    }
}

/// Typed result of a branch-following replay
/// ([`ReplayEngine::branch_following_report`]). `PartialEq` so a test can
/// assert two runs of the same scene produce a byte-identical report
/// (determinism).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchReplayReport {
    /// Scene the walk started from.
    pub scene_id: SceneId,
    /// How the walk terminated (natural end vs gap).
    pub terminus: BranchTerminus,
    /// Number of `Advanced` / `LongOpResumed` steps executed.
    pub steps: u32,
    /// Executed control-transfer counts (the branch-following evidence).
    pub transfers: ControlTransferCounts,
    /// Distinct scene ids the walk actually entered (`>1` iff a
    /// cross-scene transfer was followed into a resolvable scene).
    pub scenes_visited: std::collections::BTreeSet<SceneId>,
    /// Sorted, de-duplicated `(module_type, module_id, opcode)` tuples the
    /// walk could not dispatch on the EXECUTED path. The acceptance
    /// asserts this is EMPTY.
    pub unknown_opcode_keys: Vec<(u8, u8, u16)>,
    /// `Some(scene)` iff the walk terminated because a cross-scene
    /// transfer targeted a scene absent from the store. The acceptance
    /// asserts this is `None`.
    pub scene_not_found: Option<SceneId>,
    /// Text lines surfaced through the substrate sink during the walk.
    pub text_lines: usize,
    /// Pause / wait-for-click yields the input-provider auto-dismissed.
    pub pauses_advanced: u64,
    /// Choice prompts the input-provider resolved.
    pub choices_made: u64,
    /// Deterministic events the spin-break model fired during the walk:
    /// each is a PROVEN infinite-loop closing transfer that the model
    /// rewrote to a fall-through (modelling the polled event as having
    /// occurred). `0` for a scene that reached its terminus with no
    /// event-gated spin. Reproducible (fingerprint-driven, no clock/RNG).
    pub modeled_events: u64,
    /// The FIRST scene id, in dispatch order, the walk entered that differs
    /// from [`Self::scene_id`] — the real cross-scene dispatch target a
    /// `jump` / `farcall` / entrypoint resolution transferred into (always
    /// present in the store, since a transfer to an absent scene errors as
    /// [`BranchTerminus::SceneNotFound`] before the pc lands). `None` when
    /// the walk never left its start scene. This is the "next scene" the
    /// play-loop continues into ([`ReplayEngine::observe_playthrough`] chains
    /// on it to produce a multi-scene play-order stream).
    pub first_cross_scene: Option<SceneId>,
}

/// The real observation set produced by [`ReplayEngine::observe_scene`]:
/// the audio events emitted during the drive, the terminal
/// graphics-object stack, and the drive diagnostics. Text is not carried
/// here — it flowed into the caller-supplied
/// [`utsushi_core::substrate::TextSurfaceSink`] during the drive.
#[derive(Debug)]
pub struct SceneObservation {
    /// Audio events (`bgm` / `koe` / `se` / `wav` opcodes) emitted during
    /// the drive, in emission order. Converted by the engine port into
    /// substrate `AudioEvent`s (at the substrate's `E0` audio ceiling).
    pub audio_events: Vec<RealliveAudioEvent>,
    /// The graphics-object stack at the terminus, ready to composite into
    /// a frame through the real g00 rasteriser.
    pub graphics_stack: GraphicsObjectStack,
    /// Number of `Advanced` / `LongOpResumed` steps executed.
    pub steps: u32,
    /// Whether the drive reached a natural terminus (`EndOfScene` /
    /// `Halt`) rather than the step budget.
    pub reached_natural_terminus: bool,
}

/// The port-facing observation produced by
/// [`ReplayEngine::observe_for_port`]: the REAL play-order message stream
/// kept distinct from the frame/audio observation.
#[derive(Debug)]
pub struct PortObservation {
    /// The branch-following (real play-order) message stream, single pass,
    /// in the order a player sees the messages. This is what the message
    /// window renders one-per-frame and what the substrate text sink
    /// surfaces — NOT the doubled two-pass catalogue.
    pub play_order_lines: Vec<TextLine>,
    /// The first cross-scene dispatch target the branch-following pass
    /// followed (a real `jump` / `farcall` / entrypoint resolution into a
    /// scene present in the store), or `None` when play stayed within this
    /// scene. This is the "next scene" the play-loop continues into;
    /// [`ReplayEngine::observe_playthrough`] chains on it.
    pub first_cross_scene: Option<SceneId>,
    /// Frame + audio observation (graphics stack, audio events, drive
    /// diagnostics). Its graphics/audio may be backfilled from the linear
    /// catalogue pass; its text is not used (see `play_order_lines`).
    pub scene: SceneObservation,
}

/// The outcome of a single branch-following drive under a fixed choice
/// policy ([`ReplayEngine::branch_following_observation`]): the play-order
/// text lines the branch produced PLUS the first cross-scene dispatch target
/// it followed. For a `select` option this `first_cross_scene` is the scene
/// the option DISPATCHES INTO (its branch root) — the signal the itotori
/// work-scope carve reads off the archive's opening game-select.
#[derive(Debug, Clone)]
pub struct BranchFollowingObservation {
    /// The branch's play-order text lines (single pass, choice-option lines
    /// included, tagged `text_surface = "choice:<idx>"`).
    pub lines: Vec<TextLine>,
    /// The first cross-scene dispatch target the resolved branch followed
    /// (`jump` / `farcall` / `goto_on($store)`), or `None` when the branch
    /// stayed within its start scene.
    pub first_cross_scene: Option<SceneId>,
}

/// One observation pass' outputs: the [`SceneObservation`] plus the first
/// cross-scene dispatch target the pass followed (only the branch-following
/// mount can leave the start scene; the linear-walk mount always reports
/// `None`).
struct PassObservation {
    scene: SceneObservation,
    first_cross_scene: Option<SceneId>,
}

/// A bounded, continuous MULTI-SCENE play-order stream produced by
/// [`ReplayEngine::observe_playthrough`]: the play-loop followed the real
/// RealLive scene-dispatch across ≥1 scene boundary, in dispatch order.
#[derive(Debug)]
pub struct ScenePlaythrough {
    /// The observed scenes, in the dispatch order the play-loop crossed them
    /// (`segments[0]` is the entry scene; each subsequent segment is the
    /// cross-scene dispatch target the previous one followed).
    pub segments: Vec<ScenePlaySegment>,
}

impl ScenePlaythrough {
    /// The scene ids the play-loop crossed, in dispatch order. `len() >= 2`
    /// proves the stream spanned a real scene boundary (a regression that
    /// stops at the entry scene yields `len() == 1`).
    pub fn scene_ids(&self) -> Vec<SceneId> {
        self.segments.iter().map(|s| s.scene_id).collect()
    }

    /// Total play-order messages across every observed scene.
    pub fn total_messages(&self) -> usize {
        self.segments
            .iter()
            .map(|s| s.observation.play_order_lines.len())
            .sum()
    }
}

/// One scene of a [`ScenePlaythrough`]: its id plus the full port
/// observation (single-pass play-order messages + its own composited
/// background / audio) the play-loop rendered for it.
#[derive(Debug)]
pub struct ScenePlaySegment {
    /// The scene id this segment's messages/background belong to.
    pub scene_id: SceneId,
    /// The scene's port observation: play-order messages + its own frame /
    /// audio observation (its background is `observation.scene.graphics_stack`).
    pub observation: PortObservation,
}

/// Drive `vm` to its natural terminus by FOLLOWING real control flow,
/// using `scheduler` (a deterministic headless input-provider) to advance
/// past pause/wait yields and resolve choices. Records the executed
/// control-transfer counts + terminus into a [`BranchReplayReport`].
fn drive_branch_following(
    vm: &mut Vm,
    refs: &DriveRefs<'_>,
    scheduler: &mut HeadlessInputScheduler,
    opts: &ReplayOpts,
    scene_id: u16,
) -> BranchReplayReport {
    // Break-mode step cap: a proven-infinite frame that does not unwind
    // within this many suppressed steps surfaces the bounded-progress
    // typed diagnostic instead of a silent budget spin.
    const BREAK_MODE_STEP_CAP: u64 = 1_000_000;

    let mut steps: u32 = 0;
    let mut transfers = ControlTransferCounts::default();
    let mut scenes_visited: std::collections::BTreeSet<SceneId> = std::collections::BTreeSet::new();
    scenes_visited.insert(scene_id);
    // The first scene id the walk transfers INTO that differs from the start
    // scene, captured in dispatch order (the ordered `scenes_visited` set
    // loses this). Drives cross-scene play-loop chaining.
    let mut first_cross_scene: Option<SceneId> = None;
    let mut unknown: Vec<(u8, u8, u16)> = Vec::new();
    let mut text_lines: usize = 0;

    // --- Deterministic event-flag modeling (provable-spin break) ---
    //
    // A headless walk has no player / windowing event source, so a scene
    // that busy-polls an event flag the event system would set spins
    // forever (`goto`-loop on a memory cell that never changes). We PROVE
    // such a spin deterministically: at every control-transfer boundary we
    // fold the FULL machine state — `(scene, pc, stack, ALL memory)` — into
    // a fingerprint. Re-entering an already-seen fingerprint is a provable
    // infinite loop: stepping is a pure function of that state, so the
    // future is identical forever (no clock/RNG can perturb it — the sys
    // clock is fixed-seed and every RNG draw lands in memory, which the
    // fingerprint captures).
    //
    // On proving a spin we MODEL the awaited events as having fired by
    // entering depth-scoped "break mode": every subsequent control
    // transfer is suppressed to a fall-through until the stuck frame
    // unwinds (its stack depth drops below the depth at which the spin was
    // proven), so a gated wait loop takes its exit edge and the scene runs
    // its remaining control flow to a natural terminus. A break mode that
    // never unwinds within `BREAK_MODE_STEP_CAP` surfaces the
    // bounded-progress typed diagnostic [`BranchTerminus::EventGatedSpin`]
    // instead of a silent budget spin.
    let mut transfer_states: std::collections::HashSet<u64> = std::collections::HashSet::new();
    let mut modeled_events: u64 = 0;
    // `Some(exit_depth)` while modelling a proven-infinite frame; the walk
    // resumes normal branch-following once the stack unwinds below it.
    let mut break_mode: Option<usize> = None;
    let mut break_mode_steps: u64 = 0;

    let terminus: BranchTerminus = loop {
        if steps >= opts.step_budget {
            break BranchTerminus::BudgetExhausted;
        }
        let pc_before = vm.pc();
        let scene_before = vm.scene();
        let step = match vm.step(refs.store, refs.registry, scheduler) {
            Ok(step) => step,
            Err(err) => {
                break match err {
                    crate::VmError::SceneNotFound { scene } => BranchTerminus::SceneNotFound(scene),
                    crate::VmError::EntrypointNotFound { scene, entrypoint } => {
                        BranchTerminus::EntrypointNotFound(scene, entrypoint)
                    }
                    // A top-level `ret` / `rtl` popping the empty stack is
                    // the natural return of a standalone-driven subroutine
                    // scene — the scene executed its real control flow to
                    // its return point. Count it so the transfer totals
                    // reflect the final return.
                    crate::VmError::EmptyStack { expected, .. } => {
                        if expected == "far_call" {
                            transfers.returns_from_call += 1;
                        } else {
                            transfers.returns += 1;
                        }
                        BranchTerminus::ReturnedToCaller
                    }
                    other => BranchTerminus::OtherFatal(vm_error_semantic_code(&other).to_string()),
                };
            }
        };

        // Did this step take a LOOP-CLOSING control transfer? Any cycle in
        // the control-flow graph must contain a "back edge" — a BACKWARD
        // intra-scene jump, a CROSS-scene jump, or a `ret` / `rtl` unwind —
        // so we only fold the (relatively expensive) full-state fingerprint
        // at those edges. Forward `goto` / `gosub` / `farcall` calls cannot
        // close a loop and are skipped, keeping the per-step cost off the
        // hot path of a long linear scene.
        let suppressed = vm.last_transfer_suppressed();
        let mut is_loop_closing = suppressed;

        match step {
            StepOutcome::Advanced { event } => {
                if let VmEvent::CommandDispatched { outcome, .. } = &event {
                    is_loop_closing |= match outcome {
                        // A cross-scene jump, or an intra-scene jump to the
                        // SAME or an EARLIER pc (`<=` catches a `goto`-to-self
                        // spin), is a back edge that can close a loop.
                        DispatchOutcome::Jump { scene, pc } => {
                            *scene != scene_before || *pc <= pc_before
                        }
                        DispatchOutcome::Return | DispatchOutcome::ReturnFromCall => true,
                        _ => false,
                    };
                }
                match &event {
                    VmEvent::Textout { raw_bytes }
                        if refs.shift_jis.contains(&(scene_before, pc_before)) =>
                    {
                        dispatch_textout(refs.runtime, raw_bytes);
                        if let Some(op) = refs.registry.get(RlopKey::new(
                            MSG_MODULE_TYPE,
                            MSG_MODULE_ID,
                            OPCODE_LINE_BREAK,
                        )) {
                            let _ = op.dispatch(vm, &[]);
                        }
                        text_lines += refs.sink.drain().len();
                    }
                    VmEvent::CommandDispatched { key, outcome } if key.module_id == 1 => {
                        // Count the real control transfer this jmp op
                        // executed. `outcome` is the RESOLVED outcome
                        // (cross-scene entrypoints already resolved to a
                        // concrete scene/pc), so scene comparison is honest.
                        // A model-suppressed transfer arrives here as
                        // `Advance` and is (correctly) NOT counted — it did
                        // not transfer.
                        match outcome {
                            DispatchOutcome::Jump { scene, pc } => {
                                if *scene == scene_before {
                                    transfers.intra_scene_jumps += 1;
                                    if *pc < pc_before {
                                        transfers.backward_jumps += 1;
                                    }
                                } else {
                                    transfers.cross_scene_jumps += 1;
                                }
                            }
                            DispatchOutcome::Subroutine { .. } => transfers.subroutine_calls += 1,
                            DispatchOutcome::FarCall { .. } => transfers.far_calls += 1,
                            DispatchOutcome::Return => transfers.returns += 1,
                            DispatchOutcome::ReturnFromCall => transfers.returns_from_call += 1,
                            _ => {}
                        }
                    }
                    _ => {}
                }
                let scene_now = vm.scene();
                scenes_visited.insert(scene_now);
                if first_cross_scene.is_none() && scene_now != scene_id {
                    // The pc landed in a DIFFERENT scene: the walk followed a
                    // real cross-scene `jump` / `farcall` / entrypoint
                    // resolution into a scene present in the store (an absent
                    // target would have errored before landing). Record it as
                    // the first dispatch boundary in play order.
                    first_cross_scene = Some(scene_now);
                }
                for warning in vm.take_warnings() {
                    if let crate::VmWarning::MissingRlop { key, .. } = warning {
                        unknown.push((key.module_type, key.module_id, key.opcode));
                    }
                }
            }
            StepOutcome::LongOpResumed { .. } => {}
            StepOutcome::Suspended { .. } => {
                // The headless input-provider resumes every longop, so a
                // Suspended here would be a provider bug. Bail bounded.
                break BranchTerminus::BudgetExhausted;
            }
            StepOutcome::EndOfScene { .. } | StepOutcome::Halted => {
                break BranchTerminus::EndOfScene;
            }
        }

        if suppressed {
            modeled_events += 1;
        }

        if let Some(exit_depth) = break_mode {
            // We are inside a proven-infinite frame, modelling every
            // pending event as fired: keep suppressing each control
            // transfer so the walk FALLS THROUGH the wait loop's gating
            // branches and unwinds. A `ret` / `rtl` is never suppressed
            // (see `outcome_is_pc_moving_transfer`), so the stack depth
            // strictly decreases until it drops below the depth at which
            // the spin was proven — at which point the stuck frame has
            // returned and normal branch-following resumes. The loop's
            // `EndOfScene` / empty-stack-`ret` arms above still fire, so a
            // top-level spin unwinds to a natural terminus.
            break_mode_steps += 1;
            if vm.stack().len() < exit_depth {
                break_mode = None;
            } else if break_mode_steps > BREAK_MODE_STEP_CAP {
                // The model fired for far too long without unwinding — a
                // genuine dead spin. Surface the bounded-progress typed
                // diagnostic instead of a silent budget spin.
                break BranchTerminus::EventGatedSpin {
                    scene: vm.scene(),
                    pc: vm.pc(),
                    modeled_events,
                };
            } else {
                vm.request_suppress_next_transfer();
            }
        } else if is_loop_closing {
            // Provable-spin detection: fold the full deterministic state at
            // each loop-closing edge. A repeated fingerprint proves an
            // infinite loop (stepping is a pure function of that state), so
            // enter depth-scoped break mode to model the awaited events as
            // fired and unwind the stuck frame.
            let fingerprint = vm.control_fingerprint();
            if !transfer_states.insert(fingerprint) {
                break_mode = Some(vm.stack().len());
                break_mode_steps = 0;
                vm.request_suppress_next_transfer();
            }
        }

        steps = steps.saturating_add(1);
    };

    unknown.sort_unstable();
    unknown.dedup();

    let scene_not_found = if let BranchTerminus::SceneNotFound(scene) = &terminus {
        Some(*scene)
    } else {
        None
    };

    BranchReplayReport {
        scene_id,
        terminus,
        steps,
        transfers,
        scenes_visited,
        unknown_opcode_keys: unknown,
        scene_not_found,
        text_lines,
        pauses_advanced: scheduler.pauses_advanced(),
        choices_made: scheduler.choices_made(),
        modeled_events,
        first_cross_scene,
    }
}

fn vm_error_semantic_code(err: &crate::VmError) -> &'static str {
    match err {
        crate::VmError::SceneNotFound { .. } => "utsushi.reallive.vm.scene_not_found",
        crate::VmError::EntrypointNotFound { .. } => "utsushi.reallive.vm.entrypoint_not_found",
        crate::VmError::UnalignedPc { .. } => "utsushi.reallive.vm.unaligned_pc",
        crate::VmError::EmptyStack { .. } => "utsushi.reallive.vm.empty_stack",
        crate::VmError::FrameKindMismatch { .. } => "utsushi.reallive.vm.frame_kind_mismatch",
        crate::VmError::BytecodeDecode { .. } => "utsushi.reallive.vm.bytecode_decode",
        crate::VmError::StackOverflow { .. } => "utsushi.reallive.vm.stack_overflow",
        crate::VmError::UnexpectedDispatchOutcome { .. } => {
            "utsushi.reallive.vm.unexpected_dispatch_outcome"
        }
    }
}

fn snapshot_vm(vm: &Vm) -> Result<Snapshot, ReplayError> {
    let request = SnapshotRequest::new(
        "utsushi-reallive-replay",
        "1970-01-01T00:00:00Z",
        EvidenceTier::E1,
    )
    .with_envelope_class(SnapshotEnvelope::Medium);
    let snapshot = take_snapshot(vm, &request)?;
    Ok(snapshot)
}

/// Restore a captured [`Snapshot`] onto a fresh VM constructed at
/// `(scene_id, 0)`. Centralised so tests can express the round-trip
/// without dragging in the substrate facade directly.
pub fn restore_into_fresh_vm(snapshot: &Snapshot, scene_id: u16) -> Result<Vm, ReplayError> {
    let mut vm = Vm::new(scene_id, 0);
    let _report = restore_snapshot(&mut vm, snapshot).map_err(ReplayError::from)?;
    Ok(vm)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replay_opts_default_step_budget_matches_constant() {
        let opts = ReplayOpts::default();
        assert_eq!(opts.step_budget, DEFAULT_REPLAY_STEP_BUDGET);
        assert!(!opts.stop_at_first_pause);
    }

    /// Regression for the `(module_type=1, module_id=5, opcode=3)` key
    /// COLLISION: `msg.pause` and `sel.select_objbtn` used to share a key
    /// because `module_id`s were mislabelled (both 5), so `sel` silently
    /// clobbered `msg.pause` in the shared registry and Pause-event
    /// detection dispatched the wrong op. With the real ids (msg=3,
    /// sel=2) the two ops occupy DISTINCT keys and `mount_full_registry`
    /// registers both with no displacement (the dup-key guard would panic
    /// on any collision).
    #[test]
    fn msg_pause_and_sel_select_objbtn_occupy_distinct_registry_keys() {
        let pause_key = RlopKey::new(
            MSG_MODULE_TYPE,
            MSG_MODULE_ID,
            crate::rlop::module_msg::OPCODE_PAUSE,
        );
        let objbtn_key = RlopKey::new(
            crate::rlop::module_sel::SEL_MODULE_TYPE,
            crate::rlop::module_sel::SEL_MODULE_ID,
            crate::rlop::module_sel::OPCODE_SELECT_OBJBTN,
        );
        // The corrected real ids. `sel` lives at the real RealLive `Sel`
        // module (module_type=0, module_id=2); `msg` at (1, 3). They no
        // longer share a module_type, so the two keys are trivially distinct.
        assert_eq!(pause_key, RlopKey::new(1, 3, 3), "msg.pause is (1, 3, 3)");
        assert_eq!(
            objbtn_key,
            RlopKey::new(0, 2, 4),
            "sel.select_objbtn is the REAL rlvm opcode (0, 2, 4)"
        );
        assert_ne!(
            pause_key, objbtn_key,
            "msg.pause and sel.select_objbtn MUST NOT share a key"
        );

        // Mounting the full registry must NOT panic (the dup-key guard
        // proves there is no displacement anywhere in the 9-family +
        // catalog mount), and both keys must resolve to their own op.
        let sink: Arc<ReplayTextSink> = Arc::new(ReplayTextSink::default());
        let sink_dyn: Arc<dyn TextSurfaceSink> = Arc::clone(&sink) as Arc<dyn TextSurfaceSink>;
        let runtime = Arc::new(MsgRuntime::with_sink(Arc::clone(&sink_dyn)));
        let registry = mount_full_registry(sink_dyn, runtime);
        assert!(
            registry.get(pause_key).is_some(),
            "msg.pause must resolve at its own key"
        );
        assert!(
            registry.get(objbtn_key).is_some(),
            "sel.select_objbtn must resolve at its own key"
        );
    }

    #[test]
    fn empty_replay_log_serialises_deterministically() {
        let log = ReplayLog {
            schema_version: REPLAY_LOG_SCHEMA_VERSION.to_string(),
            scene_id: 1,
            events: vec![],
            final_outcome: ReplayOutcome::EndOfScene { events: 0 },
        };
        let a = log.to_deterministic_json().expect("serialise");
        let b = log.to_deterministic_json().expect("serialise");
        assert_eq!(a, b);
        // Pinned key ordering.
        assert!(a.contains("\"events\""));
        assert!(a.contains("\"finalOutcome\""));
        assert!(a.contains("\"schemaVersion\""));
        assert!(a.contains("\"sceneId\""));
    }

    #[test]
    fn replay_log_text_line_count_matches_event_count() {
        let log = ReplayLog {
            schema_version: REPLAY_LOG_SCHEMA_VERSION.to_string(),
            scene_id: 1,
            events: vec![
                ReplayEvent::Tick { count: 0 },
                ReplayEvent::TextLine {
                    byte_offset_in_scene: 12,
                    body_shift_jis: vec![0x82, 0xa0],
                    body_utf8: "あ".to_string(),
                    speaker: None,
                    color: None,
                },
                ReplayEvent::Pause {
                    byte_offset_in_scene: 20,
                },
            ],
            final_outcome: ReplayOutcome::FirstPauseReached { events: 3 },
        };
        assert_eq!(log.text_line_count(), 1);
        assert_eq!(log.unknown_opcode_count(), 0);
        assert_eq!(log.first_text_line_utf8(), Some("あ"));
    }

    #[test]
    fn replay_event_text_line_hexes_body_bytes() {
        let event = ReplayEvent::TextLine {
            byte_offset_in_scene: 0,
            body_shift_jis: vec![0xde, 0xad, 0xbe, 0xef],
            body_utf8: String::new(),
            speaker: None,
            color: None,
        };
        let value = event_to_canonical_value(&event);
        let obj = value.as_object().expect("object");
        assert_eq!(
            obj.get("bodyShiftJisHex").and_then(|value| value.as_str()),
            Some("deadbeef"),
        );
    }

    #[test]
    fn bytes_to_hex_round_trips_with_pinned_alphabet() {
        assert_eq!(bytes_to_hex(&[0x00, 0x0f, 0x10, 0xff]), "000f10ff");
    }

    #[test]
    fn replay_scene_missing_file_returns_typed_read_failed() {
        let path = std::path::Path::new("/nonexistent/utsushi-reallive-replay-test/Seen.txt");
        let opts = ReplayOpts::default();
        let err = replay_scene(path, 1, &opts).expect_err("missing file is typed");
        match err {
            ReplayError::ReadFailed { path, .. } => {
                assert!(path.contains("Seen.txt"));
            }
            other => panic!("expected ReadFailed, got {other:?}"),
        }
    }

    #[test]
    fn replay_scene_truncated_envelope_returns_typed_parse_error() {
        // Too short for the directory.
        let bytes = vec![0u8; 16];
        let opts = ReplayOpts::default();
        let err = replay_scene_bytes(&bytes, 1, &opts).expect_err("truncated envelope rejected");
        assert!(matches!(err, ReplayError::SceneIndexParse { .. }));
    }
}
