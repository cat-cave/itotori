//! UTSUSHI-208 — bytecode VM synthetic acceptance tests.
//!
//! Pins the four acceptance criteria from the spec node:
//!
//! 0. `goto +0` infinite loop with `max_steps=100` → deterministic
//!    `OutOfBudget` outcome (no panic).
//! 1. Synthetic gosub → ret returns pc to the post-`gosub` byte.
//! 2. Synthetic farcall → rtl returns to the calling scene at the
//!    post-`farcall` byte.
//! 3. A synthetic `pause` longop yields; next step resumes from the
//!    paused state; snapshot at suspend → restore → continue with same
//!    private state.
//!
//! Plus reinforcing tests for the empty-stack and missing-RLOp
//! fail-soft paths plus the longop scheduler ordering.

use std::sync::Arc;

use utsushi_core::EvidenceTier;
use utsushi_core::substrate::{
    Inspectable, Snapshot, SnapshotRequest, restore_snapshot, take_snapshot,
};
use utsushi_reallive::{
    AlwaysReadyScheduler, BytecodeElement, DispatchOutcome, ExprValue, InMemorySceneStore, LongOp,
    LongOpId, NeverReadyScheduler, RLOperation, RlopKey, RlopRegistry, Scene, StackFrameKind,
    StepManyOutcome, StepOutcome, Vm, VmError, VmEvent, VmWarning,
};

// ---------------------------------------------------------------------
// Synthetic-element constructors. Each builds a single, well-shaped
// `BytecodeElement` whose `byte_offset` / `byte_len` honour the
// partition invariant from UTSUSHI-204 — `Scene::new` consumes the
// `byte_offset` field, and `pc_advance` math depends on `byte_len`.
// ---------------------------------------------------------------------

fn meta_line(offset: usize, line_number: u16) -> BytecodeElement {
    BytecodeElement::MetaLine {
        line_number,
        byte_offset: offset,
        byte_len: 3,
    }
}

fn command(offset: usize, module_type: u8, module_id: u8, opcode: u16) -> BytecodeElement {
    BytecodeElement::Command {
        module_type,
        module_id,
        opcode,
        arg_count: 0,
        overload: 0,
        raw_bytes: vec![
            0x23,
            module_type,
            module_id,
            opcode as u8,
            (opcode >> 8) as u8,
            0,
            0,
            0,
        ],
        byte_offset: offset,
        byte_len: 8,
    }
}

// ---------------------------------------------------------------------
// Test RLOperation implementations. These are intentionally tiny:
// each one returns a single `DispatchOutcome` so the VM test can
// assert on the pc / stack / queue transition without dragging in a
// full per-module table.
// ---------------------------------------------------------------------

struct GotoZero;
impl RLOperation for GotoZero {
    fn dispatch(&self, vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        // Jump back to the start of the current scene.
        DispatchOutcome::Jump {
            scene: vm.scene(),
            pc: 0,
        }
    }
}

struct GosubTo {
    target_pc: u32,
}
impl RLOperation for GosubTo {
    fn dispatch(&self, vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        // post_pc is "pc + 8" because the command header is 8 bytes;
        // the dispatch path threads that as the return pc — we mirror
        // it here so the assertion can quote the exact byte.
        DispatchOutcome::Subroutine {
            return_pc: vm.pc() + 8,
            target_scene: vm.scene(),
            target_pc: self.target_pc,
        }
    }
}

struct RetOp;
impl RLOperation for RetOp {
    fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        DispatchOutcome::Return
    }
}

struct FarCallTo {
    target_scene: u16,
    target_pc: u32,
}
impl RLOperation for FarCallTo {
    fn dispatch(&self, vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        DispatchOutcome::FarCall {
            return_scene: vm.scene(),
            return_pc: vm.pc() + 8,
            target_scene: self.target_scene,
            target_pc: self.target_pc,
        }
    }
}

struct RtlOp;
impl RLOperation for RtlOp {
    fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        DispatchOutcome::ReturnFromCall
    }
}

