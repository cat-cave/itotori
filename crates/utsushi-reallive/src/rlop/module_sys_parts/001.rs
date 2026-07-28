use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use utsushi_core::clock::LogicalClockTick;
use utsushi_core::substrate::{
    Inspectable, Restorable, RestoreReport, SnapshotError, StatePath, StateTree, StateValue,
};

use super::{DispatchOutcome, ExprValue, RLOperation, RlopKey, RlopRegistry};
use crate::vm::{Vm, VmWarning};
use trig::{cos256, sin256};
use arith_ext::SlopeOp;

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
/// `modulus` opcode (`sys (1,4,1005)`) — integer slope
/// `(v1-v3)/(v2-v4)`. First registered in the `1000`-block only.
pub const OPCODE_MODULUS: u16 = 1005;
/// `angle` opcode (`sys (1,4,1006)`). rlvm's `angle` handler shares the
/// exact `modulus` body (`module_sys.cc:199-206`), so we mirror the
/// oracle: `store:= (v1-v3)/(v2-v4)`.
pub const OPCODE_ANGLE: u16 = 1006;

/// The arithmetic ops are also registered at a second opcode number in
/// the `1000`-block (`AddOpcode(1000, "rnd")` … `AddOpcode(1010, "cos")`
/// in `module_sys.cc:437-451`). RealLive bytecode calls the arithmetic
/// family through EITHER opcode range, so a runtime that only mounts the
/// low range reads the `1000`-block calls as unknown opcodes. Each entry
/// maps an already-implemented [`SysOpcode`] to its `1000`-block alias.
/// `modulus`/`angle` are absent here — they exist ONLY in the
/// `1000`-block, so they are primary [`SysOpcode`] variants at
/// [`OPCODE_MODULUS`]/[`OPCODE_ANGLE`] instead.
const ARITH_ALIASES: &[(SysOpcode, u16)] = &[
    (SysOpcode::Rnd, 1000),
    (SysOpcode::Pcnt, 1001),
    (SysOpcode::Abs, 1002),
    (SysOpcode::Power, 1003),
    (SysOpcode::Sin, 1004),
    (SysOpcode::Min, 1007),
    (SysOpcode::Max, 1008),
    (SysOpcode::Constrain, 1009),
    (SysOpcode::Cos, 1010),
];

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
    /// `modulus` — integer slope `(v1-v3)/(v2-v4)`.
    Modulus,
    /// `angle` — mirrors the `modulus` body per the rlvm oracle.
    Angle,
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
        Self::Modulus,
        Self::Angle,
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
            Self::Modulus => OPCODE_MODULUS,
            Self::Angle => OPCODE_ANGLE,
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
            Self::Modulus => "sys.modulus",
            Self::Angle => "sys.angle",
        }
    }
}

pub const SYS_RLOP_COUNT: usize =
    (SysOpcode::ALL.len() + ARITH_ALIASES.len()) * LATTICE_TYPES.len();

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
