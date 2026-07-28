//! Real-bytes patchback driver.
//! Consumes a translated v0.2 BridgeBundle ([`TranslatedBundleV02`])
//! and a writable copy of a RealLive `Seen.txt`, walks each translated
//! unit, locates its source-side Textout body inside the appropriate
//! scene's decompressed bytecode, splices the Shift-JIS-encoded target
//! text into the bytecode, re-compresses the scene via the AVG32 LZSS
//! literal-only encoder ([`crate::compressor::compress_avg32_literal`]),
//! rewrites the scene header's compressed-size field, and rewrites the
//! 10,000-slot directory to accommodate the new scene offsets.
//! Clean-room provenance:
//! - The driver consumes the v0.2 BridgeBundle surface
//!   ([`kaifuu_core::BridgeBundleV02`]) and inverts the offsets the
//!   producer pinned in `sourceLocation.range`. No rlvm source is
//!   vendored; no Wine; no Windows helper; no external compressor.
//! - The re-emission pipeline (decompress → splice → recompress → header
//!   rewrite → directory rewrite) is the literal inverse of the
//!   read pipeline.
//! - The translated-bundle schema is the source-side v0.2 BridgeBundle
//!   augmented with a per-unit `target` object carrying `{locale, text}`.
//!   The augmentation is local to this crate — itotori populates it via
//!   `apply_translated_bundle` callers.
//!   Hard constraints:
//! - The original `seen_txt_bytes` slice is NOT modified. The function
//!   returns a fresh `Vec<u8>` carrying the patched archive.
//! - Every failure mode is a typed [`PatchbackError`] variant. There is
//!   no silent fallback; no `unwrap` clusters in production code.
//! - Length-changing edits are supported. The compressor emits
//!   variable-length output and the directory is rewritten accordingly.
//!   No length-preserving constraint is imposed on the translated text.

#[path = "bundle_driven/scene_patch.rs"]
mod scene_patch;
mod translated_bundle;
include!("bundle_driven_parts/001.rs");
include!("bundle_driven_parts/002.rs");
include!("bundle_driven_parts/005.rs");
