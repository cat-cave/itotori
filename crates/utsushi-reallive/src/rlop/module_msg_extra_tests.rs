use super::*;
use crate::rlop::RlopRegistry;

#[test]
fn msg_extra_commands_register_at_their_observed_addresses() {
    let mut registry = RlopRegistry::new();
    let count = register_msg_extra_rlops(&mut registry);
    assert_eq!(count, MSG_EXTRA_RLOP_COUNT);
    assert_eq!(registry.len(), MSG_EXTRA_RLOP_COUNT);
    for &(module_type, opcode, _) in MSG_EXTRA_COMMANDS {
        assert!(registry.get(RlopKey::new(module_type, 3, opcode)).is_some());
    }
}

#[test]
fn msg_extra_command_advances_without_touching_store() {
    let op = MsgExtraCommand::new("msg.extension_400");
    let mut vm = Vm::new(1, 0);
    let before = vm.banks().store();
    let outcome = op.dispatch(&mut vm, &[]);
    assert!(matches!(outcome, DispatchOutcome::Advance));
    assert_eq!(vm.banks().store(), before);
    assert_eq!(op.tag(), "msg.extension_400");
}
