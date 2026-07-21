//! Build named statements, text surfaces, the resolved jump table, and linked
//! choice units from a partitioned scene's instruction stream.
//!
//! A lightweight typed-slot stack (str-literal index / int constant / opaque)
//! mirrors the expression-stack evaluator's operand-stack discipline just far
//! enough to read the top-of-stack **string-table index** a `CD_TEXT` /
//! `CD_NAME` renders — the load-bearing patch-back reference. Choice
//! recognition is a separate forward scan for the select→conditional-jump
//! dispatch shape. Nothing here reads a decoded character: strings travel as
//! their table index + byte-span only.

use std::collections::BTreeMap;

use crate::expression::{
    SiglusArgForm, SiglusBinaryOp, SiglusOperand, SiglusPush, SiglusUnaryOp, decode_operand,
};
use crate::opcode::{SiglusInstruction, SiglusOpcode};

use super::model::{
    SiglusChoiceArm, SiglusChoiceUnit, SiglusJump, SiglusJumpKind, SiglusStatement,
    SiglusTextSurface,
};

/// The scene's interned string table: the `str_list` base plus the per-index
/// `(char_offset, char_len)` entries, enough to locate any string's byte-span.
pub(super) struct SceneStrings {
    /// Absolute byte offset of the string-data section within the payload.
    list_byte_ofs: usize,
    /// `(char_offset, char_len)` per string index.
    entries: Vec<(i32, i32)>,
}

impl SceneStrings {
    pub(super) fn new(list_byte_ofs: usize, entries: Vec<(i32, i32)>) -> Self {
        SceneStrings {
            list_byte_ofs,
            entries,
        }
    }

    /// Resolve a string index to `(payload byte offset, char length)`.
    fn resolve(&self, index: i32) -> Option<(usize, i32)> {
        if index < 0 {
            return None;
        }
        let (char_offset, char_len) = *self.entries.get(index as usize)?;
        if char_offset < 0 || char_len < 0 {
            return None;
        }
        let byte_offset = self
            .list_byte_ofs
            .checked_add((char_offset as usize).checked_mul(2)?)?;
        Some((byte_offset, char_len))
    }
}

/// One typed slot on the lightweight tracking stack. Only the `str`-literal
/// index is load-bearing (it is the string a text consumer renders); every
/// other value is opaque here.
#[derive(Clone, Copy)]
enum Slot {
    /// A pushed `str` literal carrying its table index.
    Str(i32),
    /// Any other / computed value.
    Opaque,
}

/// A minimal stack mirroring the expression-stack evaluator's net effect,
/// tracking only typed slots (for the top-of-stack string a text consumer
/// renders).
#[derive(Default)]
struct SlotStack {
    slots: Vec<Slot>,
    frames: Vec<usize>,
}

impl SlotStack {
    fn push(&mut self, slot: Slot) {
        self.slots.push(slot);
    }

    fn pop(&mut self) -> Slot {
        self.slots.pop().unwrap_or(Slot::Opaque)
    }

    fn dup_top(&mut self) {
        let top = self.slots.last().copied().unwrap_or(Slot::Opaque);
        self.slots.push(top);
    }

    fn open_frame(&mut self) {
        self.frames.push(self.slots.len());
    }

    fn dup_frame(&mut self) {
        let begin = self
            .frames
            .last()
            .copied()
            .unwrap_or(0)
            .min(self.slots.len());
        self.frames.push(self.slots.len());
        let dup = self.slots[begin..].to_vec();
        self.slots.extend(dup);
    }

    /// Remove the current frame's atoms; the caller pushes any result.
    fn close_frame(&mut self) {
        let begin = self.frames.pop().unwrap_or(0).min(self.slots.len());
        self.slots.truncate(begin);
    }

    fn pop_args(&mut self, n: usize) {
        for _ in 0..n {
            self.pop();
        }
    }
}

/// Stack values consumed by an argument-form list.
fn arg_value_count(forms: &[SiglusArgForm]) -> usize {
    forms
        .iter()
        .map(|form| match form {
            SiglusArgForm::Form(_) => 1,
            SiglusArgForm::List(items) => arg_value_count(items),
        })
        .sum()
}

