//! Sv20 execution: values, branches, calls, and honest stop diagnostics.
use crate::scene_runtime::{
    ChoiceOption, RuntimeBankWrite, RuntimeDiagnostic, RuntimeTraceEvent, SceneStep,
};
use kaifuu_softpal::{
    CommandFamily, FileDat, Instruction, OpcodeScan, Operand, OperandTag, PacArchive, RawCommand,
};
use std::collections::{BTreeMap, HashMap};
mod scene_vm_calls;
mod scene_vm_support;
pub(crate) use scene_vm_support::point_offsets;

/// Sena initializes `user_mem` with 0x10000 i32 cells, matching the original
/// engine (`pal-vm/src/runtime.rs:32`, `:957`).
const USER_MEM_LEN: usize = 0x10000;
/// Sena allocates the temporary operand bank at the same original-engine size
/// as `user_mem` (`pal-vm/src/runtime.rs:32`, `:959`).
const TEMP_MEM_LEN: usize = 0x10000;
#[derive(Default)]
struct Frame {
    locals: BTreeMap<u32, i32>,
    arguments: Vec<i32>,
}

/// Read-only PAC resources available to native file calls for one VM run.
#[derive(Debug)]
pub(crate) struct ResourceAssets<'a> {
    pub(crate) archives: Vec<(PacArchive, &'a [u8])>,
    pub(crate) file_dat: FileDat,
}

