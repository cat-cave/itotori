use super::*;
#[rustfmt::skip]
use super::substrate::{MANIFEST_PATH, VM_MANIFEST, bytes_to_hex, hex_to_bytes};
use crate::bytecode_element::decode_bytecode_stream;
use crate::rlop::NeverReadyScheduler;
use utsushi_core::substrate::{Inspectable, Restorable, StatePath, StateValue};

fn build_scene(id: SceneId, bytes: &[u8]) -> Scene {
    let elements = decode_bytecode_stream(bytes).expect("decode test scene");
    Scene::new(id, elements).expect("non-empty scene")
}

/// Encode an int-literal expression value (`$ FF <i32 LE>`).
fn int_literal_bytes(value: i32) -> Vec<u8> {
    let mut b = vec![0x24, 0xFF];
    b.extend_from_slice(&value.to_le_bytes());
    b
}

/// Encode a single `goto(target_pc)` command (module 0/1, opcode 0).
/// Real `goto` framing per rlvm `bytecode.cc`: the 8-byte header is
/// followed by ONE trailing `i32 LE` jump-target pointer — NOT a
/// `(...)` argument list. The decoder frames the pointer into
/// `Command::goto_targets`; the VM appends it as the sole `Int` arg
/// so `GotoOp` jumps to it.
fn goto_command(target_pc: i32) -> Vec<u8> {
    let mut b = vec![0x23, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00];
    b.extend_from_slice(&target_pc.to_le_bytes());
    b
}

/// Encode a `farcall(return_scene, return_pc, target_scene
/// target_pc)` command (module 0/1, opcode 0x0020) with four
/// int-literal arguments.
fn farcall_command(rs: i32, rp: i32, ts: i32, tp: i32) -> Vec<u8> {
    let mut b = vec![0x23, 0x00, 0x01, 0x20, 0x00, 0x04, 0x00, 0x00, b'('];
    for (idx, value) in [rs, rp, ts, tp].iter().enumerate() {
        if idx > 0 {
            b.push(b',');
        }
        b.extend_from_slice(&int_literal_bytes(*value));
    }
    b.push(b')');
    b
}

#[test]
fn scene_entrypoint_pc_resolves_markers_and_defaults_zero() {
    // A goto (12 bytes) at offset 0, then a MetaEntrypoint `!4` marker
    // (`0x21 <idx u16>`) at offset 12.
    let mut bytes = goto_command(12);
    bytes.extend_from_slice(&[0x21, 0x04, 0x00]);
    let scene = build_scene(1, &bytes);
    // Non-zero entrypoint resolves through the marker map.
    assert_eq!(scene.entrypoint_pc(4), Some(12));
    // Entrypoint 0 defaults to the scene start even with no marker.
    assert_eq!(scene.entrypoint_pc(0), Some(0));
    // An undeclared entrypoint is None (VM surfaces EntrypointNotFound).
    assert_eq!(scene.entrypoint_pc(9), None);
}

#[test]
fn cross_scene_sentinels_fall_through_but_real_gaps_surface() {
    // Scene 7 present: a `goto` (12 bytes) then a MetaEntrypoint `!5`
    // marker at offset 12 — so entrypoints 0 (start) and 5 resolve.
    let mut store = InMemorySceneStore::new();
    let mut bytes = goto_command(12);
    bytes.extend_from_slice(&[0x21, 0x05, 0x00]);
    store.insert(build_scene(7, &bytes));
    let vm = Vm::new(7, 0);

    // Null-scene sentinel (scene 0): a farcall / jump to it is the
    // game's guarded "nothing to call" path — resolves to a
    // fall-through Advance, NOT a transfer, NOT a SceneNotFound.
    for outcome in [
        DispatchOutcome::FarCallToScene {
            target_scene: NULL_SCENE_SENTINEL,
            entrypoint: 10,
        },
        DispatchOutcome::JumpToScene {
            target_scene: NULL_SCENE_SENTINEL,
            entrypoint: 0,
        },
    ] {
        assert_eq!(
            vm.resolve_scene_outcome(&store, &outcome, 99).unwrap(),
            DispatchOutcome::Advance,
        );
    }

    // Scenario-return entrypoint 99 of a PRESENT scene: the end idiom —
    // falls through rather than surfacing EntrypointNotFound.
    assert_eq!(
        vm.resolve_scene_outcome(
            &store,
            &DispatchOutcome::FarCallToScene {
                target_scene: 7,
                entrypoint: SCENARIO_RETURN_ENTRYPOINT,
            },
            99,
        )
        .unwrap(),
        DispatchOutcome::Advance,
    );

    // A genuinely-taken transfer to an ABSENT (non-sentinel) scene
    // STILL surfaces a typed SceneNotFound — real gaps are not masked.
    assert!(matches!(
        vm.resolve_scene_outcome(
            &store,
            &DispatchOutcome::FarCallToScene {
                target_scene: 5,
                entrypoint: 0,
            },
            99,
        ),
        Err(VmError::SceneNotFound { scene: 5 }),
    ));

    // A present scene with a MISSING non-sentinel entrypoint STILL
    // surfaces EntrypointNotFound.
    assert!(matches!(
        vm.resolve_scene_outcome(
            &store,
            &DispatchOutcome::JumpToScene {
                target_scene: 7,
                entrypoint: 8,
            },
            99,
        ),
        Err(VmError::EntrypointNotFound {
            scene: 7,
            entrypoint: 8
        }),
    ));
}

