//! AVG32 LZSS + XOR scene-bytecode decompressor.
//!
//! Decodes the AVG32-shape compressed bytecode payload that sits after
//! the [`crate::SceneHeader`] in every populated RealLive scene blob.
//! The on-disk transform is a two-step pipeline:
//!
//! 1. **First-level XOR** — every consumed byte of the compressed stream
//!    is XOR'd against a fixed, public 256-byte mask
//!    ([`AVG32_XOR_MASK`]) indexed by a counter that increments per
//!    consumed byte (the first 8 mask slots are spent on the preamble
//!    so the first flag byte XOR'es against `mask[8]`).
//! 2. **LZSS** — rlvm-shape sliding-window decompression with 16-bit
//!    flag bytes (LSB first), a 4096-byte addressable window, and a
//!    `count_word = (back_distance << 4) | (run_length - 2)` encoding.
//! 3. **Optional second-level XOR** — when [`AvgDecompressor::decompress`]
//!    is called with `Some(key)` the 16-byte key is XOR'd cyclically
//!    against the post-LZSS bytes. For any compiler-110002 title the caller
//!    passes `None` per outcome A in
//!    the RealLive encryption research notes.
//!
//! # Outcome A (compiler version 110002)
//!
//! The encryption-mechanism research probe under
//! `RealLive encryption research notes` proved
//! the rlvm `scenario.cc::Header` heuristic ("if compiler_version ==
//! 110002 then enable second-level XOR") is overly pessimistic for the
//! compiler-110002 HD remasters. The observed scene #0001 decompresses
//! cleanly with `xor2_key = None`: the resulting 1660-byte stream
//! begins `0a 02 00 0a 03 00 21 00` and parses as a valid
//! BytecodeElement sequence. The decompressor therefore makes the
//! second-level XOR pass **optional** (caller-controlled) and emits a
//! typed [`DecompressWarning::Xor2NotApplied`] when the call site
//! passes `xor2_key = None` for a compiler version that historically
//! requested an XOR-2 pass. The warning is never silent and is part of
//! the return value — silent skip is forbidden by the alpha-gate
//! contract.
//!
//! # Clean-room provenance
//!
//! The 256-byte [`AVG32_XOR_MASK`] is a **numeric public constant** —
//! the same fixed array used by every RealLive title since AVG32. The
//! bytes are reproduced here verbatim from the rlvm
//! `src/libreallive/compression.cc` `xor_mask[256]` (BSD-3-Clause, Peter
//! Jolly, 2006); a documented numeric constant is not a license-protected
//! expression. The LZSS algorithm is restated in our own words from the
//! same source — no code is mechanically translated.

#[cfg(test)]
#[path = "decompressor_tests.rs"]
mod tests;
include!("decompressor_parts/001.rs");
include!("decompressor_parts/002.rs");
