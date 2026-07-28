use std::sync::Arc;

use super::ops::*;
use super::types::*;
use super::super::super::{RlopKey, RlopRegistry};

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

// Tests

