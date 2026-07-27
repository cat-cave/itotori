//! Program-counter dispatch and explicit runtime diagnostics.
use super::program::SceneProgram;
use kaifuu_siglus::{SiglusArgForm, SiglusOpcode, SiglusOperand, SiglusPush};
use std::collections::BTreeMap;
use thiserror::Error;

/// Finite guard for malformed/cyclic script paths; it is a terminal diagnostic.
const STEP_LIMIT: usize = 100_000;

/// Deterministic selection policy for `GLOBAL.SELBTN`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChoicePolicy {
    /// Pick the first presented option, consistently across runs.
    First,
}

/// Observable execution event in program-counter order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Moment {
    /// A decoded `CD_TEXT` run reached by execution.
    Text {
        offset: usize,
        speaker: Option<String>,
        text: String,
    },
    /// A selection reached by execution and resolved by the fixed policy.
    Choice {
        offset: usize,
        options: Vec<String>,
        chosen: usize,
    },
}

/// Persistent state, separate from call-local frames, for later scene reads.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VmState {
    /// The global integer bank addressed by packed `0x7f` element heads.
    pub globals: BTreeMap<i32, i32>,
}

/// Execution outcome and the moments observed before a terminal condition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionReport {
    /// Scene decoded and executed.
    pub scene_id: u32,
    /// Number of real instructions dispatched.
    pub instructions_executed: usize,
    /// Ordered text/choice moments from the executed path.
    pub moments: Vec<Moment>,
    /// Normal terminal condition.
    pub halted: bool,
}

/// A loud execution failure. Every unsupported opcode or runtime call is
/// terminal; callers can aggregate this tuple without inspecting title text.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum VmError {
    /// An instruction needs a stack value that execution did not produce.
    #[error("utsushi.siglus.vm.stack_underflow: scene {scene_id} offset {offset}")]
    StackUnderflow { scene_id: u32, offset: usize },
    /// A label did not resolve to a bytecode instruction.
    #[error("utsushi.siglus.vm.unresolved_jump: scene {scene_id} offset {offset} label {label}")]
    UnresolvedJump {
        scene_id: u32,
        offset: usize,
        label: i32,
    },
    /// A source opcode lacks an execution implementation.
    #[error(
        "utsushi.siglus.vm.unsupported_opcode: scene {scene_id} offset {offset} lead {lead:#04x}"
    )]
    UnsupportedOpcode {
        scene_id: u32,
        offset: usize,
        lead: u8,
    },
    /// A direct system call is not in the deliberately supported no-effect or
    /// control subset. The function id + return form are the aggregate key.
    #[error(
        "utsushi.siglus.vm.unsupported_syscall: scene {scene_id} offset {offset} function {function_id} return_form {return_form}"
    )]
    UnsupportedSyscall {
        scene_id: u32,
        offset: usize,
        function_id: i32,
        return_form: i32,
    },
    /// A command target cannot be dispatched as a direct global-system slot.
    #[error("utsushi.siglus.vm.unsupported_command_target: scene {scene_id} offset {offset}")]
    UnsupportedCommandTarget { scene_id: u32, offset: usize },
    /// A script-function element has no decoded entry-point map in the scene.
    #[error(
        "utsushi.siglus.vm.unsupported_script_function: scene {scene_id} offset {offset} function {function_id}"
    )]
    UnsupportedScriptFunction {
        scene_id: u32,
        offset: usize,
        function_id: i32,
    },
    /// Evaluation encountered a source operation whose semantics are absent.
    #[error(
        "utsushi.siglus.vm.unsupported_operation: scene {scene_id} offset {offset} operation {operation}"
    )]
    UnsupportedOperation {
        scene_id: u32,
        offset: usize,
        operation: &'static str,
    },
    /// The path did not reach a terminal instruction within its safety budget.
    #[error("utsushi.siglus.vm.step_limit: scene {scene_id} after {steps} instructions")]
    StepLimit { scene_id: u32, steps: usize },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Value {
    Int(i32),
    Str(i32),
    System(i32),
    Function(i32),
}

