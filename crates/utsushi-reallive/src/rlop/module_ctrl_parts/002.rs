

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

// Real-bytes control-flow numbering + exhaustive-linear-walk registrar

/// The real `module_jmp` opcode numbering (rlvm `module_jmp.cc`)
/// cross-checked against the `kaifuu-reallive` decompiler's byte-validated
/// `goto_kind` id sets on the observed corpus + Kanon. Each entry is `(opcode
/// semantic name)`.
///
/// This SUPERSEDES the speculative numbering
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


