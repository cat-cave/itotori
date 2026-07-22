//! RealLive `module_str` string-manipulation RLOperation
//! family.
//!
//! Implements the string opcodes RealLive's `module_str` exposes:
//! `strcpy`, `strcat`, `strlen`, `Uppercase`, `Lowercase`, `itoa`
//! `atoi`, `strout`, `intout`, `strpos`, `strlpos`, `hantozen`
//! `zentohan`. Each op consumes typed `(BankId, idx)` references via the
//! [`ExprValue`] argument carrier and produces its observable side
//! effect through the VM's typed [`crate::var_banks::VarBanks`] surface
//! and the [`utsushi_core::substrate::TextSurfaceSink`] (for
//! `strout` / `intout`).
//!
//! # Module addressing
//!
//! `module_str` is registered at `(module_type=1, module_id=10)` —
//! the REAL RealLive semantic id for the string family (matching the
//! `kaifuu-reallive` decompiler), consistent with the `(1, X)`
//! convention pinned by [`crate::rlop::module_msg`] (`(1, 3)`)
//! [`crate::rlop::module_sel`] (`(1, 2)`), and
//! [`crate::rlop::module_sys`] (`(1, 4)`). The opcode numbers below are re-derived
//! clean-room from the RLDEV name table (see
//! `docs/research/reallive-engine.md`) and pinned as `const u16`
//! constants so audit tooling can assert "the registry covers
//! exactly the surface".
//!
//! # Opcode coverage (13)
//!
//! Opcode | Op | Semantics
//! -------------------- | ------------ | ------------------------------------
//! `0x0000` | `strcpy` | `strX[dst]:= strX[src]`
//! `0x0001` | `strclear` | (covered by `strcpy("")` — not exposed)
//! `0x0002` | `strcat` | `strX[dst]:= strX[dst] + strX[src]`
//! `0x0003` | `strlen` | `intX[dst]:= byte-length(strX[src])`
//! `0x0004` | `strcmp` | (not in surface)
//! `0x0005` | `strsub` | (not in surface)
//! `0x0006` | `strrsub` | (not in surface)
//! `0x0007` | `strcharlen` | (not in surface)
//! `0x0008` | `strtrunc` | (not in surface)
//! `0x0009` | `strout` | sink emission of strX[src]
//! `0x000a` | `intout` | sink emission of intX[src] as ASCII
//! `0x000b` | `Uppercase` | strX[idx] ASCII upper-case in place
//! `0x000c` | `Lowercase` | strX[idx] ASCII lower-case in place
//! `0x000d` | `itoa` | `strX[dst]:= decimal_ascii(int_src)`
//! `0x000e` | `atoi` | `intX[dst]:= parse_decimal(strX[src])`
//! `0x000f` | `strpos` | byte position of needle in haystack
//! `0x0010` | `strlpos` | last byte position of needle
//! `0x0011` | `hantozen` | half-width → full-width in place
//! `0x0012` | `zentohan` | full-width → half-width in place
//!
//! The "not in surface" rows are reserved opcode slots —
//! the registry only mounts the 13 ops listed in [`StrOpcode::ALL`].
//! Other slots resolve to `MissingRlop` (the fail-soft path
//! pinned).
//!
//! # Argument shape
//!
//! Per RLDEV, `module_str` ops carry **typed variable references** in
//! their argument slots — `strX[idx]` for string operands and
//! `intX[idx]` for integer operands. The expression parser
//! does not yet emit a `BankRef` variant on the [`ExprValue`] carrier;
//! this module accepts a **two-int convention** for each variable
//! reference: a leading `Int(bank_byte)` followed by `Int(idx)`. A
//! literal `Bytes` payload for `strX` is also accepted in `strcpy`
//! `strcat` / `strout` so the synthetic tests can drive the ops without
//! plumbing a writer into the bank in advance — the runtime path will
//! always emit `(bank, idx)` pairs.
//!
//! # Substrate-honesty posture
//!
//! - **Typed `(BankId, idx)`.** A mismatched bank kind (e.g. `intA` for
//!   a string slot) or out-of-bound index produces a
//!   [`VmWarning::RlopArgsInvalid`] and the op advances — no panic.
//! - **No silent truncation.** `strX[idx]` reads of an unset slot
//!   resolve to an empty byte string (matching rlvm's behaviour);
//!   `itoa` / `atoi` round-trip via the substrate-honest
//!   ASCII-decimal path (no locale).
//! - **Shift-JIS aware.** `hantozen` and `zentohan` walk Shift-JIS
//!   bytes with a pair table re-derived from RLDEV's documented
//!   half/full width mappings. Half-width katakana (lead bytes
//!   `0xA1..=0xDF`) survive the round trip; the test
//!   `hantozen_half_width_katakana_round_trips` pins this.
//! - **No host print.** `strout` / `intout` emit through the substrate
//!   [`TextSurfaceSink::emit_line`] surface, never via stdout. The
//!   emitted [`TextLine`] carries `text_surface = "strout"`
//!   `"intout"` so audit tooling can distinguish them from `msg.*`
//!   emissions.