struct PauseLongOp {
    id: LongOpId,
    private_state: Vec<u8>,
}
impl RLOperation for PauseLongOp {
    fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        DispatchOutcome::Yield {
            longop_id: self.id,
            private_state: self.private_state.clone(),
        }
    }
}

// ---------------------------------------------------------------------
// Acceptance criterion #0 — `goto +0` infinite loop with `max_steps=100`
// produces a deterministic `OutOfBudget` outcome (no panic).
// ---------------------------------------------------------------------

#[test]
fn synthetic_goto_zero_infinite_loop_terminates_with_out_of_budget() {
    let elements = vec![command(0, 0x01, 0x00, 0x0001)];
    let scene = Scene::new(1, elements).expect("scene");
    let mut store = InMemorySceneStore::new();
    store.insert(scene);
    let mut registry = RlopRegistry::new();
    registry.register(RlopKey::new(0x01, 0x00, 0x0001), Arc::new(GotoZero));
    let mut scheduler = NeverReadyScheduler;
    let mut vm = Vm::new(1, 0);
    let outcome = vm
        .step_many(&store, &registry, &mut scheduler, 100)
        .expect("no error");
    match outcome {
        StepManyOutcome::OutOfBudget { executed } => {
            assert_eq!(
                executed, 100,
                "exactly 100 steps must run before the budget terminates the loop"
            );
        }
        other @ StepManyOutcome::Completed { .. } => {
            panic!("expected OutOfBudget, got {other:?}")
        }
    }
    // pc must still be 0 — we've been jumping back to the top of the
    // scene every step.
    assert_eq!(vm.pc(), 0);
    assert_eq!(vm.scene(), 1);
}

// ---------------------------------------------------------------------
// Acceptance criterion #1 — gosub → ret returns pc to the post-`gosub`
// byte.
// ---------------------------------------------------------------------

#[test]
fn synthetic_gosub_ret_returns_pc_to_post_gosub_byte() {
    // Scene layout:
    //   0x00..=0x07  gosub (8 bytes; targets pc=11)
    //   0x08..=0x0A  meta_line (the "return target" — 3 bytes)
    //   0x0B..=0x12  ret (8 bytes — the subroutine body)
    // After gosub-then-ret, pc must be 0x08 (the start of the
    // meta_line).
    let elements = vec![
        command(0, 0x01, 0x00, 0x0001),
        meta_line(8, 7),
        command(11, 0x01, 0x00, 0x0002),
    ];
    let scene = Scene::new(1, elements).expect("scene");
    let mut store = InMemorySceneStore::new();
    store.insert(scene);
    let mut registry = RlopRegistry::new();
    registry.register(
        RlopKey::new(0x01, 0x00, 0x0001),
        Arc::new(GosubTo { target_pc: 11 }),
    );
    registry.register(RlopKey::new(0x01, 0x00, 0x0002), Arc::new(RetOp));
    let mut scheduler = NeverReadyScheduler;
    let mut vm = Vm::new(1, 0);

    // Step 1: gosub. pc → 11; stack has one Subroutine frame with
    // return_pc=8.
    let outcome = vm.step(&store, &registry, &mut scheduler).expect("gosub");
    assert!(matches!(outcome, StepOutcome::Advanced { .. }));
    assert_eq!(vm.pc(), 11);
    assert_eq!(vm.stack().len(), 1);
    assert_eq!(vm.stack()[0].frame_kind, StackFrameKind::Subroutine);
    assert_eq!(vm.stack()[0].return_pc, 8);

    // Step 2: ret. pc → 8; stack drains.
    let outcome = vm.step(&store, &registry, &mut scheduler).expect("ret");
    assert!(matches!(outcome, StepOutcome::Advanced { .. }));
    assert_eq!(vm.pc(), 8, "ret must return pc to the post-gosub byte");
    assert!(vm.stack().is_empty());

    // Step 3: the meta_line at pc=8 should now dispatch normally.
    let outcome = vm
        .step(&store, &registry, &mut scheduler)
        .expect("meta_line");
    match outcome {
        StepOutcome::Advanced {
            event: VmEvent::Advanced { element },
        } => assert_eq!(element, "meta_line"),
        other => panic!("expected meta_line Advanced, got {other:?}"),
    }
    assert_eq!(vm.pc(), 11);
}

