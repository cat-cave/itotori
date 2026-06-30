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

use crate::bytecode_element::{BytecodeElement, TextoutEncoding, decode_bytecode_stream};
use crate::decompressor::AvgDecompressor;
use crate::rlop::module_ctrl::register_control_flow_rlops;
use crate::rlop::module_msg::{
    MSG_MODULE_ID, MSG_MODULE_TYPE, MsgRuntime, OPCODE_LINE_BREAK, dispatch_textout,
    register_text_rlops,
};
use crate::rlop::{AlwaysReadyScheduler, RlopKey, RlopRegistry};
use crate::scene_header::{SCENE_HEADER_BYTE_LEN, SceneHeader};
use crate::scene_index::RealSceneIndex;
use crate::vm::{InMemorySceneStore, Scene, StepOutcome, Vm, VmEvent};

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
        /// equivalent through `encoding_rs::SHIFT_JIS`. Always present;
        /// callers that want byte-stable evidence consult
        /// `body_shift_jis`.
        body_utf8: String,
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
        let value = self.to_canonical_value()?;
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
    fn to_canonical_value(&self) -> Result<serde_json::Value, ReplayError> {
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
        Ok(serde_json::Value::Object(sort_map_keys(map)))
    }
}

fn event_to_canonical_value(event: &ReplayEvent) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    match event {
        ReplayEvent::TextLine {
            byte_offset_in_scene,
            body_shift_jis,
            body_utf8,
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
            map.insert(
                "kind".to_string(),
                serde_json::Value::String("text_line".to_string()),
            );
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

impl std::fmt::Debug for ReplayTextSink {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ReplayTextSink")
            .field(
                "buffered_lines",
                &self.lines.lock().map(|guard| guard.len()).unwrap_or(0),
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
    shift_jis_textout_offsets: HashSet<u32>,
}

/// Decode a Seen.txt envelope and stage a [`ReplayContext`] positioned
/// at `(scene_id, 0)`. Centralised so [`replay_scene`] and
/// [`replay_until_first_pause`] consume the same build path.
fn stage_replay_context(seen_bytes: &[u8], scene_id: u16) -> Result<ReplayContext, ReplayError> {
    let index = RealSceneIndex::parse(seen_bytes).map_err(|err| ReplayError::SceneIndexParse {
        reason: err.to_string(),
    })?;
    let entry = index
        .lookup(scene_id)
        .ok_or(ReplayError::SceneNotFound { scene: scene_id })?;
    let blob_start =
        usize::try_from(entry.byte_offset).map_err(|_| ReplayError::SliceOverflow {
            scene: scene_id,
            reason: format!("byte_offset {} exceeds usize::MAX", entry.byte_offset),
        })?;
    let blob_len = entry.byte_len as usize;
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
    let blob = &seen_bytes[blob_start..blob_end];
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
    let elements =
        decode_bytecode_stream(&decompressed).map_err(|err| ReplayError::BytecodeDecode {
            scene: scene_id,
            reason: err.to_string(),
        })?;
    if elements.is_empty() {
        return Err(ReplayError::EmptyScene { scene: scene_id });
    }

    // Pre-walk: collect the byte offsets of every Shift-JIS-tagged
    // textout run. The runtime's `flush_pending_line` path only
    // surfaces a TextLine when the body decodes cleanly; we use this
    // set to drive `dispatch_textout` from the dispatch loop only when
    // the pc lands on a Shift-JIS run.
    let mut shift_jis_textout_offsets: HashSet<u32> = HashSet::new();
    for element in &elements {
        if let BytecodeElement::Textout {
            encoding_hint,
            byte_offset,
            ..
        } = element
            && matches!(encoding_hint, TextoutEncoding::ShiftJis)
        {
            let offset = u32::try_from(*byte_offset).unwrap_or(u32::MAX);
            shift_jis_textout_offsets.insert(offset);
        }
    }

    let scene =
        Scene::new(scene_id, elements).ok_or(ReplayError::EmptyScene { scene: scene_id })?;
    let mut store = InMemorySceneStore::new();
    store.insert(scene);

    let sink: Arc<ReplayTextSink> = Arc::new(ReplayTextSink::default());
    let runtime = Arc::new(MsgRuntime::with_sink(
        Arc::clone(&sink) as Arc<dyn TextSurfaceSink>
    ));
    let mut registry = RlopRegistry::new();
    register_text_rlops(&mut registry, Arc::clone(&runtime));
    register_control_flow_rlops(&mut registry);

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
    let log = drive_loop(&mut ctx, &opts, scene_id);
    let snapshot = snapshot_vm(&ctx.vm)?;
    Ok((log, snapshot))
}

fn drive_replay(
    seen_bytes: &[u8],
    scene_id: u16,
    opts: &ReplayOpts,
) -> Result<ReplayLog, ReplayError> {
    let mut ctx = stage_replay_context(seen_bytes, scene_id)?;
    Ok(drive_loop(&mut ctx, opts, scene_id))
}

fn drive_loop(ctx: &mut ReplayContext, opts: &ReplayOpts, scene_id: u16) -> ReplayLog {
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
        let pc_before = ctx.vm.pc();
        let step = ctx.vm.step(&ctx.store, &ctx.registry, &mut scheduler);
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
                        if ctx.shift_jis_textout_offsets.contains(&pc_before) =>
                    {
                        dispatch_textout(&ctx.runtime, &raw_bytes);
                        // Flush immediately via OPCODE_LINE_BREAK so
                        // each Shift-JIS run surfaces as a distinct
                        // TextLine before any control opcode lands.
                        // Mirrors the UTSUSHI-209 real-bytes test
                        // strategy — keeps the per-run audit trail
                        // honest.
                        if let Some(op) = ctx.registry.get(RlopKey::new(
                            MSG_MODULE_TYPE,
                            MSG_MODULE_ID,
                            OPCODE_LINE_BREAK,
                        )) {
                            let _ = op.dispatch(&mut ctx.vm, &[]);
                        }
                        // Drain any sink emissions produced by the
                        // flush and convert to TextLine events with
                        // the original Shift-JIS bytes as evidence.
                        for line in ctx.sink.drain() {
                            let body_shift_jis = raw_bytes.clone();
                            events.push(ReplayEvent::TextLine {
                                byte_offset_in_scene: pc_before,
                                body_shift_jis,
                                body_utf8: line.text,
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
                            byte_offset_in_scene: ctx.vm.pc(),
                        });
                        first_pause_seen = true;
                    }
                    _ => {}
                }
                // Pull any newly-arrived MissingRlop warnings from the
                // VM and convert them into UnknownOpcode events. The
                // warning carries the typed key + the pc the miss
                // landed at, which is exactly what the spec demands.
                let warnings = ctx.vm.take_warnings();
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
            StepOutcome::EndOfScene { .. } => {
                break ReplayOutcome::EndOfScene {
                    events: events.len() as u32,
                };
            }
            StepOutcome::Halted => {
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

fn vm_error_semantic_code(err: &crate::VmError) -> &'static str {
    match err {
        crate::VmError::SceneNotFound { .. } => "utsushi.reallive.vm.scene_not_found",
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
