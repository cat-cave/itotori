//! Pure-Rust RealLive Scene/SEEN parser (KAIFUU-173 + KAIFUU-188 +
//! KAIFUU-191) and text inventory adapter (KAIFUU-174).
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
//!   and slot patch-back.
//! - The canonical real-bytes patch driver
//!   ([`apply_translated_bundle`]) supports **length-CHANGING** edits: a
//!   translated body longer or shorter than the source rewrites the
//!   10,000-slot scene offset table AND recalculates every goto-family
//!   jump-target pointer (`goto`/`goto_if`/`goto_on`/`goto_case`/`gosub*`/
//!   `farcall*`) by the cumulative byte delta of the splices before its
//!   destination — so a jump to opcode X still points to opcode X at its
//!   new offset. A jump landing strictly inside an edited body surfaces
//!   `kaifuu.reallive.patchback_goto_target_unresolvable` Fatal. Proven on
//!   Sweetie HD scene 8509 (91 goto pointers, longer + shorter bodies).
//! - KAIFUU-191 replaces the synthetic `0x23 ('#') opener + named opcode
//!   byte` shape with the **real** RealLive bytecode opener-byte switch
//!   documented in `docs/research/reallive-engine.md` §D and confirmed
//!   against Sweetie HD's decompressed scene 1 in
//!   `docs/research/reallive-sweetie-hd-encryption-mechanism.md` §4.2.
//!   The pre-KAIFUU-191 synthetic-opener path is deleted, not aliased.
//! - No `Command::new`, no Wine, no Windows helper, no remote helper.
//!   This crate is a pure function over `&[u8]`; the adapter (in
//!   `kaifuu-engine-fixture`) owns the filesystem I/O.
//!
//! # Surface
//!
//! - [`parse_archive`] — decode a SEEN.TXT archive envelope into a
//!   [`RealLiveSceneIndex`]. Out: per-scene `(byte_offset, byte_len)`
//!   ranges keyed by the 10,000-slot directory index ([`SceneEntry`]).
//! - [`parse_scene`] — decode a single **decompressed** scene-bytecode
//!   byte stream into the documented [`RealLiveOpcode`] sequence.
//! - [`parse_scene_into_ast`] — adapter that wraps [`parse_scene`] and
//!   builds the [`Scene`] tree consumed by the bundle-driven patchback
//!   driver.
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
//! # Scene bytecode (real RealLive opcode dispatch — KAIFUU-191)
//!
//! Scene payloads encountered in the archive carry the AVG32-compressed
//! header + bytecode. The caller decompresses the payload (the AVG32
//! LZSS + 256-byte XOR transform documented in
//! `docs/research/reallive-sweetie-hd-encryption-mechanism.md`) and
//! feeds the resulting plaintext bytecode bytes to [`parse_scene`].
//!
//! [`parse_scene`] performs the documented opener-byte switch:
//!
//! | Lead byte           | BytecodeElement   | Decoded as                                                   |
//! | ------------------- | ----------------- | ------------------------------------------------------------ |
//! | `0x00`              | CommaElement      | [`RealLiveOpcode::Comma`]                                    |
//! | `0x0A`              | MetaLine          | [`RealLiveOpcode::MetaLine`] (u16 LE line)                   |
//! | `0x21`              | MetaEntrypoint    | [`RealLiveOpcode::MetaEntrypoint`] (u16 LE)                  |
//! | `0x23`              | CommandElement    | 8-byte header + bracketed args; classified via module table  |
//! | `0x24`              | ExpressionElement | [`RealLiveOpcode::Expression`] (body preserved verbatim)     |
//! | `0x2C`              | CommaElement      | [`RealLiveOpcode::Comma`]                                    |
//! | `0x40`              | MetaKidoku        | [`RealLiveOpcode::MetaKidoku`] (u16 LE)                      |
//! | any other byte      | Textout           | [`RealLiveOpcode::Textout`] (text run to next opener)        |
//!
//! Command elements decode the 8-byte header
//! (`module_type`, `module_id`, `opcode_u16_le`, `argc`, `overload`),
//! parse their bracketed `ExpressionPiece` argument list with the real
//! [`opcode::parse_expression`] evaluator, consume any goto-family
//! trailing jump-target pointers, and classify into one of the
//! documented RLOperation families per the catalogue in [`opcode`].
//! Commands at an undocumented module surface as
//! [`RealLiveOpcode::Unknown`].
//!
//! A well-formed scene stream produces **zero** `Unknown` spans: every
//! byte is partitioned into a typed element (the catch-all being a
//! Textout run). Empty input is a
//! [`RealLiveParseError::TruncatedBytecode`] — never a silent
//! `Ok(vec![])`.

#![forbid(unsafe_code)]
#![deny(missing_debug_implementations)]

