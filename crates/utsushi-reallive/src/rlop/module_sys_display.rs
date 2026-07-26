//! RealLive `module_sys` display/interaction-state commands.
//!
//! A cluster of `sys (1,4,*)` opcodes whose sole effect is on RENDER /
//! INTERACTION surfaces (text skip-mode, auto-advance mode, system-menu
//! entry visibility) — surfaces the headless control-flow drive does not
//! model. Per the rlvm oracle every one is a **void command**
//! (`RLOpcode`, not `RLStoreOpcode`): it writes no `store` register and
//! takes no control transfer, so advancing past it is behaviourally exact
//! for the headless drive-to-terminus. Full render/interactive fidelity
//! (actually toggling skip/auto/menu state) is the rendering path's
//! surface and gets real handlers there; here they are drive-complete.
//!
//! | Opcode | rlvm name | rlvm handler |
//! | ------ | ------------------ | ------------------------------------- |
//! | 334 | `ClearLocalSkipMode` | `CallFunctionWith(TextSystem::SetSkipMode, 0)` (module_sys.cc:393) |
//! | 1211 | `EnableSyscom` | `CallFunction(System::EnableSyscomEntry)` (module_sys_syscom.cc:67) |
//! | 1212 | `HideSyscom` | `CallFunction(System::HideSyscomEntry)` (module_sys_syscom.cc:70) |
//! | 2250 | `SetAutoMode` | `CallFunction(TextSystem::SetAutoMode)` (module_sys.cc:523) |
//!
//! Each is registered across the RealLive compiler-version lattice
//! `{0,1,2}` under `module_id=4`, matching how the arithmetic family in
//! [`super::module_sys`] mounts.

use super::module_sys::SYS_MODULE_ID;
use super::{DispatchOutcome, ExprValue, RLOperation, RlopKey, RlopRegistry};
use crate::vm::Vm;
use std::sync::Arc;

/// Compiler-version lattice the sys module is registered across.
const LATTICE_TYPES: [u8; 3] = [0, 1, 2];

/// The display/interaction-state commands this module mounts, as
/// `(opcode, diagnostic tag)`. Tags describe the observable effect, not a
/// ticket.
const DISPLAY_COMMANDS: &[(u16, &str)] = &[
    (334, "sys.clear_local_skip_mode"),
    (1211, "sys.enable_syscom"),
    (1212, "sys.hide_syscom"),
    (2250, "sys.set_auto_mode"),
];

/// A `module_sys` command whose only effect is on a render/interaction
/// surface absent from the headless drive. Writes no `store` and takes no
/// control transfer — behaviourally exact as an `Advance` for the drive.
#[derive(Debug)]
pub struct SysDisplayCommand {
    /// Stable diagnostic tag (e.g. `"sys.set_auto_mode"`).
    tag: &'static str,
}

impl SysDisplayCommand {
    pub fn new(tag: &'static str) -> Self {
        Self { tag }
    }

    /// The diagnostic tag this command reports under.
    pub fn tag(&self) -> &'static str {
        self.tag
    }
}

impl RLOperation for SysDisplayCommand {
    fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        // Render/interaction-state only: no store write, no transfer. The
        // headless drive is unaffected, so advance past the command.
        DispatchOutcome::Advance
    }
}

/// Mount every display/interaction-state command across the lattice.
/// Returns the number of `(lattice_type, opcode)` registrations made.
pub fn register_sys_display_rlops(registry: &mut RlopRegistry) -> usize {
    let mut count = 0;
    for &(opcode, tag) in DISPLAY_COMMANDS {
        let op: Arc<dyn RLOperation> = Arc::new(SysDisplayCommand::new(tag));
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

/// Number of registrations [`register_sys_display_rlops`] makes.
pub const SYS_DISPLAY_RLOP_COUNT: usize = DISPLAY_COMMANDS.len() * LATTICE_TYPES.len();

#[cfg(test)]
#[path = "module_sys_display_tests.rs"]
mod tests;
