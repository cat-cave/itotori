impl Vm<'_> {
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



}
