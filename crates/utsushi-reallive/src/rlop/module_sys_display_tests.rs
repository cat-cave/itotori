use super::*;
use crate::rlop::RlopRegistry;

#[test]
fn display_commands_all_register_across_lattice() {
    let mut registry = RlopRegistry::new();
    let count = register_sys_display_rlops(&mut registry);
    assert_eq!(count, SYS_DISPLAY_RLOP_COUNT);
    assert_eq!(registry.len(), SYS_DISPLAY_RLOP_COUNT);
    for &(opcode, _) in DISPLAY_COMMANDS {
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
fn display_command_advances_without_touching_store() {
    let op = SysDisplayCommand::new("sys.set_auto_mode");
    let mut vm = Vm::new(1, 0);
    let before = vm.banks().store();
    let outcome = op.dispatch(&mut vm, &[ExprValue::Int(1)]);
    assert!(matches!(outcome, DispatchOutcome::Advance));
    // A display/interaction command writes no store register.
    assert_eq!(vm.banks().store(), before);
    assert_eq!(op.tag(), "sys.set_auto_mode");
}
