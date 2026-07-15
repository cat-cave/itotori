//! Real RealLive bytecode opcode dispatch.
//! Decodes the **real** RealLive scene-bytecode stream documented in
//! `docs/research/reallive-engine.md` §D and confirmed against Sweetie HD's
//! decompressed scene 1 in `docs/research/reallive-sweetie-hd-encryption-mechanism.md` §4.2.
//! Clean-room provenance:
//! - The opener-byte switch (`{0x00, 0x0A, 0x21, 0x23, 0x24, 0x2C, 0x40}`
//!   plus Shift-JIS lead bytes `0x81..=0x9F` / `0xE0..=0xFC`) and the
//!   8-byte `CommandElement` header layout
//!   (`module_type`, `module_id`, `opcode_u16_le`, `argc`, `overload`,
//!   `reserved`) are restated in our own words from the public RLDEV
//!   manual (Haeleth) and from rlvm's `src/libreallive/bytecode.{h,cc}`
//!   (research anchor only; rlvm is GPL-3, not linked or vendored).
//! - The RLOperation-family classification keys on the documented module
//!   catalogue (rlvm `src/modules/module_*.cc` names). No bytes are
//!   inferred from Sweetie HD alone — opcode handlers are documented
//!   per RLDEV/rlvm references per the audit-focus row.
//!   Scope:
//! - This module owns the **opener-byte + Command-header** dispatch and
//!   the full **ExpressionPiece evaluator** ([`parse_expression`]) that
//!   decodes `0x24` Expression elements and Command argument lists into
//!   typed [`Expr`] trees while computing their exact byte spans.
//! - Command elements consume their bracketed argument list and any
//!   goto-family trailing jump-target pointers (`docs/research/
//!   reallive-engine.md` §D + rlvm `bytecode.cc`), so the byte cursor
//!   stays aligned across the whole scene.
//! - Text strings carried in Command argument lists or in Textout elements
//!   are kept as raw Shift-JIS bytes; decoding is the
//!   [`crate::encoding`] surface's job.
//!   The decoder partitions **every** byte of a real Sweetie HD scene
//!   stream into a typed [`RealLiveOpcode`] element — the seven structural
//!   openers decode their element and every other byte begins a Textout
//!   run (the catch-all). Every in-space Command is further classified to a
//!   **semantic operation family** keyed on its `module_id` (control-flow,
//!   selection, message, system, audio, voice, graphics-background,
//!   display-object, screen, variable, memory). A well-formed, fully
//!   catalogued stream therefore yields **zero** [`RealLiveOpcode::Command`]
//!   (un-catalogued) and **zero** [`RealLiveOpcode::Unknown`] (desync
//!   tripwire) spans — the SEMANTIC 100%-decompilation bar (Utsushi cannot
//!   render a command it cannot identify). A scene that produces no opcodes
//!   is an error ([`RealLiveParseError::TruncatedBytecode`]), never a silent
//!   `Ok(vec!)`.

use std::{collections::BTreeMap, fmt};

use kaifuu_core::RedactedContentSummary;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::command_catalog::{is_catalogued_command_opcode, is_coverage_manifest_opcode};

/// BytecodeElement opener bytes (rlvm `bytecode.cc::BytecodeElement::Read`).
/// These are the seven structural lead bytes that mark the start of a
/// documented element in a decompressed RealLive scene stream. Any other
/// lead byte begins a Textout run ([`is_structural_opener`] is the
/// boundary predicate; Shift-JIS pairs are consumed whole).
pub mod opener {
    pub const META_COMMA: u8 = 0x00;
    pub const META_LINE: u8 = 0x0A;
    pub const META_ENTRYPOINT: u8 = 0x21;
    pub const COMMAND: u8 = 0x23;
    pub const EXPRESSION: u8 = 0x24;
    pub const COMMA: u8 = 0x2C;
    pub const META_KIDOKU: u8 = 0x40;
}

/// Width of the [`opener::COMMAND`] header (rlvm `bytecode.h:CommandElement`,
/// `command[COMMAND_SIZE] = 8`).
pub const COMMAND_HEADER_LEN: usize = 8;

/// Encoding tag carried by [`RealLiveOpcode::TextDisplay`].
/// The bytes in the operand stream are u16-LE-length-prefixed Shift-JIS;
/// downstream decode is owned by [`crate::encoding::decode_shift_jis_slot`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextEncoding {
    /// 16-bit little-endian length prefix followed by N bytes of Shift-JIS.
    ShiftJisLengthPrefixed,
    /// Raw Shift-JIS bytes (Textout element body — no length prefix; runs
    /// until the next opener byte).
    ShiftJisInlineRun,
}

/// One decoded RealLive bytecode opcode.
/// The variants are a unified view over both BytecodeElement-level
/// markers (Meta/Comma/Textout/Expression) and recognised RLOperation
/// Commands (`TextDisplay`, `Choice`, `Jump`,...). Commands that decode
/// structurally but do not match a documented operation family land in
/// [`RealLiveOpcode::Unknown`] with the original bytes preserved.
/// Provenance per variant:
/// - `MetaLine`/`MetaEntrypoint`/`MetaKidoku`/`Comma`/`Textout`/`Expression`
///   — opener-byte switch from rlvm `bytecode.cc::BytecodeElement::Read`.
/// - `TextDisplay`/`CharacterTextDisplay` — module_msg family (rlvm
///   `module_msg.cc`).
/// - `Choice`/`Branch` — module_sel family (rlvm `module_sel.cc`).
/// - `Jump`/`Goto`/`Call`/`Return`/`If` — module_jmp family (rlvm
///   `module_jmp.cc`).
/// - `Wait`/`End` — module_sys family (rlvm `module_sys.cc`).
/// - `Background` — module_grp family (rlvm `module_grp.cc`).
/// - `Audio` — module_bgm / module_se / module_pcm channels.
/// - `VoicePlay` — module_koe family (rlvm `module_koe.cc`).
/// - `SetVariable` — module_mem family (rlvm `module_mem.cc`).
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RealLiveOpcode {
    /// `0x0A` MetaLine — source-line number marker. 3 bytes total
    /// (`0x0A` + u16-LE line number).
    MetaLine { line: u16 },
    /// `0x21` MetaEntrypoint — entrypoint marker. 3 bytes total
    /// (`0x21` + u16-LE entrypoint index).
    MetaEntrypoint { entrypoint: u16 },
    /// `0x40` MetaKidoku — read-tracking marker. 3 bytes total
    /// (`0x40` + u16-LE kidoku index).
    MetaKidoku { mark: u16 },
    /// `0x00` or `0x2C` comma separator. 1 byte.
    Comma,
    /// Inline Shift-JIS text run (lead byte `0x81..=0x9F` or `0xE0..=0xFC`).
    /// Bytes are preserved verbatim and run until the next opener byte.
    Textout {
        encoding: TextEncoding,
        raw_bytes: Vec<u8>,
    },
    /// `0x24` ExpressionElement — variable expression. `raw_bytes` are
    /// the body bytes after the opener; the element's exact span is
    /// computed by the [`parse_expression`] evaluator (call it on the
    /// element bytes for the typed [`Expr`] tree).
    Expression { raw_bytes: Vec<u8> },

    /// `module_msg` text-display Command (recognised).
    TextDisplay { encoding: TextEncoding },
    /// `module_msg` character-text Command (recognised).
    CharacterTextDisplay,
    /// `module_sel` choice Command (`select`/`select_s`/`select_w`).
    /// Each option carries its **scene-relative byte offset** (where the
    /// option's editable bytes begin inside the decompressed scene
    /// bytecode) so the length-preserving patch-back splice target is the
    /// option text itself, never the command opener. See [`CommandArg`].
    Choice { choices: Vec<CommandArg> },
    /// `module_jmp` conditional branch (`goto_if`/`goto_unless`).
    Branch,
    /// `module_jmp` `jump` (cross-scene long jump).
    Jump,
    /// `module_jmp` `goto` (intra-scene local jump).
    Goto,
    /// `module_jmp` `gosub`/`farcall` (subroutine call).
    Call,
    /// `module_jmp` `ret`/`ret_with`/`rtl`.
    Return,
    /// `module_sys` `wait` (longop pause with a duration in milliseconds
    /// — argument decoded from the Command argument list). The literal is
    /// surfaced at its full `i32` range: RealLive wait durations routinely
    /// exceed `u16::MAX` (a 2-minute pause is 120000 ms) and the engine
    /// also accepts negative/relative forms, so narrowing to `u16` via
    /// `unsigned_abs` would silently corrupt the decompiled value.
    Wait { duration_ms: i32 },
    /// `module_grp` `openBg`/`load` (background sprite load — the
    /// argument is the u32 sprite id pulled from the Command argument
    /// list).
    Background { sprite_id: u32 },
    /// `module_koe` `koePlay`/`koePlayInChar` (the argument is the u32
    /// `(archive_id, sample_id)` voice id pulled from the Command
    /// argument list).
    VoicePlay { voice_id: u32 },
    /// `module_mem` `setarray`/`setrng`/`cpyvars` (any variable bank
    /// write).
    SetVariable,
    /// `module_jmp` `goto_case`/`goto_on` (tabular dispatch — recorded
    /// as `If` because the spec lists `If` rather than `Switch`).
    If,
    /// `module_sys` `end` (scene terminator).
    End,

    /// `module_sel` selection-button setup / state command (non-dialogue:
    /// `select_objbtn`, `objbtn_init`, button enable / clear / position).
    /// The translatable `select*` option blocks decode to [`Self::Choice`];
    /// these configure the on-screen selection buttons and carry no
    /// dialogue. `opcode` selects the specific button operation.
    SelectionControl { opcode: u16 },
    /// `module_msg` text-window directive (non-dialogue): page / line-break /
    /// clear / face-window / text-position / colour / name-window control.
    /// These steer how the following dialogue renders but carry no
    /// translatable body themselves. `opcode` selects the window operation.
    MessageControl { opcode: u16 },
    /// `module_sys` engine / system control & query: title, screen mode,
    /// message speed, save / load triggers, rng, math, scene / menu state,
    /// timers. `opcode` selects the specific system call.
    SystemControl { opcode: u16 },
    /// `module_str`-class indexed variable / flag operation (module id 10):
    /// every opcode operates on a single integer memory-bank reference
    /// (assignment / query / counter — the uniform single-`memref` arg model
    /// observed on both archives). `opcode` selects the operation.
    VariableOp { opcode: u16 },
    /// Audio playback control (`module_bgm` / `module_se` / `module_pcm`
    /// channels, module ids 20 / 21 / 22): play (by filename) / stop / fade /
    /// volume. `module_id` selects the channel, `opcode` the operation.
    Audio { module_id: u8, opcode: u16 },
    /// Screen / frame / weather / animation-layer control (module ids
    /// 30 / 31 / 40 / 60 / 61 / 62): the graphics-pipeline operations that act
    /// on the whole screen or an effect layer rather than a single object.
    /// `module_id` / `opcode` select the operation.
    ScreenControl { module_id: u8, opcode: u16 },
    /// Display-object (sprite-plane) operation — foreground / background /
    /// child object modules (ids 71 / 72 / 73 / 81 / 82 / 84 / 85 / 90 / 91, in
    /// both the single `module_type = 1` and range `module_type = 2` forms):
    /// object load (`objOfFile`), position / scale / rotation / alpha / order
    /// setters and getters, allocation, animation. `module_id` selects the
    /// plane / category, `opcode` the operation. The composited object is
    /// what Utsushi must render, so this is a first-class family, never a
    /// generic blob.
    GraphicsObject { module_id: u8, opcode: u16 },

    /// A structurally-decoded in-space Command whose `(module_type,
    /// module_id, opcode)` tuple is **not yet catalogued** to a semantic
    /// family above. The 8-byte header and the bracketed argument list are
    /// fully parsed into typed [`CommandArg`] slots, but the operation has no
    /// semantic meaning assigned — so it is **not recognised**
    /// ([`Self::is_recognized`] returns `false`) and FAILS the full-archive
    /// semantic-zero gate. It exists only as the typed fallback for a tuple
    /// the catalogue has not reached; on the proven corpora (Sweetie HD,
    /// Kanon) it never occurs. Utsushi cannot render a command it cannot
    /// semantically identify, so this blob is deliberately gated, not
    /// accepted.
    Command {
        module_type: u8,
        module_id: u8,
        opcode: u16,
        overload: u8,
        args: Vec<CommandArg>,
    },

    /// A Command whose `(module_type, module_id, opcode)` tuple is
    /// structurally implausible — `module_type > 2`, outside RealLive's
    /// documented `{0, 1, 2}` module-type space. In a well-framed scene
    /// this never occurs; its presence means the cursor desynced and is
    /// reading arbitrary bytes as a command header, so it is preserved
    /// (`opcode` = `0x23`, `raw_bytes` = the consumed span) as a hard
    /// tripwire rather than silently coalesced into [`Self::Command`].
    Unknown { opcode: u8, raw_bytes: Vec<u8> },
}

/// One argument slot from a Command's bracketed `(...)` argument list,
/// paired with the **scene-relative byte offset** where the slot's bytes
/// begin in the decompressed scene bytecode.
/// The offset is authoritative for length-preserving patch-back: a
/// `module_sel` Choice option's editable bytes live HERE, inside the
/// argument list (after the 8-byte Command header and the `(`), never at
/// the command opener. Carrying the offset on every parsed arg means the
/// Scene-AST projection in `parser.rs` can stamp each Choice slot's
/// `byte_offset_within_scene` at the option's real bytes instead of at the
/// opcode header — the latter would make a slot-keyed splice land on the
/// opcode header and structurally corrupt the scene.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandArg {
    /// Scene-relative byte offset where this argument's bytes begin.
    pub byte_offset: u64,
    /// The argument's raw bytes (Shift-JIS text run, expression bytes, or
    /// empty for an interior `,,` slot).
    pub bytes: Vec<u8>,
}

impl fmt::Debug for CommandArg {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let bytes = RedactedContentSummary::from_bytes(&self.bytes);
        formatter
            .debug_struct("CommandArg")
            .field("byte_offset", &self.byte_offset)
            .field("bytes", &bytes)
            .finish()
    }
}

impl fmt::Debug for RealLiveOpcode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut debug = formatter.debug_struct("RealLiveOpcode");
        debug.field("label", &self.label());
        match self {
            Self::Textout {
                encoding,
                raw_bytes,
            } => {
                debug
                    .field("encoding", encoding)
                    .field("raw_bytes", &RedactedContentSummary::from_bytes(raw_bytes));
            }
            Self::Expression { raw_bytes } => {
                debug.field("raw_bytes", &RedactedContentSummary::from_bytes(raw_bytes));
            }
            Self::Choice { choices } => {
                debug.field("choices", choices);
            }
            Self::Command {
                module_type,
                module_id,
                opcode,
                overload,
                args,
            } => {
                debug
                    .field("module_type", module_type)
                    .field("module_id", module_id)
                    .field("opcode", opcode)
                    .field("overload", overload)
                    .field("args", args);
            }
            Self::Unknown { opcode, raw_bytes } => {
                debug
                    .field("opcode", opcode)
                    .field("raw_bytes", &RedactedContentSummary::from_bytes(raw_bytes));
            }
            _ => {}
        }
        debug.finish()
    }
}

impl RealLiveOpcode {
    /// `true` if this variant is a **semantically-typed** classification —
    /// every structural marker and every command mapped to a named operation
    /// family. It is `false` only for the two non-semantic variants:
    /// [`RealLiveOpcode::Command`] (an in-space tuple not yet catalogued to a
    /// family) and [`RealLiveOpcode::Unknown`] (the `module_type > 2` desync
    /// tripwire). The full-archive gate requires zero of either: Utsushi
    /// cannot render a command it cannot semantically identify, so an
    /// un-catalogued tuple must FAIL recognition rather than masquerade as
    /// decoded.
    pub fn is_recognized(&self) -> bool {
        !matches!(self, Self::Command { .. } | Self::Unknown { .. })
    }

