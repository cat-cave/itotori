//! Black-box execution proofs for the real scene-bytecode interpreter.

use kaifuu_siglus::SiglusIncludedCommand;
use utsushi_siglus::scene_vm::{
    Moment, SceneProgram, TitleProgram, VmError, VmState, execute_scene,
    execute_scene_with_stage_objects, execute_title_scene,
    execute_title_scene_with_stage_snapshots_observed,
};

#[path = "scene_vm_execution/control_flow.rs"]
mod scene_vm_execution_control_flow;
#[path = "scene_vm_execution/fixtures.rs"]
mod scene_vm_execution_fixtures;
#[path = "scene_vm_execution/included.rs"]
mod scene_vm_execution_included;
#[path = "scene_vm_execution/stage.rs"]
mod scene_vm_execution_stage;
#[path = "scene_vm_execution/diagnostics.rs"]
mod scene_vm_execution_diagnostics;