#[test]
fn step_dispatches_goto_with_real_args_and_jumps_to_target() {
    // Regression (audit-3): the integration dispatch path passed
    // `op.dispatch(self, &[])`, so `goto` got an empty arg slice and
    // fell through (warn-and-advance) instead of jumping. With the
    // real-arg wiring the decoded target must take effect: stepping a
    // `goto 100` command (which itself occupies bytes 0..16) must
    // move pc to 100, NOT to the linear post-command byte 16.
    let mut store = InMemorySceneStore::new();
    store.insert(build_scene(1, &goto_command(100)));
    let mut registry = RlopRegistry::new();
    crate::rlop::module_ctrl::register_control_flow_rlops(&mut registry);
    let mut scheduler = NeverReadyScheduler;
    let mut vm = Vm::new(1, 0);

    let outcome = vm.step(&store, &registry, &mut scheduler).expect("step");
    assert!(matches!(
        outcome,
        StepOutcome::Advanced {
            event: VmEvent::CommandDispatched { .. }
        }
    ));
    assert_eq!(
        vm.pc(),
        100,
        "goto must jump to its decoded target, not fall through to post_pc"
    );
    assert_ne!(vm.pc(), 16, "pc must NOT be the linear post-command byte");
    assert!(
        vm.warnings().is_empty(),
        "goto with a valid int arg must not warn: {:?}",
        vm.warnings()
    );
}

#[test]
fn step_dispatches_farcall_with_real_args_and_pushes_frame() {
    // Companion control-flow proof: `farcall` needs four decoded args
    // (return_scene, return_pc, target_scene, target_pc). With the
    // empty-slice bug it warn-and-advanced; now it must cross to the
    // target scene/pc and push a far-call frame.
    let mut store = InMemorySceneStore::new();
    store.insert(build_scene(1, &farcall_command(1, 37, 2, 50)));
    let mut registry = RlopRegistry::new();
    crate::rlop::module_ctrl::register_control_flow_rlops(&mut registry);
    let mut scheduler = NeverReadyScheduler;
    let mut vm = Vm::new(1, 0);

    vm.step(&store, &registry, &mut scheduler).expect("step");
    assert_eq!(vm.scene(), 2, "farcall must cross to the target scene");
    assert_eq!(vm.pc(), 50, "farcall must land on the target pc");
    assert_eq!(vm.stack().len(), 1, "farcall must push exactly one frame");
    assert!(
        vm.warnings().is_empty(),
        "farcall with valid int args must not warn: {:?}",
        vm.warnings()
    );
}

#[test]
fn new_vm_has_empty_stack_and_queue() {
    let vm = Vm::new(1, 0);
    assert_eq!(vm.scene(), 1);
    assert_eq!(vm.pc(), 0);
    assert!(vm.stack().is_empty());
    assert!(vm.longop_queue().is_empty());
    assert!(!vm.is_halted());
}

#[test]
fn step_on_meta_line_advances_pc_by_three_bytes() {
    // 0x0A 0x07 0x00 = MetaLine(line_number=7), 3 bytes.
    let bytes = [0x0A, 0x07, 0x00];
    let scene = build_scene(1, &bytes);
    let mut store = InMemorySceneStore::new();
    store.insert(scene);
    let registry = RlopRegistry::new();
    let mut scheduler = NeverReadyScheduler;
    let mut vm = Vm::new(1, 0);
    let outcome = vm.step(&store, &registry, &mut scheduler).expect("step");
    match outcome {
        StepOutcome::Advanced {
            event: VmEvent::Advanced { element },
        } => assert_eq!(element, "meta_line"),
        other => panic!("expected Advanced(meta_line), got {other:?}"),
    }
    assert_eq!(vm.pc(), 3);
}