    /// Stable serde label (snake_case discriminant string), useful for
    /// histogram diagnostics.
    pub fn label(&self) -> &'static str {
        match self {
            Self::MetaLine { .. } => "meta_line",
            Self::MetaEntrypoint { .. } => "meta_entrypoint",
            Self::MetaKidoku { .. } => "meta_kidoku",
            Self::Comma => "comma",
            Self::Textout { .. } => "textout",
            Self::Expression { .. } => "expression",
            Self::TextDisplay { .. } => "text_display",
            Self::CharacterTextDisplay => "character_text_display",
            Self::Choice { .. } => "choice",
            Self::Branch => "branch",
            Self::Jump => "jump",
            Self::Goto => "goto",
            Self::Call => "call",
            Self::Return => "return",
            Self::Wait { .. } => "wait",
            Self::Background { .. } => "background",
            Self::VoicePlay { .. } => "voice_play",
            Self::SetVariable => "set_variable",
            Self::If => "if",
            Self::End => "end",
            Self::SelectionControl { .. } => "selection_control",
            Self::MessageControl { .. } => "message_control",
            Self::SystemControl { .. } => "system_control",
            Self::VariableOp { .. } => "variable_op",
            Self::Audio { .. } => "audio",
            Self::ScreenControl { .. } => "screen_control",
            Self::GraphicsObject { .. } => "graphics_object",
            Self::Command { .. } => "command",
            Self::Unknown { .. } => "unknown",
        }
    }

    /// The `(module_type, module_id, opcode)` signature of a single
    /// **un-recognised** opcode, or `None` for a recognised one.
    /// This is the exact tuple a decode-honesty consumer (the `extract`
    /// 100%-decode gate, the multi-corpus coverage harness) reports so a
    /// regression names the precise un-catalogued command instead of a bare
    /// aggregate count. The two un-recognised variants are extracted with the
    /// SAME rule so the CLI report and the real-bytes gate agree byte-for-byte:
    /// - [`RealLiveOpcode::Command`] — the un-catalogued in-space tuple, taken
    ///   directly from its parsed header fields.
    /// - [`RealLiveOpcode::Unknown`] — the `module_type > 2` desync tripwire,
    ///   reconstructed from the preserved raw command header (`raw_bytes[1]` =
    ///   module_type, `raw_bytes[2]` = module_id, `raw_bytes[3..5]` = the
    ///   little-endian opcode) when the header is intact.
    ///   Recognised variants (`is_recognized` is `true`) return `None`.
    pub fn unrecognized_signature(&self) -> Option<(u8, u8, u16)> {
        match self {
            Self::Command {
                module_type,
                module_id,
                opcode,
                ..
            } => Some((*module_type, *module_id, *opcode)),
            Self::Unknown { opcode, raw_bytes }
                if *opcode == opener::COMMAND && raw_bytes.len() >= 5 =>
            {
                Some((
                    raw_bytes[1],
                    raw_bytes[2],
                    u16::from_le_bytes([raw_bytes[3], raw_bytes[4]]),
                ))
            }
            _ => None,
        }
    }
}

/// Aggregate the `(module_type, module_id, opcode) -> count` histogram of every
/// opcode in `opcodes` that fails [`RealLiveOpcode::is_recognized`].
/// This is the single shared source of the un-recognised-opcode tuple list: the
/// `kaifuu extract` decode-honesty gate and the multi-corpus coverage harness
/// both aggregate over [`RealLiveOpcode::unrecognized_signature`] so a green
/// CLI exit and a green real-bytes gate mean the identical thing — zero
/// un-catalogued tuples. An empty map means a fully-recognised (100%-decoded)
/// opcode stream.
pub fn unrecognized_opcode_histogram(opcodes: &[RealLiveOpcode]) -> BTreeMap<(u8, u8, u16), usize> {
    let mut histogram = BTreeMap::new();
    for op in opcodes {
        if let Some(signature) = op.unrecognized_signature() {
            *histogram.entry(signature).or_insert(0) += 1;
        }
    }
    histogram
}

/// Decoder error surface. Typed; no `unwrap` clusters in production.
#[derive(Clone, PartialEq, Eq, Error, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum RealLiveParseError {
    /// The bytecode stream was empty or produced no opcodes — silent
    /// zero-state is never accepted.
    #[error(
        "kaifuu.reallive.truncated_bytecode: scene stream produced no opcodes (input_len={input_len})"
    )]
    TruncatedBytecode { input_len: usize },
    /// A Meta element header ran past the end of the stream.
    #[error(
        "kaifuu.reallive.truncated_meta_header: meta header at offset {offset} needs {needed} bytes, {available} available"
    )]
    TruncatedMetaHeader {
        opener: u8,
        offset: u64,
        needed: usize,
        available: usize,
    },
    /// A Command element's 8-byte header ran past the end of the stream.
    #[error(
        "kaifuu.reallive.truncated_command_header: command at offset {offset} needs {COMMAND_HEADER_LEN} bytes, {available} available"
    )]
    TruncatedCommandHeader { offset: u64, available: usize },
    /// A Command element's argument list ran past the end of the stream.
    #[error(
        "kaifuu.reallive.truncated_command_args: command at offset {offset} declared argc={argc} but argument bytes ran out"
    )]
    TruncatedCommandArgs { offset: u64, argc: u16 },
    /// A Shift-JIS Textout run failed length-prefix validation. Surfaced
    /// for malformed length-prefixed strings; inline Textout runs that
    /// run to the next opener byte cannot produce this.
    #[error(
        "kaifuu.reallive.invalid_length_prefix: length-prefixed string at offset {offset} declares len={declared} but only {available} bytes remain"
    )]
    InvalidLengthPrefix {
        offset: u64,
        declared: usize,
        available: usize,
    },
    /// An ExpressionPiece ran past the end of the stream mid-token.
    #[error(
        "kaifuu.reallive.truncated_expression: expression token at offset {offset} ran past end of stream"
    )]
    TruncatedExpression { offset: u64 },
    /// An ExpressionPiece byte did not match any documented token /
    /// operator form (a structurally invalid expression, not merely an
    /// unrecognised opcode).
    #[error(
        "kaifuu.reallive.malformed_expression: invalid ExpressionPiece token at offset {offset}"
    )]
    MalformedExpression { offset: u64, byte: u8 },
}

impl fmt::Debug for RealLiveParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TruncatedBytecode { input_len } => formatter
                .debug_struct("TruncatedBytecode")
                .field("input_len", input_len)
                .finish(),
            Self::TruncatedMetaHeader {
                opener,
                offset,
                needed,
                available,
            } => formatter
                .debug_struct("TruncatedMetaHeader")
                .field("opener", &RedactedContentSummary::from_bytes(&[*opener]))
                .field("offset", offset)
                .field("needed", needed)
                .field("available", available)
                .finish(),
            Self::TruncatedCommandHeader { offset, available } => formatter
                .debug_struct("TruncatedCommandHeader")
                .field("offset", offset)
                .field("available", available)
                .finish(),
            Self::TruncatedCommandArgs { offset, argc } => formatter
                .debug_struct("TruncatedCommandArgs")
                .field("offset", offset)
                .field("argc", argc)
                .finish(),
            Self::InvalidLengthPrefix {
                offset,
                declared,
                available,
            } => formatter
                .debug_struct("InvalidLengthPrefix")
                .field("offset", offset)
                .field("declared", declared)
                .field("available", available)
                .finish(),
            Self::TruncatedExpression { offset } => formatter
                .debug_struct("TruncatedExpression")
                .field("offset", offset)
                .finish(),
            Self::MalformedExpression { offset, byte } => formatter
                .debug_struct("MalformedExpression")
                .field("offset", offset)
                .field("byte", &RedactedContentSummary::from_bytes(&[*byte]))
                .finish(),
        }
    }
}

/// Module-id catalogue keys (rlvm `src/modules/module_*.cc` names).
/// Sub-module ids inside `module_type=1` (Kepago — the primary
/// RLOperation namespace) follow rlvm's published indexing. The keys
/// below are the subset needed for the Sweetie HD scene 1 alpha; richer
/// coverage is.
mod module_id {
    /// `module_sys.cc` — system control (`end`, `wait`, `pause`, save/load).
    pub const SYS: u8 = 4;
    /// `module_mem.cc` — memory / array bulk (`setarray`, `setrng`).
    pub const MEM: u8 = 11;
    /// `module_jmp.cc` — control flow (`goto`, `gosub`, `ret`, `jump`).
    pub const JMP: u8 = 1;
    /// `module_sel.cc` — selection / selection-button management (the
    /// translatable `select*` blocks decode to `Choice` upstream of the
    /// classifier; this id covers the non-dialogue button ops).
    pub const SEL: u8 = 2;
    /// `module_msg.cc` — text / messaging (`pause`, `br`, `page`,
    /// `FontColor`, `FastText`).
    pub const MSG: u8 = 3;
    /// `module_sys.cc` second registration id observed on Sweetie HD /
    /// Kanon — system-class control sharing `module_sys` semantics.
    pub const SYS2: u8 = 5;
    /// `module_str.cc`-class indexed variable / flag module — every opcode
    /// carries a single integer memory-bank reference operand.
    pub const STR: u8 = 10;
    /// `module_bgm.cc` / `module_se.cc` / `module_pcm.cc` audio channels.
    pub const AUDIO_BGM: u8 = 20;
    pub const AUDIO_SE: u8 = 21;
    pub const AUDIO_PCM: u8 = 22;
    /// `module_grp.cc` — graphics primitives (`load`, `openBg`, `fade`).
    pub const GRP: u8 = 33;
    /// `module_koe.cc` — voice playback.
    pub const KOE: u8 = 23;
}

/// True if `byte` starts a Shift-JIS Textout run per RLDEV documentation
/// (Shift-JIS first-byte ranges).
pub fn is_shift_jis_textout_lead(byte: u8) -> bool {
    (0x81..=0x9F).contains(&byte) || (0xE0..=0xFC).contains(&byte)
}

/// Decode a catch-all Textout run as **readable Shift-JIS dialogue**,
/// returning the decoded UTF-8 string when (and only when) the run is a
/// real, translatable dialogue line — and `None` for a run that is instead
/// an embedded binary / control-byte data table the catch-all decoder swept
/// up.
/// # Why this exists
/// rlvm's `BytecodeElement::Read` (mirrored by [`decode_element`]) treats
/// every non-structural lead byte as the start of a Textout run. That is
/// faithful to the engine, but [`RealLiveOpcode::Textout`] is the decoder's
/// **catch-all**, not a semantic dialogue opcode: a Textout run can carry
/// one of two very different payloads:
/// 1. **Readable dialogue** — a Shift-JIS line the player sees and a
///    translator must rewrite. The bridge surfaces it as a translatable
///    unit; a translate+patchback run rewrites those bytes.
/// 2. **Embedded binary data** — a packed table the engine reads as raw
///    bytes, never as text (e.g. a periodic-record block sitting after a
///    second `MetaEntrypoint`). Surfacing it would let patchback overwrite
///    the table and corrupt the scene.
/// # The invariant: valid decode **and** no control bytes
/// The decision is NOT a byte-ratio guess. A run is dialogue iff it
/// satisfies BOTH invariants:
/// - it decodes as Shift-JIS with **zero decode errors** (no `U+FFFD`
///   replacement characters) — a packed binary table reliably hits byte
///   sequences that are not valid Shift-JIS; and
/// - the decoded text carries **no control characters** ([`char::is_control`]
///   — `U+0000..=U+001F` / `U+007F..=U+009F`). A low-byte binary block can
///   decode with zero replacement errors yet still resolve to C0 control
///   characters; the valid-decode gate alone let those mislabel as dialogue.
///   Real dialogue contains none — its line breaks are `MetaLine` opcodes
///   (structural openers that terminate the run), never inline bytes.
///   The bridge producer and the patchback re-walk that must stay
///   index-aligned with it share this one decision, so both paths surface and
///   skip the identical set of runs. An empty run is not dialogue.
pub fn decode_dialogue_textout(raw_bytes: &[u8]) -> Option<String> {
    if raw_bytes.is_empty() {
        return None;
    }
    let (decoded, _encoding, had_errors) = encoding_rs::SHIFT_JIS.decode(raw_bytes);
    if had_errors {
        return None;
    }
    if decoded.chars().any(char::is_control) {
        return None;
    }
    Some(decoded.into_owned())
}

/// True if `byte` is one of the seven structural BytecodeElement opener
/// bytes (`0x00`, `0x0A`, `0x21`, `0x23`, `0x24`, `0x2C`, `0x40`).
/// These are the only bytes that begin a non-text element; every other
/// byte is the start (or continuation) of a Textout run. A Textout run
/// terminates at the first structural opener — Shift-JIS lead bytes are
/// *not* in this set because they continue a text run rather than end it.
pub fn is_structural_opener(byte: u8) -> bool {
    matches!(
        byte,
        opener::META_COMMA
            | opener::META_LINE
            | opener::META_ENTRYPOINT
            | opener::COMMAND
            | opener::EXPRESSION
            | opener::COMMA
            | opener::META_KIDOKU
    )
}

/// ExpressionPiece operator-introducer byte (`\`, `0x5C`).
/// Per `docs/research/reallive-engine.md` §G and rlvm
/// `libreallive/expression.cc`, every unary and binary operator in a
/// compiled RealLive expression is introduced by `0x5C` followed by a
/// single op-code byte (arithmetic `0x00..=0x09`, compound-assignment
/// `0x14..=0x26`, comparison `0x28..=0x2D`, logical `0x3C`/`0x3D`).
const EXPR_OP_PREFIX: u8 = 0x5C;
/// ExpressionPiece integer-literal introducer (`0xFF`); followed by 4
/// bytes of `i32` little-endian. Integer literals also appear in the
/// `$`-prefixed form (`0x24 0xFF` + 4 bytes) emitted by the compiler.
const EXPR_INT_LITERAL: u8 = 0xFF;
/// ExpressionPiece store-register reference (`0xC8`).
const EXPR_STORE_REGISTER: u8 = 0xC8;
/// Memory-reference index open / close brackets (`[` `]`).
const EXPR_INDEX_OPEN: u8 = 0x5B;
const EXPR_INDEX_CLOSE: u8 = 0x5D;
/// Sub-expression grouping parentheses (`(` `)`).
const EXPR_PAREN_OPEN: u8 = 0x28;
const EXPR_PAREN_CLOSE: u8 = 0x29;
/// Memory-/`$`-reference prefix (`$`, `0x24`). Shares its value with the
/// [`opener::EXPRESSION`] element opener — at the start of an Expression
/// element the `0x24` opener doubles as the `$` of the first token.
const EXPR_DOLLAR: u8 = 0x24;
/// Special-parameter introducer (`a`, `0x61`) — rlvm
/// `libreallive/expression.cc` `SpecialExpressionPiece`. A special
/// parameter is `0x61 <tag> <data-item>`, where `<tag>` is a single byte
/// (or `0xFF`+`i32` when wide) and `<data-item>` is the contained value
/// (in practice a complex `(…)` group). Used by the variadic
/// object/graphics multi-commands (`objBgMulti`, selection-button tables)
/// to attach a discriminant tag to each grouped parameter set.
const EXPR_SPECIAL: u8 = 0x61;

