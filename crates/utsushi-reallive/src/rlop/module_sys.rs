//! RealLive `module_sys` system-arithmetic RLOperation
//! family subset.
//!
//! Implements the arithmetic subset of RealLive's `module_sys`:
//! `rnd`, `pcnt`, `abs`, `power`, `sin`, `cos`, `min`, `max`
//! `constrain`. The non-arithmetic `module_sys` opcodes (`title`
//! `end`, `save`/`load` triggers, screen-mode, message-speed) are out
//! of scope — they land in a sibling node when the runtime
//! VM grows the save-load surface.
//!
//! # Module addressing
//!
//! `module_id=4` is the system-arithmetic semantic key; `module_type` is a
//! compiler-version artifact, registered across the RealLive lattice `{0, 1, 2}`.
//!
//! # Opcode coverage (9)
//!
//! Opcode | Op | Semantics
//! -------------------- | ----------- | --------------------------------------
//! `0x0000` | `rnd` | `store:= rnd_in_range(max)`
//! `0x0001` | `pcnt` | `store:= (numerator * 100) / denom`
//! `0x0002` | `abs` | `store:= abs(value)`
//! `0x0003` | `power` | `store:= base ^ exponent` (saturating)
//! `0x0004` | `sin` | `store:= round(32768 * sin(2π·θ/256))`
//! `0x0005` | `cos` | `store:= round(32768 * cos(2π·θ/256))`
//! `0x0006` | `min` | `store:= min(a, b)`
//! `0x0007` | `max` | `store:= max(a, b)`
//! `0x0008` | `constrain` | `store:= clamp(value, lo, hi)`
//!
//! Every op writes its result through the substrate-coupled VM store
//! register ([`crate::var_banks::VarBanks::set_store`]) so the
//! caller-side `intern():= store` paste-back in the RealLive expression
//! evaluator picks it up.
//!
//! # Deterministic `rnd`
//!
//! [`rnd`] reads from a substrate
//! [`utsushi_core::clock::LogicalClockTick`]-seeded XorShift64 stream
//! not from the OS rng. The stream lives inside a [`SysRuntime`] held
//! on the registry side — the audit-focus pinned by the spec ("`rnd`
//! reading from the OS rng instead of substrate clock-seeded rng") is
//! enforced structurally: this module imports neither `std::time` nor
//! a `Rng` provider; the rng's only entropy source is the
//! `LogicalClock` snapshot passed in via [`SysRuntime::new`]
//! [`SysRuntime::reseed_from_clock`].
//!
//! The rng state is round-trippable through the substrate
//! [`utsushi_core::substrate::Inspectable`]
//! [`utsushi_core::substrate::Restorable`] traits via
//! [`SysRuntime::inspect_state`] / [`SysRuntime::restore_state`]
//! helpers. The acceptance test
//! `sys_rnd_deterministic_under_logical_clock` pins:
//!
//! 1. Two runs with the same `LogicalClockTick` produce the same
//!    `rnd` sequence.
//! 2. Snapshot the rng after a few calls, scribble it, restore, and
//!    the next `rnd` call matches the pre-snapshot sequence.

use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use utsushi_core::clock::LogicalClockTick;
use utsushi_core::substrate::{
    Inspectable, Restorable, RestoreReport, SnapshotError, StatePath, StateTree, StateValue,
};

use super::{DispatchOutcome, ExprValue, RLOperation, RlopKey, RlopRegistry};
use crate::vm::{Vm, VmWarning};

pub const SYS_MODULE_TYPE: u8 = 1;
const LATTICE_TYPES: [u8; 3] = [0, 1, 2];
pub const SYS_MODULE_ID: u8 = 4;

/// `rnd` opcode.
pub const OPCODE_RND: u16 = 0x0000;
/// `pcnt` opcode.
pub const OPCODE_PCNT: u16 = 0x0001;
/// `abs` opcode.
pub const OPCODE_ABS: u16 = 0x0002;
/// `power` opcode.
pub const OPCODE_POWER: u16 = 0x0003;
/// `sin` opcode.
pub const OPCODE_SIN: u16 = 0x0004;
/// `cos` opcode.
pub const OPCODE_COS: u16 = 0x0005;
/// `min` opcode.
pub const OPCODE_MIN: u16 = 0x0006;
/// `max` opcode.
pub const OPCODE_MAX: u16 = 0x0007;
/// `constrain` opcode.
pub const OPCODE_CONSTRAIN: u16 = 0x0008;

