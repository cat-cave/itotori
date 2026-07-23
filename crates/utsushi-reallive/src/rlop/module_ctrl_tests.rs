use super::*;
use crate::rlop::RlopRegistry;

#[test]
fn register_helper_populates_expected_count() {
    let mut registry = RlopRegistry::new();
    let count = register_control_flow_rlops(&mut registry);
    assert_eq!(count, CONTROL_FLOW_RLOP_COUNT);
    assert_eq!(registry.len(), CONTROL_FLOW_RLOP_COUNT);
}

#[test]
fn register_helper_covers_every_pinned_key() {
    let mut registry = RlopRegistry::new();
    register_control_flow_rlops(&mut registry);
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
        KEY_HALT,
    ] {
        assert!(registry.get(key).is_some(), "missing key: {key}");
    }
}

#[test]
fn goto_with_missing_arg_advances_and_warns() {
    let mut vm = Vm::new(7, 0);
    let outcome = GotoOp.dispatch(&mut vm, &[]);
    assert_eq!(outcome, DispatchOutcome::Advance);
    let warnings = vm.take_warnings();
    assert!(matches!(
        warnings.as_slice(),
        [VmWarning::RlopArgsInvalid { op: "goto", .. }]
    ));
}

#[test]
fn goto_with_negative_target_warns() {
    let mut vm = Vm::new(7, 0);
    let outcome = GotoOp.dispatch(&mut vm, &[ExprValue::Int(-1)]);
    assert_eq!(outcome, DispatchOutcome::Advance);
    let warnings = vm.take_warnings();
    assert_eq!(warnings.len(), 1);
}
