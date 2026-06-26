//! UTSUSHI-212 — RealLive `module_mem` memory-bulk RLOperation family.
//!
//! Implements the eight memory opcodes RealLive's `module_mem` exposes:
//! `setarray`, `setrng`, `cpyrng`, `setarray_stepped`, `setrng_stepped`,
//! `cpyvars`, `sum`, `sums`. Each op operates on integer banks
//! (`intA..intM`) per the rlvm-documented module_mem semantics; string
//! banks are not part of this family.
//!
//! # Module addressing
//!
//! `module_mem` is registered at `(module_type=1, module_id=11)` —
//! consistent with the `(1, X)` convention pinned by the other
//! UTSUSHI-209/210/211/213 modules. The rlvm-documented `module_id`
//! for the memory-bulk family is `11`. Pinned here so audit tooling
//! can assert the dispatch key.
//!
//! # Opcode coverage (8)
//!
//! | Opcode               | Op                  | Semantics                                            |
//! | -------------------- | ------------------- | ---------------------------------------------------- |
//! | `0x0000`             | `setarray`          | `intX[base..base+n] := v0, v1, …, v_{n-1}`           |
//! | `0x0001`             | `setrng`            | `intX[start..=end] := value`                         |
//! | `0x0002`             | `cpyrng`            | `intX[dst..dst+n] := intY[src..src+n]`               |
//! | `0x0003`             | `setarray_stepped`  | `intX[base + i*step] := v_i` for i in 0..n           |
//! | `0x0004`             | `setrng_stepped`    | `intX[start + i*step] := value` for i in 0..n        |
//! | `0x0005`             | `cpyvars`           | `intX[dst] := intY[src]` for k pairs                 |
//! | `0x0006`             | `sum`               | `intX[dst] := sum(intY[start..=end])`                |
//! | `0x0007`             | `sums`              | `intX[dst] := sum(intY[start_0..=end_0], …)`         |
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

/// Stable enum naming the `module_mem` opcodes UTSUSHI-212 implements.
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

// ---------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------

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

// ---------------------------------------------------------------------
// Per-opcode RLOperation implementors
// ---------------------------------------------------------------------

/// `setarray(bank, base, n, v0, v1, …, v_{n-1})` — array initialiser.
#[derive(Debug)]
pub struct SetarrayOp;

impl RLOperation for SetarrayOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let (bank, base) = match arg_int_bank_ref(args, 0) {
            Ok(pair) => pair,
            Err(reason) => return warn_and_advance(vm, MemOpcode::Setarray, reason),
        };
        let count_i = match arg_int(args, 2, "count") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, MemOpcode::Setarray, reason),
        };
        if count_i < 0 {
            return warn_and_advance(
                vm,
                MemOpcode::Setarray,
                format!("count out of range: {count_i}"),
            );
        }
        let count = count_i as usize;
        if args.len() < 3 + count {
            return warn_and_advance(
                vm,
                MemOpcode::Setarray,
                format!("missing values: expected {count}, got {}", args.len() - 3),
            );
        }
        for i in 0..count {
            let value = match args[3 + i].as_int() {
                Some(value) => value,
                None => {
                    return warn_and_advance(
                        vm,
                        MemOpcode::Setarray,
                        format!("arg[{}] expected Int(value), got Bytes", 3 + i),
                    );
                }
            };
            let offset = match u16::try_from(i) {
                Ok(value) => value,
                Err(_) => {
                    return warn_and_advance(
                        vm,
                        MemOpcode::Setarray,
                        format!("offset out of range: {i}"),
                    );
                }
            };
            let idx = match checked_idx_add(base, offset, MemOpcode::Setarray) {
                Ok(idx) => idx,
                Err(reason) => return warn_and_advance(vm, MemOpcode::Setarray, reason),
            };
            if let Err(reason) = write_int_slot(vm, bank, idx, value) {
                return warn_and_advance(vm, MemOpcode::Setarray, reason);
            }
        }
        DispatchOutcome::Advance
    }
}

/// `setrng(bank, start, end, value)` — inclusive-range fill.
#[derive(Debug)]
pub struct SetrngOp;

