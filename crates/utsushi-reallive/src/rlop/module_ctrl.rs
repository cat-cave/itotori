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
//! | `halt`            | [`DispatchOutcome::Halt`]              |
//!
//! The choice (`select` / `select_s` / `select_w` / `select_objbtn`)
//! family is **not** a control-flow opcode in RealLive — it lives in
//! `module_sel` ([`crate::rlop::module_sel`]) at `(module_type=1,
//! module_id=2)`. The speculative `module_jmp` `select` slot that
//! UTSUSHI-210 introduced was deleted in UTSUSHI-211 per the
//! no-legacy-compat rule.
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

use crate::rlop::{DispatchOutcome, ExprValue, RLOperation, RlopKey, RlopRegistry};
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
        let Ok(idx) = usize::try_from(value) else {
            return DispatchOutcome::Advance;
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
// Registry helper
// ---------------------------------------------------------------------

/// Number of opcodes [`register_control_flow_rlops`] populates. Pinned
/// so audit tooling can assert "the registry covers the UTSUSHI-210
/// frontier exactly" without scraping the helper body. UTSUSHI-211
/// deleted the speculative `module_jmp` `select` slot — the choice
/// family lives in [`crate::rlop::module_sel`].
pub const CONTROL_FLOW_RLOP_COUNT: usize = 11;

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
        (KEY_HALT, Arc::new(HaltOp)),
    ];
    let count = entries.len();
    for (key, op) in entries {
        registry.register(key, op);
    }
    count
}

// ---------------------------------------------------------------------
// Real-bytes control-flow numbering + exhaustive-linear-walk registrar
// ---------------------------------------------------------------------

/// The real `module_jmp` opcode numbering (rlvm `module_jmp.cc`),
/// cross-checked against the `kaifuu-reallive` decompiler's byte-validated
/// `goto_kind` id sets on Sweetie HD + Kanon. Each entry is `(opcode,
/// semantic name)`.
///
/// This SUPERSEDES the speculative UTSUSHI-210 numbering
/// (`gosub`/`ret`/`farcall`/`rtl` invented at `0x10`/`0x12`/`0x20`/`0x22`):
/// on the real bytes `gosub` is opcode 5, `ret`/`jump`/`farcall`/`rtl` are
/// 10..=13, and the `*_with` variants are 16..=19.
pub const JMP_REAL_OPCODES: &[(u16, &str)] = &[
    (0, "goto"),
    (1, "goto_if"),
    (2, "goto_unless"),
    (3, "goto_on"),
    (4, "goto_case"),
    (5, "gosub"),
    (6, "gosub_if"),
    (7, "gosub_unless"),
    (8, "gosub_on"),
    (9, "gosub_case"),
    (10, "ret"),
    (11, "jump"),
    (12, "farcall"),
    (13, "rtl"),
    (16, "gosub_with"),
    (17, "ret_with"),
    (18, "farcall_with"),
    (19, "rtl_with"),
];

/// The RealLive lattice module-type bytes a `module_jmp` command is
/// observed under (type is a compiler-version artifact; module_id 1 is the
/// real semantic key). The cross-scene `farcall` variant is observed under
/// type 2 on Kanon, so all three are registered.
const JMP_LATTICE_TYPES: [u8; 3] = [0, 1, 2];

/// A control-flow opcode dispatched as an exhaustive-linear-walk
/// [`DispatchOutcome::Advance`], carrying its real opcode + semantic name
/// for identity. See [`register_control_flow_linear_walk`].
#[derive(Debug, Clone, Copy)]
pub struct JmpLinearWalkOp {
    /// Real `module_jmp` opcode.
    pub opcode: u16,
    /// Semantic name (`"goto"`, `"gosub"`, `"farcall"`, …).
    pub name: &'static str,
}

impl RLOperation for JmpLinearWalkOp {
    fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        DispatchOutcome::Advance
    }
}

