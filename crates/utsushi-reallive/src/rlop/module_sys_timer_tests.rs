use super::*;
use crate::rlop::RlopRegistry;

#[test]
fn timer_commands_all_register_across_lattice() {
    let mut registry = RlopRegistry::new();
    let count = register_sys_timer_rlops(&mut registry);
    assert_eq!(count, SYS_TIMER_RLOP_COUNT);
    assert_eq!(registry.len(), SYS_TIMER_RLOP_COUNT);
    for &(opcode, _) in TIMER_COMMANDS {
        for module_type in LATTICE_TYPES {
            assert!(
                registry
                    .get(RlopKey::new(module_type, SYS_MODULE_ID, opcode))
                    .is_some(),
                "opcode {opcode} must resolve for lattice type {module_type}",
            );
        }
    }
}

#[test]
fn timer_command_advances_without_touching_store() {
    let op = SysTimerCommand::new("sys.time");
    let mut vm = Vm::new(1, 0);
    let before = vm.banks().store();
    // time(N, counter) — two int args; the command ignores them.
    let outcome = op.dispatch(&mut vm, &[ExprValue::Int(1000), ExprValue::Int(0)]);
    assert!(matches!(outcome, DispatchOutcome::Advance));
    assert_eq!(vm.banks().store(), before);
    assert_eq!(op.tag(), "sys.time");
}
