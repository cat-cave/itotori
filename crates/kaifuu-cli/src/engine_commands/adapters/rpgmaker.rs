//! RPG Maker ownership of its top-level bundle commands.

use super::super::{EngineCommandInvocation, EngineCommandResult};

pub(super) fn run(request: EngineCommandInvocation<'_>) -> EngineCommandResult {
    request.adapter_config().require_empty(request.engine())?;
    match request.verb() {
        "extract" => crate::run_extract_rpgmaker_bundle(request.args()),
        "patch" => crate::run_patch_rpgmaker_bundle(request.args()),
        verb => Err(format!("kaifuu.engine_command.rpgmaker.unsupported_verb: {verb}").into()),
    }
}
