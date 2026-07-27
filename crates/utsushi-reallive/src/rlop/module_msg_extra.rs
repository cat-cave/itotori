//! Exact, observed `Msg` extensions that neither proven archive identifies
//! semantically. They affect no modeled VM state, so they advance while
//! retaining their byte-level identity instead of becoming unknown.

use super::{DispatchOutcome, ExprValue, RLOperation, RlopKey, RlopRegistry};
use crate::vm::Vm;
use std::sync::Arc;

const MSG_EXTRA_COMMANDS: &[(u8, u16, &str)] = &[
    (0, 400, "msg.extension_400"),
    (0, 401, "msg.extension_401"),
];

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

/// Mount only the exact observed extension addresses.
pub fn register_msg_extra_rlops(registry: &mut RlopRegistry) -> usize {
    for &(module_type, opcode, tag) in MSG_EXTRA_COMMANDS {
        let op: Arc<dyn RLOperation> = Arc::new(MsgExtraCommand::new(tag));
        registry.register(RlopKey::new(module_type, 3, opcode), op);
    }
    MSG_EXTRA_COMMANDS.len()
}

/// Number of registrations [`register_msg_extra_rlops`] makes.
pub const MSG_EXTRA_RLOP_COUNT: usize = MSG_EXTRA_COMMANDS.len();

#[cfg(test)]
#[path = "module_msg_extra_tests.rs"]
mod tests;
