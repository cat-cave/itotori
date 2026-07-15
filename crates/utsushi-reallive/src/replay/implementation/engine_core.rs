use super::*;

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
    /// [`crate::input_bridge::BridgeScheduler`] driven by a headless / user
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
    /// - **Positional seek** ([`JumpTarget::Scene`](crate::JumpTarget::Scene)
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
}
