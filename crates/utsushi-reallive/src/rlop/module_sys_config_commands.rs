//! RealLive `module_sys` engine-state-config commands.
//!
//! `sys (1,4,*)` opcodes that toggle engine configuration state (system-
//! menu entry visibility, auto-savepoint marking) — state that does not
//! affect the headless control-flow drive. Per the rlvm oracle each is a
//! **void command** (`RLOpcode`/`CallFunction`, not `RLStoreOpcode`):
//!
//! | Opcode | rlvm name | rlvm handler |
//! | ------ | ---------------------- | ------------------------------------ |
//! | 1213 | `DisableSyscom` | `System::DisableSyscomEntry` (module_sys_syscom.cc:74) |
//! | 3501 | `EnableAutoSavepoints` | `RLMachine::SetMarkSavepoints(1)` (module_sys_save.cc:355) |
//! | 3502 | `DisableAutoSavepoints`| `RLMachine::SetMarkSavepoints(0)` (module_sys_save.cc:359) |
//!
//! `DisableSyscom` hides a system-menu entry; the auto-savepoint toggles
//! control WHEN the engine marks a save-on-exit point. None writes `store`
//! or transfers control, and the headless drive-to-terminus has neither a
//! system menu nor a save surface — so `Advance` is behaviourally exact,
//! matching how unknown opcodes are already advanced past. Full menu/save
//! fidelity is the interactive/persistence path's surface.
//!
//! Registered across the compiler-version lattice `{0,1,2}` under
//! `module_id=4`, wired at the registry assembly point so `module_sys.rs`
//! (grandfathered, shrink-only) stays untouched.

use super::module_sys::SYS_MODULE_ID;
use super::{DispatchOutcome, ExprValue, RLOperation, RlopKey, RlopRegistry};
use crate::vm::Vm;
use std::sync::Arc;

/// Compiler-version lattice the sys module is registered across.
const LATTICE_TYPES: [u8; 3] = [0, 1, 2];

/// The engine-state-config commands this module mounts, as
/// `(opcode, diagnostic tag)`.
const CONFIG_COMMANDS: &[(u16, &str)] = &[
    (1213, "sys.disable_syscom"),
    (3501, "sys.enable_auto_savepoints"),
    (3502, "sys.disable_auto_savepoints"),
];

/// A `module_sys` engine-state-config command. Void per the oracle; the
/// headless drive has no menu/save surface, so it advances past.
#[derive(Debug)]
pub struct SysConfigCommand {
    /// Stable diagnostic tag (e.g. `"sys.disable_syscom"`).
    tag: &'static str,
}

impl SysConfigCommand {
    pub fn new(tag: &'static str) -> Self {
        Self { tag }
    }

    /// The diagnostic tag this command reports under.
    pub fn tag(&self) -> &'static str {
        self.tag
    }
}

impl RLOperation for SysConfigCommand {
    fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        // Engine-state config only: no store write, no transfer. Advance.
        DispatchOutcome::Advance
    }
}

/// Mount every engine-state-config command across the lattice. Returns the
/// number of `(lattice_type, opcode)` registrations made.
pub fn register_sys_config_rlops(registry: &mut RlopRegistry) -> usize {
    let mut count = 0;
    for &(opcode, tag) in CONFIG_COMMANDS {
        let op: Arc<dyn RLOperation> = Arc::new(SysConfigCommand::new(tag));
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

/// Number of registrations [`register_sys_config_rlops`] makes.
pub const SYS_CONFIG_RLOP_COUNT: usize = CONFIG_COMMANDS.len() * LATTICE_TYPES.len();

#[cfg(test)]
#[path = "module_sys_config_commands_tests.rs"]
mod tests;
