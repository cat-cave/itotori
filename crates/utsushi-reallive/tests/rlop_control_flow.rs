//! UTSUSHI-210 — synthetic tests for the control-flow RLOperation
//! family.
//!
//! Each test dispatches one of the registered ops directly (via
//! `RLOperation::dispatch`) and asserts on the typed
//! [`DispatchOutcome`] variant plus the VM state transitions produced
//! by [`Vm::apply_dispatch_outcome`]. The op layer does not own scene
//! storage / pc arithmetic / queue plumbing — that surface is exercised
//! by the UTSUSHI-208 `vm_synthetic.rs` integration tests; here we
//! exercise the per-op contract and the documented acceptance criteria
//! for UTSUSHI-210:
//!
//! - `ctl_goto_if_branches`: condition true → Jump; false → Advance.
//! - `ctl_gosub_with_parameter_passing`: `gosub_if` true → pushes
//!   a Subroutine frame; `farcall_with_args` populates the parameter
//!   slot bank.
//! - `ctl_farcall_scene9999_entrypoint10`: the system-call shape
//!   `CANCELCALL=9999,10` lowers through `FarcallOp` into a
//!   cross-scene `FarCall` outcome whose target is `(scene=9999, pc=10)`.

use std::sync::Arc;

use utsushi_reallive::{
    AlwaysReadyScheduler, CONTROL_FLOW_RLOP_COUNT, DispatchOutcome, ExprValue, FARCALL_ARG_BANK,
    FarcallOp, FarcallWithArgsOp, GosubIfOp, GosubOp, GotoIfOp, GotoOnOp, GotoOp, GotoUnlessOp,
    HaltOp, KEY_FARCALL, KEY_FARCALL_WITH_ARGS, KEY_GOSUB, KEY_GOSUB_IF, KEY_GOTO, KEY_GOTO_IF,
    KEY_GOTO_ON, KEY_GOTO_UNLESS, KEY_HALT, KEY_RET, KEY_RTL, KEY_SELECT, LongOp, LongOpId,
    RLOperation, RetOp, RlopRegistry, RtlOp, SELECT_LONGOP_ID, STACK_DEPTH_LIMIT, SelectOp,
    SelectionLongOp, StackFrameKind, Value, Vm, VmError, VmWarning, register_control_flow_rlops,
};

// ---------------------------------------------------------------------
// goto family
// ---------------------------------------------------------------------

#[test]
fn ctl_goto_emits_jump() {
    let mut vm = Vm::new(3, 100);
    let outcome = GotoOp.dispatch(&mut vm, &[ExprValue::Int(250)]);
    assert_eq!(outcome, DispatchOutcome::Jump { scene: 3, pc: 250 });
    vm.apply_dispatch_outcome(&outcome, 999).expect("apply");
    assert_eq!(vm.scene(), 3);
    assert_eq!(vm.pc(), 250);
}

#[test]
fn ctl_goto_if_branches() {
    // True branch: cond != 0 → Jump.
    let mut vm = Vm::new(1, 50);
    let outcome = GotoIfOp.dispatch(&mut vm, &[ExprValue::Int(1), ExprValue::Int(500)]);
    assert_eq!(outcome, DispatchOutcome::Jump { scene: 1, pc: 500 });
    vm.apply_dispatch_outcome(&outcome, 60).expect("apply");
    assert_eq!(vm.pc(), 500);

    // False branch: cond == 0 → Advance to post_pc.
    let mut vm = Vm::new(1, 50);
    let outcome = GotoIfOp.dispatch(&mut vm, &[ExprValue::Int(0), ExprValue::Int(500)]);
    assert_eq!(outcome, DispatchOutcome::Advance);
    vm.apply_dispatch_outcome(&outcome, 60).expect("apply");
    assert_eq!(vm.pc(), 60);
}

