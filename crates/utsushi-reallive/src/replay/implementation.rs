use super::*;

mod branch_driver;
mod canonical;
mod driver;
mod engine_core;
mod engine_frames;
mod engine_observe;
mod registry;
#[cfg(test)]
mod tests;

pub use driver::{
    SnapshotIdentityReport, replay_scene, replay_scene_bytes, replay_until_first_pause,
    restore_into_fresh_vm, verify_snapshot_restore_each_tick,
};
pub use registry::{
    DecompressedScene, SceneStoreBundle, SceneStoreStats, build_scene_store,
    build_scene_store_from_decompressed, decompress_all_scenes, full_registry_rlop_count,
};

use branch_driver::drive_branch_following;
use driver::{drive_loop, snapshot_identity_loop, vm_error_semantic_code};
use registry::{
    dispatch_cosmetic_line_break, mount_full_registry, mount_registry, mount_registry_handles,
    stage_replay_context,
};

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

/// Mount ALL NINE opcode-module registrars onto a fresh registry.
///
/// This is the acceptance-criterion-#1 surface: `rg -n
/// 'register_.*_rlops' src/replay.rs` shows all families
/// (`register_text_rlops`, `register_control_flow_rlops`
/// `register_render_rlops`, `register_audio_rlops`
/// `register_sel_rlops`, `register_sys_rlops`, `register_mem_rlops`
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
    selection: Arc<SelRuntime>,
}

/// A reusable replay engine over ONE multi-scene store: decompress
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
