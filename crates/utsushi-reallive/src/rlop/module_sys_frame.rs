//! RealLive `module_sys` frame-counter commands.
//!
//! rlvm models `InitFrames` (600) as a multi-dispatch of simple frame
//! counters and `ReadFrames` (610) as a multi-dispatch that writes each
//! counter into the supplied integer reference and returns whether any
//! counter is still active.  The tuple structure matters: flattening it
//! loses the writable reference and made these commands a silent no-op.

use std::sync::Arc;

use super::{DispatchOutcome, ExprValue, RLOperation, RlopKey, RlopRegistry};
use crate::rlop::module_sys::{SYS_MODULE_ID, SYS_MODULE_TYPE};
use crate::var_banks::{BankId, Value};
use crate::vm::{Vm, VmWarning};

/// `sys.InitFrames`.
pub const OPCODE_INIT_FRAMES: u16 = 600;
/// `sys.ReadFrames`.
pub const OPCODE_READ_FRAMES: u16 = 610;

/// Initialise one or more `(counter, min, max, duration_ms)` counters.
#[derive(Debug)]
pub struct InitFramesOp;

impl RLOperation for InitFramesOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let mut counters = Vec::with_capacity(args.len());
        for (position, arg) in args.iter().enumerate() {
            let Some(ExprValue::List(tuple)) = Some(arg) else {
                return invalid(vm, "sys.init_frames", position, "expected tuple");
            };
            let [counter, min, max, duration_ms] = tuple.as_slice() else {
                return invalid(vm, "sys.init_frames", position, "expected 4 values");
            };
            let (Some(counter), Some(min), Some(max), Some(duration_ms)) =
                (counter.as_int(), min.as_int(), max.as_int(), duration_ms.as_int())
            else {
                return invalid(vm, "sys.init_frames", position, "expected four integers");
            };
            if duration_ms < 0 {
                return invalid(
                    vm,
                    "sys.init_frames",
                    position,
                    "duration must be non-negative",
                );
            }
            counters.push((counter, min, max, duration_ms));
        }

        for (counter, min, max, duration_ms) in counters {
            vm.init_frame_counter(counter, min, max, duration_ms);
        }
        DispatchOutcome::Advance
    }
}

/// Read one or more `(counter, integer-reference)` counter values.
#[derive(Debug)]
pub struct ReadFramesOp;

impl RLOperation for ReadFramesOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let mut reads = Vec::with_capacity(args.len());
        for (position, arg) in args.iter().enumerate() {
            let Some(ExprValue::List(tuple)) = Some(arg) else {
                return invalid(vm, "sys.read_frames", position, "expected tuple");
            };
            let [counter, destination] = tuple.as_slice() else {
                return invalid(vm, "sys.read_frames", position, "expected 2 values");
            };
            let Some(counter) = counter.as_int() else {
                return invalid(vm, "sys.read_frames", position, "counter must be an integer");
            };
            let Some((bank_byte, index)) = destination.as_int_reference() else {
                return invalid(
                    vm,
                    "sys.read_frames",
                    position,
                    "destination must be an integer reference",
                );
            };
            let Some(bank) = BankId::from_int_bank_byte(bank_byte) else {
                return invalid(vm, "sys.read_frames", position, "invalid integer bank");
            };
            let Ok(index) = u16::try_from(index) else {
                return invalid(vm, "sys.read_frames", position, "invalid integer-bank index");
            };
            reads.push((counter, bank, index));
        }

        let mut any_active = false;
        for (counter, bank, index) in reads {
            let (value, active) = vm.read_frame_counter(counter).unwrap_or((0, false));
            if let Err(warning) = vm.banks_mut().set(bank, index, Value::Int(value)) {
                vm.push_warning(VmWarning::RlopArgsInvalid {
                    op: "sys.read_frames",
                    reason: warning.to_string(),
                });
            }
            any_active |= active;
        }
        vm.banks_mut().set_store(u32::from(any_active));
        vm.advance_frame_clock();
        DispatchOutcome::Advance
    }
}

fn invalid(vm: &mut Vm, op: &'static str, position: usize, reason: &'static str) -> DispatchOutcome {
    vm.push_warning(VmWarning::RlopArgsInvalid {
        op,
        reason: format!("tuple {position}: {reason}"),
    });
    DispatchOutcome::Halt
}

/// Register the two byte-proven frame operations at their exact compiled
/// key.  They are not arithmetic lattice aliases; widening this key would
/// claim bytecode the oracle does not identify as this operation.
pub fn register_sys_frame_rlops(registry: &mut RlopRegistry) -> usize {
    registry.register(
        RlopKey::new(SYS_MODULE_TYPE, SYS_MODULE_ID, OPCODE_INIT_FRAMES),
        Arc::new(InitFramesOp),
    );
    registry.register(
        RlopKey::new(SYS_MODULE_TYPE, SYS_MODULE_ID, OPCODE_READ_FRAMES),
        Arc::new(ReadFramesOp),
    );
    2
}

#[cfg(test)]
#[path = "module_sys_frame_tests.rs"]
mod tests;
