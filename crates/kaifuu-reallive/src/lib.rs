//! Pure-Rust RealLive Scene/SEEN parser-boundary smoke (KAIFUU-173).
//!
//! Clean-room provenance:
//! - All RealLive format observations are derived from publicly archived
//!   format documentation (Haeleth's RLDEV site,
//!   `https://dev.haeleth.net/rldev.shtml`) plus the synthetic fixtures
//!   under `crates/kaifuu-reallive/tests/fixtures/`. No source expression
//!   is copied from RLDEV or rlvm.
//! - rlvm (`https://github.com/eglaysher/rlvm`) is a research anchor only.
//!   Its license is GPLv3+ and is incompatible with itotori's distribution
//!   posture if linked or derived. This crate does NOT depend on rlvm,
//!   does NOT include rlvm headers, does NOT copy rlvm's structure
//!   layouts, and does NOT mechanically translate rlvm code into Rust.
//!   If a hypothesis about RealLive's format was confirmed by reading
//!   rlvm, the hypothesis is re-derived and re-tested against the
//!   synthetic fixture bytes before being encoded here.
//! - The KAIFUU-173 parser is identify+decode only at the smoke scope.
//!   Patch-back, runtime execution, jump resolution, scene-graph linking,
//!   Shift-JIS codec, encrypted SEEN.TXT, and full opcode coverage are
//!   out of scope (see KAIFUU-174 and UTSUSHI-146).
//! - No `Command::new`, no Wine, no Windows helper, no remote helper.
//!   The parser is a pure function over `&[u8]`.
//!
//! # Surface
//!
//! - [`parse_archive`] — decode a SEEN.TXT archive envelope into a
//!   [`SceneIndex`]. Out: per-scene `(byte_offset, byte_len)` ranges plus a
//!   stable [`SceneId`].
//! - [`parse_scene`] — decode a single scene byte-blob into a [`Scene`]
//!   AST plus diagnostics. Out: structured AST with named opcodes,
//!   [`StringSlot`]s with stable position-derived ids, and a
//!   [`ParseStatus`] indicating fatal / warning / clean.
//!
//! # SEEN.TXT envelope (synthetic-fixture shape, clean-room)
//!
//! The envelope this crate parses is the documented count-plus-table shape:
//!
//! ```text
//! +--------+---------+---------+--- ... ---+----------+
//! | u32 LE | u32 LE  | u32 LE  |           | scene    |
//! | count  | off[0]  | size[0] |           | payload  |
//! +--------+---------+---------+--- ... ---+----------+
//! ^        ^                              ^
//! |        | per-scene (offset, size) entries
//! | scene count (u32 LE) at offset 0
//! ```
//!
//! `count` may be zero (treated as an empty archive). Per-scene entries are
//! eight bytes each: `u32` little-endian offset followed by `u32`
//! little-endian size. `offset` is absolute from the start of the archive;
//! `size` is the byte length of the scene payload.
//!
//! # Scene bytecode (synthetic-fixture shape, clean-room)
//!
//! This crate parses a deliberately small, named-opcode bytecode that the
//! synthetic fixtures use to exercise the AST and diagnostic surface. The
//! shape is intentionally narrower than the real RealLive opcode space; it
//! is a clean-room smoke shape suitable for the parser boundary contract.
//!
//! ```text
//! Instruction:
//!   +------+--------+---------+----------+---- ... ----+
//!   | 0x23 | opcode | operand | operand0 | operand1    |
//!   | '#'  |  byte  | count   |          |             |
//!   +------+--------+---------+----------+---- ... ----+
//!
//! Operand:
//!   - Int    : tag 0x69 'i' + i32 little-endian (4 bytes)
//!   - String : tag 0x73 's' + u16 LE length (2 bytes) + N bytes
//!   - Label  : tag 0x6C 'l' + u16 LE length (2 bytes) + N bytes (ASCII)
//! ```
//!
//! Opener byte `0x23` ('#') delimits instructions; any other opener byte
//! produces an `Unrecognized` instruction node carrying the raw opener
//! plus a paired `kaifuu.reallive.unrecognized_instruction` warning. The
//! parser advances by exactly one byte after an unrecognized opener so
//! that the byte-range partition guarantee (see §8.3 of the plan) holds.
//!
//! Recognized opcode bytes — derived from the synthetic fixture plus
//! the documented common-case cushion (Haeleth's RLDEV documentation):
//!
//! | Byte  | NamedOpcode    |
//! | ----- | -------------- |
//! | 0x01  | TextDisplay    |
//! | 0x02  | SetSpeaker     |
//! | 0x03  | Choice         |
//! | 0x04  | SetVar         |
//! | 0x05  | Jump           |
//! | 0x06  | Return         |
//! | 0x07  | ClearScreen    |
//! | 0x08  | Pause          |
//!
//! Any other opcode byte after a `#` opener is recognized as an
//! `Unrecognized` instruction with a paired warning. The byte run is
//! never silently dropped.

#![forbid(unsafe_code)]
#![deny(missing_debug_implementations)]

mod archive;
mod ast;
mod diagnostics;
mod opcodes;
mod parser;
mod strings;

pub use archive::{SceneEntry, SceneId, SceneIndex, parse_archive};
pub use ast::{
    DiagnosticSeverity, Instruction, InstructionId, InstructionKind, Operand, ParseOutcome,
    ParseStatus, Scene, StringSlot, StringSlotId, StringSlotRef, StringSlotRole,
};
pub use diagnostics::{
    ParseDiagnostic, ParseDiagnosticCode, semantic_error_code_for_parser_diagnostic,
};
pub use opcodes::NamedOpcode;
pub use parser::parse_scene;
