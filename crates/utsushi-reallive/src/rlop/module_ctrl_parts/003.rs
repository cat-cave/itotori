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


