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

/// `module_str` module type byte. Pinned at `1` to match the
/// `(1, X)` convention established by
/// [`crate::rlop::module_msg`] / [`crate::rlop::module_sel`]
/// [`crate::rlop::module_sys`].
pub const STR_MODULE_TYPE: u8 = 1;
/// `module_str` module id byte. This is the REAL RealLive semantic id
/// `10` used by the `kaifuu-reallive` decompiler
/// (`opcode::module_id::STR`) and validated on the real bytecode. An
/// earlier revision mislabelled it `2` (which is actually `SEL`).
/// Corrected to `10`.
pub const STR_MODULE_ID: u8 = 10;

/// `strcpy` — `strX[dst]:= strX[src]`.
pub const OPCODE_STRCPY: u16 = 0x0000;
/// `strcat` — `strX[dst]:= strX[dst] + strX[src]`.
pub const OPCODE_STRCAT: u16 = 0x0002;
/// `strlen` — `intX[dst]:= byte-length(strX[src])`.
pub const OPCODE_STRLEN: u16 = 0x0003;
/// `strout` — emit `strX[src]` through the substrate sink.
pub const OPCODE_STROUT: u16 = 0x0009;
/// `intout` — emit ASCII decimal `intX[src]` through the substrate sink.
pub const OPCODE_INTOUT: u16 = 0x000a;
/// `Uppercase` — ASCII upper-case `strX[idx]` in place.
pub const OPCODE_UPPERCASE: u16 = 0x000b;
/// `Lowercase` — ASCII lower-case `strX[idx]` in place.
pub const OPCODE_LOWERCASE: u16 = 0x000c;
/// `itoa` — `strX[dst]:= decimal_ascii(int_src)`.
pub const OPCODE_ITOA: u16 = 0x000d;
/// `atoi` — `intX[dst]:= parse_decimal(strX[src])`.
pub const OPCODE_ATOI: u16 = 0x000e;
/// `strpos` — byte position of needle in haystack (`-1` on miss).
pub const OPCODE_STRPOS: u16 = 0x000f;
/// `strlpos` — last byte position of needle in haystack (`-1` on miss).
pub const OPCODE_STRLPOS: u16 = 0x0010;
/// `hantozen` — half-width → full-width transform on `strX[idx]`.
pub const OPCODE_HANTOZEN: u16 = 0x0011;
/// `zentohan` — full-width → half-width transform on `strX[idx]`.
pub const OPCODE_ZENTOHAN: u16 = 0x0012;

/// Stable enum naming the `module_str` opcodes implements.
/// Used by audit tooling to assert the registry covers every variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum StrOpcode {
    /// `strcpy` — copy.
    Strcpy,
    /// `strcat` — concatenate.
    Strcat,
    /// `strlen` — byte length.
    Strlen,
    /// `strout` — sink emission.
    Strout,
    /// `intout` — sink emission of an integer's decimal form.
    Intout,
    /// `Uppercase` — ASCII upper-case.
    Uppercase,
    /// `Lowercase` — ASCII lower-case.
    Lowercase,
    /// `itoa` — int → decimal-ASCII into a string slot.
    Itoa,
    /// `atoi` — decimal-ASCII string → int.
    Atoi,
    /// `strpos` — first byte position of needle.
    Strpos,
    /// `strlpos` — last byte position of needle.
    Strlpos,
    /// `hantozen` — half-width → full-width.
    Hantozen,
    /// `zentohan` — full-width → half-width.
    Zentohan,
}

