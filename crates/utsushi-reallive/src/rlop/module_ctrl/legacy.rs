//! Legacy control-flow operations and their registrar.

use std::sync::Arc;

use crate::rlop::{DispatchOutcome, ExprValue, RLOperation, RlopKey, RlopRegistry};
use crate::var_banks::Value;
use crate::vm::{Vm, VmWarning};

use super::{
    FARCALL_ARG_BANK, FARCALL_ARG_BANK_SLOT_CAP, KEY_FARCALL, KEY_FARCALL_WITH_ARGS, KEY_GOSUB,
    KEY_GOSUB_IF, KEY_GOTO, KEY_GOTO_IF, KEY_GOTO_ON, KEY_GOTO_UNLESS, KEY_HALT, KEY_RET, KEY_RTL,
    arg_cond, arg_pc, arg_scene, warn_and_advance,
};

// goto family

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

/// `goto_on(value, [target_0, target_1,...])` — switch dispatch. Uses
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

// gosub family

/// `gosub(return_pc, target_pc)` — push a subroutine frame and jump.
///
/// The `return_pc` is supplied as an explicit arg rather than read from
/// `vm.pc()` because `vm.pc()` reflects the *pre-command* pc inside
/// dispatch and the VM does not pass the post-command byte to the op
/// layer. The dispatcher (a later work) will prepend the
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

// farcall family

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

/// `farcall_with_args(return_scene, return_pc, target_scene
/// target_pc, arg0, arg1,...)` — cross-scene call that also populates
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

// ret / rtl / halt

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

// Registry helper

/// Number of opcodes [`register_control_flow_rlops`] populates. Pinned
/// so audit tooling can assert "the registry covers the
/// frontier exactly" without scraping the helper body.
/// deleted the speculative `module_jmp` `select` slot — the choice
/// family lives in [`crate::rlop::module_sel`].
pub const CONTROL_FLOW_RLOP_COUNT: usize = 11;

/// Populate `registry` with the control-flow RLOperation
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
