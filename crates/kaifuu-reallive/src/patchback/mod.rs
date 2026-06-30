//! Patch-back for the Scene/SEEN bytecode.
//!
//! The canonical Seen.txt patchback path is
//! [`bundle_driven::apply_translated_bundle`], which consumes a translated
//! v0.2 BridgeBundle and re-emits the archive with length-changing edits
//! (scene offsets and compressed sizes rewritten). It re-walks each
//! scene's decompressed bytecode with [`crate::parse_real_bytecode`] to
//! recover the authoritative Textout / Choice-option byte ranges, so
//! opcode headers and operand bytes are never overwritten and every
//! non-translated scene survives byte-identical.

pub mod bundle_driven;
