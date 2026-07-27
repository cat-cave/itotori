//! RealLive `module_sys` MenuReturn — return-to-title control transfer.
//!
//! `sys (1,4,1201)` `MenuReturn` (and `1202` `MenuReturn2`, the same
//! handler) ends the current content flow and returns to the game's title
//! menu. Per the rlvm oracle (`Sys_MenuReturn::operator()`,
//! module_sys.cc:334) it does `machine.LocalReset()` (clearing local
//! memory, the savepoint call stack, and the system) then
//! `machine.Jump(Gameexe("SEEN_MENU"), 0)` — a hard transfer to the title
//! scene — and its `AdvanceInstructionPointer()` returns `false` (it does
//! not fall through to the following bytecode).
//!
//! # Why `Halt` is a deliberate truncation, not a faithful model
//!
//! For the headless content drive, MenuReturn is a **terminal content
//! boundary**: once the game returns to the title menu, there is no more
//! content to drive — the title menu is a separate interactive loop, out
//! of scope for a content-scene drive. We therefore model MenuReturn as
//! [`DispatchOutcome::Halt`], which the branch driver maps to
//! [`crate::replay::BranchTerminus::EndOfScene`].
//!
//! `Halt` is **not** a faithful reproduction of rlvm here: it SUPPRESSES
//! the oracle's `LocalReset()`, the `Jump(Gameexe("SEEN_MENU"), 0)`
//! transfer, and the fade. A faithful runtime would model those — they
//! belong to the interactive/render path, not to a headless content drive.
//!
//! `Halt` is nonetheless more correct than the advance-past default: the
//! bytecode physically following MenuReturn is NEVER reached by the real
//! control flow, so advancing past it would execute a phantom post-transfer
//! tail the game never runs. The real-byte terminus gate confirms that
//! `Halt` lands at the natural content end — coverage and terminus are
//! unchanged; only a ~5-step phantom tail is dropped.

use crate::rlop::module_sys::SYS_MODULE_ID;
use super::{DispatchOutcome, ExprValue, RLOperation, RlopKey, RlopRegistry};
use crate::vm::Vm;
use std::sync::Arc;

/// Compiler-version lattice the sys module is registered across.
const LATTICE_TYPES: [u8; 3] = [0, 1, 2];

/// The MenuReturn opcodes (1201 `MenuReturn`, 1202 `MenuReturn2`) — both
/// the same return-to-title transfer per the oracle.
const MENU_RETURN_OPCODES: &[u16] = &[1201, 1202];

/// `MenuReturn` — ends the content flow by returning to the title menu.
/// Modeled as [`DispatchOutcome::Halt`] (natural `EndOfScene` terminus)
/// for the headless drive; see the module docs.
#[derive(Debug)]
pub struct MenuReturnOp;

impl RLOperation for MenuReturnOp {
    fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        DispatchOutcome::Halt
    }
}

/// Mount the MenuReturn opcodes across the lattice. Returns the number of
/// `(lattice_type, opcode)` registrations made.
pub fn register_sys_menu_rlops(registry: &mut RlopRegistry) -> usize {
    let op: Arc<dyn RLOperation> = Arc::new(MenuReturnOp);
    let mut count = 0;
    for &opcode in MENU_RETURN_OPCODES {
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

/// Number of registrations [`register_sys_menu_rlops`] makes.
pub const SYS_MENU_RLOP_COUNT: usize = MENU_RETURN_OPCODES.len() * LATTICE_TYPES.len();

#[cfg(test)]
#[path = "module_sys_menu_tests.rs"]
mod tests;
