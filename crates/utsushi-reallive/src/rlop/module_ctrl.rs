//! Control-flow RLOperation family (`module_jmp`).
//!
//! Implements the subset of rlvm's `module_jmp.cc` that drives scene
//! navigation: unconditional / conditional / indexed jumps, intra-scene
//! and cross-scene subroutine calls, paired returns, the `select` long-op
//! yield, and a hard halt. The registered ops drive scene navigation
//! through the typed [`DispatchOutcome`] variants pinned in —
//! no new direct VM mutation happens in op code.
//!
//! # Opcodes covered
//!
//! Op | Outcome
//! ----------------- | --------------------------------------
//! `goto` | [`DispatchOutcome::Jump`]
//! `goto_if` | `Jump` if `cond != 0`, else `Advance`
//! `goto_unless` | `Jump` if `cond == 0`, else `Advance`
//! `goto_on` | `Jump` to `table[value]` or `Advance`
//! `gosub` | [`DispatchOutcome::Subroutine`]
//! `gosub_if` | `Subroutine` if `cond != 0`
//! `farcall` | [`DispatchOutcome::FarCall`]
//! `farcall_with_args` | `FarCall` + intL arg-bank populated
//! `ret` | [`DispatchOutcome::Return`]
//! `rtl` | [`DispatchOutcome::ReturnFromCall`]
//! `halt` | [`DispatchOutcome::Halt`]
//!
//! The choice (`select` / `select_s` / `select_w` / `select_objbtn`)
//! family is **not** a control-flow opcode in RealLive — it lives in
//! `module_sel` ([`crate::rlop::module_sel`]) at `(module_type=0
//! module_id=2)`. The speculative `module_jmp` `select` slot that
//! introduced was deleted in per the
//! no-legacy-compat rule.
//!
//! # `(module_type, module_id, opcode)` keys
//!
//! Pinned per Haeleth's RLDEV `module_jmp` layout (research-anchor
//! cross-checked against rlvm's `modules/module_jmp.cc` opcode numbers).
//! Module `(0, 0x01)` is the jmp module; the opcode column matches the
//! integer arguments rlvm registers for the same op. The values are
//! re-pinned here as `const` so audit tooling can pin "the registry
//! covers exactly the opcode set" without spelunking through
//! the registration helper.
//!
//! # Substrate-honesty posture
//!
//! - Argument validation is typed. A wrong arity / wrong
//!   [`ExprValue`] variant produces a [`VmWarning::RlopArgsInvalid`] and
//!   the op falls through to `Advance` — never a panic, never a silent
//!   "advance and pretend nothing happened" without the warning.
//! - The cross-scene jump targets are not range-checked here; the VM's
//!   [`crate::vm::Vm::step`] surfaces a typed
//!   [`crate::vm::VmError::SceneNotFound`] when a `Jump` / `FarCall`
//!   resolves to a missing scene. This keeps the op layer thin.
//! - No `unwrap()` clusters in production code. The only `expect`
//!   `unwrap` references in this module are in the `#[cfg(test)]`
//!   block.

#[cfg(test)]
#[path = "module_ctrl_tests.rs"]
mod tests;
include!("module_ctrl_parts/001.rs");
include!("module_ctrl_parts/002.rs");
include!("module_ctrl_parts/003.rs");
