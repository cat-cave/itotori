use std::{collections::BTreeMap, fmt};

use kaifuu_core::RedactedContentSummary;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::command_catalog::{is_catalogued_command_opcode, is_coverage_manifest_opcode};
pub use crate::textout::decode_dialogue_textout;

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
    /// surfaced at its full `i32` range when the first argument is a
    /// literal. RealLive wait durations routinely exceed `u16::MAX` (a
    /// 2-minute pause is 120000 ms) and the engine also accepts
    /// negative/relative forms, so narrowing to `u16` via `unsigned_abs`
    /// would silently corrupt the decompiled value. `None` records an
    /// argument that cannot be decoded as a literal rather than conflating
    /// it with a literal zero.
    Wait { duration_ms: Option<i32> },
    /// `module_grp` `openBg`/`load` (background sprite load — the
    /// argument is the optional u32 sprite id pulled from the Command
    /// argument list; `None` means it was not a decodable literal).
    Background { sprite_id: Option<u32> },
    /// `module_koe` `koePlay`/`koePlayInChar` (the argument is the u32
    /// `(archive_id, sample_id)` voice id pulled from the Command
    /// argument list; `None` means it was not a decodable literal).
    VoicePlay { voice_id: Option<u32> },
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
    /// the catalogue has not reached; on the proven corpora (the observed corpus,
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