impl RLOperation for SetrngOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let (bank, start) = match arg_int_bank_ref(args, 0) {
            Ok(pair) => pair,
            Err(reason) => return warn_and_advance(vm, MemOpcode::Setrng, reason),
        };
        let end_i = match arg_int(args, 2, "end") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, MemOpcode::Setrng, reason),
        };
        let value = match arg_int(args, 3, "value") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, MemOpcode::Setrng, reason),
        };
        let end = match u16::try_from(end_i) {
            Ok(value) => value,
            Err(_) => {
                return warn_and_advance(
                    vm,
                    MemOpcode::Setrng,
                    format!("end out of range: {end_i}"),
                );
            }
        };
        if end < start {
            // Zero-size range (acceptance criterion #1: boundary case).
            return DispatchOutcome::Advance;
        }
        for idx in start..=end {
            if let Err(reason) = write_int_slot(vm, bank, idx, value) {
                return warn_and_advance(vm, MemOpcode::Setrng, reason);
            }
        }
        DispatchOutcome::Advance
    }
}

/// `cpyrng(dst_bank, dst_start, src_bank, src_start, n)` — range copy.
#[derive(Debug)]
pub struct CpyrngOp;

impl RLOperation for CpyrngOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let (dst_bank, dst_start) = match arg_int_bank_ref(args, 0) {
            Ok(pair) => pair,
            Err(reason) => return warn_and_advance(vm, MemOpcode::Cpyrng, reason),
        };
        let (src_bank, src_start) = match arg_int_bank_ref(args, 2) {
            Ok(pair) => pair,
            Err(reason) => return warn_and_advance(vm, MemOpcode::Cpyrng, reason),
        };
        let count_i = match arg_int(args, 4, "count") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, MemOpcode::Cpyrng, reason),
        };
        if count_i < 0 {
            return warn_and_advance(
                vm,
                MemOpcode::Cpyrng,
                format!("count out of range: {count_i}"),
            );
        }
        let count = match u16::try_from(count_i) {
            Ok(value) => value,
            Err(_) => {
                return warn_and_advance(
                    vm,
                    MemOpcode::Cpyrng,
                    format!("count out of range: {count_i}"),
                );
            }
        };
        // Read first to avoid aliasing issues when src_bank == dst_bank.
        let mut buffer = Vec::with_capacity(count as usize);
        for offset in 0..count {
            let src_idx = match checked_idx_add(src_start, offset, MemOpcode::Cpyrng) {
                Ok(idx) => idx,
                Err(reason) => return warn_and_advance(vm, MemOpcode::Cpyrng, reason),
            };
            buffer.push(read_int_slot(vm, src_bank, src_idx));
        }
        for (offset, value) in buffer.into_iter().enumerate() {
            let offset_u16 = match u16::try_from(offset) {
                Ok(value) => value,
                Err(_) => {
                    return warn_and_advance(
                        vm,
                        MemOpcode::Cpyrng,
                        format!("offset out of range: {offset}"),
                    );
                }
            };
            let dst_idx = match checked_idx_add(dst_start, offset_u16, MemOpcode::Cpyrng) {
                Ok(idx) => idx,
                Err(reason) => return warn_and_advance(vm, MemOpcode::Cpyrng, reason),
            };
            if let Err(reason) = write_int_slot(vm, dst_bank, dst_idx, value) {
                return warn_and_advance(vm, MemOpcode::Cpyrng, reason);
            }
        }
        DispatchOutcome::Advance
    }
}

/// `setarray_stepped(bank, base, step, n, v0, …, v_{n-1})` — strided
/// array initialiser.
#[derive(Debug)]
pub struct SetarrayStepped;