use std::sync::{Arc, Mutex};

use utsushi_core::substrate::{EvidenceTier, TextLine, TextSurfaceSink};

use super::{DispatchOutcome, ExprValue, RLOperation, RlopKey, RlopRegistry};
use crate::var_banks::{BankId, Value};
use crate::vm::{Vm, VmWarning};

mod shift_jis;

pub use shift_jis::{hantozen_bytes, zentohan_bytes};

#[path = "module_str/opcode.rs"]
mod opcode;

pub use opcode::{
    OPCODE_ATOI, OPCODE_HANTOZEN, OPCODE_INTOUT, OPCODE_ITOA, OPCODE_LOWERCASE, OPCODE_STRCAT,
    OPCODE_STRCPY, OPCODE_STRLEN, OPCODE_STRLPOS, OPCODE_STROUT, OPCODE_STRPOS, OPCODE_UPPERCASE,
    OPCODE_ZENTOHAN, STR_MODULE_ID, STR_MODULE_TYPE, STR_RLOP_COUNT, StrOpcode,
};

// Runtime carrier

/// Runtime carrier the per-op [`RLOperation`] impls thread through to
/// the [`TextSurfaceSink`] (for `strout` / `intout`). Held inside `Arc`
/// so the registry's `Arc<dyn RLOperation>` entries can clone cheaply.
pub struct StrRuntime {
    sink: Arc<dyn TextSurfaceSink>,
    inner: Mutex<StrRuntimeInner>,
}

#[derive(Debug, Default)]
struct StrRuntimeInner {
    /// Counter the runtime uses to disambiguate `line_id` strings on
    /// the [`TextLine`] surface. Increments on every emission.
    next_line_seq: u64,
}

impl std::fmt::Debug for StrRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("StrRuntime").finish()
    }
}

impl StrRuntime {
    /// Build a runtime backed by `sink`. The sink is the only path
    /// through which `strout` / `intout` reach the substrate.
    pub fn new(sink: Arc<dyn TextSurfaceSink>) -> Self {
        Self {
            sink,
            inner: Mutex::new(StrRuntimeInner::default()),
        }
    }

    /// Borrow the sink.
    pub fn sink(&self) -> &Arc<dyn TextSurfaceSink> {
        &self.sink
    }

    fn next_line_id(&self) -> String {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let id = guard.next_line_seq;
        guard.next_line_seq = guard.next_line_seq.saturating_add(1);
        format!("utsushi-reallive-str-line-{id:08x}")
    }

