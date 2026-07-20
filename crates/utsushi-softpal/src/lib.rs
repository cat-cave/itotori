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
//! The runtime drives the arity-driven `Sv20` dispatch stream in play order:
//! every operator is walked (executed), each `Call` is dispatched to its
//! engine command surface — TEXT-SHOW emits a dialogue line, SELECT presents a
//! choice menu — and the nullary control operators advance scene/block state.
//! Conditional jump / expression-value semantics (which would require reversing
//! `Pal.dll`) are **not** modelled, so dispatch follows the linear play order
//! the disassembler establishes and headless choice selection is
//! deterministic-first. The oracle for the emitted text/choice stream is the
//! extracted bridge disassembly ([`kaifuu_softpal::ScriptScan::resolve`]): the
//! runtime cross-checks its executed stream against that 100%-resolved
//! disassembly and refuses to run on a mismatch.

#![forbid(unsafe_code)]
#![deny(missing_debug_implementations)]

mod engine_port;
mod scene_render;
mod scene_runtime;

pub use engine_port::{UtsushiSoftpalPort, UtsushiSoftpalPortContext};
pub use scene_render::{
    SoftpalFrame, SoftpalRedaction, SoftpalRenderError, encode_softpal_png, render_dialogue_frame,
};
pub use scene_runtime::{
    ChoiceOption, SceneStep, SoftpalRuntimeError, SoftpalScene, SoftpalSceneStats,
};

/// One-line capability boundary, mirroring the kaifuu detector's support
/// statements: what this runtime port DOES and, honestly, does not claim.
pub const SOFTPAL_RUNTIME_SUPPORT_BOUNDARY: &str = "utsushi-softpal executes the extracted Softpal \
    Sv20 scene-dispatch (arity-driven operator walk in play order: TEXT-SHOW dialogue emission with \
    speaker, SELECT choice menus with deterministic-first headless selection, nullary control-flow \
    markers) through the shared Utsushi substrate text + frame sinks, cross-checking the executed \
    dialogue/choice stream against the 100%-pointer-resolved kaifuu-softpal bridge disassembly, and \
    captures an edge-redacted message-box LAYOUT frame (structure only, no glyph pixels; the decoded \
    text is the localization proof). It does NOT evaluate Sv20 expression values or resolve \
    conditional jumps (Pal.dll semantics) — dispatch is the linear play order the disassembler \
    proves, not a branch-following interpreter.";
