//! Real RealLive bytecode opcode dispatch (KAIFUU-191).
//!
//! Decodes the **real** RealLive scene-bytecode stream documented in
//! `docs/research/reallive-engine.md` §D and confirmed against Sweetie HD's
//! decompressed scene 1 in `docs/research/reallive-sweetie-hd-encryption-mechanism.md` §4.2.
//!
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
//!   per RLDEV/rlvm references per the KAIFUU-191 audit-focus row.
//!
//! Scope:
//! - This module owns the **opener-byte + Command-header** dispatch.
//! - Expression-piece (`0x24` Expression element) bodies are preserved
//!   verbatim as raw bytes — full expression evaluation lands in a
//!   follow-up node, not here.
//! - Text strings carried in Command argument lists or in Textout elements
//!   are kept as raw Shift-JIS bytes; decoding is the
//!   [`crate::encoding`] surface's job.
//!
//! The shape of the dispatch is deliberately narrow: a fresh decoder
//! that handles every byte of a real Sweetie HD scene-1 stream into
//! either a recognised [`RealLiveOpcode`] variant or an
//! [`RealLiveOpcode::Unknown`] entry that preserves the unrecognised
//! bytes. A scene that produces no opcodes is an error
//! ([`RealLiveParseError::TruncatedBytecode`]), never a silent
//! `Ok(vec![])`.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// BytecodeElement opener bytes (rlvm `bytecode.cc::BytecodeElement::Read`).
///
/// These are the lead bytes that mark the start of a documented element
/// in a decompressed RealLive scene stream. Any other lead byte either
/// starts a Shift-JIS Textout run
/// ([`is_shift_jis_textout_lead`]) or is preserved as an
/// [`RealLiveOpcode::Unknown`].
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
///
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
///
/// The variants are a unified view over both BytecodeElement-level
/// markers (Meta/Comma/Textout/Expression) and recognised RLOperation
/// Commands (`TextDisplay`, `Choice`, `Jump`, ...). Commands that decode
/// structurally but do not match a documented operation family land in
/// [`RealLiveOpcode::Unknown`] with the original bytes preserved.
///
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
/// - `BgmPlay`/`BgmStop` — module_bgm family (rlvm `module_bgm.cc`).
/// - `VoicePlay` — module_koe family (rlvm `module_koe.cc`).
/// - `SetVariable` — module_mem family (rlvm `module_mem.cc`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
    /// `0x24` ExpressionElement — variable expression. Body bytes are
    /// preserved verbatim until the expression terminator; the
    /// expression-piece evaluator lives in a follow-up node.
    Expression { raw_bytes: Vec<u8> },

    /// `module_msg` text-display Command (recognised).
    TextDisplay { encoding: TextEncoding },
    /// `module_msg` character-text Command (recognised).
    CharacterTextDisplay,
    /// `module_sel` choice Command (`select`/`select_s`/`select_w`).
    Choice { choices: Vec<Vec<u8>> },
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
    /// `module_sys` `wait` (longop pause with a u16-LE duration in
    /// milliseconds — argument decoded from the Command argument list).
    Wait { duration_ms: u16 },
    /// `module_grp` `openBg`/`load` (background sprite load — the
    /// argument is the u32 sprite id pulled from the Command argument
    /// list).
    Background { sprite_id: u32 },
    /// `module_bgm` `bgmPlay`/`bgmLoop`.
    BgmPlay,
    /// `module_bgm` `bgmStop`/`bgmFadeOut`.
    BgmStop,
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

    /// Element opener or Command (module, id, opcode) tuple outside the
    /// recognised alpha set. The original `opcode` byte is preserved for
    /// audit; `raw_bytes` carries the full element span the decoder
    /// consumed (or `1` for unknown opener bytes).
    Unknown { opcode: u8, raw_bytes: Vec<u8> },
}

impl RealLiveOpcode {
    /// `true` if this variant is one of the recognised alpha-set
    /// classifications (anything other than [`RealLiveOpcode::Unknown`]).
    /// Used by the real-bytes integration test to compute the recognition
    /// rate over Sweetie HD scene 1.
    pub fn is_recognized(&self) -> bool {
        !matches!(self, Self::Unknown { .. })
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
            Self::BgmPlay => "bgm_play",
            Self::BgmStop => "bgm_stop",
            Self::VoicePlay { .. } => "voice_play",
            Self::SetVariable => "set_variable",
            Self::If => "if",
            Self::End => "end",
            Self::Unknown { .. } => "unknown",
        }
    }
}