/// Resolve a jump label index to an absolute target offset.
fn target_offset(label: i32, labels: &[i32]) -> Option<usize> {
    if label < 0 {
        return None;
    }
    let target = *labels.get(label as usize)?;
    if target < 0 {
        return None;
    }
    Some(target as usize)
}

/// The per-scene statement decode: named statements (full coverage), located
/// text/name surfaces, and the resolved jump table.
pub(super) struct StatementDecode {
    pub statements: Vec<SiglusStatement>,
    pub text_surfaces: Vec<SiglusTextSurface>,
    pub jumps: Vec<SiglusJump>,
    pub family_histogram: BTreeMap<String, usize>,
}

/// Decode every instruction into a named statement, harvesting text surfaces
/// and the resolved jump table. Full coverage: every instruction yields exactly
/// one statement (the family histogram carries zero `unknown` when the
/// partition is complete).
pub(super) fn build_statements(
    bytecode: &[u8],
    instructions: &[SiglusInstruction],
    labels: &[i32],
    strings: &SceneStrings,
) -> StatementDecode {
    let mut statements = Vec::with_capacity(instructions.len());
    let mut text_surfaces = Vec::new();
    let mut jumps = Vec::new();
    let mut family_histogram: BTreeMap<String, usize> = BTreeMap::new();
    let mut stack = SlotStack::default();

    for instruction in instructions {
        let operand = decode_operand(bytecode, instruction)
            .unwrap_or(SiglusOperand::Unknown(instruction.lead));
        let statement = classify(
            instruction,
            &operand,
            labels,
            strings,
            &mut stack,
            &mut text_surfaces,
            &mut jumps,
        );
        *family_histogram
            .entry(statement.family().to_string())
            .or_insert(0) += 1;
        statements.push(statement);
    }

    StatementDecode {
        statements,
        text_surfaces,
        jumps,
        family_histogram,
    }
}

