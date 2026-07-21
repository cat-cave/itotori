use super::*;

// Multi-scene store construction lives in `crate::scene_store`; re-export
// so the `replay` module public API is unchanged.
pub use crate::scene_store::{
    DecompressedScene, SceneStoreBundle, SceneStoreStats, build_scene_store,
    build_scene_store_from_decompressed, decompress_all_scenes,
};

pub(super) fn mount_full_registry(
    sink: Arc<dyn TextSurfaceSink>,
    msg_runtime: Arc<MsgRuntime>,
) -> RlopRegistry {
    mount_registry(sink, msg_runtime, ControlFlowMount::LinearWalk)
}

/// Mount all nine opcode families, choosing the
/// `module_jmp` control-flow registrar per `control_flow`. Shared by the
/// cataloguing ([`ControlFlowMount::LinearWalk`]) and branch-following
/// ([`ControlFlowMount::BranchFollowing`]) replay paths so every OTHER
/// family (text/grp/obj/audio/sel/sys/mem/str) is identical between them.
pub(super) fn mount_registry(
    sink: Arc<dyn TextSurfaceSink>,
    msg_runtime: Arc<MsgRuntime>,
    control_flow: ControlFlowMount,
) -> RlopRegistry {
    mount_registry_handles(sink, msg_runtime, control_flow).registry
}

/// Mount all nine opcode families, returning the
/// registry ALONGSIDE the shared audio + graphics runtimes. Single source
/// of truth for the registry composition: [`mount_registry`] delegates
/// here and drops the handles, so the cataloguing / branch-following
/// engine-port paths all mount byte-identical op tables.
pub(super) fn mount_registry_handles(
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

    // Graphics: the REAL-numbered render family (module_grp DCs
    // backgrounds, object creation/setters/management) all share one
    // GraphicsRuntime. Registered under all three lattice types so it
    // fires on real bytes regardless of the compiler's module_type
    // artifact.
    let graphics_runtime = Arc::new(GraphicsRuntime::new());
    register_render_rlops(&mut registry, Arc::clone(&graphics_runtime));

    // Audio.
    let audio_emitter = Arc::new(AudioEventEmitter::new());
    let audio_runtime = Arc::new(AudioRuntime::new(audio_emitter));
    register_audio_rlops(&mut registry, Arc::clone(&audio_runtime));

    // Selection (choices). Backed by the same text sink so choice lines
    // surface through the substrate text surface.
    let sel_runtime = Arc::new(SelRuntime::with_graphics(
        Arc::clone(&sink),
        Arc::clone(&graphics_runtime),
    ));
    register_sel_rlops(&mut registry, Arc::clone(&sel_runtime));

    // System (fixed-seed clock/RNG → deterministic replay).
    let sys_runtime = Arc::new(SysRuntime::new(LogicalClockTick(0)));
    register_sys_rlops(&mut registry, sys_runtime);

    // Memory (no runtime).
    register_mem_rlops(&mut registry);

    // String ops.
    let str_runtime = Arc::new(StrRuntime::new(sink));
    register_str_rlops(&mut registry, str_runtime);

    RegistryHandles {
        registry,
        audio: audio_runtime,
        graphics: graphics_runtime,
        selection: sel_runtime,
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
pub(super) fn stage_replay_context(
    seen_bytes: &[u8],
    scene_id: u16,
) -> Result<ReplayContext, ReplayError> {
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
