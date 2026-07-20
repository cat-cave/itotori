//! Siglus decoded scenes → v0.2 localization bridge bundles.
//!
//! This module is deliberately an engine adapter rather than a title profile:
//! decoded scene strings, statement sites, selection calls, and the Gameexe
//! speaker table are its only inputs.  It does not name or special-case a game.

mod assembly;
mod ids;
mod json;
mod markup;
mod model;

pub use assembly::{produce_bundle, produce_scene_pack_bundle, produce_whole_scene_pack_bundle};
pub use model::{BridgeOpts, BridgeProduceError, BridgeSceneInput, ProducedBundle};

#[cfg(test)]
mod tests;
