//! Program-counter dispatch and explicit runtime diagnostics.

use super::model::{
    ChoicePolicy, ExecutionOutcome, ExecutionReport, Moment, ProgramSource, SceneVm, Value,
    VmError, VmState,
};
use super::program::{SceneProgram, TitleProgram};
use kaifuu_siglus::{SiglusArgForm, SiglusOpcode, SiglusOperand, SiglusPush};

/// Finite guard for malformed/cyclic script paths; it is a terminal diagnostic.
const STEP_LIMIT: usize = 100_000;

/// Execute one decoded scene under the deterministic first-choice policy.
pub fn execute_scene(
    program: &SceneProgram,
    state: &mut VmState,
) -> Result<ExecutionReport, VmError> {
    let mut vm = SceneVm::new(program, state, ChoicePolicy::First);
    vm.run()
}

/// Execute one scene while materializing root-stage object state.
pub fn execute_scene_with_stage_objects(
    program: &SceneProgram,
    state: &mut VmState,
) -> Result<ExecutionReport, VmError> {
    let mut vm = SceneVm::new_with_stage_objects(program, state, ChoicePolicy::First, true);
    vm.run()
}

/// Execute an entry scene with the archive-level shared command table.
pub fn execute_title_scene(
    program: &TitleProgram,
    scene_id: u32,
    state: &mut VmState,
) -> Result<ExecutionReport, VmError> {
    let mut vm = SceneVm::for_title(program, scene_id, state, ChoicePolicy::First, false)?;
    vm.run()
}

/// Execute an entry scene while retaining moments emitted before a terminal
/// diagnostic interrupts dispatch.
pub fn execute_title_scene_observed(
    program: &TitleProgram,
    scene_id: u32,
    state: &mut VmState,
) -> Result<ExecutionOutcome, VmError> {
    let mut vm = SceneVm::for_title(program, scene_id, state, ChoicePolicy::First, false)?;
    Ok(vm.run_observed())
}

/// Execute an entry scene while materializing root-stage object state and
/// retaining work completed before a terminal diagnostic.
pub fn execute_title_scene_with_stage_objects_observed(
    program: &TitleProgram,
    scene_id: u32,
    state: &mut VmState,
) -> Result<ExecutionOutcome, VmError> {
    let mut vm = SceneVm::for_title(program, scene_id, state, ChoicePolicy::First, true)?;
    Ok(vm.run_observed())
}

/// Execute one entry scene while retaining the real root-stage state at every
/// emitted text or choice boundary. This is deliberately opt-in: a complete
/// title scan has tens of thousands of messages and must not clone every VM
/// state merely to produce static structure.
pub fn execute_title_scene_with_stage_snapshots_observed(
    program: &TitleProgram,
    scene_id: u32,
    state: &mut VmState,
) -> Result<ExecutionOutcome, VmError> {
    let mut vm = SceneVm::for_title_with_snapshots(program, scene_id, state, ChoicePolicy::First)?;
    Ok(vm.run_observed())
}

impl<'a> SceneVm<'a> {
    /// Construct a scene-entry VM with fresh operand and call stacks.
    pub fn new(program: &'a SceneProgram, state: &'a mut VmState, policy: ChoicePolicy) -> Self {
        Self::new_with_stage_objects(program, state, policy, false)
    }

    fn new_with_stage_objects(
        program: &'a SceneProgram,
        state: &'a mut VmState,
        policy: ChoicePolicy,
        stage_objects_enabled: bool,
    ) -> Self {
        Self {
            source: ProgramSource::Scene(program),
            entry_scene_id: program.scene_id,
            scene_id: program.scene_id,
            state,
            values: Vec::new(),
            frames: Vec::new(),
            calls: Vec::new(),
            scenes: Vec::new(),
            speaker: None,
            pc: 0,
            moments: Vec::new(),
            policy,
            stage_objects_enabled,
            capture_stage_snapshots: false,
            stage_snapshots: Vec::new(),
            instructions_executed: 0,
            scenes_entered: [program.scene_id].into_iter().collect(),
        }
    }