#[test]
fn ctl_goto_unless_inverts_goto_if() {
    // cond == 0 → Jump.
    let mut vm = Vm::new(1, 0);
    let outcome = GotoUnlessOp.dispatch(&mut vm, &[ExprValue::Int(0), ExprValue::Int(800)]);
    assert_eq!(outcome, DispatchOutcome::Jump { scene: 1, pc: 800 });

    // cond != 0 → Advance.
    let mut vm = Vm::new(1, 0);
    let outcome = GotoUnlessOp.dispatch(&mut vm, &[ExprValue::Int(7), ExprValue::Int(800)]);
    assert_eq!(outcome, DispatchOutcome::Advance);
}

#[test]
fn ctl_goto_on_indexed_jump() {
    // Value within the table → Jump to that entry.
    let mut vm = Vm::new(1, 0);
    let args = [
        ExprValue::Int(2),
        ExprValue::Int(100),
        ExprValue::Int(200),
        ExprValue::Int(300),
        ExprValue::Int(400),
    ];
    let outcome = GotoOnOp.dispatch(&mut vm, &args);
    assert_eq!(outcome, DispatchOutcome::Jump { scene: 1, pc: 300 });
}

#[test]
fn ctl_goto_on_out_of_range_falls_through() {
    // Value past the end → Advance (default sink, not Fatal).
    let mut vm = Vm::new(1, 0);
    let args = [ExprValue::Int(99), ExprValue::Int(100), ExprValue::Int(200)];
    let outcome = GotoOnOp.dispatch(&mut vm, &args);
    assert_eq!(outcome, DispatchOutcome::Advance);
}

#[test]
fn ctl_goto_on_negative_value_falls_through() {
    let mut vm = Vm::new(1, 0);
    let args = [ExprValue::Int(-1), ExprValue::Int(100)];
    let outcome = GotoOnOp.dispatch(&mut vm, &args);
    assert_eq!(outcome, DispatchOutcome::Advance);
}

// ---------------------------------------------------------------------
// gosub family
// ---------------------------------------------------------------------

#[test]
fn ctl_gosub_pushes_subroutine_frame() {
    let mut vm = Vm::new(2, 50);
    let outcome = GosubOp.dispatch(&mut vm, &[ExprValue::Int(60), ExprValue::Int(800)]);
    assert_eq!(
        outcome,
        DispatchOutcome::Subroutine {
            return_pc: 60,
            target_scene: 2,
            target_pc: 800,
        }
    );
    vm.apply_dispatch_outcome(&outcome, 60).expect("apply");
    assert_eq!(vm.scene(), 2);
    assert_eq!(vm.pc(), 800);
    assert_eq!(vm.stack().len(), 1);
    assert_eq!(vm.stack()[0].return_pc, 60);
    assert_eq!(vm.stack()[0].frame_kind, StackFrameKind::Subroutine);
}

#[test]
fn ctl_gosub_if_true_pushes_frame() {
    let mut vm = Vm::new(2, 0);
    let outcome = GosubIfOp.dispatch(
        &mut vm,
        &[ExprValue::Int(1), ExprValue::Int(60), ExprValue::Int(800)],
    );
    assert_eq!(
        outcome,
        DispatchOutcome::Subroutine {
            return_pc: 60,
            target_scene: 2,
            target_pc: 800,
        }
    );
    vm.apply_dispatch_outcome(&outcome, 60).expect("apply");
    assert_eq!(vm.stack().len(), 1);
}

#[test]
fn ctl_gosub_if_false_advances() {
    let mut vm = Vm::new(2, 0);
    let outcome = GosubIfOp.dispatch(
        &mut vm,
        &[ExprValue::Int(0), ExprValue::Int(60), ExprValue::Int(800)],
    );
    assert_eq!(outcome, DispatchOutcome::Advance);
    vm.apply_dispatch_outcome(&outcome, 60).expect("apply");
    assert_eq!(vm.stack().len(), 0);
}

