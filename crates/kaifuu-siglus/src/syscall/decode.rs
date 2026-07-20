//! Stack replay and selection extraction for `CD_COMMAND`.

use std::collections::BTreeMap;

use crate::expression::{
    SiglusArgForm, SiglusBinaryOp, SiglusElementHead, SiglusExpr, SiglusOperand, SiglusPush,
    SiglusUnaryOp, arg_forms_value_count, decode_operand,
};
use crate::flow::decode_scene_flow;
use crate::opcode::{SiglusInstruction, SiglusOpcode, partition_scene};

use super::model::{
    GLOBAL_SELBTN_SYSTEM_FUNCTION_ID, SceneSyscallDecode, SceneSyscallError, SiglusCallArgument,
    SiglusCallArgumentRole, SiglusCallTarget, SiglusSelChoice, SiglusSelOption, SiglusStringRef,
    SiglusSyscallDiagnostic, SiglusTypedCall,
};
use super::shapes::system_function_shape;

/// A compact, total version of the siglus-09 expression stack. It exists here
/// because this layer needs every command call at its bytecode site, including
/// value-returning calls that siglus-09 leaves on the stack for a later use.
#[derive(Default)]
struct CallStack {
    values: Vec<SiglusExpr>,
    frames: Vec<usize>,
}

impl CallStack {
    fn push(&mut self, value: SiglusExpr) {
        self.values.push(value);
    }

    fn pop(&mut self) -> SiglusExpr {
        self.values.pop().unwrap_or(SiglusExpr::StackUnderflow)
    }

    fn pop_args(&mut self, count: usize) -> Vec<SiglusExpr> {
        let mut args: Vec<SiglusExpr> = (0..count).map(|_| self.pop()).collect();
        args.reverse();
        args
    }

    fn copy_top(&mut self) {
        self.push(
            self.values
                .last()
                .cloned()
                .unwrap_or(SiglusExpr::StackUnderflow),
        );
    }

    fn open_frame(&mut self) {
        self.frames.push(self.values.len());
    }

    fn copy_frame(&mut self) {
        let begin = self
            .frames
            .last()
            .copied()
            .unwrap_or(0)
            .min(self.values.len());
        self.frames.push(self.values.len());
        self.values.extend(self.values[begin..].to_vec());
    }

    fn close_frame(&mut self) -> SiglusExpr {
        let Some(depth) = self.frames.pop() else {
            return SiglusExpr::StackUnderflow;
        };
        let atoms = self.values.split_off(depth.min(self.values.len()));
        let mut atoms = atoms.into_iter();
        let Some(head) = atoms.next() else {
            return SiglusExpr::StackUnderflow;
        };
        SiglusExpr::Element {
            head: SiglusElementHead::from_expr(head),
            tail: atoms.collect(),
        }
    }
}

/// A checked lookup table for the scene's interned UTF-16 strings.
struct StringTable {
    list_byte_offset: usize,
    entries: Vec<(i32, i32)>,
    payload_len: usize,
}

impl StringTable {
    fn from_payload(payload: &[u8]) -> Self {
        let field = |index: usize| -> i32 {
            let base = index.saturating_mul(4);
            payload.get(base..base.saturating_add(4)).map_or(0, |raw| {
                i32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]])
            })
        };
        let offset = field(3);
        let count = field(4);
        let mut entries = Vec::new();
        if offset >= 0 && count >= 0 {
            let base = offset as usize;
            let available = payload.len().saturating_sub(base) / 8;
            for entry in 0..(count as usize).min(available) {
                let Some(byte) = entry
                    .checked_mul(8)
                    .and_then(|delta| base.checked_add(delta))
                else {
                    break;
                };
                let Some(raw) = payload.get(byte..byte.saturating_add(8)) else {
                    break;
                };
                entries.push((
                    i32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]),
                    i32::from_le_bytes([raw[4], raw[5], raw[6], raw[7]]),
                ));
            }
        }
        StringTable {
            list_byte_offset: field(5).max(0) as usize,
            entries,
            payload_len: payload.len(),
        }
    }

    fn resolve(&self, index: i32) -> Option<SiglusStringRef> {
        if index < 0 {
            return None;
        }
        let (char_offset, char_len) = *self.entries.get(index as usize)?;
        if char_offset < 0 || char_len < 0 {
            return None;
        }
        let byte_offset = self
            .list_byte_offset
            .checked_add((char_offset as usize).checked_mul(2)?)?;
        let byte_len = (char_len as usize).checked_mul(2)?;
        if byte_offset.checked_add(byte_len)? > self.payload_len {
            return None;
        }
        Some(SiglusStringRef {
            index,
            byte_offset,
            char_len,
        })
    }
}

