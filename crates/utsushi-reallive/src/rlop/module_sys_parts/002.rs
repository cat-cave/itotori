

impl RLOperation for PowerOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let base = match arg_int(args, 0, "base") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, SysOpcode::Power, reason),
        };
        let exp = match arg_int(args, 1, "exponent") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, SysOpcode::Power, reason),
        };
        if exp < 0 {
            // RLDEV-documented behaviour: negative exponent → 0 (no
            // fractional surface in the engine arithmetic).
            store_i32(vm, 0);
            return DispatchOutcome::Advance;
        }
        let mut acc: i64 = 1;
        for _ in 0..exp {
            acc = acc.saturating_mul(base as i64);
            if !(i32::MIN as i64..=i32::MAX as i64).contains(&acc) {
                // Saturate per the substrate-honest "no silent
                // overflow" posture.
                if acc > i32::MAX as i64 {
                    store_i32(vm, i32::MAX);
                } else {
                    store_i32(vm, i32::MIN);
                }
                return DispatchOutcome::Advance;
            }
        }
        store_i32(vm, acc as i32);
        DispatchOutcome::Advance
    }
}

/// `sin(theta)` — store:= sin256(theta).
#[derive(Debug)]
pub struct SinOp;

impl RLOperation for SinOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let theta = match arg_int(args, 0, "theta") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, SysOpcode::Sin, reason),
        };
        store_i32(vm, sin256(theta));
        DispatchOutcome::Advance
    }
}

/// `cos(theta)` — store:= cos256(theta).
#[derive(Debug)]
pub struct CosOp;

impl RLOperation for CosOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let theta = match arg_int(args, 0, "theta") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, SysOpcode::Cos, reason),
        };
        store_i32(vm, cos256(theta));
        DispatchOutcome::Advance
    }
}

/// `min(a, b)` — store:= min(a, b).
#[derive(Debug)]
pub struct MinOp;

impl RLOperation for MinOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let a = match arg_int(args, 0, "a") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, SysOpcode::Min, reason),
        };
        let b = match arg_int(args, 1, "b") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, SysOpcode::Min, reason),
        };
        store_i32(vm, a.min(b));
        DispatchOutcome::Advance
    }
}

/// `max(a, b)` — store:= max(a, b).
#[derive(Debug)]
pub struct MaxOp;

impl RLOperation for MaxOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let a = match arg_int(args, 0, "a") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, SysOpcode::Max, reason),
        };
        let b = match arg_int(args, 1, "b") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, SysOpcode::Max, reason),
        };
        store_i32(vm, a.max(b));
        DispatchOutcome::Advance
    }
}

/// `constrain(value, lo, hi)` — store:= clamp(value, lo, hi).
#[derive(Debug)]
pub struct ConstrainOp;

impl RLOperation for ConstrainOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let value = match arg_int(args, 0, "value") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, SysOpcode::Constrain, reason),
        };
        let lo = match arg_int(args, 1, "lo") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, SysOpcode::Constrain, reason),
        };
        let hi = match arg_int(args, 2, "hi") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, SysOpcode::Constrain, reason),
        };
        if lo > hi {
            return warn_and_advance(vm, SysOpcode::Constrain, format!("lo {lo} > hi {hi}"));
        }
        store_i32(vm, value.clamp(lo, hi));
        DispatchOutcome::Advance
    }
}

// Registry helper

/// Mount every `module_sys` arithmetic op this module ships into
/// `registry`. The runtime is shared so the rng state lives at one
/// canonical location. Each op is registered at its primary opcode and
/// (for the ops in [`ARITH_ALIASES`]) at its `1000`-block alias, so
/// bytecode calling the family through either opcode range resolves to
/// the same handler.
pub fn register_sys_rlops(registry: &mut RlopRegistry, runtime: Arc<SysRuntime>) -> usize {
    let mut mount = |op: SysOpcode, rlop: Arc<dyn RLOperation>| {
        let alias = ARITH_ALIASES
            .iter()
            .find(|(candidate, _)| *candidate == op)
            .map(|(_, alias)| *alias);
        for module_type in LATTICE_TYPES {
            registry.register(op.rlop_key_for(module_type), Arc::clone(&rlop));
            if let Some(alias) = alias {
                registry.register(
                    RlopKey::new(module_type, SYS_MODULE_ID, alias),
                    Arc::clone(&rlop),
                );
            }
        }
    };
    mount(SysOpcode::Rnd, Arc::new(RndOp::new(Arc::clone(&runtime))));
    mount(SysOpcode::Pcnt, Arc::new(PcntOp));
    mount(SysOpcode::Abs, Arc::new(AbsOp));
    mount(SysOpcode::Power, Arc::new(PowerOp));
    mount(SysOpcode::Sin, Arc::new(SinOp));
    mount(SysOpcode::Cos, Arc::new(CosOp));
    mount(SysOpcode::Min, Arc::new(MinOp));
    mount(SysOpcode::Max, Arc::new(MaxOp));
    mount(SysOpcode::Constrain, Arc::new(ConstrainOp));
    mount(
        SysOpcode::Modulus,
        Arc::new(SlopeOp::new(SysOpcode::Modulus)),
    );
    mount(SysOpcode::Angle, Arc::new(SlopeOp::new(SysOpcode::Angle)));
    SYS_RLOP_COUNT
}


