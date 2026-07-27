//! Cross-scene control-flow resolution.

use std::mem;

use super::execute::default_value;
use super::model::{CallFrame, ProgramSource, SceneFrame, SceneVm, Value, VmError};

impl SceneVm<'_> {
    pub(super) fn farcall(
        &mut self,
        offset: usize,
        arg_list_id: i32,
        args: Vec<Value>,
        return_form: i32,
    ) -> Result<(), VmError> {
        let Some(Value::Str(index)) = args.first() else {
            return Err(self.operation(offset, "farcall-argument"));
        };
        let scene_name = self
            .program()
            .strings
            .get(index)
            .cloned()
            .ok_or(self.operation(offset, "farcall-string"))?;
        let z_label = if arg_list_id >= 1 {
            match args.get(1) {
                Some(Value::Int(value)) => *value,
                Some(_) => return Err(self.operation(offset, "farcall-z-label")),
                None => 0,
            }
        } else {
            0
        };
        let target = match self.source {
            ProgramSource::Scene(_) => None,
            ProgramSource::Title(program) => program.farcall(&scene_name, z_label),
        }
        .ok_or(self.operation(offset, "farcall-target"))?;
        self.scenes.push(SceneFrame {
            scene_id: self.scene_id,
            pc: self.pc,
            values: mem::take(&mut self.values),
            frames: mem::take(&mut self.frames),
            calls: mem::take(&mut self.calls),
            speaker: self.speaker.take(),
            return_form,
        });
        self.calls.push(CallFrame {
            scene_id: target.scene_id,
            pc: target.pc,
            return_form: 0,
            arguments: Vec::new(),
            properties: Vec::new(),
            scene_entry: true,
        });
        self.scene_id = target.scene_id;
        self.pc = target.pc;
        Ok(())
    }

    pub(super) fn return_to_caller(&mut self, returns: Vec<Value>) -> bool {
        if let Some(frame) = self.calls.pop()
            && !frame.scene_entry
        {
            self.finish_return(frame.return_form, returns);
            self.scene_id = frame.scene_id;
            self.pc = frame.pc;
            return true;
        }
        let Some(frame) = self.scenes.pop() else {
            return false;
        };
        self.scene_id = frame.scene_id;
        self.pc = frame.pc;
        self.values = frame.values;
        self.frames = frame.frames;
        self.calls = frame.calls;
        self.speaker = frame.speaker;
        self.finish_return(frame.return_form, returns);
        true
    }

    fn finish_return(&mut self, return_form: i32, returns: Vec<Value>) {
        let no_explicit_return = returns.is_empty();
        self.values.extend(returns);
        if no_explicit_return && return_form != 0 {
            self.values.push(default_value(return_form));
        }
    }
}
