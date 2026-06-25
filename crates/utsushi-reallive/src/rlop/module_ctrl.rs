//! UTSUSHI-210 — control-flow RLOperation family (`module_jmp`).
//!
//! Implements the subset of rlvm's `module_jmp.cc` that drives scene
//! navigation: unconditional / conditional / indexed jumps, intra-scene
//! and cross-scene subroutine calls, paired returns, the `select` long-op
//! yield, and a hard halt. The registered ops drive scene navigation
//! through the typed [`DispatchOutcome`] variants pinned in UTSUSHI-208 —
//! no new direct VM mutation happens in op code.
//!
//! # Opcodes covered
//!
//! | Op                | Outcome                                |
//! | ----------------- | -------------------------------------- |
//! | `goto`            | [`DispatchOutcome::Jump`]              |
//! | `goto_if`         | `Jump` if `cond != 0`, else `Advance`  |
//! | `goto_unless`     | `Jump` if `cond == 0`, else `Advance`  |
//! | `goto_on`         | `Jump` to `table[value]` or `Advance`  |
//! | `gosub`           | [`DispatchOutcome::Subroutine`]        |
//! | `gosub_if`        | `Subroutine` if `cond != 0`            |
//! | `farcall`         | [`DispatchOutcome::FarCall`]           |
//! | `farcall_with_args` | `FarCall` + intL arg-bank populated  |
//! | `ret`             | [`DispatchOutcome::Return`]            |
//! | `rtl`             | [`DispatchOutcome::ReturnFromCall`]    |
//! | `select`          | [`DispatchOutcome::Yield`] with a [`SelectionLongOp`] |
//! | `halt`            | [`DispatchOutcome::Halt`]              |
//!
//! # `(module_type, module_id, opcode)` keys
//!
//! Pinned per Haeleth's RLDEV `module_jmp` layout (research-anchor
//! cross-checked against rlvm's `modules/module_jmp.cc` opcode numbers).
//! Module `(0, 0x01)` is the jmp module; the opcode column matches the
//! integer arguments rlvm registers for the same op. The values are
//! re-pinned here as `const` so audit tooling can pin "the registry
//! covers exactly the UTSUSHI-210 opcode set" without spelunking through
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
//! - No `unwrap()` clusters in production code. The only `expect` /
//!   `unwrap` references in this module are in the `#[cfg(test)]`
//!   block.

use std::sync::Arc;

use crate::rlop::longops::SelectionLongOp;
use crate::rlop::{DispatchOutcome, ExprValue, LongOpId, RLOperation, RlopKey, RlopRegistry};
use crate::var_banks::{BankId, Value};
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
/// rlvm-documented opcode for `select`.
pub const OPCODE_SELECT: u16 = 0x0030;
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
/// Key for `select`.
pub const KEY_SELECT: RlopKey = RlopKey::new(MODULE_JMP_TYPE, MODULE_JMP_ID, OPCODE_SELECT);
/// Key for `halt`.
pub const KEY_HALT: RlopKey = RlopKey::new(MODULE_JMP_TYPE, MODULE_JMP_ID, OPCODE_HALT);

/// rlvm-documented integer bank used to pass `farcall_with_args` /
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

// ---------------------------------------------------------------------
// Internal arg-validation helpers
// ---------------------------------------------------------------------

/// Extract a non-negative `u32` pc from an [`ExprValue`]. Returns the
/// canonical "expected int arg" reason string when the variant is wrong
/// or the value is negative.
fn arg_pc(value: &ExprValue, slot: &'static str) -> Result<u32, String> {
    let raw = value
        .as_int()
        .ok_or_else(|| format!("{slot}: expected Int, got Bytes"))?;
    u32::try_from(raw).map_err(|_| format!("{slot}: expected non-negative u32, got {raw}"))
}

/// Extract a `SceneId` (`u16`) from an [`ExprValue`]. The pc-style
/// reason string keeps the warning surface uniform.
fn arg_scene(value: &ExprValue, slot: &'static str) -> Result<SceneId, String> {
    let raw = value
        .as_int()
        .ok_or_else(|| format!("{slot}: expected Int, got Bytes"))?;
    let unsigned = u32::try_from(raw)
        .map_err(|_| format!("{slot}: expected non-negative scene id, got {raw}"))?;
    SceneId::try_from(unsigned).map_err(|_| format!("{slot}: scene id {raw} exceeds u16::MAX"))
}

/// Extract a raw `i32` condition value from an [`ExprValue`].
fn arg_cond(value: &ExprValue, slot: &'static str) -> Result<i32, String> {
    value
        .as_int()
        .ok_or_else(|| format!("{slot}: expected Int, got Bytes"))
}