mod archive;
mod ast;
pub mod bridge;
pub mod compressor;
pub mod decompressor;
pub mod detector;
mod diagnostics;
pub mod encoding;
pub mod framing;
pub mod gameexe;
pub mod opcode;
mod opcodes;
mod parser;
pub mod patchback;
pub mod protected_spans;
pub mod scene_header;
pub mod scope;
mod strings;
#[cfg(test)]
mod test_fixtures;
pub mod xor2;

pub use archive::{
    REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN, REALLIVE_SEEN_TXT_SLOT_COUNT, RealLiveSceneIndex,
    SceneEntry, parse_archive,
};
pub use ast::{
    DiagnosticSeverity, Instruction, InstructionId, InstructionKind, Operand, ParseOutcome,
    ParseStatus, Scene, StringSlot, StringSlotId, StringSlotRef, StringSlotRole,
};
pub use bridge::{BridgeOpts, BridgeProduceError, ProducedBundle, produce_bundle};
pub use compressor::{CompressError, compress_avg32_literal};
pub use decompressor::{AVG32_COMPRESSED_PREAMBLE_LEN, DecompressError, decompress_avg32};
pub use detector::{
    REALLIVE_DATA_DIR_NAME, REALLIVE_DETECTOR_DEFAULT_MAX_DEPTH, RealLiveDetectError,
    RealLiveDetectionEvidence, detect as detect_reallive_data_dir,
    detect_with_max_depth as detect_reallive_data_dir_with_max_depth,
};
pub use diagnostics::{
    ParseDiagnostic, ParseDiagnosticCode, semantic_error_code_for_parser_diagnostic,
};
pub use encoding::{
    SHIFT_JIS_DECODE_FAILURE_CODE, ShiftJisDecode, ShiftJisDecodeDiagnostic, ShiftJisEncodeError,
    decode_shift_jis_slot, encode_shift_jis_slot, slice_control_bytes,
};
pub use framing::{FramingError, FramingSpan, framing_manifest, reemit_scene};
pub use gameexe::{
    GameexeIniDiagnostic, GameexeInventoryEntry, GameexeInventoryReport, GameexeKeyFamily,
    GameexeKeyTreatment, UNKNOWN_GAMEEXE_KEY_CODE, UnknownReason, parse_gameexe_inventory,
};
pub use opcode::{
    COMMAND_HEADER_LEN, CommandArg, Expr, GotoPointerSite, RealLiveOpcode, RealLiveParseError,
    TextEncoding, collect_goto_pointer_sites, decode_dialogue_textout,
    encode_choice_option_next_string_safe, is_recognized_opener, is_shift_jis_textout_lead,
    is_structural_opener, parse_expression, parse_real_bytecode, parse_real_bytecode_spans,
};
pub use opcodes::NamedOpcode;
pub use parser::{parse_scene, parse_scene_into_ast};
pub use patchback::bundle_driven::{
    PATCHBACK_ARCHIVE_PARSE_FAILURE_CODE, PATCHBACK_BUNDLE_SCHEMA_INVALID_CODE,
    PATCHBACK_COMPRESS_FAILURE_CODE, PATCHBACK_CONTROL_MARKUP_ONLY_TARGET_CODE,
    PATCHBACK_DECOMPRESS_FAILURE_CODE, PATCHBACK_GOTO_TARGET_UNRESOLVABLE_CODE,
    PATCHBACK_PROVENANCE_MISMATCH_CODE, PATCHBACK_SCENE_HEADER_INVALID_CODE,
    PATCHBACK_SCENE_PACKING_OVERFLOW_CODE, PATCHBACK_TARGET_ENCODE_FAILURE_CODE,
    PATCHBACK_TARGET_NONEMPTY_CODE, PatchbackEncoding, PatchbackError, PatchbackOpts,
    REALLIVE_OUT_OF_BAND_MARKER_OPEN, TranslatedBundleV02, TranslatedUnitTarget,
    apply_translated_bundle, strip_out_of_band_control_markup,
};
pub use protected_spans::{
    PROTECTED_SPAN_DECODED_RANGE_CODE, PROTECTED_SPAN_UNKNOWN_CONTROL_CODE, ProtectedSpanError,
    ProtectedSpanKind, ProtectedSpanReport, ProtectedSpanWarning, RealLiveProtectedSpan,
    detect_protected_spans,
};
pub use scene_header::{SCENE_HEADER_BYTE_LEN, SceneHeader, SceneHeaderError};
pub use scope::TranslationScope;
pub use xor2::{
    XOR2_KEY_LEN, XOR2_SEGMENT_LENGTH, XOR2_SEGMENT_OFFSET, Xor2Cipher, Xor2DecScene, Xor2Report,
    compiler_version_uses_xor2, recover_and_decrypt_archive, recover_archive_cipher,
};