/// A fully-decoded RealLive ExpressionPiece (RLDEV / rlvm
/// `libreallive/expression.cc` grammar, restated in our own words).
/// This is the typed output of [`parse_expression`]: every byte of a
/// well-formed expression maps to one of these nodes. The decoder uses
/// the parse both to evaluate the expression's structure and to compute
/// the exact byte span an Expression element / Command argument occupies,
/// so the bytecode stream stays aligned with zero residual unknown bytes.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "node", rename_all = "snake_case")]
pub enum Expr {
    /// `0xFF`+i32 (or `$ 0xFF`+i32) integer literal.
    IntLiteral { value: i32 },
    /// `0xC8` store-register reference.
    StoreRegister,
    /// `<bank> [ <index> ]` memory-bank reference. `bank` is the single
    /// bank-selector byte (`docs/research/reallive-engine.md` §G).
    MemoryRef { bank: u8, index: Box<Expr> },
    /// `\<op>` binary operator joining two operands.
    Binary {
        op: u8,
        lhs: Box<Expr>,
        rhs: Box<Expr>,
    },
    /// `\<op>` unary operator prefixing one operand.
    Unary { op: u8, operand: Box<Expr> },
    /// `(<item> <item>*)` complex parameter — a parenthesised **sequence**
    /// of data items (rlvm `ComplexExpressionPiece`). A plain parenthesised
    /// arithmetic sub-expression `(<expr>)` is the one-item case: its sole
    /// item is the operator-chained expression, so the same node and byte
    /// width cover both grouping and complex-parameter forms.
    Complex { items: Vec<Expr> },
    /// `0x61 <tag> <item>` special parameter (rlvm `SpecialExpressionPiece`):
    /// a tagged wrapper around a contained data item (usually a `Complex`).
    SpecialParam { tag: i32, content: Box<Expr> },
    /// A string operand (quoted or bare identifier) carried in an
    /// argument list; bytes preserved verbatim (downstream Shift-JIS
    /// decode is [`crate::encoding`]'s job).
    StrLiteral { raw_bytes: Vec<u8> },
}

impl fmt::Debug for Expr {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::IntLiteral { value } => formatter
                .debug_struct("IntLiteral")
                .field("value", value)
                .finish(),
            Self::StoreRegister => formatter.write_str("StoreRegister"),
            Self::MemoryRef { bank, index } => formatter
                .debug_struct("MemoryRef")
                .field("bank", bank)
                .field("index", index)
                .finish(),
            Self::Binary { op, lhs, rhs } => formatter
                .debug_struct("Binary")
                .field("op", op)
                .field("lhs", lhs)
                .field("rhs", rhs)
                .finish(),
            Self::Unary { op, operand } => formatter
                .debug_struct("Unary")
                .field("op", op)
                .field("operand", operand)
                .finish(),
            Self::Complex { items } => formatter
                .debug_struct("Complex")
                .field("items", items)
                .finish(),
            Self::SpecialParam { tag, content } => formatter
                .debug_struct("SpecialParam")
                .field("tag", tag)
                .field("content", content)
                .finish(),
            Self::StrLiteral { raw_bytes } => formatter
                .debug_struct("StrLiteral")
                .field("raw_bytes", &RedactedContentSummary::from_bytes(raw_bytes))
                .finish(),
        }
    }
}

/// Read a little-endian `i32` at `pos`, erroring if fewer than 4 bytes
/// remain.
fn read_i32_le(bytes: &[u8], pos: usize) -> Result<i32, RealLiveParseError> {
    if pos + 4 > bytes.len() {
        return Err(RealLiveParseError::TruncatedExpression { offset: pos as u64 });
    }
    Ok(i32::from_le_bytes([
        bytes[pos],
        bytes[pos + 1],
        bytes[pos + 2],
        bytes[pos + 3],
    ]))
}

/// `true` if `byte` opens an arithmetic-expression token (rlvm
/// `GetExpressionToken`): an integer literal (`0xFF`), the store register
/// (`0xC8`), a `$`-prefixed memory reference / typed literal, or a `\`
/// operator. Every *other* lead byte at a data position is a string
/// constant (a bare identifier or `"`-quoted run) — there is **no**
/// "any byte followed by `[`" memory-reference form: a real memory
/// reference is always `$`-prefixed, so a quoted string that happens to
/// begin with `[` is never misread as a bank reference.
fn is_expr_token_lead(byte: u8) -> bool {
    matches!(
        byte,
        EXPR_INT_LITERAL | EXPR_STORE_REGISTER | EXPR_DOLLAR | EXPR_OP_PREFIX
    )
}

/// `true` if `byte` opens a **non-string** data item — a complex parameter
/// (`(`), a special parameter (`0x61`), or an arithmetic-expression token
/// (`0xFF` / `0xC8` / `$` / `\`). String constants are deliberately
/// excluded: this set is used to disambiguate a special parameter from a
/// bare string that merely begins with `0x61`.
fn is_nonstring_data_lead(byte: u8) -> bool {
    matches!(byte, EXPR_PAREN_OPEN | EXPR_SPECIAL) || is_expr_token_lead(byte)
}

/// `true` if `pos` begins a special parameter (`0x61 <tag> <item>`).
/// The compiler emits a special parameter as the `0x61` introducer, a tag
/// (a single byte, or `0xFF`+`i32` in the wide form), and then its contained
/// data item — across the Sweetie HD and Kanon archives that item is always
/// a complex `(` group or a `$`-prefixed memory / literal reference, i.e. a
/// **non-string** data lead. Requiring that lead disambiguates a genuine
/// special parameter from a bare string constant that merely begins with the
/// byte `0x61` (`'a'`): such a string's following byte is another string
/// byte or a delimiter, never a complex / expression lead.
fn is_special_param_lead(bytes: &[u8], pos: usize) -> bool {
    if bytes.get(pos) != Some(&EXPR_SPECIAL) {
        return false;
    }
    let content_pos = match bytes.get(pos + 1) {
        // Wide tag: `0x61 0xFF <i32> <item>`.
        Some(&EXPR_INT_LITERAL) => pos + 6,
        // Single-byte tag: `0x61 <tag> <item>`.
        Some(_) => pos + 2,
        None => return false,
    };
    bytes
        .get(content_pos)
        .copied()
        .is_some_and(is_nonstring_data_lead)
}

/// Parse a single **data item** at `pos` (rlvm `libreallive/expression.cc`
/// `GetData`): the unit an argument slot, a complex-parameter element, or a
/// special-parameter content is composed of. Exactly one of:
/// - a special parameter (`0x61` …);
/// - a complex parameter (`(…)`);
/// - an arithmetic expression (`$`-mem / literal / store / `\`-operator
///   chain, including a parenthesised group as its leading term);
/// - a string constant (any other lead byte → a bare / `"`-quoted run).
///   Returns the typed node and the exact number of bytes consumed so the
///   caller keeps the stream byte-aligned.
fn parse_data(bytes: &[u8], pos: usize) -> Result<(Expr, usize), RealLiveParseError> {
    match bytes.get(pos) {
        None => Err(RealLiveParseError::TruncatedExpression { offset: pos as u64 }),
        Some(&EXPR_SPECIAL) if is_special_param_lead(bytes, pos) => parse_special_param(bytes, pos),
        Some(&EXPR_PAREN_OPEN) => parse_complex(bytes, pos),
        Some(&b) if is_expr_token_lead(b) => parse_expression(bytes, pos),
        Some(&b) => {
            let len = string_operand_len(bytes, pos);
            if len == 0 {
                return Err(RealLiveParseError::MalformedExpression {
                    offset: pos as u64,
                    byte: b,
                });
            }
            Ok((
                Expr::StrLiteral {
                    raw_bytes: bytes[pos..pos + len].to_vec(),
                },
                len,
            ))
        }
    }
}

/// Parse a complex parameter `(<item> <item>*)` at `pos` (which must
/// point at the `(`) — rlvm `ComplexExpressionPiece`. The contained items
/// are a back-to-back **sequence** of [`parse_data`] values (no comma is
/// required between them; a stray `,` or inline `\n` line marker is
/// tolerated as a separator). The one-item case is exactly a parenthesised
/// arithmetic sub-expression, so this single routine covers both grouping
/// and complex-parameter forms.
fn parse_complex(bytes: &[u8], pos: usize) -> Result<(Expr, usize), RealLiveParseError> {
    let mut cursor = pos + 1; // skip '('
    let mut items: Vec<Expr> = Vec::new();
    loop {
        match bytes.get(cursor) {
            None => return Err(RealLiveParseError::TruncatedExpression { offset: pos as u64 }),
            Some(&EXPR_PAREN_CLOSE) => {
                cursor += 1;
                break;
            }
            // Tolerated inter-item separators inside a complex param.
            Some(&opener::COMMA) => cursor += 1,
            Some(&opener::META_LINE) => cursor += 3,
            Some(&b) => {
                let (item, len) = parse_data(bytes, cursor)?;
                if len == 0 {
                    return Err(RealLiveParseError::MalformedExpression {
                        offset: cursor as u64,
                        byte: b,
                    });
                }
                items.push(item);
                cursor += len;
            }
        }
    }
    Ok((Expr::Complex { items }, cursor - pos))
}

/// Parse a special parameter `0x61 <tag> <item>` at `pos` (which must point
/// at the `0x61` introducer) — rlvm `SpecialExpressionPiece`. `<tag>` is a
/// single discriminant byte, or `0xFF`+`i32` in the wide form; `<item>` is
/// the contained [`parse_data`] value (in practice a `Complex` group).
fn parse_special_param(bytes: &[u8], pos: usize) -> Result<(Expr, usize), RealLiveParseError> {
    let (tag, tag_len) = match bytes.get(pos + 1) {
        Some(&EXPR_INT_LITERAL) => (read_i32_le(bytes, pos + 2)?, 5),
        Some(&t) => (i32::from(t), 1),
        None => return Err(RealLiveParseError::TruncatedExpression { offset: pos as u64 }),
    };
    let (content, content_len) = parse_data(bytes, pos + 1 + tag_len)?;
    Ok((
        Expr::SpecialParam {
            tag,
            content: Box::new(content),
        },
        1 + tag_len + content_len,
    ))
}

/// Parse a single ExpressionPiece **token** at `pos` — the lowest
/// arithmetic grammar level: integer literal (`0xFF` / `$ 0xFF`), store
/// register (`0xC8`), or `$`-prefixed memory reference `$ <bank> [ <index> ]`.
/// Any other lead byte is a structurally invalid arithmetic token
/// ([`RealLiveParseError::MalformedExpression`]) — string constants and
/// complex / special parameters are handled one level up by [`parse_data`].
fn parse_token(bytes: &[u8], pos: usize) -> Result<(Expr, usize), RealLiveParseError> {
    let Some(&b) = bytes.get(pos) else {
        return Err(RealLiveParseError::TruncatedExpression { offset: pos as u64 });
    };
    match b {
        EXPR_INT_LITERAL => {
            let value = read_i32_le(bytes, pos + 1)?;
            Ok((Expr::IntLiteral { value }, 5))
        }
        EXPR_STORE_REGISTER => Ok((Expr::StoreRegister, 1)),
        EXPR_DOLLAR => match bytes.get(pos + 1) {
            // `$ 0xFF` + i32 — the compiler's typed integer-literal form.
            Some(&EXPR_INT_LITERAL) => {
                let value = read_i32_le(bytes, pos + 2)?;
                Ok((Expr::IntLiteral { value }, 6))
            }
            // `$ 0xC8` — the `$`-prefixed store-register reference (the
            // assignment RHS idiom `intX[i] = store`); no `[index]` follows.
            Some(&EXPR_STORE_REGISTER) => Ok((Expr::StoreRegister, 2)),
            // `$ <bank> [ <index-expr> ]` — a memory-bank reference. `bank`
            // is the single bank-selector byte (intA–intG/intZ, strS/M/K and
            // the numeric bank codes rlvm emits); the index is itself a full
            // expression. A real memory reference is ALWAYS `$`-prefixed.
            Some(&bank) => {
                if bytes.get(pos + 2) != Some(&EXPR_INDEX_OPEN) {
                    return Err(RealLiveParseError::MalformedExpression {
                        offset: (pos + 2) as u64,
                        byte: bytes.get(pos + 2).copied().unwrap_or(0),
                    });
                }
                let (index, index_len) = parse_expression(bytes, pos + 3)?;
                let close = pos + 3 + index_len;
                if bytes.get(close) != Some(&EXPR_INDEX_CLOSE) {
                    return Err(RealLiveParseError::MalformedExpression {
                        offset: close as u64,
                        byte: bytes.get(close).copied().unwrap_or(0),
                    });
                }
                Ok((
                    Expr::MemoryRef {
                        bank,
                        index: Box::new(index),
                    },
                    3 + index_len + 1,
                ))
            }
            None => Err(RealLiveParseError::TruncatedExpression { offset: pos as u64 }),
        },
        _ => Err(RealLiveParseError::MalformedExpression {
            offset: pos as u64,
            byte: b,
        }),
    }
}

/// Parse an ExpressionPiece **term** at `pos`: a parenthesised group /
/// complex parameter, a `\<op>` unary-prefixed term, or a bare token.
fn parse_term(bytes: &[u8], pos: usize) -> Result<(Expr, usize), RealLiveParseError> {
    match bytes.get(pos) {
        Some(&EXPR_PAREN_OPEN) => parse_complex(bytes, pos),
        Some(&EXPR_OP_PREFIX) => {
            let Some(&op) = bytes.get(pos + 1) else {
                return Err(RealLiveParseError::TruncatedExpression { offset: pos as u64 });
            };
            let (operand, operand_len) = parse_term(bytes, pos + 2)?;
            Ok((
                Expr::Unary {
                    op,
                    operand: Box::new(operand),
                },
                operand_len + 2,
            ))
        }
        _ => parse_token(bytes, pos),
    }
}

/// Parse a full ExpressionPiece at `pos`, returning the typed [`Expr`]
/// tree and the exact number of bytes consumed.
/// Operator precedence is collapsed into a single left-to-right chain:
/// the byte length of an expression is independent of the precedence
/// grouping (every binary operator is encoded `\<op>` and joins two
/// terms), so a flat fold yields both the correct length and a faithful
/// operator tree. This is the real ExpressionPiece evaluator that drives
/// the decompiler's byte alignment — there is no heuristic body scan.
pub fn parse_expression(bytes: &[u8], pos: usize) -> Result<(Expr, usize), RealLiveParseError> {
    let (mut node, mut len) = parse_term(bytes, pos)?;
    loop {
        let cursor = pos + len;
        if bytes.get(cursor) == Some(&EXPR_OP_PREFIX) {
            let Some(&op) = bytes.get(cursor + 1) else {
                return Err(RealLiveParseError::TruncatedExpression {
                    offset: cursor as u64,
                });
            };
            let (rhs, rhs_len) = parse_term(bytes, cursor + 2)?;
            node = Expr::Binary {
                op,
                lhs: Box::new(node),
                rhs: Box::new(rhs),
            };
            len += 2 + rhs_len;
        } else {
            break;
        }
    }
    Ok((node, len))
}

/// Length of a string operand (bare identifier or `"`-quoted) at `pos`.
/// Bare strings run until a structural / expression delimiter; quoted
/// strings run to the closing `"`. Shift-JIS double-byte pairs are
/// consumed whole so a trail byte equal to a delimiter value does not end
/// the string early.
fn string_operand_len(bytes: &[u8], pos: usize) -> usize {
    let mut i = pos;
    if bytes.get(pos) == Some(&b'"') {
        i += 1;
        while let Some(&b) = bytes.get(i) {
            if b == b'"' {
                i += 1;
                break;
            }
            if is_shift_jis_textout_lead(b) && i + 1 < bytes.len() {
                i += 2;
            } else {
                i += 1;
            }
        }
    } else {
        while let Some(&b) = bytes.get(i) {
            if is_string_operand_delimiter(b) {
                break;
            }
            if is_shift_jis_textout_lead(b) && i + 1 < bytes.len() {
                i += 2;
            } else {
                i += 1;
            }
        }
    }
    i - pos
}

/// `true` if `byte` ends a bare (unquoted) string operand.
fn is_string_operand_delimiter(byte: u8) -> bool {
    matches!(
        byte,
        opener::META_COMMA
            | opener::META_LINE
            | opener::META_ENTRYPOINT
            | b'"'
            | opener::COMMAND
            | EXPR_DOLLAR
            | EXPR_PAREN_OPEN
            | EXPR_PAREN_CLOSE
            | opener::COMMA
            | opener::META_KIDOKU
            | EXPR_OP_PREFIX
    )
}

