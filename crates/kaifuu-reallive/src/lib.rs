//! Pure-Rust RealLive Scene/SEEN parser-boundary smoke (KAIFUU-173) and
//! text inventory adapter (KAIFUU-174).
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
//! - KAIFUU-174 adds Shift-JIS decode/encode via `encoding_rs` (WHATWG-
//!   spec implementation, not a copy of rlvm or RLDEV), a bounded
//!   protected-span catalogue derived from public RLDEV documentation,
//!   and length-preserving patch-back. Offset-table rewriting and
//!   jump-target recalculation are not implemented; length-changing edits
//!   emit `kaifuu.reallive.patchback_offset_overflow` Fatal.
//! - No `Command::new`, no Wine, no Windows helper, no remote helper.
//!   This crate is a pure function over `&[u8]`; the adapter (in
//!   `kaifuu-engine-fixture`) owns the filesystem I/O.
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
pub mod encoding;
pub mod gameexe;
pub mod inventory;
mod opcodes;
mod parser;
pub mod patchback;
pub mod protected_spans;
mod strings;

pub use archive::{SceneEntry, SceneId, SceneIndex, parse_archive};
pub use ast::{
    DiagnosticSeverity, Instruction, InstructionId, InstructionKind, Operand, ParseOutcome,
    ParseStatus, Scene, StringSlot, StringSlotId, StringSlotRef, StringSlotRole,
};
pub use diagnostics::{
    ParseDiagnostic, ParseDiagnosticCode, semantic_error_code_for_parser_diagnostic,
};
pub use encoding::{
    SHIFT_JIS_DECODE_FAILURE_CODE, ShiftJisDecode, ShiftJisDecodeDiagnostic, ShiftJisEncodeError,
    decode_shift_jis_slot, encode_shift_jis_slot, slice_control_bytes,
};
pub use gameexe::{
    GameexeIniDiagnostic, GameexeInventoryEntry, GameexeInventoryReport, GameexeKeyTreatment,
    UNKNOWN_GAMEEXE_KEY_CODE, parse_gameexe_inventory,
};
pub use inventory::{
    AssetReference, AssetReferenceInventory, AssetReferenceKind,
    INVENTORY_UNATTRIBUTED_DIALOGUE_CODE, INVENTORY_UNKNOWN_ASSET_EXTENSION_CODE,
    INVENTORY_UNSUPPORTED_TEXT_SHAPE_CODE, InventoryReport, InventoryWarning, InventoryWarningCode,
    build_scene_inventory,
};
pub use opcodes::NamedOpcode;
pub use parser::parse_scene;
pub use patchback::{
    PATCHBACK_OFFSET_OVERFLOW_CODE, PATCHBACK_PARSER_REGRESSION_CODE,
    PATCHBACK_PROTECTED_SPAN_LOST_CODE, PATCHBACK_SHIFT_JIS_ENCODE_FAILURE_CODE,
    PATCHBACK_STALE_SOURCE_HASH_CODE, PATCHBACK_UNKNOWN_SLOT_ID_CODE,
    PATCHBACK_UNSUPPORTED_LENGTH_POLICY_CODE, PatchBackError, PatchBackErrorCode, PatchBackPlan,
    SlotEdit, SlotEditLengthPolicy, apply_patches,
};
pub use protected_spans::{
    PROTECTED_SPAN_UNKNOWN_CONTROL_CODE, ProtectedSpanKind, ProtectedSpanReport,
    ProtectedSpanWarning, RealLiveProtectedSpan, detect_protected_spans,
};
