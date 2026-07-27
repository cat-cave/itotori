//! RealLive `module_sys` timer reset + time-wait opcodes.
//!
//! The executed real-byte path uses the timer family as
//! `ResetTimer(c); …; time(N, c)` — reset a counter, then WAIT until `N`
//! ms elapse. Per the rlvm oracle (`module_sys_timer.cc`) every opcode
//! here is a **void command** (`RLOpcode`, not `RLStoreOpcode`):
//!
//! | Opcode | rlvm name | semantics |
//! | ------ | -------------- | -------------------------------------------- |
//! | 110 | `ResetTimer` | `GetTimer(0,c).Set()` — start counter `c` at 0 |
//! | 111 | `time` | wait until `GetTimer(0,c).Read() > N` |
//! | 112 | `timeC` | as `time`, also breakable by click |
//! | 120 | `ResetExTimer` | `GetTimer(1,c).Set()` — Ex-layer counter |
//! | 121 | `timeEx` | wait until `GetTimer(1,c).Read() > N` |
//! | 122 | `timeExC` | as `timeEx`, also breakable by click |
//!
//! # Why `Advance` is behaviourally exact for the headless drive
//!
//! 1. **The timer VALUE is never read on any executed path.** The reader
//!    opcodes `Timer`/`CmpTimer`/`SetTimer` (114/115/116, 124/125/126)
//!    never appear in the executed-path unknown set, so no branch depends
//!    on a counter's value — `ResetTimer` has no observable effect.
//! 2. **`time(N)`'s wait resolves immediately under the headless
//!    scheduler** (the branch drive advances pauses/waits deterministically
//!    — `HeadlessInputScheduler`), and no animation is bound to the wait,
//!    so a resolved wait and an `Advance` leave identical VM state.
//! 3. **Unknown opcodes are already advanced past** by the driver (the
//!    drive reached its natural terminus WITH these unregistered), and any
//!    timer-polling busy-loop is already handled by the deterministic
//!    spin-detector. Registering them as explicit `Advance` therefore
//!    changes nothing about the drive except removing them from the
//!    unknown set — while matching their real void-command semantics.
//!
//! Real-time wait behaviour (actually blocking `N` ms, and reading back a
//! live counter) is the interactive/render path's surface; the readers are
//! intentionally NOT mounted here because they write `store` and would need
//! a real deterministic timer bank — implementing them as `Advance` would
//! hide a store write, which is exactly the fog we refuse. They land with
//! that bank when a path actually exercises them.

use crate::rlop::module_sys::SYS_MODULE_ID;
use super::{DispatchOutcome, ExprValue, RLOperation, RlopKey, RlopRegistry};
use crate::vm::Vm;
use std::sync::Arc;

/// Compiler-version lattice the sys module is registered across.
const LATTICE_TYPES: [u8; 3] = [0, 1, 2];

/// The reset/time-wait commands this module mounts, as
/// `(opcode, diagnostic tag)`.
const TIMER_COMMANDS: &[(u16, &str)] = &[
    (110, "sys.reset_timer"),
    (111, "sys.time"),
    (112, "sys.time_c"),
    (120, "sys.reset_ex_timer"),
    (121, "sys.time_ex"),
    (122, "sys.time_ex_c"),
];

/// A `module_sys` timer reset or time-wait. Void per the oracle; under the
/// headless drive it neither writes `store` nor transfers control (see the
/// module docs), so it advances past the command.
#[derive(Debug)]
pub struct SysTimerCommand {
    /// Stable diagnostic tag (e.g. `"sys.time"`).
    tag: &'static str,
}

impl SysTimerCommand {
    pub fn new(tag: &'static str) -> Self {
        Self { tag }
    }

    /// The diagnostic tag this command reports under.
    pub fn tag(&self) -> &'static str {
        self.tag
    }
}

impl RLOperation for SysTimerCommand {
    fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        // Void command; timer value never read + wait resolves instantly
        // under the headless scheduler. Advance past it.
        DispatchOutcome::Advance
    }
}

/// Mount every timer reset/time-wait command across the lattice. Returns
/// the number of `(lattice_type, opcode)` registrations made.
pub fn register_sys_timer_rlops(registry: &mut RlopRegistry) -> usize {
    let mut count = 0;
    for &(opcode, tag) in TIMER_COMMANDS {
        let op: Arc<dyn RLOperation> = Arc::new(SysTimerCommand::new(tag));
        for module_type in LATTICE_TYPES {
            registry.register(
                RlopKey::new(module_type, SYS_MODULE_ID, opcode),
                Arc::clone(&op),
            );
            count += 1;
        }
    }
    count
}

/// Number of registrations [`register_sys_timer_rlops`] makes.
pub const SYS_TIMER_RLOP_COUNT: usize = TIMER_COMMANDS.len() * LATTICE_TYPES.len();

#[cfg(test)]
#[path = "module_sys_timer_tests.rs"]
mod tests;