impl RLOperation for SetarrayStepped {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let (bank, base) = match arg_int_bank_ref(args, 0) {
            Ok(pair) => pair,
            Err(reason) => return warn_and_advance(vm, MemOpcode::SetarrayStepped, reason),
        };
        let step_i = match arg_int(args, 2, "step") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, MemOpcode::SetarrayStepped, reason),
        };
        let count_i = match arg_int(args, 3, "count") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, MemOpcode::SetarrayStepped, reason),
        };
        if step_i <= 0 {
            return warn_and_advance(
                vm,
                MemOpcode::SetarrayStepped,
                format!("step must be positive: {step_i}"),
            );
        }
        if count_i < 0 {
            return warn_and_advance(
                vm,
                MemOpcode::SetarrayStepped,
                format!("count out of range: {count_i}"),
            );
        }
        let step = step_i as u32;
        let count = count_i as usize;
        if args.len() < 4 + count {
            return warn_and_advance(
                vm,
                MemOpcode::SetarrayStepped,
                format!("missing values: expected {count}, got {}", args.len() - 4),
            );
        }
        for i in 0..count {
            let value = match args[4 + i].as_int() {
                Some(value) => value,
                None => {
                    return warn_and_advance(
                        vm,
                        MemOpcode::SetarrayStepped,
                        format!("arg[{}] expected Int(value), got Bytes", 4 + i),
                    );
                }
            };
            let offset_u32 = (i as u32)
                .checked_mul(step)
                .ok_or_else(|| format!("offset overflow i={i} step={step}"));
            let offset_u32 = match offset_u32 {
                Ok(value) => value,
                Err(reason) => return warn_and_advance(vm, MemOpcode::SetarrayStepped, reason),
            };
            let offset = match u16::try_from(offset_u32) {
                Ok(value) => value,
                Err(_) => {
                    return warn_and_advance(
                        vm,
                        MemOpcode::SetarrayStepped,
                        format!("offset out of range: {offset_u32}"),
                    );
                }
            };
            let idx = match checked_idx_add(base, offset, MemOpcode::SetarrayStepped) {
                Ok(idx) => idx,
                Err(reason) => return warn_and_advance(vm, MemOpcode::SetarrayStepped, reason),
            };
            if let Err(reason) = write_int_slot(vm, bank, idx, value) {
                return warn_and_advance(vm, MemOpcode::SetarrayStepped, reason);
            }
        }
        DispatchOutcome::Advance
    }
}

/// `setrng_stepped(bank, start, step, n, value)` — strided range fill.
#[derive(Debug)]
pub struct SetrngStepped;

impl RLOperation for SetrngStepped {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let (bank, start) = match arg_int_bank_ref(args, 0) {
            Ok(pair) => pair,
            Err(reason) => return warn_and_advance(vm, MemOpcode::SetrngStepped, reason),
        };
        let step_i = match arg_int(args, 2, "step") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, MemOpcode::SetrngStepped, reason),
        };
        let count_i = match arg_int(args, 3, "count") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, MemOpcode::SetrngStepped, reason),
        };
        let value = match arg_int(args, 4, "value") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, MemOpcode::SetrngStepped, reason),
        };
        if step_i <= 0 {
            return warn_and_advance(
                vm,
                MemOpcode::SetrngStepped,
                format!("step must be positive: {step_i}"),
            );
        }
        if count_i < 0 {
            return warn_and_advance(
                vm,
                MemOpcode::SetrngStepped,
                format!("count out of range: {count_i}"),
            );
        }
        let step = step_i as u32;
        let count = count_i as usize;
        for i in 0..count {
            let offset_u32 = match (i as u32).checked_mul(step) {
                Some(value) => value,
                None => {
                    return warn_and_advance(
                        vm,
                        MemOpcode::SetrngStepped,
                        format!("offset overflow i={i} step={step}"),
                    );
                }
            };
            let offset = match u16::try_from(offset_u32) {
                Ok(value) => value,
                Err(_) => {
                    return warn_and_advance(
                        vm,
                        MemOpcode::SetrngStepped,
                        format!("offset out of range: {offset_u32}"),
                    );
                }
            };
            let idx = match checked_idx_add(start, offset, MemOpcode::SetrngStepped) {
                Ok(idx) => idx,
                Err(reason) => return warn_and_advance(vm, MemOpcode::SetrngStepped, reason),
            };
            if let Err(reason) = write_int_slot(vm, bank, idx, value) {
                return warn_and_advance(vm, MemOpcode::SetrngStepped, reason);
            }
        }
        DispatchOutcome::Advance
    }
}

/// `cpyvars(k, (dst_bank0, dst_idx0, src_bank0, src_idx0)…)` — pairwise
/// copy. `k` records of `(dst, src)` follow.
#[derive(Debug)]
pub struct CpyvarsOp;