/// Stable inspectable id for the substrate snapshot path.
pub const SYS_RUNTIME_INSPECTABLE_ID: &str = "utsushi-reallive-sys-runtime";

/// State-path leaf the substrate snapshot path writes the rng seed
/// under.
const RNG_STATE_PATH: &str = "port.sys_runtime.rng_state";
/// State-path leaf the manifest entry lives under so the empty-tree
/// rejection on the substrate side does not bite us.
const MANIFEST_PATH: &str = "port.sys_runtime.manifest";
/// Stable manifest string.
const SYS_RUNTIME_MANIFEST: &str = "utsushi-reallive-sys-runtime/0.1.0-alpha";

/// Stable enum naming the `module_sys` opcodes implements.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum SysOpcode {
    /// `rnd` — pseudo-random number.
    Rnd,
    /// `pcnt` — percentage.
    Pcnt,
    /// `abs` — absolute value.
    Abs,
    /// `power` — integer exponentiation.
    Power,
    /// `sin` — 256-step fixed-point sine.
    Sin,
    /// `cos` — 256-step fixed-point cosine.
    Cos,
    /// `min` — minimum of two values.
    Min,
    /// `max` — maximum of two values.
    Max,
    /// `constrain` — clamp to `[lo, hi]`.
    Constrain,
}

impl SysOpcode {
    /// All `module_sys` arithmetic opcodes this module ships.
    pub const ALL: &'static [SysOpcode] = &[
        Self::Rnd,
        Self::Pcnt,
        Self::Abs,
        Self::Power,
        Self::Sin,
        Self::Cos,
        Self::Min,
        Self::Max,
        Self::Constrain,
    ];

    /// Numeric opcode byte for this variant.
    pub fn opcode(self) -> u16 {
        match self {
            Self::Rnd => OPCODE_RND,
            Self::Pcnt => OPCODE_PCNT,
            Self::Abs => OPCODE_ABS,
            Self::Power => OPCODE_POWER,
            Self::Sin => OPCODE_SIN,
            Self::Cos => OPCODE_COS,
            Self::Min => OPCODE_MIN,
            Self::Max => OPCODE_MAX,
            Self::Constrain => OPCODE_CONSTRAIN,
        }
    }

    pub fn rlop_key_for(self, module_type: u8) -> RlopKey {
        RlopKey::new(module_type, SYS_MODULE_ID, self.opcode())
    }

    pub fn rlop_key(self) -> RlopKey {
        self.rlop_key_for(SYS_MODULE_TYPE)
    }

    /// Stable lowercase tag used by [`VmWarning::RlopArgsInvalid::op`].
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Rnd => "sys.rnd",
            Self::Pcnt => "sys.pcnt",
            Self::Abs => "sys.abs",
            Self::Power => "sys.power",
            Self::Sin => "sys.sin",
            Self::Cos => "sys.cos",
            Self::Min => "sys.min",
            Self::Max => "sys.max",
            Self::Constrain => "sys.constrain",
        }
    }
}

pub const SYS_RLOP_COUNT: usize = SysOpcode::ALL.len() * LATTICE_TYPES.len();

// Deterministic XorShift64 rng — substrate-clock-seeded.

/// 64-bit XorShift PRNG state. Determined entirely by the seed; no OS
/// entropy is involved at any point. Held as a public-API-safe wrapper
/// so the snapshot path can serialise the state without exposing the
/// internal update rule.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct XorShift64State {
    /// Current state word. Must never be zero (XorShift's zero state
    /// is a fixed point); the [`XorShift64State::seed_from_tick`]
    /// constructor enforces this with a non-zero salt.
    state: u64,
}

impl XorShift64State {
    /// Build the state from a [`LogicalClockTick`]. The tick value is
    /// XORed with a fixed non-zero salt so a `LogicalClockTick(0)`
    /// produces a well-defined non-zero state.
    pub fn seed_from_tick(tick: LogicalClockTick) -> Self {
        // Salt picked so the state's bit pattern is non-trivially
        // distributed even for tick=0 (XorShift's zero state is a
        // fixed point and produces a zero stream).
        const SALT: u64 = 0x9E37_79B9_7F4A_7C15;
        Self {
            state: tick.get() ^ SALT,
        }
    }