/// Register the FULL real-numbered `module_jmp` control-flow family under
/// every observed lattice type, dispatched as an exhaustive-linear-walk
/// [`DispatchOutcome::Advance`].
///
/// This is the registrar the full-module cataloging **replay** mounts (in
/// place of [`register_control_flow_rlops`]): the replay must VISIT every
/// command in a scene — following branches would both skip the un-taken
/// arms (cataloguing fewer commands) and spin forever on the input-gated
/// loops a headless deterministic walk cannot exit. The decoder
/// ([`crate::bytecode_element`]) already fully consumes the goto-family
/// jump-target framing, so the walk never desyncs. The branch-execution
/// state machine (real `Jump` / `Subroutine` / `FarCall` outcomes) lives in
/// the [`GotoOp`] / [`GosubOp`] / [`FarcallOp`] family above — unit-tested
/// and driven by the syscall route dispatcher — and is intentionally NOT
/// used by the cataloguing replay.
///
/// Returns the number of `(type, opcode)` keys registered.
pub fn register_control_flow_linear_walk(registry: &mut RlopRegistry) -> usize {
    let mut registered = 0usize;
    for &(opcode, name) in JMP_REAL_OPCODES {
        for module_type in JMP_LATTICE_TYPES {
            let key = RlopKey::new(module_type, MODULE_JMP_ID, opcode);
            registry.register(key, Arc::new(JmpLinearWalkOp { opcode, name }));
            registered += 1;
        }
    }
    registered
}

// ---------------------------------------------------------------------
// Real-numbered branch-FOLLOWING control-flow family
// ---------------------------------------------------------------------
//
// This is the counterpart to [`register_control_flow_linear_walk`]: where
// the linear walk mounts every `module_jmp` opcode as a cataloguing
// `Advance` (so a headless replay VISITS every command), this family
// mounts the REAL branch semantics at the REAL opcode numbers so a scene
// EXECUTES its actual control flow — goto/goto_if/goto_unless/goto_on
// rewrite the pc, gosub/ret push+pop an intra-scene frame, and
// jump/farcall/rtl transfer across the multi-scene store. Following a
// branch means the un-taken arms are NOT visited (correct for execution,
// vs cataloguing); the linear walk is retained as the exhaustive-coverage
// check.
//
// Arg layout each op observes (the VM decodes the `(...)` list, then
// APPENDS the trailing goto-family jump-target pointers as `Int` args —
// see `Vm::dispatch_element`):
//   goto (0)          : [target]                     (1 target, no arglist)
//   goto_if (1)       : [cond, target]               ((cond) + 1 target)
//   goto_unless (2)   : [cond, target]
//   goto_on (3)       : [value, t0, t1, …]           ((value) + N targets)
//   goto_case (4)     : [target]                     (VM pre-resolves the
//                                                      matched case via
//                                                      Command::goto_case_exprs;
//                                                      empty ⇒ fall through)
//   gosub (5)         : [target]                     (return pc from vm.post_pc())
//   gosub_if (6)      : [cond, target]
//   ret (10)          : []                            (pop subroutine frame)
//   jump (11)         : [scene] | [scene, entrypoint] (cross-scene, no return)
//   farcall (12)      : [scene] | [scene, entrypoint] (cross-scene call)
//   rtl (13)          : []                            (pop far-call frame)
//   gosub_with (16)   : [arg0, …, argN, target]       (args + 1 target)
//   ret_with (17)     : [value]                       (pop subroutine frame)
//   farcall_with (18) : [scene, entrypoint, arg0, …]  (cross-scene call + args)
//   rtl_with (19)     : [value]                       (pop far-call frame)

/// Extract an optional entrypoint index from a cross-scene op's args.
/// `[scene]` → entrypoint 0 (scene start); `[scene, ep, …]` → `ep`.
fn arg_entrypoint(args: &[ExprValue]) -> u16 {
    args.get(1)
        .and_then(ExprValue::as_int)
        .and_then(|v| u16::try_from(v).ok())
        .unwrap_or(0)
}

/// `goto(target)` — unconditional intra-scene jump (real opcode 0).
#[derive(Debug, Clone, Copy, Default)]
pub struct JmpGoto;
impl RLOperation for JmpGoto {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        match args.last().map(|a| arg_pc(a, "target_pc")) {
            Some(Ok(pc)) => DispatchOutcome::Jump {
                scene: vm.scene(),
                pc,
            },
            Some(Err(reason)) => warn_and_advance(vm, "goto", reason),
            None => warn_and_advance(vm, "goto", "expected 1 arg (target_pc), got 0".to_string()),
        }
    }
}

/// `goto_if(cond, target)` — jump when `cond != 0` (real opcode 1).
#[derive(Debug, Clone, Copy, Default)]
pub struct JmpGotoIf;
impl RLOperation for JmpGotoIf {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        GotoIfOp.dispatch(vm, args)
    }
}

/// `goto_unless(cond, target)` — jump when `cond == 0` (real opcode 2).
#[derive(Debug, Clone, Copy, Default)]
pub struct JmpGotoUnless;
impl RLOperation for JmpGotoUnless {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        GotoUnlessOp.dispatch(vm, args)
    }
}