impl StrOpcode {
    /// All `module_str` opcodes ships. The registry covers
    /// exactly this list.
    pub const ALL: &'static [StrOpcode] = &[
        Self::Strcpy,
        Self::Strcat,
        Self::Strlen,
        Self::Strout,
        Self::Intout,
        Self::Uppercase,
        Self::Lowercase,
        Self::Itoa,
        Self::Atoi,
        Self::Strpos,
        Self::Strlpos,
        Self::Hantozen,
        Self::Zentohan,
    ];

    /// Numeric opcode byte for this variant.
    pub fn opcode(self) -> u16 {
        match self {
            Self::Strcpy => OPCODE_STRCPY,
            Self::Strcat => OPCODE_STRCAT,
            Self::Strlen => OPCODE_STRLEN,
            Self::Strout => OPCODE_STROUT,
            Self::Intout => OPCODE_INTOUT,
            Self::Uppercase => OPCODE_UPPERCASE,
            Self::Lowercase => OPCODE_LOWERCASE,
            Self::Itoa => OPCODE_ITOA,
            Self::Atoi => OPCODE_ATOI,
            Self::Strpos => OPCODE_STRPOS,
            Self::Strlpos => OPCODE_STRLPOS,
            Self::Hantozen => OPCODE_HANTOZEN,
            Self::Zentohan => OPCODE_ZENTOHAN,
        }
    }

    /// Composite registry key the VM uses to dispatch this op.
    pub fn rlop_key(self) -> RlopKey {
        RlopKey::new(STR_MODULE_TYPE, STR_MODULE_ID, self.opcode())
    }

    /// Stable lowercase tag used by [`VmWarning::RlopArgsInvalid::op`].
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Strcpy => "str.strcpy",
            Self::Strcat => "str.strcat",
            Self::Strlen => "str.strlen",
            Self::Strout => "str.strout",
            Self::Intout => "str.intout",
            Self::Uppercase => "str.uppercase",
            Self::Lowercase => "str.lowercase",
            Self::Itoa => "str.itoa",
            Self::Atoi => "str.atoi",
            Self::Strpos => "str.strpos",
            Self::Strlpos => "str.strlpos",
            Self::Hantozen => "str.hantozen",
            Self::Zentohan => "str.zentohan",
        }
    }
}

/// Number of opcodes [`register_str_rlops`] mounts. Pinned so audit
/// tooling can assert the registry covers exactly the
/// surface without walking the helper body.
pub const STR_RLOP_COUNT: usize = StrOpcode::ALL.len();

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

