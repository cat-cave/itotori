use super::*;

impl ReplayEngine {
    /// Land the runtime at `(scene, pc)` positionally (no execution drive) and
    /// report the deterministic landing. Shared by the scene / line seek arms
    /// of [`Self::jump_to`]. A `(scene, pc)` seek is reproducible by
    /// construction: the fresh VM at that position always folds to the same
    /// [`Vm::control_fingerprint`].
    pub(super) fn seek_position(
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
    /// play-order: the real branch-following pass when it reaches dialogue
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
    pub(super) fn drive_to_frame(
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
            // Branch reached NO dialogue: fall through to the linear catalogue
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

    /// Drive ONE play-order pass (`control_flow`) from `scene_id`'s start
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
                        dispatch_textout_at(&runtime, pc_before, raw_bytes);
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
}
