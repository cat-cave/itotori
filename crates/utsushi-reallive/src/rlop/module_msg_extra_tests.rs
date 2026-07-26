use super::*;
use crate::rlop::RlopRegistry;

#[test]
fn msg_extra_commands_all_register_across_lattice() {
    let mut registry = RlopRegistry::new();
    let count = register_msg_extra_rlops(&mut registry);
    assert_eq!(count, MSG_EXTRA_RLOP_COUNT);
    assert_eq!(registry.len(), MSG_EXTRA_RLOP_COUNT);
    for &(opcode, _) in MSG_EXTRA_COMMANDS {
        for module_type in LATTICE_TYPES {
            assert!(
                registry
                    .get(RlopKey::new(module_type, MSG_MODULE_ID, opcode))
                    .is_some(),
                "opcode {opcode} must resolve for lattice type {module_type}",
            );
        }
    }
}

#[test]
fn msg_extra_command_advances_without_touching_store() {
    let op = MsgExtraCommand::new("msg.br");
    let mut vm = Vm::new(1, 0);
    let before = vm.banks().store();
    let outcome = op.dispatch(&mut vm, &[]);
    assert!(matches!(outcome, DispatchOutcome::Advance));
    assert_eq!(vm.banks().store(), before);
    assert_eq!(op.tag(), "msg.br");
}