/// A single-scene interpreter. Its state may be retained and passed to a later
/// scene, while its operand/call stacks are always reset at scene entry.
#[derive(Debug)]
pub struct SceneVm<'a> {
    pub(super) program: &'a SceneProgram,
    pub(super) state: &'a mut VmState,
    pub(super) values: Vec<Value>,
    pub(super) frames: Vec<usize>,
    pub(super) calls: Vec<usize>,
    pub(super) speaker: Option<String>,
    pub(super) pc: usize,
    pub(super) moments: Vec<Moment>,
    pub(super) policy: ChoicePolicy,
}

/// Execute one decoded scene under the deterministic first-choice policy.
pub fn execute_scene(
    program: &SceneProgram,
    state: &mut VmState,
) -> Result<ExecutionReport, VmError> {
    SceneVm::new(program, state, ChoicePolicy::First).run()
}

impl<'a> SceneVm<'a> {
    /// Construct a scene-entry VM with fresh operand and call stacks.
    pub fn new(program: &'a SceneProgram, state: &'a mut VmState, policy: ChoicePolicy) -> Self {
        Self {
            program,
            state,
            values: Vec::new(),
            frames: Vec::new(),
            calls: Vec::new(),
            speaker: None,
            pc: 0,
            moments: Vec::new(),
            policy,
        }
    }

    /// Drive dispatch until `CD_RETURN` at scene entry or `CD_EOF`.
    pub fn run(mut self) -> Result<ExecutionReport, VmError> {
        for steps in 0..STEP_LIMIT {
            let Some(current) = self.program.instructions.get(self.pc) else {
                return Ok(self.report(steps));
            };
            let offset = current.instruction.byte_offset;
            let opcode = current.instruction.opcode;
            let operand = current.operand.clone();
            self.pc += 1;
            match (opcode, operand) {
                (
                    SiglusOpcode::Nl
                    | SiglusOpcode::Arg
                    | SiglusOpcode::SelBlockStart
                    | SiglusOpcode::SelBlockEnd
                    | SiglusOpcode::DecProp,
                    _,
                ) => {}
                (SiglusOpcode::Push, SiglusOperand::Push(push)) => self.push(push),
                (SiglusOpcode::Pop, SiglusOperand::Pop(form)) => {
                    if form != 0 {
                        self.pop(offset)?;
                    }
                }
                (SiglusOpcode::Copy, _) => {
                    let value = self
                        .values
                        .last()
                        .cloned()
                        .ok_or_else(|| self.underflow(offset))?;
                    self.values.push(value);
                }
                (SiglusOpcode::ElmPoint, _) => self.frames.push(self.values.len()),
                (SiglusOpcode::CopyElm, _) => self.copy_frame(offset)?,
                (SiglusOpcode::Property, _) => {
                    let value = self.read_element(offset)?;
                    self.values.push(value);
                }
                (SiglusOpcode::Assign, _) => self.assign(offset)?,
                (SiglusOpcode::Operate1, SiglusOperand::Operate1(_, op)) => {
                    self.unary(offset, op)?;
                }
                (SiglusOpcode::Operate2, SiglusOperand::Operate2(_, _, op)) => {
                    self.binary(offset, op)?;
                }
                (SiglusOpcode::Goto, SiglusOperand::Goto(label)) => self.jump(offset, label)?,
                (SiglusOpcode::GotoTrue, SiglusOperand::GotoTrue(label)) => {
                    if self.integer(offset)? != 0 {
                        self.jump(offset, label)?;
                    }
                }
                (SiglusOpcode::GotoFalse, SiglusOperand::GotoFalse(label)) => {
                    if self.integer(offset)? == 0 {
                        self.jump(offset, label)?;
                    }
                }
                (
                    SiglusOpcode::Gosub | SiglusOpcode::GosubStr,
                    SiglusOperand::Gosub(label, forms) | SiglusOperand::GosubStr(label, forms),
                ) => {
                    self.pop_n(offset, count(&forms))?;
                    self.calls.push(self.pc);
                    self.jump(offset, label)?;
                }
                (SiglusOpcode::Return, SiglusOperand::Return(forms)) => {
                    let returns = self.pop_n(offset, count(&forms))?;
                    if let Some(pc) = self.calls.pop() {
                        self.values.extend(returns);
                        self.pc = pc;
                    } else {
                        return Ok(self.report(steps + 1));
                    }
                }
                (
                    SiglusOpcode::Command { .. },
                    SiglusOperand::Command {
                        arg_forms,
                        ret_form,
                        ..
                    },
                ) => self.command(offset, count(&arg_forms), ret_form)?,
                (SiglusOpcode::Text, _) => self.text(offset)?,
                (SiglusOpcode::Name, _) => self.name(offset)?,
                (SiglusOpcode::Eof, _) => return Ok(self.report(steps + 1)),
                (SiglusOpcode::Unknown { lead, .. }, _) => {
                    return Err(VmError::UnsupportedOpcode {
                        scene_id: self.program.scene_id,
                        offset,
                        lead,
                    });
                }
                _ => {
                    return Err(VmError::UnsupportedOperation {
                        scene_id: self.program.scene_id,
                        offset,
                        operation: "operand-shape",
                    });
                }
            }
        }
        Err(VmError::StepLimit {
            scene_id: self.program.scene_id,
            steps: STEP_LIMIT,
        })
    }

