//! Byte-correct patch-back for the `Scene.pck` bytecode — **skeleton**
//! (siglus-05).
//! Mirrors `kaifuu-reallive`'s `patchback` module shape:
//! - [`bundle_driven`] consumes a translated v0.2 BridgeBundle and
//!   re-emits the `Scene.pck` archive with length-changing edits (scene
//!   offsets and compressed sizes rewritten), re-walking each scene's
//!   decompiled bytecode so opcode headers and operand bytes are never
//!   overwritten and every non-translated scene survives byte-identical.
//! - [`delta`] produces a per-scene patch delta (the unit-level edit
//!   record) that the bundle-driven driver applies.
//!   Skeleton status: both entry points return their module-local
//!   `NotImplemented` error.

pub mod bundle_driven;
pub mod delta;
