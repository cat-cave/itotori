// Object-button bindings belong to the graphics runtime, not VM state.
// Historical note: `objButtonOpts` (`obj (1,{81,82},1064)`) recovers each
// selectable on-screen button (0-based `number` + button-group `group`)
// for a matching `select_objbtn` (`sel (0,2,4)`). Screen coordinates
// g00 refs come from separate `objSetPos` / `objOfFile` ops; the render
// layer uses decoded object-button geometry and art metadata.

impl Vm {
    /// Construct a VM positioned at `(scene, pc)` with empty banks
    /// stack / longop queue.
    pub fn new(scene: SceneId, pc: u32) -> Self {
        Self {
            scene,
            pc,
            stack: Vec::new(),
            banks: VarBanks::new(),
            longop_queue: VecDeque::new(),
            halted: false,
            warnings: Vec::new(),
            frame_counters: BTreeMap::new(),
            post_pc: 0,
            suppress_next_transfer: false,
            last_transfer_suppressed: false,
        }
    }

    /// Fold the FULL deterministic control state — active `(scene, pc)`
    /// the call-stack shape (each frame's return scene / pc / kind), the
    /// complete mutable memory ([`VarBanks::fingerprint`]), and the
    /// suspended-longop queue (length + each longop's id / private
    /// state) — into a 64-bit fingerprint.
    ///
    /// Two VMs sharing a `control_fingerprint` will, under the same store
    /// registry / (deterministic) scheduler, execute an IDENTICAL next
    /// step: stepping is a pure function of exactly this state. The
    /// branch-following driver uses the fingerprint to PROVE a spin — a
    /// walk that returns to an already-seen fingerprint is in a
    /// deterministic infinite loop (no clock / RNG can perturb it), which
    /// is the trigger for the driver's event-flag model.
    pub fn control_fingerprint(&self) -> u64 {
        const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
        const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;
        let mut hash = FNV_OFFSET;
        let mut fold = |bytes: &[u8]| {
            for byte in bytes {
                hash ^= u64::from(*byte);
                hash = hash.wrapping_mul(FNV_PRIME);
            }
        };
        fold(&self.scene.to_le_bytes());
        fold(&self.pc.to_le_bytes());
        fold(&(self.stack.len() as u64).to_le_bytes());
        for frame in &self.stack {
            fold(&frame.return_scene.unwrap_or(u16::MAX).to_le_bytes());
            fold(&frame.return_pc.to_le_bytes());
            fold(&[frame.frame_kind as u8]);
        }
        fold(&[u8::from(self.halted)]);
        // Combine with the memory fingerprint (already an FNV fold).
        fold(&self.banks.fingerprint().to_le_bytes());
        for (counter, frame) in &self.frame_counters {
            fold(&counter.to_le_bytes());
            fold(&frame.min.to_le_bytes());
            fold(&frame.max.to_le_bytes());
            fold(&frame.duration_ms.to_le_bytes());
            fold(&frame.elapsed_ms.to_le_bytes());
            fold(&[u8::from(frame.active)]);
        }
        // Fold the suspended-longop queue. `step()` polls the queue head
        // BEFORE fetching the next element, so the next step is a pure
        // function of the folded state ONLY when the queue's contents are
        // also captured. Folding the length plus each queued longop's
        // identity (`id`) and full private state means two genuinely
        // different queue states cannot collide — an evolving wait/event
        // longop (whose private state advances between polls) produces a
        // DISTINCT fingerprint each step, so the spin-break cannot
        // false-positive on it, while a truly stable pure-state repeat
        // still yields a repeated fingerprint.
        fold(&(self.longop_queue.len() as u64).to_le_bytes());
        for longop in &self.longop_queue {
            fold(&longop.id.0.to_le_bytes());
            fold(&(longop.private_state.len() as u64).to_le_bytes());
            fold(&longop.private_state);
        }
        hash
    }

    /// Request that the NEXT executed control-transfer command fall
    /// through to its post-command pc instead of transferring. See
    /// [`Self::suppress_next_transfer`]. One-shot: cleared as soon as a
    /// transfer consumes it (or the flag is explicitly reset).
    pub fn request_suppress_next_transfer(&mut self) {
        self.suppress_next_transfer = true;
    }

    /// Whether the most recent [`Vm::step`] rewrote a real control
    /// transfer into a fall-through because a
    /// [`Self::request_suppress_next_transfer`] was pending.
    pub fn last_transfer_suppressed(&self) -> bool {
        self.last_transfer_suppressed
    }

    /// Byte offset immediately past the command currently being
    /// dispatched. Only meaningful while an op's `dispatch` is executing
    /// (the branch-following `gosub` / `farcall` ops read it to obtain the
    /// return pc); `0` outside a dispatch.
    pub fn post_pc(&self) -> u32 {
        self.post_pc
    }

