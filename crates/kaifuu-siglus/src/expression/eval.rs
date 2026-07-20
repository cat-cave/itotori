//! Fuzz-safe stack evaluator: fold a partitioned scene's operand stream into
//! typed [`SiglusExpr`] trees plus a sanitized operator histogram.
//!
//! The evaluator walks the [`SiglusInstruction`] stream in order, decoding each
//! instruction's operand (see [`super::decode_operand`]) and driving a
//! ProgStack model: `CD_PUSH` pushes literal / element-code leaves, the
//! `CD_OPERATE_1/2` opcodes fold the top of stack under a re-derived operator,
//! `CD_ELM_POINT` / `CD_PROPERTY` bracket element-reference chains, and the
//! consumers (`CD_ASSIGN`, `CD_GOTO_TRUE/FALSE`, `CD_TEXT`, `CD_NAME`,
//! `CD_RETURN`, void `CD_POP` / `CD_COMMAND`) harvest completed expression trees
//! into [`SceneExpressionDecode::roots`].
//!
//! Every pop is underflow-checked: a value that a straight-line walk cannot
//! supply (its producer sits on another control-flow path) becomes a typed
//! [`SiglusExpr::StackUnderflow`] leaf, never a panic. Every operator byte is
//! mapped through the re-derived tables; a byte outside them becomes a typed
//! [`SiglusExpr::UnsupportedOperator`] and is recorded in
//! [`SiglusOperatorHistogram::unsupported`]. Only counts, offsets, forms, and
//! operator labels cross into the report — never raw scene text.

use crate::opcode::{SiglusInstruction, SiglusOpcode, SiglusParseError, partition_scene};

use super::model::ProgStack;
use super::tree::{SiglusBinaryOp, SiglusExpr, SiglusUnaryOp};
use super::{
    SceneExpressionDecode, SceneExpressionError, SiglusExpressionError, SiglusOperand, SiglusPush,
    UnsupportedOperatorSite, arg_forms_value_count, decode_operand,
};

