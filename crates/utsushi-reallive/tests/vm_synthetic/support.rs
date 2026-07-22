use super::*;

// Synthetic-element constructors. Each builds a single, well-shaped
// `BytecodeElement` whose `byte_offset` / `byte_len` honour the
// partition invariant from — `Scene::new` consumes the
// `byte_offset` field, and `pc_advance` math depends on `byte_len`.

pub(super) fn meta_line(offset: usize, line_number: u16) -> BytecodeElement {
    BytecodeElement::MetaLine {
        line_number,
        byte_offset: offset,
        byte_len: 3,
    }
}

pub(super) fn command(
    offset: usize,
    module_type: u8,
    module_id: u8,
    opcode: u16,
) -> BytecodeElement {
    BytecodeElement::Command {
        module_type,
        module_id,
        opcode,
        arg_count: 0,
        overload: 0,
        goto_targets: vec![],
        goto_case_exprs: vec![],
        raw_bytes: vec![
            0x23,
            module_type,
            module_id,
            opcode as u8,
            (opcode >> 8) as u8,
            0,
            0,
            0,
        ],
        byte_offset: offset,
        byte_len: 8,
    }
}

// Test RLOperation implementations. These are intentionally tiny:
// each one returns a single `DispatchOutcome` so the VM test can
// assert on the pc / stack / queue transition without dragging in a
// full per-module table.

pub(super) struct GotoZero;
impl RLOperation for GotoZero {
    fn dispatch(&self, vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        // Jump back to the start of the current scene.
        DispatchOutcome::Jump {
            scene: vm.scene(),
            pc: 0,
        }
    }
}

pub(super) struct GosubTo {
    pub(super) target_pc: u32,
}
impl RLOperation for GosubTo {
    fn dispatch(&self, vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        // post_pc is "pc + 8" because the command header is 8 bytes;
        // the dispatch path threads that as the return pc — we mirror
        // it here so the assertion can quote the exact byte.
        DispatchOutcome::Subroutine {
            return_pc: vm.pc() + 8,
            target_scene: vm.scene(),
            target_pc: self.target_pc,
        }
    }
}

pub(super) struct RetOp;
impl RLOperation for RetOp {
    fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        DispatchOutcome::Return
    }
}

pub(super) struct FarCallTo {
    pub(super) target_scene: u16,
    pub(super) target_pc: u32,
}
impl RLOperation for FarCallTo {
    fn dispatch(&self, vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        DispatchOutcome::FarCall {
            return_scene: vm.scene(),
            return_pc: vm.pc() + 8,
            target_scene: self.target_scene,
            target_pc: self.target_pc,
        }
    }
}

pub(super) struct RtlOp;
impl RLOperation for RtlOp {
    fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        DispatchOutcome::ReturnFromCall
    }
}

pub(super) struct PauseLongOp {
    pub(super) id: LongOpId,
    pub(super) private_state: Vec<u8>,
}
impl RLOperation for PauseLongOp {
    fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        DispatchOutcome::Yield {
            longop_id: self.id,
            private_state: self.private_state.clone(),
        }
    }
}