/// True if `byte` is a recognised BytecodeElement opener (per opcode-table
/// in `docs/research/reallive-engine.md` §D + Shift-JIS Textout leads).
pub fn is_recognized_opener(byte: u8) -> bool {
    matches!(
        byte,
        opener::META_COMMA
            | opener::META_LINE
            | opener::META_ENTRYPOINT
            | opener::COMMAND
            | opener::EXPRESSION
            | opener::COMMA
            | opener::META_KIDOKU
    ) || is_shift_jis_textout_lead(byte)
}

/// Width of a goto-family jump-target pointer (`i32` LE).
const GOTO_POINTER_LEN: usize = 4;

/// One captured goto-family jump-target pointer inside a scene's
/// decompressed (and, for `xor_2` titles, decrypted) bytecode.
/// RealLive control-flow commands (`goto`/`goto_if`/`goto_on`/`goto_case`/
/// `gosub*`/`farcall*`) carry trailing `i32 LE` pointers whose value is the
/// **absolute byte offset** of the jump destination within the same scene
/// bytecode stream (rlvm `libreallive` resolves each pointer against the
/// scene's `Pointers` table, which is a byte-offset index). When a
/// length-changing text splice shifts everything after the edit, every
/// pointer whose destination sits at/after the edit must be re-based by the
/// cumulative byte delta — the patchback drives that off this record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GotoPointerSite {
    /// Absolute byte offset (within the scene bytecode) of the 4-byte
    /// `i32 LE` pointer itself — where the recalculated value is written back.
    pub pointer_offset: usize,
    /// The current jump-target byte offset the pointer encodes (its `i32`
    /// value, absolute within the same scene bytecode stream).
    pub target: i32,
}

/// Walk a decompressed (and, for `xor_2` titles, decrypted) scene bytecode
/// stream and collect every goto-family jump-target pointer site.
/// Drives off the single-source-of-truth element decoder ([`decode_element`]
/// [`decode_command`]) so the pointer offsets can never drift from the
/// authoritative command framing: for a Command opener the pointer-recording
/// [`decode_command`] is called; every other element is advanced by
/// [`decode_element`]. The returned offsets/values are absolute within
/// `bytes` (the same coordinate space the text-splice offsets use), so the
/// patchback can re-base each target by the cumulative splice delta and write
/// the new value back at `pointer_offset`.
pub fn collect_goto_pointer_sites(
    bytes: &[u8],
) -> Result<Vec<GotoPointerSite>, RealLiveParseError> {
    if bytes.is_empty() {
        return Err(RealLiveParseError::TruncatedBytecode { input_len: 0 });
    }
    let mut sites: Vec<GotoPointerSite> = Vec::new();
    let mut pos: usize = 0;
    while pos < bytes.len() {
        let consumed = if bytes[pos] == opener::COMMAND {
            let (_op, consumed) = decode_command(bytes, pos, &mut sites)?;
            consumed
        } else {
            let (_op, consumed) = decode_element(bytes, pos)?;
            consumed
        };
        debug_assert!(consumed > 0, "decode must make forward progress");
        pos += consumed;
    }
    Ok(sites)
}

/// Goto-family classification of a Command, keyed on the 32-bit command
/// id `(module_type << 24) | (module_id << 16) | opcode_u16` (rlvm
/// `libreallive/bytecode.cc::BytecodeElement::Read`). These are the
/// commands that carry **trailing jump-target pointers** after the
/// argument list — the structure a length-only argument scan cannot see.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GotoKind {
    /// `goto` / `gosub`: 8-byte header + one `i32` target, no arglist.
    Goto,
    /// `goto_if` / `goto_unless` / `gosub_if`: header + `(cond)` + `i32`.
    GotoIf,
    /// `goto_on`: header + `(expr)` + `argc` × `i32` targets.
    GotoOn,
    /// `goto_case`: header + `(expr)` + `argc` × (`(case)` + `i32`).
    GotoCase,
    /// `gosub_with`: header + `(args)` + `i32` target.
    GosubWith,
    /// Not a goto-family command.
    None,
}

/// Map a command id to its [`GotoKind`]. The id sets are restated from
/// rlvm `libreallive/bytecode.cc`'s `BytecodeElement::Read` dispatch
/// switch (the cross-scene/`farcall` module variants `0x05`/`0x06` are
/// included alongside the intra-scene `0x01` jmp module).
fn goto_kind(command_id: u32) -> GotoKind {
    match command_id {
        0x0001_0000 | 0x0001_0005 | 0x0005_0001 | 0x0005_0005 | 0x0006_0001 | 0x0006_0005 => {
            GotoKind::Goto
        }
        0x0001_0001 | 0x0001_0002 | 0x0001_0006 | 0x0001_0007 | 0x0005_0002 | 0x0005_0006
        | 0x0005_0007 | 0x0006_0000 | 0x0006_0002 | 0x0006_0006 | 0x0006_0007 => GotoKind::GotoIf,
        0x0001_0003 | 0x0001_0008 | 0x0005_0003 | 0x0005_0008 | 0x0006_0003 | 0x0006_0008 => {
            GotoKind::GotoOn
        }
        0x0001_0004 | 0x0001_0009 | 0x0005_0004 | 0x0005_0009 | 0x0006_0004 | 0x0006_0009 => {
            GotoKind::GotoCase
        }
        0x0001_0010 | 0x0006_0010 => GotoKind::GosubWith,
        _ => GotoKind::None,
    }
}

/// Select-block open / close braces (`{` `}`) and the option-text
/// boundary bytes used by the [`decode_select`] `{ … }` framing.
const SELECT_BLOCK_OPEN: u8 = 0x7B;
const SELECT_BLOCK_CLOSE: u8 = 0x7D;

/// `true` if `command_id` is a `module_sel` selection command that the
/// compiler emits with the `SelectElement` `{ … }` block framing rather
/// than a plain `(…)` argument list — `select_w`/`select`/`select_s2`/
/// `select_s` (`(0, 2, 0..=3)`) plus the `0x10` selection variant
/// (`(0, 2, 16)`). Restated from rlvm `libreallive/bytecode.cc`'s
/// `BytecodeElement::Read` dispatch (the `SelectElement` opcode set), NOT
/// vendored. The remaining `module_sel` opcodes (`select_objbtn`,
/// `objbtn_init`, …) use the ordinary function-call framing and are
/// decoded by the generic argument-list path.
fn is_select_command(command_id: u32) -> bool {
    matches!(
        command_id,
        0x0002_0000 | 0x0002_0001 | 0x0002_0002 | 0x0002_0003 | 0x0002_0010
    )
}

/// `true` if `byte` continues a RealLive **string token** in the
/// unquoted state (rlvm `libreallive` `NextString`): a Shift-JIS lead
/// byte (`0x81..=0x9F` / `0xE0..=0xEF`), an ASCII alphanumeric, space,
/// `?`, `_`, `"` or `\`. Any other byte ends the token. Restated from the
/// rlvm reference, not vendored.
fn is_next_string_byte(byte: u8) -> bool {
    matches!(byte, 0x81..=0x9F | 0xE0..=0xEF)
        || byte.is_ascii_alphanumeric()
        || matches!(byte, b' ' | b'?' | b'_' | b'"' | b'\\')
}

/// Length in bytes of the string token beginning at `pos`, mirroring rlvm
/// `NextString`: a run of [`is_next_string_byte`] bytes with Shift-JIS
/// double-byte pairs consumed whole, `"`-quoted spans that ignore the
/// boundary set until the closing quote, and the embedded
/// `###PRINT(<expr>)` interpolation form. Returns `0` when `pos` does not
/// begin a string token.
/// Inside a `"`-quoted span the backslash (`0x5C`) is the general escape
/// introducer (rlvm `NextString` quoted state): `\<byte>` consumes the
/// backslash and the following byte verbatim, whatever that byte is
/// (`\"` → literal quote, `\\` → literal backslash, `\x` → literal `x`).
/// This is what makes a translated choice option NextString-SAFE: the
/// producer ([`encode_choice_option_next_string_safe`]) escapes every
/// interior `"`/`\`, so the only *unescaped* `"` the decoder can reach is
/// the producer's closing quote — no interior byte (`[`, `,`, `!`, a
/// Shift-JIS trail byte equal to `"`, …) can terminate the token early or
/// run it past its close.
fn next_string_len(bytes: &[u8], pos: usize) -> usize {
    const PRINT_TAG: &[u8] = b"###PRINT(";
    let mut end = pos;
    let mut quoted = false;
    while end < bytes.len() {
        let b = bytes[end];
        if quoted {
            if b == b'\\' {
                // General escape: consume the backslash and the escaped
                // byte together. A trailing lone backslash (no following
                // byte) consumes just itself so `end` never exceeds the
                // buffer length.
                end += if end + 1 < bytes.len() { 2 } else { 1 };
                continue;
            }
            if b == b'"' {
                end += 1; // closing quote
                break;
            }
            // Ordinary quoted byte: Shift-JIS double-byte pairs are
            // consumed whole so a trail byte equal to `"`/`\` cannot be
            // misread as a close/escape.
            if matches!(b, 0x81..=0x9F | 0xE0..=0xEF) && end + 1 < bytes.len() {
                end += 2;
            } else {
                end += 1;
            }
            continue;
        }
        if bytes[end..].starts_with(PRINT_TAG) {
            end += PRINT_TAG.len();
            match parse_expression(bytes, end) {
                // `+ 1` consumes the closing `)` of the `###PRINT(…)`
                // interpolation (rlvm `end += 1 + NextExpression(end)`).
                Ok((_expr, len)) => end += len + 1,
                Err(_) => break,
            }
            continue;
        }
        if b == b'"' {
            quoted = true;
            end += 1;
            continue;
        }
        if !is_next_string_byte(b) {
            break;
        }
        if matches!(b, 0x81..=0x9F | 0xE0..=0xEF) && end + 1 < bytes.len() {
            end += 2;
        } else {
            end += 1;
        }
    }
    end - pos
}

/// Encode a translated `module_sel` choice option NextString-SAFE.
/// A raw Shift-JIS splice of translated choice text corrupts the
/// `SelectElement` framing: an option is decoded by [`next_string_len`],
/// whose *unquoted* state ends at the first byte that is not an
/// [`is_next_string_byte`] — so a translation carrying `[`, `,`, `.`, `!`,
/// `(`, `-`, … (all outside the unquoted string-token set) truncates the
/// option and lets the trailing bytes be misread as select structure
/// (`\n`+line markers, the `}` close, the next option), structurally
/// corrupting the command.
/// This encoder wraps the whole option in a `"`-quoted NextString and
/// escapes every interior single-byte `"` / `\` with a backslash. In the
/// quoted state [`next_string_len`] consumes ANY byte (arbitrary
/// punctuation, Shift-JIS pairs whose trail byte equals `"`/`\`) verbatim
/// and terminates ONLY at the producer's unescaped closing quote — so the
/// select structure and the option's `NextString` token can never be
/// corrupted, for ANY UTF-8 / Shift-JIS choice text. The escaping is done
/// per Shift-JIS *character* (not per raw byte) so a double-byte glyph
/// whose trail byte happens to equal `0x22`/`0x5C` is never split by a
/// spurious escape.
/// Returns the same [`ShiftJisEncodeError`] as [`encode_shift_jis_slot`]
/// (with the accurate first-unmappable char index) when the target text
/// carries a character outside Shift-JIS.
pub fn encode_choice_option_next_string_safe(
    text: &str,
) -> Result<Vec<u8>, crate::encoding::ShiftJisEncodeError> {
    // Validate mappability once up-front so the error carries the accurate
    // char index; the per-char re-encode below is then guaranteed to
    // succeed.
    crate::encoding::encode_shift_jis_slot(text)?;

    let mut out = Vec::with_capacity(text.len() + 2);
    out.push(b'"'); // opening quote
    let mut ch_buf = [0u8; 4];
    for ch in text.chars() {
        let sjis = crate::encoding::encode_shift_jis_slot(ch.encode_utf8(&mut ch_buf))
            .expect("char validated mappable above");
        // Only single-byte `"` / `\` need escaping; a Shift-JIS lead byte
        // (or its trail byte) is emitted as part of a whole 2-byte pair and
        // is consumed as a pair by the decoder, so it can never be mistaken
        if sjis.len() == 1 && (sjis[0] == b'"' || sjis[0] == b'\\') {
            out.push(b'\\');
        }
        out.extend_from_slice(&sjis);
    }
    out.push(b'"'); // closing quote
    Ok(out)
}

/// Decode a `module_sel` selection Command's `SelectElement` body and
/// return each option's text as a [`CommandArg`] (offset + raw bytes) plus
/// the total bytes the command consumed (8-byte header included). `pos`
/// points at the `0x23` opener.
/// Layout (rlvm `libreallive/bytecode.cc::SelectElement::SelectElement`,
/// restated, not vendored): the 8-byte header, an optional `(…)` window
/// expression, the `{` block open, an optional `\n`+i16 first-line marker,
/// then one entry per option until the matching `}`. Each option is an
/// optional `(…)` condition group (whose interior carries `\`-introduced
/// effect expressions and the single-byte effect codes the compiler emits,
/// e.g. `'2'`/`'3'` that take no operand), the option text
/// ([`next_string_len`]), and a trailing `\n`+i16 line marker. Trailing
/// `\n`+i16 markers after the `}` are consumed as junk. Only options that
/// carry non-empty text become [`CommandArg`] slots (an empty option is
/// not a translatable unit) so the produced `choices` length matches the
/// bridge / patch-back text-unit walk exactly.
fn decode_select(bytes: &[u8], pos: usize) -> Result<(Vec<CommandArg>, usize), RealLiveParseError> {
    let argc_offset = pos;
    let mut cursor = pos + COMMAND_HEADER_LEN;
    let truncated = |cursor: usize| RealLiveParseError::TruncatedCommandArgs {
        offset: argc_offset as u64,
        argc: (cursor.min(u16::MAX as usize)) as u16,
    };

    // Optional window/parameter expression `(…)`.
    if bytes.get(cursor) == Some(&EXPR_PAREN_OPEN) {
        let (_expr, len) = parse_expression(bytes, cursor)?;
        cursor += len;
    }
    // Mandatory `{` block open.
    if bytes.get(cursor) != Some(&SELECT_BLOCK_OPEN) {
        return Err(truncated(cursor));
    }
    cursor += 1;
    // Optional first-line `\n`+i16 marker.
    if bytes.get(cursor) == Some(&opener::META_LINE) {
        cursor += 3;
    }

    let mut choices: Vec<CommandArg> = Vec::new();
    loop {
        match bytes.get(cursor) {
            None => return Err(truncated(cursor)),
            Some(&SELECT_BLOCK_CLOSE) => {
                cursor += 1;
                break;
            }
            _ => {}
        }
        // Skip inter-option separators (`,`) and stray line markers.
        while bytes.get(cursor) == Some(&opener::COMMA) {
            cursor += 1;
        }
        if bytes.get(cursor) == Some(&opener::META_LINE) {
            cursor += 3;
        }
        if bytes.get(cursor) == Some(&SELECT_BLOCK_CLOSE) {
            cursor += 1;
            break;
        }
        // Optional condition group `(…)`.
        if bytes.get(cursor) == Some(&EXPR_PAREN_OPEN) {
            cursor += 1; // '('
            loop {
                match bytes.get(cursor) {
                    None => return Err(truncated(cursor)),
                    Some(&EXPR_PAREN_CLOSE) => {
                        cursor += 1;
                        break;
                    }
                    Some(&EXPR_PAREN_OPEN) => {
                        let (_e, len) = parse_expression(bytes, cursor)?;
                        cursor += len;
                    }
                    Some(&effect) => {
                        cursor += 1; // the single effect-code byte
                        // The `'2'`/`'3'` effect codes take no operand; any
                        // other effect code that is not immediately followed
                        // by `)` or a digit introduces a `\`/`$` expression
                        // operand.
                        if effect != b'2' && effect != b'3' {
                            let next = bytes.get(cursor).copied();
                            let stop = next == Some(EXPR_PAREN_CLOSE)
                                || next.is_some_and(|b| b.is_ascii_digit());
                            if !stop && next.is_some() {
                                let (_e, len) = parse_expression(bytes, cursor)?;
                                cursor += len;
                            }
                        }
                    }
                }
            }
        }
        // Option text.
        let text_start = cursor;
        let text_len = next_string_len(bytes, cursor);
        let text = bytes[cursor..cursor + text_len].to_vec();
        cursor += text_len;
        if !text.is_empty() {
            choices.push(CommandArg {
                byte_offset: text_start as u64,
                bytes: text,
            });
        }
        // Trailing `\n`+i16 line marker for this option.
        if bytes.get(cursor) == Some(&opener::META_LINE) {
            cursor += 3;
        } else if text_len == 0 {
            // No text and no line marker — the cursor would not advance and
            // the loop would spin. Surface a typed framing error.
            return Err(truncated(cursor));
        }
    }
    // Trailing junk: `\n`+i16 markers after the closing brace.
    while bytes.get(cursor) == Some(&opener::META_LINE) {
        cursor += 3;
    }
    Ok((choices, cursor - pos))
}

