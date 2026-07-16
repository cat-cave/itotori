use super::*;

// Per-opcode RLOperation implementors

/// `strcpy(dst_bank, dst_idx, src…)` — copy a string slot.
#[derive(Debug)]
pub struct StrcpyOp;

impl RLOperation for StrcpyOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let (dst_bank, dst_idx) = match arg_bank_ref(args, 0) {
            Ok(pair) => pair,
            Err(reason) => return warn_and_advance(vm, StrOpcode::Strcpy, reason),
        };
        let (_, bytes) = match read_str_operand(vm, args, 2) {
            Ok(pair) => pair,
            Err(reason) => return warn_and_advance(vm, StrOpcode::Strcpy, reason),
        };
        if let Err(reason) = write_str_bank(vm, dst_bank, dst_idx, bytes) {
            return warn_and_advance(vm, StrOpcode::Strcpy, reason);
        }
        DispatchOutcome::Advance
    }
}

/// `strcat(dst_bank, dst_idx, src…)` — concatenate.
#[derive(Debug)]
pub struct StrcatOp;

impl RLOperation for StrcatOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let (dst_bank, dst_idx) = match arg_bank_ref(args, 0) {
            Ok(pair) => pair,
            Err(reason) => return warn_and_advance(vm, StrOpcode::Strcat, reason),
        };
        let (_, src_bytes) = match read_str_operand(vm, args, 2) {
            Ok(pair) => pair,
            Err(reason) => return warn_and_advance(vm, StrOpcode::Strcat, reason),
        };
        if !dst_bank.is_str() {
            return warn_and_advance(
                vm,
                StrOpcode::Strcat,
                format!("dst {} is not a string bank", dst_bank.as_str()),
            );
        }
        let mut acc = read_str_bank(vm, dst_bank, dst_idx);
        acc.extend(src_bytes);
        if let Err(reason) = write_str_bank(vm, dst_bank, dst_idx, acc) {
            return warn_and_advance(vm, StrOpcode::Strcat, reason);
        }
        DispatchOutcome::Advance
    }
}

/// `strlen(dst_int_bank, dst_int_idx, src…)` — byte length.
#[derive(Debug)]
pub struct StrlenOp;

impl RLOperation for StrlenOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let (dst_bank, dst_idx) = match arg_bank_ref(args, 0) {
            Ok(pair) => pair,
            Err(reason) => return warn_and_advance(vm, StrOpcode::Strlen, reason),
        };
        let (_, bytes) = match read_str_operand(vm, args, 2) {
            Ok(pair) => pair,
            Err(reason) => return warn_and_advance(vm, StrOpcode::Strlen, reason),
        };
        let length = i32::try_from(bytes.len()).unwrap_or(i32::MAX);
        if let Err(reason) = write_int_bank(vm, dst_bank, dst_idx, length) {
            return warn_and_advance(vm, StrOpcode::Strlen, reason);
        }
        DispatchOutcome::Advance
    }
}

/// `strout(src…)` — emit a string-slot through the substrate sink.
#[derive(Debug)]
pub struct StroutOp {
    runtime: Arc<StrRuntime>,
}

impl StroutOp {
    pub fn new(runtime: Arc<StrRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for StroutOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let (_, bytes) = match read_str_operand(vm, args, 0) {
            Ok(pair) => pair,
            Err(reason) => return warn_and_advance(vm, StrOpcode::Strout, reason),
        };
        let (cow, _, _) = encoding_rs::SHIFT_JIS.decode(&bytes);
        let text = cow.into_owned();
        if let Err(reason) = self.runtime.emit("strout", text) {
            return warn_and_advance(vm, StrOpcode::Strout, reason);
        }
        DispatchOutcome::Advance
    }
}

/// `intout(int…)` — emit an integer's decimal form through the sink.
#[derive(Debug)]
pub struct IntoutOp {
    runtime: Arc<StrRuntime>,
}

impl IntoutOp {
    pub fn new(runtime: Arc<StrRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for IntoutOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let (_, value) = match read_int_operand(vm, args, 0) {
            Ok(pair) => pair,
            Err(reason) => return warn_and_advance(vm, StrOpcode::Intout, reason),
        };
        if let Err(reason) = self.runtime.emit("intout", value.to_string()) {
            return warn_and_advance(vm, StrOpcode::Intout, reason);
        }
        DispatchOutcome::Advance
    }
}

/// `Uppercase(bank, idx)` — ASCII upper-case in place.
#[derive(Debug)]
pub struct UppercaseOp;

impl RLOperation for UppercaseOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let (bank, idx) = match arg_bank_ref(args, 0) {
            Ok(pair) => pair,
            Err(reason) => return warn_and_advance(vm, StrOpcode::Uppercase, reason),
        };
        if !bank.is_str() {
            return warn_and_advance(
                vm,
                StrOpcode::Uppercase,
                format!("target {} is not a string bank", bank.as_str()),
            );
        }
        let bytes = read_str_bank(vm, bank, idx);
        let folded = ascii_upper(&bytes);
        if let Err(reason) = write_str_bank(vm, bank, idx, folded) {
            return warn_and_advance(vm, StrOpcode::Uppercase, reason);
        }
        DispatchOutcome::Advance
    }
}

