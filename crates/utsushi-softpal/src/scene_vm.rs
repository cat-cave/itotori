//! Sv20 execution: values, branches, calls, and honest stop diagnostics.
use crate::scene_runtime::{ChoiceOption, RuntimeDiagnostic, SceneStep};
use kaifuu_softpal::{CommandFamily, Instruction, OpcodeScan, Operand, OperandTag, RawCommand};
use std::collections::{BTreeMap, HashMap};
mod scene_vm_calls;
mod scene_vm_support;
pub(crate) use scene_vm_support::point_offsets;
#[derive(Default)]
struct Frame {
    locals: BTreeMap<u32, i32>,
    arguments: Vec<i32>,
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
    /// Category `0x0011:0x001c` work-process attachment; no launcher data is invented.
    work_process_attached: bool,
    /// Category `0x000f:0x0005` exchanges this PAL-owned mode value.
    debug_window_state: i32,
    /// Category `0x0009:0x0034` cancels this native scene-skip latch.
    ///
    /// The compact VM has no scene-skip producer yet, but retaining the latch
    /// makes this a state transition rather than an invisible pass-through.
    scene_skip_active: bool,
    /// Category `0x0009:0x0002` controls timer-based ADV progression.
    text_auto_enabled: bool,
    /// Category `0x0009:0x0000` controls user-triggered ADV skipping.
    text_skip_enabled: bool,
    /// Slots currently represented by the compact system-button model.
    system_button_slots: std::collections::BTreeSet<i32>,
    /// Category `0x0009:0x000e` clears this PAL-owned temporary work bank.
    scene_scratch: BTreeMap<u32, i32>,
    /// Active category-17 action counters in the compact scheduler model.
    active_actions: std::collections::BTreeSet<i32>,
    /// Live category-3 sprite slots known to the compact scene state.
    sprite_slots: std::collections::BTreeSet<i32>,
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
            .map(|command| (scene_vm_support::command_call_offset(command), command))
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
            work_process_attached: false,
            debug_window_state: 0,
            scene_skip_active: false,
            text_auto_enabled: false,
            text_skip_enabled: false,
            system_button_slots: std::collections::BTreeSet::new(),
            scene_scratch: BTreeMap::new(),
            active_actions: std::collections::BTreeSet::new(),
            sprite_slots: std::collections::BTreeSet::new(),
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
                // The compact call model transfers arguments at `0x0b`.
                0x20 | 0x21 => {
                    let operation = if instruction.opcode.id() == 0x20 {
                        "pack_args"
                    } else {
                        "drop_args"
                    };
                    if !scene_vm_calls::verify_frame_argument_count(
                        &mut self,
                        instruction,
                        operation,
                    ) {
                        break;
                    }
                    self.ip = next;
                }
                // Sena identifies 0x16 as an intentionally state-free `nop`.
                0x16 => self.ip = next,
                // A future opcode is visible at its instruction offset.
                opcode => {
                    self.bad(
                        &format!("unimplemented_opcode_{opcode:02x}"),
                        instruction.offset,
                    );
                    break;
                }
            }
        }
        VmResult {
            steps: self.steps,
            diagnostics: self.diagnostics,
            branches: self.branches,
            instructions: self.instruction_count,
            work_process_attached: self.work_process_attached,
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
                self.work_process_attached = true;
                scene_vm_calls::write_call_result(self, instruction, 1)
            }
            CommandFamily::Call { target }
                if (target.category, target.function) == (0x000f, 0x0005) =>
            {
                let Some(new_state) = self.stack.pop() else {
                    return self.bad("debug_window_set_stack_underflow", instruction.offset);
                };
                let old_state = self.debug_window_state;
                self.debug_window_state = new_state;
                scene_vm_calls::write_call_result(self, instruction, old_state)
            }
            // Sena's category-9 handler 52 consumes no VM arguments, cancels
            // its native scene-skip latch, and reports success to the extcall
            // destination. The native save-point update remains intentionally
            // unmodeled: it is conditional on a scene-skip state this compact
            // VM does not otherwise represent.
            CommandFamily::Call { target }
                if (target.category, target.function) == (0x0009, 0x0034) =>
            {
                self.scene_skip_active = false;
                scene_vm_calls::write_call_result(self, instruction, 1)
            }
            // `auto_set` consumes the requested auto-advance flag, stores its
            // boolean form in the ADV text state, and returns success.
            CommandFamily::Call { target }
                if (target.category, target.function) == (0x0009, 0x0002) =>
            {
                let Some(enabled) = self.stack.pop() else {
                    return self.bad("auto_set_stack_underflow", instruction.offset);
                };
                self.text_auto_enabled = enabled != 0;
                scene_vm_calls::write_call_result(self, instruction, 1)
            }
            // `system_btn_release` consumes one slot id. The native wildcard
            // `0xffff` releases every system button; compact state records the
            // same removal even though it has no window renderer yet.
            CommandFamily::Call { target }
                if (target.category, target.function) == (0x000c, 0x0001) =>
            {
                let Some(slot) = self.stack.pop() else {
                    return self.bad("system_button_release_stack_underflow", instruction.offset);
                };
                if slot == 0xffff {
                    self.system_button_slots.clear();
                } else {
                    self.system_button_slots.remove(&slot);
                }
                scene_vm_calls::write_call_result(self, instruction, 1)
            }
            // `system_btn_set` consumes source-order (slot, image, state).
            // Compact state keeps the configured slot; image/window rendering
            // is outside this scene VM, but a later release observes the slot.
            CommandFamily::Call { target }
                if (target.category, target.function) == (0x000c, 0x0000) =>
            {
                let (Some(_state), Some(_image), Some(slot)) =
                    (self.stack.pop(), self.stack.pop(), self.stack.pop())
                else {
                    return self.bad("system_button_set_stack_underflow", instruction.offset);
                };
                self.system_button_slots.insert(slot);
                scene_vm_calls::write_call_result(self, instruction, 1)
            }
            // `skip_set` stores the requested boolean skip latch and reports
            // success. The compact runtime has no input wait loop yet, so the
            // latch is retained for the eventual dialogue-step scheduler.
            CommandFamily::Call { target }
                if (target.category, target.function) == (0x0009, 0x0000) =>
            {
                let Some(enabled) = self.stack.pop() else {
                    return self.bad("skip_set_stack_underflow", instruction.offset);
                };
                self.text_skip_enabled = enabled != 0;
                scene_vm_calls::write_call_result(self, instruction, 1)
            }
            // Category 9:14 resets the native temporary work bank. Its
            // contents have no operand producer in this compact VM yet, but
            // retaining and clearing the bank preserves the reset boundary.
            CommandFamily::Call { target }
                if (target.category, target.function) == (0x0009, 0x000e) =>
            {
                self.scene_scratch.clear();
                scene_vm_calls::write_call_result(self, instruction, 1)
            }
            // `action_clear_count_over` clears the current counter for -1,
            // otherwise the addressed counter. Scheduling is not present yet,
            // but preserving this teardown prevents an invisible stack pass.
            CommandFamily::Call { target }
                if (target.category, target.function) == (0x0011, 0x0003) =>
            {
                let Some(action_id) = self.stack.pop() else {
                    return self.bad("action_clear_stack_underflow", instruction.offset);
                };
                if action_id == -1 {
                    self.active_actions.clear();
                } else {
                    self.active_actions.remove(&action_id);
                }
                scene_vm_calls::write_call_result(self, instruction, 1)
            }
            // `sp_cls` destroys one sprite slot, with -1 as the native
            // all-slots wildcard. This preserves renderer ownership without
            // inventing an image for a slot this compact VM never created.
            CommandFamily::Call { target }
                if (target.category, target.function) == (0x0003, 0x0005) =>
            {
                let Some(slot) = self.stack.pop() else {
                    return self.bad("sprite_clear_stack_underflow", instruction.offset);
                };
                if slot == -1 {
                    self.sprite_slots.clear();
                } else {
                    self.sprite_slots.remove(&slot);
                }
                scene_vm_calls::write_call_result(self, instruction, 1)
            }
            CommandFamily::Call { target } => self.bad(
                &format!(
                    "unimplemented_call_{:04x}_{:04x}",
                    target.category, target.function
                ),
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
            OperandTag::PLAIN => Some(scene_vm_support::sign_extend_28(operand.raw)),
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

pub(crate) struct VmResult {
    pub(crate) steps: Vec<SceneStep>,
    pub(crate) diagnostics: Vec<RuntimeDiagnostic>,
    pub(crate) branches: usize,
    pub(crate) instructions: usize,
    pub(crate) work_process_attached: bool,
}