impl RLOperation for CpyvarsOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let k_i = match arg_int(args, 0, "count") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, MemOpcode::Cpyvars, reason),
        };
        if k_i < 0 {
            return warn_and_advance(vm, MemOpcode::Cpyvars, format!("count out of range: {k_i}"));
        }
        let k = k_i as usize;
        // Each record is 4 args: dst_bank, dst_idx, src_bank, src_idx.
        if args.len() < 1 + k * 4 {
            return warn_and_advance(
                vm,
                MemOpcode::Cpyvars,
                format!(
                    "missing pair records: expected {} args, got {}",
                    1 + k * 4,
                    args.len(),
                ),
            );
        }
        // Read first to avoid src/dst aliasing.
        let mut pairs = Vec::with_capacity(k);
        for i in 0..k {
            let base = 1 + i * 4;
            let (dst_bank, dst_idx) = match arg_int_bank_ref(args, base) {
                Ok(pair) => pair,
                Err(reason) => return warn_and_advance(vm, MemOpcode::Cpyvars, reason),
            };
            let (src_bank, src_idx) = match arg_int_bank_ref(args, base + 2) {
                Ok(pair) => pair,
                Err(reason) => return warn_and_advance(vm, MemOpcode::Cpyvars, reason),
            };
            let value = read_int_slot(vm, src_bank, src_idx);
            pairs.push((dst_bank, dst_idx, value));
        }
        for (dst_bank, dst_idx, value) in pairs {
            if let Err(reason) = write_int_slot(vm, dst_bank, dst_idx, value) {
                return warn_and_advance(vm, MemOpcode::Cpyvars, reason);
            }
        }
        DispatchOutcome::Advance
    }
}

/// `sum(dst_bank, dst_idx, src_bank, src_start, src_end)` — inclusive
/// range sum.
#[derive(Debug)]
pub struct SumOp;

impl RLOperation for SumOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let (dst_bank, dst_idx) = match arg_int_bank_ref(args, 0) {
            Ok(pair) => pair,
            Err(reason) => return warn_and_advance(vm, MemOpcode::Sum, reason),
        };
        let (src_bank, src_start) = match arg_int_bank_ref(args, 2) {
            Ok(pair) => pair,
            Err(reason) => return warn_and_advance(vm, MemOpcode::Sum, reason),
        };
        let end_i = match arg_int(args, 4, "end") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, MemOpcode::Sum, reason),
        };
        let end = match u16::try_from(end_i) {
            Ok(value) => value,
            Err(_) => {
                return warn_and_advance(vm, MemOpcode::Sum, format!("end out of range: {end_i}"));
            }
        };
        if end < src_start {
            // Zero-size range → 0.
            if let Err(reason) = write_int_slot(vm, dst_bank, dst_idx, 0) {
                return warn_and_advance(vm, MemOpcode::Sum, reason);
            }
            return DispatchOutcome::Advance;
        }
        let mut acc: i64 = 0;
        for idx in src_start..=end {
            acc = acc.saturating_add(read_int_slot(vm, src_bank, idx) as i64);
        }
        let acc_i32 = if acc > i32::MAX as i64 {
            i32::MAX
        } else if acc < i32::MIN as i64 {
            i32::MIN
        } else {
            acc as i32
        };
        if let Err(reason) = write_int_slot(vm, dst_bank, dst_idx, acc_i32) {
            return warn_and_advance(vm, MemOpcode::Sum, reason);
        }
        DispatchOutcome::Advance
    }
}

/// `sums(dst_bank, dst_idx, k, (src_bank0, src_start0, src_end0)…)` —
/// multi-range sum.
#[derive(Debug)]
pub struct SumsOp;

