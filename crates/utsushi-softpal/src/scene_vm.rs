//! Sv20 execution: values, branches, calls, and honest stop diagnostics.
use crate::native_callback_registry::NativeCallbackRegistry;
use crate::scene_runtime::{ChoiceOption, RuntimeDiagnostic, SceneStep, SoftpalRuntimeError};
use kaifuu_softpal::{CommandFamily, Instruction, OpcodeScan, Operand, OperandTag, RawCommand};
use std::collections::{BTreeMap, HashMap};
#[derive(Default)]
struct Frame {
    locals: BTreeMap<u32, i32>,
    arguments: Vec<i32>,
}
/// Parse `POINT.DAT`: its stored offsets are relative to the 12-byte code
/// header and are listed in reverse label order.
pub(crate) fn point_offsets(bytes: &[u8]) -> Result<Vec<usize>, SoftpalRuntimeError> {
    if bytes.len() < 16 || !matches!(&bytes[..16], b"$POINT_LIST_****" | b"_POINT_LIST_****") {
        return Err(SoftpalRuntimeError::InvalidPointTable);
    }
    let encrypted = bytes[0] == b'$'
        && bytes.get(16..20).is_some_and(|word| {
            u32::from_le_bytes(word.try_into().expect("four bytes")) & 0xff00_0000 != 0
        });
    let mut offsets = Vec::new();
    let mut shift = 4u32;
    for chunk in bytes[16..].chunks_exact(4) {
        let mut raw = u32::from_le_bytes(chunk.try_into().expect("four bytes"));
        if encrypted {
            let mut parts = raw.to_le_bytes();
            parts[0] = parts[0].rotate_left(shift);
            raw = u32::from_le_bytes(parts) ^ 0x084d_f873 ^ 0xff98_7dee;
            shift = (shift + 1) % 8;
        }
        offsets
            .push(usize::try_from(raw).map_err(|_| SoftpalRuntimeError::InvalidPointTable)? + 12);
    }
    offsets.reverse();
    Ok(offsets)
}
pub(crate) struct Vm<'a> {
    instructions: &'a [Instruction],
    by_offset: HashMap<usize, usize>,
    labels: &'a [usize],
    commands: HashMap<usize, &'a RawCommand>,
    texts: &'a HashMap<u32, String>,
    frames: Vec<Frame>,
    globals: BTreeMap<u32, i32>,
    shared: BTreeMap<u32, i32>,
    returns: Vec<usize>,
    stack: Vec<i32>,
    ip: usize,
    steps: Vec<SceneStep>,
    diagnostics: Vec<RuntimeDiagnostic>,
    branches: usize,
    instruction_count: usize,
}

impl<'a> Vm<'a> {
    pub(crate) fn new(
        scan: &'a OpcodeScan,
        commands: &'a [RawCommand],
        labels: &'a [usize],
        texts: &'a HashMap<u32, String>,
    ) -> Self {
        let by_offset = scan
            .instructions
            .iter()
            .enumerate()
            .map(|(index, instruction)| (instruction.offset, index))
            .collect();
        let commands = commands
            .iter()
            .map(|command| (command_call_offset(command), command))
            .collect();
        Self {
            instructions: &scan.instructions,
            by_offset,
            labels,
            commands,
            texts,
            frames: vec![Frame::default()],
            globals: BTreeMap::new(),
            shared: BTreeMap::new(),
            returns: Vec::new(),
            stack: Vec::new(),
            ip: 0,
            steps: Vec::new(),
            diagnostics: Vec::new(),
            branches: 0,
            instruction_count: 0,
        }
    }