/// `Lowercase(bank, idx)` — ASCII lower-case in place.
#[derive(Debug)]
pub struct LowercaseOp;

impl RLOperation for LowercaseOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let (bank, idx) = match arg_bank_ref(args, 0) {
            Ok(pair) => pair,
            Err(reason) => return warn_and_advance(vm, StrOpcode::Lowercase, reason),
        };
        if !bank.is_str() {
            return warn_and_advance(
                vm,
                StrOpcode::Lowercase,
                format!("target {} is not a string bank", bank.as_str()),
            );
        }
        let bytes = read_str_bank(vm, bank, idx);
        let folded = ascii_lower(&bytes);
        if let Err(reason) = write_str_bank(vm, bank, idx, folded) {
            return warn_and_advance(vm, StrOpcode::Lowercase, reason);
        }
        DispatchOutcome::Advance
    }
}

/// `itoa(dst_str_bank, dst_str_idx, src_int…)` — int → decimal-ASCII.
#[derive(Debug)]
pub struct ItoaOp;

impl RLOperation for ItoaOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let (dst_bank, dst_idx) = match arg_bank_ref(args, 0) {
            Ok(pair) => pair,
            Err(reason) => return warn_and_advance(vm, StrOpcode::Itoa, reason),
        };
        let (_, value) = match read_int_operand(vm, args, 2) {
            Ok(pair) => pair,
            Err(reason) => return warn_and_advance(vm, StrOpcode::Itoa, reason),
        };
        let text = value.to_string().into_bytes();
        if let Err(reason) = write_str_bank(vm, dst_bank, dst_idx, text) {
            return warn_and_advance(vm, StrOpcode::Itoa, reason);
        }
        DispatchOutcome::Advance
    }
}

/// `atoi(dst_int_bank, dst_int_idx, src_str…)` — decimal-ASCII → int.
#[derive(Debug)]
pub struct AtoiOp;

impl RLOperation for AtoiOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let (dst_bank, dst_idx) = match arg_bank_ref(args, 0) {
            Ok(pair) => pair,
            Err(reason) => return warn_and_advance(vm, StrOpcode::Atoi, reason),
        };
        let (_, bytes) = match read_str_operand(vm, args, 2) {
            Ok(pair) => pair,
            Err(reason) => return warn_and_advance(vm, StrOpcode::Atoi, reason),
        };
        // RLDEV documents atoi as a leading-decimal-prefix parse (matches
        // C `atoi`). We accept an optional leading sign and stop at the
        // first non-digit byte.
        let value = parse_leading_decimal(&bytes);
        if let Err(reason) = write_int_bank(vm, dst_bank, dst_idx, value) {
            return warn_and_advance(vm, StrOpcode::Atoi, reason);
        }
        DispatchOutcome::Advance
    }
}

/// Leading-decimal-prefix parse, matching the documented `atoi`
/// behaviour. Skips leading whitespace, accepts an optional sign
/// stops at the first non-digit byte. Returns `0` on no digits.
fn parse_leading_decimal(bytes: &[u8]) -> i32 {
    let mut i = 0;
    while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
        i += 1;
    }
    let mut sign: i64 = 1;
    if i < bytes.len() && (bytes[i] == b'-' || bytes[i] == b'+') {
        if bytes[i] == b'-' {
            sign = -1;
        }
        i += 1;
    }
    let mut acc: i64 = 0;
    let mut saw_digit = false;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        let d = (bytes[i] - b'0') as i64;
        acc = acc.saturating_mul(10).saturating_add(d);
        saw_digit = true;
        i += 1;
    }
    if !saw_digit {
        return 0;
    }
    let signed = sign.saturating_mul(acc);
    if signed > i32::MAX as i64 {
        i32::MAX
    } else if signed < i32::MIN as i64 {
        i32::MIN
    } else {
        signed as i32
    }
}

/// `strpos(dst_int_bank, dst_int_idx, haystack…, needle…)` — first
/// byte position of needle. `-1` on miss.
#[derive(Debug)]
pub struct StrposOp;

impl RLOperation for StrposOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let (dst_bank, dst_idx) = match arg_bank_ref(args, 0) {
            Ok(pair) => pair,
            Err(reason) => return warn_and_advance(vm, StrOpcode::Strpos, reason),
        };
        let (consumed, haystack) = match read_str_operand(vm, args, 2) {
            Ok(pair) => pair,
            Err(reason) => return warn_and_advance(vm, StrOpcode::Strpos, reason),
        };
        let (_, needle) = match read_str_operand(vm, args, 2 + consumed) {
            Ok(pair) => pair,
            Err(reason) => return warn_and_advance(vm, StrOpcode::Strpos, reason),
        };
        let result = byte_find_first(&haystack, &needle)
            .map_or(-1, |idx| i32::try_from(idx).unwrap_or(i32::MAX));
        if let Err(reason) = write_int_bank(vm, dst_bank, dst_idx, result) {
            return warn_and_advance(vm, StrOpcode::Strpos, reason);
        }
        DispatchOutcome::Advance
    }
}