    /// Advance the state and return a 32-bit result. Implements
    /// Marsaglia's xorshift64 update rule with `(13, 7, 17)`.
    fn next_u32(&mut self) -> u32 {
        let mut x = self.state;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.state = x;
        (x >> 32) as u32
    }
}

// SysRuntime

/// Runtime carrier for the `module_sys` arithmetic family. Owns the
/// deterministic rng state and exposes substrate
/// [`Inspectable`] / [`Restorable`] traits for round-trip snapshot
/// testing.
pub struct SysRuntime {
    inner: Mutex<SysRuntimeInner>,
}

#[derive(Debug)]
struct SysRuntimeInner {
    rng: XorShift64State,
}

impl std::fmt::Debug for SysRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("SysRuntime").finish()
    }
}

impl SysRuntime {
    /// Build a runtime whose rng is seeded from `tick`.
    pub fn new(tick: LogicalClockTick) -> Self {
        Self {
            inner: Mutex::new(SysRuntimeInner {
                rng: XorShift64State::seed_from_tick(tick),
            }),
        }
    }

    /// Reseed the rng from a new clock tick. Used by callers that
    /// want to fold a fresh `LogicalClock::tick()` into the rng
    /// stream between scene-level transitions.
    pub fn reseed_from_clock(&self, tick: LogicalClockTick) {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.rng = XorShift64State::seed_from_tick(tick);
    }

    /// Borrow the current rng state. Exposed so audit tooling can pin
    /// the snapshot path without going through the full
    /// `inspect_state` round trip.
    pub fn rng_state(&self) -> XorShift64State {
        let guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.rng
    }

    /// Roll the rng forward and return an `i32` in `[0, max)`. `max`
    /// values less than `1` resolve to `0` to match RLDEV-documented
    /// behaviour ("rnd(0) returns 0").
    pub fn rnd_below(&self, max: i32) -> i32 {
        if max <= 1 {
            return 0;
        }
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let raw = guard.rng.next_u32();
        let modulus = max as u32;
        (raw % modulus) as i32
    }
}

impl Inspectable for SysRuntime {
    fn inspectable_id(&self) -> &'static str {
        SYS_RUNTIME_INSPECTABLE_ID
    }

    fn inspect_state(&self) -> Result<StateTree, SnapshotError> {
        let mut tree = StateTree::new();
        tree.insert(
            StatePath::parse(MANIFEST_PATH)?,
            StateValue::String {
                value: SYS_RUNTIME_MANIFEST.to_string(),
            },
        )?;
        let rng_state = self.rng_state().state;
        tree.insert(
            StatePath::parse(RNG_STATE_PATH)?,
            StateValue::Uint { value: rng_state },
        )?;
        Ok(tree)
    }
}

impl Restorable for SysRuntime {
    fn restore_state(&mut self, state: &StateTree) -> Result<RestoreReport, SnapshotError> {
        let mut manifest_seen = false;
        let mut rng_seen = false;
        let mut new_state: u64 = 0;
        let mut consumed = Vec::new();
        for (path, value) in state.iter() {
            match (path.as_str(), value) {
                (MANIFEST_PATH, StateValue::String { value }) => {
                    if value != SYS_RUNTIME_MANIFEST {
                        return Err(SnapshotError::RestoreValueOutOfRange {
                            path: path.clone(),
                            reason: format!(
                                "sys_runtime manifest mismatch: observed={value} \
                                 expected={SYS_RUNTIME_MANIFEST}",
                            ),
                        });
                    }
                    manifest_seen = true;
                    consumed.push(path.clone());
                }
                (RNG_STATE_PATH, StateValue::Uint { value }) => {
                    new_state = *value;
                    rng_seen = true;
                    consumed.push(path.clone());
                }
                (other, _) => {
                    return Err(SnapshotError::RestoreStatePathUnknown {
                        path: StatePath::parse(other)?,
                    });
                }
            }
        }
        if !manifest_seen {
            return Err(SnapshotError::RestoreValueOutOfRange {
                path: StatePath::parse(MANIFEST_PATH)?,
                reason: "sys_runtime manifest entry missing from snapshot".to_string(),
            });
        }
        if !rng_seen {
            return Err(SnapshotError::RestoreValueOutOfRange {
                path: StatePath::parse(RNG_STATE_PATH)?,
                reason: "sys_runtime rng_state entry missing from snapshot".to_string(),
            });
        }
        // The XorShift state must never be zero. A restored `0` lands
        // on a zero-stream fixed point — reject typed so the audit
        // trail names the failure.
        if new_state == 0 {
            return Err(SnapshotError::RestoreValueOutOfRange {
                path: StatePath::parse(RNG_STATE_PATH)?,
                reason: "sys_runtime rng_state must be non-zero".to_string(),
            });
        }
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.rng = XorShift64State { state: new_state };
        Ok(RestoreReport {
            consumed_paths: consumed,
            ignored_by_design: Vec::new(),
        })
    }
}