/// Parse a bracketed argument list `'(' (arg (',' arg)*)? ')'` beginning
/// at `pos` (which must point at the `(`).
/// The list is split into comma-delimited **slots**; each slot's bytes
/// are the concatenation of its ExpressionPiece / string data items. A
/// `,` immediately followed by another `,` yields an empty interior
/// slot — this preserves the one-slot-per-option contract the Choice /
/// select surface walk relies on. A trailing `,` immediately before
/// `)` does NOT yield a final empty slot, and an empty `` yields zero
/// slots: the close arm only pushes the final slot when it is non-empty
/// (`cursor > slot_start`). Top-level commas are the only separators;
/// commas buried inside an integer-literal payload or a parenthesised
/// sub-expression are consumed as part of that data item by the grammar
/// and never split a slot. Returns the per-slot raw bytes plus the total
/// bytes consumed (both parentheses included).
fn parse_arg_list(
    bytes: &[u8],
    pos: usize,
) -> Result<(Vec<CommandArg>, usize), RealLiveParseError> {
    let mut cursor = pos + 1; // skip '('
    let mut args: Vec<CommandArg> = Vec::new();
    let mut slot_start = cursor;
    loop {
        let Some(&b) = bytes.get(cursor) else {
            return Err(RealLiveParseError::TruncatedCommandArgs {
                offset: pos as u64,
                argc: 0,
            });
        };
        match b {
            EXPR_PAREN_CLOSE => {
                if cursor > slot_start {
                    args.push(CommandArg {
                        byte_offset: slot_start as u64,
                        bytes: bytes[slot_start..cursor].to_vec(),
                    });
                }
                cursor += 1;
                break;
            }
            // Top-level separator: close the current slot (possibly
            // empty) and open the next.
            opener::COMMA => {
                args.push(CommandArg {
                    byte_offset: slot_start as u64,
                    bytes: bytes[slot_start..cursor].to_vec(),
                });
                cursor += 1;
                slot_start = cursor;
            }
            // A `\n` + i16 line marker can appear between arguments
            // (rlvm `GetData`); skip its 3 bytes as part of the slot.
            opener::META_LINE => cursor += 3,
            _ => {
                // One data item (rlvm `GetData`): an arithmetic expression,
                // a string constant, or a complex / special parameter. The
                // grammar — not a delimiter scan — computes its exact width.
                let (_item, len) = parse_data(bytes, cursor)?;
                if len == 0 {
                    // No forward progress — a byte that is neither a
                    // valid expression token nor a string char. Surface a
                    // typed error rather than spin.
                    return Err(RealLiveParseError::MalformedExpression {
                        offset: cursor as u64,
                        byte: b,
                    });
                }
                cursor = (cursor + len).min(bytes.len());
            }
        }
    }
    Ok((args, cursor - pos))
}

/// Decode a single Command at `pos` into a `RealLiveOpcode` plus the
/// number of bytes consumed. `pos` points at the `0x23` opener byte.
fn decode_command(
    bytes: &[u8],
    pos: usize,
    goto_sites: &mut Vec<GotoPointerSite>,
) -> Result<(RealLiveOpcode, usize), RealLiveParseError> {
    if bytes.len() - pos < COMMAND_HEADER_LEN {
        return Err(RealLiveParseError::TruncatedCommandHeader {
            offset: pos as u64,
            available: bytes.len() - pos,
        });
    }
    let module_type = bytes[pos + 1];
    let module_id = bytes[pos + 2];
    let opcode_u16 = u16::from_le_bytes([bytes[pos + 3], bytes[pos + 4]]);
    // The header `argc` is a `u16 LE` (bytes 5-6); byte 7 is the overload
    // selector (rlvm `bytecode.h:CommandElement`). For goto_on / goto_case
    // it is the number of trailing jump targets / cases.
    let argc = u16::from_le_bytes([bytes[pos + 5], bytes[pos + 6]]);
    let overload = bytes[pos + 7];
    let command_id =
        (u32::from(module_type) << 24) | (u32::from(module_id) << 16) | u32::from(opcode_u16);

    // `module_sel` selection commands carry a `SelectElement` `{ … }`
    // option block rather than a plain `(…)` argument list, so they are
    // framed by their own decoder before the generic paths below.
    if is_select_command(command_id) {
        let (choices, consumed) = decode_select(bytes, pos)?;
        return Ok((RealLiveOpcode::Choice { choices }, consumed));
    }

    let mut consumed = COMMAND_HEADER_LEN;
    let mut args_bytes: Vec<CommandArg> = Vec::new();

    // Helper: consume `count` trailing `i32` jump-target pointers, recording
    // each pointer's absolute byte offset + current target value so the
    // patchback can re-base it after a length-changing splice.
    let mut consume_pointers = |consumed: &mut usize,
                                count: usize|
     -> Result<(), RealLiveParseError> {
        let need = count * GOTO_POINTER_LEN;
        if pos + *consumed + need > bytes.len() {
            return Err(RealLiveParseError::TruncatedCommandArgs {
                offset: pos as u64,
                argc,
            });
        }
        for k in 0..count {
            let ptr = pos + *consumed + k * GOTO_POINTER_LEN;
            let target =
                i32::from_le_bytes([bytes[ptr], bytes[ptr + 1], bytes[ptr + 2], bytes[ptr + 3]]);
            goto_sites.push(GotoPointerSite {
                pointer_offset: ptr,
                target,
            });
        }
        *consumed += need;
        Ok(())
    };
    // Helper: consume a bracketed `(...)` arg list if one is present.
    let parse_optional_args =
        |consumed: &mut usize, args: &mut Vec<CommandArg>| -> Result<(), RealLiveParseError> {
            if bytes.get(pos + *consumed) == Some(&EXPR_PAREN_OPEN) {
                let (parsed, len) = parse_arg_list(bytes, pos + *consumed)?;
                *args = parsed;
                *consumed += len;
            }
            Ok(())
        };

    match goto_kind(command_id) {
        GotoKind::Goto => {
            // 8-byte header + one i32 target; no argument list.
            consume_pointers(&mut consumed, 1)?;
        }
        GotoKind::GotoIf | GotoKind::GosubWith => {
            parse_optional_args(&mut consumed, &mut args_bytes)?;
            consume_pointers(&mut consumed, 1)?;
        }
        GotoKind::GotoOn => {
            // `goto_on(expr) { @t0 @t1 … }` — the discriminant expression,
            // then a `{`-delimited block of `argc` raw i32 jump targets
            // (rlvm `GotoOnElement`). The braces wrap the target list.
            parse_optional_args(&mut consumed, &mut args_bytes)?;
            let braced = bytes.get(pos + consumed) == Some(&SELECT_BLOCK_OPEN);
            if braced {
                consumed += 1;
            }
            consume_pointers(&mut consumed, argc as usize)?;
            if braced {
                if bytes.get(pos + consumed) != Some(&SELECT_BLOCK_CLOSE) {
                    return Err(RealLiveParseError::TruncatedCommandArgs {
                        offset: pos as u64,
                        argc,
                    });
                }
                consumed += 1;
            }
        }
        GotoKind::GotoCase => {
            // `goto_case(expr) { (case0) @t0 (case1) @t1 … }` — the
            // discriminant expression, then a `{`-delimited block of `argc`
            // entries, each a bracketed `(case-expr)` (the default case is
            // the empty ``) followed by an i32 target (rlvm
            // `GotoCaseElement`). The braces wrap the case list.
            parse_optional_args(&mut consumed, &mut args_bytes)?;
            let braced = bytes.get(pos + consumed) == Some(&SELECT_BLOCK_OPEN);
            if braced {
                consumed += 1;
            }
            for _ in 0..argc {
                if bytes.get(pos + consumed) != Some(&EXPR_PAREN_OPEN) {
                    return Err(RealLiveParseError::TruncatedCommandArgs {
                        offset: pos as u64,
                        argc,
                    });
                }
                let (_case, len) = parse_arg_list(bytes, pos + consumed)?;
                consumed += len;
                consume_pointers(&mut consumed, 1)?;
            }
            if braced {
                if bytes.get(pos + consumed) != Some(&SELECT_BLOCK_CLOSE) {
                    return Err(RealLiveParseError::TruncatedCommandArgs {
                        offset: pos as u64,
                        argc,
                    });
                }
                consumed += 1;
            }
        }
        GotoKind::None => {
            // Ordinary function command: an optional bracketed arg list.
            parse_optional_args(&mut consumed, &mut args_bytes)?;
        }
    }

    let opcode = classify_command(module_type, module_id, opcode_u16, overload, &args_bytes)
        .unwrap_or_else(|| {
            // `classify_command` only declines a command whose
            // `module_type` is outside RealLive's documented `{0, 1, 2}`
            // space — i.e. a desync tripwire. In-space commands whose
            // `(module_id, opcode)` tuple is not catalogued decode to the
            // generic `Command` variant inside `classify_command` instead.
            RealLiveOpcode::Unknown {
                opcode: opener::COMMAND,
                raw_bytes: bytes[pos..pos + consumed].to_vec(),
            }
        });
    Ok((opcode, consumed))
}

/// Classify a fully-framed Command into a typed [`RealLiveOpcode`].
/// The byte framing (header, argument list, goto pointers, select block)
/// is already resolved by [`decode_command`]; this is purely the
/// *labelling* pass. It returns `None` **only** when `module_type` is
/// outside RealLive's documented `{0, 1, 2}` space — a desync tripwire the
/// caller records as [`RealLiveOpcode::Unknown`]. In-space commands first
/// pass through an enumerated `(module_id, opcode)` allow-list: only
/// catalogued opcodes resolve to a **semantically-typed** operation family
/// keyed on `module_id` (the engine's real semantic key — `module_type` is
/// a compiler-version artifact, so e.g. `Wait` is observed at both
/// `0:4:100` and `1:4:100`). The generic [`RealLiveOpcode::Command`] is
/// reached by either an uncatalogued in-space `module_id` or an
/// uncatalogued opcode inside a known module — it is NOT recognised and
/// FAILS the semantic-zero gate. On the proven Sweetie HD / Kanon corpora
/// every real tuple is enumerated and lands in a named family.
/// `module_id` keys are restated from the rlvm `src/modules/module_*.cc`
/// registrations (`RLModule(name, type, id)`) and `libreallive/bytecode.cc`
/// dispatch — reference, not vendored.
fn classify_command(
    module_type: u8,
    module_id: u8,
    opcode_u16: u16,
    overload: u8,
    args_bytes: &[CommandArg],
) -> Option<RealLiveOpcode> {
    if module_type > 2 {
        return None;
    }
    let command_id =
        (u32::from(module_type) << 24) | (u32::from(module_id) << 16) | u32::from(opcode_u16);

    // Un-catalogued fallback: an in-space `module_id` no semantic family
    // covers. Structurally decoded but NOT recognised — fails the
    // semantic-zero gate. Never reached on the proven corpora.
    let generic = || RealLiveOpcode::Command {
        module_type,
        module_id,
        opcode: opcode_u16,
        overload,
        args: args_bytes.to_vec(),
    };

    // Control-flow commands (`module_jmp` and the cross-scene `gosub`/
    // `farcall` module variants) were byte-consumed via their goto framing;
    // label them by family.
    match goto_kind(command_id) {
        GotoKind::Goto => return Some(RealLiveOpcode::Goto),
        GotoKind::GotoIf => return Some(RealLiveOpcode::Branch),
        GotoKind::GotoOn | GotoKind::GotoCase => return Some(RealLiveOpcode::If),
        GotoKind::GosubWith => return Some(RealLiveOpcode::Call),
        GotoKind::None => {}
    }

    if !is_catalogued_command_opcode(module_id, opcode_u16)
        && !is_coverage_manifest_opcode(module_id, opcode_u16)
    {
        return Some(generic());
    }

    let mapped = match module_id {
        // module_jmp (rlvm `module_jmp.cc`, id 1) — the non-pointer opcodes
        // (the pointer-carrying ones are handled by goto framing above).
        // Module 1 is the control-flow namespace, so any residual opcode is a
        // jump/computed-flow form rather than a generic blob.
        module_id::JMP => match opcode_u16 {
            0 | 1 => RealLiveOpcode::Goto,
            2 | 3 => RealLiveOpcode::Branch,
            4 | 5 => RealLiveOpcode::If,
            10..=13 => RealLiveOpcode::Call,
            20..=22 => RealLiveOpcode::Return,
            _ => RealLiveOpcode::Jump,
        },
        // module_sel (rlvm `module_sel.cc`, id 2) — the translatable
        // `select*` option blocks were decoded to `Choice` before classify;
        // every other opcode is selection-button setup / state.
        module_id::SEL => RealLiveOpcode::SelectionControl { opcode: opcode_u16 },
        // module_msg (rlvm `module_msg.cc`, id 3) — opcode 3 is the character
        // speaker text op; catalogued opcodes in the text-display range
        // decode to `TextDisplay`; the remaining catalogued opcodes are
        // non-dialogue window directives.
        module_id::MSG => match opcode_u16 {
            3 => RealLiveOpcode::CharacterTextDisplay,
            x if (1..=200).contains(&x) => RealLiveOpcode::TextDisplay {
                encoding: TextEncoding::ShiftJisLengthPrefixed,
            },
            _ => RealLiveOpcode::MessageControl { opcode: opcode_u16 },
        },
        // module_sys (rlvm `module_sys.cc`, id 4) — `end` / `wait` keep their
        // named variants; the long control / query tail is system control.
        module_id::SYS => match opcode_u16 {
            17 => RealLiveOpcode::End,
            100 | 101 => RealLiveOpcode::Wait {
                duration_ms: first_arg_as_i32(args_bytes),
            },
            _ => RealLiveOpcode::SystemControl { opcode: opcode_u16 },
        },
        // module_sys second registration id (5) — system-class control.
        module_id::SYS2 => RealLiveOpcode::SystemControl { opcode: opcode_u16 },
        // module_str-class indexed variable / flag module (id 10) — uniform
        // single integer memory-bank reference operand.
        module_id::STR => RealLiveOpcode::VariableOp { opcode: opcode_u16 },
        // module_mem (rlvm `module_mem.cc`, id 11) — any variable-bank write.
        module_id::MEM => RealLiveOpcode::SetVariable,
        // Audio channels (module_bgm / module_se / module_pcm, ids 20/21/22)
        // — play (by filename) / stop / fade / volume.
        module_id::AUDIO_BGM | module_id::AUDIO_SE | module_id::AUDIO_PCM => {
            RealLiveOpcode::Audio {
                module_id,
                opcode: opcode_u16,
            }
        }
        // module_koe (rlvm `module_koe.cc`, id 23) — voice playback.
        module_id::KOE => RealLiveOpcode::VoicePlay {
            voice_id: first_arg_as_u32(args_bytes),
        },
        // module_grp (rlvm `module_grp.cc`, id 33) — background / sprite load
        // (first arg is the sprite id).
        module_id::GRP => RealLiveOpcode::Background {
            sprite_id: first_arg_as_u32(args_bytes),
        },
        // Screen / frame / weather / animation-layer control (ids
        // 30/31/40/60/61/62) — whole-screen / effect-layer graphics ops.
        30 | 31 | 40 | 60 | 61 | 62 => RealLiveOpcode::ScreenControl {
            module_id,
            opcode: opcode_u16,
        },
        // Display-object (sprite-plane) modules — foreground / background /
        // child object planes and their range (`module_type = 2`) forms.
        71 | 72 | 73 | 81 | 82 | 84 | 85 | 90 | 91 => RealLiveOpcode::GraphicsObject {
            module_id,
            opcode: opcode_u16,
        },
        // An in-space module id the catalogue has not reached: the typed
        // fallback that FAILS the semantic-zero gate (never occurs on the
        // proven Sweetie HD / Kanon corpora).
        _ => generic(),
    };
    Some(mapped)
}

