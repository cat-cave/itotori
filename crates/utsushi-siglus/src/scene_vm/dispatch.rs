//! Command, text, and selection dispatch.

use super::model::{ChoicePolicy, Moment, SceneVm, Value, VmError};
use super::pcmch;
use super::stage;
use super::state::owner;

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
            && let Some(result) = pcmch::command(self.state, &values, &args, offset, self.scene_id)?
        {
            if ret_form != 0 {
                self.values.push(result);
            }
            return Ok(());
        }
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
        if let Some(result) = self.string_command(offset, arg_list_id, &values, &args)? {
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
            self.call(offset, args, ret_form)?;
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
        arg_list_id: i32,
        values: &[Value],
        args: &[Value],
    ) -> Result<Option<Value>, VmError> {
        let string = match values {
            [
                Value::Int(34),
                Value::Int(-1),
                Value::Int(index),
                Value::Int(_),
            ] => self
                .state
                .indexed_strings
                .get(&(34, *index))
                .cloned()
                .ok_or(self.operation(offset, "string-list-value"))?,
            [Value::Int(83), Value::Int(raw), Value::Int(_)] if owner(*raw) == 125 => {
                self.call_string_property(offset, *raw)?
            }
            _ => return Ok(None),
        };
        let operation = match values.last() {
            Some(Value::Int(operation)) => *operation,
            _ => return Ok(None),
        };
        Ok(Some(self.string_member(
            offset,
            &string,
            operation,
            arg_list_id,
            args,
        )?))
    }

    fn string_member(
        &self,
        offset: usize,
        string: &str,
        operation: i32,
        arg_list_id: i32,
        args: &[Value],
    ) -> Result<Value, VmError> {
        let integer = |index: usize| {
            args.get(index)
                .and_then(|value| match value {
                    Value::Int(value) => Some(*value),
                    _ => None,
                })
                .unwrap_or(0)
                .max(0) as usize
        };
        let needle = || {
            args.first()
                .map(|value| self.string_value(offset, value))
                .transpose()
                .map(Option::unwrap_or_default)
        };
        let display_width = |text: &str| {
            text.chars()
                .map(|ch| usize::from(!ch.is_ascii()) + 1)
                .sum::<usize>()
        };
        let left_width = |limit: usize| {
            string
                .chars()
                .scan(0usize, |width, ch| {
                    let next = *width + usize::from(!ch.is_ascii()) + 1;
                    (next <= limit).then(|| {
                        *width = next;
                        ch
                    })
                })
                .collect()
        };
        let right_width = |limit: usize| {
            let mut width = 0;
            let mut chars = Vec::new();
            for ch in string.chars().rev() {
                let next = width + usize::from(!ch.is_ascii()) + 1;
                if next > limit {
                    break;
                }
                width = next;
                chars.push(ch);
            }
            chars.into_iter().rev().collect()
        };
        let result = match operation {
            0 => Value::Text(string.chars().map(|ch| ch.to_ascii_uppercase()).collect()),
            1 => Value::Text(string.chars().map(|ch| ch.to_ascii_lowercase()).collect()),
            2 => Value::Text(string.chars().take(integer(0)).collect()),
            3 => {
                let start = integer(0);
                let chars = string.chars().skip(start);
                Value::Text(if arg_list_id == 0 || args.len() <= 1 {
                    chars.collect()
                } else {
                    chars.take(integer(1)).collect()
                })
            }
            4 => {
                let count = string.chars().count();
                Value::Text(
                    string
                        .chars()
                        .skip(count.saturating_sub(integer(0)))
                        .collect(),
                )
            }
            5 => Value::Int(display_width(string) as i32),
            6 => Value::Int(string.chars().count() as i32),
            7 => Value::Text(left_width(integer(0))),
            8 => {
                let start = integer(0);
                let limit = if arg_list_id == 0 || args.len() <= 1 {
                    None
                } else {
                    Some(integer(1))
                };
                let mut width = 0;
                let mut result = String::new();
                for ch in string.chars() {
                    let char_width = usize::from(!ch.is_ascii()) + 1;
                    if width >= start
                        && limit.is_none_or(|limit| display_width(&result) + char_width <= limit)
                    {
                        result.push(ch);
                    }
                    width += char_width;
                }
                Value::Text(result)
            }
            9 => Value::Text(right_width(integer(0))),
            10 => {
                let needle = needle()?;
                Value::Int(
                    string
                        .to_ascii_lowercase()
                        .find(&needle.to_ascii_lowercase())
                        .map_or(-1, |index| index as i32),
                )
            }
            11 => {
                let needle = needle()?;
                Value::Int(
                    string
                        .to_ascii_lowercase()
                        .rfind(&needle.to_ascii_lowercase())
                        .map_or(-1, |index| index as i32),
                )
            }
            12 => Value::Int(string.parse().unwrap_or(0)),
            13 => Value::Int(string.chars().nth(integer(0)).map_or(-1, |ch| ch as i32)),
            _ => return Err(self.operation(offset, "string-member-operation")),
        };
        Ok(result)
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