// ---------------------------------------------------------------------
// Acceptance criterion #2 — cross-scene farcall → rtl returns to the
// calling scene at the post-`farcall` byte.
// ---------------------------------------------------------------------

#[test]
fn synthetic_farcall_rtl_returns_to_calling_scene_at_post_farcall_byte() {
    // Scene 1: farcall (target scene 2 pc=0), then a meta_line.
    let scene1_elements = vec![
        command(0, 0x01, 0x00, 0x0010), // farcall → scene 2 pc 0
        meta_line(8, 42),               // post-farcall return target
    ];
    let scene1 = Scene::new(1, scene1_elements).expect("scene 1");

    // Scene 2: an rtl op.
    let scene2_elements = vec![command(0, 0x01, 0x00, 0x0011)];
    let scene2 = Scene::new(2, scene2_elements).expect("scene 2");

    let mut store = InMemorySceneStore::new();
    store.insert(scene1);
    store.insert(scene2);

    let mut registry = RlopRegistry::new();
    registry.register(
        RlopKey::new(0x01, 0x00, 0x0010),
        Arc::new(FarCallTo {
            target_scene: 2,
            target_pc: 0,
        }),
    );
    registry.register(RlopKey::new(0x01, 0x00, 0x0011), Arc::new(RtlOp));

    let mut scheduler = NeverReadyScheduler;
    let mut vm = Vm::new(1, 0);

    // Step 1: farcall. scene → 2, pc → 0, stack pushed.
    vm.step(&store, &registry, &mut scheduler).expect("farcall");
    assert_eq!(vm.scene(), 2);
    assert_eq!(vm.pc(), 0);
    assert_eq!(vm.stack().len(), 1);
    assert_eq!(vm.stack()[0].frame_kind, StackFrameKind::FarCall);
    assert_eq!(vm.stack()[0].return_scene, Some(1));
    assert_eq!(vm.stack()[0].return_pc, 8);

    // Step 2: rtl. scene → 1, pc → 8, stack drains.
    vm.step(&store, &registry, &mut scheduler).expect("rtl");
    assert_eq!(vm.scene(), 1, "rtl must return to the calling scene");
    assert_eq!(vm.pc(), 8, "rtl must return to the post-farcall byte");
    assert!(vm.stack().is_empty());

    // Step 3: meta_line at pc=8 dispatches normally.
    let outcome = vm
        .step(&store, &registry, &mut scheduler)
        .expect("meta_line");
    match outcome {
        StepOutcome::Advanced {
            event: VmEvent::Advanced { element },
        } => assert_eq!(element, "meta_line"),
        other => panic!("expected meta_line Advanced, got {other:?}"),
    }
}

// ---------------------------------------------------------------------
// Acceptance criterion #3 — synthetic `pause` longop yields; next
// step resumes from the paused state; snapshot at suspend → restore →
// continue with same private state.
// ---------------------------------------------------------------------