/// Classify one instruction, driving the slot stack and harvesting surfaces /
/// jumps as a side effect.
fn classify(
    instruction: &SiglusInstruction,
    operand: &SiglusOperand,
    labels: &[i32],
    strings: &SceneStrings,
    stack: &mut SlotStack,
    text_surfaces: &mut Vec<SiglusTextSurface>,
    jumps: &mut Vec<SiglusJump>,
) -> SiglusStatement {
    let site = instruction.byte_offset;
    match (&instruction.opcode, operand) {
        (SiglusOpcode::Nl, SiglusOperand::Line(line)) => SiglusStatement::Line { line: *line },
        (SiglusOpcode::Push, SiglusOperand::Push(push)) => {
            stack.push(match push {
                SiglusPush::Str(index) => Slot::Str(*index),
                SiglusPush::Int(_) | SiglusPush::Form(_) => Slot::Opaque,
            });
            SiglusStatement::Structural { name: "push" }
        }
        (SiglusOpcode::Copy, _) => {
            stack.dup_top();
            SiglusStatement::Structural { name: "copy" }
        }
        (SiglusOpcode::ElmPoint, _) => {
            stack.open_frame();
            SiglusStatement::Structural { name: "elm_point" }
        }
        (SiglusOpcode::CopyElm, _) => {
            stack.dup_frame();
            SiglusStatement::Structural { name: "copy_elm" }
        }
        (SiglusOpcode::Property, _) => {
            stack.close_frame();
            stack.push(Slot::Opaque);
            SiglusStatement::Structural { name: "property" }
        }
        (SiglusOpcode::Operate1, SiglusOperand::Operate1(form, op)) => {
            stack.pop();
            stack.push(Slot::Opaque);
            match SiglusUnaryOp::from_byte(*op) {
                Some(unary) => SiglusStatement::Unary {
                    form: *form,
                    op: unary,
                },
                None => SiglusStatement::ArithUnsupported { op: *op, arity: 1 },
            }
        }
        (SiglusOpcode::Operate2, SiglusOperand::Operate2(left, right, op)) => {
            stack.pop();
            stack.pop();
            stack.push(Slot::Opaque);
            match SiglusBinaryOp::from_byte(*op) {
                Some(binary) => SiglusStatement::Binary {
                    left_form: *left,
                    right_form: *right,
                    op: binary,
                },
                None => SiglusStatement::ArithUnsupported { op: *op, arity: 2 },
            }
        }
        (SiglusOpcode::Assign, SiglusOperand::Assign(left, right, arg_list_id)) => {
            stack.pop();
            stack.close_frame();
            SiglusStatement::Assign {
                left_form: *left,
                right_form: *right,
                arg_list_id: *arg_list_id,
            }
        }
        (SiglusOpcode::Pop, SiglusOperand::Pop(form)) => {
            if *form != 0 {
                stack.pop();
                SiglusStatement::PopValue { form: *form }
            } else {
                SiglusStatement::Structural { name: "pop_void" }
            }
        }
        (SiglusOpcode::DecProp, SiglusOperand::DecProp(form, _)) => {
            if *form == 11 || *form == 21 {
                stack.pop();
            }
            SiglusStatement::Structural { name: "dec_prop" }
        }
        (SiglusOpcode::Text, SiglusOperand::Text(read_flag)) => {
            let surface = harvest_surface(site, false, Some(*read_flag), stack, strings);
            let index = text_surfaces.len();
            text_surfaces.push(surface);
            SiglusStatement::Text { surface: index }
        }
        (SiglusOpcode::Name, _) => {
            let surface = harvest_surface(site, true, None, stack, strings);
            let index = text_surfaces.len();
            text_surfaces.push(surface);
            SiglusStatement::Name { surface: index }
        }
        (SiglusOpcode::Goto, SiglusOperand::Goto(label)) => {
            push_jump(site, SiglusJumpKind::Goto, *label, labels, jumps)
        }
        (SiglusOpcode::GotoTrue, SiglusOperand::GotoTrue(label)) => {
            stack.pop();
            push_jump(site, SiglusJumpKind::GotoTrue, *label, labels, jumps)
        }
        (SiglusOpcode::GotoFalse, SiglusOperand::GotoFalse(label)) => {
            stack.pop();
            push_jump(site, SiglusJumpKind::GotoFalse, *label, labels, jumps)
        }
        (SiglusOpcode::Gosub, SiglusOperand::Gosub(label, forms)) => {
            stack.pop_args(arg_value_count(forms));
            stack.push(Slot::Opaque);
            push_jump(
                site,
                SiglusJumpKind::Gosub { returns_str: false },
                *label,
                labels,
                jumps,
            )
        }
        (SiglusOpcode::GosubStr, SiglusOperand::GosubStr(label, forms)) => {
            stack.pop_args(arg_value_count(forms));
            stack.push(Slot::Opaque);
            push_jump(
                site,
                SiglusJumpKind::Gosub { returns_str: true },
                *label,
                labels,
                jumps,
            )
        }
        (SiglusOpcode::Return, SiglusOperand::Return(forms)) => {
            let value_count = arg_value_count(forms);
            stack.pop_args(value_count);
            SiglusStatement::Return { value_count }
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
            let arg_count = arg_value_count(arg_forms);
            stack.pop_args(arg_count);
            stack.close_frame();
            if *ret_form != 0 {
                stack.push(Slot::Opaque);
            }
            SiglusStatement::Command {
                arg_list_id: *arg_list_id,
                arg_count,
                named_arg_count: named_arg_ids.len(),
                ret_form: *ret_form,
                read_flag: *read_flag,
            }
        }
        (SiglusOpcode::Arg, _) => SiglusStatement::Structural { name: "arg" },
        (SiglusOpcode::SelBlockStart, _) => SiglusStatement::Structural {
            name: "sel_block_start",
        },
        (SiglusOpcode::SelBlockEnd, _) => SiglusStatement::Structural {
            name: "sel_block_end",
        },
        (SiglusOpcode::Eof, _) => SiglusStatement::Structural { name: "eof" },
        (SiglusOpcode::Unknown { lead, .. }, _) => SiglusStatement::Unknown { lead: *lead },
        // Operand shape can only mismatch its opcode via a decode defect; treat
        // defensively as structural rather than panicking.
        _ => SiglusStatement::Structural { name: "other" },
    }
}

