use super::*;
use crate::var_banks::Value;
use utsushi_core::substrate::{Inspectable, Restorable};

#[test]
fn frame_commands_write_references_and_return_active_state() {
    let mut vm = Vm::new(1, 0);
    let init = InitFramesOp;
    assert_eq!(
        init.dispatch(
            &mut vm,
            &[
                ExprValue::List(vec![
                    ExprValue::Int(4),
                    ExprValue::Int(7),
                    ExprValue::Int(10),
                    ExprValue::Int(100),
                ]),
                ExprValue::List(vec![
                    ExprValue::Int(5),
                    ExprValue::Int(20),
                    ExprValue::Int(20),
                    ExprValue::Int(0),
                ]),
            ],
        ),
        DispatchOutcome::Advance
    );

    let read = ReadFramesOp;
    assert_eq!(
        read.dispatch(
            &mut vm,
            &[
                ExprValue::List(vec![
                    ExprValue::Int(4),
                    ExprValue::IntReference {
                        bank: 1,
                        index: 17,
                        value: 0,
                    },
                ]),
                ExprValue::List(vec![
                    ExprValue::Int(5),
                    ExprValue::IntReference {
                        bank: 2,
                        index: 18,
                        value: 0,
                    },
                ]),
            ],
        ),
        DispatchOutcome::Advance
    );

    assert_eq!(vm.banks().get(BankId::IntB, 17), Some(Value::Int(7)));
    assert_eq!(vm.banks().get(BankId::IntC, 18), Some(Value::Int(20)));
    assert_eq!(vm.banks().store(), 1);
}

#[test]
fn malformed_frame_command_is_visible_and_does_not_advance() {
    let mut vm = Vm::new(1, 0);
    let outcome = ReadFramesOp.dispatch(&mut vm, &[ExprValue::Int(7)]);
    assert_eq!(outcome, DispatchOutcome::Halt);
    assert!(matches!(
        vm.take_warnings().as_slice(),
        [VmWarning::RlopArgsInvalid {
            op: "sys.read_frames",
            ..
        }]
    ));
}

#[test]
fn read_frames_uses_initial_value_then_advances_its_logical_millisecond_clock() {
    let mut vm = Vm::new(1, 0);
    let init = InitFramesOp;
    let read = ReadFramesOp;
    init.dispatch(
        &mut vm,
        &[ExprValue::List(vec![
            ExprValue::Int(9),
            ExprValue::Int(0),
            ExprValue::Int(10),
            ExprValue::Int(2),
        ])],
    );
    let destination = |index| {
        vec![ExprValue::List(vec![
            ExprValue::Int(9),
            ExprValue::IntReference {
                bank: 1,
                index,
                value: 0,
            },
        ])]
    };

    read.dispatch(&mut vm, &destination(20));
    assert_eq!(vm.banks().get(BankId::IntB, 20), Some(Value::Int(0)));
    assert_eq!(vm.banks().store(), 1);
    read.dispatch(&mut vm, &destination(21));
    assert_eq!(vm.banks().get(BankId::IntB, 21), Some(Value::Int(5)));
    assert_eq!(vm.banks().store(), 1);
    read.dispatch(&mut vm, &destination(22));
    assert_eq!(vm.banks().get(BankId::IntB, 22), Some(Value::Int(10)));
    assert_eq!(vm.banks().store(), 0);
}

#[test]
fn frame_counter_clock_survives_vm_snapshot_restore() {
    let mut original = Vm::new(1, 0);
    let init = InitFramesOp;
    let read = ReadFramesOp;
    init.dispatch(
        &mut original,
        &[ExprValue::List(vec![
            ExprValue::Int(7),
            ExprValue::Int(0),
            ExprValue::Int(10),
            ExprValue::Int(2),
        ])],
    );
    read.dispatch(
        &mut original,
        &[ExprValue::List(vec![
            ExprValue::Int(7),
            ExprValue::IntReference {
                bank: 1,
                index: 23,
                value: 0,
            },
        ])],
    );
    let snapshot = original.inspect_state().expect("frame snapshot");
    let mut restored = Vm::new(99, 99);
    restored.restore_state(&snapshot).expect("restore frame snapshot");
    let next_read = [ExprValue::List(vec![
        ExprValue::Int(7),
        ExprValue::IntReference {
            bank: 1,
            index: 24,
            value: 0,
        },
    ])];
    read.dispatch(&mut original, &next_read);
    read.dispatch(&mut restored, &next_read);
    assert_eq!(
        original.banks().get(BankId::IntB, 24),
        restored.banks().get(BankId::IntB, 24)
    );
    assert_eq!(original.banks().store(), restored.banks().store());
}

#[test]
fn frame_commands_register_only_the_byte_proven_keys() {
    let mut registry = RlopRegistry::new();
    assert_eq!(register_sys_frame_rlops(&mut registry), 2);
    assert!(registry
        .get(RlopKey::new(SYS_MODULE_TYPE, SYS_MODULE_ID, OPCODE_INIT_FRAMES))
        .is_some());
    assert!(registry
        .get(RlopKey::new(SYS_MODULE_TYPE, SYS_MODULE_ID, OPCODE_READ_FRAMES))
        .is_some());
    assert!(registry
        .get(RlopKey::new(0, SYS_MODULE_ID, OPCODE_INIT_FRAMES))
        .is_none());
}