/// `goto_on(value, [targets])` — indexed jump (real opcode 3).
#[derive(Debug, Clone, Copy, Default)]
pub struct JmpGotoOn;
impl RLOperation for JmpGotoOn {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        GotoOnOp.dispatch(vm, args)
    }
}

/// `goto_case(value) { (c0) @t0; (c1) @t1; … }` — value-matched jump
/// (real opcode 4).
///
/// The exact `value == case_i` selection is reproduced: the bytecode
/// decoder now records each case's match EXPRESSION
/// (`Command::goto_case_exprs`) and the VM evaluates them against the
/// discriminant in real memory context, passing the single pre-resolved
/// target pc as `args[0]`. An empty arg list means no case matched and no
/// default `()` case is present, so control falls through past the block
/// ([`DispatchOutcome::Advance`]). This supersedes the previous
/// discriminant-as-index approximation.
#[derive(Debug, Clone, Copy, Default)]
pub struct JmpGotoCase;
impl RLOperation for JmpGotoCase {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        match args.first().map(|t| arg_pc(t, "target_pc")) {
            Some(Ok(pc)) => DispatchOutcome::Jump {
                scene: vm.scene(),
                pc,
            },
            Some(Err(reason)) => warn_and_advance(vm, "goto_case", reason),
            // No matching case and no default `()` case — fall through.
            None => DispatchOutcome::Advance,
        }
    }
}

/// `gosub(target)` — intra-scene subroutine call (real opcode 5). The
/// return pc is read from [`Vm::post_pc`] (the byte after this command).
#[derive(Debug, Clone, Copy, Default)]
pub struct JmpGosub;
impl RLOperation for JmpGosub {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        match args.last().map(|a| arg_pc(a, "target_pc")) {
            Some(Ok(target_pc)) => DispatchOutcome::Subroutine {
                return_pc: vm.post_pc(),
                target_scene: vm.scene(),
                target_pc,
            },
            Some(Err(reason)) => warn_and_advance(vm, "gosub", reason),
            None => warn_and_advance(vm, "gosub", "expected 1 arg (target_pc), got 0".to_string()),
        }
    }
}

/// `gosub_if(cond, target)` — conditional intra-scene subroutine (real
/// opcode 6).
#[derive(Debug, Clone, Copy, Default)]
pub struct JmpGosubIf;
impl RLOperation for JmpGosubIf {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        if args.len() < 2 {
            return warn_and_advance(
                vm,
                "gosub_if",
                format!("expected 2 args (cond, target), got {}", args.len()),
            );
        }
        let cond = match arg_cond(&args[0], "cond") {
            Ok(v) => v,
            Err(reason) => return warn_and_advance(vm, "gosub_if", reason),
        };
        if cond == 0 {
            return DispatchOutcome::Advance;
        }
        match args.last().map(|a| arg_pc(a, "target_pc")) {
            Some(Ok(target_pc)) => DispatchOutcome::Subroutine {
                return_pc: vm.post_pc(),
                target_scene: vm.scene(),
                target_pc,
            },
            _ => warn_and_advance(vm, "gosub_if", "missing target".to_string()),
        }
    }
}

/// `gosub_unless(cond, target)` — subroutine when `cond == 0` (real
/// opcode 7). Same `(cond) + 1 target` framing as `goto_unless`.
#[derive(Debug, Clone, Copy, Default)]
pub struct JmpGosubUnless;
impl RLOperation for JmpGosubUnless {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        if args.len() < 2 {
            return warn_and_advance(
                vm,
                "gosub_unless",
                format!("expected 2 args (cond, target), got {}", args.len()),
            );
        }
        let cond = match arg_cond(&args[0], "cond") {
            Ok(v) => v,
            Err(reason) => return warn_and_advance(vm, "gosub_unless", reason),
        };
        if cond != 0 {
            return DispatchOutcome::Advance;
        }
        match args.last().map(|a| arg_pc(a, "target_pc")) {
            Some(Ok(target_pc)) => DispatchOutcome::Subroutine {
                return_pc: vm.post_pc(),
                target_scene: vm.scene(),
                target_pc,
            },
            _ => warn_and_advance(vm, "gosub_unless", "missing target".to_string()),
        }
    }
}