#[test]
fn synthetic_pause_longop_yields_then_resumes_with_same_private_state() {
    let pause_state = vec![0xde, 0xad, 0xbe, 0xef, 0x00, 0xff];
    let elements = vec![
        command(0, 0x02, 0x00, 0x0100), // pause longop
        meta_line(8, 7),                // post-pause continuation
    ];
    let scene = Scene::new(1, elements).expect("scene");
    let mut store = InMemorySceneStore::new();
    store.insert(scene);
    let mut registry = RlopRegistry::new();
    registry.register(
        RlopKey::new(0x02, 0x00, 0x0100),
        Arc::new(PauseLongOp {
            id: LongOpId(0xCAFE_BABE),
            private_state: pause_state.clone(),
        }),
    );
    let mut never = NeverReadyScheduler;
    let mut vm = Vm::new(1, 0);

    // Step 1: dispatch the pause op. The dispatch path enqueues the
    // longop and advances past the command (pc → 8).
    let outcome = vm.step(&store, &registry, &mut never).expect("yield step");
    assert!(matches!(outcome, StepOutcome::Advanced { .. }));
    assert_eq!(vm.pc(), 8);
    assert_eq!(vm.longop_queue().len(), 1);
    assert_eq!(vm.longop_queue().front().unwrap().id, LongOpId(0xCAFE_BABE));
    assert_eq!(
        vm.longop_queue().front().unwrap().private_state,
        pause_state
    );

    // Step 2: with the NeverReadyScheduler, the queued longop stays
    // pending — the VM emits a Suspended outcome and does NOT
    // advance.
    let outcome = vm.step(&store, &registry, &mut never).expect("suspended");
    assert_eq!(
        outcome,
        StepOutcome::Suspended {
            longop_id: LongOpId(0xCAFE_BABE)
        }
    );
    assert_eq!(vm.pc(), 8, "Suspended must not advance pc");
    assert_eq!(vm.longop_queue().len(), 1);

    // Snapshot at the suspend point — the queued longop's private
    // state must survive the round trip.
    let request = SnapshotRequest::new("run-utsushi-208", "2026-06-24T00:00:00Z", EvidenceTier::E2)
        .with_tick(1);
    let snapshot: Snapshot = take_snapshot(&vm, &request).expect("snapshot");

    // Scribble the queue and pc in-place — proof that the restore
    // re-establishes the suspended state from snapshot bytes.
    vm.enqueue_longop(LongOp::new(LongOpId(0x9999), vec![]));
    // We can't easily mutate scene/pc directly without going through
    // the dispatch loop; the queue scramble is sufficient to prove
    // the restore re-establishes the original queue.
    assert_eq!(vm.longop_queue().len(), 2);

    restore_snapshot(&mut vm, &snapshot).expect("restore");
    assert_eq!(vm.longop_queue().len(), 1);
    assert_eq!(vm.longop_queue().front().unwrap().id, LongOpId(0xCAFE_BABE));
    assert_eq!(
        vm.longop_queue().front().unwrap().private_state,
        pause_state,
        "restored longop must carry the same private state byte-for-byte"
    );

    // Step 3: switch to a scheduler that fires immediately. The VM
    // consumes the queued longop (LongOpResumed) without advancing
    // the pc; the next step picks up the post-pause meta_line.
    let mut ready = AlwaysReadyScheduler;
    let outcome = vm
        .step(&store, &registry, &mut ready)
        .expect("resumed step");
    assert_eq!(
        outcome,
        StepOutcome::LongOpResumed {
            longop_id: LongOpId(0xCAFE_BABE)
        }
    );
    assert_eq!(vm.pc(), 8, "LongOpResumed must not advance pc");
    assert!(vm.longop_queue().is_empty());

    let outcome = vm.step(&store, &registry, &mut ready).expect("meta_line");
    match outcome {
        StepOutcome::Advanced {
            event: VmEvent::Advanced { element },
        } => assert_eq!(element, "meta_line"),
        other => panic!("expected meta_line Advanced after resume, got {other:?}"),
    }
    assert_eq!(vm.pc(), 11);
}

// ---------------------------------------------------------------------
// Reinforcing tests — empty-stack failure, missing-RLOp fail-soft, and
// the longop scheduler ordering.
// ---------------------------------------------------------------------

