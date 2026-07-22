//! RealLive `module_mem` memory-bulk RLOperation family.
//!
//! Implements the eight memory opcodes RealLive's `module_mem` exposes:
//! `setarray`, `setrng`, `cpyrng`, `setarray_stepped`, `setrng_stepped`
//! `cpyvars`, `sum`, `sums`. Each op operates on integer banks
//! (`intA..intM`) per the rlvm-documented module_mem semantics; string
//! banks are not part of this family.
//!
//! # Module addressing
//!
//! `module_mem` is registered at `(module_type=1, module_id=11)` —
//! consistent with the `(1, X)` convention pinned by the other
//! modules. The rlvm-documented `module_id`
//! for the memory-bulk family is `11`. Pinned here so audit tooling
//! can assert the dispatch key.
//!
//! # Opcode coverage (8)
//!
//! Opcode | Op | Semantics
//! -------------------- | ------------------- | ----------------------------------------------------
//! `0x0000` | `setarray` | `intX[base..base+n]:= v0, v1, …, v_{n-1}`
//! `0x0001` | `setrng` | `intX[start..=end]:= value`
//! `0x0002` | `cpyrng` | `intX[dst..dst+n]:= intY[src..src+n]`
//! `0x0003` | `setarray_stepped` | `intX[base + i*step]:= v_i` for i in 0..n
//! `0x0004` | `setrng_stepped` | `intX[start + i*step]:= value` for i in 0..n
//! `0x0005` | `cpyvars` | `intX[dst]:= intY[src]` for k pairs
//! `0x0006` | `sum` | `intX[dst]:= sum(intY[start..=end])`
//! `0x0007` | `sums` | `intX[dst]:= sum(intY[start_0..=end_0], …)`
//!
//! # Argument shape
//!
//! Every op consumes typed `(bank_byte, idx)` pairs. The two-int
//! convention follows [`module_str`](super::module_str) — a leading
//! `Int(bank_byte)` followed by `Int(idx)` for each variable
//! reference. Integer literals (counts / values) are single
//! `Int(value)` arguments.
//!
//! # Substrate-honesty posture
//!
//! - **Typed `(BankId, idx)`.** A non-int bank or out-of-bound index
//!   produces a [`VmWarning::RlopArgsInvalid`] and the op advances.
//! - **Sparse-aware reads.** Unset slots read as `0` so a `sum` of an
//!   unset range returns `0` rather than panicking.
//! - **Clamped writes.** Writes through [`crate::var_banks::VarBanks::set`]
//!   honour the `BANK_INDEX_CAP=2_000` ceiling; the typed warning is
//!   bubbled into the VM's diagnostic queue.

use std::sync::Arc;

use super::{DispatchOutcome, ExprValue, RLOperation, RlopKey, RlopRegistry};
use crate::var_banks::{BankId, Value};
use crate::vm::{Vm, VmWarning};

/// `module_mem` module type byte. Pinned at `1` to match the
/// `(1, X)` convention shared with the other module families.
pub const MEM_MODULE_TYPE: u8 = 1;
/// `module_mem` module id byte. Pinned at the rlvm-documented
/// `module_id = 11` for the memory-bulk family.
pub const MEM_MODULE_ID: u8 = 11;

/// `setarray` opcode.
pub const OPCODE_SETARRAY: u16 = 0x0000;
/// `setrng` opcode.
pub const OPCODE_SETRNG: u16 = 0x0001;
/// `cpyrng` opcode.
pub const OPCODE_CPYRNG: u16 = 0x0002;
/// `setarray_stepped` opcode.
pub const OPCODE_SETARRAY_STEPPED: u16 = 0x0003;
/// `setrng_stepped` opcode.
pub const OPCODE_SETRNG_STEPPED: u16 = 0x0004;
/// `cpyvars` opcode.
pub const OPCODE_CPYVARS: u16 = 0x0005;
/// `sum` opcode.
pub const OPCODE_SUM: u16 = 0x0006;
/// `sums` opcode.
pub const OPCODE_SUMS: u16 = 0x0007;

/// Stable enum naming the `module_mem` opcodes implements.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum MemOpcode {
    /// `setarray` — array initialiser.
    Setarray,
    /// `setrng` — range fill.
    Setrng,
    /// `cpyrng` — range copy.
    Cpyrng,
    /// `setarray_stepped` — strided array initialiser.
    SetarrayStepped,
    /// `setrng_stepped` — strided range fill.
    SetrngStepped,
    /// `cpyvars` — pairwise variable copy.
    Cpyvars,
    /// `sum` — range sum.
    Sum,
    /// `sums` — multi-range sum.
    Sums,
}

