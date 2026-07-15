use super::*;

impl ReplayEngine {
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
    ///    that farcalls into dialogue surfaces its whole executed text
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
    /// 2. **Linear-catalogue** (every command of the scene in byte order
    ///    single pass) is the WORKAROUND for titles whose real dialogue is
    ///    gated behind a menu/選択 the headless input-provider cannot walk
    ///    into (e.g. Kanon's `#SEEN_START` title scene branch-follows into
    ///    a spin before any message). The byte-order catalogue surfaces
    ///    each message ONCE, so it is still a faithful single-pass stream —
    ///    it supplies `play_order_lines` when the branch pass reached no
    ///    dialogue, OR when the branch pass exhausted its budget with strong
    ///    text repetition (`branch_lines_show_spin`) while the linear pass
    ///    reached a natural terminus and has dialogue. It is NEVER added to
    ///    the branch stream (that union was the ~2× inflation defect).
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
        let branch_prompts = branch_pass.selection_prompts;
        let branch_termination = branch_pass.termination;
        let branch = branch_pass.scene;
        let branch_lines = branch_sink.take_lines();

        // Pass 2: linear byte-order catalogue. Capture its text SEPARATELY
        // (single pass) so it can serve as the play-order fallback; it is
        // used for graphics/audio backfill regardless.
        let linear_sink: Arc<ReplayTextSink> = Arc::new(ReplayTextSink::default());
        let mut linear_scheduler = AlwaysReadyScheduler;
        let linear_pass = self.observe_pass(
            scene_id,
            opts,
            ControlFlowMount::LinearWalk,
            Arc::clone(&linear_sink) as Arc<dyn TextSurfaceSink>,
            &mut linear_scheduler,
        );
        let linear_prompts = linear_pass.selection_prompts;
        let linear_termination = linear_pass.termination;
        let linear = linear_pass.scene;
        let linear_lines = linear_sink.take_lines();

        // Choose the play order: retain branch unless it reached no dialogue
        // or it SPUN while a nonempty linear pass reached a natural terminus;
        // then use the single-pass byte-order catalogue. Prompts follow that
        // exact same choice: they identify the text lines in their own pass
        // never a cross-pass mixture. NEVER combine passes (no doubling).
        let (play_order_lines, selection_prompts) = select_port_pass(
            branch_lines,
            branch_prompts,
            branch_termination,
            linear_lines,
            linear_prompts,
            linear_termination,
        );

        let mut audio_events = branch.audio_events;
        audio_events.extend(linear.audio_events);
        let graphics_stack = if branch.graphics_stack.is_empty() {
            linear.graphics_stack
        } else {
            branch.graphics_stack
        };
        PortObservation {
            play_order_lines,
            selection_prompts,
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
    /// [`Self::observe_for_port`] (its own single-pass play-order messages
    /// its own composited background / audio). The next scene is the FIRST
    /// cross-scene dispatch target that scene's branch-following walk followed
    /// ([`PortObservation::first_cross_scene`] — a real `jump` / `farcall`
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
    /// the audio + graphics runtimes), drive `scene_id` with `scheduler`
    /// dispatching every Shift-JIS `Textout` into `text_sink`. Also reports
    /// the first cross-scene dispatch target the pass followed (only the
    /// branch-following mount can leave the start scene), so the play-loop
    /// can chain into the next scene.
    pub(super) fn observe_pass(
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
        let mut first_cross_scene: Option<SceneId> = None;
        let termination = loop {
            if steps >= opts.step_budget {
                break PassTermination::BudgetExhausted;
            }
            let pc_before = vm.pc();
            let scene_before = vm.scene();
            let Ok(step) = vm.step(&self.store, &handles.registry, scheduler) else {
                break PassTermination::VmError;
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
                        dispatch_textout_at(&runtime, pc_before, raw_bytes);
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
                    break PassTermination::NaturalTerminus;
                }
                StepOutcome::Suspended { .. } => break PassTermination::Suspended,
            }
            // Drain warnings so the VM's buffer does not grow unbounded.
            let _ = vm.take_warnings();
        };
        let audio_events = handles.audio.emitter().store().drain_in_order();
        let graphics_stack = handles.graphics.state_snapshot().stack;
        PassObservation {
            scene: SceneObservation {
                audio_events,
                graphics_stack,
                steps,
                reached_natural_terminus: termination == PassTermination::NaturalTerminus,
            },
            first_cross_scene,
            selection_prompts: handles.selection.take_prompts(),
            termination,
        }
    }

    /// Snapshot/restore identity at every tick boundary while driving
    /// `scene_id` to its terminus with the BRANCH-FOLLOWING registry
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