/// Push a typed [`VmWarning::RlopArgsInvalid`] and fall through to
/// [`DispatchOutcome::Advance`]. Centralised so each op's invalid-arg
/// path is identical.
fn warn_and_advance(vm: &mut Vm, op: &'static str, reason: String) -> DispatchOutcome {
    vm.push_warning(VmWarning::RlopArgsInvalid { op, reason });
    DispatchOutcome::Advance
}

// ---------------------------------------------------------------------
// goto family
// ---------------------------------------------------------------------

/// `goto(target_pc)` — unconditional intra-scene jump.
#[derive(Debug, Clone, Copy, Default)]
pub struct GotoOp;

impl RLOperation for GotoOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        if args.len() != 1 {
            return warn_and_advance(
                vm,
                "goto",
                format!("expected 1 arg (target_pc), got {}", args.len()),
            );
        }
        match arg_pc(&args[0], "target_pc") {
            Ok(pc) => DispatchOutcome::Jump {
                scene: vm.scene(),
                pc,
            },
            Err(reason) => warn_and_advance(vm, "goto", reason),
        }
    }
}

/// `goto_if(cond, target_pc)` — jump when `cond != 0`, else advance.
#[derive(Debug, Clone, Copy, Default)]
pub struct GotoIfOp;

impl RLOperation for GotoIfOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        if args.len() != 2 {
            return warn_and_advance(
                vm,
                "goto_if",
                format!("expected 2 args (cond, target_pc), got {}", args.len()),
            );
        }
        let cond = match arg_cond(&args[0], "cond") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, "goto_if", reason),
        };
        let pc = match arg_pc(&args[1], "target_pc") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, "goto_if", reason),
        };
        if cond != 0 {
            DispatchOutcome::Jump {
                scene: vm.scene(),
                pc,
            }
        } else {
            DispatchOutcome::Advance
        }
    }
}

/// `goto_unless(cond, target_pc)` — jump when `cond == 0`, else advance.
#[derive(Debug, Clone, Copy, Default)]
pub struct GotoUnlessOp;

impl RLOperation for GotoUnlessOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        if args.len() != 2 {
            return warn_and_advance(
                vm,
                "goto_unless",
                format!("expected 2 args (cond, target_pc), got {}", args.len()),
            );
        }
        let cond = match arg_cond(&args[0], "cond") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, "goto_unless", reason),
        };
        let pc = match arg_pc(&args[1], "target_pc") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, "goto_unless", reason),
        };
        if cond == 0 {
            DispatchOutcome::Jump {
                scene: vm.scene(),
                pc,
            }
        } else {
            DispatchOutcome::Advance
        }
    }
}

/// `goto_on(value, [target_0, target_1, ...])` — switch dispatch. Uses
/// `value` as an index into the target table. Out-of-range produces a
/// fall-through `Advance`; the spec calls this "indexed jump with a
/// default sink".
#[derive(Debug, Clone, Copy, Default)]
pub struct GotoOnOp;

impl RLOperation for GotoOnOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        if args.is_empty() {
            return warn_and_advance(
                vm,
                "goto_on",
                "expected at least 1 arg (value), got 0".to_string(),
            );
        }
        let value = match arg_cond(&args[0], "value") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, "goto_on", reason),
        };
        let table = &args[1..];
        let idx = match usize::try_from(value) {
            Ok(idx) => idx,
            Err(_) => return DispatchOutcome::Advance,
        };
        let Some(target_value) = table.get(idx) else {
            return DispatchOutcome::Advance;
        };
        match arg_pc(target_value, "target_pc") {
            Ok(pc) => DispatchOutcome::Jump {
                scene: vm.scene(),
                pc,
            },
            Err(reason) => warn_and_advance(vm, "goto_on", reason),
        }
    }
}

// ---------------------------------------------------------------------
// gosub family
// ---------------------------------------------------------------------

/// `gosub(return_pc, target_pc)` — push a subroutine frame and jump.
///
/// The `return_pc` is supplied as an explicit arg rather than read from
/// `vm.pc()` because `vm.pc()` reflects the *pre-command* pc inside
/// dispatch and the VM does not pass the post-command byte to the op
/// layer. The dispatcher (a follow-up node) will prepend the
/// computed `pc + cmd.byte_len` as the first arg before invoking this
/// op; for the synthetic test surface, the test passes it directly.
#[derive(Debug, Clone, Copy, Default)]
pub struct GosubOp;

