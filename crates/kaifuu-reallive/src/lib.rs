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
//!   [`RealLiveSceneIndex`]. Out: per-scene `(byte_offset, byte_len)`
//!   ranges keyed by the 10,000-slot directory index ([`SceneEntry`]).
//! - [`parse_scene`] — decode a single scene byte-blob into a [`Scene`]
//!   AST plus diagnostics. Out: structured AST with named opcodes,
//!   [`StringSlot`]s with stable position-derived ids, and a
//!   [`ParseStatus`] indicating fatal / warning / clean.
//!
//! # SEEN.TXT envelope (real 10,000-slot fixed-offset-table — KAIFUU-188)
//!
//! The envelope this crate parses is the **real RealLive 10,000-slot
//! fixed-offset-table** documented at `docs/research/reallive-engine.md`
//! §C and confirmed against Sweetie HD's
//! `REALLIVEDATA/Seen.txt` per
//! `docs/audits/real-bytes-validation-2026-06-24.md` §2.8.
//!
//! ```text
//! +----------+----------+----- … -----+----------+--------- … -----------+
//! | slot 0   | slot 1   |             | slot 9999| scene payloads        |
//! | u32 off  | u32 off  |             | u32 off  | (referenced by        |
//! | u32 size | u32 size |             | u32 size |  absolute u32 offset) |
//! +----------+----------+----- … -----+----------+--------- … -----------+
//! 0x0000     0x0008                   0x1_3878    0x1_3880
//! ```
//!
//! - 10,000 slots × 8 bytes = 80,000 bytes (`0x0001_3880`) of fixed
//!   directory at file offset 0.
//! - Each slot is `(u32_le offset, u32_le length)`. Both zero means the
//!   slot is reserved/unused (silently omitted by the parser).
//! - Non-zero slots whose `offset + length` runs past the file end emit
//!   `kaifuu.reallive.truncated_scene` Fatal.
//! - Sweetie HD has 198 populated slots, scene-id range 1..=9999.
//!
//! The pre-KAIFUU-188 synthetic count-plus-table envelope is removed — no
//! legacy compat, no alias, no flag.
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

pub use archive::{
    REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN, REALLIVE_SEEN_TXT_SLOT_COUNT, RealLiveSceneIndex,
    SceneEntry, parse_archive,
};
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