impl RLOperation for SumsOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let (dst_bank, dst_idx) = match arg_int_bank_ref(args, 0) {
            Ok(pair) => pair,
            Err(reason) => return warn_and_advance(vm, MemOpcode::Sums, reason),
        };
        let k_i = match arg_int(args, 2, "count") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, MemOpcode::Sums, reason),
        };
        if k_i < 0 {
            return warn_and_advance(vm, MemOpcode::Sums, format!("count out of range: {k_i}"));
        }
        let k = k_i as usize;
        if args.len() < 3 + k * 3 {
            return warn_and_advance(
                vm,
                MemOpcode::Sums,
                format!(
                    "missing range records: expected {} args, got {}",
                    3 + k * 3,
                    args.len(),
                ),
            );
        }
        let mut acc: i64 = 0;
        for i in 0..k {
            let base = 3 + i * 3;
            let (src_bank, src_start) = match arg_int_bank_ref(args, base) {
                Ok(pair) => pair,
                Err(reason) => return warn_and_advance(vm, MemOpcode::Sums, reason),
            };
            let end_i = match arg_int(args, base + 2, "end") {
                Ok(value) => value,
                Err(reason) => return warn_and_advance(vm, MemOpcode::Sums, reason),
            };
            let end = match u16::try_from(end_i) {
                Ok(value) => value,
                Err(_) => {
                    return warn_and_advance(
                        vm,
                        MemOpcode::Sums,
                        format!("end out of range: {end_i}"),
                    );
                }
            };
            if end < src_start {
                continue;
            }
            for idx in src_start..=end {
                acc = acc.saturating_add(read_int_slot(vm, src_bank, idx) as i64);
            }
        }
        let acc_i32 = if acc > i32::MAX as i64 {
            i32::MAX
        } else if acc < i32::MIN as i64 {
            i32::MIN
        } else {
            acc as i32
        };
        if let Err(reason) = write_int_slot(vm, dst_bank, dst_idx, acc_i32) {
            return warn_and_advance(vm, MemOpcode::Sums, reason);
        }
        DispatchOutcome::Advance
    }
}