#[test]
fn ctl_gosub_with_parameter_passing() {
    // Lowered shape of rlvm `gosub_with(label, $intA[0])` →
    // farcall_with_args is the closest analogue in our op table for
    // arg-bank populating semantics. Verify the arg bank is populated.
    let mut vm = Vm::new(2, 0);
    let outcome = FarcallWithArgsOp.dispatch(
        &mut vm,
        &[
            ExprValue::Int(2),   // return_scene
            ExprValue::Int(60),  // return_pc
            ExprValue::Int(2),   // target_scene
            ExprValue::Int(800), // target_pc
            ExprValue::Int(11),
            ExprValue::Int(22),
            ExprValue::Int(33),
        ],
    );
    assert_eq!(
        outcome,
        DispatchOutcome::FarCall {
            return_scene: 2,
            return_pc: 60,
            target_scene: 2,
            target_pc: 800,
        }
    );
    vm.apply_dispatch_outcome(&outcome, 60).expect("apply");
    // Bank slot 0 → 11, slot 1 → 22, slot 2 → 33.
    assert_eq!(vm.banks().get(FARCALL_ARG_BANK, 0), Some(Value::Int(11)));
    assert_eq!(vm.banks().get(FARCALL_ARG_BANK, 1), Some(Value::Int(22)));
    assert_eq!(vm.banks().get(FARCALL_ARG_BANK, 2), Some(Value::Int(33)));
    assert_eq!(vm.banks().get(FARCALL_ARG_BANK, 3), None);
}

// ---------------------------------------------------------------------
// farcall family
// ---------------------------------------------------------------------

#[test]
fn ctl_farcall_emits_far_call_outcome() {
    let mut vm = Vm::new(2, 50);
    let outcome = FarcallOp.dispatch(
        &mut vm,
        &[
            ExprValue::Int(2),   // return_scene
            ExprValue::Int(60),  // return_pc
            ExprValue::Int(42),  // target_scene
            ExprValue::Int(900), // target_pc
        ],
    );
    assert_eq!(
        outcome,
        DispatchOutcome::FarCall {
            return_scene: 2,
            return_pc: 60,
            target_scene: 42,
            target_pc: 900,
        }
    );
    vm.apply_dispatch_outcome(&outcome, 60).expect("apply");
    assert_eq!(vm.scene(), 42);
    assert_eq!(vm.pc(), 900);
    assert_eq!(vm.stack().len(), 1);
    assert_eq!(vm.stack()[0].return_scene, Some(2));
    assert_eq!(vm.stack()[0].return_pc, 60);
    assert_eq!(vm.stack()[0].frame_kind, StackFrameKind::FarCall);
}

#[test]
fn ctl_farcall_scene9999_entrypoint10() {
    // Sweetie HD `CANCELCALL=9999,10` system-call entry shape.
    let mut vm = Vm::new(1, 0);
    let outcome = FarcallOp.dispatch(
        &mut vm,
        &[
            ExprValue::Int(1),
            ExprValue::Int(20),
            ExprValue::Int(9999),
            ExprValue::Int(10),
        ],
    );
    assert_eq!(
        outcome,
        DispatchOutcome::FarCall {
            return_scene: 1,
            return_pc: 20,
            target_scene: 9999,
            target_pc: 10,
        }
    );
}

// ---------------------------------------------------------------------
// ret / rtl
// ---------------------------------------------------------------------

#[test]
fn ctl_ret_pops_subroutine_frame() {
    let mut vm = Vm::new(1, 0);
    // Stage a subroutine frame by going through gosub.
    let push = GosubOp.dispatch(&mut vm, &[ExprValue::Int(60), ExprValue::Int(800)]);
    vm.apply_dispatch_outcome(&push, 60).expect("push");
    assert_eq!(vm.stack().len(), 1);

    // ret → ReturnFromSubroutine.
    let pop = RetOp.dispatch(&mut vm, &[]);
    assert_eq!(pop, DispatchOutcome::Return);
    vm.apply_dispatch_outcome(&pop, 800).expect("ret");
    assert_eq!(vm.stack().len(), 0);
    assert_eq!(vm.pc(), 60);
}

