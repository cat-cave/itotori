use super::*;

// Per-opcode RLOperation implementors

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
            let Some(value) = args[3 + i].as_int() else {
                return warn_and_advance(
                    vm,
                    MemOpcode::Setarray,
                    format!("arg[{}] expected Int(value), got Bytes", 3 + i),
                );
            };
            let Ok(offset) = u16::try_from(i) else {
                return warn_and_advance(
                    vm,
                    MemOpcode::Setarray,
                    format!("offset out of range: {i}"),
                );
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
        let Ok(end) = u16::try_from(end_i) else {
            return warn_and_advance(vm, MemOpcode::Setrng, format!("end out of range: {end_i}"));
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
        let Ok(count) = u16::try_from(count_i) else {
            return warn_and_advance(
                vm,
                MemOpcode::Cpyrng,
                format!("count out of range: {count_i}"),
            );
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
            let Ok(offset_u16) = u16::try_from(offset) else {
                return warn_and_advance(
                    vm,
                    MemOpcode::Cpyrng,
                    format!("offset out of range: {offset}"),
                );
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
            let Some(value) = args[4 + i].as_int() else {
                return warn_and_advance(
                    vm,
                    MemOpcode::SetarrayStepped,
                    format!("arg[{}] expected Int(value), got Bytes", 4 + i),
                );
            };
            let offset_u32 = (i as u32)
                .checked_mul(step)
                .ok_or_else(|| format!("offset overflow i={i} step={step}"));
            let offset_u32 = match offset_u32 {
                Ok(value) => value,
                Err(reason) => return warn_and_advance(vm, MemOpcode::SetarrayStepped, reason),
            };
            let Ok(offset) = u16::try_from(offset_u32) else {
                return warn_and_advance(
                    vm,
                    MemOpcode::SetarrayStepped,
                    format!("offset out of range: {offset_u32}"),
                );
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
            let Some(offset_u32) = (i as u32).checked_mul(step) else {
                return warn_and_advance(
                    vm,
                    MemOpcode::SetrngStepped,
                    format!("offset overflow i={i} step={step}"),
                );
            };
            let Ok(offset) = u16::try_from(offset_u32) else {
                return warn_and_advance(
                    vm,
                    MemOpcode::SetrngStepped,
                    format!("offset out of range: {offset_u32}"),
                );
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
        let Ok(end) = u16::try_from(end_i) else {
            return warn_and_advance(vm, MemOpcode::Sum, format!("end out of range: {end_i}"));
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
            let Ok(end) = u16::try_from(end_i) else {
                return warn_and_advance(vm, MemOpcode::Sums, format!("end out of range: {end_i}"));
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