/// Decode every expression in a partitioned instruction stream over its
/// `bytecode` section into typed trees + a sanitized operator histogram.
pub fn decode_operand_stream(
    bytecode: &[u8],
    instructions: &[SiglusInstruction],
) -> Result<SceneExpressionDecode, SiglusExpressionError> {
    let mut out = SceneExpressionDecode::new(instructions.len());
    let mut stack = ProgStack::default();

    for instruction in instructions {
        let operand_bytes = instruction.len - 1;
        out.total_operand_bytes += operand_bytes;
        stack.set_lead(instruction.lead);
        // `decode_operand` asserts it consumes exactly `operand_bytes`.
        let operand = decode_operand(bytecode, instruction)?;
        out.typed_operand_bytes += operand_bytes;

        match (&instruction.opcode, operand) {
            (SiglusOpcode::Push, SiglusOperand::Push(push)) => match push {
                SiglusPush::Int(value) => {
                    out.push_int_count += 1;
                    stack.push(SiglusExpr::Int(value));
                }
                SiglusPush::Str(index) => {
                    out.push_str_count += 1;
                    stack.push(SiglusExpr::Str { index });
                }
                SiglusPush::Form(form) => {
                    *out.push_other_forms.entry(form).or_insert(0) += 1;
                    stack.push(SiglusExpr::PushForm { form });
                }
            },
            (SiglusOpcode::Operate1, SiglusOperand::Operate1(_form, op)) => {
                let operand = stack.pop();
                if let Some(unary) = SiglusUnaryOp::from_byte(op) {
                    out.operators.bump_unary(unary);
                    stack.push(SiglusExpr::Unary {
                        op: unary,
                        operand: Box::new(operand),
                    });
                } else {
                    out.operators.unsupported.push(UnsupportedOperatorSite {
                        byte_offset: instruction.byte_offset,
                        op,
                        arity: 1,
                    });
                    stack.push(SiglusExpr::UnsupportedOperator { op, arity: 1 });
                }
            }
            (SiglusOpcode::Operate2, SiglusOperand::Operate2(_l, _r, op)) => {
                let rhs = stack.pop();
                let lhs = stack.pop();
                if let Some(binary) = SiglusBinaryOp::from_byte(op) {
                    out.operators.bump_binary(binary);
                    stack.push(SiglusExpr::Binary {
                        op: binary,
                        lhs: Box::new(lhs),
                        rhs: Box::new(rhs),
                    });
                } else {
                    out.operators.unsupported.push(UnsupportedOperatorSite {
                        byte_offset: instruction.byte_offset,
                        op,
                        arity: 2,
                    });
                    stack.push(SiglusExpr::UnsupportedOperator { op, arity: 2 });
                }
            }
            (SiglusOpcode::ElmPoint, _) => stack.open_frame(),
            (SiglusOpcode::CopyElm, _) => stack.dup_frame(),
            (SiglusOpcode::Property, _) => {
                let chain = stack.close_frame();
                if matches!(chain, SiglusExpr::Element { .. }) {
                    out.element_chain_count += 1;
                }
                stack.push(chain);
            }
            (SiglusOpcode::Copy, _) => stack.dup_top(),
            (SiglusOpcode::Pop, SiglusOperand::Pop(form)) => {
                // A void-form pop discards nothing from the operand stack (it
                // balances a void-returning command that pushed no value); only
                // the typed int/str pops actually consume a value.
                if form != 0 {
                    let value = stack.pop();
                    out.roots.push(value);
                }
            }
            (SiglusOpcode::DecProp, SiglusOperand::DecProp(form, _prop_id)) => {
                // List-form property declarations take their size off the stack.
                if form == 11 || form == 21 {
                    let size = stack.pop();
                    out.roots.push(size);
                }
            }
            (SiglusOpcode::Assign, SiglusOperand::Assign(..)) => {
                let rhs = stack.pop();
                let lhs = stack.close_frame();
                if matches!(lhs, SiglusExpr::Element { .. }) {
                    out.element_chain_count += 1;
                }
                out.roots.push(lhs);
                out.roots.push(rhs);
            }
            // Single-operand consumers that harvest one completed tree: a jump
            // condition (`CD_GOTO_TRUE/FALSE`), a message run's text
            // (`CD_TEXT`), or a speaker name (`CD_NAME`).
            (
                SiglusOpcode::GotoTrue
                | SiglusOpcode::GotoFalse
                | SiglusOpcode::Text
                | SiglusOpcode::Name,
                _,
            ) => {
                let value = stack.pop();
                out.roots.push(value);
            }
            (SiglusOpcode::Gosub, SiglusOperand::Gosub(label, forms)) => {
                let args = stack.pop_args(arg_forms_value_count(&forms));
                out.gosub_count += 1;
                stack.push(SiglusExpr::Gosub {
                    label,
                    args,
                    returns_str: false,
                });
            }
            (SiglusOpcode::GosubStr, SiglusOperand::GosubStr(label, forms)) => {
                let args = stack.pop_args(arg_forms_value_count(&forms));
                out.gosub_count += 1;
                stack.push(SiglusExpr::Gosub {
                    label,
                    args,
                    returns_str: true,
                });
            }
            (SiglusOpcode::Return, SiglusOperand::Return(forms)) => {
                for arg in stack.pop_args(arg_forms_value_count(&forms)) {
                    out.roots.push(arg);
                }
            }
            (
                SiglusOpcode::Command { .. },
                SiglusOperand::Command {
                    arg_list_id,
                    arg_forms,
                    ret_form,
                    ..
                },
            ) => {
                let args = stack.pop_args(arg_forms_value_count(&arg_forms));
                let target = stack.close_frame();
                if matches!(target, SiglusExpr::Element { .. }) {
                    out.element_chain_count += 1;
                }
                out.command_count += 1;
                let call = SiglusExpr::Command {
                    arg_list_id,
                    args,
                    target: Box::new(target),
                    ret_form,
                };
                if ret_form == 0 {
                    out.roots.push(call);
                } else {
                    stack.push(call);
                }
            }
            // No operand-stack effect. This covers line markers (`CD_NL`), jumps
            // (`CD_GOTO`), frame arg-expansion (`CD_ARG`), the selection-block
            // brackets, `CD_EOF`, opaque `Unknown` spans, and — defensively —
            // any impossible `(opcode, operand)` shape mismatch (the operand is
            // decoded off the same opcode, so a mismatch cannot occur).
            _ => {}
        }
    }

    let (underflow, underflow_by_lead, final_depth) = stack.into_diagnostics();
    out.stack_underflow_count = underflow;
    out.stack_underflow_by_lead = underflow_by_lead;
    out.final_stack_depth = final_depth;
    Ok(out)
}