    fn report(&self, instructions_executed: usize) -> ExecutionReport {
        ExecutionReport {
            scene_id: self.program.scene_id,
            instructions_executed,
            moments: self.moments.clone(),
            halted: true,
        }
    }
    fn underflow(&self, offset: usize) -> VmError {
        VmError::StackUnderflow {
            scene_id: self.program.scene_id,
            offset,
        }
    }
    fn pop(&mut self, offset: usize) -> Result<Value, VmError> {
        self.values.pop().ok_or_else(|| self.underflow(offset))
    }
    pub(super) fn integer(&mut self, offset: usize) -> Result<i32, VmError> {
        match self.pop(offset)? {
            Value::Int(value) => Ok(value),
            _ => Err(VmError::UnsupportedOperation {
                scene_id: self.program.scene_id,
                offset,
                operation: "non-integer condition",
            }),
        }
    }
    fn push(&mut self, push: SiglusPush) {
        match push {
            SiglusPush::Int(value) => self.values.push(Value::Int(value)),
            SiglusPush::Str(index) => self.values.push(Value::Str(index)),
            SiglusPush::Form(_) => self.values.push(Value::Int(0)),
        }
    }
    fn copy_frame(&mut self, offset: usize) -> Result<(), VmError> {
        let start = *self.frames.last().ok_or_else(|| self.underflow(offset))?;
        self.frames.push(self.values.len());
        self.values.extend_from_within(start..);
        Ok(())
    }
    fn frame(&mut self, offset: usize) -> Result<Vec<Value>, VmError> {
        let start = self.frames.pop().ok_or_else(|| self.underflow(offset))?;
        Ok(self.values.split_off(start))
    }
    fn element(&mut self, offset: usize) -> Result<Value, VmError> {
        let values = self.frame(offset)?;
        match values.as_slice() {
            [Value::Int(raw)] if (*raw >> 24) & 0xff == 0x7f => Ok(Value::Int(
                *self.state.globals.get(&(*raw & 0x00ff_ffff)).unwrap_or(&0),
            )),
            [Value::Int(raw)] if (*raw >> 24) & 0xff == 0x00 => {
                Ok(Value::System(*raw & 0x00ff_ffff))
            }
            [Value::Int(raw)] if (*raw >> 24) & 0xff == 0x7e => {
                Ok(Value::Function(*raw & 0x00ff_ffff))
            }
            _ => Err(VmError::UnsupportedOperation {
                scene_id: self.program.scene_id,
                offset,
                operation: "element-path",
            }),
        }
    }
    fn read_element(&mut self, offset: usize) -> Result<Value, VmError> {
        self.element(offset)
    }
    fn assign(&mut self, offset: usize) -> Result<(), VmError> {
        let value = self.integer(offset)?;
        let values = self.frame(offset)?;
        match values.as_slice() {
            [Value::Int(raw)] if (*raw >> 24) & 0xff == 0x7f => {
                self.state.globals.insert(*raw & 0x00ff_ffff, value);
                Ok(())
            }
            _ => Err(VmError::UnsupportedOperation {
                scene_id: self.program.scene_id,
                offset,
                operation: "assignment-target",
            }),
        }
    }
    fn jump(&mut self, offset: usize, label: i32) -> Result<(), VmError> {
        self.pc = self.program.target(label).ok_or(VmError::UnresolvedJump {
            scene_id: self.program.scene_id,
            offset,
            label,
        })?;
        Ok(())
    }
    fn pop_n(&mut self, offset: usize, count: usize) -> Result<Vec<Value>, VmError> {
        let mut values = Vec::with_capacity(count);
        for _ in 0..count {
            values.push(self.pop(offset)?);
        }
        values.reverse();
        Ok(values)
    }
    fn command(&mut self, offset: usize, arg_count: usize, ret_form: i32) -> Result<(), VmError> {
        let args = self.pop_n(offset, arg_count)?;
        let target = self.element(offset)?;
        if let Value::Function(index) = target {
            self.calls.push(self.pc);
            self.pc = self
                .program
                .function(index)
                .ok_or(VmError::UnsupportedScriptFunction {
                    scene_id: self.program.scene_id,
                    offset,
                    function_id: index,
                })?;
            return Ok(());
        }
        let Value::System(function_id) = target else {
            return Err(VmError::UnsupportedCommandTarget {
                scene_id: self.program.scene_id,
                offset,
            });
        };
        let result = match function_id {
            2 => return Ok(()),
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
            | 79..=83
            | 85..=87
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
                    scene_id: self.program.scene_id,
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
    fn select(&mut self, offset: usize, args: Vec<Value>) -> Result<Value, VmError> {
        let options = args
            .into_iter()
            .filter_map(|value| match value {
                Value::Str(index) => self.program.strings.get(&index).cloned(),
                _ => None,
            })
            .collect::<Vec<_>>();
        if options.is_empty() {
            return Err(VmError::UnsupportedOperation {
                scene_id: self.program.scene_id,
                offset,
                operation: "empty-selection",
            });
        }
        let chosen = match self.policy {
            ChoicePolicy::First => 0,
        };
        self.moments.push(Moment::Choice {
            offset,
            options,
            chosen,
        });
        Ok(Value::Int(chosen as i32 + 1))
    }
    fn text(&mut self, offset: usize) -> Result<(), VmError> {
        let Value::Str(index) = self.pop(offset)? else {
            return Err(VmError::UnsupportedOperation {
                scene_id: self.program.scene_id,
                offset,
                operation: "computed-text",
            });
        };
        let text =
            self.program
                .strings
                .get(&index)
                .cloned()
                .ok_or(VmError::UnsupportedOperation {
                    scene_id: self.program.scene_id,
                    offset,
                    operation: "text-string",
                })?;
        self.moments.push(Moment::Text {
            offset,
            speaker: self.speaker.clone(),
            text,
        });
        Ok(())
    }
    fn name(&mut self, offset: usize) -> Result<(), VmError> {
        let Value::Str(index) = self.pop(offset)? else {
            return Err(VmError::UnsupportedOperation {
                scene_id: self.program.scene_id,
                offset,
                operation: "computed-name",
            });
        };
        self.speaker = self.program.strings.get(&index).cloned();
        Ok(())
    }
}

fn count(forms: &[SiglusArgForm]) -> usize {
    forms
        .iter()
        .map(|form| match form {
            SiglusArgForm::Form(_) => 1,
            SiglusArgForm::List(items) => count(items),
        })
        .sum()
}