impl MemOpcode {
    /// All `module_mem` opcodes this module ships.
    pub const ALL: &'static [MemOpcode] = &[
        Self::Setarray,
        Self::Setrng,
        Self::Cpyrng,
        Self::SetarrayStepped,
        Self::SetrngStepped,
        Self::Cpyvars,
        Self::Sum,
        Self::Sums,
    ];

    /// Numeric opcode byte for this variant.
    pub fn opcode(self) -> u16 {
        match self {
            Self::Setarray => OPCODE_SETARRAY,
            Self::Setrng => OPCODE_SETRNG,
            Self::Cpyrng => OPCODE_CPYRNG,
            Self::SetarrayStepped => OPCODE_SETARRAY_STEPPED,
            Self::SetrngStepped => OPCODE_SETRNG_STEPPED,
            Self::Cpyvars => OPCODE_CPYVARS,
            Self::Sum => OPCODE_SUM,
            Self::Sums => OPCODE_SUMS,
        }
    }

    /// Composite registry key the VM uses to dispatch this op.
    pub fn rlop_key(self) -> RlopKey {
        RlopKey::new(MEM_MODULE_TYPE, MEM_MODULE_ID, self.opcode())
    }

    /// Stable lowercase tag used by [`VmWarning::RlopArgsInvalid::op`].
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Setarray => "mem.setarray",
            Self::Setrng => "mem.setrng",
            Self::Cpyrng => "mem.cpyrng",
            Self::SetarrayStepped => "mem.setarray_stepped",
            Self::SetrngStepped => "mem.setrng_stepped",
            Self::Cpyvars => "mem.cpyvars",
            Self::Sum => "mem.sum",
            Self::Sums => "mem.sums",
        }
    }
}

/// Number of opcodes [`register_mem_rlops`] mounts.
pub const MEM_RLOP_COUNT: usize = MemOpcode::ALL.len();

// Argument helpers

fn arg_int_bank_ref(args: &[ExprValue], start: usize) -> Result<(BankId, u16), String> {
    let bank_arg = args
        .get(start)
        .ok_or_else(|| format!("missing arg[{start}] (bank_byte)"))?;
    let idx_arg = args
        .get(start + 1)
        .ok_or_else(|| format!("missing arg[{}] (idx)", start + 1))?;
    let bank_byte = bank_arg
        .as_int()
        .ok_or_else(|| format!("arg[{start}] expected Int(bank_byte), got Bytes"))?;
    let idx_i = idx_arg
        .as_int()
        .ok_or_else(|| format!("arg[{}] expected Int(idx), got Bytes", start + 1))?;
    let bank_byte_u8 = u8::try_from(bank_byte)
        .map_err(|_| format!("arg[{start}] bank_byte out of range: {bank_byte}"))?;
    let bank = BankId::from_int_bank_byte(bank_byte_u8)
        .ok_or_else(|| format!("arg[{start}] unknown int bank_byte=0x{bank_byte_u8:02x}"))?;
    let idx_u16 = u16::try_from(idx_i)
        .map_err(|_| format!("arg[{}] idx out of range: {idx_i}", start + 1))?;
    Ok((bank, idx_u16))
}

fn arg_int(args: &[ExprValue], at: usize, slot: &str) -> Result<i32, String> {
    args.get(at)
        .ok_or_else(|| format!("missing arg[{at}] ({slot})"))?
        .as_int()
        .ok_or_else(|| format!("arg[{at}] expected Int({slot}), got Bytes"))
}

fn read_int_slot(vm: &Vm, bank: BankId, idx: u16) -> i32 {
    match vm.banks().get(bank, idx) {
        Some(Value::Int(value)) => value,
        _ => 0,
    }
}

fn write_int_slot(vm: &mut Vm, bank: BankId, idx: u16, value: i32) -> Result<(), String> {
    match vm.banks_mut().set(bank, idx, Value::Int(value)) {
        Ok(()) => Ok(()),
        Err(warning) => Err(warning.to_string()),
    }
}

fn warn_and_advance(vm: &mut Vm, op: MemOpcode, reason: String) -> DispatchOutcome {
    vm.push_warning(VmWarning::RlopArgsInvalid {
        op: op.as_str(),
        reason,
    });
    DispatchOutcome::Advance
}

fn checked_idx_add(base: u16, offset: u16, op: MemOpcode) -> Result<u16, String> {
    base.checked_add(offset)
        .ok_or_else(|| format!("{}: idx overflow base={base} offset={offset}", op.as_str()))
}

#[path = "module_mem/operations.rs"]
mod operations;
pub use operations::{
    CpyrngOp, CpyvarsOp, SetarrayOp, SetarrayStepped, SetrngOp, SetrngStepped, SumOp, SumsOp,
};

// Registry helper

/// Mount every `module_mem` op this module ships into `registry`.
pub fn register_mem_rlops(registry: &mut RlopRegistry) -> usize {
    registry.register(MemOpcode::Setarray.rlop_key(), Arc::new(SetarrayOp));
    registry.register(MemOpcode::Setrng.rlop_key(), Arc::new(SetrngOp));
    registry.register(MemOpcode::Cpyrng.rlop_key(), Arc::new(CpyrngOp));
    registry.register(
        MemOpcode::SetarrayStepped.rlop_key(),
        Arc::new(SetarrayStepped),
    );
    registry.register(MemOpcode::SetrngStepped.rlop_key(), Arc::new(SetrngStepped));
    registry.register(MemOpcode::Cpyvars.rlop_key(), Arc::new(CpyvarsOp));
    registry.register(MemOpcode::Sum.rlop_key(), Arc::new(SumOp));
    registry.register(MemOpcode::Sums.rlop_key(), Arc::new(SumsOp));
    MEM_RLOP_COUNT
}

// Tests

#[cfg(test)]
#[path = "module_mem/tests.rs"]
mod tests;
