use super::*;
use crate::rlop::RlopRegistry;

#[test]
fn media_commands_all_register() {
    let mut registry = RlopRegistry::new();
    let count = register_media_rlops(&mut registry);
    assert_eq!(count, MEDIA_RLOP_COUNT);
    assert_eq!(registry.len(), MEDIA_RLOP_COUNT);
    for &(module_id, opcode, _) in MEDIA_COMMANDS {
        assert!(
            registry
                .get(RlopKey::new(AUDIO_MODULE_TYPE, module_id, opcode))
                .is_some(),
            "({AUDIO_MODULE_TYPE},{module_id},{opcode}) must resolve",
        );
    }
}

#[test]
fn media_command_advances_without_touching_store() {
    let op = MediaCommand::new("koe.do_play");
    let mut vm = Vm::new(1, 0);
    let before = vm.banks().store();
    let outcome = op.dispatch(&mut vm, &[ExprValue::Int(42)]);
    assert!(matches!(outcome, DispatchOutcome::Advance));
    assert_eq!(vm.banks().store(), before);
    assert_eq!(op.tag(), "koe.do_play");
}