    /// Emit `text` through the sink with `text_surface` tag.
    fn emit(&self, text_surface: &'static str, text: String) -> Result<(), String> {
        let line = TextLine {
            line_id: self.next_line_id(),
            evidence_tier: EvidenceTier::E1,
            text,
            speaker: None,
            color: None,
            text_surface: Some(text_surface.to_string()),
            bridge_ref: None,
            source_asset: None,
            byte_offset_in_scene: None,
            body_shift_jis: None,
        };
        self.sink.emit_line(line).map_err(|err| err.to_string())
    }
}

// Argument helpers

/// Resolve `args[start..start+2]` as a `(BankId, idx)` pair. Returns
/// `Err` with a typed reason string on a malformed pair.
fn arg_bank_ref(args: &[ExprValue], start: usize) -> Result<(BankId, u16), String> {
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
    let bank = BankId::from_bank_byte(bank_byte_u8)
        .ok_or_else(|| format!("arg[{start}] unknown bank_byte=0x{bank_byte_u8:02x}"))?;
    let idx_u16 = u16::try_from(idx_i)
        .map_err(|_| format!("arg[{}] idx out of range: {idx_i}", start + 1))?;
    Ok((bank, idx_u16))
}

/// Read the bytes at `(bank, idx)`. Returns an empty `Vec<u8>` for an
/// unset slot — matches RLDEV-documented behaviour ("empty string for
/// any unwritten string slot").
fn read_str_bank(vm: &Vm, bank: BankId, idx: u16) -> Vec<u8> {
    match vm.banks().get(bank, idx) {
        Some(Value::Str(bytes)) => bytes,
        _ => Vec::new(),
    }
}

/// Read the integer at `(bank, idx)`. Returns `0` for an unset slot.
fn read_int_bank(vm: &Vm, bank: BankId, idx: u16) -> i32 {
    match vm.banks().get(bank, idx) {
        Some(Value::Int(value)) => value,
        _ => 0,
    }
}

/// Decode the source operand for a strX-shaped read. Accepts either a
/// `(bank_byte, idx)` two-int prefix at `start..start+2` or a literal
/// `Bytes` payload. Returns `(consumed_args, bytes)`.
fn read_str_operand(vm: &Vm, args: &[ExprValue], start: usize) -> Result<(usize, Vec<u8>), String> {
    match args.get(start) {
        Some(ExprValue::Bytes(bytes)) => Ok((1, bytes.clone())),
        Some(ExprValue::Int(_)) => {
            let (bank, idx) = arg_bank_ref(args, start)?;
            if !bank.is_str() {
                return Err(format!(
                    "arg[{start}] expected str bank, got int bank {}",
                    bank.as_str()
                ));
            }
            Ok((2, read_str_bank(vm, bank, idx)))
        }
        None => Err(format!("missing arg[{start}] (str operand)")),
    }
}

/// Decode an `intX[idx]` operand (or accept a literal `Int(value)`).
fn read_int_operand(vm: &Vm, args: &[ExprValue], start: usize) -> Result<(usize, i32), String> {
    let bank_arg = args
        .get(start)
        .ok_or_else(|| format!("missing arg[{start}] (int operand)"))?;
    let bank_byte = bank_arg
        .as_int()
        .ok_or_else(|| format!("arg[{start}] expected Int, got Bytes"))?;
    // A literal int (no following idx) is the "constant" shape. We
    // detect the bank-byte prefix by looking at whether the byte falls
    // in `0x00..=0x12` AND there's a following arg that decodes as an
    // index. Otherwise we treat the value as a literal.
    if let Ok(bank_byte_u8) = u8::try_from(bank_byte)
        && BankId::from_int_bank_byte(bank_byte_u8).is_some()
        && let Some(idx_arg) = args.get(start + 1)
        && let Some(idx_i) = idx_arg.as_int()
        && let Ok(idx_u16) = u16::try_from(idx_i)
    {
        let bank = BankId::from_int_bank_byte(bank_byte_u8).expect("checked above");
        return Ok((2, read_int_bank(vm, bank, idx_u16)));
    }
    Ok((1, bank_byte))
}