/// Locate a decompressed scene payload's `scn` bytecode section (header fields
/// 1 = offset, 2 = size), returning `None` if it runs out of bounds.
fn scene_bytecode(payload: &[u8]) -> Option<&[u8]> {
    let read = |field: usize| -> Option<i32> {
        let base = field * 4;
        let slice = payload.get(base..base + 4)?;
        Some(i32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
    };
    let scn_ofs = read(1)?.max(0) as usize;
    let scn_size = read(2)?.max(0) as usize;
    let end = scn_ofs.checked_add(scn_size)?;
    payload.get(scn_ofs..end)
}

/// Decode every expression in a decompressed scene payload: partition it (via
/// [`partition_scene`]) then fold the operand stream into typed trees.
///
/// This is the payload-level entry the real-bytes proof drives.
pub fn decode_scene_expressions(
    payload: &[u8],
) -> Result<SceneExpressionDecode, SceneExpressionError> {
    let partition = partition_scene(payload)?;
    let bytecode = scene_bytecode(payload).ok_or(SceneExpressionError::Partition(
        SiglusParseError::BytecodeOutOfBounds {
            scn_ofs: 0,
            scn_size: 0,
            payload_len: payload.len(),
        },
    ))?;
    Ok(decode_operand_stream(bytecode, &partition.instructions)?)
}

#[cfg(test)]
mod tests {
    use super::super::FM_INT;
    use super::*;

    fn put_i32(buf: &mut Vec<u8>, value: i32) {
        buf.extend_from_slice(&value.to_le_bytes());
    }

    fn build_payload(bytecode: &[u8], labels: &[i32]) -> Vec<u8> {
        let header_len = crate::opcode::SCN_HEADER_BYTE_LEN as i32;
        let scn_ofs = header_len;
        let label_ofs = header_len + bytecode.len() as i32;
        let mut header = Vec::new();
        put_i32(&mut header, crate::opcode::SCN_HEADER_DECLARED_SIZE);
        put_i32(&mut header, scn_ofs);
        put_i32(&mut header, bytecode.len() as i32);
        for _ in 3..7 {
            put_i32(&mut header, 0);
        }
        put_i32(&mut header, label_ofs);
        put_i32(&mut header, labels.len() as i32);
        put_i32(&mut header, 0);
        put_i32(&mut header, 0);
        for _ in 11..33 {
            put_i32(&mut header, 0);
        }
        let mut payload = header;
        payload.extend_from_slice(bytecode);
        for label in labels {
            put_i32(&mut payload, *label);
        }
        payload
    }

    /// `(1 + 2) == cond`, consumed by a GOTO_TRUE: builds a Binary(Eq) over a
    /// Binary(Add) of two int literals.
    #[test]
    fn builds_a_binary_tree_from_pushes_and_operators() {
        let mut bc = Vec::new();
        for value in [1, 2] {
            bc.push(0x02);
            put_i32(&mut bc, FM_INT);
            put_i32(&mut bc, value);
        }
        bc.push(0x22); // add
        put_i32(&mut bc, FM_INT);
        put_i32(&mut bc, FM_INT);
        bc.push(0x01);
        bc.push(0x02); // push int 5
        put_i32(&mut bc, FM_INT);
        put_i32(&mut bc, 5);
        bc.push(0x22); // eq
        put_i32(&mut bc, FM_INT);
        put_i32(&mut bc, FM_INT);
        bc.push(0x10);
        bc.push(0x11); // goto_true consumes the condition
        put_i32(&mut bc, 0);
        bc.push(0x16);
        let payload = build_payload(&bc, &[]);
        let decode = decode_scene_expressions(&payload).expect("decode");
        assert!(decode.is_fully_typed());
        assert_eq!(decode.stack_underflow_count, 0);
        assert_eq!(decode.final_stack_depth, 0);
        assert_eq!(decode.operators.binary.get("b.add"), Some(&1));
        assert_eq!(decode.operators.binary.get("b.eq"), Some(&1));
        let root = decode.roots.last().expect("a harvested condition");
        match root {
            SiglusExpr::Binary {
                op: SiglusBinaryOp::Eq,
                lhs,
                ..
            } => assert!(matches!(
                lhs.as_ref(),
                SiglusExpr::Binary {
                    op: SiglusBinaryOp::Add,
                    ..
                }
            )),
            other => panic!("expected eq over add, got {other:?}"),
        }
    }

    #[test]
    fn unknown_operator_byte_is_a_typed_diagnostic_not_a_panic() {
        let mut bc = Vec::new();
        bc.push(0x02);
        put_i32(&mut bc, FM_INT);
        put_i32(&mut bc, 9);
        bc.push(0x21); // OPERATE_1 with an out-of-table operator byte
        put_i32(&mut bc, FM_INT);
        bc.push(0x7F);
        bc.push(0x16);
        let payload = build_payload(&bc, &[]);
        let decode = decode_scene_expressions(&payload).expect("decode");
        assert_eq!(decode.typed_operand_bytes, decode.total_operand_bytes);
        assert!(!decode.is_fully_typed(), "an unsupported op is present");
        assert_eq!(decode.operators.unsupported.len(), 1);
        assert_eq!(decode.operators.unsupported[0].op, 0x7F);
        assert_eq!(decode.operators.unsupported[0].arity, 1);
    }

    #[test]
    fn element_chain_brackets_into_a_typed_reference() {
        // ELM_POINT, push global-var head (0x7F000003), PROPERTY closes it.
        let mut bc = vec![0x08];
        bc.push(0x02);
        put_i32(&mut bc, FM_INT);
        put_i32(&mut bc, 0x7F00_0003u32 as i32);
        bc.push(0x05); // property
        bc.push(0x16);
        let payload = build_payload(&bc, &[]);
        let decode = decode_scene_expressions(&payload).expect("decode");
        assert!(decode.is_fully_typed());
        assert_eq!(decode.element_chain_count, 1);
        assert_eq!(decode.final_stack_depth, 1);
        // The bracketed chain sits typed on the stack (no consumer harvested it).
        assert!(matches!(
            decode_scene_expressions(&payload)
                .expect("re-decode")
                .element_chain_count,
            1
        ));
    }

    #[test]
    fn deterministic_across_two_runs() {
        let mut bc = Vec::new();
        bc.push(0x02);
        put_i32(&mut bc, FM_INT);
        put_i32(&mut bc, 3);
        bc.push(0x21);
        put_i32(&mut bc, FM_INT);
        bc.push(0x02);
        bc.push(0x16);
        let payload = build_payload(&bc, &[]);
        let a = decode_scene_expressions(&payload).expect("run a");
        let b = decode_scene_expressions(&payload).expect("run b");
        assert_eq!(a, b);
    }
}