    fn for_title(
        program: &'a TitleProgram,
        scene_id: u32,
        state: &'a mut VmState,
        policy: ChoicePolicy,
        stage_objects_enabled: bool,
    ) -> Result<Self, VmError> {
        if program.scene(scene_id).is_none() {
            return Err(VmError::UnsupportedScriptFunction {
                scene_id,
                offset: 0,
                function_id: -1,
            });
        }
        Ok(Self {
            source: ProgramSource::Title(program),
            entry_scene_id: scene_id,
            scene_id,
            state,
            values: Vec::new(),
            frames: Vec::new(),
            calls: Vec::new(),
            scenes: Vec::new(),
            speaker: None,
            pc: 0,
            moments: Vec::new(),
            policy,
            stage_objects_enabled,
            capture_stage_snapshots: false,
            stage_snapshots: Vec::new(),
            instructions_executed: 0,
            scenes_entered: [scene_id].into_iter().collect(),
        })
    }

    fn for_title_with_snapshots(
        program: &'a TitleProgram,
        scene_id: u32,
        state: &'a mut VmState,
        policy: ChoicePolicy,
    ) -> Result<Self, VmError> {
        let mut vm = Self::for_title(program, scene_id, state, policy, true)?;
        vm.capture_stage_snapshots = true;
        Ok(vm)
    }

    pub(super) fn program(&self) -> &SceneProgram {
        match self.source {
            ProgramSource::Scene(program) => program,
            ProgramSource::Title(program) => program
                .scene(self.scene_id)
                .expect("title scene was validated before dispatch"),
        }
    }

