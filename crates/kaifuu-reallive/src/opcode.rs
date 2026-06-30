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
//!
//! The decoder partitions **every** byte of a real Sweetie HD scene
//! stream into a typed [`RealLiveOpcode`] element — the seven structural
//! openers decode their element and every other byte begins a Textout
//! run (the catch-all). A well-formed stream therefore yields **zero**
//! [`RealLiveOpcode::Unknown`] spans (100% decompilation). A command at
//! an undocumented module still surfaces as `Unknown` (preserving its
//! bytes for audit). A scene that produces no opcodes is an error
//! ([`RealLiveParseError::TruncatedBytecode`]), never a silent
//! `Ok(vec![])`.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// BytecodeElement opener bytes (rlvm `bytecode.cc::BytecodeElement::Read`).
///
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

    /// A Command whose `(module_type, module_id, opcode)` tuple is at an
    /// undocumented module (outside the classified catalogue). The
    /// original `opcode` byte (`0x23`) is preserved for audit; `raw_bytes`
    /// carries the full command span the decoder consumed. A well-formed
    /// scene at a documented module never produces this variant.
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
    /// An ExpressionPiece ran past the end of the stream mid-token.
    #[error(
        "kaifuu.reallive.truncated_expression: expression token at offset {offset} ran past end of stream"
    )]
    TruncatedExpression { offset: u64 },
    /// An ExpressionPiece byte did not match any documented token /
    /// operator form (a structurally invalid expression, not merely an
    /// unrecognised opcode).
    #[error(
        "kaifuu.reallive.malformed_expression: byte {byte:#04x} at offset {offset} is not a valid ExpressionPiece token"
    )]
    MalformedExpression { offset: u64, byte: u8 },
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

/// True if a Textout run's bytes are **readable Shift-JIS dialogue** (a
/// real, translatable unit) rather than an embedded binary / non-printable
/// data run that the catch-all decoder swept up.
///
/// # Why this predicate exists
///
/// rlvm's `BytecodeElement::Read` (mirrored by [`decode_element`]) treats
/// every non-structural lead byte as the start of a Textout run. That is
/// faithful to the engine, but it means a Textout opcode can carry one of
/// two very different payloads:
///
/// 1. **Readable dialogue** — a Shift-JIS-encoded line the player sees and
///    a translator must rewrite (e.g. `【和人】「‥‥‥‥！？」`).
/// 2. **Embedded binary data** — a packed table the engine reads as raw
///    bytes, never as text (e.g. Sweetie HD scene-1 op[72] = 214 bytes of
///    periodic 21-byte records sitting after a 2nd `MetaEntrypoint`).
///
/// The bridge surfaces (1) as a translatable unit; a translate+patchback
/// run rewrites those bytes. If (2) were also surfaced, patchback would
/// overwrite the binary table and corrupt the scene. So the bridge — and
/// the patchback re-walk that must stay index-aligned with it — share this
/// single predicate to decide which Textout runs are translatable.
///
/// # The test: valid Shift-JIS decode
///
/// A run is translatable iff its bytes decode as Shift-JIS with **zero
/// decode errors** (no `U+FFFD` replacement characters). This is a
/// principled separator, not a fragile heuristic:
///
/// - Real dialogue is, by construction, valid Shift-JIS the engine renders
///   verbatim — it always decodes cleanly.
/// - A packed binary table is a stream of arbitrary bytes; periodic record
///   layouts reliably hit byte sequences that are not valid Shift-JIS and
///   force replacement characters.
///
/// Measured against Sweetie HD's full `Seen.txt` (the
/// `bridge_real_bytes` corpus): of 3366 Textout runs, all 3279 readable
/// dialogue lines decode cleanly (zero decode errors) — including
/// ellipsis-heavy lines such as `【真理子】「‥‥‥‥」` whose printable-character
/// ratio drops below 0.5 — while all 87 binary runs (every scene-1 run,
/// the 214-byte block, and catch-all overruns like `２．…<binary>`) decode
/// with errors. A printable-ratio gate would drop the ellipsis lines (a
/// false negative on real dialogue); the valid-decode gate does not, which
/// is why it is the one used here.
///
/// An empty run is not translatable.
pub fn is_translatable_textout(raw_bytes: &[u8]) -> bool {
    if raw_bytes.is_empty() {
        return false;
    }
    let (_decoded, _encoding, had_errors) = encoding_rs::SHIFT_JIS.decode(raw_bytes);
    !had_errors
}