    pub(crate) fn run(mut self) -> VmResult {
        while let Some(instruction) = self.instructions.get(self.ip).copied() {
            self.instruction_count += 1;
            if self.instruction_count > self.instructions.len().saturating_mul(64).max(1) {
                self.stop("execution_limit", instruction.offset);
                break;
            }
            let next = self.ip + 1;
            match instruction.opcode.id() {
                0x01..=0x08 | 0x0c..=0x14 | 0x1a..=0x1d => {
                    if !self.expression(instruction) {
                        break;
                    }
                    self.ip = next;
                }
                0x09 => {
                    if !self.jump(instruction, true) {
                        break;
                    }
                }
                0x0a => {
                    if !self.conditional_jump(instruction, next) {
                        break;
                    }
                }
                0x0b => {
                    if !self.call(instruction, next) {
                        break;
                    }
                }
                0x1e => {
                    if !self.pop(instruction) {
                        break;
                    }
                    self.ip = next;
                }
                0x1f => {
                    if !self.push(instruction) {
                        break;
                    }
                    self.ip = next;
                }
                0x15 => break,
                0x18 => {
                    let Some(return_ip) = self.returns.pop() else {
                        break;
                    };
                    if self.frames.len() > 1 {
                        self.frames.pop();
                    }
                    self.ip = return_ip;
                }
                0x17 => {
                    if !self.dispatch(instruction) {
                        break;
                    }
                    self.ip = next;
                }
                _ => self.ip = next,
            }
        }
        VmResult {
            steps: self.steps,
            diagnostics: self.diagnostics,
            branches: self.branches,
            instructions: self.instruction_count,
        }
    }

    fn expression(&mut self, instruction: Instruction) -> bool {
        let operands = instruction.operands();
        let Some(destination) = operands.first().copied() else {
            return self.bad("missing_operand", instruction.offset);
        };
        let Some(left) = self.value(destination, instruction.offset) else {
            return false;
        };
        let right = operands
            .get(1)
            .and_then(|operand| self.value(*operand, instruction.offset));
        let result = match instruction.opcode.id() {
            0x01 => right,
            0x02 => right.map(|r| left.wrapping_add(r)),
            0x03 => right.map(|r| left.wrapping_sub(r)),
            0x04 => right.map(|r| left.wrapping_mul(r)),
            0x05 => right.and_then(|r| left.checked_div(r)),
            0x06 => right.map(|r| left & r),
            0x07 => right.map(|r| left | r),
            0x08 => right.map(|r| left ^ r),
            0x0c => right.map(|r| i32::from(left == r)),
            0x0d => right.map(|r| i32::from(left != r)),
            0x0e => right.map(|r| i32::from(left <= r)),
            0x0f => right.map(|r| i32::from(left >= r)),
            0x10 => right.map(|r| i32::from(left < r)),
            0x11 => right.map(|r| i32::from(left > r)),
            0x12 => right.map(|r| i32::from(left != 0 || r != 0)),
            0x13 => right.map(|r| i32::from(left != 0 && r != 0)),
            0x14 => Some(i32::from(left == 0)),
            0x1a => right.and_then(|r| left.checked_rem(r)),
            0x1b => right.map(|r| left.wrapping_shl(r as u32)),
            0x1c => right.map(|r| left.wrapping_shr(r as u32)),
            0x1d => Some(left.wrapping_neg()),
            _ => None,
        };
        let Some(result) = result else {
            return self.bad("invalid_expression", instruction.offset);
        };
        self.store(destination, result, instruction.offset)
    }

    fn conditional_jump(&mut self, instruction: Instruction, next: usize) -> bool {
        let operands = instruction.operands();
        let Some(condition) = operands
            .get(1)
            .and_then(|operand| self.value(*operand, instruction.offset))
        else {
            return false;
        };
        self.branches += 1;
        if condition == 0 {
            self.jump(instruction, true)
        } else {
            self.steps.push(SceneStep::Branch {
                command_offset: instruction.offset,
                taken: false,
                target_offset: None,
            });
            self.ip = next;
            true
        }
    }

    fn jump(&mut self, instruction: Instruction, taken: bool) -> bool {
        let Some(label) = instruction
            .operands()
            .first()
            .and_then(|operand| self.label(*operand, instruction.offset))
        else {
            return false;
        };
        self.branches += usize::from(taken);
        self.steps.push(SceneStep::Branch {
            command_offset: instruction.offset,
            taken,
            target_offset: Some(label),
        });
        let Some(ip) = self.by_offset.get(&label).copied() else {
            return self.bad("jump_target_not_instruction", instruction.offset);
        };
        self.ip = ip;
        true
    }

