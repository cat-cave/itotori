//! Real-numbered branch-following control-flow operations.

use std::sync::Arc;

use crate::rlop::{DispatchOutcome, ExprValue, RLOperation, RlopKey, RlopRegistry};
use crate::var_banks::Value;
use crate::vm::{Vm, VmWarning};

use super::super::{
    FARCALL_ARG_BANK, FARCALL_ARG_BANK_SLOT_CAP, MODULE_JMP_ID, arg_cond, arg_pc, arg_scene,
    warn_and_advance,
};
use super::JMP_LATTICE_TYPES;
use crate::rlop::module_ctrl::{GotoIfOp, GotoOnOp, GotoUnlessOp};

// Real-numbered branch-FOLLOWING control-flow family
//
// This is the counterpart to [`register_control_flow_linear_walk`]: where
// the linear walk mounts every `module_jmp` opcode as a cataloguing
// `Advance` (so a headless replay VISITS every command), this family
// mounts the REAL branch semantics at the REAL opcode numbers so a scene
// EXECUTES its actual control flow — goto/goto_if/goto_unless/goto_on
// rewrite the pc, gosub/ret push+pop an intra-scene frame, and
// jump/farcall/rtl transfer across the multi-scene store. Following a
// branch means the un-taken arms are NOT visited (correct for execution
// vs cataloguing); the linear walk is retained as the exhaustive-coverage
// check.
//
// Arg layout each op observes (the VM decodes the `(...)` list, then
// APPENDS the trailing goto-family jump-target pointers as `Int` args —
// see `Vm::dispatch_element`):
//   goto (0): [target] (1 target, no arglist)
//   goto_if (1): [cond, target] ((cond) + 1 target)
//   goto_unless (2): [cond, target]
//   goto_on (3): [value, t0, t1, …] ((value) + N targets)
//   goto_case (4): [target] (VM pre-resolves the
//                                                      matched case via
//                                                      Command::goto_case_exprs;
//                                                      empty ⇒ fall through)
//   gosub (5): [target] (return pc from vm.post_pc())
//   gosub_if (6): [cond, target]
//   ret (10): [] (pop subroutine frame)
//   jump (11): [scene] | [scene, entrypoint] (cross-scene, no return)
//   farcall (12): [scene] | [scene, entrypoint] (cross-scene call)
//   rtl (13): [] (pop far-call frame)
//   gosub_with (16): [arg0, …, argN, target] (args + 1 target)
//   ret_with (17): [value] (pop subroutine frame)
//   farcall_with (18): [scene, entrypoint, arg0, …] (cross-scene call + args)
//   rtl_with (19): [value] (pop far-call frame)

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

/// `ret()` / `ret_with(value)` — pop a subroutine frame (real opcodes 10
/// 17). Any `ret_with` return value is not modelled (it affects data, not
/// control flow).
#[derive(Debug, Clone, Copy, Default)]
pub struct JmpRet;
impl RLOperation for JmpRet {
    fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        DispatchOutcome::Return
    }
}

/// `rtl()` / `rtl_with(value)` — pop a far-call frame (real opcodes 13
/// 19).
#[derive(Debug, Clone, Copy, Default)]
pub struct JmpRtl;
impl RLOperation for JmpRtl {
    fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        DispatchOutcome::ReturnFromCall
    }
}

/// Spill `slots` into the `intL` parameter bank ([`FARCALL_ARG_BANK`])
/// bounded by [`FARCALL_ARG_BANK_SLOT_CAP`]. Shared by `gosub_with`
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
/// numbering) for the real-bytes execution path; the linear
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