    /// Drive dispatch until `CD_RETURN` at scene entry or `CD_EOF`.
    pub fn run(&mut self) -> Result<ExecutionReport, VmError> {
        for steps in 0..STEP_LIMIT {
            let Some(current) = self.program().instructions.get(self.pc).cloned() else {
                return Err(VmError::UnexpectedEnd {
                    scene_id: self.scene_id,
                    offset: self.program().end_offset(),
                });
            };
            self.instructions_executed = steps + 1;
            let offset = current.instruction.byte_offset;
            let opcode = current.instruction.opcode;
            let operand = current.operand.clone();
            self.pc += 1;
            match (opcode, operand) {
                (SiglusOpcode::Arg, _) => self.expand_args(offset)?,
                (SiglusOpcode::DecProp, SiglusOperand::DecProp(form, prop_id)) => {
                    self.declare_property(offset, form, prop_id)?;
                }
                (SiglusOpcode::Push, SiglusOperand::Push(push)) => self.push(push),
                (SiglusOpcode::Pop, SiglusOperand::Pop(form)) if form != 0 => {
                    self.pop(offset)?;
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
                (SiglusOpcode::GotoTrue, SiglusOperand::GotoTrue(label))
                    if self.integer(offset)? != 0 =>
                {
                    self.jump(offset, label)?;
                }
                (SiglusOpcode::GotoFalse, SiglusOperand::GotoFalse(label))
                    if self.integer(offset)? == 0 =>
                {
                    self.jump(offset, label)?;
                }
                (
                    SiglusOpcode::Nl
                    | SiglusOpcode::SelBlockStart
                    | SiglusOpcode::SelBlockEnd
                    | SiglusOpcode::Pop
                    | SiglusOpcode::GotoTrue
                    | SiglusOpcode::GotoFalse,
                    _,
                ) => {}
                (
                    SiglusOpcode::Gosub | SiglusOpcode::GosubStr,
                    SiglusOperand::Gosub(label, forms) | SiglusOperand::GosubStr(label, forms),
                ) => {
                    let arguments = self.pop_n(offset, count(&forms))?;
                    self.call(
                        offset,
                        arguments,
                        if opcode == SiglusOpcode::GosubStr {
                            20
                        } else {
                            10
                        },
                    )?;
                    self.jump(offset, label)?;
                }
                (SiglusOpcode::Return, SiglusOperand::Return(forms)) => {
                    let returns = self.pop_n(offset, count(&forms))?;
                    if !self.return_to_caller(returns) {
                        return Ok(self.report(true));
                    }
                }
                (
                    SiglusOpcode::Command { .. },
                    SiglusOperand::Command {
                        arg_list_id,
                        arg_forms,
                        ret_form,
                        ..
                    },
                ) => self.command(offset, arg_list_id, count(&arg_forms), ret_form)?,
                (SiglusOpcode::Text, _) => self.text(offset)?,
                (SiglusOpcode::Name, _) => self.name(offset)?,
                (SiglusOpcode::Eof, _) => return Ok(self.report(true)),
                (SiglusOpcode::Unknown { lead, .. }, _) => {
                    return Err(VmError::UnsupportedOpcode {
                        scene_id: self.scene_id,
                        offset,
                        lead,
                    });
                }
                _ => return Err(self.operation(offset, "operand-shape")),
            }
        }
        Err(VmError::StepLimit {
            scene_id: self.entry_scene_id,
            steps: STEP_LIMIT,
        })
    }

    pub fn run_observed(&mut self) -> ExecutionOutcome {
        match self.run() {
            Ok(report) => ExecutionOutcome::Complete(report),
            Err(error) => ExecutionOutcome::Terminal {
                report: self.report(false),
                error,
            },
        }
    }

    fn report(&self, halted: bool) -> ExecutionReport {
        ExecutionReport {
            scene_id: self.entry_scene_id,
            scenes_entered: self.scenes_entered.clone(),
            instructions_executed: self.instructions_executed,
            moments: self.moments.clone(),
            stage_snapshots: self.stage_snapshots.clone(),
            halted,
        }
    }

    pub(super) fn record_moment(&mut self, moment: Moment) {
        self.moments.push(moment.clone());
        if self.capture_stage_snapshots {
            self.stage_snapshots.push(super::model::StageSnapshot {
                scene_id: self.scene_id,
                offset: match &moment {
                    Moment::Text { offset, .. } | Moment::Choice { offset, .. } => *offset,
                },
                instruction_pointer: self.pc,
                moment,
                state: self.state.clone(),
            });
        }
    }

    fn underflow(&self, offset: usize) -> VmError {
        VmError::StackUnderflow {
            scene_id: self.scene_id,
            offset,
        }
    }

    pub(super) fn pop(&mut self, offset: usize) -> Result<Value, VmError> {
        self.values.pop().ok_or_else(|| self.underflow(offset))
    }

    pub(super) fn integer(&mut self, offset: usize) -> Result<i32, VmError> {
        match self.pop(offset)? {
            Value::Int(value) => Ok(value),
            _ => Err(self.operation(offset, "non-integer condition")),
        }
    }

    fn push(&mut self, push: SiglusPush) {
        self.values.push(match push {
            SiglusPush::Int(value) => Value::Int(value),
            SiglusPush::Str(index) => Value::Str(index),
            SiglusPush::Form(_) => Value::Int(0),
        });
    }

    fn copy_frame(&mut self, offset: usize) -> Result<(), VmError> {
        let start = *self.frames.last().ok_or_else(|| self.underflow(offset))?;
        self.frames.push(self.values.len());
        self.values.extend_from_within(start..);
        Ok(())
    }

    pub(super) fn frame(&mut self, offset: usize) -> Result<Vec<Value>, VmError> {
        let start = self.frames.pop().ok_or_else(|| self.underflow(offset))?;
        Ok(self.values.split_off(start))
    }

    fn read_element(&mut self, offset: usize) -> Result<Value, VmError> {
        let values = self.frame(offset)?;
        self.resolve_element(offset, values)
    }

    fn jump(&mut self, offset: usize, label: i32) -> Result<(), VmError> {
        self.pc = self
            .program()
            .target(label)
            .ok_or(VmError::UnresolvedJump {
                scene_id: self.scene_id,
                offset,
                label,
            })?;
        Ok(())
    }

    pub(super) fn pop_n(&mut self, offset: usize, count: usize) -> Result<Vec<Value>, VmError> {
        let mut values = Vec::with_capacity(count);
        for _ in 0..count {
            values.push(self.pop(offset)?);
        }
        values.reverse();
        Ok(values)
    }

    pub(super) fn script_function(&self, index: i32) -> Option<super::program::FunctionTarget> {
        match self.source {
            ProgramSource::Scene(program) => {
                program
                    .function(index)
                    .map(|pc| super::program::FunctionTarget {
                        scene_id: self.scene_id,
                        pc,
                    })
            }
            ProgramSource::Title(program) => program.function(self.scene_id, index),
        }
    }

    pub(super) fn enter_scene(&mut self, scene_id: u32, pc: usize) {
        self.scene_id = scene_id;
        self.pc = pc;
        self.scenes_entered.insert(scene_id);
    }

    pub(super) fn operation(&self, offset: usize, operation: &'static str) -> VmError {
        VmError::UnsupportedOperation {
            scene_id: self.scene_id,
            offset,
            operation,
        }
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

pub(super) fn default_value(form: i32) -> Value {
    match form {
        20 => Value::Str(-1),
        _ => Value::Int(0),
    }
}