    fn call(&mut self, instruction: Instruction, next: usize) -> bool {
        let Some(target) = instruction
            .operands()
            .first()
            .and_then(|operand| self.label(*operand, instruction.offset))
        else {
            return false;
        };
        let Some(ip) = self.by_offset.get(&target).copied() else {
            return self.bad("call_target_not_instruction", instruction.offset);
        };
        let argc = self
            .instructions
            .get(ip)
            .filter(|entry| entry.opcode.id() == 0x20)
            .and_then(|entry| entry.operands().first())
            .and_then(|operand| self.value(*operand, instruction.offset));
        let Some(argc) = argc.and_then(|count| usize::try_from(count).ok()) else {
            return self.bad("call_target_without_enter", instruction.offset);
        };
        if self.stack.len() < argc {
            return self.bad("call_stack_underflow", instruction.offset);
        }
        let arguments = self.stack.split_off(self.stack.len() - argc);
        self.returns.push(next);
        self.frames.push(Frame {
            locals: BTreeMap::new(),
            arguments,
        });
        self.ip = ip;
        true
    }

    fn push(&mut self, instruction: Instruction) -> bool {
        let Some(value) = instruction
            .operands()
            .first()
            .and_then(|operand| self.value(*operand, instruction.offset))
        else {
            return false;
        };
        self.stack.push(value);
        true
    }

    fn pop(&mut self, instruction: Instruction) -> bool {
        let Some(value) = self.stack.pop() else {
            return self.bad("pop_stack_underflow", instruction.offset);
        };
        let Some(destination) = instruction.operands().first().copied() else {
            return self.bad("missing_operand", instruction.offset);
        };
        self.store(destination, value, instruction.offset)
    }

    fn dispatch(&mut self, instruction: Instruction) -> bool {
        match instruction.family {
            CommandFamily::TextShow { .. } => self.emit_dialogue(instruction.offset),
            CommandFamily::Select => self.emit_choice(instruction.offset),
            CommandFamily::Call { target }
                if (target.category, target.function) == (0x0011, 0x001c) =>
            {
                if NativeCallbackRegistry::default().invoke(|_| {}) == 0 {
                    self.diagnostics.push(RuntimeDiagnostic {
                        signature: "native_callback_registry_population_unavailable".to_string(),
                        offset: instruction.offset,
                    });
                }
                true
            }
            CommandFamily::Call { target } if target.semantic_name().is_some() => true,
            CommandFamily::Call { target } => self.bad(
                &format!("call_{:04x}_{:04x}", target.category, target.function),
                instruction.offset,
            ),
            _ => true,
        }
    }

    fn emit_dialogue(&mut self, offset: usize) -> bool {
        let Some(RawCommand::TextShow { command_offset, .. }) = self.commands.get(&offset).copied()
        else {
            return self.bad("text_command_shape", offset);
        };
        let Some((speaker, text)) = self.resolved_text(*command_offset) else {
            return self.bad("unresolved_text_command", offset);
        };
        self.flush_choice();
        self.steps.push(SceneStep::Dialogue {
            command_offset: *command_offset,
            speaker,
            text,
        });
        true
    }

    fn emit_choice(&mut self, offset: usize) -> bool {
        let Some(RawCommand::Select { command_offset, .. }) = self.commands.get(&offset).copied()
        else {
            return self.bad("select_command_shape", offset);
        };
        let text = self.resolved_choice(*command_offset);
        match self.steps.last_mut() {
            Some(SceneStep::Choice { options, .. }) => options.push(ChoiceOption {
                command_offset: *command_offset,
                text,
            }),
            _ => self.steps.push(SceneStep::Choice {
                options: vec![ChoiceOption {
                    command_offset: *command_offset,
                    text,
                }],
                selected: 0,
            }),
        }
        true
    }

    fn flush_choice(&mut self) {
        if let Some(SceneStep::Choice { options, selected }) = self.steps.last_mut() {
            *selected = options
                .iter()
                .position(ChoiceOption::is_text_bearing)
                .unwrap_or(0);
        }
    }

