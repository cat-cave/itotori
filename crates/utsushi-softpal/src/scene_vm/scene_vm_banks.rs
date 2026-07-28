impl Vm<'_> {
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
