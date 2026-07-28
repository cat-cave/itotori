//! RealLive bytecode VM (fetch / decode / dispatch
//! advance) with longop yield + substrate snapshot.
//!
//! The VM owns the central RealLive execution state: the active
//! `(scene, pc)`, the call stack, the typed variable banks, and the
//! suspended-longop queue. Each [`Vm::step`] call fetches the next
//! bytecode element at the current `(scene, pc)`, decodes it, and
//! dispatches according to the
//! [`crate::rlop::DispatchOutcome`] table.
//!
//! # Substrate-honesty posture
//!
//! - **No panic on bad bytecode.** Every failure surfaces as a typed
//!   [`VmError`] or [`VmWarning`]. The synthetic test suite pins the
//!   `goto +0` budget terminator (`Vm::step_many`) and the empty-stack
//!   `ret` / `rtl` error paths.
//! - **No silent fallbacks.** A missing RLOp surfaces a typed
//!   [`VmWarning::MissingRlop`] event; the VM advances past the
//!   command and the warning is exposed via [`Vm::take_warnings`]. The
//!   `Halt` and `Yield` outcomes are typed; there is no
//!   "execute-something-else" fallback for an unsupported op.
//! - **Substrate `Inspectable` / `Restorable` adoption.** The VM does
//!   not invent a private snapshot format — every restorable field is
//!   carried under the `port.utsushi_reallive_vm.*` namespace inside a
//!   substrate [`StateTree`], and the `VarBanks` substrate impl is
//!   re-used verbatim for the banks payload.
//!
//! # Public surface
//!
//! - [`Vm`] — the VM itself.
//! - [`SceneId`] — scene-id alias (`u16`).
//! - [`Scene`] / [`SceneStore`] — the scene index the VM consumes.
//!   `Scene` carries a pre-decoded element list (so `pc` can index it
//!   by byte offset cheaply); `SceneStore` is the lookup the VM uses
//!   when a Jump / FarCall changes scene.
//! - [`StackFrame`] / [`StackFrameKind`] — call-stack frame types.
//! - [`StepOutcome`] — the typed result of a single step.
//! - [`StepManyOutcome`] — the typed result of [`Vm::step_many`].
//! - [`VmError`] / [`VmWarning`] / [`VmEvent`] — typed diagnostics.

mod command_args;
mod diagnostics;
#[cfg(test)]
#[path = "vm_overload_tests.rs"]
mod overload_tests;
mod substrate;
#[cfg(test)]
#[path = "vm_tests.rs"]
mod tests;
include!("vm_parts/001.rs");
include!("vm_parts/nested-002/002.rs");
include!("vm_parts/nested-002/003.rs");
include!("vm_parts/nested-002/004.rs");
include!("vm_parts/frame_counter.rs");
include!("vm_parts/005.rs");