    fn resolved_text(&self, command_offset: usize) -> Option<(Option<String>, String)> {
        let RawCommand::TextShow {
            text_pointer,
            name_pointer,
            ..
        } = self
            .commands
            .values()
            .find(|command| command.command_offset() == command_offset)?
            .to_owned()
        else {
            return None;
        };
        let lookup = self.texts;
        Some((
            name_pointer.and_then(|pointer| lookup.get(&pointer).cloned()),
            lookup.get(text_pointer)?.clone(),
        ))
    }

    fn resolved_choice(&self, command_offset: usize) -> Option<String> {
        let RawCommand::Select {
            text_pointer,
            decoupled_label,
            ..
        } = self
            .commands
            .values()
            .find(|command| command.command_offset() == command_offset)?
            .to_owned()
        else {
            return None;
        };
        let lookup = self.texts;
        lookup
            .get(text_pointer)
            .or_else(|| decoupled_label.and_then(|label| lookup.get(&label.pointer)))
            .cloned()
    }

    fn value(&mut self, operand: Operand, offset: usize) -> Option<i32> {
        match operand.tag() {
            OperandTag::PLAIN => Some(sign_extend_28(operand.raw)),
            OperandTag::TYPED => Some(
                *self
                    .frames
                    .last()?
                    .locals
                    .get(&(operand.raw & 0x0fff_ffff))
                    .unwrap_or(&0),
            ),
            OperandTag::VAR => self
                .frames
                .last()?
                .arguments
                .get((operand.raw & 0x0fff_ffff).saturating_sub(1) as usize)
                .copied()
                .or(Some(0)),
            OperandTag(0x2) => Some(*self.shared.get(&(operand.raw & 0x0fff_ffff)).unwrap_or(&0)),
            OperandTag(0x9) => Some(*self.globals.get(&(operand.raw & 0x0fff_ffff)).unwrap_or(&0)),
            OperandTag::SENTINEL if operand.raw == u32::MAX => Some(-1),
            tag => {
                self.stop(&format!("operand_tag_{:02x}", tag.0), offset);
                None
            }
        }
    }

    fn store(&mut self, operand: Operand, value: i32, offset: usize) -> bool {
        match operand.tag() {
            OperandTag::TYPED => {
                self.frames
                    .last_mut()
                    .expect("initial frame")
                    .locals
                    .insert(operand.raw & 0x0fff_ffff, value);
            }
            OperandTag(0x2) => {
                self.shared.insert(operand.raw & 0x0fff_ffff, value);
            }
            OperandTag(0x9) => {
                self.globals.insert(operand.raw & 0x0fff_ffff, value);
            }
            _ => return self.bad("nonlocal_destination", offset),
        }
        true
    }

    fn label(&mut self, operand: Operand, offset: usize) -> Option<usize> {
        if operand.tag() != OperandTag::PLAIN || operand.raw == 0 {
            self.stop("invalid_label_operand", offset);
            return None;
        }
        self.labels
            .get((operand.raw - 1) as usize)
            .copied()
            .or_else(|| {
                self.stop("label_out_of_range", offset);
                None
            })
    }

    fn bad(&mut self, signature: &str, offset: usize) -> bool {
        self.stop(signature, offset);
        false
    }
    fn stop(&mut self, signature: &str, offset: usize) {
        self.diagnostics.push(RuntimeDiagnostic {
            signature: signature.to_string(),
            offset,
        });
    }
}

fn command_call_offset(command: &RawCommand) -> usize {
    match command {
        RawCommand::TextShow { command_offset, .. } => command_offset + 24,
        RawCommand::Select { command_offset, .. } => command_offset + 8,
    }
}
fn sign_extend_28(raw: u32) -> i32 {
    ((raw & 0x0fff_ffff) as i32) << 4 >> 4
}

pub(crate) struct VmResult {
    pub(crate) steps: Vec<SceneStep>,
    pub(crate) diagnostics: Vec<RuntimeDiagnostic>,
    pub(crate) branches: usize,
    pub(crate) instructions: usize,
}