/// Convert a completed element frame into a target without discarding anything
/// unusual. Direct system heads are the syscall function-id form.
fn target_from_expression(expression: &SiglusExpr) -> SiglusCallTarget {
    match expression {
        SiglusExpr::Element {
            head: SiglusElementHead::System { index },
            tail,
        } if tail.is_empty() => SiglusCallTarget::System {
            function_id: *index,
        },
        SiglusExpr::Element {
            head: SiglusElementHead::System { index },
            tail,
        } => SiglusCallTarget::SystemPath {
            function_id: *index,
            tail: tail.clone(),
        },
        SiglusExpr::Element {
            head: SiglusElementHead::Function { index },
            tail,
        } if tail.is_empty() => SiglusCallTarget::Function {
            function_id: *index,
        },
        SiglusExpr::Element {
            head: SiglusElementHead::GlobalVar { index },
            tail,
        } if tail.is_empty() => SiglusCallTarget::GlobalVar {
            variable_id: *index,
        },
        SiglusExpr::Element {
            head: SiglusElementHead::Raw { value },
            tail,
        } if tail.is_empty() => SiglusCallTarget::Raw { value: *value },
        _ => SiglusCallTarget::Computed {
            expression: expression.clone(),
        },
    }
}

/// Flatten the command's recursive ABI form list to one leaf per consumed
/// stack value. This mirrors the oracle's `CD_COMMAND` → `pop_arg_list()`
/// construct: nested list forms still consume their leaf values in order.
fn flatten_arg_forms(forms: &[SiglusArgForm], out: &mut Vec<SiglusArgForm>) {
    for form in forms {
        match form {
            SiglusArgForm::Form(_) => out.push(form.clone()),
            SiglusArgForm::List(items) => flatten_arg_forms(items, out),
        }
    }
}

/// Pair the exact values consumed by `CD_COMMAND` with the form that consumed
/// each one and with the ABI's positional/named role. The oracle applies named
/// ids from the argument-list tail backwards (`args[len - 1 - a]`), so the
/// same association is preserved here.
fn semantic_args(
    forms: &[SiglusArgForm],
    args: &[SiglusExpr],
    named_arg_ids: &[i32],
) -> Vec<SiglusCallArgument> {
    let mut leaf_forms = Vec::new();
    flatten_arg_forms(forms, &mut leaf_forms);
    debug_assert_eq!(leaf_forms.len(), args.len());
    let positional_count = args.len().saturating_sub(named_arg_ids.len());

    args.iter()
        .cloned()
        .zip(leaf_forms)
        .enumerate()
        .map(|(index, (value, form))| {
            let role = if index < positional_count {
                SiglusCallArgumentRole::Positional { index }
            } else {
                let id_index = args.len().saturating_sub(index + 1);
                SiglusCallArgumentRole::Named {
                    id: named_arg_ids[id_index],
                }
            };
            SiglusCallArgument { role, form, value }
        })
        .collect()
}