/// Write `bytes` to the destination `(bank, idx)`. Returns the typed
/// warning carrier so the caller can fold it back into the VM's
/// diagnostic queue.
fn write_str_bank(vm: &mut Vm, bank: BankId, idx: u16, bytes: Vec<u8>) -> Result<(), String> {
    if !bank.is_str() {
        return Err(format!("dst {} is not a string bank", bank.as_str()));
    }
    match vm.banks_mut().set(bank, idx, Value::Str(bytes)) {
        Ok(()) => Ok(()),
        Err(warning) => Err(warning.to_string()),
    }
}

/// Write `value` to the destination `(bank, idx)`. Returns the typed
/// warning carrier so the caller can fold it back into the VM's
/// diagnostic queue.
fn write_int_bank(vm: &mut Vm, bank: BankId, idx: u16, value: i32) -> Result<(), String> {
    if !bank.is_int() {
        return Err(format!("dst {} is not an integer bank", bank.as_str()));
    }
    match vm.banks_mut().set(bank, idx, Value::Int(value)) {
        Ok(()) => Ok(()),
        Err(warning) => Err(warning.to_string()),
    }
}

fn warn_and_advance(vm: &mut Vm, op: StrOpcode, reason: String) -> DispatchOutcome {
    vm.push_warning(VmWarning::RlopArgsInvalid {
        op: op.as_str(),
        reason,
    });
    DispatchOutcome::Advance
}

/// ASCII upper-case transform on Shift-JIS bytes. Double-byte
/// Shift-JIS pairs (lead `0x81..=0x9F` or `0xE0..=0xFC`) pass through
/// verbatim — full-width Latin letters are NOT folded (matches
/// RLDEV-documented behaviour: "Uppercase only affects the ASCII byte
/// range").
fn ascii_upper(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if ((0x81..=0x9F).contains(&b) || (0xE0..=0xFC).contains(&b)) && i + 1 < bytes.len() {
            out.push(b);
            out.push(bytes[i + 1]);
            i += 2;
            continue;
        }
        match b {
            0x61..=0x7A => out.push(b - 0x20),
            other => out.push(other),
        }
        i += 1;
    }
    out
}

/// ASCII lower-case transform on Shift-JIS bytes. Double-byte
/// Shift-JIS pairs pass through verbatim.
fn ascii_lower(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if ((0x81..=0x9F).contains(&b) || (0xE0..=0xFC).contains(&b)) && i + 1 < bytes.len() {
            out.push(b);
            out.push(bytes[i + 1]);
            i += 2;
            continue;
        }
        match b {
            0x41..=0x5A => out.push(b + 0x20),
            other => out.push(other),
        }
        i += 1;
    }
    out
}

/// Find the first byte offset of `needle` inside `haystack`. Returns
/// `None` on a miss. Empty needle returns `Some(0)` (matches `strstr`).
fn byte_find_first(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    if needle.len() > haystack.len() {
        return None;
    }
    for start in 0..=haystack.len() - needle.len() {
        if &haystack[start..start + needle.len()] == needle {
            return Some(start);
        }
    }
    None
}

/// Find the last byte offset of `needle` inside `haystack`. Returns
/// `None` on a miss. Empty needle returns `Some(haystack.len())`.
fn byte_find_last(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(haystack.len());
    }
    if needle.len() > haystack.len() {
        return None;
    }
    let mut idx = haystack.len() - needle.len();
    loop {
        if &haystack[idx..idx + needle.len()] == needle {
            return Some(idx);
        }
        if idx == 0 {
            break;
        }
        idx -= 1;
    }
    None
}

mod operations;

pub use operations::{
    AtoiOp, HantozenOp, IntoutOp, ItoaOp, LowercaseOp, StrcatOp, StrcpyOp, StrlenOp, StrlposOp,
    StroutOp, StrposOp, UppercaseOp, ZentohanOp, register_str_rlops,
};

// Tests

#[cfg(test)]
#[path = "module_str/tests.rs"]
mod tests;
