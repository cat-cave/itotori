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
mod program;
mod state;

pub use execute::{execute_scene, execute_title_scene, execute_title_scene_observed};
pub use model::{
    ChoicePolicy, ExecutionOutcome, ExecutionReport, Moment, SceneVm, VmError, VmState,
};
pub use program::{SceneProgram, SceneProgramError, TitleProgram, TitleProgramError};
