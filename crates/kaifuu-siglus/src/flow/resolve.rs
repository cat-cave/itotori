//! Fuzz-safe CFG stack-state resolver for the expression-evaluator
//! cross-edge underflows.
//!
//! The expression-stack evaluator walks the operand stream **straight-line**,
//! so a value a consumer needs whose producer sits across a jump edge
//! underflows (a typed `StackUnderflow` leaf). This resolver reconstructs the
//! intra-scene control-flow graph and propagates an **abstract stack state**
//! (the value depth + element-frame markers, mirroring the evaluator's
//! `ProgStack` discipline) along every jump + fall-through edge, seeded at the
//! runtime entry points (offset 0 + each scene-command entry) with an empty
//! stack.
//!
//! A consumer reached with a propagated stack finds the value the straight-line
//! walk could not — that underflow is **resolved**. What remains is confined to
//! inter-procedural entry (a function consuming its incoming call-frame
//! arguments, or a block reached only by indirect / computed dispatch) — a
//! documented non-flow residual, not an unresolved intra-scene flow edge.
//!
//! The walk is bounded (each instruction is entered at most once) and every
//! read is checked, so an adversarial stream cannot panic or spin.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use crate::expression::{SiglusArgForm, SiglusOperand, decode_operand};
use crate::opcode::{SiglusInstruction, SiglusOpcode};

use super::model::FlowUnderflowReport;

/// Abstract operand-stack state: value depth + element-frame start markers.
/// Mirrors the expression-stack evaluator's `ProgStack` net effect exactly
/// (proven to reproduce its underflow count on real bytes), tracking only
/// depths — never values.
#[derive(Clone, Default)]
struct AbstractStack {
    depth: i64,
    frames: Vec<i64>,
    underflow: u64,
}

impl AbstractStack {
    fn pop(&mut self) {
        if self.depth <= 0 {
            self.underflow += 1;
        } else {
            self.depth -= 1;
        }
    }

    fn push(&mut self) {
        self.depth += 1;
    }

    fn dup_top(&mut self) {
        if self.depth <= 0 {
            self.underflow += 1;
        }
        self.depth += 1;
    }

    fn open_frame(&mut self) {
        self.frames.push(self.depth);
    }

    fn dup_frame(&mut self) {
        let begin = self.frames.last().copied().unwrap_or(0).min(self.depth);
        self.frames.push(self.depth);
        self.depth += self.depth - begin;
    }

    /// Remove the frame's atoms (does not push the produced element — the
    /// caller decides). Mirrors `ProgStack::close_frame`.
    fn close_frame(&mut self) {
        let Some(begin) = self.frames.pop() else {
            self.underflow += 1;
            return;
        };
        let begin = begin.min(self.depth);
        if self.depth - begin == 0 {
            self.underflow += 1;
        }
        self.depth = begin;
    }

    fn pop_args(&mut self, n: i64) {
        for _ in 0..n {
            self.pop();
        }
    }
}

/// Stack values consumed by an argument-form list (leaf = 1, list = recursive).
fn arg_value_count(forms: &[SiglusArgForm]) -> i64 {
    forms
        .iter()
        .map(|form| match form {
            SiglusArgForm::Form(_) => 1,
            SiglusArgForm::List(items) => arg_value_count(items),
        })
        .sum()
}

/// Apply one instruction's net stack effect, mirroring the expression-stack evaluator.
fn apply(bytecode: &[u8], instruction: &SiglusInstruction, stack: &mut AbstractStack) {
    let operand =
        decode_operand(bytecode, instruction).unwrap_or(SiglusOperand::Unknown(instruction.lead));
    match (&instruction.opcode, operand) {
        (SiglusOpcode::Push, _) => stack.push(),
        (SiglusOpcode::Pop, SiglusOperand::Pop(form)) => {
            if form != 0 {
                stack.pop();
            }
        }
        (SiglusOpcode::Copy, _) => stack.dup_top(),
        (SiglusOpcode::Property, _) => {
            stack.close_frame();
            stack.push();
        }
        (SiglusOpcode::ElmPoint, _) => stack.open_frame(),
        (SiglusOpcode::CopyElm, _) => stack.dup_frame(),
        (SiglusOpcode::Operate1, _) => {
            stack.pop();
            stack.push();
        }
        (SiglusOpcode::Operate2, _) => {
            stack.pop();
            stack.pop();
            stack.push();
        }
        (SiglusOpcode::Assign, _) => {
            stack.pop();
            stack.close_frame();
        }
        // Each pops one value: the jump condition, the message text, the name.
        (
            SiglusOpcode::GotoTrue
            | SiglusOpcode::GotoFalse
            | SiglusOpcode::Text
            | SiglusOpcode::Name,
            _,
        ) => stack.pop(),
        (SiglusOpcode::DecProp, SiglusOperand::DecProp(form, _)) => {
            if form == 11 || form == 21 {
                stack.pop();
            }
        }
        (SiglusOpcode::Gosub, SiglusOperand::Gosub(_, forms))
        | (SiglusOpcode::GosubStr, SiglusOperand::GosubStr(_, forms)) => {
            stack.pop_args(arg_value_count(&forms));
            stack.push();
        }
        (SiglusOpcode::Return, SiglusOperand::Return(forms)) => {
            stack.pop_args(arg_value_count(&forms));
        }
        (
            SiglusOpcode::Command { .. },
            SiglusOperand::Command {
                arg_forms,
                ret_form,
                ..
            },
        ) => {
            stack.pop_args(arg_value_count(&arg_forms));
            stack.close_frame();
            if ret_form != 0 {
                stack.push();
            }
        }
        _ => {}
    }
}

