//! Command, text, and selection dispatch.

use super::model::{ChoicePolicy, Moment, SceneVm, Value, VmError};
use super::stage;

impl SceneVm<'_> {
    pub(super) fn command(
        &mut self,
        offset: usize,
        arg_list_id: i32,
        arg_count: usize,
        ret_form: i32,
    ) -> Result<(), VmError> {
        let args = self.pop_n(offset, arg_count)?;
        let values = self.frame(offset)?;
        if self.stage_objects_enabled
            && let Some(target) = stage::target(&values)
        {
            let args = self.stage_arguments(offset, args)?;
            let result = stage::command(
                self.state,
                target,
                &args,
                arg_list_id,
                offset,
                self.scene_id,
            )?;
            if ret_form != 0 {
                self.values.push(result);
            }
            return Ok(());
        }
        if let Some(result) = self.string_command(offset, &values, &args)? {
            if ret_form != 0 {
                self.values.push(result);
            }
            return Ok(());
        }
        let target = self.command_target(offset, values)?;
        if let Value::Function(index) = target {
            let target = self
                .script_function(index)
                .ok_or(VmError::UnsupportedScriptFunction {
                    scene_id: self.scene_id,
                    offset,
                    function_id: index,
                })?;
            self.call(args, ret_form);
            self.enter_scene(target.scene_id, target.pc);
            return Ok(());
        }
        let Value::System(function_id) = target else {
            return Err(VmError::UnsupportedCommandTarget {
                scene_id: self.scene_id,
                offset,
            });
        };
        let result = match function_id {
            2 => return Ok(()),
            5 => return self.farcall(offset, arg_list_id, args, ret_form),
            76 => self.select(offset, args)?,
            0
            | 6..=18
            | 20..=23
            | 33..=35
            | 37..=38
            | 41..=46
            | 48
            | 50..=61
            | 63
            | 68..=74
            | 77
            | 79..=87
            | 91..=94
            | 97
            | 104
            | 113..=128
            | 130..=131
            | 134
            | 137
            | 141..=143
            | 148..=150
            | 154..=156
            | 160..=166
            | 170..=176 => Value::Int(0),
            _ => {
                return Err(VmError::UnsupportedSyscall {
                    scene_id: self.scene_id,
                    offset,
                    function_id,
                    return_form: ret_form,
                });
            }
        };
        if ret_form != 0 {
            self.values.push(result);
        }
        Ok(())
    }

    fn command_target(&mut self, offset: usize, values: Vec<Value>) -> Result<Value, VmError> {
        match values.as_slice() {
            [Value::Int(42), Value::Int(_)] => Ok(Value::System(42)),
            [Value::Int(root @ (37 | 38 | 73)), ..] => Ok(Value::System(*root)),
            _ => self.resolve_element(offset, values),
        }
    }

    fn string_command(
        &self,
        offset: usize,
        values: &[Value],
        args: &[Value],
    ) -> Result<Option<Value>, VmError> {
        let [
            Value::Int(34),
            Value::Int(-1),
            Value::Int(index),
            Value::Int(operation),
        ] = values
        else {
            return Ok(None);
        };
        let string = self
            .state
            .indexed_strings
            .get(&(34, *index))
            .and_then(|string| self.program().strings.get(string))
            .ok_or(self.operation(offset, "string-list-value"))?;
        let result = match operation {
            0 => Value::Text(string.to_uppercase()),
            1 => Value::Text(string.to_lowercase()),
            10 => {
                let needle = args.iter().find_map(|value| match value {
                    Value::Str(index) => self.program().strings.get(index).map(String::as_str),
                    Value::Text(text) => Some(text),
                    _ => None,
                });
                Value::Int(needle.map_or(0, |needle| {
                    string.find(needle).map_or(-1, |index| index as i32)
                }))
            }
            _ => return Ok(None),
        };
        Ok(Some(result))
    }

    fn stage_arguments(&self, offset: usize, args: Vec<Value>) -> Result<Vec<Value>, VmError> {
        args.into_iter()
            .map(|value| match value {
                Value::Str(index) => self
                    .program()
                    .strings
                    .get(&index)
                    .cloned()
                    .map(Value::Text)
                    .ok_or(self.operation(offset, "stage-object-string")),
                value => Ok(value),
            })
            .collect()
    }

    fn select(&mut self, offset: usize, args: Vec<Value>) -> Result<Value, VmError> {
        let options = args
            .into_iter()
            .filter_map(|value| match value {
                Value::Str(index) => self.program().strings.get(&index).cloned(),
                Value::Text(text) => Some(text),
                _ => None,
            })
            .collect::<Vec<_>>();
        if options.is_empty() {
            return Err(self.operation(offset, "empty-selection"));
        }
        let chosen = match self.policy {
            ChoicePolicy::First => 0,
        };
        self.record_moment(Moment::Choice {
            scene_id: self.scene_id,
            offset,
            options,
            chosen,
        });
        Ok(Value::Int(chosen as i32 + 1))
    }

    pub(super) fn text(&mut self, offset: usize) -> Result<(), VmError> {
        let text = match self.pop(offset)? {
            Value::Str(index) => self
                .program()
                .strings
                .get(&index)
                .cloned()
                .ok_or(self.operation(offset, "text-string"))?,
            Value::Text(text) => text,
            _ => return Err(self.operation(offset, "computed-text")),
        };
        self.record_moment(Moment::Text {
            scene_id: self.scene_id,
            offset,
            speaker: self.speaker.clone(),
            text,
        });
        Ok(())
    }

    pub(super) fn name(&mut self, offset: usize) -> Result<(), VmError> {
        self.speaker = match self.pop(offset)? {
            Value::Str(index) => self.program().strings.get(&index).cloned(),
            Value::Text(text) => Some(text),
            _ => return Err(self.operation(offset, "computed-name")),
        };
        Ok(())
    }
}
