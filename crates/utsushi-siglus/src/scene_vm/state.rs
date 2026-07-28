//! Variable, element-path, and call-property state for the scene VM.

use std::collections::BTreeMap;

use super::model::{CallFrame, CallProperty, SceneVm, Value, VmError};
use super::stage;

impl SceneVm<'_> {
    pub(super) fn resolve_element(
        &mut self,
        offset: usize,
        values: Vec<Value>,
    ) -> Result<Value, VmError> {
        if self.stage_objects_enabled
            && let Some(target) = stage::target(&values)
        {
            return stage::read(self.state, target, offset, self.scene_id);
        }
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
            [Value::Int(34), Value::Int(-1), Value::Int(index)] => self
                .state
                .indexed_strings
                .get(&(34, *index))
                .cloned()
                .map(Value::Text)
                .ok_or(self.operation(offset, "string-list-value")),
            [
                Value::Int(34),
                Value::Int(-1),
                Value::Int(index),
                Value::Int(0),
            ] => self
                .state
                .indexed_strings
                .get(&(34, *index))
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
            _ if structured_system_path(&values).is_some() => {
                let path = structured_system_path(&values).expect("path was checked");
                Ok(self
                    .state
                    .structured_system
                    .get(&(self.scene_id, path))
                    .cloned()
                    .unwrap_or(Value::Int(0)))
            }
            _ => Err(VmError::UnsupportedElementPath {
                scene_id: self.scene_id,
                offset,
                path: values
                    .iter()
                    .map(|value| match value {
                        Value::Int(value) => *value,
                        Value::Str(index) => *index,
                        Value::Text(_) | Value::System(_) | Value::Function(_) => i32::MIN,
                    })
                    .collect(),
            }),
        }
    }

    pub(super) fn assign(&mut self, offset: usize) -> Result<(), VmError> {
        let value = self.pop(offset)?;
        let values = self.frame(offset)?;
        if self.stage_objects_enabled
            && let Some(target) = stage::target(&values)
        {
            return stage::assign(
                self.state,
                target,
                self.expect_int(offset, value)?,
                offset,
                self.scene_id,
            );
        }
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
                let value = self.string_value(offset, &value)?;
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
            _ if structured_system_path(&values).is_some() => {
                let path = structured_system_path(&values).expect("path was checked");
                self.state
                    .structured_system
                    .insert((self.scene_id, path), value);
            }
            _ => return Err(self.operation(offset, "assignment-target")),
        }
        Ok(())
    }

    pub(super) fn call(
        &mut self,
        offset: usize,
        arguments: Vec<Value>,
        return_form: i32,
    ) -> Result<(), VmError> {
        let arguments = arguments
            .into_iter()
            .map(|argument| match argument {
                Value::Str(index) => self
                    .program()
                    .strings
                    .get(&index)
                    .cloned()
                    .map(Value::Text)
                    .ok_or(self.operation(offset, "call-argument-string")),
                argument => Ok(argument),
            })
            .collect::<Result<Vec<_>, _>>()?;
        self.calls.push(CallFrame {
            scene_id: self.scene_id,
            pc: self.pc,
            return_form,
            arguments,
            properties: Vec::new(),
            scene_entry: false,
        });
        Ok(())
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

    pub(super) fn call_string_property(&self, offset: usize, raw: i32) -> Result<String, VmError> {
        let frame = self
            .calls
            .last()
            .ok_or(self.operation(offset, "call-property-context"))?;
        let property = frame
            .properties
            .get((raw & 0xffff) as usize)
            .ok_or(self.operation(offset, "call-property-id"))?;
        if property.form != 20 {
            return Err(self.operation(offset, "call-property-string-form"));
        }
        self.string_value(offset, &property.value)
    }

    pub(super) fn string_value(&self, offset: usize, value: &Value) -> Result<String, VmError> {
        match value {
            Value::Str(index) => self
                .program()
                .strings
                .get(index)
                .cloned()
                .ok_or(self.operation(offset, "string-value")),
            Value::Text(text) => Ok(text.clone()),
            _ => Err(self.operation(offset, "non-string value")),
        }
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
        let property_form = self
            .calls
            .last()
            .and_then(|frame| frame.properties.get((raw & 0xffff) as usize))
            .map(|property| property.form);
        let value = match property_form {
            Some(20) if index.is_none() => Value::Text(self.string_value(offset, &value)?),
            Some(21) if index.is_some() => Value::Text(self.string_value(offset, &value)?),
            _ => value,
        };
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

pub(super) fn owner(value: i32) -> i32 {
    (value >> 24) & 0xff
}

fn int_list(form: i32) -> bool {
    matches!(form, 25..=32 | 137)
}

fn structured_system_path(values: &[Value]) -> Option<Vec<i32>> {
    let path = values
        .iter()
        .map(|value| match value {
            Value::Int(value) => Some(*value),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()?;
    matches!(path.as_slice(), [83, 0, -1, ..]).then_some(path)
}