#[test]
fn end_of_scene_outcome_does_not_panic() {
    let bytes = [0x0A, 0x07, 0x00];
    let scene = build_scene(1, &bytes);
    let mut store = InMemorySceneStore::new();
    store.insert(scene);
    let registry = RlopRegistry::new();
    let mut scheduler = NeverReadyScheduler;
    let mut vm = Vm::new(1, 0);
    let _first = vm.step(&store, &registry, &mut scheduler).expect("step 1");
    let second = vm.step(&store, &registry, &mut scheduler).expect("step 2");
    assert!(matches!(second, StepOutcome::EndOfScene { scene: 1 }));
}

#[test]
fn unaligned_pc_returns_typed_error() {
    // 3-byte MetaLine — a pc of 1 lands in the middle of it.
    let bytes = [0x0A, 0x07, 0x00];
    let scene = build_scene(1, &bytes);
    let mut store = InMemorySceneStore::new();
    store.insert(scene);
    let registry = RlopRegistry::new();
    let mut scheduler = NeverReadyScheduler;
    let mut vm = Vm::new(1, 1);
    match vm.step(&store, &registry, &mut scheduler) {
        Err(VmError::UnalignedPc {
            scene: 1, pc: 1, ..
        }) => {}
        other => panic!("expected UnalignedPc, got {other:?}"),
    }
}

#[test]
fn missing_scene_returns_typed_error() {
    let store = InMemorySceneStore::new();
    let registry = RlopRegistry::new();
    let mut scheduler = NeverReadyScheduler;
    let mut vm = Vm::new(1, 0);
    match vm.step(&store, &registry, &mut scheduler) {
        Err(VmError::SceneNotFound { scene: 1 }) => {}
        other => panic!("expected SceneNotFound, got {other:?}"),
    }
}

#[test]
fn stack_frame_kind_round_trips_through_wire_form() {
    for kind in [StackFrameKind::Subroutine, StackFrameKind::FarCall] {
        assert_eq!(StackFrameKind::parse_wire(kind.as_str()), Some(kind));
    }
    assert!(StackFrameKind::parse_wire("nonsense").is_none());
}

#[test]
fn empty_vm_snapshots_with_substrate_inspectable() {
    let mut vm = Vm::new(0, 0);
    let v1 = LongOp::new(
        LongOpId(6),
        vec![0xA3, 1, 0xFF, 0xFF, 2, 0, 7, 0, 0, 0, 2, 0, 0, 0],
    );
    let v1_state = v1.private_state.clone();
    vm.enqueue_longop(v1);
    let mut v2 =
        crate::rlop::ObjectSelectLongOp::try_new(LongOpId(7), vec![7, 2]).expect("bounded");
    v2.set_cancelable(true);
    v2.cancel();
    let v2 = v2.into_longop();
    let v2_state = v2.private_state.clone();
    vm.enqueue_longop(v2);
    let tree = vm.inspect_state().expect("inspect");
    assert!(tree.len() >= 6); // manifest + scene + pc + halted + stack + longop + var-banks manifest + store
    let manifest_path = StatePath::parse(MANIFEST_PATH).expect("path");
    match tree.get(&manifest_path).expect("manifest entry") {
        StateValue::String { value } => assert_eq!(value, VM_MANIFEST),
        other => panic!("manifest must be a string, got {other:?}"),
    }
    let mut restored = Vm::new(0, 0);
    restored.restore_state(&tree).expect("restore");
    assert_eq!(restored.longop_queue()[0].private_state, v1_state);
    let v1 = crate::rlop::ObjectSelectLongOp::try_from_longop(&restored.longop_queue()[0])
        .expect("v1 carrier");
    assert_eq!(v1.flags(), 0);
    assert_eq!(v1.outcome(), crate::rlop::ObjectSelectOutcome::Pending);
    assert_eq!(restored.longop_queue()[1].private_state, v2_state);
    let object = crate::rlop::ObjectSelectLongOp::try_from_longop(&restored.longop_queue()[1])
        .expect("object carrier");
    assert_eq!(object.return_values(), &[7, 2]);
    assert!(object.is_cancelable());
    assert_eq!(
        object.outcome(),
        crate::rlop::ObjectSelectOutcome::Cancelled
    );
    restored.apply_choice_resume(&object.into_longop());
    assert_eq!(restored.banks().store(), (-1_i32) as u32);
    restored.banks_mut().set_store(99);
    let mut invalid =
        crate::rlop::ObjectSelectLongOp::try_new(LongOpId(8), vec![7, 2]).expect("bounded");
    invalid.select(9);
    restored.apply_choice_resume(&invalid.into_longop());
    restored.apply_choice_resume(&LongOp::new(LongOpId(9), vec![0xA3, 1]));
    assert_eq!(restored.banks().store(), 99);
    assert!(matches!(
        restored.warnings(),
        [
            VmWarning::ObjectChoiceResumeOutOfRange { .. },
            VmWarning::ObjectChoiceResumeMalformed { .. }
        ]
    ));
}