    /// Borrow the scene id the VM is currently positioned in.
    pub fn scene(&self) -> SceneId {
        self.scene
    }

    /// Borrow the pc the VM is currently positioned at.
    pub fn pc(&self) -> u32 {
        self.pc
    }

    /// Borrow the call stack. Used by tests and by the snapshot path.
    pub fn stack(&self) -> &[StackFrame] {
        &self.stack
    }

    /// Borrow the typed variable banks.
    pub fn banks(&self) -> &VarBanks {
        &self.banks
    }

    /// Borrow the typed variable banks mutably.
    pub fn banks_mut(&mut self) -> &mut VarBanks {
        &mut self.banks
    }

    /// Borrow the suspended-longop queue.
    pub fn longop_queue(&self) -> &VecDeque<LongOp> {
        &self.longop_queue
    }

    /// Whether the VM has observed a `DispatchOutcome::Halt`. While
    /// halted, `step` returns `StepOutcome::Halted` and does not
    /// advance the pc.
    pub fn is_halted(&self) -> bool {
        self.halted
    }

    /// Drain the accumulated fail-soft warnings. Callers wire this into
    /// their diagnostic sink at a cadence of their choosing.
    pub fn take_warnings(&mut self) -> Vec<VmWarning> {
        std::mem::take(&mut self.warnings)
    }

    /// Borrow the fail-soft warnings without draining.
    pub fn warnings(&self) -> &[VmWarning] {
        &self.warnings
    }

    /// Reset the halt flag. The caller drives this — the VM never
    /// silently un-halts itself.
    pub fn clear_halt(&mut self) {
        self.halted = false;
    }

    /// Append a fail-soft warning to the VM's diagnostic buffer.
    ///
    /// Per-module RLOperation tables (, …) use
    /// this to surface a typed observation (e.g. a malformed argument
    /// list) without panicking and without inventing a separate side
    /// channel. The warning is drained by [`Vm::take_warnings`] at the
    /// caller's cadence.
    pub fn push_warning(&mut self, warning: VmWarning) {
        self.warnings.push(warning);
    }

    /// Apply a [`DispatchOutcome`] against the VM, advancing to
    /// `post_pc` for [`DispatchOutcome::Advance`] / `Yield`. Exposed so
    /// per-module RLOperation tests can drive the same code path as
    /// the dispatch loop without staging a synthetic scene store —
    /// useful for the stack-overflow and frame-kind-mismatch
    /// acceptance tests.
    pub fn apply_dispatch_outcome(
        &mut self,
        outcome: &DispatchOutcome,
        post_pc: u32,
    ) -> Result<(), VmError> {
        self.apply_outcome(outcome, post_pc)
    }

    /// Apply typed selection resume: legacy A2 stores its chosen index, while
    /// durable A3 maps its selected display index to its persisted i32 return
    /// value. Pending, cancelled, malformed, and out-of-range A3 carriers
    /// warn without writing the store register.
    ///
    /// Exposed so per-module integration tests and the substrate
    /// runner can drive the same code path as [`Vm::step`] without
    /// staging a synthetic scene store.
    pub fn apply_choice_resume(&mut self, popped: &crate::rlop::LongOp) {
        match popped.private_state.first().copied() {
            Some(crate::rlop::SELECT_PRIVATE_STATE_MAGIC) => {
                match crate::rlop::SelectLongOp::try_from_longop(popped) {
                    Ok(select) => match select.chosen() {
                        Some(index) => self.banks.set_store(index as u32),
                        None => self.warnings.push(VmWarning::ChoiceResumeWithoutChoice {
                            longop_id: popped.id,
                        }),
                    },
                    Err(err) => self.warnings.push(VmWarning::ChoiceResumeMalformed {
                        longop_id: popped.id,
                        reason: err.to_string(),
                    }),
                }
            }
            Some(crate::rlop::OBJECT_SELECT_PRIVATE_STATE_MAGIC) => {
                match crate::rlop::ObjectSelectLongOp::try_from_longop(popped) {
                    Ok(select) => match select.outcome() {
                        crate::rlop::ObjectSelectOutcome::DisplayIndex(index) => {
                            match select.return_values().get(index as usize) {
                                Some(value) => self.banks.set_store(*value as u32),
                                None => {
                                    self.warnings.push(VmWarning::ObjectChoiceResumeOutOfRange {
                                        longop_id: popped.id,
                                        selected: index,
                                        choice_count: select.choice_count(),
                                    });
                                }
                            }
                        }
                        crate::rlop::ObjectSelectOutcome::Pending => {
                            self.warnings
                                .push(VmWarning::ObjectChoiceResumeWithoutChoice {
                                    longop_id: popped.id,
                                });
                        }
                        crate::rlop::ObjectSelectOutcome::Cancelled => {
                            self.banks.set_store((-1_i32) as u32);
                        }
                    },
                    Err(err) => self.warnings.push(VmWarning::ObjectChoiceResumeMalformed {
                        longop_id: popped.id,
                        reason: err.to_string(),
                    }),
                }
            }
            _ => {}
        }
    }

