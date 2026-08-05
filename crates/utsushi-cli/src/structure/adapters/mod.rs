//! Engine-specific narrative-structure providers and their registry.
//!
//! The command parser stays engine-agnostic in the parent module. Adding an
//! engine changes this directory only: its provider declares its format paths
//! and is registered here without a new command flag or parser branch.

mod reallive;
mod rpg_maker;
mod siglus;

use std::error::Error;

use serde_json::Value;

use super::StructureCommandInput;

type StructureProvider = fn(StructureCommandInput) -> Result<Value, Box<dyn Error>>;

const STRUCTURE_PROVIDERS: &[(&str, StructureProvider)] = &[
    ("reallive", reallive::build_structure),
    ("rpg-maker", rpg_maker::build_structure),
    ("softpal", super::softpal::build_softpal_structure),
    ("siglus", siglus::build_structure),
];

pub(super) fn structure_provider(engine: &str) -> Result<StructureProvider, Box<dyn Error>> {
    STRUCTURE_PROVIDERS
        .iter()
        .find_map(|(id, provider)| (*id == engine).then_some(*provider))
        .ok_or_else(|| format!("unregistered structure provider: {engine}").into())
}

pub(super) fn validate_empty_adapter_config(
    engine: &str,
    input: &StructureCommandInput,
) -> Result<(), Box<dyn Error>> {
    let Some(config) = input.adapter_config.as_ref() else {
        return Ok(());
    };
    let object = config.as_object().ok_or_else(|| -> Box<dyn Error> {
        format!("utsushi.structure.{engine}.adapter_config: expected an object").into()
    })?;
    let Some(key) = object.keys().next() else {
        return Ok(());
    };
    Err(format!("utsushi.structure.{engine}.adapter_config: unsupported key {key:?}").into())
}