/// Harvest a text / name surface from the top-of-stack string slot.
fn harvest_surface(
    site: usize,
    is_name: bool,
    read_flag: Option<i32>,
    stack: &mut SlotStack,
    strings: &SceneStrings,
) -> SiglusTextSurface {
    let slot = stack.pop();
    let str_index = match slot {
        Slot::Str(index) => Some(index),
        Slot::Opaque => None,
    };
    let (str_byte_offset, str_char_len) = match str_index.and_then(|index| strings.resolve(index)) {
        Some((byte_offset, char_len)) => (Some(byte_offset), Some(char_len)),
        None => (None, None),
    };
    SiglusTextSurface {
        site_offset: site,
        is_name,
        read_flag,
        str_index,
        str_byte_offset,
        str_char_len,
    }
}

/// Record a resolved jump and return its `Jump` statement.
fn push_jump(
    site: usize,
    kind: SiglusJumpKind,
    label_index: i32,
    labels: &[i32],
    jumps: &mut Vec<SiglusJump>,
) -> SiglusStatement {
    let index = jumps.len();
    jumps.push(SiglusJump {
        site_offset: site,
        kind,
        label_index,
        target_offset: target_offset(label_index, labels),
    });
    SiglusStatement::Jump { jump: index }
}

/// How far past a selection command the choice-dispatch scan looks.
const CHOICE_SCAN_BUDGET: usize = 64;

/// Recognize select→conditional-jump choice units: a value-returning command
/// whose result is dispatched by a contiguous ladder of ≥2 arms, each
/// `PUSH int k ; (compare eq/ne) ; GOTO_TRUE/FALSE → target`, with distinct
/// constants and distinct targets. Each arm links a choice constant to its
/// branch target. (Whether a given selector is a player-facing menu vs an
/// internal value dispatch is refined by the syscall decoder.)
pub(super) fn recognize_choices(
    bytecode: &[u8],
    instructions: &[SiglusInstruction],
    labels: &[i32],
) -> Vec<SiglusChoiceUnit> {
    let mut units = Vec::new();
    for (i, instruction) in instructions.iter().enumerate() {
        let ret_form = match (&instruction.opcode, decode_operand(bytecode, instruction)) {
            (SiglusOpcode::Command { .. }, Ok(SiglusOperand::Command { ret_form, .. }))
                if ret_form != 0 =>
            {
                ret_form
            }
            _ => continue,
        };
        if let Some(arms) = scan_dispatch_ladder(bytecode, instructions, i, labels) {
            units.push(SiglusChoiceUnit {
                select_offset: instruction.byte_offset,
                select_ret_form: ret_form,
                arms,
            });
        }
    }
    units
}

/// Scan forward from a selection command for its dispatch ladder; return the
/// linked arms when ≥2 distinct-constant, distinct-target arms are found.
fn scan_dispatch_ladder(
    bytecode: &[u8],
    instructions: &[SiglusInstruction],
    select_index: usize,
    labels: &[i32],
) -> Option<Vec<SiglusChoiceArm>> {
    let mut arms: Vec<SiglusChoiceArm> = Vec::new();
    let mut seen_const = std::collections::BTreeSet::new();
    let mut seen_target = std::collections::BTreeSet::new();
    let mut last_int: Option<i32> = None;

    let end = (select_index + 1 + CHOICE_SCAN_BUDGET).min(instructions.len());
    for instruction in &instructions[select_index + 1..end] {
        match (&instruction.opcode, decode_operand(bytecode, instruction)) {
            (SiglusOpcode::Push, Ok(SiglusOperand::Push(SiglusPush::Int(value)))) => {
                last_int = Some(value);
            }
            (SiglusOpcode::GotoTrue, Ok(SiglusOperand::GotoTrue(label)))
            | (SiglusOpcode::GotoFalse, Ok(SiglusOperand::GotoFalse(label))) => {
                if let Some(value) = last_int.take() {
                    let target = target_offset(label, labels);
                    let target_key = target.map_or(-1, |t| t as i64);
                    if seen_const.insert(value) && seen_target.insert(target_key) {
                        arms.push(SiglusChoiceArm {
                            compare_value: value,
                            jump_site_offset: instruction.byte_offset,
                            target_offset: target,
                        });
                    }
                }
            }
            // A text/name run, another command, or an unconditional goto ends
            // the contiguous dispatch ladder.
            (
                SiglusOpcode::Text
                | SiglusOpcode::Name
                | SiglusOpcode::Command { .. }
                | SiglusOpcode::Goto,
                _,
            ) => break,
            _ => {}
        }
    }

    if arms.len() >= 2 { Some(arms) } else { None }
}