impl RLOperation for GosubOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        if args.len() != 2 {
            return warn_and_advance(
                vm,
                "gosub",
                format!("expected 2 args (return_pc, target_pc), got {}", args.len()),
            );
        }
        let return_pc = match arg_pc(&args[0], "return_pc") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, "gosub", reason),
        };
        let target_pc = match arg_pc(&args[1], "target_pc") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, "gosub", reason),
        };
        DispatchOutcome::Subroutine {
            return_pc,
            target_scene: vm.scene(),
            target_pc,
        }
    }
}

/// `gosub_if(cond, return_pc, target_pc)` — conditional subroutine.
#[derive(Debug, Clone, Copy, Default)]
pub struct GosubIfOp;

impl RLOperation for GosubIfOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        if args.len() != 3 {
            return warn_and_advance(
                vm,
                "gosub_if",
                format!(
                    "expected 3 args (cond, return_pc, target_pc), got {}",
                    args.len()
                ),
            );
        }
        let cond = match arg_cond(&args[0], "cond") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, "gosub_if", reason),
        };
        let return_pc = match arg_pc(&args[1], "return_pc") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, "gosub_if", reason),
        };
        let target_pc = match arg_pc(&args[2], "target_pc") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, "gosub_if", reason),
        };
        if cond != 0 {
            DispatchOutcome::Subroutine {
                return_pc,
                target_scene: vm.scene(),
                target_pc,
            }
        } else {
            DispatchOutcome::Advance
        }
    }
}

// ---------------------------------------------------------------------
// farcall family
// ---------------------------------------------------------------------

/// `farcall(return_scene, return_pc, target_scene, target_pc)` —
/// cross-scene subroutine.
///
/// The four args are supplied explicitly because the op layer does not
/// see the post-command byte (`return_scene`/`return_pc`) or the
/// argument-decoded `target_scene`/`target_pc` — the dispatcher will
/// prepend them when arg extraction lands.
#[derive(Debug, Clone, Copy, Default)]
pub struct FarcallOp;

impl RLOperation for FarcallOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        if args.len() != 4 {
            return warn_and_advance(
                vm,
                "farcall",
                format!(
                    "expected 4 args (return_scene, return_pc, target_scene, target_pc), got {}",
                    args.len()
                ),
            );
        }
        let return_scene = match arg_scene(&args[0], "return_scene") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, "farcall", reason),
        };
        let return_pc = match arg_pc(&args[1], "return_pc") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, "farcall", reason),
        };
        let target_scene = match arg_scene(&args[2], "target_scene") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, "farcall", reason),
        };
        let target_pc = match arg_pc(&args[3], "target_pc") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, "farcall", reason),
        };
        DispatchOutcome::FarCall {
            return_scene,
            return_pc,
            target_scene,
            target_pc,
        }
    }
}

/// `farcall_with_args(return_scene, return_pc, target_scene,
/// target_pc, arg0, arg1, ...)` — cross-scene call that also populates
/// the parameter-slot bank ([`FARCALL_ARG_BANK`], i.e. `intL`) with the
/// trailing integer args.
///
/// rlvm models this through a per-frame parameter slot stack inside
/// `StackFrame`; we instead spill the slots into the typed `intL` bank
/// because that surface is already substrate-snapshot-aware and the
/// alpha-tier registry needs no per-frame slot stack to land scene-1.
/// A bytes-shaped arg is recorded as the slot-warning surface (the
/// caller passed Bytes where an Int was expected) and the slot is left
/// untouched.
#[derive(Debug, Clone, Copy, Default)]
pub struct FarcallWithArgsOp;