#[test]
fn ctl_rtl_pops_far_call_frame() {
    let mut vm = Vm::new(1, 0);
    let push = FarcallOp.dispatch(
        &mut vm,
        &[
            ExprValue::Int(1),
            ExprValue::Int(40),
            ExprValue::Int(9999),
            ExprValue::Int(10),
        ],
    );
    vm.apply_dispatch_outcome(&push, 40).expect("push");
    let pop = RtlOp.dispatch(&mut vm, &[]);
    assert_eq!(pop, DispatchOutcome::ReturnFromCall);
    vm.apply_dispatch_outcome(&pop, 10).expect("rtl");
    assert_eq!(vm.stack().len(), 0);
    assert_eq!(vm.scene(), 1);
    assert_eq!(vm.pc(), 40);
}

#[test]
fn ctl_ret_on_empty_stack_is_typed_error() {
    let mut vm = Vm::new(1, 0);
    let pop = RetOp.dispatch(&mut vm, &[]);
    let err = vm.apply_dispatch_outcome(&pop, 0).unwrap_err();
    match err {
        VmError::EmptyStack {
            scene: 1,
            expected: "subroutine",
            ..
        } => {}
        other => panic!("expected EmptyStack(subroutine), got {other:?}"),
    }
}

#[test]
fn ctl_rtl_on_empty_stack_is_typed_error() {
    let mut vm = Vm::new(1, 0);
    let pop = RtlOp.dispatch(&mut vm, &[]);
    let err = vm.apply_dispatch_outcome(&pop, 0).unwrap_err();
    match err {
        VmError::EmptyStack {
            scene: 1,
            expected: "far_call",
            ..
        } => {}
        other => panic!("expected EmptyStack(far_call), got {other:?}"),
    }
}

// ---------------------------------------------------------------------
// halt
// ---------------------------------------------------------------------

#[test]
fn ctl_halt_sets_halted_flag() {
    let mut vm = Vm::new(1, 0);
    let outcome = HaltOp.dispatch(&mut vm, &[]);
    assert_eq!(outcome, DispatchOutcome::Halt);
    vm.apply_dispatch_outcome(&outcome, 0).expect("halt");
    assert!(vm.is_halted());
}

// ---------------------------------------------------------------------
// select
// ---------------------------------------------------------------------

#[test]
fn ctl_select_yields_selection_longop() {
    let mut vm = Vm::new(1, 0);
    let op = SelectOp::new(LongOpId(0xabcd));
    let outcome = op.dispatch(
        &mut vm,
        &[
            ExprValue::Int(100),
            ExprValue::Int(200),
            ExprValue::Int(300),
        ],
    );
    let (longop_id, private_state) = match outcome {
        DispatchOutcome::Yield {
            longop_id,
            private_state,
        } => (longop_id, private_state),
        other => panic!("expected Yield, got {other:?}"),
    };
    assert_eq!(longop_id, LongOpId(0xabcd));
    let queued = LongOp::new(longop_id, private_state);
    let decoded = SelectionLongOp::from_longop(&queued).expect("decode");
    assert_eq!(decoded.choices(), &[100, 200, 300]);
    assert_eq!(decoded.user_choice(), None);
}

#[test]
fn ctl_select_longop_resume_targets_recorded_choice() {
    let mut longop = SelectionLongOp::new(LongOpId(7), vec![100, 200, 300]).expect("new");
    longop.record_user_choice(2).expect("record");
    let outcome = longop.resume(1).expect("resume");
    assert_eq!(outcome, DispatchOutcome::Jump { scene: 1, pc: 300 });
}

// ---------------------------------------------------------------------
// Stack overflow & invalid args
// ---------------------------------------------------------------------

#[test]
fn ctl_stack_overflow_after_1024_pushes() {
    let mut vm = Vm::new(1, 0);
    // Push STACK_DEPTH_LIMIT successful subroutine frames.
    for _ in 0..STACK_DEPTH_LIMIT {
        let outcome = GosubOp.dispatch(&mut vm, &[ExprValue::Int(60), ExprValue::Int(800)]);
        vm.apply_dispatch_outcome(&outcome, 60).expect("push");
    }
    assert_eq!(vm.stack().len(), STACK_DEPTH_LIMIT);
    // The next push must surface a typed StackOverflow.
    let outcome = GosubOp.dispatch(&mut vm, &[ExprValue::Int(60), ExprValue::Int(800)]);
    let err = vm.apply_dispatch_outcome(&outcome, 60).unwrap_err();
    match err {
        VmError::StackOverflow {
            limit,
            kind: "subroutine",
            ..
        } => assert_eq!(limit, STACK_DEPTH_LIMIT),
        other => panic!("expected StackOverflow, got {other:?}"),
    }
}

