//! Selection-label helpers for the `CD_COMMAND` syscall decoder.

use crate::expression::{SiglusExpr, SiglusOperand, SiglusPush, decode_operand};
use crate::opcode::{SiglusInstruction, SiglusOpcode};

use super::model::SiglusTypedCall;

/// Return all direct, positional string arguments used as `selbtn` labels.
pub(super) fn sel_option_strings(call: &SiglusTypedCall) -> impl Iterator<Item = i32> + '_ {
    let positional_count = call.args.len().saturating_sub(call.named_arg_ids.len());
    call.args[..positional_count]
        .iter()
        .filter_map(|arg| match arg {
            SiglusExpr::Str { index } => Some(*index),
            _ => None,
        })
}

/// Recover the `CD_PUSH str` sites immediately feeding a selection call. The
/// text refs carry patchable string-table locations; these instruction offsets
/// distinguish labels supplied to one `CD_COMMAND` site.
pub(super) fn selection_string_push_offsets(
    bytecode: &[u8],
    instructions: &[SiglusInstruction],
    call_offset: usize,
) -> Vec<(i32, usize)> {
    let Some(call_index) = instructions
        .iter()
        .position(|instruction| instruction.byte_offset == call_offset)
    else {
        return Vec::new();
    };
    let frame_start = instructions[..call_index]
        .iter()
        .rposition(|instruction| matches!(instruction.opcode, SiglusOpcode::ElmPoint))
        .unwrap_or(0);
    instructions[frame_start..call_index]
        .iter()
        .filter_map(
            |instruction| match decode_operand(bytecode, instruction).ok()? {
                SiglusOperand::Push(SiglusPush::Str(index)) => {
                    Some((index, instruction.byte_offset))
                }
                _ => None,
            },
        )
        .collect()
}