#[test]
fn hex_round_trip_helper() {
    let bytes = vec![0xDE, 0xAD, 0xBE, 0xEF];
    let hex = bytes_to_hex(&bytes);
    assert_eq!(hex, "deadbeef");
    let back = hex_to_bytes(&hex).expect("decode");
    assert_eq!(back, bytes);
}

/// Soundness of the event-flag spin-break: `control_fingerprint`
/// MUST fold the suspended-longop queue. `step()` polls the queue
/// head before fetching the next element, so on a wait/event-poll
/// loop the next step is NOT a pure function of (scene, pc, stack
/// banks) alone when the queue is non-empty and evolving. If the
/// queue were omitted, a back-edge that returns to the same
/// (scene, pc) with a DIFFERENT — still-evolving — queue would
/// present a REPEATED fingerprint and be falsely proven an infinite
/// spin, silently rewriting a real transfer to `Advance`.
///
/// This asserts:
///  1. false-positive guard — an evolving queue (same scene/pc
///     stack/banks) yields a DISTINCT fingerprint each step, so the
///     spin-break cannot fire on it; and
///  2. the spin-break is not weakened — a genuine pure-state repeat
///     (queue byte-identical) still yields a REPEATED fingerprint.
#[test]
fn control_fingerprint_folds_evolving_longop_queue() {
    let mut vm = Vm::new(7, 42);

    // Baseline: empty queue.
    let fp_empty = vm.control_fingerprint();

    // Enqueuing a longop changes the fingerprint (queue length
    // contents are folded), even though scene/pc/stack/banks are
    // unchanged.
    vm.enqueue_longop(LongOp::new(LongOpId(1), vec![0x00]));
    let fp_q0 = vm.control_fingerprint();
    assert_ne!(
        fp_empty, fp_q0,
        "a non-empty queue must not share a fingerprint with the empty queue"
    );

    // Fingerprint is a pure function of state: recomputing with the
    // queue unchanged yields the SAME value — a genuine pure-state
    // spin (queue stable) still breaks.
    assert_eq!(
        fp_q0,
        vm.control_fingerprint(),
        "a byte-identical pure state must repeat its fingerprint (spin-break preserved)"
    );

    // False-positive guard: an evolving wait/event longop advances
    // its private_state between polls while scene/pc/stack/banks
    // stay fixed. The fingerprint MUST differ so the back-edge is
    // not proven an infinite spin.
    vm.longop_queue
        .front_mut()
        .expect("queue head present")
        .private_state = vec![0x01];
    let fp_q1 = vm.control_fingerprint();
    assert_ne!(
        fp_q0, fp_q1,
        "an evolving longop queue must produce distinct fingerprints (no false-positive spin)"
    );

    // Distinct queue depth also perturbs the fingerprint.
    vm.enqueue_longop(LongOp::new(LongOpId(2), vec![0x01]));
    let fp_q2 = vm.control_fingerprint();
    assert_ne!(
        fp_q1, fp_q2,
        "queue depth must be folded (a deeper queue differs)"
    );

    // Distinct longop identity (same private_state, different id)
    // must not collide.
    let mut vm_a = Vm::new(7, 42);
    vm_a.enqueue_longop(LongOp::new(LongOpId(10), vec![0xAB]));
    let mut vm_b = Vm::new(7, 42);
    vm_b.enqueue_longop(LongOp::new(LongOpId(11), vec![0xAB]));
    assert_ne!(
        vm_a.control_fingerprint(),
        vm_b.control_fingerprint(),
        "distinct longop ids must not collide under an identical private_state"
    );
}