    /// Take a single fetch / decode / dispatch / advance step.
    ///
    /// The scheduler is consulted before fetching the next element so a
    /// queued longop can suspend the VM without making forward
    /// progress. Returns one of the typed [`StepOutcome`] variants.
    pub fn step(
        &mut self,
        scenes: &dyn SceneStore,
        registry: &RlopRegistry,
        scheduler: &mut dyn LongOpScheduler,
    ) -> Result<StepOutcome, VmError> {
        if self.halted {
            return Ok(StepOutcome::Halted);
        }
        // Reset the per-step "did we suppress a transfer" flag; the
        // Command-dispatch path sets it back to `true` iff this step
        // rewrites a control transfer into a fall-through.
        self.last_transfer_suppressed = false;
        // Longop queue: poll the head before fetching the next
        // element. A `Pending` reading suspends the VM; a `Ready`
        // reading pops the head and lets the next step resume the
        // normal dispatch.
        if let Some(head) = self.longop_queue.front_mut() {
            let head_id = head.id;
            match scheduler.poll(head) {
                LongOpReadiness::Pending => {
                    return Ok(StepOutcome::Suspended { longop_id: head_id });
                }
                LongOpReadiness::Ready => {
                    // SAFETY: front_mut returned Some so pop_front
                    // cannot fail. The expect documents the invariant.
                    let popped = self
                        .longop_queue
                        .pop_front()
                        .expect("front_mut returned Some, pop_front must succeed");
                    // typed resume side-effect. If the
                    // popped longop carries a SelectLongOp payload
                    // (magic byte = SELECT_PRIVATE_STATE_MAGIC), decode
                    // the chosen index and write it into the store
                    // register. The scheduler (e.g.
                    // [`ChoiceInputScheduler`]) is responsible for
                    // recording the chosen index into the head's
                    // private state before signalling Ready; this path
                    // is the substrate-coupled translation from
                    // "scheduler said Ready" to "VM observed a chosen
                    // index". The audit-focus pin for
                    // ("Longop coupling — the longop must use the
                    // substrate scheduler, not a private wait loop")
                    // lands here.
                    self.apply_choice_resume(&popped);
                    return Ok(StepOutcome::LongOpResumed { longop_id: head_id });
                }
            }
        }
        // Fetch + decode the current element.
        let scene = scenes
            .fetch(self.scene)
            .ok_or(VmError::SceneNotFound { scene: self.scene })?;
        if scene.is_past_end(self.pc) {
            return Ok(StepOutcome::EndOfScene { scene: self.scene });
        }
        let Some(element) = scene.element_at(self.pc) else {
            return Err(VmError::UnalignedPc {
                scene: self.scene,
                pc: self.pc,
                bytecode_len: scene.bytecode_len,
            });
        };
        // We clone the element so we can release the borrow on the
        // scene store before mutating self (the dispatch path may
        // mutate banks / stack / pc).
        let element = element.clone();
        let element_len =
            u32::try_from(element.byte_len()).map_err(|_| VmError::BytecodeDecode {
                scene: self.scene,
                pc: self.pc,
                reason: "element byte_len exceeds u32::MAX".to_string(),
            })?;
        let post_pc = self
            .pc
            .checked_add(element_len)
            .ok_or(VmError::BytecodeDecode {
                scene: self.scene,
                pc: self.pc,
                reason: "pc + element_len overflows u32".to_string(),
            })?;

        let event = self.dispatch_element(scenes, element, post_pc, registry)?;
        Ok(StepOutcome::Advanced { event })
    }

    /// Run [`Vm::step`] up to `max_steps` times. Returns one of the
    /// typed [`StepManyOutcome`] variants. Acceptance criterion #0 —
    /// a synthetic `goto +0` infinite loop produces
    /// [`StepManyOutcome::OutOfBudget`] (no panic, no infinite loop).
    pub fn step_many(
        &mut self,
        scenes: &dyn SceneStore,
        registry: &RlopRegistry,
        scheduler: &mut dyn LongOpScheduler,
        max_steps: u32,
    ) -> Result<StepManyOutcome, VmError> {
        let mut executed: u32 = 0;
        while executed < max_steps {
            let outcome = self.step(scenes, registry, scheduler)?;
            match &outcome {
                StepOutcome::Advanced { .. } | StepOutcome::LongOpResumed { .. } => {
                    executed = executed.saturating_add(1);
                }
                StepOutcome::Suspended { .. }
                | StepOutcome::EndOfScene { .. }
                | StepOutcome::Halted => {
                    return Ok(StepManyOutcome::Completed {
                        executed,
                        last: outcome,
                    });
                }
            }
        }
        Ok(StepManyOutcome::OutOfBudget { executed })
    }

}
