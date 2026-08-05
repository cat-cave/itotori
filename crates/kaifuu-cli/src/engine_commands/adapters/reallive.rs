//! RealLive ownership of its top-level bundle commands.

use super::super::{EngineCommandInvocation, EngineCommandResult};

pub(super) fn run(request: EngineCommandInvocation<'_>) -> EngineCommandResult {
    request.adapter_config().require_empty(request.engine())?;
    match request.verb() {
        "extract" => crate::run_extract_reallive_bundle(request.args()),
        "patch" => crate::run_patch_reallive_bundle(request.args()),
        verb => Err(format!("kaifuu.engine_command.reallive.unsupported_verb: {verb}").into()),
    }
}
