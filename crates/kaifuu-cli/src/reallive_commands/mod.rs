mod extract;
mod opcode_gate;
mod patch;
mod paths;

pub(crate) use extract::run_extract_reallive_bundle;
pub(crate) use patch::run_patch_reallive_bundle;

#[cfg(test)]
pub(crate) use opcode_gate::{UnknownOpcodeGate, evaluate_unknown_opcode_gate};
#[cfg(test)]
pub(crate) use paths::{
    read_gameexe_inventory_bytes, reallive_patch_read_source_error,
    reallive_patch_source_mutated_error, reallive_patch_write_target_error,
    resolve_reallive_game_root_via_vault, resolve_reallive_seen_path,
};