/// `gosub_on(value, [targets])` — indexed subroutine (real opcode 8).
/// Same `(value) + N targets` framing as `goto_on`.
#[derive(Debug, Clone, Copy, Default)]
pub struct JmpGosubOn;
impl RLOperation for JmpGosubOn {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        if args.is_empty() {
            return warn_and_advance(
                vm,
                "gosub_on",
                "expected at least 1 arg (value)".to_string(),
            );
        }
        let value = match arg_cond(&args[0], "value") {
            Ok(v) => v,
            Err(reason) => return warn_and_advance(vm, "gosub_on", reason),
        };
        let table = &args[1..];
        let Ok(idx) = usize::try_from(value) else {
            return DispatchOutcome::Advance;
        };
        match table.get(idx).map(|t| arg_pc(t, "target_pc")) {
            Some(Ok(target_pc)) => DispatchOutcome::Subroutine {
                return_pc: vm.post_pc(),
                target_scene: vm.scene(),
                target_pc,
            },
            _ => DispatchOutcome::Advance,
        }
    }
}

/// `gosub_case(value) { (c0) @t0; … }` — value-matched subroutine (real
/// opcode 9). Same case-expression selection as [`JmpGotoCase`]: the VM
/// evaluates each case's match expression against the discriminant and
/// passes the single pre-resolved target pc as `args[0]` (empty ⇒ no case
/// matched and no default `()`, so control falls through).
#[derive(Debug, Clone, Copy, Default)]
pub struct JmpGosubCase;
impl RLOperation for JmpGosubCase {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        match args.first().map(|t| arg_pc(t, "target_pc")) {
            Some(Ok(target_pc)) => DispatchOutcome::Subroutine {
                return_pc: vm.post_pc(),
                target_scene: vm.scene(),
                target_pc,
            },
            Some(Err(reason)) => warn_and_advance(vm, "gosub_case", reason),
            // No matching case and no default `()` case — fall through.
            None => DispatchOutcome::Advance,
        }
    }
}

/// `gosub_with(args…, target)` — intra-scene subroutine call carrying
/// parameter-slot args (real opcode 16). Args before the trailing target
/// are spilled into the `intL` parameter bank ([`FARCALL_ARG_BANK`]).
#[derive(Debug, Clone, Copy, Default)]
pub struct JmpGosubWith;
impl RLOperation for JmpGosubWith {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let Some((target, slots)) = args.split_last() else {
            return warn_and_advance(vm, "gosub_with", "expected at least 1 arg".to_string());
        };
        let target_pc = match arg_pc(target, "target_pc") {
            Ok(pc) => pc,
            Err(reason) => return warn_and_advance(vm, "gosub_with", reason),
        };
        populate_arg_bank(vm, "gosub_with", slots);
        DispatchOutcome::Subroutine {
            return_pc: vm.post_pc(),
            target_scene: vm.scene(),
            target_pc,
        }
    }
}

/// `jump(scene[, entrypoint])` — cross-scene jump with no return (real
/// opcode 11).
#[derive(Debug, Clone, Copy, Default)]
pub struct JmpJump;
impl RLOperation for JmpJump {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        if args.is_empty() {
            return warn_and_advance(vm, "jump", "expected at least 1 arg (scene)".to_string());
        }
        match arg_scene(&args[0], "target_scene") {
            Ok(target_scene) => DispatchOutcome::JumpToScene {
                target_scene,
                entrypoint: arg_entrypoint(args),
            },
            Err(reason) => warn_and_advance(vm, "jump", reason),
        }
    }
}

/// `farcall(scene[, entrypoint])` — cross-scene subroutine call (real
/// opcode 12). `rtl` returns.
#[derive(Debug, Clone, Copy, Default)]
pub struct JmpFarcall;
impl RLOperation for JmpFarcall {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        if args.is_empty() {
            return warn_and_advance(vm, "farcall", "expected at least 1 arg (scene)".to_string());
        }
        match arg_scene(&args[0], "target_scene") {
            Ok(target_scene) => DispatchOutcome::FarCallToScene {
                target_scene,
                entrypoint: arg_entrypoint(args),
            },
            Err(reason) => warn_and_advance(vm, "farcall", reason),
        }
    }
}

/// `farcall_with(scene, entrypoint, args…)` — cross-scene subroutine call
/// carrying parameter-slot args (real opcode 18).
#[derive(Debug, Clone, Copy, Default)]
pub struct JmpFarcallWith;
impl RLOperation for JmpFarcallWith {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        if args.is_empty() {
            return warn_and_advance(
                vm,
                "farcall_with",
                "expected at least 1 arg (scene)".to_string(),
            );
        }
        let target_scene = match arg_scene(&args[0], "target_scene") {
            Ok(s) => s,
            Err(reason) => return warn_and_advance(vm, "farcall_with", reason),
        };
        let entrypoint = arg_entrypoint(args);
        if args.len() > 2 {
            populate_arg_bank(vm, "farcall_with", &args[2..]);
        }
        DispatchOutcome::FarCallToScene {
            target_scene,
            entrypoint,
        }
    }
}

