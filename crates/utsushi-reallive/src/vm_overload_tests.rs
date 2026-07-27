use super::*;
use crate::{NeverReadyScheduler, RLOperation};
use std::sync::Arc;

struct HaltOp;

impl RLOperation for HaltOp {
    fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        DispatchOutcome::Halt
    }
}

struct AdvanceOp;

impl RLOperation for AdvanceOp {
    fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        DispatchOutcome::Advance
    }
}

#[test]
fn vm_dispatches_command_to_the_byte_header_overload() {
    let opcode = 1000;
    let element = BytecodeElement::Command {
        module_type: 1,
        module_id: 4,
        opcode,
        arg_count: 0,
        overload: 1,
        goto_targets: Vec::new(),
        goto_case_exprs: Vec::new(),
        raw_bytes: vec![0x23, 1, 4, opcode as u8, (opcode >> 8) as u8, 0, 0, 1],
        byte_offset: 0,
        byte_len: 8,
    };
    let scene = Scene::new(1, vec![element]).expect("well-formed scene");
    let mut store = InMemorySceneStore::new();
    store.insert(scene);
    let mut registry = RlopRegistry::new();
    registry.register(RlopKey::new(1, 4, opcode), Arc::new(HaltOp));
    registry.register(RlopKey::with_overload(1, 4, opcode, 1), Arc::new(AdvanceOp));
    let mut vm = Vm::new(1, 0);
    let mut scheduler = NeverReadyScheduler;

    match vm
        .step(&store, &registry, &mut scheduler)
        .expect("dispatch")
    {
        StepOutcome::Advanced {
            event: VmEvent::CommandDispatched { key, .. },
        } => assert_eq!(key, RlopKey::with_overload(1, 4, opcode, 1)),
        other => panic!("overload-one command must advance, got {other:?}"),
    }
}