#[derive(Debug)]
struct RuntimeFile {
    bytes: Vec<u8>,
    cursor: usize,
    table: Option<scene_vm_support::FileTable>,
    table_cursor: usize,
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
    /// Operand tag `0x1`: `user_mem[vars[lo]]`.
    ///
    /// This is a fixed, zero-initialized bank. Unlike Sena's permissive
    /// fallback, the compact runtime makes an invalid script index a visible
    /// stop so an unproven script path cannot silently change behavior.
    user_mem: Vec<i32>,
    /// Writable `MEM.DAT` i32-word shadow for operand tag `0x6`.
    mem_dat: Option<Vec<i32>>,
    /// Operand tag `0x5`: temporary memory addressed through a local slot.
    temp_mem: Vec<i32>,
    argument_base: i32,
    /// Category-18 dynamic strings use a rotating 16-slot native buffer.
    dynamic_strings: Vec<String>,
    dynamic_string_cursor: usize,
    /// Validated PAC + FILE.DAT assets used by category-18 file calls.
    resources: Option<ResourceAssets<'a>>,
    /// One-based, reusable native file handles. A missing/closed slot is never
    /// converted into a zero result: callers stop at a named diagnostic.
    file_handles: Vec<Option<RuntimeFile>>,
    returns: Vec<usize>,
    stack: Vec<i32>,
    ip: usize,
    steps: Vec<SceneStep>,
    diagnostics: Vec<RuntimeDiagnostic>,
    trace: Vec<RuntimeTraceEvent>,
    /// Category `0x0011:0x001c` work-process attachment; no launcher data is invented.
    work_process_attached: bool,
    /// Category `0x000f:0x0005` exchanges this PAL-owned mode value.
    debug_window_state: i32,
    /// Category `0x0012:0x0023` retains the script point selected for the
    /// next native work process. The compact VM has no PAL process scheduler,
    /// but must retain and consume this contract exactly.
    last_process_point: i32,
    /// Category `0x000d:0x0015`'s script-visible BGV level.  PAL initializes
    /// this audio field to 50; it is deliberately distinct from an audio
    /// renderer, which this compact VM does not own.
    bgv_volume: i32,
    /// Category `0x000f:0x0004`'s three native overlay arguments.
    system_window_overlay: Option<(i32, i32, i32)>,
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
        mem_dat: Option<&[u8]>,
        resources: Option<ResourceAssets<'a>>,
        entry_ip: usize,
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
            user_mem: vec![0; USER_MEM_LEN],
            mem_dat: mem_dat.map(|bytes| {
                bytes
                    .chunks_exact(4)
                    .map(|word| i32::from_le_bytes(word.try_into().expect("four-byte word")))
                    .collect()
            }),
            temp_mem: vec![0; TEMP_MEM_LEN],
            argument_base: 0,
            dynamic_strings: vec![String::new(); 16],
            dynamic_string_cursor: 0,
            resources,
            file_handles: Vec::new(),
            returns: Vec::new(),
            stack: Vec::new(),
            ip: entry_ip,
            steps: Vec::new(),
            diagnostics: Vec::new(),
            trace: Vec::new(),
            work_process_attached: false,
            debug_window_state: 0,
            last_process_point: 0,
            bgv_volume: 50,
            system_window_overlay: None,
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
                0x15 => {
                    // The script bootstrap can end immediately after attaching
                    // PAL's work-process pump. The callback registration and
                    // task data live in launcher-native state, not SCRIPT.SRC;
                    // ending here as success would hide the absent text path.
                    if self.work_process_attached {
                        self.stop("work_process_callback_unavailable", instruction.offset);
                    }
                    break;
                }
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
        // Some bootstraps leave through a root-level `return` rather than the
        // `end` opcode. Keep the missing native work callback visible at either
        // script terminus; otherwise a worker-less run would appear complete.
        if self.work_process_attached && self.diagnostics.is_empty() {
            let offset = self
                .instructions
                .get(self.ip)
                .map_or(12, |instruction| instruction.offset);
            self.stop("work_process_callback_unavailable", offset);
        }
        VmResult {
            steps: self.steps,
            diagnostics: self.diagnostics,
            trace: self.trace,
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
        let right = match operands.get(1) {
            Some(operand) => match self.value(*operand, instruction.offset) {
                Some(value) => Some(value),
                None => return false,
            },
            None => None,
        };
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
            self.record_branch(instruction.offset, false, None);
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
        self.record_branch(instruction.offset, taken, Some(label));
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
        self.record_call(instruction);
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
            // `set_bgv_volume` consumes the requested script-visible level,
            // retains it in PAL audio state, and reports success.  The compact
            // VM intentionally records no synthetic sound output.
            //
            // Sena: `dispatch_text_stub` indexes this call as 69 and pops one
            // argument before writing `text_state.bgv_volume`
            // (`pal-vm/src/runtime.rs:3308-3309`, `:4383-4391`).
            CommandFamily::Call { target }
                if (target.category, target.function) == (0x000d, 0x0015) =>
            {
                let Some(volume) = self.stack.pop() else {
                    return self.bad("set_bgv_volume_stack_underflow", instruction.offset);
                };
                self.bgv_volume = volume;
                scene_vm_calls::write_call_result(self, instruction, 1)
            }
            // The paired query consumes no arguments and exposes exactly the
            // level retained by `set_bgv_volume`, rather than an invented
            // default at each call site (Sena `runtime.rs:4434-4436`).
            CommandFamily::Call { target }
                if (target.category, target.function) == (0x000d, 0x0016) =>
            {
                scene_vm_calls::write_call_result(self, instruction, self.bgv_volume)
            }
            // Category 15:4 has a proven three-value stack contract. The
            // backing window object is outside this compact VM, but retaining
            // every supplied value preserves the state transition rather than
            // silently discarding its effect.
            CommandFamily::Call { target }
                if (target.category, target.function) == (0x000f, 0x0004) =>
            {
                let (Some(text_id), Some(value), Some(mode)) =
                    (self.stack.pop(), self.stack.pop(), self.stack.pop())
                else {
                    return self.bad("system_window_overlay_stack_underflow", instruction.offset);
                };
                self.system_window_overlay = Some((text_id, value, mode));
                scene_vm_calls::write_call_result(self, instruction, 1)
            }
            // `system_task_value` consumes no VM argument. The native value is
            // launcher-owned; the reference runtime's active-latch result is
            // one, so that is the only value modeled here.
            CommandFamily::Call { target }
                if (target.category, target.function) == (0x0012, 0x000f) =>
            {
                scene_vm_calls::write_call_result(self, instruction, 1)
            }
            // `string_alloc` consumes its ignored source value, clears the
            // selected native dynamic-string buffer, then advances its fixed
            // 16-slot cursor and returns the tagged handle.
            CommandFamily::Call { target }
                if (target.category, target.function) == (0x0012, 0x0006) =>
            {
                let Some(_ignored) = self.stack.pop() else {
                    return self.bad("string_alloc_stack_underflow", instruction.offset);
                };
                let slot = self.dynamic_string_cursor;
                self.dynamic_strings[slot].clear();
                self.dynamic_string_cursor = (slot + 1) % self.dynamic_strings.len();
                scene_vm_calls::write_call_result(
                    self,
                    instruction,
                    (0x1000_0000_u32 | slot as u32) as i32,
                )
            }
            // `openfile` consumes a resource-string id, resolves it through
            // FILE.DAT/dynamic text state, and retains the exact PAC payload
            // behind a nonzero, one-based handle. Missing inputs are explicit
            // stops: returning a fake zero would let setup code advance on an
            // unproven file-open result.
            CommandFamily::Call { target }
                if (target.category, target.function) == (0x0012, 0x001e) =>
            {
                self.open_file(instruction)
            }
            CommandFamily::Call { target }
                if (target.category, target.function) == (0x0012, 0x001f) =>
            {
                self.read_file(instruction)
            }
            CommandFamily::Call { target }
                if (target.category, target.function) == (0x0012, 0x0022) =>
            {
                self.file_string(instruction)
            }
            // `set_last_process` consumes one script point id and stores the
            // native cached process target. The scheduler that later uses this
            // cache is outside the compact VM, but neither its argument nor
            // its success result may be silently discarded.
            //
            // Sena's recovered handler: `pal-vm/src/runtime.rs:11670-11678`.
            CommandFamily::Call { target }
                if (target.category, target.function) == (0x0012, 0x0023) =>
            {
                let Some(point_id) = self.stack.pop() else {
                    return self.bad("set_last_process_stack_underflow", instruction.offset);
                };
                self.last_process_point = point_id;
                scene_vm_calls::write_call_result(self, instruction, 1)
            }
            CommandFamily::Call { target }
                if (target.category, target.function) == (0x0012, 0x0021) =>
            {
                self.set_file_pointer(instruction)
            }
            CommandFamily::Call { target }
                if (target.category, target.function) == (0x0012, 0x0005) =>
            {
                self.string_character_or_int(instruction)
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

    fn open_file(&mut self, instruction: Instruction) -> bool {
        let Some(resource_id) = self.stack.pop() else {
            return self.bad("openfile_stack_underflow", instruction.offset);
        };
        let Some(name) = self.resolve_resource_name(resource_id) else {
            return self.bad("openfile_resource_name_unresolved", instruction.offset);
        };
        let Some(resources) = self.resources.as_ref() else {
            return self.bad("openfile_resource_archive_required", instruction.offset);
        };
        let Some((archive, pac_bytes, entry)) =
            resources.archives.iter().find_map(|(archive, bytes)| {
                archive
                    .entries()
                    .iter()
                    .find(|entry| entry.name.eq_ignore_ascii_case(&name))
                    .map(|entry| (archive, *bytes, entry))
            })
        else {
            return self.bad("openfile_pac_entry_missing", instruction.offset);
        };
        let bytes = match archive.extract(pac_bytes, entry) {
            Ok(bytes) => bytes.to_vec(),
            Err(_) => return self.bad("openfile_pac_extract_failed", instruction.offset),
        };
        let table = scene_vm_support::parse_file_table(&bytes);
        let handle = self.insert_file_handle(RuntimeFile {
            bytes,
            cursor: 0,
            table,
            table_cursor: 0,
        });
        scene_vm_calls::write_call_result(self, instruction, handle)
    }

    fn resolve_resource_name(&self, value: i32) -> Option<String> {
        if value == 0x0fff_ffff {
            return None;
        }
        let raw = value as u32;
        if raw & 0xf000_0000 == 0x1000_0000 {
            let index = (raw & 0x0fff_ffff) as usize;
            return self
                .dynamic_strings
                .get(index)
                .filter(|name| scene_vm_support::is_plausible_resource_name(name))
                .cloned();
        }
        let index = usize::try_from(value).ok()?;
        self.resources
            .as_ref()
            .and_then(|resources| resources.file_dat.slot(index))
            .filter(|name| scene_vm_support::is_plausible_resource_name(name))
            .map(ToOwned::to_owned)
            .or_else(|| {
                self.texts
                    .get(&(value as u32))
                    .filter(|name| scene_vm_support::is_plausible_resource_name(name))
                    .cloned()
            })
    }

    fn insert_file_handle(&mut self, file: RuntimeFile) -> i32 {
        for (index, slot) in self.file_handles.iter_mut().enumerate() {
            if slot.is_none() {
                *slot = Some(file);
                return (index + 1) as i32;
            }
        }
        self.file_handles.push(Some(file));
        self.file_handles.len() as i32
    }

    fn file_handle_mut(&mut self, handle: i32) -> Option<&mut RuntimeFile> {
        usize::try_from(handle)
            .ok()
            .and_then(|handle| handle.checked_sub(1))
            .and_then(|slot| self.file_handles.get_mut(slot))
            .and_then(Option::as_mut)
    }

    fn read_file(&mut self, instruction: Instruction) -> bool {
        let (Some(handle), Some(temp_offset), Some(count)) =
            (self.stack.pop(), self.stack.pop(), self.stack.pop())
        else {
            return self.bad("readfile_stack_underflow", instruction.offset);
        };
        let Ok(count) = usize::try_from(count) else {
            return self.bad("readfile_negative_count", instruction.offset);
        };
        let Ok(temp_offset) = usize::try_from(temp_offset) else {
            return self.bad("readfile_temp_offset_out_of_range", instruction.offset);
        };
        let Some(file) = self.file_handle_mut(handle) else {
            return self.bad("readfile_invalid_handle", instruction.offset);
        };
        let (values, read_len) = if let Some(table) = file.table.as_ref() {
            let start = file.table_cursor / 4;
            let read_len = table.entries.len().saturating_sub(start).min(count);
            let values = table.entries[start..start + read_len].to_vec();
            file.table_cursor += read_len * 4;
            (values, read_len)
        } else {
            let available = file.bytes.len().saturating_sub(file.cursor);
            let read_len = available.min(count);
            let values = file.bytes[file.cursor..file.cursor + read_len]
                .iter()
                .map(|byte| i32::from(*byte))
                .collect();
            file.cursor += read_len;
            (values, read_len)
        };
        let Some(end) = temp_offset.checked_add(read_len) else {
            return self.bad("readfile_temp_offset_out_of_range", instruction.offset);
        };
        if end > self.temp_mem.len() {
            self.temp_mem.resize(end, 0);
        }
        for (index, value) in values.into_iter().enumerate() {
            self.temp_mem[temp_offset + index] = value;
        }
        scene_vm_calls::write_call_result(self, instruction, i32::from(read_len == count))
    }

    fn file_string(&mut self, instruction: Instruction) -> bool {
        let (Some(handle), Some(entry), Some(destination)) =
            (self.stack.pop(), self.stack.pop(), self.stack.pop())
        else {
            return self.bad("filestring_stack_underflow", instruction.offset);
        };
        let Some(file) = self.file_handle_mut(handle) else {
            return self.bad("filestring_invalid_handle", instruction.offset);
        };
        let Some(table) = file.table.as_ref() else {
            return self.bad("filestring_table_unparsed", instruction.offset);
        };
        let offset = entry & 0x7fff_ffff;
        let Some(value) = table.strings.get(&offset).cloned() else {
            return self.bad("filestring_entry_missing", instruction.offset);
        };
        let result = self.store_dynamic_string(destination, value);
        scene_vm_calls::write_call_result(self, instruction, result)
    }

    fn set_file_pointer(&mut self, instruction: Instruction) -> bool {
        let (Some(handle), Some(offset), Some(origin)) =
            (self.stack.pop(), self.stack.pop(), self.stack.pop())
        else {
            return self.bad("setfilepointer_stack_underflow", instruction.offset);
        };
        let Some(file) = self.file_handle_mut(handle) else {
            return self.bad("setfilepointer_invalid_handle", instruction.offset);
        };
        let table_len = file
            .table
            .as_ref()
            .map_or(file.bytes.len(), |table| table.entries.len() * 4);
        let current = file.table_cursor as i64;
        let base = match origin {
            0 => 0,
            2 => table_len as i64,
            _ => current,
        };
        let next = base
            .saturating_add(i64::from(offset).saturating_mul(4))
            .max(0) as usize;
        file.table_cursor = next.min(table_len);
        file.cursor = file.table_cursor.min(file.bytes.len());
        scene_vm_calls::write_call_result(self, instruction, 1)
    }

    fn string_character_or_int(&mut self, instruction: Instruction) -> bool {
        let (Some(string_id), Some(offset), Some(length)) =
            (self.stack.pop(), self.stack.pop(), self.stack.pop())
        else {
            return self.bad("strgetcf_stack_underflow", instruction.offset);
        };
        let Some(text) = self.resolve_script_string(string_id) else {
            return self.bad("strgetcf_string_unresolved", instruction.offset);
        };
        let offset = offset.max(0) as usize;
        let length = length.max(0) as usize;
        let bytes = text.as_bytes();
        let value = if offset >= bytes.len() {
            0
        } else if length == 0 {
            i32::from(bytes[offset])
        } else {
            let end = offset.saturating_add(length).min(bytes.len());
            std::str::from_utf8(&bytes[offset..end])
                .ok()
                .filter(|value| value.bytes().all(|byte| byte.is_ascii_digit()))
                .and_then(|value| value.parse().ok())
                .unwrap_or(0)
        };
        scene_vm_calls::write_call_result(self, instruction, value)
    }

    fn resolve_script_string(&self, value: i32) -> Option<String> {
        if value == 0x0fff_ffff {
            return Some(String::new());
        }
        let raw = value as u32;
        if raw & 0xf000_0000 == 0x1000_0000 {
            return self
                .dynamic_strings
                .get((raw & 0x0fff_ffff) as usize)
                .cloned();
        }
        self.texts
            .get(&raw)
            .cloned()
            .or_else(|| self.resolve_resource_name(value))
    }

    fn store_dynamic_string(&mut self, requested: i32, value: String) -> i32 {
        let raw = requested as u32;
        if raw & 0xf000_0000 == 0x1000_0000 {
            let index = (raw & 0x0fff_ffff) as usize;
            if index < self.dynamic_strings.len() {
                self.dynamic_strings[index] = value;
                return requested;
            }
        }
        let index = self.dynamic_string_cursor;
        self.dynamic_strings[index] = value;
        self.dynamic_string_cursor = (index + 1) % self.dynamic_strings.len();
        (0x1000_0000_u32 | index as u32) as i32
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
            OperandTag(0x1) => {
                let index = self.user_memory_index(operand, offset)?;
                Some(self.user_mem[index])
            }
            OperandTag(0x2) => Some(*self.shared.get(&(operand.raw & 0x0fff_ffff)).unwrap_or(&0)),
            OperandTag(0x5) => {
                let index = self.temp_memory_index(operand, offset)?;
                let Some(value) = self.temp_mem.get(index).copied() else {
                    self.stop("temp_mem_index_out_of_range", offset);
                    return None;
                };
                Some(value)
            }
            OperandTag(0x6) => {
                let index = self.mem_dat_index(operand, offset)?;
                let Some(value) = self
                    .mem_dat
                    .as_ref()
                    .and_then(|mem_dat| mem_dat.get(index))
                    .copied()
                else {
                    self.stop("mem_dat_index_out_of_range", offset);
                    return None;
                };
                Some(value)
            }
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
            OperandTag(0x1) => {
                let Some(index) = self.user_memory_index(operand, offset) else {
                    return false;
                };
                self.user_mem[index] = value;
            }
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
            OperandTag(0x5) => {
                let Some(index) = self.temp_memory_index(operand, offset) else {
                    return false;
                };
                if index >= self.temp_mem.len() {
                    self.temp_mem.resize(index + 1, 0);
                }
                self.temp_mem[index] = value;
            }
            OperandTag(0x6) => {
                let Some(index) = self.mem_dat_index(operand, offset) else {
                    return false;
                };
                let Some(mem_dat) = self.mem_dat.as_mut() else {
                    return self.bad("mem_dat_required", offset);
                };
                if index >= mem_dat.len() {
                    mem_dat.resize(index + 1, 0);
                }
                mem_dat[index] = value;
            }
            OperandTag(0x9) => {
                self.globals.insert(operand.raw & 0x0fff_ffff, value);
            }
            _ => return self.bad("nonlocal_destination", offset),
        }
        true
    }

    /// Resolves the tag-1 indirection and rejects a negative or out-of-bank
    /// value. `lo` is a u16 source variable index in the reference decoder,
    /// and the existing compact local bank supplies the same default-zero
    /// value for an unset slot.
    fn user_memory_index(&mut self, operand: Operand, offset: usize) -> Option<usize> {
        let source_slot = operand.raw & 0xffff;
        let signed_index = self
            .frames
            .last()
            .and_then(|frame| frame.locals.get(&source_slot).copied())
            .unwrap_or(0);
        let Ok(index) = usize::try_from(signed_index) else {
            self.stop("user_mem_index_out_of_range", offset);
            return None;
        };
        if index >= self.user_mem.len() {
            self.stop("user_mem_index_out_of_range", offset);
            return None;
        }
        Some(index)
    }

    /// Tag 6 targets the writable `MEM.DAT` shadow at word
    /// `bank + vars[lo] + 4`; the four-word offset skips its 16-byte header.
    /// This is the reference's recovered addressing formula
    /// (`pal-vm/src/runtime.rs:3053-3066`).
    fn mem_dat_index(&mut self, operand: Operand, offset: usize) -> Option<usize> {
        if self.mem_dat.is_none() {
            self.stop("mem_dat_required", offset);
            return None;
        }
        let source_slot = operand.raw & 0xffff;
        let variable = self
            .frames
            .last()
            .and_then(|frame| frame.locals.get(&source_slot).copied())
            .unwrap_or(0);
        let bank = ((operand.raw >> 16) & 0x0fff) as i32;
        let index = bank.wrapping_add(variable).wrapping_add(4);
        let Ok(index) = usize::try_from(index) else {
            self.stop("mem_dat_index_out_of_range", offset);
            return None;
        };
        Some(index)
    }

    /// Tag 5 targets `temp_mem[(bank != 0 ? bank + argument_base : 0) +
    /// vars[lo]]`. The reference permits an in-range write to extend this
    /// bank; an invalid negative/read-beyond-end path remains visible here.
    fn temp_memory_index(&mut self, operand: Operand, offset: usize) -> Option<usize> {
        let source_slot = operand.raw & 0xffff;
        let variable = self
            .frames
            .last()
            .and_then(|frame| frame.locals.get(&source_slot).copied())
            .unwrap_or(0);
        let bank = ((operand.raw >> 16) & 0x0fff) as i32;
        let base = if bank == 0 {
            0
        } else {
            bank.wrapping_add(self.argument_base)
        };
        let Ok(index) = usize::try_from(base.wrapping_add(variable)) else {
            self.stop("temp_mem_index_out_of_range", offset);
            return None;
        };
        Some(index)
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

    fn record_call(&mut self, instruction: Instruction) {
        let Some(target) = instruction.call_target() else {
            return;
        };
        self.trace.push(RuntimeTraceEvent::Call {
            offset: instruction.offset,
            category: target.category,
            function: target.function,
            stack_depth: self.stack.len(),
            destination_tag: instruction.operands().get(1).map(|operand| operand.tag().0),
            return_value: None,
            bank_writes: Vec::new(),
        });
    }

    fn record_call_result(&mut self, instruction: Instruction, value: i32) {
        let Some(RuntimeTraceEvent::Call {
            offset,
            return_value,
            bank_writes,
            ..
        }) = self.trace.last_mut()
        else {
            return;
        };
        if *offset != instruction.offset {
            return;
        }
        *return_value = Some(value);
        if let Some(destination) = instruction.operands().get(1) {
            bank_writes.push(RuntimeBankWrite {
                destination_tag: destination.tag().0,
                destination_slot: destination.raw & 0x0fff_ffff,
            });
        }
    }

    fn record_branch(&mut self, offset: usize, taken: bool, target_offset: Option<usize>) {
        self.trace.push(RuntimeTraceEvent::Branch {
            offset,
            taken,
            target_offset,
        });
    }
}

pub(crate) struct VmResult {
    pub(crate) steps: Vec<SceneStep>,
    pub(crate) diagnostics: Vec<RuntimeDiagnostic>,
    pub(crate) trace: Vec<RuntimeTraceEvent>,
    pub(crate) branches: usize,
    pub(crate) instructions: usize,
    pub(crate) work_process_attached: bool,
}