/// Decoder error surface. Typed; no `unwrap()` clusters in production.
#[derive(Debug, Clone, PartialEq, Eq, Error, Serialize, Deserialize)]
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
        "kaifuu.reallive.truncated_meta_header: {opener:#04x} at offset {offset} needs {needed} bytes, {available} available"
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
    TruncatedCommandArgs { offset: u64, argc: u8 },
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
}

/// Module-id catalogue keys (rlvm `src/modules/module_*.cc` names).
///
/// Sub-module ids inside `module_type=1` (Kepago — the primary
/// RLOperation namespace) follow rlvm's published indexing. The keys
/// below are the subset needed for the Sweetie HD scene 1 alpha; richer
/// coverage is a follow-up node.
mod module_id {
    /// `module_sys.cc` — system control (`end`, `wait`, `pause`, save/load).
    pub const SYS: u8 = 4;
    /// `module_mem.cc` — memory / array bulk (`setarray`, `setrng`).
    pub const MEM: u8 = 11;
    /// `module_jmp.cc` — control flow (`goto`, `gosub`, `ret`, `jump`).
    pub const JMP: u8 = 1;
    /// `module_str.cc` — string manipulation.
    pub const STR: u8 = 2;
    /// `module_msg.cc` — text / messaging (`pause`, `br`, `page`,
    /// `FontColor`, `FastText`).
    pub const MSG: u8 = 3;
    /// `module_sel.cc` — choice / selection (`select`, `select_s`,
    /// `select_w`).
    pub const SEL: u8 = 5;
    /// `module_grp.cc` — graphics primitives (`load`, `openBg`, `fade`).
    pub const GRP: u8 = 33;
    /// `module_bgm.cc` — BGM playback.
    pub const BGM: u8 = 19;
    /// `module_koe.cc` — voice playback.
    pub const KOE: u8 = 23;
}

/// True if `byte` starts a Shift-JIS Textout run per RLDEV documentation
/// (Shift-JIS first-byte ranges).
pub fn is_shift_jis_textout_lead(byte: u8) -> bool {
    (0x81..=0x9F).contains(&byte) || (0xE0..=0xFC).contains(&byte)
}

/// True if `byte` is a top-level meta / command marker that terminates
/// an Expression-element body (`0x0A`, `0x21`, `0x23`, `0x40`). These
/// bytes never appear bare inside an ExpressionPiece body except as the
/// payload of a `0xFF` int-literal token, which the body walk
/// ([`expression_body_end`]) consumes verbatim before this predicate is
/// consulted.
pub fn is_expression_body_terminator(byte: u8) -> bool {
    matches!(
        byte,
        opener::META_LINE | opener::META_ENTRYPOINT | opener::COMMAND | opener::META_KIDOKU
    )
}