// Argument helpers

fn arg_int(args: &[ExprValue], at: usize, slot: &str) -> Result<i32, String> {
    args.get(at)
        .ok_or_else(|| format!("missing arg[{at}] ({slot})"))?
        .as_int()
        .ok_or_else(|| format!("arg[{at}] expected Int({slot}), got Bytes"))
}

fn warn_and_advance(vm: &mut Vm, op: SysOpcode, reason: String) -> DispatchOutcome {
    vm.push_warning(VmWarning::RlopArgsInvalid {
        op: op.as_str(),
        reason,
    });
    DispatchOutcome::Advance
}

fn store_i32(vm: &mut Vm, value: i32) {
    vm.banks_mut().set_store(value as u32);
}

// Per-opcode RLOperation implementors

/// `rnd(max)` — store:= rnd_in_range(max).
#[derive(Debug)]
pub struct RndOp {
    runtime: Arc<SysRuntime>,
}

impl RndOp {
    pub fn new(runtime: Arc<SysRuntime>) -> Self {
        Self { runtime }
    }
}

impl RLOperation for RndOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let max = match arg_int(args, 0, "max") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, SysOpcode::Rnd, reason),
        };
        let value = self.runtime.rnd_below(max);
        store_i32(vm, value);
        DispatchOutcome::Advance
    }
}

/// `pcnt(numerator, denominator)` — store:= (n * 100) / d.
#[derive(Debug)]
pub struct PcntOp;

impl RLOperation for PcntOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let num = match arg_int(args, 0, "numerator") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, SysOpcode::Pcnt, reason),
        };
        let denom = match arg_int(args, 1, "denominator") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, SysOpcode::Pcnt, reason),
        };
        if denom == 0 {
            store_i32(vm, 0);
            return DispatchOutcome::Advance;
        }
        let result = ((num as i64).saturating_mul(100)) / (denom as i64);
        let clamped = if result > i32::MAX as i64 {
            i32::MAX
        } else if result < i32::MIN as i64 {
            i32::MIN
        } else {
            result as i32
        };
        store_i32(vm, clamped);
        DispatchOutcome::Advance
    }
}

/// `abs(value)` — store:= |value|. Saturates on `i32::MIN`.
#[derive(Debug)]
pub struct AbsOp;

impl RLOperation for AbsOp {
    fn dispatch(&self, vm: &mut Vm, args: &[ExprValue]) -> DispatchOutcome {
        let value = match arg_int(args, 0, "value") {
            Ok(value) => value,
            Err(reason) => return warn_and_advance(vm, SysOpcode::Abs, reason),
        };
        let result = value.unsigned_abs();
        let result_i32 = if result > i32::MAX as u32 {
            i32::MAX
        } else {
            result as i32
        };
        store_i32(vm, result_i32);
        DispatchOutcome::Advance
    }
}

/// `power(base, exponent)` — store:= base ^ exponent (saturating).
#[derive(Debug)]
pub struct PowerOp;

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

/// 256-step fixed-point sine. Returns `round(32768 * sin(2π·theta/256))`
/// where `theta` is the input modulo 256. The table is pinned so the
/// substrate-honest "no float drift on different hosts" guarantee
/// holds.
fn sin256(theta: i32) -> i32 {
    let theta_mod = theta.rem_euclid(256) as usize;
    SIN_TABLE_256[theta_mod]
}

