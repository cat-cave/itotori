//! Exact real-byte commands whose effects are outside the headless state.
//!
//! These keys occur on the branch-following path but their command bodies do
//! not write the VM store or move control. Their argument expressions still
//! run before dispatch. They are intentionally registered only at their
//! observed `(module_type, module_id, opcode)` addresses: this is not a
//! catalogue fallback for neighbouring or future commands. The `tag` values
//! preserve each individually named byte-level operation until a richer
//! surface (window, system, audio, or graphics) consumes its effect.

use super::{DispatchOutcome, ExprValue, RLOperation, RlopKey, RlopRegistry};
use crate::vm::Vm;
use std::sync::Arc;

/// An observed command whose state belongs to a non-headless surface.
#[derive(Debug)]
pub struct ObservedSurfaceCommand {
    tag: &'static str,
}

impl ObservedSurfaceCommand {
    fn new(tag: &'static str) -> Self {
        Self { tag }
    }

    /// Stable byte-level identity for diagnostics and test evidence.
    pub fn tag(&self) -> &'static str {
        self.tag
    }
}

impl RLOperation for ObservedSurfaceCommand {
    fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        DispatchOutcome::Advance
    }
}

/// The exact observed commands, each named by its stable semantic family and
/// byte-level extension number. They are deliberately not registered across a
/// lattice: an unobserved address remains an unknown operation.
const OBSERVED_SURFACE_COMMANDS: &[(u8, u8, u16, &str)] = &[
    (0, 4, 212, "sys.extension_212"),
    (0, 4, 213, "sys.extension_213"),
    (1, 4, 203, "sys.extension_203"),
    (1, 4, 300, "sys.extension_300"),
    (1, 4, 301, "sys.extension_301"),
    (1, 4, 302, "sys.extension_302"),
    (1, 4, 370, "sys.extension_370"),
    (1, 4, 371, "sys.extension_371"),
    (1, 4, 372, "sys.extension_372"),
    (1, 4, 373, "sys.extension_373"),
    (1, 4, 451, "sys.extension_451"),
    (1, 4, 452, "sys.extension_452"),
    (1, 4, 456, "sys.extension_456"),
    (1, 4, 457, "sys.extension_457"),
    (1, 4, 1221, "sys.extension_1221"),
    (1, 4, 1222, "sys.extension_1222"),
    (1, 4, 1231, "sys.extension_1231"),
    (1, 4, 1520, "sys.extension_1520"),
    (1, 4, 2230, "sys.set_bgm_volume_modifier"),
    (1, 4, 3503, "sys.extension_3503"),
    (1, 5, 120, "sys2.extension_120"),
    (1, 23, 101, "koe.extension_101"),
    (1, 33, 406, "grp.extension_406"),
    (1, 40, 10, "grp_effect.extension_10"),
    (1, 4, 100, "sys.extension_100"),
    (1, 4, 101, "sys.extension_101"),
    (1, 4, 620, "sys.extension_620"),
    (1, 4, 630, "sys.extension_630"),
    (1, 4, 2001, "sys.skip_animations"),
    (1, 4, 2051, "sys.set_skip_animations"),
    (1, 4, 2275, "sys.set_screen_mode"),
    (1, 4, 2375, "sys.screen_mode"),
    (1, 4, 3001, "sys.extension_3001"),
    (1, 5, 0, "sys2.extension_0"),
    (1, 30, 0, "grp_ctrl.extension_0"),
    (1, 30, 20, "grp_ctrl.extension_20"),
    (1, 30, 22, "grp_ctrl.extension_22"),
    (1, 31, 0, "grp_ctrl.extension_31_0"),
    (1, 81, 1031, "obj.extension_1031"),
    (1, 84, 1000, "obj.extension_84_1000"),
    (1, 84, 1100, "obj.extension_84_1100"),
];

/// Mount every exact observed headless-surface command.
pub fn register_observed_surface_rlops(registry: &mut RlopRegistry) -> usize {
    for &(module_type, module_id, opcode, tag) in OBSERVED_SURFACE_COMMANDS {
        registry.register(
            RlopKey::new(module_type, module_id, opcode),
            Arc::new(ObservedSurfaceCommand::new(tag)),
        );
    }
    OBSERVED_SURFACE_COMMANDS.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observed_surface_commands_are_exactly_addressed_and_advance() {
        let mut registry = RlopRegistry::new();
        assert_eq!(
            register_observed_surface_rlops(&mut registry),
            OBSERVED_SURFACE_COMMANDS.len()
        );
        let key = RlopKey::new(1, 4, 2230);
        assert!(registry.get(key).is_some());
        assert!(registry.get(RlopKey::new(2, 4, 2230)).is_none());
        assert_eq!(
            ObservedSurfaceCommand::new("sys.set_bgm_volume_modifier").tag(),
            "sys.set_bgm_volume_modifier"
        );
        assert_eq!(
            registry
                .get(key)
                .expect("registered command")
                .dispatch(&mut Vm::new(1, 0), &[]),
            DispatchOutcome::Advance
        );
    }
}