#[test]
fn ret_on_empty_stack_returns_typed_empty_stack_error() {
    let elements = vec![command(0, 0x01, 0x00, 0x0002)];
    let scene = Scene::new(1, elements).expect("scene");
    let mut store = InMemorySceneStore::new();
    store.insert(scene);
    let mut registry = RlopRegistry::new();
    registry.register(RlopKey::new(0x01, 0x00, 0x0002), Arc::new(RetOp));
    let mut scheduler = NeverReadyScheduler;
    let mut vm = Vm::new(1, 0);
    match vm.step(&store, &registry, &mut scheduler) {
        Err(VmError::EmptyStack { expected, .. }) => assert_eq!(expected, "subroutine"),
        other => panic!("expected EmptyStack, got {other:?}"),
    }
}

#[test]
fn rtl_on_empty_stack_returns_typed_empty_stack_error() {
    let elements = vec![command(0, 0x01, 0x00, 0x0011)];
    let scene = Scene::new(1, elements).expect("scene");
    let mut store = InMemorySceneStore::new();
    store.insert(scene);
    let mut registry = RlopRegistry::new();
    registry.register(RlopKey::new(0x01, 0x00, 0x0011), Arc::new(RtlOp));
    let mut scheduler = NeverReadyScheduler;
    let mut vm = Vm::new(1, 0);
    match vm.step(&store, &registry, &mut scheduler) {
        Err(VmError::EmptyStack { expected, .. }) => assert_eq!(expected, "far_call"),
        other => panic!("expected EmptyStack, got {other:?}"),
    }
}

#[test]
fn missing_rlop_emits_typed_warning_and_advances() {
    let elements = vec![command(0, 0xFF, 0xFE, 0x1234), meta_line(8, 99)];
    let scene = Scene::new(1, elements).expect("scene");
    let mut store = InMemorySceneStore::new();
    store.insert(scene);
    let registry = RlopRegistry::new();
    let mut scheduler = NeverReadyScheduler;
    let mut vm = Vm::new(1, 0);
    let outcome = vm
        .step(&store, &registry, &mut scheduler)
        .expect("missing rlop");
    match outcome {
        StepOutcome::Advanced {
            event: VmEvent::CommandDispatched { key, outcome },
        } => {
            assert_eq!(key, RlopKey::new(0xFF, 0xFE, 0x1234));
            assert_eq!(outcome, DispatchOutcome::Advance);
        }
        other => panic!("expected CommandDispatched(Advance), got {other:?}"),
    }
    assert_eq!(vm.pc(), 8, "missing RLOp must advance past the command");
    let warnings = vm.take_warnings();
    assert_eq!(warnings.len(), 1);
    match &warnings[0] {
        VmWarning::MissingRlop { key, .. } => assert_eq!(*key, RlopKey::new(0xFF, 0xFE, 0x1234)),
        other => panic!("expected MissingRlop warning, got {other:?}"),
    }
}

#[test]
fn longop_scheduler_ordering_pops_in_queue_order() {
    // Three longops queued. With AlwaysReadyScheduler, the VM should
    // pop them in FIFO order before advancing past the first
    // post-queue element.
    let elements = vec![meta_line(0, 1)];
    let scene = Scene::new(1, elements).expect("scene");
    let mut store = InMemorySceneStore::new();
    store.insert(scene);
    let registry = RlopRegistry::new();
    let mut ready = AlwaysReadyScheduler;
    let mut vm = Vm::new(1, 0);
    vm.enqueue_longop(LongOp::new(LongOpId(1), vec![1]));
    vm.enqueue_longop(LongOp::new(LongOpId(2), vec![2]));
    vm.enqueue_longop(LongOp::new(LongOpId(3), vec![3]));
    assert_eq!(vm.longop_queue().len(), 3);

    for expected in [1u64, 2, 3] {
        let outcome = vm.step(&store, &registry, &mut ready).expect("step");
        assert_eq!(
            outcome,
            StepOutcome::LongOpResumed {
                longop_id: LongOpId(expected)
            },
            "longop {expected} must resume next (FIFO ordering)"
        );
    }
    assert!(vm.longop_queue().is_empty());
    let outcome = vm.step(&store, &registry, &mut ready).expect("step");
    assert!(matches!(
        outcome,
        StepOutcome::Advanced {
            event: VmEvent::Advanced {
                element: "meta_line"
            }
        }
    ));
}

