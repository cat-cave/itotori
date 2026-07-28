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

use crate::rlop::{DispatchOutcome, ExprValue, RlopKey};
use crate::var_banks::BankId;
use crate::vm::{SceneId, Vm, VmWarning};

/// `module_jmp` module type byte. Pinned per rlvm's
/// `modules/module_jmp.cc` registration (the jmp module is type `0` in
/// the rlvm decode).
pub const MODULE_JMP_TYPE: u8 = 0;
/// `module_jmp` module id byte. Pinned per rlvm's
/// `modules/module_jmp.cc` registration.
pub const MODULE_JMP_ID: u8 = 0x01;

/// rlvm-documented opcode for `goto`.
pub const OPCODE_GOTO: u16 = 0x0000;
/// rlvm-documented opcode for `goto_if`.
pub const OPCODE_GOTO_IF: u16 = 0x0001;
/// rlvm-documented opcode for `goto_unless`.
pub const OPCODE_GOTO_UNLESS: u16 = 0x0002;
/// rlvm-documented opcode for `goto_on`.
pub const OPCODE_GOTO_ON: u16 = 0x0003;
/// rlvm-documented opcode for `gosub`.
pub const OPCODE_GOSUB: u16 = 0x0010;
/// rlvm-documented opcode for `gosub_if`.
pub const OPCODE_GOSUB_IF: u16 = 0x0011;
/// rlvm-documented opcode for `ret`.
pub const OPCODE_RET: u16 = 0x0012;
/// rlvm-documented opcode for `farcall`.
pub const OPCODE_FARCALL: u16 = 0x0020;
/// rlvm-documented opcode for `farcall_with_args` (rlvm `farcall_with`).
pub const OPCODE_FARCALL_WITH_ARGS: u16 = 0x0021;
/// rlvm-documented opcode for `rtl`.
pub const OPCODE_RTL: u16 = 0x0022;
/// rlvm-documented opcode for `halt` (`end`/`exit` family — pinned at
/// this slot so the alpha-tier registry can be exhaustively named).
pub const OPCODE_HALT: u16 = 0x0040;

/// `(module_type, module_id, opcode)` key for `goto`.
pub const KEY_GOTO: RlopKey = RlopKey::new(MODULE_JMP_TYPE, MODULE_JMP_ID, OPCODE_GOTO);
/// Key for `goto_if`.
pub const KEY_GOTO_IF: RlopKey = RlopKey::new(MODULE_JMP_TYPE, MODULE_JMP_ID, OPCODE_GOTO_IF);
/// Key for `goto_unless`.
pub const KEY_GOTO_UNLESS: RlopKey =
    RlopKey::new(MODULE_JMP_TYPE, MODULE_JMP_ID, OPCODE_GOTO_UNLESS);
/// Key for `goto_on`.
pub const KEY_GOTO_ON: RlopKey = RlopKey::new(MODULE_JMP_TYPE, MODULE_JMP_ID, OPCODE_GOTO_ON);
/// Key for `gosub`.
pub const KEY_GOSUB: RlopKey = RlopKey::new(MODULE_JMP_TYPE, MODULE_JMP_ID, OPCODE_GOSUB);
/// Key for `gosub_if`.
pub const KEY_GOSUB_IF: RlopKey = RlopKey::new(MODULE_JMP_TYPE, MODULE_JMP_ID, OPCODE_GOSUB_IF);
/// Key for `ret`.
pub const KEY_RET: RlopKey = RlopKey::new(MODULE_JMP_TYPE, MODULE_JMP_ID, OPCODE_RET);
/// Key for `farcall`.
pub const KEY_FARCALL: RlopKey = RlopKey::new(MODULE_JMP_TYPE, MODULE_JMP_ID, OPCODE_FARCALL);
/// Key for `farcall_with_args`.
pub const KEY_FARCALL_WITH_ARGS: RlopKey =
    RlopKey::new(MODULE_JMP_TYPE, MODULE_JMP_ID, OPCODE_FARCALL_WITH_ARGS);
/// Key for `rtl`.
pub const KEY_RTL: RlopKey = RlopKey::new(MODULE_JMP_TYPE, MODULE_JMP_ID, OPCODE_RTL);
/// Key for `halt`.
pub const KEY_HALT: RlopKey = RlopKey::new(MODULE_JMP_TYPE, MODULE_JMP_ID, OPCODE_HALT);

/// rlvm-documented integer bank used to pass `farcall_with_args`
/// `gosub_with` parameter slots. Pinned at `intL` per
/// `docs/research/reallive-engine.md` §G — the "local" bank that rlvm's
/// `gosub_with` lower as a parameter-slot scratch area.
pub const FARCALL_ARG_BANK: BankId = BankId::IntL;
/// Cap on the number of arg-bank slots populated by
/// `farcall_with_args`. Bounded by the `VarBanks` 2 000-index ceiling
/// but capped to a smaller number here so a malformed args list cannot
/// run away with the bank. The 32-arg cap matches rlvm's
/// `LL_PARAMETERS_PER_CALL` heuristic in `stack_frame.cc`.
pub const FARCALL_ARG_BANK_SLOT_CAP: u16 = 32;

// Internal arg-validation helpers

/// Extract a non-negative `u32` pc from an [`ExprValue`]. Returns the
/// canonical "expected int arg" reason string when the variant is wrong
/// or the value is negative.
pub(super) fn arg_pc(value: &ExprValue, slot: &'static str) -> Result<u32, String> {
    let raw = value
        .as_int()
        .ok_or_else(|| format!("{slot}: expected Int, got Bytes"))?;
    u32::try_from(raw).map_err(|_| format!("{slot}: expected non-negative u32, got {raw}"))
}

/// Extract a `SceneId` (`u16`) from an [`ExprValue`]. The pc-style
/// reason string keeps the warning surface uniform.
pub(super) fn arg_scene(value: &ExprValue, slot: &'static str) -> Result<SceneId, String> {
    let raw = value
        .as_int()
        .ok_or_else(|| format!("{slot}: expected Int, got Bytes"))?;
    let unsigned = u32::try_from(raw)
        .map_err(|_| format!("{slot}: expected non-negative scene id, got {raw}"))?;
    SceneId::try_from(unsigned).map_err(|_| format!("{slot}: scene id {raw} exceeds u16::MAX"))
}

/// Extract a raw `i32` condition value from an [`ExprValue`].
pub(super) fn arg_cond(value: &ExprValue, slot: &'static str) -> Result<i32, String> {
    value
        .as_int()
        .ok_or_else(|| format!("{slot}: expected Int, got Bytes"))
}

/// Push a typed [`VmWarning::RlopArgsInvalid`] and fall through to
/// [`DispatchOutcome::Advance`]. Centralised so each op's invalid-arg
/// path is identical.
pub(super) fn warn_and_advance(vm: &mut Vm, op: &'static str, reason: String) -> DispatchOutcome {
    vm.push_warning(VmWarning::RlopArgsInvalid { op, reason });
    DispatchOutcome::Advance
}

mod branch;
mod legacy;

pub use branch::*;
pub use legacy::*;

#[cfg(test)]
#[path = "module_ctrl_tests.rs"]
mod tests;