impl RLOperation for FarcallWithArgsOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        if args.len() < 4 {
            return warn_and_advance(
                vm,
                "farcall_with_args",
                format!(
                    "expected at least 4 args (return_scene, return_pc, target_scene, target_pc), \
                     got {}",
                    args.len()
                ),
            );
        }
        let return_scene = match arg_scene(&args[0], "return_scene") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, "farcall_with_args", reason),
        };
        let return_pc = match arg_pc(&args[1], "return_pc") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, "farcall_with_args", reason),
        };
        let target_scene = match arg_scene(&args[2], "target_scene") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, "farcall_with_args", reason),
        };
        let target_pc = match arg_pc(&args[3], "target_pc") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, "farcall_with_args", reason),
        };
        // Populate the parameter-slot bank. Bytes-shaped args produce a
        // typed warning and the slot is skipped (left at its prior
        // value); the surrounding FarCall still completes so the caller
        // sees the call effect even if a single slot was malformed.
        let slot_args = &args[4..];
        if slot_args.len() > FARCALL_ARG_BANK_SLOT_CAP as usize {
            vm.push_warning(VmWarning::RlopArgsInvalid {
                op: "farcall_with_args",
                reason: format!(
                    "{} slots requested; cap is {}",
                    slot_args.len(),
                    FARCALL_ARG_BANK_SLOT_CAP
                ),
            });
        }
        for (slot_idx, value) in slot_args.iter().enumerate() {
            if slot_idx >= FARCALL_ARG_BANK_SLOT_CAP as usize {
                break;
            }
            let slot_idx_u16 = slot_idx as u16;
            match value.as_int() {
                Some(int_value) => {
                    if let Err(warning) =
                        vm.banks_mut()
                            .set(FARCALL_ARG_BANK, slot_idx_u16, Value::Int(int_value))
                    {
                        vm.push_warning(VmWarning::RlopArgsInvalid {
                            op: "farcall_with_args",
                            reason: warning.to_string(),
                        });
                    }
                }
                None => {
                    vm.push_warning(VmWarning::RlopArgsInvalid {
                        op: "farcall_with_args",
                        reason: format!("slot {slot_idx}: expected Int, got Bytes"),
                    });
                }
            }
        }
        DispatchOutcome::FarCall {
            return_scene,
            return_pc,
            target_scene,
            target_pc,
        }
    }
}

// ---------------------------------------------------------------------
// ret / rtl / halt
// ---------------------------------------------------------------------

/// `ret()` — return from `gosub`.
#[derive(Debug, Clone, Copy, Default)]
pub struct RetOp;

impl RLOperation for RetOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        if !args.is_empty() {
            return warn_and_advance(vm, "ret", format!("expected 0 args, got {}", args.len()));
        }
        DispatchOutcome::Return
    }
}

/// `rtl()` — return from `farcall`.
#[derive(Debug, Clone, Copy, Default)]
pub struct RtlOp;

impl RLOperation for RtlOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        if !args.is_empty() {
            return warn_and_advance(vm, "rtl", format!("expected 0 args, got {}", args.len()));
        }
        DispatchOutcome::ReturnFromCall
    }
}

/// `halt()` — hard halt.
#[derive(Debug, Clone, Copy, Default)]
pub struct HaltOp;

impl RLOperation for HaltOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        if !args.is_empty() {
            return warn_and_advance(vm, "halt", format!("expected 0 args, got {}", args.len()));
        }
        DispatchOutcome::Halt
    }
}

// ---------------------------------------------------------------------
// select
// ---------------------------------------------------------------------

/// `select(choice_pc_0, choice_pc_1, ...)` — yields a selection long-op
/// whose resume target is one of `choice_pc_*`.
///
/// The op produces a [`DispatchOutcome::Yield`] carrying the
/// [`SelectionLongOp`] (with `user_choice = None`) serialised into the
/// long-op private state. A follow-up selection-runtime node wires user
/// input into the long-op via [`SelectionLongOp::record_user_choice`];
/// on resume the long-op emits a [`DispatchOutcome::Jump`].
///
/// The long-op id is taken from the [`SelectLongOpIdSource`] the
/// registration helper threaded into the op so the registry can keep a
/// stable, deterministic id assignment without reaching for a global
/// counter.
#[derive(Debug)]
pub struct SelectOp {
    longop_id: LongOpId,
}

impl SelectOp {
    /// Build a `select` op that emits long-ops under `longop_id`.
    /// Production wiring (UTSUSHI-212+) will instantiate one of these
    /// per registry; the alpha-tier registration helper threads a
    /// pinned id so the synthetic test can assert on the queued
    /// long-op verbatim.
    pub fn new(longop_id: LongOpId) -> Self {
        Self { longop_id }
    }
}

impl RLOperation for SelectOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        if args.is_empty() {
            return warn_and_advance(
                vm,
                "select",
                "expected at least 1 choice target_pc, got 0".to_string(),
            );
        }
        let mut choices = Vec::with_capacity(args.len());
        for (idx, value) in args.iter().enumerate() {
            match arg_pc(value, "choice_pc") {
                Ok(pc) => choices.push(pc),
                Err(reason) => {
                    return warn_and_advance(vm, "select", format!("choice {idx}: {reason}"));
                }
            }
        }
        let longop = match SelectionLongOp::new(self.longop_id, choices) {
            Ok(op) => op,
            Err(err) => {
                return warn_and_advance(vm, "select", err.to_string());
            }
        };
        let queued = match longop.to_longop() {
            Ok(queued) => queued,
            Err(err) => {
                return warn_and_advance(vm, "select", err.to_string());
            }
        };
        DispatchOutcome::Yield {
            longop_id: queued.id,
            private_state: queued.private_state,
        }
    }
}

