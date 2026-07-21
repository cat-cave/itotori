use super::*;

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

/// Drive `vm` against `store`/`registry` to its terminus with `scheduler`
/// asserting the substrate snapshot round-trips byte-identically at every
/// tick boundary. Shared by the cataloguing snapshot-identity checks (with
/// [`AlwaysReadyScheduler`]) and the branch-following one (with
/// [`HeadlessInputScheduler`]).
pub(super) fn snapshot_identity_loop(
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

pub(super) fn drive_loop(
    vm: &mut Vm,
    refs: &DriveRefs<'_>,
    opts: &ReplayOpts,
    scene_id: u16,
) -> ReplayLog {
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
                        dispatch_textout_at(refs.runtime, pc_before, &raw_bytes);
                        // Flush immediately via OPCODE_LINE_BREAK so
                        // each Shift-JIS run surfaces as a distinct
                        // TextLine before any control opcode lands.
                        // Mirrors the real-bytes test
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
                    VmEvent::CommandDispatched { key, outcome, .. }
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
                // AlwaysReadyScheduler should never produce Suspended
                // but if it ever does (e.g. a future scheduler swap)
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

pub(super) fn vm_error_semantic_code(err: &crate::VmError) -> &'static str {
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

pub(super) fn snapshot_vm(vm: &Vm) -> Result<Snapshot, ReplayError> {
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
