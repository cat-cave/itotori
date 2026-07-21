use super::*;

/// Drive `vm` to its natural terminus by FOLLOWING real control flow
/// using `scheduler` (a deterministic headless input-provider) to advance
/// past pause/wait yields and resolve choices. Records the executed
/// control-transfer counts + terminus into a [`BranchReplayReport`].
pub(super) fn drive_branch_following(
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
                        dispatch_textout_at(refs.runtime, pc_before, raw_bytes);
                        if let Some(op) = refs.registry.get(RlopKey::new(
                            MSG_MODULE_TYPE,
                            MSG_MODULE_ID,
                            OPCODE_LINE_BREAK,
                        )) {
                            let _ = op.dispatch(vm, &[]);
                        }
                        text_lines += refs.sink.drain().len();
                    }
                    VmEvent::CommandDispatched { key, outcome, .. } if key.module_id == 1 => {
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
