//! Softpal ownership of its top-level bundle commands.

use super::super::{EngineCommandInvocation, EngineCommandResult};

pub(super) fn run(request: EngineCommandInvocation<'_>) -> EngineCommandResult {
    request.adapter_config().require_empty(request.engine())?;
    crate::run_softpal_command(request.args())
}