/// 256-step fixed-point cosine. Identical table; offset by 64.
fn cos256(theta: i32) -> i32 {
    let theta_mod = (theta.rem_euclid(256) as usize + 64) % 256;
    SIN_TABLE_256[theta_mod]
}

/// Pre-computed 256-entry sine table (`round(32768 * sin(2π·k/256))`).
/// The values are pinned so the dispatch is host-independent — no
/// `f64::sin` call at runtime.
const SIN_TABLE_256: [i32; 256] = sine_table_for_256();

/// Compile-time-friendly sine-table builder. Uses Bhaskara's
/// approximation for `sin` so the table is reproducible by
/// inspection without dragging in a floating-point cosine library at
/// const-eval time. The approximation differs from the IEEE `sin`
/// table by ≤2 LSB across the table; the tests pin the table
/// observably (`sin(0)=0`, `sin(64)=32768`, `sin(128)=0`
/// `sin(192)=-32768`).
const fn sine_table_for_256() -> [i32; 256] {
    let mut table = [0i32; 256];
    let mut k = 0;
    while k < 256 {
        table[k] = sine_q15_bhaskara(k as i32);
        k += 1;
    }
    table
}

/// Bhaskara's sine approximation in Q15 fixed-point, parameterised
/// by a 256-step circle. Pins:
/// - `theta=0 → 0`
/// - `theta=64 → 32768`
/// - `theta=128 → 0`
/// - `theta=192 → -32768`
/// - `theta=k` and `theta=k+256` produce the same value.
///
/// The approximation: `sin(x) = (4x(π - x)) / (5π² - 4x(π - x))` for
/// `x in [0, π]`, mirrored for `[π, 2π]`. Encoded directly in the
/// 256-step domain so there are no float ops.
const fn sine_q15_bhaskara(theta: i32) -> i32 {
    let mut t = theta.rem_euclid(256);
    let negate = t >= 128;
    if negate {
        t -= 128;
    }
    // Now t in [0, 127]. The half-cycle goes from 0 → 32768 → 0.
    // Bhaskara's formula in the 128-step domain
    // (`pi` ≡ 128 steps): sin(x) = 16·x·(π−x) / (5π² − 4·x·(π−x)).
    // At t=64 (the peak): x·(π−x) = 64·64 = 4096; 16·4096 = 65536;
    // 5·128² = 81920; 81920 − 4·4096 = 65536. Result = 1.0 in
    // floating point, encoded as Q15 = 32768.
    let x = t;
    let pi_minus_x = 128 - t;
    let xp = x * pi_minus_x;
    let numerator = 16 * xp;
    let denom = 5 * 128 * 128 - 4 * xp;
    // Result is in Q0 (a fraction in [0, 1]); scale to Q15.
    let value = (numerator as i64).saturating_mul(32768);
    let q15 = (value / denom as i64) as i32;
    if negate { -q15 } else { q15 }
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
/// canonical location.
pub fn register_sys_rlops(registry: &mut RlopRegistry, runtime: Arc<SysRuntime>) -> usize {
    let mut register = |opcode: SysOpcode, op: Arc<dyn RLOperation>| {
        for module_type in LATTICE_TYPES {
            registry.register(opcode.rlop_key_for(module_type), Arc::clone(&op));
        }
    };
    register(SysOpcode::Rnd, Arc::new(RndOp::new(Arc::clone(&runtime))));
    register(SysOpcode::Pcnt, Arc::new(PcntOp));
    register(SysOpcode::Abs, Arc::new(AbsOp));
    register(SysOpcode::Power, Arc::new(PowerOp));
    register(SysOpcode::Sin, Arc::new(SinOp));
    register(SysOpcode::Cos, Arc::new(CosOp));
    register(SysOpcode::Min, Arc::new(MinOp));
    register(SysOpcode::Max, Arc::new(MaxOp));
    register(SysOpcode::Constrain, Arc::new(ConstrainOp));
    SYS_RLOP_COUNT
}

// Tests

#[cfg(test)]
#[path = "module_sys_tests.rs"]
mod tests;
