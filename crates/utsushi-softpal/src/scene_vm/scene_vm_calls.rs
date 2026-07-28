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

/// `0x17`'s second operand is the native return destination. A plain immediate
/// is a discarded destination in this compact scene model.
pub(super) fn write_call_result(vm: &mut Vm<'_>, instruction: Instruction, value: i32) -> bool {
    let Some(destination) = instruction.operands().get(1).copied() else {
        return vm.bad("call_missing_result_destination", instruction.offset);
    };
    if destination.tag() == OperandTag::PLAIN {
        return true;
    }
    vm.store(destination, value, instruction.offset)
}