/// `strlpos(dst_int_bank, dst_int_idx, haystack…, needle…)` — last
/// byte position of needle. `-1` on miss.
#[derive(Debug)]
pub struct StrlposOp;

impl RLOperation for StrlposOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let (dst_bank, dst_idx) = match arg_bank_ref(args, 0) {
            Ok(pair) => pair,
            Err(reason) => return warn_and_advance(vm, StrOpcode::Strlpos, reason),
        };
        let (consumed, haystack) = match read_str_operand(vm, args, 2) {
            Ok(pair) => pair,
            Err(reason) => return warn_and_advance(vm, StrOpcode::Strlpos, reason),
        };
        let (_, needle) = match read_str_operand(vm, args, 2 + consumed) {
            Ok(pair) => pair,
            Err(reason) => return warn_and_advance(vm, StrOpcode::Strlpos, reason),
        };
        let result = byte_find_last(&haystack, &needle)
            .map_or(-1, |idx| i32::try_from(idx).unwrap_or(i32::MAX));
        if let Err(reason) = write_int_bank(vm, dst_bank, dst_idx, result) {
            return warn_and_advance(vm, StrOpcode::Strlpos, reason);
        }
        DispatchOutcome::Advance
    }
}

/// `hantozen(bank, idx)` — half-width → full-width in place.
#[derive(Debug)]
pub struct HantozenOp;

impl RLOperation for HantozenOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let (bank, idx) = match arg_bank_ref(args, 0) {
            Ok(pair) => pair,
            Err(reason) => return warn_and_advance(vm, StrOpcode::Hantozen, reason),
        };
        if !bank.is_str() {
            return warn_and_advance(
                vm,
                StrOpcode::Hantozen,
                format!("target {} is not a string bank", bank.as_str()),
            );
        }
        let bytes = read_str_bank(vm, bank, idx);
        let folded = hantozen_bytes(&bytes);
        if let Err(reason) = write_str_bank(vm, bank, idx, folded) {
            return warn_and_advance(vm, StrOpcode::Hantozen, reason);
        }
        DispatchOutcome::Advance
    }
}

/// `zentohan(bank, idx)` — full-width → half-width in place.
#[derive(Debug)]
pub struct ZentohanOp;

impl RLOperation for ZentohanOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let (bank, idx) = match arg_bank_ref(args, 0) {
            Ok(pair) => pair,
            Err(reason) => return warn_and_advance(vm, StrOpcode::Zentohan, reason),
        };
        if !bank.is_str() {
            return warn_and_advance(
                vm,
                StrOpcode::Zentohan,
                format!("target {} is not a string bank", bank.as_str()),
            );
        }
        let bytes = read_str_bank(vm, bank, idx);
        let folded = zentohan_bytes(&bytes);
        if let Err(reason) = write_str_bank(vm, bank, idx, folded) {
            return warn_and_advance(vm, StrOpcode::Zentohan, reason);
        }
        DispatchOutcome::Advance
    }
}

// Registry helper

/// Mount every `module_str` op this module ships into `registry`.
/// Returns the number of opcodes registered (matches
/// [`STR_RLOP_COUNT`]).
pub fn register_str_rlops(registry: &mut RlopRegistry, runtime: Arc<StrRuntime>) -> usize {
    registry.register(StrOpcode::Strcpy.rlop_key(), Arc::new(StrcpyOp));
    registry.register(StrOpcode::Strcat.rlop_key(), Arc::new(StrcatOp));
    registry.register(StrOpcode::Strlen.rlop_key(), Arc::new(StrlenOp));
    registry.register(
        StrOpcode::Strout.rlop_key(),
        Arc::new(StroutOp::new(Arc::clone(&runtime))),
    );
    registry.register(
        StrOpcode::Intout.rlop_key(),
        Arc::new(IntoutOp::new(Arc::clone(&runtime))),
    );
    registry.register(StrOpcode::Uppercase.rlop_key(), Arc::new(UppercaseOp));
    registry.register(StrOpcode::Lowercase.rlop_key(), Arc::new(LowercaseOp));
    registry.register(StrOpcode::Itoa.rlop_key(), Arc::new(ItoaOp));
    registry.register(StrOpcode::Atoi.rlop_key(), Arc::new(AtoiOp));
    registry.register(StrOpcode::Strpos.rlop_key(), Arc::new(StrposOp));
    registry.register(StrOpcode::Strlpos.rlop_key(), Arc::new(StrlposOp));
    registry.register(StrOpcode::Hantozen.rlop_key(), Arc::new(HantozenOp));
    registry.register(StrOpcode::Zentohan.rlop_key(), Arc::new(ZentohanOp));
    STR_RLOP_COUNT
}