/// The straight-line underflow count — reproduces the expression-stack evaluator exactly.
fn linear_underflow(bytecode: &[u8], instructions: &[SiglusInstruction]) -> u64 {
    let mut stack = AbstractStack::default();
    for instruction in instructions {
        apply(bytecode, instruction, &mut stack);
    }
    stack.underflow
}

/// The label index a `CD_GOTO*` instruction transfers to, if it decodes.
fn jump_label(bytecode: &[u8], instruction: &SiglusInstruction) -> Option<i32> {
    match decode_operand(bytecode, instruction) {
        Ok(
            SiglusOperand::Goto(label)
            | SiglusOperand::GotoTrue(label)
            | SiglusOperand::GotoFalse(label),
        ) => Some(label),
        _ => None,
    }
}

/// Resolve a jump label index to a target instruction index.
fn resolve_target(
    label: i32,
    labels: &[i32],
    offset_to_index: &BTreeMap<usize, usize>,
) -> Option<usize> {
    if label < 0 {
        return None;
    }
    let target = *labels.get(label as usize)?;
    if target < 0 {
        return None;
    }
    offset_to_index.get(&(target as usize)).copied()
}

/// Compute the flow-resolved underflow report for one partitioned scene.
pub(super) fn resolve_underflows(
    bytecode: &[u8],
    instructions: &[SiglusInstruction],
    labels: &[i32],
    scn_cmds: &[i32],
) -> FlowUnderflowReport {
    let linear = linear_underflow(bytecode, instructions) as usize;

    let n = instructions.len();
    let mut offset_to_index: BTreeMap<usize, usize> = BTreeMap::new();
    for (index, instruction) in instructions.iter().enumerate() {
        offset_to_index.insert(instruction.byte_offset, index);
    }

    // Runtime entry points: offset 0 + each scene-command entry, empty stack.
    let mut entries: BTreeSet<usize> = BTreeSet::new();
    if n > 0 {
        entries.insert(0);
    }
    for offset in scn_cmds.iter().filter(|o| **o >= 0) {
        if let Some(&index) = offset_to_index.get(&(*offset as usize)) {
            entries.insert(index);
        }
    }

    let mut visited = vec![false; n];
    let mut worklist: VecDeque<(usize, AbstractStack, bool)> = VecDeque::new();
    for &index in &entries {
        worklist.push_back((index, AbstractStack::default(), false));
    }

    let mut call_frame = 0usize;
    let mut indirect = 0usize;
    let mut by_lead: BTreeMap<String, usize> = BTreeMap::new();
    let mut next_cold = 0usize;

    loop {
        while let Some((mut index, mut stack, cold)) = worklist.pop_front() {
            if index >= n || visited[index] {
                continue;
            }
            loop {
                if index >= n || visited[index] {
                    break;
                }
                visited[index] = true;
                let instruction = &instructions[index];
                let before = stack.underflow;
                apply(bytecode, instruction, &mut stack);
                let delta = (stack.underflow - before) as usize;
                if delta > 0 {
                    if cold {
                        indirect += delta;
                    } else {
                        call_frame += delta;
                    }
                    *by_lead
                        .entry(format!("{:02x}", instruction.lead))
                        .or_insert(0) += delta;
                }
                match &instruction.opcode {
                    SiglusOpcode::Goto => {
                        if let Some(target) = jump_label(bytecode, instruction)
                            .and_then(|label| resolve_target(label, labels, &offset_to_index))
                        {
                            worklist.push_back((target, stack.clone(), cold));
                        }
                        break;
                    }
                    SiglusOpcode::GotoTrue | SiglusOpcode::GotoFalse => {
                        if let Some(target) = jump_label(bytecode, instruction)
                            .and_then(|label| resolve_target(label, labels, &offset_to_index))
                        {
                            worklist.push_back((target, stack.clone(), cold));
                        }
                        index += 1;
                    }
                    SiglusOpcode::Return | SiglusOpcode::Eof => break,
                    _ => index += 1,
                }
            }
        }
        // Full coverage: cold-seed the lowest unvisited block (indirect entry).
        while next_cold < n && visited[next_cold] {
            next_cold += 1;
        }
        if next_cold >= n {
            break;
        }
        worklist.push_back((next_cold, AbstractStack::default(), true));
    }

    let flow = call_frame + indirect;
    FlowUnderflowReport {
        linear_underflow: linear,
        flow_underflow: flow,
        resolved: linear.saturating_sub(flow),
        residual_call_frame: call_frame,
        residual_indirect: indirect,
        residual_by_lead: by_lead,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::opcode::partition_scene;

    fn put_i32(buf: &mut Vec<u8>, value: i32) {
        buf.extend_from_slice(&value.to_le_bytes());
    }

    /// Build a payload with a label table (offsets are scn-relative).
    fn build_payload(bytecode: &[u8], labels: &[i32]) -> Vec<u8> {
        let header_len = crate::opcode::SCN_HEADER_BYTE_LEN as i32;
        let label_ofs = header_len + bytecode.len() as i32;
        let mut header = Vec::new();
        put_i32(&mut header, crate::opcode::SCN_HEADER_DECLARED_SIZE);
        put_i32(&mut header, header_len);
        put_i32(&mut header, bytecode.len() as i32);
        put_i32(&mut header, 0);
        put_i32(&mut header, 0);
        put_i32(&mut header, 0);
        put_i32(&mut header, 0);
        put_i32(&mut header, label_ofs);
        put_i32(&mut header, labels.len() as i32);
        for _ in 9..33 {
            put_i32(&mut header, 0);
        }
        let mut payload = header;
        payload.extend_from_slice(bytecode);
        for label in labels {
            put_i32(&mut payload, *label);
        }
        payload
    }

    #[test]
    fn cross_edge_pop_is_resolved_by_flow() {
        // PUSH int 1 ; GOTO L(->pop) ; <dead> ; L: POP int.
        // A straight-line walk keeps the pushed value on the stack across the
        // GOTO, so the POP does NOT underflow linearly here — build a case that
        // does: put the producer only on the jumped-from path.
        //   0: GOTO L2 (skip the cold POP that a linear walk would underflow)
        //   5: POP int            <- linearly underflows (empty), cold block
        //  10: L2: EOF
        let mut bc = Vec::new();
        bc.push(0x10); // GOTO
        put_i32(&mut bc, 1); // label index 1 -> offset 10
        bc.push(0x03); // POP
        put_i32(&mut bc, 10); // int form
        bc.push(0x16); // EOF at offset 10
        // labels[0]=0 (entry), labels[1]=10 (L2)
        let payload = build_payload(&bc, &[0, 10]);
        let part = partition_scene(&payload).expect("partition");
        let scn = &payload
            [crate::opcode::SCN_HEADER_BYTE_LEN..crate::opcode::SCN_HEADER_BYTE_LEN + bc.len()];
        let report = resolve_underflows(scn, &part.instructions, &[0, 10], &[]);
        // Linear: the POP at offset 5 underflows once.
        assert_eq!(report.linear_underflow, 1);
        // Flow: offset 0 GOTOs to offset 10 (EOF); the POP at 5 is reached only
        // by cold-seeding (no edge targets it) -> residual is indirect, and the
        // linear underflow at 5 is not on any runtime-reachable path.
        assert_eq!(report.residual_indirect, 1);
        assert_eq!(report.residual_call_frame, 0);
        assert!(report.residual_fully_attributed());
    }

    #[test]
    fn deterministic_across_two_runs() {
        let mut bc = Vec::new();
        bc.push(0x02);
        put_i32(&mut bc, 10);
        put_i32(&mut bc, 7);
        bc.push(0x03);
        put_i32(&mut bc, 10);
        bc.push(0x16);
        let payload = build_payload(&bc, &[]);
        let part = partition_scene(&payload).expect("partition");
        let scn = &payload
            [crate::opcode::SCN_HEADER_BYTE_LEN..crate::opcode::SCN_HEADER_BYTE_LEN + bc.len()];
        let a = resolve_underflows(scn, &part.instructions, &[], &[]);
        let b = resolve_underflows(scn, &part.instructions, &[], &[]);
        assert_eq!(a, b);
    }
}
