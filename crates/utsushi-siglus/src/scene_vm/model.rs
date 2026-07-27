//! Observable VM data and private execution state.

use super::program::{SceneProgram, TitleProgram};
use std::collections::BTreeMap;
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChoicePolicy {
    First,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Moment {
    Text {
        scene_id: u32,
        offset: usize,
        speaker: Option<String>,
        text: String,
    },
    Choice {
        scene_id: u32,
        offset: usize,
        options: Vec<String>,
        chosen: usize,
    },
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VmState {
    pub globals: BTreeMap<i32, i32>,
    pub indexed_globals: BTreeMap<(i32, i32), i32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionReport {
    pub scene_id: u32,
    pub instructions_executed: usize,
    pub moments: Vec<Moment>,
    pub halted: bool,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum VmError {
    #[error("utsushi.siglus.vm.stack_underflow: scene {scene_id} offset {offset}")]
    StackUnderflow { scene_id: u32, offset: usize },
    #[error("utsushi.siglus.vm.unresolved_jump: scene {scene_id} offset {offset} label {label}")]
    UnresolvedJump {
        scene_id: u32,
        offset: usize,
        label: i32,
    },
    #[error(
        "utsushi.siglus.vm.unsupported_opcode: scene {scene_id} offset {offset} lead {lead:#04x}"
    )]
    UnsupportedOpcode {
        scene_id: u32,
        offset: usize,
        lead: u8,
    },
    #[error(
        "utsushi.siglus.vm.unsupported_syscall: scene {scene_id} offset {offset} function {function_id} return_form {return_form}"
    )]
    UnsupportedSyscall {
        scene_id: u32,
        offset: usize,
        function_id: i32,
        return_form: i32,
    },
    #[error("utsushi.siglus.vm.unsupported_command_target: scene {scene_id} offset {offset}")]
    UnsupportedCommandTarget { scene_id: u32, offset: usize },
    #[error(
        "utsushi.siglus.vm.unsupported_script_function: scene {scene_id} offset {offset} function {function_id}"
    )]
    UnsupportedScriptFunction {
        scene_id: u32,
        offset: usize,
        function_id: i32,
    },
    #[error(
        "utsushi.siglus.vm.unsupported_operation: scene {scene_id} offset {offset} operation {operation}"
    )]
    UnsupportedOperation {
        scene_id: u32,
        offset: usize,
        operation: &'static str,
    },
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

#[derive(Debug)]
pub struct SceneVm<'a> {
    pub(super) source: ProgramSource<'a>,
    pub(super) entry_scene_id: u32,
    pub(super) scene_id: u32,
    pub(super) state: &'a mut VmState,
    pub(super) values: Vec<Value>,
    pub(super) frames: Vec<usize>,
    pub(super) calls: Vec<CallFrame>,
    pub(super) speaker: Option<String>,
    pub(super) pc: usize,
    pub(super) moments: Vec<Moment>,
    pub(super) policy: ChoicePolicy,
}

#[derive(Debug)]
pub(super) enum ProgramSource<'a> {
    Scene(&'a SceneProgram),
    Title(&'a TitleProgram),
}

#[derive(Debug, Clone, Copy)]
pub(super) struct CallFrame {
    pub(super) scene_id: u32,
    pub(super) pc: usize,
}