/// Reduce an [`Expr`] to a constant `i32` when it is (or wraps) an
/// integer literal. Used to decorate `Wait` / `Background` / `VoicePlay`
/// with their first scalar argument.
fn expr_as_i32(expr: &Expr) -> Option<i32> {
    match expr {
        Expr::IntLiteral { value } => Some(*value),
        // A single-item complex parameter is a parenthesised value `(lit)`.
        Expr::Complex { items } if items.len() == 1 => expr_as_i32(&items[0]),
        _ => None,
    }
}

/// Parse the first argument's bytes as an ExpressionPiece and return its
/// integer value when it is a constant literal, else `0`. The argument
/// bytes are a full expression (e.g. `$ 0xFF` + i32), decoded by the real
/// [`parse_expression`] evaluator rather than a byte-prefix guess.
fn first_arg_as_i32(args_bytes: &[CommandArg]) -> i32 {
    args_bytes
        .first()
        .and_then(|arg| parse_expression(&arg.bytes, 0).ok())
        .and_then(|(expr, _)| expr_as_i32(&expr))
        .unwrap_or(0)
}

/// Surface the first argument literal as a `u32` **id** without losing
/// magnitude or sign information. Asset / voice ids are bit-packed `u32`
/// values (e.g. `voice_id = (archive_id << 16) | sample_id`), so the raw
/// `i32` bit pattern is reinterpreted (`as u32`) rather than passed
/// through `unsigned_abs`, which would flip a negative literal to its
/// absolute value and corrupt the id.
fn first_arg_as_u32(args_bytes: &[CommandArg]) -> u32 {
    first_arg_as_i32(args_bytes) as u32
}

/// Decode the full real-bytecode stream into a [`RealLiveOpcode`] sequence.
/// `bytes` is the **decompressed** scene bytecode (post-AVG32 LZSS + XOR
/// first-level transform per
/// `docs/research/reallive-sweetie-hd-encryption-mechanism.md`). The
/// caller owns decompression — this function operates on plaintext
/// bytecode bytes.
/// An empty input is rejected with
/// [`RealLiveParseError::TruncatedBytecode`]; the function never returns
/// `Ok(vec!)` on a non-empty input either. Every byte is partitioned
/// into a typed [`RealLiveOpcode`] element — a well-formed stream
/// produces **zero** [`RealLiveOpcode::Unknown`] spans because any byte
/// outside a structural element is a Textout (the catch-all per rlvm
/// `BytecodeElement::Read`).
pub fn parse_real_bytecode(bytes: &[u8]) -> Result<Vec<RealLiveOpcode>, RealLiveParseError> {
    Ok(parse_real_bytecode_spans(bytes)?
        .into_iter()
        .map(|(opcode, _consumed)| opcode)
        .collect())
}

/// Decode the full real-bytecode stream into `(opcode, consumed_width)`
/// pairs — the **authoritative**, width-carrying decode.
/// Each pair's `consumed_width` is exactly the number of bytes
/// [`decode_element`] (the single source of truth that `decode_command`
/// drives) consumed for that element, including any bracketed argument
/// list and trailing goto-family jump pointers. Every downstream surface
/// that needs per-element byte widths — the Scene-AST projection in
/// `parser.rs` and the bridge provenance cursor in `bridge.rs` — derives
/// its widths from this function rather than re-deriving them from a
/// hand-maintained table that could silently drift from the decoder.
/// [`parse_real_bytecode`] is a thin width-dropping wrapper over this.
pub fn parse_real_bytecode_spans(
    bytes: &[u8],
) -> Result<Vec<(RealLiveOpcode, usize)>, RealLiveParseError> {
    if bytes.is_empty() {
        return Err(RealLiveParseError::TruncatedBytecode { input_len: 0 });
    }

    let mut out: Vec<(RealLiveOpcode, usize)> = Vec::new();
    let mut pos: usize = 0;

    while pos < bytes.len() {
        let (opcode, consumed) = decode_element(bytes, pos)?;
        debug_assert!(consumed > 0, "decode_element must make forward progress");
        out.push((opcode, consumed));
        pos += consumed;
    }

    if out.is_empty() {
        return Err(RealLiveParseError::TruncatedBytecode {
            input_len: bytes.len(),
        });
    }
    Ok(out)
}

/// Decode exactly one BytecodeElement at `pos`, returning the typed
/// [`RealLiveOpcode`] and the number of bytes it consumed.
/// This is the single source of truth for element boundaries — both
/// [`parse_real_bytecode`] and the patchback re-walk drive off it so
/// their cursors never drift. The dispatch is the documented opener-byte
/// switch (`docs/research/reallive-engine.md` §D): structural openers
/// `{0x00, 0x0A, 0x21, 0x23, 0x24, 0x2C, 0x40}` decode their element;
/// every other byte begins a Textout run that extends to the next
/// structural opener (Shift-JIS pairs consumed whole).
pub(crate) fn decode_element(
    bytes: &[u8],
    pos: usize,
) -> Result<(RealLiveOpcode, usize), RealLiveParseError> {
    let lead = bytes[pos];
    match lead {
        opener::META_COMMA | opener::COMMA => Ok((RealLiveOpcode::Comma, 1)),
        opener::META_LINE => {
            let value = read_meta_u16(bytes, pos)?;
            Ok((RealLiveOpcode::MetaLine { line: value }, 3))
        }
        opener::META_ENTRYPOINT => {
            let value = read_meta_u16(bytes, pos)?;
            Ok((RealLiveOpcode::MetaEntrypoint { entrypoint: value }, 3))
        }
        opener::META_KIDOKU => {
            let value = read_meta_u16(bytes, pos)?;
            Ok((RealLiveOpcode::MetaKidoku { mark: value }, 3))
        }
        opener::EXPRESSION => {
            // The `0x24` element opener doubles as the `$` of the first
            // ExpressionPiece token; parse from `pos` so the real
            // evaluator computes the exact span (it stops precisely at
            // the expression's true end, never absorbing a following
            // Textout).
            let (_expr, len) = parse_expression(bytes, pos)?;
            let raw_bytes = bytes[pos + 1..pos + len].to_vec();
            Ok((RealLiveOpcode::Expression { raw_bytes }, len))
        }
        opener::COMMAND => {
            // The single-element decode path discards goto-pointer sites;
            // `collect_goto_pointer_sites` is the accumulating walker.
            let mut goto_sites = Vec::new();
            decode_command(bytes, pos, &mut goto_sites)
        }
        _ => {
            let (raw_bytes, consumed) = scan_textout(bytes, pos);
            Ok((
                RealLiveOpcode::Textout {
                    encoding: TextEncoding::ShiftJisInlineRun,
                    raw_bytes,
                },
                consumed,
            ))
        }
    }
}

/// Scan a Textout run beginning at `pos` (a non-structural lead byte),
/// returning its raw bytes and the byte width consumed.
/// This is the catch-all in [`decode_element`]: any byte that is not one
/// of the seven structural BytecodeElement openers
/// ([`is_structural_opener`]) begins a displayable-text (or embedded
/// binary) run that extends to the next structural opener. Shift-JIS
/// double-byte pairs ([`is_shift_jis_textout_lead`]) are consumed whole,
/// so a trail byte whose value equals a structural opener never ends the
/// run early.
/// The run is treated as an opaque byte span — commas and `"` are part of
/// the run, and the producer's surface-selection split
/// ([`decode_dialogue_textout`]) later decides whether a given run is
/// readable Shift-JIS dialogue or embedded binary data. This is the
/// minimal, version-agnostic boundary rule: applying text-only quoting /
/// comma-inlining heuristics here mis-splits embedded binary data blocks
/// (e.g. Sweetie HD's binary catch-all runs).
fn scan_textout(bytes: &[u8], pos: usize) -> (Vec<u8>, usize) {
    let start = pos;
    let mut end = pos;
    while end < bytes.len() {
        let b = bytes[end];
        if is_structural_opener(b) {
            break;
        }
        if is_shift_jis_textout_lead(b) && end + 1 < bytes.len() {
            end += 2;
        } else {
            end += 1;
        }
    }
    (bytes[start..end].to_vec(), end - start)
}

