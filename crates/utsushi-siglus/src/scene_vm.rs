//! Executing Siglus scene-bytecode VM.
//!
//! This module consumes Kaifuu's exact real-bytecode partition and operand
//! decoder. It does not enumerate text surfaces: program-counter movement,
//! stack values, global-variable assignments, calls, and branches determine
//! the emitted moments. Unsupported execution is terminal and recorded.

mod eval;
mod execute;
mod model;
mod program;

pub use execute::{execute_scene, execute_title_scene};
pub use model::{ChoicePolicy, ExecutionReport, Moment, SceneVm, VmError, VmState};
pub use program::{SceneProgram, SceneProgramError, TitleProgram, TitleProgramError};