/// Drive all stack-affecting instructions. Command calls are returned at their
/// precise site and still leave their declared result on the stack.
fn replay_calls(
    bytecode: &[u8],
    instructions: &[SiglusInstruction],
) -> Result<(Vec<SiglusTypedCall>, usize), SceneSyscallError> {
    let mut stack = CallStack::default();
    let mut calls = Vec::new();
    let mut command_operand_bytes = 0usize;

    for instruction in instructions {
        let operand = decode_operand(bytecode, instruction)?;
        match (&instruction.opcode, operand) {
            (SiglusOpcode::Push, SiglusOperand::Push(push)) => match push {
                SiglusPush::Int(value) => stack.push(SiglusExpr::Int(value)),
                SiglusPush::Str(index) => stack.push(SiglusExpr::Str { index }),
                SiglusPush::Form(form) => stack.push(SiglusExpr::PushForm { form }),
            },
            (SiglusOpcode::Operate1, SiglusOperand::Operate1(_, op)) => {
                let operand = stack.pop();
                stack.push(match SiglusUnaryOp::from_byte(op) {
                    Some(op) => SiglusExpr::Unary {
                        op,
                        operand: Box::new(operand),
                    },
                    None => SiglusExpr::UnsupportedOperator { op, arity: 1 },
                });
            }
            (SiglusOpcode::Operate2, SiglusOperand::Operate2(_, _, op)) => {
                let rhs = stack.pop();
                let lhs = stack.pop();
                stack.push(match SiglusBinaryOp::from_byte(op) {
                    Some(op) => SiglusExpr::Binary {
                        op,
                        lhs: Box::new(lhs),
                        rhs: Box::new(rhs),
                    },
                    None => SiglusExpr::UnsupportedOperator { op, arity: 2 },
                });
            }
            (SiglusOpcode::ElmPoint, _) => stack.open_frame(),
            (SiglusOpcode::CopyElm, _) => stack.copy_frame(),
            (SiglusOpcode::Property, _) => {
                let property = stack.close_frame();
                stack.push(property);
            }
            (SiglusOpcode::Copy, _) => stack.copy_top(),
            (SiglusOpcode::Pop, SiglusOperand::Pop(form)) if form != 0 => {
                stack.pop();
            }
            (SiglusOpcode::DecProp, SiglusOperand::DecProp(form, _))
                if form == 11 || form == 21 =>
            {
                stack.pop();
            }
            (SiglusOpcode::Assign, SiglusOperand::Assign(..)) => {
                stack.pop();
                stack.close_frame();
            }
            (
                SiglusOpcode::GotoTrue
                | SiglusOpcode::GotoFalse
                | SiglusOpcode::Text
                | SiglusOpcode::Name,
                _,
            ) => {
                stack.pop();
            }
            (SiglusOpcode::Gosub, SiglusOperand::Gosub(label, forms)) => {
                let args = stack.pop_args(arg_forms_value_count(&forms));
                stack.push(SiglusExpr::Gosub {
                    label,
                    args,
                    returns_str: false,
                });
            }
            (SiglusOpcode::GosubStr, SiglusOperand::GosubStr(label, forms)) => {
                let args = stack.pop_args(arg_forms_value_count(&forms));
                stack.push(SiglusExpr::Gosub {
                    label,
                    args,
                    returns_str: true,
                });
            }
            (SiglusOpcode::Return, SiglusOperand::Return(forms)) => {
                stack.pop_args(arg_forms_value_count(&forms));
            }
            (
                SiglusOpcode::Command { .. },
                SiglusOperand::Command {
                    arg_list_id,
                    arg_forms,
                    named_arg_ids,
                    ret_form,
                    read_flag,
                },
            ) => {
                command_operand_bytes += instruction.len.saturating_sub(1);
                let args = stack.pop_args(arg_forms_value_count(&arg_forms));
                let target_expression = stack.close_frame();
                let target = target_from_expression(&target_expression);
                let call = SiglusTypedCall {
                    site_offset: instruction.byte_offset,
                    operand_byte_len: instruction.len.saturating_sub(1),
                    target,
                    target_expression,
                    arg_list_id,
                    semantic_args: semantic_args(&arg_forms, &args, &named_arg_ids),
                    arg_forms,
                    args,
                    named_arg_ids,
                    ret_form,
                    read_flag,
                };
                if call.ret_form != 0 {
                    stack.push(SiglusExpr::Command {
                        arg_list_id: call.arg_list_id,
                        args: call.args.clone(),
                        target: Box::new(call.target_expression.clone()),
                        ret_form: call.ret_form,
                    });
                }
                calls.push(call);
            }
            _ => {}
        }
    }
    Ok((calls, command_operand_bytes))
}

