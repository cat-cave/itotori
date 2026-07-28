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
    /// String-list values are bytes, rather than indexes into whichever scene
    /// happens to be executing when the list is read.
    pub indexed_strings: BTreeMap<(i32, i32), String>,
    pub system_properties: BTreeMap<(i32, i32), i32>,
    /// Root-stage object arrays keyed by stage index and object slot.
    pub stage_objects: BTreeMap<i32, BTreeMap<i32, StageObject>>,
    /// Declared root-stage object-list lengths. Sparse slots stay sparse until
    /// an authored operation materialises one.
    pub stage_object_list_sizes: BTreeMap<i32, usize>,
    /// PCM-channel state mutated by the authored `PCMCH[channel].STOP` command.
    /// Audio output is outside this headless frame path, but the VM must retain
    /// the command's state transition rather than silently skipping it.
    pub pcm_channels: BTreeMap<i32, PcmChannelState>,
    pub(super) structured_system: BTreeMap<(u32, Vec<i32>), Value>,
}

/// Observable state for the PCM-channel command subset used by the live scene
/// path. Further PCMCH operations remain explicit terminal diagnostics until
/// their state effects are implemented.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PcmChannelState {
    pub stopped: bool,
    pub stop_fade: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionReport {
    pub scene_id: u32,
    /// Distinct archive scenes actually entered while executing this path.
    /// This makes cross-scene control flow visible without changing it.
    pub scenes_entered: BTreeSet<u32>,
    pub instructions_executed: usize,
    pub moments: Vec<Moment>,
    /// Renderable stage state at explicitly requested text/choice boundaries.
    /// Ordinary archive scans leave this empty rather than cloning title state
    /// for every message.
    pub stage_snapshots: Vec<StageSnapshot>,
    pub halted: bool,
}

/// A real VM boundary with the stage state which produced it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StageSnapshot {
    pub scene_id: u32,
    pub offset: usize,
    pub instruction_pointer: usize,
    pub moment: Moment,
    pub state: VmState,
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
    #[error(
        "utsushi.siglus.vm.unsupported_element_path: scene {scene_id} offset {offset} path {path:?}"
    )]
    UnsupportedElementPath {
        scene_id: u32,
        offset: usize,
        path: Vec<i32>,
    },
    #[error(
        "utsushi.siglus.vm.unsupported_stage_object_property: scene {scene_id} offset {offset} property {property}"
    )]
    UnsupportedStageObjectProperty {
        scene_id: u32,
        offset: usize,
        property: i32,
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
    pub(super) capture_stage_snapshots: bool,
    pub(super) stage_snapshots: Vec<StageSnapshot>,
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