/// `ret()` / `ret_with(value)` — pop a subroutine frame (real opcodes 10 /
/// 17). Any `ret_with` return value is not modelled (it affects data, not
/// control flow).
#[derive(Debug, Clone, Copy, Default)]
pub struct JmpRet;
impl RLOperation for JmpRet {
    fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        DispatchOutcome::Return
    }
}

/// `rtl()` / `rtl_with(value)` — pop a far-call frame (real opcodes 13 /
/// 19).
#[derive(Debug, Clone, Copy, Default)]
pub struct JmpRtl;
impl RLOperation for JmpRtl {
    fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        DispatchOutcome::ReturnFromCall
    }
}

/// Spill `slots` into the `intL` parameter bank ([`FARCALL_ARG_BANK`]),
/// bounded by [`FARCALL_ARG_BANK_SLOT_CAP`]. Shared by `gosub_with` /
/// `farcall_with`; bytes-shaped slots surface a typed warning.
fn populate_arg_bank(vm: &mut Vm, op: &'static str, slots: &[ExprValue]) {
    for (slot_idx, value) in slots.iter().enumerate() {
        if slot_idx >= FARCALL_ARG_BANK_SLOT_CAP as usize {
            break;
        }
        match value.as_int() {
            Some(int_value) => {
                if let Err(warning) =
                    vm.banks_mut()
                        .set(FARCALL_ARG_BANK, slot_idx as u16, Value::Int(int_value))
                {
                    vm.push_warning(VmWarning::RlopArgsInvalid {
                        op,
                        reason: warning.to_string(),
                    });
                }
            }
            None => vm.push_warning(VmWarning::RlopArgsInvalid {
                op,
                reason: format!("slot {slot_idx}: expected Int, got Bytes"),
            }),
        }
    }
}

/// `(opcode, factory)` table of the real branch-following `module_jmp`
/// family. Each factory builds a fresh `Arc<dyn RLOperation>` so the
/// registrar can mount the same op under every observed lattice type.
type JmpOpFactory = fn() -> Arc<dyn RLOperation>;

/// The real branch-following op table, keyed by real `module_jmp` opcode.
/// Mirrors [`JMP_REAL_OPCODES`] but binds each opcode to its executing
/// implementation instead of a cataloguing `Advance`.
pub const JMP_BRANCH_OPS: &[(u16, JmpOpFactory)] = &[
    (0, || Arc::new(JmpGoto)),
    (1, || Arc::new(JmpGotoIf)),
    (2, || Arc::new(JmpGotoUnless)),
    (3, || Arc::new(JmpGotoOn)),
    (4, || Arc::new(JmpGotoCase)),
    (5, || Arc::new(JmpGosub)),
    (6, || Arc::new(JmpGosubIf)),
    (7, || Arc::new(JmpGosubUnless)),
    (8, || Arc::new(JmpGosubOn)),
    (9, || Arc::new(JmpGosubCase)),
    (10, || Arc::new(JmpRet)),
    (11, || Arc::new(JmpJump)),
    (12, || Arc::new(JmpFarcall)),
    (13, || Arc::new(JmpRtl)),
    (16, || Arc::new(JmpGosubWith)),
    (17, || Arc::new(JmpRet)),
    (18, || Arc::new(JmpFarcallWith)),
    (19, || Arc::new(JmpRtl)),
];

/// Register the REAL branch-FOLLOWING `module_jmp` family under every
/// observed lattice type ([`JMP_LATTICE_TYPES`]), so a headless replay
/// EXECUTES real control flow (jumps/calls followed) rather than
/// linear-walking. Returns the number of `(type, opcode)` keys registered.
///
/// This SUPERSEDES [`register_control_flow_rlops`] (the speculative
/// UTSUSHI-210 numbering) for the real-bytes execution path; the linear
/// walk ([`register_control_flow_linear_walk`]) is retained separately as
/// the exhaustive-coverage check.
pub fn register_control_flow_branch_following(registry: &mut RlopRegistry) -> usize {
    let mut registered = 0usize;
    for &(opcode, factory) in JMP_BRANCH_OPS {
        for module_type in JMP_LATTICE_TYPES {
            let key = RlopKey::new(module_type, MODULE_JMP_ID, opcode);
            registry.register(key, factory());
            registered += 1;
        }
    }
    registered
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
