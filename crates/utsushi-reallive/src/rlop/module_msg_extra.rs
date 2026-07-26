//! RealLive `Msg` text-page formatting commands utsushi's core msg family
//! does not yet mount: `msgHideAll` (161), `br` (201), `spause` (205).
//!
//! Per the rlvm oracle every one is a void `RLOpcode` (module_msg.cc:254/
//! 257/258) — none writes `store`:
//!
//! | Opcode | rlvm name | effect |
//! | ------ | ----------- | -------------------------------------------- |
//! | 161 | `msgHideAll` | hide every active text window + new page |
//! | 201 | `br` | `TextPage::HardBrake` — hard line break |
//! | 205 | `spause` | push a `PauseLongOperation` (a text pause) |
//!
//! All three act on the TEXT-RENDERING surface (window visibility, line
//! breaking, pausing) — none affects the control-flow drive: they take no
//! control transfer and write no `store`, and `spause`'s pause resolves
//! immediately under the headless scheduler (like `msg.pause`). So
//! `Advance` is behaviourally exact for the headless drive-to-terminus,
//! matching how unknown opcodes are already advanced past. Faithful text
//! formatting (the break/hide/pause actually reshaping rendered text) is
//! the render path's surface.
//!
//! Registered across the msg compiler-version lattice `{0,1,2}` under
//! [`MSG_MODULE_ID`], matching how the core msg family mounts.

use super::module_msg::MSG_MODULE_ID;
use super::{DispatchOutcome, ExprValue, RLOperation, RlopKey, RlopRegistry};
use crate::vm::Vm;
use std::sync::Arc;

/// The msg compiler-version lattice the core family registers across.
const LATTICE_TYPES: [u8; 3] = [0, 1, 2];

/// The text-formatting commands this module mounts, as
/// `(opcode, diagnostic tag)`.
const MSG_EXTRA_COMMANDS: &[(u16, &str)] =
    &[(161, "msg.hide_all"), (201, "msg.br"), (205, "msg.spause")];

/// A void `Msg` text-formatting command. Writes no `store` and takes no
/// control transfer; its effect is on rendered text, which the headless
/// drive does not model, so it advances past.
#[derive(Debug)]
pub struct MsgExtraCommand {
    /// Stable diagnostic tag (e.g. `"msg.br"`).
    tag: &'static str,
}

impl MsgExtraCommand {
    pub fn new(tag: &'static str) -> Self {
        Self { tag }
    }

    /// The diagnostic tag this command reports under.
    pub fn tag(&self) -> &'static str {
        self.tag
    }
}

impl RLOperation for MsgExtraCommand {
    fn dispatch(&self, _vm: &mut Vm, _args: &[ExprValue]) -> DispatchOutcome {
        // Text-rendering side effect only: no store, no transfer. Advance.
        DispatchOutcome::Advance
    }
}

/// Mount every text-formatting command across the lattice. Returns the
/// number of `(lattice_type, opcode)` registrations made.
pub fn register_msg_extra_rlops(registry: &mut RlopRegistry) -> usize {
    let mut count = 0;
    for &(opcode, tag) in MSG_EXTRA_COMMANDS {
        let op: Arc<dyn RLOperation> = Arc::new(MsgExtraCommand::new(tag));
        for module_type in LATTICE_TYPES {
            registry.register(
                RlopKey::new(module_type, MSG_MODULE_ID, opcode),
                Arc::clone(&op),
            );
            count += 1;
        }
    }
    count
}

/// Number of registrations [`register_msg_extra_rlops`] makes.
pub const MSG_EXTRA_RLOP_COUNT: usize = MSG_EXTRA_COMMANDS.len() * LATTICE_TYPES.len();

#[cfg(test)]
#[path = "module_msg_extra_tests.rs"]
mod tests;