#[test]
fn ctl_farcall_stack_overflow_after_1024_pushes() {
    let mut vm = Vm::new(1, 0);
    for _ in 0..STACK_DEPTH_LIMIT {
        let outcome = FarcallOp.dispatch(
            &mut vm,
            &[
                ExprValue::Int(1),
                ExprValue::Int(40),
                ExprValue::Int(9999),
                ExprValue::Int(10),
            ],
        );
        vm.apply_dispatch_outcome(&outcome, 40).expect("push");
    }
    let outcome = FarcallOp.dispatch(
        &mut vm,
        &[
            ExprValue::Int(1),
            ExprValue::Int(40),
            ExprValue::Int(9999),
            ExprValue::Int(10),
        ],
    );
    let err = vm.apply_dispatch_outcome(&outcome, 40).unwrap_err();
    match err {
        VmError::StackOverflow {
            kind: "far_call", ..
        } => {}
        other => panic!("expected StackOverflow(far_call), got {other:?}"),
    }
}

#[test]
fn ctl_invalid_args_warn_and_advance() {
    // wrong arity
    let mut vm = Vm::new(1, 0);
    let outcome = GotoIfOp.dispatch(&mut vm, &[ExprValue::Int(1)]);
    assert_eq!(outcome, DispatchOutcome::Advance);
    let warnings = vm.take_warnings();
    assert!(matches!(
        warnings.as_slice(),
        [VmWarning::RlopArgsInvalid { op: "goto_if", .. }]
    ));

    // wrong type
    let mut vm = Vm::new(1, 0);
    let outcome = GotoOp.dispatch(&mut vm, &[ExprValue::Bytes(vec![0xff])]);
    assert_eq!(outcome, DispatchOutcome::Advance);
    let warnings = vm.take_warnings();
    assert_eq!(warnings.len(), 1);
}

// ---------------------------------------------------------------------
// Registry helper
// ---------------------------------------------------------------------

#[test]
fn ctl_register_helper_populates_full_family() {
    let mut registry = RlopRegistry::new();
    let count = register_control_flow_rlops(&mut registry);
    assert_eq!(count, CONTROL_FLOW_RLOP_COUNT);
    for key in [
        KEY_GOTO,
        KEY_GOTO_IF,
        KEY_GOTO_UNLESS,
        KEY_GOTO_ON,
        KEY_GOSUB,
        KEY_GOSUB_IF,
        KEY_FARCALL,
        KEY_FARCALL_WITH_ARGS,
        KEY_RET,
        KEY_RTL,
        KEY_SELECT,
        KEY_HALT,
    ] {
        assert!(registry.get(key).is_some(), "missing key {key}");
    }
}

#[test]
fn ctl_select_longop_id_is_pinned() {
    // The registry-managed select op's long-op id is the pinned
    // constant — snapshot tooling can identify the queued long-op by
    // this id.
    let mut vm = Vm::new(1, 0);
    let op = SelectOp::new(SELECT_LONGOP_ID);
    let outcome = op.dispatch(&mut vm, &[ExprValue::Int(10)]);
    match outcome {
        DispatchOutcome::Yield { longop_id, .. } => assert_eq!(longop_id, SELECT_LONGOP_ID),
        other => panic!("expected Yield, got {other:?}"),
    }
}

// Touch the scheduler / Arc imports so unused-import lints don't fire
// while keeping the test surface clear about which substrate types this
// suite depends on.
fn _touch_scheduler() {
    let _scheduler: AlwaysReadyScheduler = AlwaysReadyScheduler;
    let _registered: Arc<dyn RLOperation> = Arc::new(GotoOp);
}
