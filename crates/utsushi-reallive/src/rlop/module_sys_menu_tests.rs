use super::*;
use crate::rlop::RlopRegistry;

#[test]
fn menu_return_opcodes_register_across_lattice() {
    let mut registry = RlopRegistry::new();
    let count = register_sys_menu_rlops(&mut registry);
    assert_eq!(count, SYS_MENU_RLOP_COUNT);
    assert_eq!(registry.len(), SYS_MENU_RLOP_COUNT);
    for &opcode in MENU_RETURN_OPCODES {
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
fn menu_return_halts_the_content_flow() {
    let op = MenuReturnOp;
    let mut vm = Vm::new(1, 0);
    let outcome = op.dispatch(&mut vm, &[]);
    // MenuReturn is a return-to-title transfer, modeled as a halt so the
    // branch driver records a natural EndOfScene terminus.
    assert!(matches!(outcome, DispatchOutcome::Halt));
}