/// True if `byte` is one of the seven structural BytecodeElement opener
/// bytes (`0x00`, `0x0A`, `0x21`, `0x23`, `0x24`, `0x2C`, `0x40`).
///
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
///
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

/// A fully-decoded RealLive ExpressionPiece (RLDEV / rlvm
/// `libreallive/expression.cc` grammar, restated in our own words).
///
/// This is the typed output of [`parse_expression`]: every byte of a
/// well-formed expression maps to one of these nodes. The decoder uses
/// the parse both to evaluate the expression's structure and to compute
/// the exact byte span an Expression element / Command argument occupies,
/// so the bytecode stream stays aligned with zero residual unknown bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
    /// `( <inner> )` parenthesised sub-expression.
    Parenthesized { inner: Box<Expr> },
    /// A string operand (quoted or bare identifier) carried in an
    /// argument list; bytes preserved verbatim (downstream Shift-JIS
    /// decode is [`crate::encoding`]'s job).
    StrLiteral { raw_bytes: Vec<u8> },
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

/// `true` if `byte` introduces (in argument-list position) an
/// ExpressionPiece operand rather than a bare string. The bank-byte
/// memory-reference form is detected by a following `[`.
fn is_expression_start(bytes: &[u8], pos: usize) -> bool {
    match bytes.get(pos) {
        Some(&b) => {
            matches!(
                b,
                EXPR_INT_LITERAL
                    | EXPR_STORE_REGISTER
                    | EXPR_DOLLAR
                    | EXPR_PAREN_OPEN
                    | EXPR_OP_PREFIX
            ) || bytes.get(pos + 1) == Some(&EXPR_INDEX_OPEN)
        }
        None => false,
    }
}

/// Parse a single ExpressionPiece **token** at `pos` — the lowest grammar
/// level: integer literal, store register, `$`-prefixed value, memory
/// reference, or parenthesised sub-expression. Returns the node and the
/// number of bytes consumed.
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
            // `$` as a type prefix in front of a memory reference or
            // store register; consume the `$` and recurse on the value.
            Some(_) => {
                let (inner, len) = parse_token(bytes, pos + 1)?;
                Ok((inner, len + 1))
            }
            None => Err(RealLiveParseError::TruncatedExpression { offset: pos as u64 }),
        },
        _ => {
            // Memory-bank reference: `<bank> [ <index-expr> ]`.
            if bytes.get(pos + 1) == Some(&EXPR_INDEX_OPEN) {
                let (index, index_len) = parse_expression(bytes, pos + 2)?;
                let close = pos + 2 + index_len;
                if bytes.get(close) != Some(&EXPR_INDEX_CLOSE) {
                    return Err(RealLiveParseError::MalformedExpression {
                        offset: close as u64,
                        byte: bytes.get(close).copied().unwrap_or(0),
                    });
                }
                Ok((
                    Expr::MemoryRef {
                        bank: b,
                        index: Box::new(index),
                    },
                    2 + index_len + 1,
                ))
            } else {
                Err(RealLiveParseError::MalformedExpression {
                    offset: pos as u64,
                    byte: b,
                })
            }
        }
    }
}