// Tests

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use utsushi_core::substrate::{SinkCapability, SinkResult};

    use super::*;
    use crate::expression::BANK_BYTE_INT_A;

    /// Bank byte for `strS`.
    const BANK_BYTE_STR_S: u8 = 0x12;
    /// Bank byte for `strM`.
    const BANK_BYTE_STR_M: u8 = 0x0D;

    fn int_arg(value: i32) -> ExprValue {
        ExprValue::Int(value)
    }

    fn bytes_arg(value: &[u8]) -> ExprValue {
        ExprValue::Bytes(value.to_vec())
    }

    fn str_ref(bank_byte: u8, idx: u16) -> Vec<ExprValue> {
        vec![int_arg(bank_byte as i32), int_arg(idx as i32)]
    }

    fn int_ref(bank_byte: u8, idx: u16) -> Vec<ExprValue> {
        vec![int_arg(bank_byte as i32), int_arg(idx as i32)]
    }

    /// Concatenate the argument vectors. Convenience for assembling
    /// the `(dst_ref, src_ref…)` arg lists the table-style tests use.
    fn args(parts: Vec<Vec<ExprValue>>) -> Vec<ExprValue> {
        let mut out = Vec::new();
        for part in parts {
            out.extend(part);
        }
        out
    }

    #[derive(Default)]
    struct CollectingSink {
        lines: Mutex<Vec<TextLine>>,
    }

    impl TextSurfaceSink for CollectingSink {
        fn capability(&self) -> SinkCapability {
            SinkCapability::Supported {
                evidence_tier_ceiling: EvidenceTier::E1,
            }
        }

        fn emit_line(&self, line: TextLine) -> SinkResult<()> {
            line.validate()?;
            self.lines.lock().expect("lock").push(line);
            Ok(())
        }
    }

    fn make_runtime() -> (Arc<StrRuntime>, Arc<CollectingSink>) {
        let sink = Arc::new(CollectingSink::default());
        let runtime = Arc::new(StrRuntime::new(
            Arc::clone(&sink) as Arc<dyn TextSurfaceSink>
        ));
        (runtime, sink)
    }

    fn run<R: RLOperation>(op: &R, args: &[ExprValue]) -> Vm {
        let mut vm = Vm::new(1, 0);
        op.dispatch(&mut vm, args);
        vm
    }

    fn read_str(vm: &Vm, bank: BankId, idx: u16) -> Vec<u8> {
        match vm.banks().get(bank, idx) {
            Some(Value::Str(bytes)) => bytes,
            _ => Vec::new(),
        }
    }

    fn read_int(vm: &Vm, bank: BankId, idx: u16) -> i32 {
        match vm.banks().get(bank, idx) {
            Some(Value::Int(value)) => value,
            _ => 0,
        }
    }

    // Acceptance: register_helper covers exactly STR_RLOP_COUNT opcodes

    #[test]
    fn str_register_helper_populates_expected_count() {
        let (runtime, _sink) = make_runtime();
        let mut registry = RlopRegistry::new();
        let count = register_str_rlops(&mut registry, runtime);
        assert_eq!(count, STR_RLOP_COUNT);
        assert_eq!(registry.len(), STR_RLOP_COUNT);
        for op in StrOpcode::ALL {
            assert!(registry.get(op.rlop_key()).is_some(), "{op:?} must resolve",);
        }
    }

    #[test]
    fn str_opcode_byte_values_are_distinct() {
        let mut seen = std::collections::HashSet::new();
        for op in StrOpcode::ALL {
            assert!(seen.insert(op.opcode()), "duplicate opcode for {op:?}");
        }
    }

    // Acceptance: `str_ops_table` — input/output table for each op
    // with ≥3 cases including a boundary.

    #[test]
    fn str_ops_table_strcpy_three_cases() {
        // Case 1: literal-bytes source → dst slot holds the bytes.
        let mut vm = Vm::new(1, 0);
        StrcpyOp.dispatch(
            &mut vm,
            &args(vec![str_ref(BANK_BYTE_STR_S, 0), vec![bytes_arg(b"hi")]]),
        );
        assert_eq!(read_str(&vm, BankId::StrS, 0), b"hi".to_vec());
        // Case 2: bank-source → dst.
        vm.banks_mut()
            .set(BankId::StrS, 5, Value::Str(b"there".to_vec()))
            .expect("seed");
        StrcpyOp.dispatch(
            &mut vm,
            &args(vec![
                str_ref(BANK_BYTE_STR_M, 0),
                str_ref(BANK_BYTE_STR_S, 5),
            ]),
        );
        assert_eq!(read_str(&vm, BankId::StrM, 0), b"there".to_vec());
        // Boundary: empty-string copy.
        StrcpyOp.dispatch(
            &mut vm,
            &args(vec![str_ref(BANK_BYTE_STR_S, 1), vec![bytes_arg(b"")]]),
        );
        assert_eq!(read_str(&vm, BankId::StrS, 1), Vec::<u8>::new());
    }

    #[test]
    fn str_ops_table_strcat_three_cases() {
        // Case 1: empty dst + new bytes → new bytes.
        let mut vm = Vm::new(1, 0);
        StrcatOp.dispatch(
            &mut vm,
            &args(vec![str_ref(BANK_BYTE_STR_S, 0), vec![bytes_arg(b"abc")]]),
        );
        assert_eq!(read_str(&vm, BankId::StrS, 0), b"abc".to_vec());
        // Case 2: existing dst + new bytes → concat.
        StrcatOp.dispatch(
            &mut vm,
            &args(vec![str_ref(BANK_BYTE_STR_S, 0), vec![bytes_arg(b"def")]]),
        );
        assert_eq!(read_str(&vm, BankId::StrS, 0), b"abcdef".to_vec());
        // Boundary: append empty → no change.
        StrcatOp.dispatch(
            &mut vm,
            &args(vec![str_ref(BANK_BYTE_STR_S, 0), vec![bytes_arg(b"")]]),
        );
        assert_eq!(read_str(&vm, BankId::StrS, 0), b"abcdef".to_vec());
    }

    #[test]
    fn str_ops_table_strlen_three_cases() {
        let mut vm = Vm::new(1, 0);
        // Case 1: non-empty.
        StrlenOp.dispatch(
            &mut vm,
            &args(vec![int_ref(BANK_BYTE_INT_A, 0), vec![bytes_arg(b"abc")]]),
        );
        assert_eq!(read_int(&vm, BankId::IntA, 0), 3);
        // Case 2: shift-jis pair.
        StrlenOp.dispatch(
            &mut vm,
            &args(vec![
                int_ref(BANK_BYTE_INT_A, 1),
                vec![bytes_arg(&[0x82, 0xa0])],
            ]),
        );
        assert_eq!(read_int(&vm, BankId::IntA, 1), 2);
        // Boundary: empty.
        StrlenOp.dispatch(
            &mut vm,
            &args(vec![int_ref(BANK_BYTE_INT_A, 2), vec![bytes_arg(b"")]]),
        );
        assert_eq!(read_int(&vm, BankId::IntA, 2), 0);
    }

    #[test]
    fn str_ops_table_strout_emits_three_cases_through_sink() {
        let (runtime, sink) = make_runtime();
        let op = StroutOp::new(runtime);
        // Case 1: literal ASCII.
        let _ = run(&op, &[bytes_arg(b"hello")]);
        // Case 2: literal shift-jis あ.
        let _ = run(&op, &[bytes_arg(&[0x82, 0xa0])]);
        // Boundary: empty.
        let _ = run(&op, &[bytes_arg(b"")]);
        let lines = sink.lines.lock().expect("lock");
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].text, "hello");
        assert_eq!(lines[1].text, "\u{3042}");
        assert_eq!(lines[2].text, "");
        for line in &*lines {
            assert_eq!(line.text_surface.as_deref(), Some("strout"));
        }
    }

    #[test]
    fn str_ops_table_intout_emits_three_cases_through_sink() {
        let (runtime, sink) = make_runtime();
        let op = IntoutOp::new(runtime);
        // Case 1: positive.
        let _ = run(&op, &[int_arg(42)]);
        // Case 2: negative.
        let _ = run(&op, &[int_arg(-7)]);
        // Boundary: i32::MIN.
        let _ = run(&op, &[int_arg(i32::MIN)]);
        let lines = sink.lines.lock().expect("lock");
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].text, "42");
        assert_eq!(lines[1].text, "-7");
        assert_eq!(lines[2].text, "-2147483648");
    }

    #[test]
    fn str_ops_table_uppercase_three_cases_including_fullwidth_pass_through() {
        let mut vm = Vm::new(1, 0);
        // Case 1: ASCII lower.
        vm.banks_mut()
            .set(BankId::StrS, 0, Value::Str(b"abc".to_vec()))
            .expect("seed");
        UppercaseOp.dispatch(&mut vm, &str_ref(BANK_BYTE_STR_S, 0));
        assert_eq!(read_str(&vm, BankId::StrS, 0), b"ABC".to_vec());
        // Case 2: mixed.
        vm.banks_mut()
            .set(BankId::StrS, 1, Value::Str(b"AbCd1!".to_vec()))
            .expect("seed");
        UppercaseOp.dispatch(&mut vm, &str_ref(BANK_BYTE_STR_S, 1));
        assert_eq!(read_str(&vm, BankId::StrS, 1), b"ABCD1!".to_vec());
        // Boundary: full-width 'Ａ' (0x82 0x60) stays unchanged — RLDEV
        // acceptance criterion in the spec: `Uppercase("ＡＢＣ")`
        // returns `"ＡＢＣ"` (already upper-case shape).
        let fullwidth_abc = vec![0x82, 0x60, 0x82, 0x61, 0x82, 0x62];
        vm.banks_mut()
            .set(BankId::StrS, 2, Value::Str(fullwidth_abc.clone()))
            .expect("seed");
        UppercaseOp.dispatch(&mut vm, &str_ref(BANK_BYTE_STR_S, 2));
        assert_eq!(read_str(&vm, BankId::StrS, 2), fullwidth_abc);
    }

    #[test]
    fn str_ops_table_lowercase_three_cases() {
        let mut vm = Vm::new(1, 0);
        vm.banks_mut()
            .set(BankId::StrS, 0, Value::Str(b"ABC".to_vec()))
            .expect("seed");
        LowercaseOp.dispatch(&mut vm, &str_ref(BANK_BYTE_STR_S, 0));
        assert_eq!(read_str(&vm, BankId::StrS, 0), b"abc".to_vec());
        vm.banks_mut()
            .set(BankId::StrS, 1, Value::Str(b"AbCd1!".to_vec()))
            .expect("seed");
        LowercaseOp.dispatch(&mut vm, &str_ref(BANK_BYTE_STR_S, 1));
        assert_eq!(read_str(&vm, BankId::StrS, 1), b"abcd1!".to_vec());
        // Boundary: empty.
        LowercaseOp.dispatch(&mut vm, &str_ref(BANK_BYTE_STR_S, 2));
        assert_eq!(read_str(&vm, BankId::StrS, 2), Vec::<u8>::new());
    }

    #[test]
    fn str_ops_table_itoa_three_cases() {
        let mut vm = Vm::new(1, 0);
        // Case 1: positive literal.
        ItoaOp.dispatch(
            &mut vm,
            &args(vec![str_ref(BANK_BYTE_STR_S, 0), vec![int_arg(42)]]),
        );
        assert_eq!(read_str(&vm, BankId::StrS, 0), b"42".to_vec());
        // Case 2: negative literal.
        ItoaOp.dispatch(
            &mut vm,
            &args(vec![str_ref(BANK_BYTE_STR_S, 1), vec![int_arg(-7)]]),
        );
        assert_eq!(read_str(&vm, BankId::StrS, 1), b"-7".to_vec());
        // Boundary: zero.
        ItoaOp.dispatch(
            &mut vm,
            &args(vec![str_ref(BANK_BYTE_STR_S, 2), vec![int_arg(0)]]),
        );
        assert_eq!(read_str(&vm, BankId::StrS, 2), b"0".to_vec());
    }

    #[test]
    fn str_ops_table_atoi_three_cases() {
        let mut vm = Vm::new(1, 0);
        AtoiOp.dispatch(
            &mut vm,
            &args(vec![int_ref(BANK_BYTE_INT_A, 0), vec![bytes_arg(b"42")]]),
        );
        assert_eq!(read_int(&vm, BankId::IntA, 0), 42);
        AtoiOp.dispatch(
            &mut vm,
            &args(vec![int_ref(BANK_BYTE_INT_A, 1), vec![bytes_arg(b"-7abc")]]),
        );
        assert_eq!(read_int(&vm, BankId::IntA, 1), -7);
        // Boundary: empty → 0.
        AtoiOp.dispatch(
            &mut vm,
            &args(vec![int_ref(BANK_BYTE_INT_A, 2), vec![bytes_arg(b"")]]),
        );
        assert_eq!(read_int(&vm, BankId::IntA, 2), 0);
    }

    #[test]
    fn str_ops_table_strpos_three_cases() {
        let mut vm = Vm::new(1, 0);
        // Case 1: hit.
        StrposOp.dispatch(
            &mut vm,
            &args(vec![
                int_ref(BANK_BYTE_INT_A, 0),
                vec![bytes_arg(b"foobar"), bytes_arg(b"bar")],
            ]),
        );
        assert_eq!(read_int(&vm, BankId::IntA, 0), 3);
        // Case 2: miss → -1.
        StrposOp.dispatch(
            &mut vm,
            &args(vec![
                int_ref(BANK_BYTE_INT_A, 1),
                vec![bytes_arg(b"foobar"), bytes_arg(b"zzz")],
            ]),
        );
        assert_eq!(read_int(&vm, BankId::IntA, 1), -1);
        // Boundary: empty needle → 0.
        StrposOp.dispatch(
            &mut vm,
            &args(vec![
                int_ref(BANK_BYTE_INT_A, 2),
                vec![bytes_arg(b"foobar"), bytes_arg(b"")],
            ]),
        );
        assert_eq!(read_int(&vm, BankId::IntA, 2), 0);
    }

    #[test]
    fn str_ops_table_strlpos_three_cases() {
        let mut vm = Vm::new(1, 0);
        // Case 1: hit (last 'b').
        StrlposOp.dispatch(
            &mut vm,
            &args(vec![
                int_ref(BANK_BYTE_INT_A, 0),
                vec![bytes_arg(b"abcabc"), bytes_arg(b"bc")],
            ]),
        );
        assert_eq!(read_int(&vm, BankId::IntA, 0), 4);
        // Case 2: miss → -1.
        StrlposOp.dispatch(
            &mut vm,
            &args(vec![
                int_ref(BANK_BYTE_INT_A, 1),
                vec![bytes_arg(b"abcabc"), bytes_arg(b"zzz")],
            ]),
        );
        assert_eq!(read_int(&vm, BankId::IntA, 1), -1);
        // Boundary: needle longer than haystack → -1.
        StrlposOp.dispatch(
            &mut vm,
            &args(vec![
                int_ref(BANK_BYTE_INT_A, 2),
                vec![bytes_arg(b"ab"), bytes_arg(b"abcd")],
            ]),
        );
        assert_eq!(read_int(&vm, BankId::IntA, 2), -1);
    }

    #[test]
    fn str_ops_table_hantozen_three_cases() {
        let mut vm = Vm::new(1, 0);
        // Case 1: RLDEV acceptance — hantozen("abc") = "ａｂｃ".
        vm.banks_mut()
            .set(BankId::StrS, 0, Value::Str(b"abc".to_vec()))
            .expect("seed");
        HantozenOp.dispatch(&mut vm, &str_ref(BANK_BYTE_STR_S, 0));
        assert_eq!(
            read_str(&vm, BankId::StrS, 0),
            vec![0x82, 0x81, 0x82, 0x82, 0x82, 0x83],
        );
        // Case 2: ASCII digits → fullwidth digits.
        vm.banks_mut()
            .set(BankId::StrS, 1, Value::Str(b"123".to_vec()))
            .expect("seed");
        HantozenOp.dispatch(&mut vm, &str_ref(BANK_BYTE_STR_S, 1));
        assert_eq!(
            read_str(&vm, BankId::StrS, 1),
            vec![0x82, 0x50, 0x82, 0x51, 0x82, 0x52],
        );
        // Boundary: half-width katakana survives the round trip.
        vm.banks_mut()
            .set(BankId::StrS, 2, Value::Str(vec![0xB1]))
            .expect("seed");
        HantozenOp.dispatch(&mut vm, &str_ref(BANK_BYTE_STR_S, 2));
        assert_eq!(read_str(&vm, BankId::StrS, 2), vec![0x83, 0x41]);
    }

    #[test]
    fn str_ops_table_zentohan_three_cases() {
        let mut vm = Vm::new(1, 0);
        // Case 1: fullwidth "ａｂｃ" → "abc".
        vm.banks_mut()
            .set(
                BankId::StrS,
                0,
                Value::Str(vec![0x82, 0x81, 0x82, 0x82, 0x82, 0x83]),
            )
            .expect("seed");
        ZentohanOp.dispatch(&mut vm, &str_ref(BANK_BYTE_STR_S, 0));
        assert_eq!(read_str(&vm, BankId::StrS, 0), b"abc".to_vec());
        // Case 2: fullwidth digits → ASCII digits.
        vm.banks_mut()
            .set(
                BankId::StrS,
                1,
                Value::Str(vec![0x82, 0x50, 0x82, 0x51, 0x82, 0x52]),
            )
            .expect("seed");
        ZentohanOp.dispatch(&mut vm, &str_ref(BANK_BYTE_STR_S, 1));
        assert_eq!(read_str(&vm, BankId::StrS, 1), b"123".to_vec());
        // Boundary: fullwidth katakana → halfwidth.
        vm.banks_mut()
            .set(BankId::StrS, 2, Value::Str(vec![0x83, 0x41]))
            .expect("seed");
        ZentohanOp.dispatch(&mut vm, &str_ref(BANK_BYTE_STR_S, 2));
        assert_eq!(read_str(&vm, BankId::StrS, 2), vec![0xB1]);
    }

    #[test]
    fn hantozen_half_width_katakana_round_trips() {
        // RLDEV pin: every half-width katakana byte 0xA1..=0xDF must
        // hantozen → full-width AND zentohan back to the same byte.
        for byte in 0xA1u8..=0xDFu8 {
            let folded = hantozen_bytes(&[byte]);
            assert_eq!(
                folded.len(),
                2,
                "0x{byte:02x} must land on a 2-byte full-width form",
            );
            let restored = zentohan_bytes(&folded);
            assert_eq!(
                restored,
                vec![byte],
                "0x{byte:02x} did not round-trip through hantozen/zentohan",
            );
        }
    }

    // Argument validation surfaces — warnings, not panics.

    #[test]
    fn strcpy_with_missing_dst_warns() {
        let mut vm = Vm::new(1, 0);
        StrcpyOp.dispatch(&mut vm, &[]);
        let warnings = vm.take_warnings();
        assert_eq!(warnings.len(), 1);
        assert!(matches!(
            warnings[0],
            VmWarning::RlopArgsInvalid {
                op: "str.strcpy",
                ..
            }
        ));
    }

    #[test]
    fn strcpy_into_int_bank_warns() {
        let mut vm = Vm::new(1, 0);
        StrcpyOp.dispatch(
            &mut vm,
            &args(vec![int_ref(BANK_BYTE_INT_A, 0), vec![bytes_arg(b"x")]]),
        );
        let warnings = vm.take_warnings();
        assert_eq!(warnings.len(), 1);
    }
}