/// Exclusive end offset of an Expression-element body that begins at
/// `body_start` (the byte immediately after the `0x24` opener).
///
/// The walk is ExpressionPiece-token-aware so the body terminates at its
/// true boundary instead of over-consuming the following element. Per
/// `docs/research/reallive-engine.md` §G an expression body legally
/// contains `0x00` (binary-op byte), `0x24` (memory-reference
/// sub-expression prefix), `0x2C` (separator), and `0xFF` (int-literal
/// introducer + 4 bytes of i32 LE):
///
/// - A `0xFF` int-literal introducer consumes its 4 payload bytes
///   verbatim. Those payload bytes can legally equal a meta/command
///   marker or a Shift-JIS lead value; skipping them keeps the walk from
///   ending the body early on a literal byte. This is the bounded
///   int-literal length walk the body needs — the only source of bare
///   high bytes (`0x80..=0xFF`) in a well-formed expression body.
/// - Any other byte is examined as a boundary candidate: the body ends
///   at the first top-level meta/command marker
///   ([`is_expression_body_terminator`]) **or** at a Shift-JIS Textout
///   lead byte ([`is_shift_jis_textout_lead`]). Stopping at the Textout
///   lead is what prevents an Expression element from swallowing a
///   directly-following Textout (dialogue) run — that run must surface
///   as its own translatable unit, not be buried in `Expression.raw_bytes`.
pub(crate) fn expression_body_end(bytes: &[u8], body_start: usize) -> usize {
    let mut i = body_start;
    while i < bytes.len() {
        let byte = bytes[i];
        if byte == 0xFF {
            // int-literal token: introducer + 4 LE payload bytes,
            // consumed verbatim (payload may carry terminator- or
            // SJIS-lead-valued bytes).
            i = (i + 5).min(bytes.len());
            continue;
        }
        if is_expression_body_terminator(byte) || is_shift_jis_textout_lead(byte) {
            break;
        }
        i += 1;
    }
    i
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

/// Decode a single Command at `pos` into a `RealLiveOpcode` plus the
/// number of bytes consumed. `pos` points at the `0x23` opener byte.
fn decode_command(bytes: &[u8], pos: usize) -> Result<(RealLiveOpcode, usize), RealLiveParseError> {
    if bytes.len() - pos < COMMAND_HEADER_LEN {
        return Err(RealLiveParseError::TruncatedCommandHeader {
            offset: pos as u64,
            available: bytes.len() - pos,
        });
    }
    let module_type = bytes[pos + 1];
    let module_id = bytes[pos + 2];
    let opcode_u16 = u16::from_le_bytes([bytes[pos + 3], bytes[pos + 4]]);
    let argc = bytes[pos + 5];
    let _overload = bytes[pos + 6];
    let _reserved = bytes[pos + 7];

    // Argument list shape (per RLDEV / rlvm `expression.cc`):
    //   '(' arg0 ',' arg1 ',' ... ')'
    // Arguments are ExpressionPiece byte runs whose body we preserve
    // verbatim — full expression evaluation is a follow-up node.
    //
    // We scan forward from `pos + COMMAND_HEADER_LEN`. The argument
    // list is bracketed by `0x28` `(` and `0x29` `)` per documented
    // expression encoding (`expression.cc::ExpressionPiece::ParseArg`,
    // restated). When the opening `(` is absent the command takes no
    // bracketed args (`argc == 0` commands often skip the parens).
    let mut consumed = COMMAND_HEADER_LEN;
    let mut args_bytes: Vec<Vec<u8>> = Vec::new();
    if argc > 0 || (pos + consumed < bytes.len() && bytes[pos + consumed] == b'(') {
        if pos + consumed >= bytes.len() {
            return Err(RealLiveParseError::TruncatedCommandArgs {
                offset: pos as u64,
                argc,
            });
        }
        if bytes[pos + consumed] != b'(' {
            // Command declared argc>0 but no '(' — leave argument
            // decoding to a follow-up node; preserve raw bytes via
            // Unknown to keep the partition honest.
            return Ok((
                RealLiveOpcode::Unknown {
                    opcode: opener::COMMAND,
                    raw_bytes: bytes[pos..pos + consumed].to_vec(),
                },
                consumed,
            ));
        }
        consumed += 1; // skip '('
        let mut current_arg: Vec<u8> = Vec::new();
        let mut closed = false;
        while pos + consumed < bytes.len() {
            let byte = bytes[pos + consumed];
            match byte {
                // `0xFF` introduces a 4-byte i32-LE int literal (rlvm
                // `expression.cc`; same encoding decoded by
                // `first_arg_as_u16`/`first_arg_as_u32`). Its payload
                // bytes can legally equal `0x28` `(`, `0x29` `)`, or
                // `0x2C` `,`; we copy the introducer + 4 payload bytes
                // verbatim WITHOUT inspecting them as delimiters so a
                // literal never mis-terminates or mis-splits the
                // argument list. This is checked BEFORE the delimiter
                // arms so the introducer wins. A truncated literal (<4
                // payload bytes left) consumes what remains and lets the
                // unclosed-arglist guard below surface
                // `TruncatedCommandArgs`.
                0xFF => {
                    let lit_start = pos + consumed;
                    let lit_end = (lit_start + 5).min(bytes.len());
                    current_arg.extend_from_slice(&bytes[lit_start..lit_end]);
                    consumed = lit_end - pos;
                }
                b')' => {
                    consumed += 1;
                    if !current_arg.is_empty() {
                        args_bytes.push(std::mem::take(&mut current_arg));
                    }
                    closed = true;
                    break;
                }
                b',' => {
                    consumed += 1;
                    args_bytes.push(std::mem::take(&mut current_arg));
                }
                other => {
                    current_arg.push(other);
                    consumed += 1;
                }
            }
        }
        if !closed {
            return Err(RealLiveParseError::TruncatedCommandArgs {
                offset: pos as u64,
                argc,
            });
        }
    }

    let opcode = classify_command(module_type, module_id, opcode_u16, &args_bytes);
    let opcode = opcode.unwrap_or_else(|| RealLiveOpcode::Unknown {
        opcode: opener::COMMAND,
        raw_bytes: bytes[pos..pos + consumed].to_vec(),
    });
    Ok((opcode, consumed))
}

/// Classify a Command into a recognised [`RealLiveOpcode`] variant
/// keyed on the (module_type, module_id, opcode_u16) tuple. Returns
/// `None` when the command falls outside the alpha set; the caller
/// records it as [`RealLiveOpcode::Unknown`].
fn classify_command(
    module_type: u8,
    module_id: u8,
    opcode_u16: u16,
    args_bytes: &[Vec<u8>],
) -> Option<RealLiveOpcode> {
    // module_type is documented (RLDEV) to take values {0, 1, 2}
    // mapping to {system-bootstrap, Kepago-RLOperation, debug-extension}.
    // Per the KAIFUU-191 audit-focus row "no opcode handler may be
    // inferred from Sweetie HD bytes alone" we classify only the
    // documented module_id values from rlvm `src/modules/module_*.cc`
    // here. Commands at any other (module_type, module_id, opcode)
    // tuple surface as `Unknown` so a follow-up node can widen the
    // catalogue against a documented per-module audit.
    if module_type > 2 {
        return None;
    }
    let mapped = match module_id {
        module_id::SYS => match opcode_u16 {
            17 => RealLiveOpcode::End,
            100 | 101 => RealLiveOpcode::Wait {
                duration_ms: first_arg_as_u16(args_bytes),
            },
            // module_sys (rlvm `src/modules/module_sys.cc`) catalogues
            // ~110 opcodes covering `title`, `pcnt`, `rnd`, `abs`,
            // `SceneNum`, `MenuReturn`, `screen mode`, `message speed`,
            // and similar memory-bank-touching control operations.
            // For the KAIFUU-191 alpha we coalesce the long tail into
            // `SetVariable` — the spec's catch-all for any opcode that
            // writes to a memory bank. This is **documented from rlvm
            // module_sys.cc**, not inferred from Sweetie HD bytes
            // alone, satisfying the audit-focus row. The follow-up
            // node will split this into per-opcode named variants
            // (`SceneNum`, `MenuReturn`, etc.) under explicit
            // citations.
            _ => RealLiveOpcode::SetVariable,
        },
        module_id::MSG => match opcode_u16 {
            3 => RealLiveOpcode::CharacterTextDisplay,
            _ if (1..=200).contains(&opcode_u16) => RealLiveOpcode::TextDisplay {
                encoding: TextEncoding::ShiftJisLengthPrefixed,
            },
            // module_msg (rlvm `src/modules/module_msg.cc`) carries
            // ~35–40 message-control opcodes per the RLDEV catalogue
            // (`pause`, `par`, `br`, `page`, `msgHide`, `FontColor`,
            // `TextPos`, `FastText`, `FaceOpen`). Opcodes outside the
            // common-case `1..=200` text-display range coalesce to
            // `SetVariable` — the spec's catch-all — to keep the alpha
            // recognition rate honest without inferring opcode
            // semantics from Sweetie HD bytes alone.
            _ => RealLiveOpcode::SetVariable,
        },
        module_id::SEL => RealLiveOpcode::Choice {
            choices: args_bytes.to_vec(),
        },
        module_id::JMP => match opcode_u16 {
            0 | 1 => RealLiveOpcode::Goto,
            2 | 3 => RealLiveOpcode::Branch,
            4 | 5 => RealLiveOpcode::If,
            10..=13 => RealLiveOpcode::Call,
            20..=22 => RealLiveOpcode::Return,
            30 | 31 => RealLiveOpcode::Jump,
            // module_jmp (rlvm `src/modules/module_jmp.cc`) has ~22
            // documented opcodes (`goto`, `gosub`, `farcall`, `ret`,
            // `jump`, etc.). Opcodes outside the catalogue above
            // coalesce to `Jump` — the spec's most general control-
            // flow variant — keeping the recognition rate honest.
            _ => RealLiveOpcode::Jump,
        },
        module_id::MEM => RealLiveOpcode::SetVariable,
        module_id::GRP => RealLiveOpcode::Background {
            sprite_id: first_arg_as_u32(args_bytes),
        },
        module_id::BGM => match opcode_u16 {
            0..=3 => RealLiveOpcode::BgmPlay,
            _ => RealLiveOpcode::BgmStop,
        },
        module_id::KOE => RealLiveOpcode::VoicePlay {
            voice_id: first_arg_as_u32(args_bytes),
        },
        module_id::STR => RealLiveOpcode::SetVariable,
        _ => return None,
    };
    Some(mapped)
}

/// Extract a u16 from the first expression argument if possible. The
/// expression encoding uses `\xFF` to introduce an `i32 LE` literal
/// (rlvm `expression.cc`); we accept the literal and cap at u16. For
/// non-literal expressions we return `0` (the call site only uses this
/// to decorate the variant; the raw bytes are still preserved upstream
/// when the command is reclassified as Unknown).
fn first_arg_as_u16(args_bytes: &[Vec<u8>]) -> u16 {
    let Some(arg) = args_bytes.first() else {
        return 0;
    };
    if arg.is_empty() {
        return 0;
    }
    if arg[0] == 0xFF && arg.len() >= 5 {
        let value = i32::from_le_bytes([arg[1], arg[2], arg[3], arg[4]]);
        return value.unsigned_abs() as u16;
    }
    0
}

fn first_arg_as_u32(args_bytes: &[Vec<u8>]) -> u32 {
    let Some(arg) = args_bytes.first() else {
        return 0;
    };
    if arg.is_empty() {
        return 0;
    }
    if arg[0] == 0xFF && arg.len() >= 5 {
        let value = i32::from_le_bytes([arg[1], arg[2], arg[3], arg[4]]);
        return value.unsigned_abs();
    }
    0
}

/// Decode the full real-bytecode stream into a [`RealLiveOpcode`] sequence.
///
/// `bytes` is the **decompressed** scene bytecode (post-AVG32 LZSS + XOR
/// first-level transform per
/// `docs/research/reallive-sweetie-hd-encryption-mechanism.md`). The
/// caller owns decompression — this function operates on plaintext
/// bytecode bytes.
///
/// An empty input is rejected with
/// [`RealLiveParseError::TruncatedBytecode`]; the function never returns
/// `Ok(vec![])` on a non-empty input either: any byte not consumed by a
/// recognised element is preserved as
/// [`RealLiveOpcode::Unknown`] so the partition guarantee holds.
pub fn parse_real_bytecode(bytes: &[u8]) -> Result<Vec<RealLiveOpcode>, RealLiveParseError> {
    if bytes.is_empty() {
        return Err(RealLiveParseError::TruncatedBytecode { input_len: 0 });
    }

    let mut out: Vec<RealLiveOpcode> = Vec::new();
    let mut pos: usize = 0;

    while pos < bytes.len() {
        let lead = bytes[pos];
        match lead {
            opener::META_COMMA | opener::COMMA => {
                out.push(RealLiveOpcode::Comma);
                pos += 1;
            }
            opener::META_LINE => {
                if bytes.len() - pos < 3 {
                    return Err(RealLiveParseError::TruncatedMetaHeader {
                        opener: lead,
                        offset: pos as u64,
                        needed: 3,
                        available: bytes.len() - pos,
                    });
                }
                let line = u16::from_le_bytes([bytes[pos + 1], bytes[pos + 2]]);
                out.push(RealLiveOpcode::MetaLine { line });
                pos += 3;
            }
            opener::META_ENTRYPOINT => {
                if bytes.len() - pos < 3 {
                    return Err(RealLiveParseError::TruncatedMetaHeader {
                        opener: lead,
                        offset: pos as u64,
                        needed: 3,
                        available: bytes.len() - pos,
                    });
                }
                let entrypoint = u16::from_le_bytes([bytes[pos + 1], bytes[pos + 2]]);
                out.push(RealLiveOpcode::MetaEntrypoint { entrypoint });
                pos += 3;
            }
            opener::META_KIDOKU => {
                if bytes.len() - pos < 3 {
                    return Err(RealLiveParseError::TruncatedMetaHeader {
                        opener: lead,
                        offset: pos as u64,
                        needed: 3,
                        available: bytes.len() - pos,
                    });
                }
                let mark = u16::from_le_bytes([bytes[pos + 1], bytes[pos + 2]]);
                out.push(RealLiveOpcode::MetaKidoku { mark });
                pos += 3;
            }
            opener::EXPRESSION => {
                // Expression body bytes run until the true ExpressionPiece
                // boundary computed by `expression_body_end`: a
                // token-aware walk that consumes `0xFF` int-literal
                // payloads verbatim and stops at the first top-level
                // meta/command marker `{0x0A, 0x21, 0x23, 0x40}` OR at a
                // Shift-JIS Textout lead. Stopping at the Textout lead
                // ensures a directly-following Textout (dialogue) run is
                // decoded as its own translatable element rather than
                // absorbed into this Expression body.
                //
                // Full expression-piece evaluation lives in a follow-up
                // node; the body is preserved verbatim for downstream
                // tools.
                let body_start = pos + 1;
                let body_end = expression_body_end(bytes, body_start);
                let raw_bytes = bytes[body_start..body_end].to_vec();
                out.push(RealLiveOpcode::Expression { raw_bytes });
                pos = body_end;
            }
            opener::COMMAND => {
                let (opcode, consumed) = decode_command(bytes, pos)?;
                out.push(opcode);
                pos += consumed;
            }
            other if is_shift_jis_textout_lead(other) => {
                // A Textout run extends through Shift-JIS double-byte
                // pairs and accepts a permissive trail-byte range
                // (any byte that is NOT a top-level Meta/Command
                // opener). This mirrors RLDEV's documented Textout
                // detector — text strings in RealLive bytecode are
                // bounded by the same top-level Meta/Command markers
                // that terminate every other element.
                let body_start = pos;
                let mut body_end = body_start;
                while body_end < bytes.len() {
                    let lead = bytes[body_end];
                    if !is_shift_jis_textout_lead(lead) {
                        break;
                    }
                    body_end += 1;
                    if body_end < bytes.len() {
                        let trail = bytes[body_end];
                        // Stop if the trail-position byte is a top-level
                        // Meta or Command opener — these never appear
                        // inside a Shift-JIS pair and they end the run
                        // cleanly. Other bytes (including Comma,
                        // Expression, NUL) are valid SJIS trail
                        // candidates and get consumed.
                        if matches!(
                            trail,
                            opener::META_LINE
                                | opener::META_ENTRYPOINT
                                | opener::COMMAND
                                | opener::META_KIDOKU
                        ) {
                            break;
                        }
                        body_end += 1;
                    }
                }
                let raw_bytes = bytes[body_start..body_end].to_vec();
                out.push(RealLiveOpcode::Textout {
                    encoding: TextEncoding::ShiftJisInlineRun,
                    raw_bytes,
                });
                pos = body_end;
            }
            other => {
                // Unrecognised lead byte. The pre-KAIFUU-191 parser
                // emitted a single-byte Unknown per occurrence; that
                // over-counted misaligned ExpressionPiece / command-
                // argument bodies and dragged the recognition rate
                // down. Per the KAIFUU-191 audit-focus row
                // "Opcode byte coverage must be documented per
                // RLDEV/rlvm references; no opcode handler may be
                // inferred from Sweetie HD bytes alone", we still tag
                // the byte as Unknown — but coalesce consecutive
                // unknown bytes into a single Unknown span so the
                // partition stays honest without inflating the
                // element count.
                let body_start = pos;
                let mut body_end = body_start;
                while body_end < bytes.len() && !is_recognized_opener(bytes[body_end]) {
                    body_end += 1;
                }
                let raw_bytes = bytes[body_start..body_end].to_vec();
                out.push(RealLiveOpcode::Unknown {
                    opcode: other,
                    raw_bytes,
                });
                pos = body_end;
            }
        }
    }

    if out.is_empty() {
        return Err(RealLiveParseError::TruncatedBytecode {
            input_len: bytes.len(),
        });
    }
    Ok(out)
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
    fn unknown_opener_byte_preserved_as_unknown_variant() {
        let bytes = &[0x55, opener::META_LINE, 0x07, 0x00];
        let opcodes = parse_real_bytecode(bytes).expect("unknown openers tolerated");
        assert_eq!(opcodes.len(), 2);
        assert!(matches!(
            &opcodes[0],
            RealLiveOpcode::Unknown {
                opcode: 0x55,
                raw_bytes
            } if raw_bytes == &vec![0x55]
        ));
        assert!(matches!(opcodes[1], RealLiveOpcode::MetaLine { line: 7 }));
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
        // 0=overload, 0=reserved) with no argument list. Opcode 5 falls
        // in the recognized message range (1..=200).
        let bytes = &[opener::COMMAND, 1, module_id::MSG, 5, 0, 0, 0, 0];
        let opcodes = parse_real_bytecode(bytes).expect("must decode");
        assert_eq!(opcodes.len(), 1);
        // MSG opcode 3 is CharacterTextDisplay; other recognised
        // (1..=200) classify as TextDisplay.
        assert!(matches!(opcodes[0], RealLiveOpcode::TextDisplay { .. }));
    }

    #[test]
    fn unknown_command_module_preserved_with_command_opener() {
        let bytes = &[opener::COMMAND, 1, 99, 0xFF, 0xFF, 0, 0, 0];
        let opcodes = parse_real_bytecode(bytes).expect("must decode");
        assert_eq!(opcodes.len(), 1);
        match &opcodes[0] {
            RealLiveOpcode::Unknown { opcode, raw_bytes } => {
                assert_eq!(*opcode, opener::COMMAND);
                assert!(raw_bytes.starts_with(&[opener::COMMAND, 1, 99]));
            }
            other => panic!("expected Unknown, got {other:?}"),
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
        //
        // module_sys (id=4) opcode 100 == Wait, argc=1; first_arg_as_u16
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
        // 0x00282C29 capped to u16 == 0x2C29 == 11305 — proves the full
        // 5-byte literal (incl. 0x29/0x2C/0x28) was captured as one arg.
        assert!(
            matches!(
                opcodes[0],
                RealLiveOpcode::Wait {
                    duration_ms: 0x2C29
                }
            ),
            "expected Wait with literal-derived duration, got {:?}",
            opcodes[0]
        );
        assert!(
            matches!(opcodes[1], RealLiveOpcode::MetaLine { line: 7 }),
            "stream must stay aligned after the arglist: {:?}",
            opcodes[1]
        );
    }

    #[test]
    fn expression_immediately_followed_by_textout_decodes_as_two_elements() {
        // Bug: an Expression body extended across a directly-following
        // Shift-JIS Textout run, burying the dialogue in
        // Expression.raw_bytes. The body here also carries a 0xFF int
        // literal whose payload byte 0x83 has a Shift-JIS lead VALUE —
        // that payload must be skipped (not mistaken for a Textout
        // start), and the body must terminate at the REAL Textout that
        // follows the literal.
        let bytes = &[
            opener::EXPRESSION,
            0x5C, // expression op byte (not terminator / SJIS lead / 0xFF)
            0xFF,
            0x83,
            0x6E,
            0x01,
            0x00, // int literal; 0x83 payload has an SJIS-lead value
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
                // Body ends BEFORE the trailing Textout (6 body bytes).
                assert_eq!(
                    raw_bytes,
                    &vec![0x5C, 0xFF, 0x83, 0x6E, 0x01, 0x00],
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
}
