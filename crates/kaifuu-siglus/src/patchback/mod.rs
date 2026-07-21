//! Byte-correct patch-back for `Scene.pck`.
//! Mirrors `kaifuu-reallive`'s `patchback` module shape:
//! - [`bundle_driven`] consumes a translated v0.2 BridgeBundle and
//!   re-emits the `Scene.pck` archive with length-changing edits (scene
//!   offsets and compressed sizes rewritten), re-walking each scene's
//!   decompiled bytecode and string table so opcode headers and operand bytes
//!   are never overwritten and every non-translated scene survives
//!   byte-identical.
//! - [`delta`] produces a per-scene patch delta (the unit-level edit
//!   record) that the bundle-driven driver applies. The older delta API remains
//!   separate while its consumer contract is completed.

pub mod bundle_driven;
pub mod delta;
