//! Observable VM data and private execution state.

use super::program::{SceneProgram, TitleProgram};
use super::stage::StageObject;
use std::collections::{BTreeMap, BTreeSet};
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
    pub indexed_strings: BTreeMap<(i32, i32), i32>,
    pub system_properties: BTreeMap<(i32, i32), i32>,
    /// Root-stage object arrays keyed by stage index and object slot.
    pub stage_objects: BTreeMap<i32, BTreeMap<i32, StageObject>>,
    pub(super) structured_system: BTreeMap<(u32, Vec<i32>), Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionReport {
    pub scene_id: u32,
    /// Distinct archive scenes actually entered while executing this path.
    /// This makes cross-scene control flow visible without changing it.
    pub scenes_entered: BTreeSet<u32>,
    pub instructions_executed: usize,
    pub moments: Vec<Moment>,
    pub halted: bool,
}

/// The observable work completed before a VM either reached its terminus or
/// encountered a terminal diagnostic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecutionOutcome {
    Complete(ExecutionReport),
    Terminal {
        report: ExecutionReport,
        error: VmError,
    },
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
    Text(String),
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
    pub(super) scenes: Vec<SceneFrame>,
    pub(super) speaker: Option<String>,
    pub(super) pc: usize,
    pub(super) moments: Vec<Moment>,
    pub(super) policy: ChoicePolicy,
    pub(super) stage_objects_enabled: bool,
    pub(super) instructions_executed: usize,
    pub(super) scenes_entered: BTreeSet<u32>,
}

#[derive(Debug)]
pub(super) enum ProgramSource<'a> {
    Scene(&'a SceneProgram),
    Title(&'a TitleProgram),
}

#[derive(Debug)]
pub(super) struct CallFrame {
    pub(super) scene_id: u32,
    pub(super) pc: usize,
    pub(super) return_form: i32,
    pub(super) arguments: Vec<Value>,
    pub(super) properties: Vec<CallProperty>,
    pub(super) scene_entry: bool,
}

#[derive(Debug)]
pub(super) struct SceneFrame {
    pub(super) scene_id: u32,
    pub(super) pc: usize,
    pub(super) values: Vec<Value>,
    pub(super) frames: Vec<usize>,
    pub(super) calls: Vec<CallFrame>,
    pub(super) speaker: Option<String>,
    pub(super) return_form: i32,
}

#[derive(Debug, Clone)]
pub(super) struct CallProperty {
    pub(super) form: i32,
    pub(super) value: Value,
    pub(super) indexed: BTreeMap<i32, Value>,
}