/// Return all direct, positional string arguments used as `selbtn` labels.
fn sel_option_strings(call: &SiglusTypedCall) -> impl Iterator<Item = i32> + '_ {
    let positional_count = call.args.len().saturating_sub(call.named_arg_ids.len());
    call.args[..positional_count]
        .iter()
        .filter_map(|arg| match arg {
            SiglusExpr::Str { index } => Some(*index),
            _ => None,
        })
}

/// Decode command sites, then attach the selections to the existing flow
/// recognizer's branch arms. All byte parsing happens through `decode_operand`,
/// which validates its exact partition-assigned span.
pub fn decode_scene_syscalls(payload: &[u8]) -> Result<SceneSyscallDecode, SceneSyscallError> {
    let partition = partition_scene(payload)?;
    let flow = decode_scene_flow(payload)?;
    let scn_ofs = payload.get(4..8).map_or(0, |raw| {
        i32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]).max(0) as usize
    });
    let bytecode = payload
        .get(scn_ofs..scn_ofs.saturating_add(partition.bytecode_len))
        .unwrap_or(&[]);
    let (calls, total_command_operand_bytes) = replay_calls(bytecode, &partition.instructions)?;
    let strings = StringTable::from_payload(payload);
    let mut selections = Vec::new();
    let mut unresolved_sel_option_count = 0usize;

    for (call_index, call) in calls.iter().enumerate() {
        if call.target.system_function_id() != Some(GLOBAL_SELBTN_SYSTEM_FUNCTION_ID) {
            continue;
        }
        let structural_choice_index = flow
            .choice_units
            .iter()
            .position(|choice| choice.select_offset == call.site_offset);
        let arms = structural_choice_index.map(|index| &flow.choice_units[index].arms);
        let mut options = Vec::new();
        for (index, string_index) in sel_option_strings(call).enumerate() {
            let Some(text) = strings.resolve(string_index) else {
                unresolved_sel_option_count += 1;
                continue;
            };
            let Some(result_value) = i32::try_from(index)
                .ok()
                .and_then(|index| index.checked_add(1))
            else {
                unresolved_sel_option_count += 1;
                continue;
            };
            let (structural_arm_index, branch_target_offset) = arms
                .and_then(|arms| {
                    arms.iter()
                        .enumerate()
                        .find(|(_, arm)| arm.compare_value == result_value)
                })
                .map_or((None, None), |(arm_index, arm)| {
                    (Some(arm_index), arm.target_offset)
                });
            options.push(SiglusSelOption {
                result_value,
                text,
                structural_arm_index,
                branch_target_offset,
            });
        }
        selections.push(SiglusSelChoice {
            call_offset: call.site_offset,
            call_index,
            structural_choice_index,
            options,
        });
    }

    let mut unknown_arg_shape_counts = BTreeMap::new();
    for call in &calls {
        if let Some(function_id) = call.target.system_function_id()
            && system_function_shape(function_id).is_none()
        {
            *unknown_arg_shape_counts.entry(function_id).or_insert(0) += 1;
        }
    }
    // Function references, global variables, raw packed heads, and computed
    // elements each have a distinct fully typed target representation. They
    // are not opaque or unknown target shapes.
    let mut diagnostics: Vec<_> = unknown_arg_shape_counts
        .iter()
        .map(
            |(&function_id, &count)| SiglusSyscallDiagnostic::UnknownSyscallArgShape {
                function_id,
                count,
            },
        )
        .collect();
    if unresolved_sel_option_count > 0 {
        diagnostics.push(SiglusSyscallDiagnostic::UnresolvedSelOptionStringRef {
            count: unresolved_sel_option_count,
        });
    }

    Ok(SceneSyscallDecode {
        instruction_count: partition.instructions.len(),
        typed_command_operand_bytes: total_command_operand_bytes,
        total_command_operand_bytes,
        calls,
        selections,
        diagnostics,
        unknown_arg_shape_counts,
        unknown_target_shapes: 0,
    })
}
