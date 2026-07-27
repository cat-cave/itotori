//! Executing Siglus scene-bytecode VM.
//!
//! This module consumes Kaifuu's exact real-bytecode partition and operand
//! decoder. It does not enumerate text surfaces: program-counter movement,
//! stack values, global-variable assignments, calls, and branches determine
//! the emitted moments. Unsupported execution is terminal and recorded.

mod eval;
mod execute;
mod program;

pub use execute::{
    ChoicePolicy, ExecutionReport, Moment, SceneVm, VmError, VmState, execute_scene,
};
pub use program::{SceneProgram, SceneProgramError};
