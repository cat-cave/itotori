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



}