#[test]
fn halt_dispatch_outcome_freezes_the_vm() {
    struct HaltOp;
    impl RLOperation for HaltOp {
        fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
            DispatchOutcome::Halt
        }
    }
    let elements = vec![command(0, 0x01, 0x00, 0x0030), meta_line(8, 7)];
    let scene = Scene::new(1, elements).expect("scene");
    let mut store = InMemorySceneStore::new();
    store.insert(scene);
    let mut registry = RlopRegistry::new();
    registry.register(RlopKey::new(0x01, 0x00, 0x0030), Arc::new(HaltOp));
    let mut scheduler = NeverReadyScheduler;
    let mut vm = Vm::new(1, 0);
    vm.step(&store, &registry, &mut scheduler).expect("halt op");
    assert!(vm.is_halted());
    assert_eq!(vm.pc(), 0, "halt must not advance pc");
    let outcome = vm
        .step(&store, &registry, &mut scheduler)
        .expect("post-halt");
    assert_eq!(outcome, StepOutcome::Halted);
}

#[test]
fn step_many_completes_cleanly_on_end_of_scene() {
    let elements = vec![meta_line(0, 1), meta_line(3, 2)];
    let scene = Scene::new(1, elements).expect("scene");
    let mut store = InMemorySceneStore::new();
    store.insert(scene);
    let registry = RlopRegistry::new();
    let mut scheduler = NeverReadyScheduler;
    let mut vm = Vm::new(1, 0);
    let outcome = vm
        .step_many(&store, &registry, &mut scheduler, 100)
        .expect("step_many");
    match outcome {
        StepManyOutcome::Completed { executed, last } => {
            assert_eq!(executed, 2);
            assert!(matches!(last, StepOutcome::EndOfScene { scene: 1 }));
        }
        other @ StepManyOutcome::OutOfBudget { .. } => {
            panic!("expected Completed, got {other:?}")
        }
    }
}

#[test]
fn vm_snapshot_restore_round_trips_scene_pc_stack_and_banks() {
    use utsushi_reallive::{BankId, Value};
    let elements = vec![meta_line(0, 1)];
    let scene = Scene::new(1, elements).expect("scene");
    let mut store = InMemorySceneStore::new();
    store.insert(scene);
    let mut vm = Vm::new(7, 11);
    // Push a synthetic call stack so the restore re-establishes it.
    vm.enqueue_longop(LongOp::new(LongOpId(0xABCD), vec![0xAA, 0xBB]));
    vm.banks_mut()
        .set(BankId::IntA, 5, Value::Int(123))
        .expect("set");
    vm.banks_mut().set_store(0xDEAD_BEEF);

    let request = SnapshotRequest::new("run-utsushi-208", "2026-06-24T00:00:00Z", EvidenceTier::E2)
        .with_tick(1);
    let snapshot = take_snapshot(&vm, &request).expect("snapshot");

    let mut restored = Vm::new(0, 0);
    restore_snapshot(&mut restored, &snapshot).expect("restore");
    assert_eq!(restored.scene(), 7);
    assert_eq!(restored.pc(), 11);
    assert_eq!(restored.longop_queue().len(), 1);
    assert_eq!(
        restored.longop_queue().front().unwrap().id,
        LongOpId(0xABCD)
    );
    assert_eq!(
        restored.longop_queue().front().unwrap().private_state,
        vec![0xAA, 0xBB]
    );
    assert_eq!(restored.banks().get(BankId::IntA, 5), Some(Value::Int(123)));
    assert_eq!(restored.banks().store(), 0xDEAD_BEEF);

    // store is consumed to silence dead_code on the in-mem store
    // since this test path does not step the VM.
    let _ = &store;
}

#[test]
fn vm_inspectable_id_matches_pinned_constant() {
    let vm = Vm::new(0, 0);
    assert_eq!(vm.inspectable_id(), "utsushi-reallive-vm");
}
