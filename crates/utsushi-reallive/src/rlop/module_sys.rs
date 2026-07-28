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

#[path = "module_sys_trig.rs"]
mod trig;

#[path = "module_sys_arith_ext.rs"]
mod arith_ext; // Tests

#[cfg(test)]
#[path = "module_sys_tests.rs"]
mod tests;
include!("module_sys_parts/001.rs");
include!("module_sys_parts/002.rs");