// ---------------------------------------------------------------------
// Registry helper
// ---------------------------------------------------------------------

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

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::expression::{BANK_BYTE_INT_A, BANK_BYTE_INT_B};

    fn int_arg(value: i32) -> ExprValue {
        ExprValue::Int(value)
    }

    fn int_ref(bank_byte: u8, idx: u16) -> Vec<ExprValue> {
        vec![int_arg(bank_byte as i32), int_arg(idx as i32)]
    }

    fn args(parts: Vec<Vec<ExprValue>>) -> Vec<ExprValue> {
        let mut out = Vec::new();
        for part in parts {
            out.extend(part);
        }
        out
    }

    fn read_int(vm: &Vm, bank: BankId, idx: u16) -> i32 {
        match vm.banks().get(bank, idx) {
            Some(Value::Int(value)) => value,
            _ => 0,
        }
    }

    #[test]
    fn mem_register_helper_populates_expected_count() {
        let mut registry = RlopRegistry::new();
        let count = register_mem_rlops(&mut registry);
        assert_eq!(count, MEM_RLOP_COUNT);
        assert_eq!(registry.len(), MEM_RLOP_COUNT);
        for op in MemOpcode::ALL {
            assert!(registry.get(op.rlop_key()).is_some(), "{op:?} must resolve",);
        }
    }

    #[test]
    fn mem_opcode_byte_values_are_distinct() {
        let mut seen = std::collections::HashSet::new();
        for op in MemOpcode::ALL {
            assert!(seen.insert(op.opcode()), "duplicate opcode for {op:?}");
        }
    }

    // -----------------------------------------------------------------
    // Acceptance: `mem_setarray_stepped_table` — input/output table
    // for setarray_stepped with ≥3 cases incl. boundary.
    // -----------------------------------------------------------------

    #[test]
    fn mem_setarray_stepped_table_three_cases() {
        // Case 1: step=2, n=3 → indices 0, 2, 4 get the values.
        let mut vm = Vm::new(1, 0);
        SetarrayStepped.dispatch(
            &mut vm,
            &args(vec![
                int_ref(BANK_BYTE_INT_A, 0),
                vec![
                    int_arg(2),
                    int_arg(3),
                    int_arg(10),
                    int_arg(20),
                    int_arg(30),
                ],
            ]),
        );
        assert_eq!(read_int(&vm, BankId::IntA, 0), 10);
        assert_eq!(read_int(&vm, BankId::IntA, 1), 0);
        assert_eq!(read_int(&vm, BankId::IntA, 2), 20);
        assert_eq!(read_int(&vm, BankId::IntA, 3), 0);
        assert_eq!(read_int(&vm, BankId::IntA, 4), 30);
        // Case 2: step=5, n=2 → indices 100, 105.
        SetarrayStepped.dispatch(
            &mut vm,
            &args(vec![
                int_ref(BANK_BYTE_INT_A, 100),
                vec![int_arg(5), int_arg(2), int_arg(7), int_arg(9)],
            ]),
        );
        assert_eq!(read_int(&vm, BankId::IntA, 100), 7);
        assert_eq!(read_int(&vm, BankId::IntA, 105), 9);
        // Boundary: n=0 → no writes, no warnings.
        let mut vm2 = Vm::new(1, 0);
        SetarrayStepped.dispatch(
            &mut vm2,
            &args(vec![
                int_ref(BANK_BYTE_INT_A, 50),
                vec![int_arg(3), int_arg(0)],
            ]),
        );
        assert_eq!(read_int(&vm2, BankId::IntA, 50), 0);
        assert!(vm2.warnings().is_empty());
    }

    #[test]
    fn mem_setarray_stepped_boundary_max_u16_index_clamps() {
        // Boundary: writing at idx = BANK_INDEX_CAP - 1 (= 1999) lands.
        let mut vm = Vm::new(1, 0);
        SetarrayStepped.dispatch(
            &mut vm,
            &args(vec![
                int_ref(BANK_BYTE_INT_A, 1999),
                vec![int_arg(1), int_arg(1), int_arg(123)],
            ]),
        );
        assert_eq!(read_int(&vm, BankId::IntA, 1999), 123);
        // Writing at idx = BANK_INDEX_CAP (= 2000) clamps + warns
        // (per VarBanksWarning::BankIndexOutOfRange).
        SetarrayStepped.dispatch(
            &mut vm,
            &args(vec![
                int_ref(BANK_BYTE_INT_A, 2000),
                vec![int_arg(1), int_arg(1), int_arg(456)],
            ]),
        );
        // Write landed at the clamped idx (1999); but our dispatch
        // converts the warning into a RlopArgsInvalid (not a panic).
        let warnings = vm.take_warnings();
        assert!(warnings.iter().any(|w| matches!(
            w,
            VmWarning::RlopArgsInvalid {
                op: "mem.setarray_stepped",
                ..
            }
        )));
    }

    #[test]
    fn mem_setrng_stepped_table_three_cases() {
        let mut vm = Vm::new(1, 0);
        // Case 1: step=2, n=3, value=7 → indices 0/2/4 = 7.
        SetrngStepped.dispatch(
            &mut vm,
            &args(vec![
                int_ref(BANK_BYTE_INT_A, 0),
                vec![int_arg(2), int_arg(3), int_arg(7)],
            ]),
        );
        assert_eq!(read_int(&vm, BankId::IntA, 0), 7);
        assert_eq!(read_int(&vm, BankId::IntA, 2), 7);
        assert_eq!(read_int(&vm, BankId::IntA, 4), 7);
        assert_eq!(read_int(&vm, BankId::IntA, 1), 0);
        // Case 2: step=1, n=5, value=42 → contiguous fill.
        SetrngStepped.dispatch(
            &mut vm,
            &args(vec![
                int_ref(BANK_BYTE_INT_A, 100),
                vec![int_arg(1), int_arg(5), int_arg(42)],
            ]),
        );
        for idx in 100u16..105 {
            assert_eq!(read_int(&vm, BankId::IntA, idx), 42);
        }
        // Boundary: n=0 → no writes.
        SetrngStepped.dispatch(
            &mut vm,
            &args(vec![
                int_ref(BANK_BYTE_INT_A, 200),
                vec![int_arg(1), int_arg(0), int_arg(99)],
            ]),
        );
        assert_eq!(read_int(&vm, BankId::IntA, 200), 0);
    }

    #[test]
    fn mem_setarray_three_cases() {
        let mut vm = Vm::new(1, 0);
        // Case 1: three values.
        SetarrayOp.dispatch(
            &mut vm,
            &args(vec![
                int_ref(BANK_BYTE_INT_A, 0),
                vec![int_arg(3), int_arg(1), int_arg(2), int_arg(3)],
            ]),
        );
        assert_eq!(read_int(&vm, BankId::IntA, 0), 1);
        assert_eq!(read_int(&vm, BankId::IntA, 1), 2);
        assert_eq!(read_int(&vm, BankId::IntA, 2), 3);
        // Case 2: single value.
        SetarrayOp.dispatch(
            &mut vm,
            &args(vec![
                int_ref(BANK_BYTE_INT_A, 10),
                vec![int_arg(1), int_arg(42)],
            ]),
        );
        assert_eq!(read_int(&vm, BankId::IntA, 10), 42);
        // Boundary: zero count → no writes.
        SetarrayOp.dispatch(
            &mut vm,
            &args(vec![int_ref(BANK_BYTE_INT_A, 20), vec![int_arg(0)]]),
        );
        assert_eq!(read_int(&vm, BankId::IntA, 20), 0);
    }

    #[test]
    fn mem_setrng_three_cases() {
        let mut vm = Vm::new(1, 0);
        // Case 1: inclusive range.
        SetrngOp.dispatch(
            &mut vm,
            &args(vec![
                int_ref(BANK_BYTE_INT_A, 0),
                vec![int_arg(3), int_arg(99)],
            ]),
        );
        for idx in 0u16..=3 {
            assert_eq!(read_int(&vm, BankId::IntA, idx), 99);
        }
        // Case 2: single-element range.
        SetrngOp.dispatch(
            &mut vm,
            &args(vec![
                int_ref(BANK_BYTE_INT_A, 100),
                vec![int_arg(100), int_arg(7)],
            ]),
        );
        assert_eq!(read_int(&vm, BankId::IntA, 100), 7);
        // Boundary: end < start → zero-size, no writes.
        SetrngOp.dispatch(
            &mut vm,
            &args(vec![
                int_ref(BANK_BYTE_INT_A, 200),
                vec![int_arg(199), int_arg(42)],
            ]),
        );
        assert_eq!(read_int(&vm, BankId::IntA, 200), 0);
    }

    #[test]
    fn mem_cpyrng_three_cases() {
        let mut vm = Vm::new(1, 0);
        // Seed the source range.
        for (i, value) in [10, 20, 30].into_iter().enumerate() {
            vm.banks_mut()
                .set(BankId::IntA, i as u16, Value::Int(value))
                .expect("seed");
        }
        // Case 1: cross-bank copy.
        CpyrngOp.dispatch(
            &mut vm,
            &args(vec![
                int_ref(BANK_BYTE_INT_B, 0),
                int_ref(BANK_BYTE_INT_A, 0),
                vec![int_arg(3)],
            ]),
        );
        assert_eq!(read_int(&vm, BankId::IntB, 0), 10);
        assert_eq!(read_int(&vm, BankId::IntB, 1), 20);
        assert_eq!(read_int(&vm, BankId::IntB, 2), 30);
        // Case 2: in-bank overlapping copy (dst > src).
        CpyrngOp.dispatch(
            &mut vm,
            &args(vec![
                int_ref(BANK_BYTE_INT_A, 5),
                int_ref(BANK_BYTE_INT_A, 0),
                vec![int_arg(3)],
            ]),
        );
        assert_eq!(read_int(&vm, BankId::IntA, 5), 10);
        assert_eq!(read_int(&vm, BankId::IntA, 6), 20);
        assert_eq!(read_int(&vm, BankId::IntA, 7), 30);
        // Boundary: zero-count copy.
        CpyrngOp.dispatch(
            &mut vm,
            &args(vec![
                int_ref(BANK_BYTE_INT_B, 100),
                int_ref(BANK_BYTE_INT_A, 0),
                vec![int_arg(0)],
            ]),
        );
        assert_eq!(read_int(&vm, BankId::IntB, 100), 0);
    }

    #[test]
    fn mem_cpyvars_three_cases() {
        let mut vm = Vm::new(1, 0);
        // Seed sources.
        vm.banks_mut()
            .set(BankId::IntA, 0, Value::Int(11))
            .expect("seed");
        vm.banks_mut()
            .set(BankId::IntA, 1, Value::Int(22))
            .expect("seed");
        // Case 1: two pairs.
        CpyvarsOp.dispatch(
            &mut vm,
            &args(vec![
                vec![int_arg(2)],
                int_ref(BANK_BYTE_INT_B, 0),
                int_ref(BANK_BYTE_INT_A, 0),
                int_ref(BANK_BYTE_INT_B, 1),
                int_ref(BANK_BYTE_INT_A, 1),
            ]),
        );
        assert_eq!(read_int(&vm, BankId::IntB, 0), 11);
        assert_eq!(read_int(&vm, BankId::IntB, 1), 22);
        // Case 2: single pair.
        CpyvarsOp.dispatch(
            &mut vm,
            &args(vec![
                vec![int_arg(1)],
                int_ref(BANK_BYTE_INT_B, 99),
                int_ref(BANK_BYTE_INT_A, 0),
            ]),
        );
        assert_eq!(read_int(&vm, BankId::IntB, 99), 11);
        // Boundary: k=0 → no writes.
        CpyvarsOp.dispatch(&mut vm, &args(vec![vec![int_arg(0)]]));
        // No new writes.
    }

    #[test]
    fn mem_sum_three_cases() {
        let mut vm = Vm::new(1, 0);
        // Seed: intA[0..=2] = 1, 2, 3.
        for (i, value) in [1, 2, 3].into_iter().enumerate() {
            vm.banks_mut()
                .set(BankId::IntA, i as u16, Value::Int(value))
                .expect("seed");
        }
        // Case 1: non-empty range.
        SumOp.dispatch(
            &mut vm,
            &args(vec![
                int_ref(BANK_BYTE_INT_B, 0),
                int_ref(BANK_BYTE_INT_A, 0),
                vec![int_arg(2)],
            ]),
        );
        assert_eq!(read_int(&vm, BankId::IntB, 0), 6);
        // Case 2: single-element range.
        SumOp.dispatch(
            &mut vm,
            &args(vec![
                int_ref(BANK_BYTE_INT_B, 1),
                int_ref(BANK_BYTE_INT_A, 1),
                vec![int_arg(1)],
            ]),
        );
        assert_eq!(read_int(&vm, BankId::IntB, 1), 2);
        // Boundary: empty range (end < start) → 0.
        SumOp.dispatch(
            &mut vm,
            &args(vec![
                int_ref(BANK_BYTE_INT_B, 2),
                int_ref(BANK_BYTE_INT_A, 10),
                vec![int_arg(0)],
            ]),
        );
        assert_eq!(read_int(&vm, BankId::IntB, 2), 0);
    }

    #[test]
    fn mem_sums_three_cases() {
        let mut vm = Vm::new(1, 0);
        // Seed: intA[0..=2] = 1, 2, 3; intA[10..=11] = 100, 200.
        for (i, value) in [1, 2, 3].into_iter().enumerate() {
            vm.banks_mut()
                .set(BankId::IntA, i as u16, Value::Int(value))
                .expect("seed");
        }
        vm.banks_mut()
            .set(BankId::IntA, 10, Value::Int(100))
            .expect("seed");
        vm.banks_mut()
            .set(BankId::IntA, 11, Value::Int(200))
            .expect("seed");
        // Case 1: two ranges.
        SumsOp.dispatch(
            &mut vm,
            &args(vec![
                int_ref(BANK_BYTE_INT_B, 0),
                vec![int_arg(2)],
                int_ref(BANK_BYTE_INT_A, 0),
                vec![int_arg(2)],
                int_ref(BANK_BYTE_INT_A, 10),
                vec![int_arg(11)],
            ]),
        );
        assert_eq!(read_int(&vm, BankId::IntB, 0), 6 + 300);
        // Case 2: single range.
        SumsOp.dispatch(
            &mut vm,
            &args(vec![
                int_ref(BANK_BYTE_INT_B, 1),
                vec![int_arg(1)],
                int_ref(BANK_BYTE_INT_A, 0),
                vec![int_arg(0)],
            ]),
        );
        assert_eq!(read_int(&vm, BankId::IntB, 1), 1);
        // Boundary: zero ranges → 0.
        SumsOp.dispatch(
            &mut vm,
            &args(vec![int_ref(BANK_BYTE_INT_B, 2), vec![int_arg(0)]]),
        );
        assert_eq!(read_int(&vm, BankId::IntB, 2), 0);
    }

    #[test]
    fn setarray_with_non_int_bank_warns() {
        let mut vm = Vm::new(1, 0);
        // strS = 0x12; not an int bank.
        SetarrayOp.dispatch(
            &mut vm,
            &args(vec![vec![
                int_arg(0x12),
                int_arg(0),
                int_arg(1),
                int_arg(99),
            ]]),
        );
        let warnings = vm.take_warnings();
        assert_eq!(warnings.len(), 1);
        assert!(matches!(
            warnings[0],
            VmWarning::RlopArgsInvalid {
                op: "mem.setarray",
                ..
            }
        ));
    }
}
