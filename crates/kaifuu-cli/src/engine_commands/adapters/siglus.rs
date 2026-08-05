//! Siglus ownership of its top-level bundle commands.

use super::super::{EngineCommandInvocation, EngineCommandResult};

pub(super) fn run(request: EngineCommandInvocation<'_>) -> EngineCommandResult {
    // Cipher selection is decoder-owned, not an adapter-config property.
    request.adapter_config().require_empty(request.engine())?;
    crate::siglus_commands::run_siglus_engine_command(request.args())
}
