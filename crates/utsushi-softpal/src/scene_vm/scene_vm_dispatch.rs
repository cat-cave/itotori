impl Vm<'_> {
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



}
