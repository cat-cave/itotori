//! Softpal (Amuse-Craft "Pal" engine) runtime **EnginePort**: it loads the
//! extracted `SCRIPT.SRC` + `TEXT.DAT`, EXECUTES the `Sv20` scene-dispatch
//! stack machine (text emission, choice menus, control-flow markers) through
//! the shared Utsushi substrate, and CAPTURES an edge-redacted layout frame.
//!
//! # Where this sits
//!
//! `kaifuu-softpal` owns the **decode**: the `PAC ` container, the `TEXT.DAT`
//! string-pool codec, and the `Sv20` opcode/stack-machine **disassembler**
//! (0-unknown exhaustive on two real titles). Its own docs stop short of
//! *executing* the stack machine, deferring that to "the Utsushi Softpal
//! replay runtime, a separate node" — this crate is that runtime.
//!
//! # Faithful scope (no fabricated runtime behaviour)
//!
//! The runtime evaluates the established arithmetic/comparison operators,
//! persistent operand banks, labels, calls, and conditional jumps. It emits
//! dialogue, choices, and branch moments in executed order. An operand form or
//! engine dispatch not established by byte evidence stops execution with a
//! counted diagnostic; it is never silently treated as a no-op.

#![forbid(unsafe_code)]
#![deny(missing_debug_implementations)]

mod engine_port;
mod scene_render;
mod scene_runtime;
mod scene_vm;

pub use engine_port::{UtsushiSoftpalPort, UtsushiSoftpalPortContext};
pub use scene_render::{
    SoftpalFrame, SoftpalRedaction, SoftpalRenderError, encode_softpal_png, render_dialogue_frame,
};
pub use scene_runtime::{
    ChoiceOption, RuntimeBankWrite, RuntimeDiagnostic, RuntimeTraceEvent, SceneStep,
    SoftpalRuntimeError, SoftpalScene, SoftpalSceneStats,
};
/// One-line capability boundary, mirroring the kaifuu detector's support
/// statements: what this runtime port DOES and, honestly, does not claim.
pub const SOFTPAL_RUNTIME_SUPPORT_BOUNDARY: &str = "utsushi-softpal executes the extracted Softpal \
    Sv20 VM through the shared Utsushi substrate text + frame sinks: established arithmetic, \
    comparisons, operand banks, label calls, and conditional jumps produce deterministic dialogue, \
    choice, and branch moments. Unproven operands or engine dispatches stop with counted diagnostics; \
    no unproven construct is silently skipped. It captures an edge-redacted message-box LAYOUT frame.";
