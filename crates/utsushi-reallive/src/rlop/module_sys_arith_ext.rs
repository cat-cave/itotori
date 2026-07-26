//! `module_sys` arithmetic ops that exist ONLY in the `1000`-block:
//! `modulus` (`sys (1,4,1005)`) and `angle` (`sys (1,4,1006)`). Split out
//! of `module_sys.rs` so the arithmetic-family file stays within the line
//! budget. Reaches the parent's argument/store helpers via `super::`.

use super::{SysOpcode, arg_int, store_i32, warn_and_advance};
use crate::rlop::{DispatchOutcome, ExprValue, RLOperation};
use crate::vm::Vm;

/// `modulus`/`angle` — store:= `(v1 - v3) / (v2 - v4)` (integer slope).
///
/// rlvm registers `angle` (`sys (1,4,1006)`) with a body identical to
/// `modulus` (`sys (1,4,1005)`) — both are `int(float(v1-v3) /
/// float(v2-v4))` at `module_sys.cc:190-206`. We mirror the oracle for
/// both opcodes and key the diagnostic tag off the concrete
/// [`SysOpcode`]. rlvm's float division then `int()`-truncates toward
/// zero; Rust integer division truncates toward zero identically for the
/// coordinate-scale operands these ops see.
#[derive(Debug)]
pub struct SlopeOp {
    op: SysOpcode,
}

impl SlopeOp {
    pub fn new(op: SysOpcode) -> Self {
        Self { op }
    }
}

impl RLOperation for SlopeOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let v1 = match arg_int(args, 0, "v1") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, self.op, reason),
        };
        let v2 = match arg_int(args, 1, "v2") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, self.op, reason),
        };
        let v3 = match arg_int(args, 2, "v3") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, self.op, reason),
        };
        let v4 = match arg_int(args, 3, "v4") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, self.op, reason),
        };
        let denom = v2 - v4;
        if denom == 0 {
            // rlvm computes `float(v1-v3) / float(v2-v4)`; a zero
            // denominator yields a non-finite float whose `int()` cast is
            // undefined in C++. rlvm relies on it never happening — we
            // resolve it to 0 so the runtime stays panic-free and
            // deterministic.
            store_i32(vm, 0);
            return DispatchOutcome::Advance;
        }
        store_i32(vm, (v1 - v3) / denom);
        DispatchOutcome::Advance
    }
}