// ---------------------------------------------------------------------
// Registry helper
// ---------------------------------------------------------------------

/// Pinned base for the long-op id space the control-flow registry
/// owns. The `select` op's queued long-op uses this id; later
/// per-module registries (text long-ops, animation long-ops, …) will
/// claim distinct bases so a snapshot can disambiguate the queued
/// long-op by id range.
pub const CONTROL_FLOW_LONGOP_ID_BASE: u64 = 0x0001_0000;

/// `select` long-op id assigned by [`register_control_flow_rlops`].
pub const SELECT_LONGOP_ID: LongOpId = LongOpId(CONTROL_FLOW_LONGOP_ID_BASE);

/// Number of opcodes [`register_control_flow_rlops`] populates. Pinned
/// so audit tooling can assert "the registry covers the UTSUSHI-210
/// frontier exactly" without scraping the helper body.
pub const CONTROL_FLOW_RLOP_COUNT: usize = 12;

/// Populate `registry` with the UTSUSHI-210 control-flow RLOperation
/// family. Returns the number of registered ops (matches
/// [`CONTROL_FLOW_RLOP_COUNT`]).
///
/// Idempotent in the sense that calling it twice replaces the previous
/// entries (the underlying [`RlopRegistry::register`] returns the prior
/// implementor, which we discard here — callers that need a
/// duplicate-detection assertion can call `RlopRegistry::register`
/// directly).
pub fn register_control_flow_rlops(registry: &mut RlopRegistry) -> usize {
    let entries: [(RlopKey, Arc<dyn RLOperation>); CONTROL_FLOW_RLOP_COUNT] = [
        (KEY_GOTO, Arc::new(GotoOp)),
        (KEY_GOTO_IF, Arc::new(GotoIfOp)),
        (KEY_GOTO_UNLESS, Arc::new(GotoUnlessOp)),
        (KEY_GOTO_ON, Arc::new(GotoOnOp)),
        (KEY_GOSUB, Arc::new(GosubOp)),
        (KEY_GOSUB_IF, Arc::new(GosubIfOp)),
        (KEY_FARCALL, Arc::new(FarcallOp)),
        (KEY_FARCALL_WITH_ARGS, Arc::new(FarcallWithArgsOp)),
        (KEY_RET, Arc::new(RetOp)),
        (KEY_RTL, Arc::new(RtlOp)),
        (KEY_SELECT, Arc::new(SelectOp::new(SELECT_LONGOP_ID))),
        (KEY_HALT, Arc::new(HaltOp)),
    ];
    let count = entries.len();
    for (key, op) in entries {
        registry.register(key, op);
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rlop::RlopRegistry;

    #[test]
    fn register_helper_populates_expected_count() {
        let mut registry = RlopRegistry::new();
        let count = register_control_flow_rlops(&mut registry);
        assert_eq!(count, CONTROL_FLOW_RLOP_COUNT);
        assert_eq!(registry.len(), CONTROL_FLOW_RLOP_COUNT);
    }

    #[test]
    fn register_helper_covers_every_pinned_key() {
        let mut registry = RlopRegistry::new();
        register_control_flow_rlops(&mut registry);
        for key in [
            KEY_GOTO,
            KEY_GOTO_IF,
            KEY_GOTO_UNLESS,
            KEY_GOTO_ON,
            KEY_GOSUB,
            KEY_GOSUB_IF,
            KEY_FARCALL,
            KEY_FARCALL_WITH_ARGS,
            KEY_RET,
            KEY_RTL,
            KEY_SELECT,
            KEY_HALT,
        ] {
            assert!(registry.get(key).is_some(), "missing key: {key}");
        }
    }

    #[test]
    fn goto_with_missing_arg_advances_and_warns() {
        let mut vm = Vm::new(7, 0);
        let outcome = GotoOp.dispatch(&mut vm, &[]);
        assert_eq!(outcome, DispatchOutcome::Advance);
        let warnings = vm.take_warnings();
        assert!(matches!(
            warnings.as_slice(),
            [VmWarning::RlopArgsInvalid { op: "goto", .. }]
        ));
    }

    #[test]
    fn goto_with_negative_target_warns() {
        let mut vm = Vm::new(7, 0);
        let outcome = GotoOp.dispatch(&mut vm, &[ExprValue::Int(-1)]);
        assert_eq!(outcome, DispatchOutcome::Advance);
        let warnings = vm.take_warnings();
        assert_eq!(warnings.len(), 1);
    }
}
