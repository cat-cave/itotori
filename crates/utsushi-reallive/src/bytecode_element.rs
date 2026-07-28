//! RealLive bytecode element stream decoder.
//!
//! Consumes the AVG32-decompressed bytecode produced by
//! [`crate::AvgDecompressor::decompress`] () and lexes it
//! into a typed [`Vec<BytecodeElement>`]. The decoder is a **structural
//! lexer**: it identifies each element's start byte, its byte length
//! and (for the cheap-to-extract header fields) the typed values that
//! immediately follow the lead byte. It does **not** evaluate
//! expressions or decode command argument lists semantically — that is
//! the responsibility. Each element preserves its
//! `raw_bytes` so the follow-up evaluator can consume them without
//! re-walking the stream.
//!
//! # Lead-byte dispatch
//!
//! The table below is derived from Haeleth's RLDEV documentation
//! (`docs/research/reallive-engine.md` §E) and re-tested against the
//! Observed scene #0001 decompressed bytes
//! (`RealLive encryption research notes` §4.2)
//! before being encoded here:
//!
//! Lead byte | Element | Body shape
//! ------------------ | ------------------------------------- | --------------------------------
//! `0x00` / `0x2C` | [`BytecodeElement::Comma`] | 1 byte (lead only)
//! `0x0A` | [`BytecodeElement::MetaLine`] | lead + `u16 LE` (3 bytes)
//! `0x21` | [`BytecodeElement::MetaEntrypoint`] | lead + `u16 LE` (3 bytes)
//! `0x23` | [`BytecodeElement::Command`] | 8-byte header + optional `(...)`
//! `0x24` | [`BytecodeElement::Expression`] | lead + one expression body
//! `0x30..=0x34` | [`BytecodeElement::SelectionOption`] | 1-byte marker
//! `0x40` | [`BytecodeElement::MetaKidoku`] | lead + `u16 LE` (3 bytes)
//! other | [`BytecodeElement::Textout`] | textout run (Shift-JIS aware)
//!
//! # Partition invariant
//!
//! [`decode_bytecode_stream`] returns
//! `Err(BytecodeDecodeError::PartitionMismatch)` if the per-element
//! `byte_offset` and `byte_len` values do not partition the full
//! input slice (every byte covered exactly once, in monotonic
//! order). The same guarantee is exercised by the real-bytes test
//! in `tests/bytecode_element_real_bytes.rs` against the observed
//! scene #0001 1660-byte decompressed payload.
//!
//! # Empty input
//!
//! An empty input slice is **not** accepted as a zero-element stream.
//! The function returns [`BytecodeDecodeError::Truncated`] — the
//! alpha-gate "no silent zero-state" contract forbids returning
//! `Ok(vec![])` on an empty buffer.
//!
//! # Expression-byte walker (private)
//!
//! The decoder relies on a private [`expression_byte_length`] helper
//! that walks the documented expression encoding
//! (`docs/research/reallive-engine.md` §G) for the sole purpose of
//! determining how many bytes a single expression consumes. It does
//! not evaluate the expression or build an AST — that is.
//! The walker is the minimum machinery required to satisfy the
//! partition invariant for [`BytecodeElement::Expression`] and for
//! the `(...)` argument list inside [`BytecodeElement::Command`].

mod command_decode;
mod select_choice;
#[cfg(test)]
#[path = "bytecode_element_stream_tests.rs"]
mod stream_tests;
include!("bytecode_element_parts/001.rs");
include!("bytecode_element_parts/002.rs");
include!("bytecode_element_parts/003.rs");
include!("bytecode_element_parts/004.rs");
