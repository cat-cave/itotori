//! Executing Siglus scene-bytecode VM.
//!
//! This module consumes Kaifuu's exact real-bytecode partition and operand
//! decoder. It does not enumerate text surfaces: program-counter movement,
//! stack values, global-variable assignments, calls, and branches determine
//! the emitted moments. Unsupported execution is terminal and recorded.

mod dispatch;
mod eval;
mod execute;
mod flow;
mod model;
mod pcmch;
mod program;
mod stage;
mod state;

pub use execute::{
    execute_scene, execute_scene_with_stage_objects, execute_title_scene,
    execute_title_scene_observed, execute_title_scene_with_stage_objects_observed,
    execute_title_scene_with_stage_snapshots_observed,
};
pub use model::{
    ChoicePolicy, ExecutionOutcome, ExecutionReport, Moment, PcmChannelState, SceneVm,
    StageSnapshot, VmError, VmState,
};
pub use program::{SceneProgram, SceneProgramError, TitleProgram, TitleProgramError};
pub use stage::{StageGeometry, StageObject};
