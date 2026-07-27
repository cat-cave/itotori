//! Variable, element-path, and call-property state for the scene VM.

use std::collections::BTreeMap;

use super::model::{CallFrame, CallProperty, SceneVm, Value, VmError};

impl SceneVm<'_> {
    pub(super) fn resolve_element(
        &mut self,
        offset: usize,
        values: Vec<Value>,
    ) -> Result<Value, VmError> {
        match values.as_slice() {
            [Value::Int(raw)] if owner(*raw) == 127 => Ok(Value::Int(
                *self.state.globals.get(&(*raw & 0x00ff_ffff)).unwrap_or(&0),
            )),
            [Value::Int(raw), Value::Int(-1), Value::Int(index)] if owner(*raw) == 127 => {
                Ok(Value::Int(
                    *self
                        .state
                        .indexed_globals
                        .get(&(*raw & 0x00ff_ffff, *index))
                        .unwrap_or(&0),
                ))
            }
            [Value::Int(form), Value::Int(-1), Value::Int(index)] if int_list(*form) => {
                Ok(Value::Int(
                    *self
                        .state
                        .indexed_globals
                        .get(&(*form, *index))
                        .unwrap_or(&0),
                ))
            }
            [Value::Int(34), Value::Int(-1), Value::Int(index)] => Ok(Value::Str(
                *self.state.indexed_strings.get(&(34, *index)).unwrap_or(&-1),
            )),
            [
                Value::Int(34),
                Value::Int(-1),
                Value::Int(index),
                Value::Int(0),
            ] => self
                .state
                .indexed_strings
                .get(&(34, *index))
                .and_then(|string| self.program().strings.get(string))
                .map(|string| Value::Text(string.to_uppercase()))
                .ok_or(self.operation(offset, "string-list-value")),
            [Value::Int(42), Value::Int(property)] => Ok(Value::Int(
                *self
                    .state
                    .system_properties
                    .get(&(42, *property))
                    .unwrap_or(&0),
            )),
            [Value::Int(65), Value::Int(8)] | [Value::Int(37 | 38 | 73), ..] => Ok(Value::Int(0)),
            [Value::Int(raw)] if owner(*raw) == 125 => self.call_property(offset, *raw, None),
            [Value::Int(raw), Value::Int(-1), Value::Int(index)] if owner(*raw) == 125 => {
                self.call_property(offset, *raw, Some(*index))
            }
            [Value::Int(83), Value::Int(raw)] if owner(*raw) == 125 => {
                self.call_property(offset, *raw, None)
            }
            [
                Value::Int(83),
                Value::Int(raw),
                Value::Int(-1),
                Value::Int(index),
            ] if owner(*raw) == 125 => self.call_property(offset, *raw, Some(*index)),
            [Value::Int(raw)] if owner(*raw) == 0 => Ok(Value::System(*raw & 0x00ff_ffff)),
            [Value::Int(raw)] if owner(*raw) == 126 => Ok(Value::Function(*raw & 0x00ff_ffff)),
            _ => Err(self.operation(offset, "element-path")),
        }
    }

    pub(super) fn assign(&mut self, offset: usize) -> Result<(), VmError> {
        let value = self.pop(offset)?;
        let values = self.frame(offset)?;
        match values.as_slice() {
            [Value::Int(raw)] if owner(*raw) == 127 => {
                let value = self.expect_int(offset, value)?;
                self.state.globals.insert(*raw & 0x00ff_ffff, value);
            }
            [Value::Int(raw), Value::Int(-1), Value::Int(index)] if owner(*raw) == 127 => {
                let value = self.expect_int(offset, value)?;
                self.state
                    .indexed_globals
                    .insert((*raw & 0x00ff_ffff, *index), value);
            }
            [Value::Int(form), Value::Int(-1), Value::Int(index)] if int_list(*form) => {
                let value = self.expect_int(offset, value)?;
                self.state.indexed_globals.insert((*form, *index), value);
            }
            [Value::Int(34), Value::Int(-1), Value::Int(index)] => {
                let Value::Str(value) = value else {
                    return Err(self.operation(offset, "non-string assignment"));
                };
                self.state.indexed_strings.insert((34, *index), value);
            }
            [Value::Int(42), Value::Int(property)] => {
                let value = self.expect_int(offset, value)?;
                self.state.system_properties.insert((42, *property), value);
            }
            [Value::Int(raw)] | [Value::Int(83), Value::Int(raw)] if owner(*raw) == 125 => {
                return self.assign_call_property(offset, *raw, None, value);
            }
            [Value::Int(raw), Value::Int(-1), Value::Int(index)] if owner(*raw) == 125 => {
                return self.assign_call_property(offset, *raw, Some(*index), value);
            }
            [
                Value::Int(83),
                Value::Int(raw),
                Value::Int(-1),
                Value::Int(index),
            ] if owner(*raw) == 125 => {
                return self.assign_call_property(offset, *raw, Some(*index), value);
            }
            _ => return Err(self.operation(offset, "assignment-target")),
        }
        Ok(())
    }

    pub(super) fn call(&mut self, arguments: Vec<Value>, return_form: i32) {
        self.calls.push(CallFrame {
            scene_id: self.scene_id,
            pc: self.pc,
            return_form,
            arguments,
            properties: Vec::new(),
            scene_entry: false,
        });
    }

    pub(super) fn declare_property(
        &mut self,
        offset: usize,
        form: i32,
        _declared_id: i32,
    ) -> Result<(), VmError> {
        let value = match form {
            10 | 11 => Value::Int(0),
            20 | 21 => Value::Str(-1),
            _ => return Err(self.operation(offset, "call-property-form")),
        };
        if matches!(form, 11 | 21) {
            self.integer(offset)?;
        }
        let error = self.operation(offset, "call-property-context");
        let frame = self.calls.last_mut().ok_or(error)?;
        frame.properties.push(CallProperty {
            form,
            value,
            indexed: BTreeMap::default(),
        });
        Ok(())
    }

    pub(super) fn expand_args(&mut self, offset: usize) -> Result<(), VmError> {
        let error = self.operation(offset, "call-property-context");
        let frame = self.calls.last_mut().ok_or(error)?;
        if frame.arguments.len() != frame.properties.len() {
            return Err(self.operation(offset, "call-argument-shape"));
        }
        for (property, value) in frame.properties.iter_mut().zip(frame.arguments.drain(..)) {
            property.value = value;
        }
        Ok(())
    }

    fn call_property(&self, offset: usize, raw: i32, index: Option<i32>) -> Result<Value, VmError> {
        let frame = self
            .calls
            .last()
            .ok_or(self.operation(offset, "call-property-context"))?;
        let property = frame
            .properties
            .get((raw & 0xffff) as usize)
            .ok_or(self.operation(offset, "call-property-id"))?;
        Ok(index
            .and_then(|index| property.indexed.get(&index).cloned())
            .unwrap_or_else(|| property.value.clone()))
    }

    fn assign_call_property(
        &mut self,
        offset: usize,
        raw: i32,
        index: Option<i32>,
        value: Value,
    ) -> Result<(), VmError> {
        let error = self.operation(offset, "call-property-context");
        let frame = self.calls.last_mut().ok_or(error)?;
        let property_index = (raw & 0xffff) as usize;
        while frame.properties.len() <= property_index {
            frame.properties.push(CallProperty {
                form: 10,
                value: Value::Int(0),
                indexed: BTreeMap::default(),
            });
        }
        let property = &mut frame.properties[property_index];
        if let Some(index) = index {
            if !matches!(property.form, 11 | 21) {
                return Err(self.operation(offset, "call-property-index"));
            }
            property.indexed.insert(index, value);
        } else {
            property.value = value;
        }
        Ok(())
    }

    fn expect_int(&self, offset: usize, value: Value) -> Result<i32, VmError> {
        if let Value::Int(value) = value {
            Ok(value)
        } else {
            Err(self.operation(offset, "non-integer assignment"))
        }
    }
}

fn owner(value: i32) -> i32 {
    (value >> 24) & 0xff
}

fn int_list(form: i32) -> bool {
    matches!(form, 25..=32 | 137)
}
