use super::Vm;
use kaifuu_softpal::{Instruction, OperandTag};

pub(super) fn verify_frame_argument_count(
    vm: &mut Vm<'_>,
    instruction: Instruction,
    operation: &str,
) -> bool {
    let Some(count) = instruction
        .operands()
        .first()
        .and_then(|operand| vm.value(*operand, instruction.offset))
        .and_then(|count| usize::try_from(count).ok())
    else {
        return vm.bad(&format!("{operation}_invalid_count"), instruction.offset);
    };
    let actual = vm.frames.last().map_or(0, |frame| frame.arguments.len());
    if actual != count {
        return vm.bad(
            &format!("{operation}_argument_count_mismatch_{actual}_{count}"),
            instruction.offset,
        );
    }
    true
}

/// `0x17`'s second operand is a native variable-slot number, rather than a
/// normal expression operand. In particular, raw `1` means local slot 1;
/// treating it as a discarded immediate loses returned opaque handles before
/// the script's next native call can consume them.
pub(super) fn write_call_result(vm: &mut Vm<'_>, instruction: Instruction, value: i32) -> bool {
    let Some(destination) = instruction.operands().get(1).copied() else {
        return vm.bad("call_missing_result_destination", instruction.offset);
    };
    if destination.tag() == OperandTag::PLAIN {
        vm.frames
            .last_mut()
            .expect("initial frame")
            .locals
            .insert(destination.raw, value);
        return true;
    }
    vm.store(destination, value, instruction.offset)
}