/// Read the `u16 LE` payload of a 3-byte Meta element at `pos`.
fn read_meta_u16(bytes: &[u8], pos: usize) -> Result<u16, RealLiveParseError> {
    if bytes.len() - pos < 3 {
        return Err(RealLiveParseError::TruncatedMetaHeader {
            opener: bytes[pos],
            offset: pos as u64,
            needed: 3,
            available: bytes.len() - pos,
        });
    }
    Ok(u16::from_le_bytes([bytes[pos + 1], bytes[pos + 2]]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input_surfaces_truncated_bytecode_not_silent_ok() {
        let err = parse_real_bytecode(&[]).expect_err("empty input must error");
        assert!(matches!(
            err,
            RealLiveParseError::TruncatedBytecode { input_len: 0 }
        ));
    }

    #[test]
    fn decodes_sweetie_hd_scene_1_prologue_into_documented_meta_run() {
        // First 16 bytes of decompressed Sweetie HD scene 1 per
        // docs/research/reallive-sweetie-hd-encryption-mechanism.md §4.2.
        let bytes: &[u8] = &[
            0x0a, 0x02, 0x00, 0x0a, 0x03, 0x00, 0x21, 0x00, 0x00, 0x0a, 0x04, 0x00, 0x0a, 0x05,
            0x00, 0x0a,
        ];
        let _ = parse_real_bytecode(bytes); // 16-byte feed runs into a partial MetaLine
        // Documented: MetaLine(2), MetaLine(3), MetaEntrypoint(0),
        // MetaLine(4), MetaLine(5), then a partial MetaLine that runs
        // off the end → TruncatedMetaHeader. We pass only the 15 bytes
        // that align to a clean element boundary:
        let bytes = &bytes[..15];
        let opcodes = parse_real_bytecode(bytes).expect("decode must succeed");
        assert_eq!(opcodes.len(), 5);
        assert!(matches!(opcodes[0], RealLiveOpcode::MetaLine { line: 2 }));
        assert!(matches!(opcodes[1], RealLiveOpcode::MetaLine { line: 3 }));
        assert!(matches!(
            opcodes[2],
            RealLiveOpcode::MetaEntrypoint { entrypoint: 0 }
        ));
        assert!(matches!(opcodes[3], RealLiveOpcode::MetaLine { line: 4 }));
        assert!(matches!(opcodes[4], RealLiveOpcode::MetaLine { line: 5 }));
    }

    #[test]
    fn truncated_meta_header_is_typed_error_not_panic() {
        let bytes = &[opener::META_LINE, 0x02]; // truncated line marker
        let err = parse_real_bytecode(bytes).expect_err("must reject truncated header");
        assert!(matches!(
            err,
            RealLiveParseError::TruncatedMetaHeader { opener: 0x0A, .. }
        ));
    }

    #[test]
    fn non_structural_lead_byte_decodes_as_textout_not_unknown() {
        // `0x55` is not a structural opener, so it begins a Textout run
        // (the catch-all per rlvm `BytecodeElement::Read`) that ends at
        // the following MetaLine opener. No byte is dropped or marked
        // Unknown — every byte partitions into a typed element.
        let bytes = &[0x55, opener::META_LINE, 0x07, 0x00];
        let opcodes = parse_real_bytecode(bytes).expect("non-structural lead tolerated");
        assert_eq!(opcodes.len(), 2);
        match &opcodes[0] {
            RealLiveOpcode::Textout { raw_bytes, .. } => assert_eq!(raw_bytes, &vec![0x55]),
            other => panic!("expected Textout, got {other:?}"),
        }
        assert!(opcodes.iter().all(RealLiveOpcode::is_recognized));
        assert!(matches!(opcodes[1], RealLiveOpcode::MetaLine { line: 7 }));
    }

    #[test]
    fn unrecognized_signature_names_uncatalogued_command_tuple() {
        // 8-byte CommandElement header + MetaLine terminator. module_type 1
        // (in-space) with an UNCATALOGUED (module_id 99, opcode 999) → the
        // generic `Command` blob that fails `is_recognized`.
        let bytes = &[
            opener::COMMAND,
            1,
            99,
            0xE7,
            0x03, // opcode 999 (0x03E7) little-endian
            0,
            0, // argc = 0
            0, // overload
            opener::META_LINE,
            0x05,
            0x00,
        ];
        let opcodes = parse_real_bytecode(bytes).expect("decode must succeed");
        assert!(matches!(
            opcodes[0],
            RealLiveOpcode::Command {
                module_type: 1,
                module_id: 99,
                opcode: 999,
                ..
            }
        ));
        assert!(!opcodes[0].is_recognized());
        assert_eq!(opcodes[0].unrecognized_signature(), Some((1, 99, 999)));

        let histogram = unrecognized_opcode_histogram(&opcodes);
        assert_eq!(histogram.get(&(1, 99, 999)), Some(&1));
        assert_eq!(histogram.len(), 1);
    }

    #[test]
    fn unrecognized_signature_is_empty_for_fully_recognized_stream() {
        // module_type 1, module_id 4 (sys), opcode 17 → `End` (catalogued),
        // then a MetaLine. Every element is a recognised family, so the
        // un-recognised histogram is empty (the 100%-decode property).
        let bytes = &[
            opener::COMMAND,
            1,
            4,
            17,
            0,
            0,
            0,
            0,
            opener::META_LINE,
            0x05,
            0x00,
        ];
        let opcodes = parse_real_bytecode(bytes).expect("decode must succeed");
        assert!(opcodes.iter().all(RealLiveOpcode::is_recognized));
        assert!(
            opcodes
                .iter()
                .all(|op| op.unrecognized_signature().is_none())
        );
        assert!(unrecognized_opcode_histogram(&opcodes).is_empty());
    }

    #[test]
    fn command_header_truncation_is_typed_error() {
        let bytes = &[opener::COMMAND, 1, 5]; // only 3 of 8 header bytes
        let err = parse_real_bytecode(bytes).expect_err("must reject truncated command");
        assert!(matches!(
            err,
            RealLiveParseError::TruncatedCommandHeader { .. }
        ));
    }

    #[test]
    fn command_with_recognized_module_classifies_to_named_variant() {
        // Construct a module_msg TextDisplay-shaped command: header
        // (0x23, 1, 3=MSG, 5=opcode_u16_le_lo, 0=opcode_u16_le_hi, 0=argc,
        // 0=overload, 0=reserved) with no argument list. Opcode 5 is in the
        // catalogued message allow-list.
        let bytes = &[opener::COMMAND, 1, module_id::MSG, 5, 0, 0, 0, 0];
        let opcodes = parse_real_bytecode(bytes).expect("must decode");
        assert_eq!(opcodes.len(), 1);
        // MSG opcode 3 is CharacterTextDisplay; this catalogued text opcode
        // classifies as TextDisplay.
        assert!(matches!(opcodes[0], RealLiveOpcode::TextDisplay { .. }));
    }

    #[test]
    fn pcm_wav_loop_is_catalogued_as_recognized_audio() {
        // `module_pcm` is `(module_type=1, module_id=21)`; its opcode 2
        // is `wavLoop`. The semantic catalogue must admit the tuple so the
        // already-typed audio family does not fall back to generic Command.
        let bytes = &[opener::COMMAND, 1, 21, 2, 0, 0, 0, 0];
        let opcodes = parse_real_bytecode(bytes).expect("must decode");
        assert_eq!(opcodes.len(), 1);
        assert!(matches!(
            opcodes[0],
            RealLiveOpcode::Audio {
                module_id: 21,
                opcode: 2
            }
        ));
        assert!(opcodes[0].is_recognized());
    }

    #[test]
    fn out_of_space_module_type_preserved_as_unknown_with_command_opener() {
        // `Unknown` is now reserved for the desync tripwire: a command
        // header whose module_type is outside RealLive's documented
        // `{0, 1, 2}` space. Such a header (module_type=14) is preserved
        // verbatim for audit rather than coalesced into a generic Command.
        let bytes = &[opener::COMMAND, 14, 99, 0xFF, 0xFF, 0, 0, 0];
        let opcodes = parse_real_bytecode(bytes).expect("must decode");
        assert_eq!(opcodes.len(), 1);
        match &opcodes[0] {
            RealLiveOpcode::Unknown { opcode, raw_bytes } => {
                assert_eq!(*opcode, opener::COMMAND);
                assert!(raw_bytes.starts_with(&[opener::COMMAND, 14, 99]));
            }
            other => panic!("expected Unknown, got {other:?}"),
        }
    }

    #[test]
    fn in_space_uncatalogued_module_is_generic_command_and_fails_recognition() {
        // An in-space (module_type <= 2) command at a module_id no semantic
        // family covers (99) decodes to the generic typed Command — NOT
        // `Unknown` (it is structurally framed), but it is NOT recognised:
        // an un-catalogued tuple must fail the semantic-zero gate rather
        // than masquerade as decoded. (Every module_id present on the real
        // Sweetie HD / Kanon corpora lands in a named family, so this never
        // fires there.)
        let bytes = &[opener::COMMAND, 1, 99, 0xFF, 0xFF, 0, 0, 0];
        let opcodes = parse_real_bytecode(bytes).expect("must decode");
        assert_eq!(opcodes.len(), 1);
        assert!(matches!(
            opcodes[0],
            RealLiveOpcode::Command {
                module_type: 1,
                module_id: 99,
                opcode: 0xFFFF,
                ..
            }
        ));
        assert!(
            !opcodes[0].is_recognized(),
            "an un-catalogued in-space tuple must FAIL recognition"
        );
    }

    #[test]
    fn unknown_opcode_inside_known_module_is_generic_command_and_fails_recognition() {
        // RealLive command opcodes are u16; 0xffff is the synthetic stand-in
        // property is that a plausible module id no longer buckets every
        // opcode to SystemControl.
        let bytes = &[opener::COMMAND, 1, module_id::SYS2, 0xFF, 0xFF, 0, 0, 0];
        let opcodes = parse_real_bytecode(bytes).expect("must decode");
        assert_eq!(opcodes.len(), 1);
        assert!(matches!(
            opcodes[0],
            RealLiveOpcode::Command {
                module_type: 1,
                module_id: module_id::SYS2,
                opcode: 0xFFFF,
                ..
            }
        ));
        assert!(
            !opcodes[0].is_recognized(),
            "an unknown opcode inside a known module must FAIL recognition"
        );
    }

    #[test]
    fn catalogued_modules_classify_to_named_semantic_families() {
        // Spot-check the new semantic families across the module space so a
        // real-game tuple can never silently fall back to generic Command.
        type Case = (u8, u8, u16, fn(&RealLiveOpcode) -> bool);
        let cases: &[Case] = &[
            // module 2 (Sel) non-select op -> SelectionControl.
            (0, 2, 30, |o| {
                matches!(o, RealLiveOpcode::SelectionControl { opcode: 30 })
            }),
            // module 3 (Msg) window directive (>200) -> MessageControl.
            (0, 3, 201, |o| {
                matches!(o, RealLiveOpcode::MessageControl { opcode: 201 })
            }),
            // module 4 (Sys) control tail -> SystemControl.
            (1, 4, 130, |o| {
                matches!(o, RealLiveOpcode::SystemControl { opcode: 130 })
            }),
            // module 5 (Sys2) -> SystemControl.
            (1, 5, 120, |o| {
                matches!(o, RealLiveOpcode::SystemControl { opcode: 120 })
            }),
            // module 10 (variable/flag) -> VariableOp.
            (1, 10, 100, |o| {
                matches!(o, RealLiveOpcode::VariableOp { opcode: 100 })
            }),
            // module 20/21/22 (audio channels) -> Audio.
            (1, 20, 0, |o| {
                matches!(
                    o,
                    RealLiveOpcode::Audio {
                        module_id: 20,
                        opcode: 0
                    }
                )
            }),
            // module 30/60/62 (screen / animation / effect layer) -> ScreenControl.
            (1, 62, 10, |o| {
                matches!(
                    o,
                    RealLiveOpcode::ScreenControl {
                        module_id: 62,
                        opcode: 10
                    }
                )
            }),
            // module 72/81/82 (display object planes) -> GraphicsObject.
            (1, 82, 1000, |o| {
                matches!(
                    o,
                    RealLiveOpcode::GraphicsObject {
                        module_id: 82,
                        opcode: 1000
                    }
                )
            }),
            // module_type 2 range form of an object module -> GraphicsObject.
            (2, 81, 1064, |o| {
                matches!(
                    o,
                    RealLiveOpcode::GraphicsObject {
                        module_id: 81,
                        opcode: 1064
                    }
                )
            }),
        ];
        for &(mt, mid, op, pred) in cases {
            let bytes = &[
                opener::COMMAND,
                mt,
                mid,
                (op & 0xFF) as u8,
                (op >> 8) as u8,
                0,
                0,
                0,
            ];
            let opcodes = parse_real_bytecode(bytes).expect("must decode");
            assert_eq!(opcodes.len(), 1, "{mt}:{mid}:{op}");
            assert!(
                pred(&opcodes[0]),
                "{mt}:{mid}:{op} did not classify to its semantic family: {:?}",
                opcodes[0]
            );
            assert!(
                opcodes[0].is_recognized(),
                "{mt}:{mid}:{op} semantic family must be recognised"
            );
        }
    }

    #[test]
    fn comma_opener_is_recognized() {
        let bytes = &[opener::META_COMMA, opener::COMMA];
        let opcodes = parse_real_bytecode(bytes).expect("must decode");
        assert_eq!(opcodes.len(), 2);
        assert!(matches!(opcodes[0], RealLiveOpcode::Comma));
        assert!(matches!(opcodes[1], RealLiveOpcode::Comma));
    }

    #[test]
    fn shift_jis_textout_run_is_recognized_and_byte_equal() {
        // Shift-JIS string for "ハ" (0x83 0x6E) followed by MetaLine.
        // The Textout run extends across one SJIS double-byte.
        let bytes = &[0x83, 0x6E, opener::META_LINE, 0x05, 0x00];
        let opcodes = parse_real_bytecode(bytes).expect("must decode");
        assert_eq!(opcodes.len(), 2);
        match &opcodes[0] {
            RealLiveOpcode::Textout { raw_bytes, .. } => {
                assert_eq!(raw_bytes, &vec![0x83, 0x6E]);
            }
            other => panic!("expected Textout, got {other:?}"),
        }
        assert!(matches!(opcodes[1], RealLiveOpcode::MetaLine { line: 5 }));
    }

    #[test]
    fn command_arglist_int_literal_payload_with_delimiter_bytes_does_not_misterminate() {
        // Bug: the arglist scanner split on raw 0x28 '(' / 0x29 ')' /
        // 0x2C ',' without honoring the 0xFF int-literal introducer.
        // Here a single argument is a 0xFF int literal whose 4 LE payload
        // bytes are exactly [0x29 ')', 0x2C ',', 0x28 '(', 0x00] — every
        // delimiter value. The literal must be consumed whole so the
        // arglist closes at the REAL trailing ')', and the following
        // MetaLine decodes aligned with zero unknown opcodes.
        // module_sys (id=4) opcode 100 == Wait, argc=1; first_arg_as_i32
        // decodes the int literal, so asserting duration_ms proves all 4
        // payload bytes (incl. the delimiter-valued ones) landed in the
        // argument rather than splitting it.
        let bytes = &[
            opener::COMMAND,
            1,
            module_id::SYS,
            100,
            0, // opcode_u16 = 100 (Wait)
            1, // argc
            0, // overload
            0, // reserved
            b'(',
            0xFF,
            0x29,
            0x2C,
            0x28,
            0x00, // i32 LE literal = 0x00282C29
            b')',
            opener::META_LINE,
            0x07,
            0x00,
        ];
        let opcodes = parse_real_bytecode(bytes).expect("must decode");
        assert!(
            opcodes.iter().all(RealLiveOpcode::is_recognized),
            "no element may misalign into Unknown: {opcodes:?}"
        );
        assert_eq!(
            opcodes.len(),
            2,
            "arglist must close at the real ')': {opcodes:?}"
        );
        // The full i32 literal 0x00282C29 is surfaced verbatim (no u16
        // truncation) — proves the full 5-byte literal (incl.
        // 0x29/0x2C/0x28) was captured as one arg.
        assert!(
            matches!(
                opcodes[0],
                RealLiveOpcode::Wait {
                    duration_ms: 0x0028_2C29
                }
            ),
            "expected Wait with full-range literal-derived duration, got {:?}",
            opcodes[0]
        );
        assert!(
            matches!(opcodes[1], RealLiveOpcode::MetaLine { line: 7 }),
            "stream must stay aligned after the arglist: {:?}",
            opcodes[1]
        );
    }

    #[test]
    fn wait_and_id_operands_preserve_full_magnitude_and_sign_no_unsigned_abs() {
        // 007 regression: operand literals were narrowed via
        // `unsigned_abs as u16/u32`, silently truncating any value above
        // u16::MAX and flipping the sign of negative literals. The decoded
        // surface must now carry the literal's real range.

        // Wait with a 100000 ms duration (> u16::MAX = 65535). Old code
        // truncated to (100000 & 0xFFFF) = 34464; the i32 surface keeps it.
        let mut wait = vec![opener::COMMAND, 1, module_id::SYS, 100, 0, 1, 0, 0];
        wait.extend_from_slice(&[b'(', EXPR_INT_LITERAL]);
        wait.extend_from_slice(&100_000i32.to_le_bytes());
        wait.push(b')');
        let opcodes = parse_real_bytecode(&wait).expect("wait decodes");
        assert!(
            matches!(
                opcodes[0],
                RealLiveOpcode::Wait {
                    duration_ms: 100_000
                }
            ),
            "duration must survive above u16::MAX, got {:?}",
            opcodes[0]
        );

        // Background (module_grp) sprite id carrying a negative literal
        // -5 (= 0xFFFF_FFFB). Old code's unsigned_abs flipped it to 5; the
        // bit-reinterpreting `as u32` preserves the literal's bit pattern.
        let mut bg = vec![opener::COMMAND, 1, module_id::GRP, 0x49, 0, 1, 0, 0];
        bg.extend_from_slice(&[b'(', EXPR_INT_LITERAL]);
        bg.extend_from_slice(&(-5i32).to_le_bytes());
        bg.push(b')');
        let opcodes = parse_real_bytecode(&bg).expect("background decodes");
        assert!(
            matches!(
                opcodes[0],
                RealLiveOpcode::Background {
                    sprite_id: 0xFFFF_FFFB
                }
            ),
            "negative id literal must keep its bit pattern (no unsigned_abs flip), got {:?}",
            opcodes[0]
        );
    }

    #[test]
    fn expression_immediately_followed_by_textout_decodes_as_two_elements() {
        // An Expression element whose value is a `$ 0xFF` int literal
        // (`0x24 0xFF` + i32) carries a payload byte `0x83` with a
        // Shift-JIS lead VALUE. The literal must be consumed whole (its
        // payload is not mistaken for a Textout start), and the
        // expression must terminate at its true 6-byte boundary so the
        // REAL Textout that follows surfaces as its own translatable
        // unit instead of being buried in `Expression.raw_bytes`.
        let bytes = &[
            opener::EXPRESSION,
            0xFF,
            0x83,
            0x6E,
            0x01,
            0x00, // $ 0xFF int literal = 0x00016E83; 0x83 has an SJIS-lead value
            0x83,
            0x6E, // Textout "ハ" — the translatable dialogue
            opener::META_LINE,
            0x05,
            0x00,
        ];
        let opcodes = parse_real_bytecode(bytes).expect("must decode");
        assert_eq!(
            opcodes.len(),
            3,
            "Expression + Textout + MetaLine must be THREE elements: {opcodes:?}"
        );
        match &opcodes[0] {
            RealLiveOpcode::Expression { raw_bytes } => {
                // Body is the 5 bytes after the `0x24` opener — the whole
                // int literal, nothing more.
                assert_eq!(
                    raw_bytes,
                    &vec![0xFF, 0x83, 0x6E, 0x01, 0x00],
                    "Expression must not swallow the following Textout"
                );
            }
            other => panic!("expected Expression, got {other:?}"),
        }
        match &opcodes[1] {
            RealLiveOpcode::Textout { raw_bytes, .. } => {
                // The dialogue text is recovered as its own unit.
                assert_eq!(raw_bytes, &vec![0x83, 0x6E]);
            }
            other => panic!("expected Textout (recovered dialogue), got {other:?}"),
        }
        assert!(matches!(opcodes[2], RealLiveOpcode::MetaLine { line: 5 }));
    }

    #[test]
    fn parses_assignment_expression_into_typed_tree() {
        // `$06[401] = 1` — the pervasive Sweetie HD scene-1 idiom:
        // memory-ref LHS, `\0x1e` assignment op, `$ 0xFF` int-literal
        // RHS. The evaluator must consume exactly 18 bytes and produce a
        // typed Binary(MemoryRef, IntLiteral) tree.
        let body = [
            0x24, 0x06, 0x5B, 0x24, 0xFF, 0x91, 0x01, 0x00, 0x00, 0x5D, 0x5C, 0x1E, 0x24, 0xFF,
            0x01, 0x00, 0x00, 0x00,
        ];
        let (expr, len) = parse_expression(&body, 0).expect("assignment must parse");
        assert_eq!(len, 18, "must consume the whole expression");
        match expr {
            Expr::Binary { op, lhs, rhs } => {
                assert_eq!(op, 0x1E, "assignment operator");
                assert!(matches!(
                    *lhs,
                    Expr::MemoryRef { bank: 0x06, ref index }
                        if matches!(**index, Expr::IntLiteral { value: 401 })
                ));
                assert!(matches!(*rhs, Expr::IntLiteral { value: 1 }));
            }
            other => panic!("expected Binary assignment, got {other:?}"),
        }
    }

    #[test]
    fn goto_if_consumes_trailing_jump_pointer() {
        // module_jmp goto_if (modtype=0, module=1, opcode=2) carries a
        // `(cond)` arg list followed by a 4-byte i32 jump target. The
        // decoder must consume header + arglist + pointer so the stream
        // stays aligned (the trailing pointer is not left as Unknown).
        let mut bytes = vec![
            opener::COMMAND,
            0,
            1,
            2,
            0, // opcode_u16 = 2 (goto_if)
            0,
            0,
            0, // argc=0, overload=0
        ];
        // arg list: `($ 0xFF 0)`
        bytes.extend_from_slice(&[b'(', 0x24, 0xFF, 0x00, 0x00, 0x00, 0x00, b')']);
        // trailing i32 jump target = 0x0461
        bytes.extend_from_slice(&[0x61, 0x04, 0x00, 0x00]);
        // a following MetaLine to prove alignment
        bytes.extend_from_slice(&[opener::META_LINE, 0x07, 0x00]);
        let opcodes = parse_real_bytecode(&bytes).expect("must decode");
        assert!(
            opcodes.iter().all(RealLiveOpcode::is_recognized),
            "no element may misalign into Unknown: {opcodes:?}"
        );
        assert_eq!(opcodes.len(), 2, "goto_if + MetaLine: {opcodes:?}");
        assert!(matches!(opcodes[0], RealLiveOpcode::Branch));
        assert!(matches!(opcodes[1], RealLiveOpcode::MetaLine { line: 7 }));
    }

    #[test]
    fn plain_goto_consumes_twelve_bytes_with_pointer() {
        // module_jmp goto (modtype=0, module=1, opcode=0): 8-byte header
        // + 4-byte i32 target, no arg list (rlvm GotoElement == 12 bytes).
        let mut bytes = vec![opener::COMMAND, 0, 1, 0, 0, 0, 0, 0];
        bytes.extend_from_slice(&[0x0F, 0x06, 0x00, 0x00]); // i32 target
        bytes.extend_from_slice(&[opener::META_LINE, 0x86, 0x00]);
        let opcodes = parse_real_bytecode(&bytes).expect("must decode");
        assert_eq!(opcodes.len(), 2, "goto + MetaLine: {opcodes:?}");
        assert!(matches!(opcodes[0], RealLiveOpcode::Goto));
        assert!(matches!(
            opcodes[1],
            RealLiveOpcode::MetaLine { line: 0x86 }
        ));
    }

    #[test]
    fn command_string_argument_is_consumed_as_operand() {
        // module_grp open command with a bare string filename followed by
        // an int param: `(_WHITE $ 0xFF 50)`. The string operand must
        // be consumed (stopping at the `$`), and the int param decoded.
        let mut bytes = vec![opener::COMMAND, 1, module_id::GRP, 0x49, 0, 2, 0, 0];
        bytes.push(b'(');
        bytes.extend_from_slice(b"_WHITE");
        bytes.extend_from_slice(&[0x24, 0xFF, 0x32, 0x00, 0x00, 0x00]); // $ 0xFF 50
        bytes.push(b')');
        bytes.extend_from_slice(&[opener::META_LINE, 0x01, 0x00]);
        let opcodes = parse_real_bytecode(&bytes).expect("must decode");
        assert!(opcodes.iter().all(RealLiveOpcode::is_recognized));
        assert_eq!(opcodes.len(), 2, "background + MetaLine: {opcodes:?}");
        assert!(matches!(opcodes[0], RealLiveOpcode::Background { .. }));
        assert!(matches!(opcodes[1], RealLiveOpcode::MetaLine { line: 1 }));
    }

    #[test]
    fn is_recognized_helpers_match_documented_opener_table() {
        for byte in [
            opener::META_COMMA,
            opener::META_LINE,
            opener::META_ENTRYPOINT,
            opener::COMMAND,
            opener::EXPRESSION,
            opener::COMMA,
            opener::META_KIDOKU,
        ] {
            assert!(is_recognized_opener(byte), "byte {byte:#04x}");
        }
        assert!(is_shift_jis_textout_lead(0x81));
        assert!(is_shift_jis_textout_lead(0xE0));
        assert!(!is_recognized_opener(0x55));
    }

    #[test]
    fn parse_arg_list_trailing_comma_drops_final_empty_slot() {
        fn arg_bytes(args: &[CommandArg]) -> Vec<Vec<u8>> {
            args.iter().map(|a| a.bytes.clone()).collect()
        }
        // `` -> zero slots.
        assert_eq!(
            arg_bytes(
                &parse_arg_list(&[EXPR_PAREN_OPEN, EXPR_PAREN_CLOSE], 0)
                    .unwrap()
                    .0
            ),
            Vec::<Vec<u8>>::new()
        );
        // `(,)` -> one empty interior slot from the comma; the trailing
        // comma before `)` does NOT add a final empty slot.
        assert_eq!(
            arg_bytes(
                &parse_arg_list(&[EXPR_PAREN_OPEN, opener::COMMA, EXPR_PAREN_CLOSE], 0)
                    .unwrap()
                    .0
            ),
            vec![Vec::<u8>::new()]
        );
        // `(,,)` -> two empty slots (one per comma); still no extra
        // trailing slot.
        assert_eq!(
            arg_bytes(
                &parse_arg_list(
                    &[
                        EXPR_PAREN_OPEN,
                        opener::COMMA,
                        opener::COMMA,
                        EXPR_PAREN_CLOSE
                    ],
                    0
                )
                .unwrap()
                .0
            ),
            vec![Vec::<u8>::new(), Vec::<u8>::new()]
        );
    }

    #[test]
    fn parse_arg_list_stamps_scene_relative_offset_per_option() {
        // `("あ", "い")` starting at byte 0: option 0 begins right after
        // the `(` at offset 1; option 1 begins after the comma at offset 4.
        let bytes = [
            EXPR_PAREN_OPEN, // 0: (
            0x82,
            0xA0,          // 1..3: "あ"
            opener::COMMA, // 3: ,
            0x82,
            0xA2,             // 4..6: "い"
            EXPR_PAREN_CLOSE, // 6: )
        ];
        let (args, consumed) = parse_arg_list(&bytes, 0).unwrap();
        assert_eq!(consumed, bytes.len());
        assert_eq!(args.len(), 2);
        assert_eq!(args[0].byte_offset, 1);
        assert_eq!(args[0].bytes, vec![0x82, 0xA0]);
        assert_eq!(args[1].byte_offset, 4);
        assert_eq!(args[1].bytes, vec![0x82, 0xA2]);
    }

    #[test]
    fn catalogued_msg_control_opcode_decodes_to_message_control() {
        // A catalogued module_msg opcode outside the text-display range is a
        // non-dialogue text-window directive — it classifies to the semantic
        // `MessageControl` family, never the generic blob.
        assert_eq!(
            classify_command(0, module_id::MSG, 201, 0, &[]),
            Some(RealLiveOpcode::MessageControl { opcode: 201 })
        );
    }

    #[test]
    fn object_plane_module_decodes_to_graphics_object_family() {
        // An object-plane module (id 82, ObjBg) decodes to the semantic
        // `GraphicsObject` family carrying its plane id + opcode — the
        // composited object Utsushi must render, never a generic blob.
        assert_eq!(
            classify_command(1, 82, 1004, 3, &[]),
            Some(RealLiveOpcode::GraphicsObject {
                module_id: 82,
                opcode: 1004,
            })
        );
    }

    #[test]
    fn out_of_space_module_type_is_unknown_desync_tripwire() {
        // module_type > 2 is outside RealLive's documented space; it is the
        // desync tripwire and must NOT be coalesced into a generic Command.
        assert_eq!(classify_command(14, 3, 23243, 0, &[]), None);
    }

    #[test]
    fn truncated_goto_on_reports_full_u16_argc() {
        // goto_on command (module_id JMP, opcode 3) declaring argc=300 with
        // no trailing jump-target bytes must surface the full u16 argc, not
        // 300 truncated to u8 (300 & 0xFF == 44).
        let argc: u16 = 300;
        let bytes = [
            opener::COMMAND,
            0,              // module_type
            module_id::JMP, // module_id
            3,              // opcode_lo (goto_on)
            0,              // opcode_hi
            (argc & 0xFF) as u8,
            (argc >> 8) as u8,
            0, // overload
        ];
        let err = decode_command(&bytes, 0, &mut Vec::new())
            .expect_err("missing jump targets must error");
        assert!(
            matches!(
                err,
                RealLiveParseError::TruncatedCommandArgs { argc: 300, .. }
            ),
            "expected argc=300, got {err:?}"
        );
    }

    // The byte sequences below are SYNTHETIC: they reproduce the structural
    // forms the Kanon + Sweetie HD full-archive recon exposed (integer/string
    // bank references, store register, array index, complex / special params,
    // bracket-leading quoted strings) WITHOUT embedding any copyrighted game
    // text — every string operand here is an ASCII placeholder.

    #[test]
    fn integer_bank_reference_dollar_prefixed_with_array_index() {
        // `$ 0x02 [ 0x000C ]` — an `intC[12]` bank reference (the `0x42 'B'` /
        // `0x43 'C'` recon class is the *bareword* form; the canonical numeric
        // bank reference rlvm emits is `$ <bank> [ <index> ]`).
        let bytes = [
            EXPR_DOLLAR,
            0x02, // bank selector
            EXPR_INDEX_OPEN,
            EXPR_INT_LITERAL,
            0x0C,
            0x00,
            0x00,
            0x00,
            EXPR_INDEX_CLOSE,
        ];
        let (expr, len) = parse_expression(&bytes, 0).expect("memory ref must parse");
        assert_eq!(len, bytes.len());
        assert!(matches!(
            expr,
            Expr::MemoryRef { bank: 0x02, ref index }
                if matches!(**index, Expr::IntLiteral { value: 12 })
        ));
    }

    #[test]
    fn dollar_prefixed_store_register_is_two_bytes() {
        // `$ 0xC8` — the `$`-typed store-register RHS idiom (`intX[i] = store`).
        // Must consume exactly 2 bytes and NOT be misread as `$ <bank=0xC8> [`.
        let (expr, len) = parse_expression(&[EXPR_DOLLAR, EXPR_STORE_REGISTER, 0x0A], 0)
            .expect("$store must parse");
        assert_eq!(len, 2, "$ + 0xC8 store register is two bytes");
        assert!(matches!(expr, Expr::StoreRegister));
    }

    #[test]
    fn bracket_leading_quoted_string_arg_is_not_misread_as_bank_reference() {
        // `("[X]")` — a quoted string whose first content byte is `[`. The
        // old "any byte followed by `[`" heuristic misread the opening `"` as
        // a memory-bank reference and failed on the next byte (the Sweetie HD
        // `0x83` / Kanon `0x53` recon class). A real bank reference is always
        // `$`-prefixed, so the quoted string is consumed whole.
        let bytes = [
            EXPR_PAREN_OPEN,
            b'"',
            b'[',
            b'X',
            b']',
            b'"',
            EXPR_PAREN_CLOSE,
        ];
        let (args, consumed) = parse_arg_list(&bytes, 0).expect("quoted `[`-string must parse");
        assert_eq!(consumed, bytes.len());
        assert_eq!(args.len(), 1);
        assert_eq!(args[0].bytes, b"\"[X]\"".to_vec());
    }

    #[test]
    fn bareword_string_then_int_then_special_param_in_arg_list() {
        // `("BG" $0 0x61 0x01 ("FG" $0))` — the Kanon `0x42 'B'` recon
        // class: a bareword asset-id string, an int literal, and a special
        // parameter (tag 0x01) wrapping a complex group with its own bareword.
        // Every byte must partition with zero residual.
        let bytes = [
            EXPR_PAREN_OPEN, // (
            b'B',
            b'G', // bareword "BG"
            EXPR_DOLLAR,
            EXPR_INT_LITERAL,
            0,
            0,
            0,
            0, // $0
            EXPR_SPECIAL,
            0x01,            // special param, tag 0x01
            EXPR_PAREN_OPEN, // (  complex
            b'F',
            b'G', // bareword "FG"
            EXPR_DOLLAR,
            EXPR_INT_LITERAL,
            0,
            0,
            0,
            0,                // $0
            EXPR_PAREN_CLOSE, // )  complex
            EXPR_PAREN_CLOSE, // )
        ];
        let (args, consumed) = parse_arg_list(&bytes, 0).expect("special-param arg must parse");
        assert_eq!(consumed, bytes.len(), "whole arg list consumed");
        // One un-split slot (no top-level comma): bareword + int + special.
        assert_eq!(args.len(), 1);
        assert_eq!(args[0].bytes, bytes[1..bytes.len() - 1].to_vec());
    }

    #[test]
    fn special_param_with_memory_ref_content_no_complex_wrapper() {
        // `0x61 0x00 $0x06[7]` — a special parameter (tag 0x00) whose content
        // is a `$`-memory reference directly (no `` wrapper). The Sweetie HD
        // `objBgMulti`-class `0x61 0x00 $…` form: it must be recognised as a
        // special parameter, not a bare string ending at the `0x00` delimiter.
        let bytes = [
            EXPR_SPECIAL,
            0x00, // tag
            EXPR_DOLLAR,
            0x06,
            EXPR_INDEX_OPEN,
            EXPR_INT_LITERAL,
            0x07,
            0x00,
            0x00,
            0x00,
            EXPR_INDEX_CLOSE,
        ];
        let (expr, len) = parse_data(&bytes, 0).expect("special-with-memref must parse");
        assert_eq!(len, bytes.len());
        match expr {
            Expr::SpecialParam { tag: 0, content } => {
                assert!(matches!(
                    *content,
                    Expr::MemoryRef { bank: 0x06, ref index }
                        if matches!(**index, Expr::IntLiteral { value: 7 })
                ));
            }
            other => panic!("expected SpecialParam{{tag:0}}, got {other:?}"),
        }
    }

    #[test]
    fn leading_0x61_string_is_not_misread_as_special_param() {
        // A bare string that merely begins with `0x61` (`'a'`) — e.g. a
        // `select` option "ab" — is NOT a special parameter: the byte after
        // the would-be tag is a string byte / delimiter, never a complex /
        // expression lead. The synthetic Choice pin depends on this.
        assert!(!is_special_param_lead(&[EXPR_SPECIAL, b'b', b','], 0));
        assert!(is_special_param_lead(
            &[EXPR_SPECIAL, 0x01, EXPR_PAREN_OPEN],
            0
        ));
    }

    #[test]
    fn complex_param_is_a_sequence_of_data_items_not_a_single_expression() {
        // `($0 $0 $1 $0x02[0])` — a complex parameter is a back-to-back
        // sequence of data items (rlvm `ComplexExpressionPiece`), NOT a single
        // operator-chained expression. The old parenthesised-expression path
        // stopped at the second item and failed on the `$` (the Kanon `0x24`
        // recon class).
        let bytes = [
            EXPR_PAREN_OPEN,
            EXPR_DOLLAR,
            EXPR_INT_LITERAL,
            0,
            0,
            0,
            0, // $0
            EXPR_DOLLAR,
            EXPR_INT_LITERAL,
            0,
            0,
            0,
            0, // $0
            EXPR_DOLLAR,
            EXPR_INT_LITERAL,
            1,
            0,
            0,
            0, // $1
            EXPR_DOLLAR,
            0x02,
            EXPR_INDEX_OPEN,
            EXPR_INT_LITERAL,
            0,
            0,
            0,
            0,
            EXPR_INDEX_CLOSE, // $intC[0]
            EXPR_PAREN_CLOSE,
        ];
        let (expr, len) = parse_data(&bytes, 0).expect("complex param must parse");
        assert_eq!(len, bytes.len());
        match expr {
            Expr::Complex { items } => assert_eq!(items.len(), 4, "four data items"),
            other => panic!("expected Complex, got {other:?}"),
        }
    }

    #[test]
    fn bare_token_without_dollar_prefix_is_malformed_not_a_bank_reference() {
        // A bank reference is ONLY `$`-prefixed. A bare `0x02 [ … ]` (no `$`)
        // is not a valid arithmetic token — the evaluator must surface a typed
        // MalformedExpression rather than silently inventing a reference.
        let err = parse_token(&[0x02, EXPR_INDEX_OPEN, EXPR_INT_LITERAL, 0, 0, 0, 0], 0)
            .expect_err("bare bank byte must be malformed");
        assert!(matches!(
            err,
            RealLiveParseError::MalformedExpression { byte: 0x02, .. }
        ));
    }
}