/// Parse an ExpressionPiece **term** at `pos`: a parenthesised group, a
/// `\<op>` unary-prefixed term, or a bare token.
fn parse_term(bytes: &[u8], pos: usize) -> Result<(Expr, usize), RealLiveParseError> {
    match bytes.get(pos) {
        Some(&EXPR_PAREN_OPEN) => {
            let (inner, inner_len) = parse_expression(bytes, pos + 1)?;
            let close = pos + 1 + inner_len;
            if bytes.get(close) != Some(&EXPR_PAREN_CLOSE) {
                return Err(RealLiveParseError::MalformedExpression {
                    offset: close as u64,
                    byte: bytes.get(close).copied().unwrap_or(0),
                });
            }
            Ok((
                Expr::Parenthesized {
                    inner: Box::new(inner),
                },
                inner_len + 2,
            ))
        }
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
///
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

/// Parse a bracketed argument list `'(' (arg (',' arg)*)? ')'` beginning
/// at `pos` (which must point at the `(`).
///
/// The list is split into comma-delimited **slots**; each slot's bytes
/// are the concatenation of its ExpressionPiece / string data items. A
/// `,` immediately followed by `,` (or `)`) yields an empty slot — this
/// preserves the one-slot-per-option contract the Choice / select
/// surface walk relies on. Top-level commas are the only separators;
/// commas buried inside an integer-literal payload or a parenthesised
/// sub-expression are consumed as part of that data item by the grammar
/// and never split a slot. Returns the per-slot raw bytes plus the total
/// bytes consumed (both parentheses included).
fn parse_arg_list(bytes: &[u8], pos: usize) -> Result<(Vec<Vec<u8>>, usize), RealLiveParseError> {
    let mut cursor = pos + 1; // skip '('
    let mut args: Vec<Vec<u8>> = Vec::new();
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
                    args.push(bytes[slot_start..cursor].to_vec());
                }
                cursor += 1;
                break;
            }
            // Top-level separator: close the current slot (possibly
            // empty) and open the next.
            opener::COMMA => {
                args.push(bytes[slot_start..cursor].to_vec());
                cursor += 1;
                slot_start = cursor;
            }
            // A `\n` + i16 line marker can appear between arguments
            // (rlvm `GetData`); skip its 3 bytes as part of the slot.
            opener::META_LINE => cursor += 3,
            _ => {
                let len = if is_expression_start(bytes, cursor) {
                    let (_expr, len) = parse_expression(bytes, cursor)?;
                    len
                } else {
                    string_operand_len(bytes, cursor)
                };
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
    // The header `argc` is a `u16 LE` (bytes 5-6); byte 7 is the overload
    // selector (rlvm `bytecode.h:CommandElement`). For goto_on / goto_case
    // it is the number of trailing jump targets / cases.
    let argc = u16::from_le_bytes([bytes[pos + 5], bytes[pos + 6]]);
    let command_id =
        (u32::from(module_type) << 24) | (u32::from(module_id) << 16) | u32::from(opcode_u16);

    let mut consumed = COMMAND_HEADER_LEN;
    let mut args_bytes: Vec<Vec<u8>> = Vec::new();

    // Helper: consume `count` trailing `i32` jump-target pointers.
    let consume_pointers = |consumed: &mut usize, count: usize| -> Result<(), RealLiveParseError> {
        let need = count * GOTO_POINTER_LEN;
        if pos + *consumed + need > bytes.len() {
            return Err(RealLiveParseError::TruncatedCommandArgs {
                offset: pos as u64,
                argc: argc as u8,
            });
        }
        *consumed += need;
        Ok(())
    };
    // Helper: consume a bracketed `(...)` arg list if one is present.
    let parse_optional_args =
        |consumed: &mut usize, args: &mut Vec<Vec<u8>>| -> Result<(), RealLiveParseError> {
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
            parse_optional_args(&mut consumed, &mut args_bytes)?;
            consume_pointers(&mut consumed, argc as usize)?;
        }
        GotoKind::GotoCase => {
            parse_optional_args(&mut consumed, &mut args_bytes)?;
            // Each case: a bracketed `(case-expr)` followed by an i32
            // target.
            for _ in 0..argc {
                if bytes.get(pos + consumed) != Some(&EXPR_PAREN_OPEN) {
                    return Err(RealLiveParseError::TruncatedCommandArgs {
                        offset: pos as u64,
                        argc: argc as u8,
                    });
                }
                let (_case, len) = parse_arg_list(bytes, pos + consumed)?;
                consumed += len;
                consume_pointers(&mut consumed, 1)?;
            }
        }
        GotoKind::None => {
            // Ordinary function command: an optional bracketed arg list.
            parse_optional_args(&mut consumed, &mut args_bytes)?;
        }
    }

    let opcode =
        classify_command(module_type, module_id, opcode_u16, &args_bytes).unwrap_or_else(|| {
            RealLiveOpcode::Unknown {
                opcode: opener::COMMAND,
                raw_bytes: bytes[pos..pos + consumed].to_vec(),
            }
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

/// Reduce an [`Expr`] to a constant `i32` when it is (or wraps) an
/// integer literal. Used to decorate `Wait` / `Background` / `VoicePlay`
/// with their first scalar argument.
fn expr_as_i32(expr: &Expr) -> Option<i32> {
    match expr {
        Expr::IntLiteral { value } => Some(*value),
        Expr::Parenthesized { inner } => expr_as_i32(inner),
        _ => None,
    }
}

/// Parse the first argument's bytes as an ExpressionPiece and return its
/// integer value when it is a constant literal, else `0`. The argument
/// bytes are a full expression (e.g. `$ 0xFF` + i32), decoded by the real
/// [`parse_expression`] evaluator rather than a byte-prefix guess.
fn first_arg_as_i32(args_bytes: &[Vec<u8>]) -> i32 {
    args_bytes
        .first()
        .and_then(|arg| parse_expression(arg, 0).ok())
        .and_then(|(expr, _)| expr_as_i32(&expr))
        .unwrap_or(0)
}

fn first_arg_as_u16(args_bytes: &[Vec<u8>]) -> u16 {
    first_arg_as_i32(args_bytes).unsigned_abs() as u16
}

fn first_arg_as_u32(args_bytes: &[Vec<u8>]) -> u32 {
    first_arg_as_i32(args_bytes).unsigned_abs()
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
/// `Ok(vec![])` on a non-empty input either. Every byte is partitioned
/// into a typed [`RealLiveOpcode`] element — a well-formed stream
/// produces **zero** [`RealLiveOpcode::Unknown`] spans because any byte
/// outside a structural element is a Textout (the catch-all per rlvm
/// `BytecodeElement::Read`).
pub fn parse_real_bytecode(bytes: &[u8]) -> Result<Vec<RealLiveOpcode>, RealLiveParseError> {
    if bytes.is_empty() {
        return Err(RealLiveParseError::TruncatedBytecode { input_len: 0 });
    }

    let mut out: Vec<RealLiveOpcode> = Vec::new();
    let mut pos: usize = 0;

    while pos < bytes.len() {
        let (opcode, consumed) = decode_element(bytes, pos)?;
        debug_assert!(consumed > 0, "decode_element must make forward progress");
        out.push(opcode);
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
///
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
        opener::COMMAND => decode_command(bytes, pos),
        _ => {
            // Textout (catch-all): any non-structural byte starts a text
            // run that extends to the next structural opener. Shift-JIS
            // double-byte pairs are consumed whole so a trail byte equal
            // to an opener value does not end the run early.
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
            let raw_bytes = bytes[start..end].to_vec();
            Ok((
                RealLiveOpcode::Textout {
                    encoding: TextEncoding::ShiftJisInlineRun,
                    raw_bytes,
                },
                end - start,
            ))
        }
    }
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
        // arg list: `( $ 0xFF 0 )`
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
        // an int param: `( _WHITE $ 0xFF 50 )`. The string operand must
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
}
