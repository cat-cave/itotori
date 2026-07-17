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
//! Sweetie HD scene #0001 decompressed bytes
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
//! in `tests/bytecode_element_real_bytes.rs` against the Sweetie HD
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

use serde::{Deserialize, Serialize};

mod command_decode;
mod select_choice;
pub use self::select_choice::extract_select_choice_texts;

use self::command_decode::decode_command;

/// Lead byte introducing a [`BytecodeElement::MetaLine`] (source-line
/// number marker).
pub const META_LINE_LEAD_BYTE: u8 = 0x0A;
/// Lead byte introducing a [`BytecodeElement::MetaEntrypoint`]
/// (`!N` entrypoint marker).
pub const META_ENTRYPOINT_LEAD_BYTE: u8 = 0x21;
/// Lead byte introducing a [`BytecodeElement::MetaKidoku`]
/// (`@N` kidoku read-tracking marker).
pub const META_KIDOKU_LEAD_BYTE: u8 = 0x40;
/// Lead byte introducing a [`BytecodeElement::Command`].
pub const COMMAND_LEAD_BYTE: u8 = 0x23;
/// Lead byte introducing a [`BytecodeElement::Expression`].
pub const EXPRESSION_LEAD_BYTE: u8 = 0x24;
/// Comma sentinel — synonymous with [`COMMA_LEAD_BYTE_ALT`].
pub const COMMA_LEAD_BYTE: u8 = 0x00;
/// Alternative comma sentinel — RLDEV documents `0x2C` as the same
/// `CommaElement` shape as `0x00`.
pub const COMMA_LEAD_BYTE_ALT: u8 = 0x2C;

/// Fixed byte length of the [`BytecodeElement::Command`] 8-byte header
/// (lead `0x23` plus 7 fields).
pub const COMMAND_HEADER_BYTE_LEN: usize = 8;

/// Fixed byte length of a 3-byte MetaElement (lead byte + `u16 LE`
/// payload).
pub const META_ELEMENT_BYTE_LEN: usize = 3;

/// Inclusive lower bound of the SelectElement option-marker range
/// (`OPTION_COLOUR` in rlvm `bytecode.h`).
pub const SELECTION_OPTION_MARKER_MIN: u8 = 0x30;
/// Inclusive upper bound of the SelectElement option-marker range
/// (`OPTION_CURSOR` in rlvm `bytecode.h`).
pub const SELECTION_OPTION_MARKER_MAX: u8 = 0x34;

/// Encoding hint carried on a [`BytecodeElement::Textout`].
///
/// Textout is loose by design: the RealLive bytecode lexer's default
/// branch absorbs any bytes that do not match a documented opener. The
/// hint reports whether the run started with a Shift-JIS lead byte
/// (`0x81..=0x9F` or `0xE0..=0xFC`) so downstream decoders can pick a
/// codec without re-sniffing the first byte.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextoutEncoding {
    /// The run started with a documented Shift-JIS lead byte. The body
    /// is consumed as a Shift-JIS-aware byte run that does not split
    /// mid-pair.
    ShiftJis,
    /// The run started with a byte that is neither in the structural
    /// opener set nor a Shift-JIS lead. The body is consumed one byte
    /// at a time. The decoder does not fail on these because textout
    /// is documented as "default branch" in RLDEV's lead-byte table.
    Other,
}

/// One decoded element from the RealLive bytecode stream.
///
/// Each variant carries the byte range it occupies in the original
/// input slice so callers can re-slice the raw bytes and so the
/// partition invariant can be asserted at decode time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BytecodeElement {
    /// `0x0A <line:u16 LE>` — source-line number marker (`<line>` in
    /// the source script). 3 bytes total.
    MetaLine {
        /// Source-line number reported by the compiler.
        line_number: u16,
        /// Byte offset of the lead byte within the decoded input slice.
        byte_offset: usize,
        /// Total length in bytes (always 3 for this variant).
        byte_len: usize,
    },
    /// `0x21 <idx:u16 LE>` — entrypoint marker (`!N`). 3 bytes total.
    MetaEntrypoint {
        /// Entrypoint slot index (matches the
        /// [`crate::SceneHeader::entrypoint_table`] indexing).
        entrypoint_index: u16,
        /// Byte offset of the lead byte within the decoded input slice.
        byte_offset: usize,
        /// Total length in bytes (always 3 for this variant).
        byte_len: usize,
    },
    /// `0x40 <id:u16 LE>` — kidoku (read-tracking) marker (`@N`).
    /// 3 bytes total.
    MetaKidoku {
        /// Kidoku slot id within the scene's kidoku table.
        kidoku_id: u16,
        /// Byte offset of the lead byte within the decoded input slice.
        byte_offset: usize,
        /// Total length in bytes (always 3 for this variant).
        byte_len: usize,
    },
    /// `0x23 <module_type><module_id><opcode:u16 LE><arg_count:u16 LE><overload>`
    /// followed by an optional `(`-delimited expression argument list
    /// terminated by `)`, and — for the goto-family commands — one or
    /// more trailing `i32 LE` jump-target pointers (see
    /// [`command_goto_kind`]).
    ///
    /// `raw_bytes` carries the full 8-byte header plus any argument-list
    /// bytes and any trailing goto-pointer bytes.
    Command {
        /// Byte 1 of the header — module-type lattice id.
        module_type: u8,
        /// Byte 2 of the header — module id within the lattice.
        module_id: u8,
        /// Bytes 3..5 of the header — opcode (u16 LE).
        opcode: u16,
        /// Bytes 5..7 of the header — declared argument count (`u16 LE`).
        /// For `goto_on` / `goto_case` this is the number of trailing
        /// jump targets / cases.
        arg_count: u16,
        /// Byte 7 of the header — overload variant selector.
        overload: u8,
        /// Absolute byte offsets (into the decompressed scene bytecode)
        /// of the trailing goto-family jump-target pointers, in order.
        /// Empty for every non-goto command. `goto`/`gosub` carry one;
        /// `goto_on`/`goto_case` carry `arg_count`.
        goto_targets: Vec<u32>,
        /// Per-case match EXPRESSIONS for a `goto_case` / `gosub_case`
        /// command, in case order — one entry per `goto_targets` entry.
        /// Each is the raw expression bytes inside that case's `(…)`
        /// (i.e. between the `(` and its matching `)`); the default case
        /// is the empty `()` and is recorded as an empty `Vec`. Empty for
        /// every command that is not `goto_case` / `gosub_case`. The VM
        /// evaluates these against the discriminant to reproduce the exact
        /// `value == case_i` selection instead of the discriminant-as-index
        /// approximation.
        #[serde(default)]
        goto_case_exprs: Vec<Vec<u8>>,
        /// The full element bytes, including the 8-byte header, any
        /// `(`-delimited argument list, and any trailing goto pointers.
        /// Owned so callers can re-slice without re-walking the source.
        raw_bytes: Vec<u8>,
        /// Byte offset of the lead byte within the decoded input slice.
        byte_offset: usize,
        /// Total length in bytes.
        byte_len: usize,
    },
    /// `0x24 <expression-body>` — standalone expression element.
    /// `raw_bytes` includes the `0x24` lead byte.
    Expression {
        /// The full element bytes, including the `0x24` lead byte.
        raw_bytes: Vec<u8>,
        /// Byte offset of the lead byte within the decoded input slice.
        byte_offset: usize,
        /// Total length in bytes.
        byte_len: usize,
    },
    /// `0x00` or `0x2C` — comma sentinel separating sibling elements.
    /// 1 byte total.
    Comma {
        /// The lead byte that introduced this comma (`0x00` or `0x2C`)
        /// preserved so the value is round-trippable.
        lead_byte: u8,
        /// Byte offset of the lead byte within the decoded input slice.
        byte_offset: usize,
        /// Total length in bytes (always 1 for this variant).
        byte_len: usize,
    },
    /// `0x30..=0x34` — SelectElement option marker
    /// (`OPTION_COLOUR`/`OPTION_TITLE`/`OPTION_HIDE`/`OPTION_BLANK`
    /// `OPTION_CURSOR`). The marker is recognised at lex time so it is
    /// not swallowed by the textout default branch; full SelectElement
    /// option-body decoding is a later work's responsibility.
    SelectionOption {
        /// The lead byte that introduced this option
        /// (`0x30..=0x34`).
        marker: u8,
        /// The full element bytes. Currently this is the 1-byte marker;
        /// the field is `Vec<u8>` so a later work can extend the
        /// shape without breaking the API.
        raw_bytes: Vec<u8>,
        /// Byte offset of the lead byte within the decoded input slice.
        byte_offset: usize,
        /// Total length in bytes.
        byte_len: usize,
    },
    /// Default branch: a run of bytes that did not match any structural
    /// opener. The run is Shift-JIS-aware (it never splits a Shift-JIS
    /// lead/trail pair) but is otherwise treated opaquely.
    Textout {
        /// Encoding hint derived from the first byte of the run.
        encoding_hint: TextoutEncoding,
        /// The full run bytes.
        raw_bytes: Vec<u8>,
        /// Byte offset of the first byte of the run within the decoded
        /// input slice.
        byte_offset: usize,
        /// Total length in bytes.
        byte_len: usize,
    },
}

impl BytecodeElement {
    /// Byte offset of the element's first byte within the decoded
    /// input slice. Centralised so callers do not have to match on
    /// every variant just to read the offset.
    pub fn byte_offset(&self) -> usize {
        match self {
            BytecodeElement::MetaLine { byte_offset, .. }
            | BytecodeElement::MetaEntrypoint { byte_offset, .. }
            | BytecodeElement::MetaKidoku { byte_offset, .. }
            | BytecodeElement::Command { byte_offset, .. }
            | BytecodeElement::Expression { byte_offset, .. }
            | BytecodeElement::Comma { byte_offset, .. }
            | BytecodeElement::SelectionOption { byte_offset, .. }
            | BytecodeElement::Textout { byte_offset, .. } => *byte_offset,
        }
    }

    /// Total byte length of the element. Centralised mirror of
    /// [`Self::byte_offset`].
    pub fn byte_len(&self) -> usize {
        match self {
            BytecodeElement::MetaLine { byte_len, .. }
            | BytecodeElement::MetaEntrypoint { byte_len, .. }
            | BytecodeElement::MetaKidoku { byte_len, .. }
            | BytecodeElement::Command { byte_len, .. }
            | BytecodeElement::Expression { byte_len, .. }
            | BytecodeElement::Comma { byte_len, .. }
            | BytecodeElement::SelectionOption { byte_len, .. }
            | BytecodeElement::Textout { byte_len, .. } => *byte_len,
        }
    }

    /// Static name of the variant, useful for diagnostic
    /// `eprintln!` summaries in the real-bytes test.
    pub fn variant_name(&self) -> &'static str {
        match self {
            BytecodeElement::MetaLine { .. } => "meta_line",
            BytecodeElement::MetaEntrypoint { .. } => "meta_entrypoint",
            BytecodeElement::MetaKidoku { .. } => "meta_kidoku",
            BytecodeElement::Command { .. } => "command",
            BytecodeElement::Expression { .. } => "expression",
            BytecodeElement::Comma { .. } => "comma",
            BytecodeElement::SelectionOption { .. } => "selection_option",
            BytecodeElement::Textout { .. } => "textout",
        }
    }
}

/// Fatal errors raised by [`decode_bytecode_stream`].
///
/// Every recoverable mismatch is a typed variant. There is no
/// `Ok(vec![])` fallback for an empty buffer or a partition mismatch
/// — the alpha-gate "no silent zero-state" contract forbids those.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BytecodeDecodeError {
    /// The input slice was empty or ran out mid-element.
    Truncated {
        /// Total length of the input slice that was offered.
        observed_len: usize,
        /// Decoder position at which the shortfall was detected.
        position: usize,
        /// Number of additional input bytes the decoder needed.
        needed: usize,
        /// Human-readable diagnostic.
        message: String,
    },
    /// The decoder reached a state it could not recover from — for
    /// example an expression body whose lead byte is not in the
    /// documented expression-encoding table, or an unterminated
    /// `(`-delimited argument list.
    MalformedElement {
        /// Decoder position at which the malformed element starts.
        position: usize,
        /// Human-readable diagnostic.
        message: String,
    },
    /// The per-element `byte_offset` and `byte_len` values did not
    /// partition the input slice (sum of lengths != input length, or
    /// the offsets are not monotonically increasing without gaps).
    PartitionMismatch {
        /// Total input length the decoder was given.
        input_len: usize,
        /// Sum of `byte_len` over the produced elements.
        sum_of_element_lengths: usize,
        /// Human-readable diagnostic.
        message: String,
    },
}

impl std::fmt::Display for BytecodeDecodeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BytecodeDecodeError::Truncated {
                observed_len,
                position,
                needed,
                message,
            } => write!(
                formatter,
                "utsushi.reallive.bytecode_element.truncated: observed_len={observed_len} \
                 position={position} needed={needed}: {message}",
            ),
            BytecodeDecodeError::MalformedElement { position, message } => write!(
                formatter,
                "utsushi.reallive.bytecode_element.malformed_element: position={position}: \
                 {message}",
            ),
            BytecodeDecodeError::PartitionMismatch {
                input_len,
                sum_of_element_lengths,
                message,
            } => write!(
                formatter,
                "utsushi.reallive.bytecode_element.partition_mismatch: input_len={input_len} \
                 sum_of_element_lengths={sum_of_element_lengths}: {message}",
            ),
        }
    }
}

impl std::error::Error for BytecodeDecodeError {}

/// `true` when `byte` is a Shift-JIS lead byte per the documented
/// pair-encoding ranges (`0x81..=0x9F` or `0xE0..=0xFC`).
fn is_shift_jis_lead(byte: u8) -> bool {
    matches!(byte, 0x81..=0x9F | 0xE0..=0xFC)
}

/// `true` when `byte` is the lead byte of a structural element (meta
/// command, expression, comma, selection-option marker). Used by the
/// textout walker to know when to stop absorbing bytes.
fn is_structural_lead_byte(byte: u8) -> bool {
    matches!(
        byte,
        COMMA_LEAD_BYTE
            | META_LINE_LEAD_BYTE
            | META_ENTRYPOINT_LEAD_BYTE
            | COMMAND_LEAD_BYTE
            | EXPRESSION_LEAD_BYTE
            | COMMA_LEAD_BYTE_ALT
            | META_KIDOKU_LEAD_BYTE
            | SELECTION_OPTION_MARKER_MIN..=SELECTION_OPTION_MARKER_MAX
    )
}

/// Lex a single RealLive bytecode element starting at `bytes[pos]`.
///
/// Returns the typed element on success. Advances are computed via
/// each variant's `byte_len` field — the caller is responsible for
/// stepping `pos` forward by `element.byte_len()`.
///
/// Exposed `pub` so the VM can fetch one element at a
/// time from a scene's decompressed bytecode without re-walking the
/// full stream on every step.
pub fn decode_one_element(
    bytes: &[u8],
    pos: usize,
) -> Result<BytecodeElement, BytecodeDecodeError> {
    if pos >= bytes.len() {
        return Err(BytecodeDecodeError::Truncated {
            observed_len: bytes.len(),
            position: pos,
            needed: 1,
            message: "decode_one_element called past end of input".to_string(),
        });
    }
    let lead = bytes[pos];

    match lead {
        COMMA_LEAD_BYTE | COMMA_LEAD_BYTE_ALT => Ok(BytecodeElement::Comma {
            lead_byte: lead,
            byte_offset: pos,
            byte_len: 1,
        }),
        META_LINE_LEAD_BYTE => {
            let line_number = read_meta_u16(bytes, pos)?;
            Ok(BytecodeElement::MetaLine {
                line_number,
                byte_offset: pos,
                byte_len: META_ELEMENT_BYTE_LEN,
            })
        }
        META_ENTRYPOINT_LEAD_BYTE => {
            let entrypoint_index = read_meta_u16(bytes, pos)?;
            Ok(BytecodeElement::MetaEntrypoint {
                entrypoint_index,
                byte_offset: pos,
                byte_len: META_ELEMENT_BYTE_LEN,
            })
        }
        META_KIDOKU_LEAD_BYTE => {
            let kidoku_id = read_meta_u16(bytes, pos)?;
            Ok(BytecodeElement::MetaKidoku {
                kidoku_id,
                byte_offset: pos,
                byte_len: META_ELEMENT_BYTE_LEN,
            })
        }
        COMMAND_LEAD_BYTE => decode_command(bytes, pos),
        EXPRESSION_LEAD_BYTE => decode_expression_element(bytes, pos),
        SELECTION_OPTION_MARKER_MIN..=SELECTION_OPTION_MARKER_MAX => {
            Ok(BytecodeElement::SelectionOption {
                marker: lead,
                raw_bytes: vec![lead],
                byte_offset: pos,
                byte_len: 1,
            })
        }
        _ => Ok(decode_textout(bytes, pos)),
    }
}

/// Read the 16-bit LE payload that follows a 3-byte MetaElement lead
/// byte (`0x0A`/`0x21`/`0x40`). Returns
/// [`BytecodeDecodeError::Truncated`] if fewer than 3 bytes remain.
fn read_meta_u16(bytes: &[u8], pos: usize) -> Result<u16, BytecodeDecodeError> {
    let need_end = pos.checked_add(META_ELEMENT_BYTE_LEN).ok_or_else(|| {
        BytecodeDecodeError::MalformedElement {
            position: pos,
            message: "meta-element end offset overflowed usize".to_string(),
        }
    })?;
    if need_end > bytes.len() {
        return Err(BytecodeDecodeError::Truncated {
            observed_len: bytes.len(),
            position: pos,
            needed: need_end - bytes.len(),
            message: format!(
                "meta-element at position {pos} (lead 0x{:02x}) requires {} bytes total",
                bytes[pos], META_ELEMENT_BYTE_LEN,
            ),
        });
    }
    Ok(u16::from_le_bytes([bytes[pos + 1], bytes[pos + 2]]))
}

/// Fixed byte length of a goto-family jump-target pointer (`i32 LE`).
pub const GOTO_POINTER_BYTE_LEN: usize = 4;

/// Maximum recursive expression nesting accepted by this bytecode length
/// walker. This mirrors the semantic expression parser's bound in
/// `expression.rs`: real scenes stay far below it, while hostile input must
/// return a typed decode error instead of overflowing the native stack.
const MAX_EXPRESSION_DEPTH: usize = 256;

/// SelectElement block open brace (`{`).
const SELECT_BLOCK_OPEN: u8 = 0x7B;
/// SelectElement block close brace (`}`).
const SELECT_BLOCK_CLOSE: u8 = 0x7D;

/// Decode a standalone `0x24` ExpressionElement at `bytes[pos]`.
///
/// The `0x24` element opener doubles as the `$` of the first
/// ExpressionPiece token (per rlvm
/// `bytecode.cc::ExpressionElement::ExpressionElement` and
/// `expression.cc::GetExpression`, research anchor only), so the whole
/// element is framed with the general expression walker
/// ([`next_expression`]) starting at `pos`. This is a faithful
/// restatement of the proven `kaifuu-reallive` `decode_element`, which
/// frames the `0x24` element with `parse_expression(bytes, pos)`.
///
/// The compound-assignment idiom (`<dest_term> \<op> <source_expr>`) is
/// the common on-disk shape, but it is just one instance of a general
/// expression: the `\<op>` join and its operand are folded in by the
/// binary-operator continuation in [`next_arith`], which accepts **any**
/// op byte after the `\` prefix. The previous implementation hard-coded
/// the assignment form and rejected any op byte outside `0x14..=0x24`
/// which desynced on real Sweetie HD scene 2 (an expression element whose
/// `\<op>` is `0x03`) where the kaifuu decoder — and the general walker —
/// frame it cleanly. Restricting the `0x24` element to the assignment
/// form was a decoder divergence from kaifuu, not a real grammar rule.
fn decode_expression_element(
    bytes: &[u8],
    pos: usize,
) -> Result<BytecodeElement, BytecodeDecodeError> {
    let expr_len = next_expression(bytes, pos, 0)?;
    let end = pos
        .checked_add(expr_len)
        .ok_or_else(|| BytecodeDecodeError::MalformedElement {
            position: pos,
            message: "expression-element length addition overflowed usize".to_string(),
        })?;
    if end > bytes.len() {
        return Err(BytecodeDecodeError::Truncated {
            observed_len: bytes.len(),
            position: pos,
            needed: end - bytes.len(),
            message: "expression-element extends past end of input".to_string(),
        });
    }
    // The `0x24` lead byte is itself the `$` of the first token, so the
    // walker always consumes at least the 2-byte `$ <bank>` form — a
    // zero-width expression element is impossible and would stall the
    // outer decode loop. Guard it as a typed error rather than a silent
    // non-advance.
    if end == pos {
        return Err(BytecodeDecodeError::MalformedElement {
            position: pos,
            message: "expression-element consumed zero bytes".to_string(),
        });
    }
    let raw_bytes = bytes[pos..end].to_vec();
    Ok(BytecodeElement::Expression {
        raw_bytes,
        byte_offset: pos,
        byte_len: end - pos,
    })
}

/// Walk a textout run starting at `bytes[pos]`. The run absorbs bytes
/// until it hits a structural lead byte (or end-of-input). Shift-JIS
/// lead/trail pairs are consumed atomically so the run does not split
/// mid-pair on a trail byte that happens to coincide with a structural
/// lead byte (`0x40`, `0x23`, etc.).
fn decode_textout(bytes: &[u8], pos: usize) -> BytecodeElement {
    let lead = bytes[pos];
    let encoding_hint = if is_shift_jis_lead(lead) {
        TextoutEncoding::ShiftJis
    } else {
        TextoutEncoding::Other
    };
    let mut p = pos;
    while p < bytes.len() {
        let current = bytes[p];
        if is_shift_jis_lead(current) {
            // Consume the lead + trail atomically. If the trail byte
            // is absent (truncated input), still consume the lead so
            // the partition includes the byte; the caller's outer
            // loop will terminate cleanly at end-of-input.
            if p + 1 < bytes.len() {
                p += 2;
            } else {
                p += 1;
            }
            continue;
        }
        if p > pos && is_structural_lead_byte(current) {
            break;
        }
        if p == pos {
            // First byte of the run: by construction not a structural
            // lead (decode_one_element dispatched us here), and not a
            // Shift-JIS lead (handled above). Consume one byte.
            p += 1;
            continue;
        }
        // Subsequent bytes that are not structural leads and not
        // Shift-JIS leads — keep absorbing as opaque textout body.
        p += 1;
    }
    let raw_bytes = bytes[pos..p].to_vec();
    BytecodeElement::Textout {
        encoding_hint,
        raw_bytes,
        byte_offset: pos,
        byte_len: p - pos,
    }
}

/// Backslash byte (`0x5C`) — the documented operator-introducer
/// prefix in the expression byte encoding (`\<op>` for binary ops
/// `\<op>` for compound assignments, `\<0x00>` no-op, `\<0x01>`
/// unary minus).
const EXPRESSION_BACKSLASH: u8 = 0x5C;

/// Integer-literal introducer (`0xFF`): `0xFF <i32 LE>` (5 bytes), or
/// `$ 0xFF <i32 LE>` (6 bytes) in the `$`-typed form.
const EXPR_INT_LITERAL: u8 = 0xFF;
/// Store-register token (`0xC8`): the `store` pseudo-register — 1 byte
/// bare, or `$ 0xC8` (2 bytes) in the `$`-prefixed idiom.
const EXPR_STORE_REGISTER: u8 = 0xC8;
/// Special-parameter introducer (`0x61`, ASCII `'a'`): `0x61 <tag>
/// <item>` where `<tag>` is a single byte (or `0xFF`+`i32` in the wide
/// form) and `<item>` is a contained data value (per rlvm
/// `SpecialExpressionPiece`).
const EXPR_SPECIAL: u8 = 0x61;

/// `true` when `byte` opens an arithmetic-expression **token** (rlvm
/// `GetExpressionToken`): an integer literal (`0xFF`), the store register
/// (`0xC8`), a `$`-prefixed memory reference / typed literal (`0x24`), or
/// a `\`-operator (`0x5C`). Every other lead byte at a data position is a
/// string constant. Restated from `kaifuu-reallive` `opcode.rs`
/// `is_expr_token_lead` so the two decoders classify data leads
/// identically.
fn is_expr_token_lead(byte: u8) -> bool {
    matches!(
        byte,
        EXPR_INT_LITERAL | EXPR_STORE_REGISTER | EXPRESSION_LEAD_BYTE | EXPRESSION_BACKSLASH
    )
}

/// `true` when `byte` opens a **non-string** data item — a complex
/// parameter (`(`), a special parameter (`0x61`), or an
/// arithmetic-expression token. Used to disambiguate a genuine special
/// parameter from a bare string that merely begins with `0x61` (`'a'`).
/// Restated from `kaifuu-reallive` `is_nonstring_data_lead`.
fn is_nonstring_data_lead(byte: u8) -> bool {
    matches!(byte, b'(' | EXPR_SPECIAL) || is_expr_token_lead(byte)
}

/// `true` when `pos` begins a special parameter (`0x61 <tag> <item>`).
///
/// The compiler emits a special parameter as the `0x61` introducer, a tag
/// (a single byte, or `0xFF`+`i32` in the wide form), and then its
/// contained data item — across the Sweetie HD and Kanon archives that
/// item is always a complex `(` group or a `$`-prefixed memory / literal
/// reference, i.e. a **non-string** data lead. Requiring that lead
/// disambiguates a genuine special parameter from a bare string constant
/// that merely begins with the byte `0x61` (`'a'`). Restated from
/// `kaifuu-reallive` `is_special_param_lead`.
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

/// Compute the byte length of a special parameter `0x61 <tag> <item>`
/// starting at `bytes[pos]` (which must point at the `0x61` introducer).
/// `<tag>` is a single discriminant byte, or `0xFF`+`i32` in the wide
/// form; `<item>` is the contained [`next_data_value`] value (in practice
/// a `Complex` group or a `$`-prefixed reference). Restated from
/// `kaifuu-reallive` `parse_special_param`.
fn next_special_param(
    bytes: &[u8],
    pos: usize,
    depth: usize,
) -> Result<usize, BytecodeDecodeError> {
    ensure_expression_depth(pos, depth)?;
    let tag_len = match bytes.get(pos + 1) {
        Some(&EXPR_INT_LITERAL) => 5,
        Some(_) => 1,
        None => {
            return Err(BytecodeDecodeError::Truncated {
                observed_len: bytes.len(),
                position: pos,
                needed: 1,
                message: "special parameter (`0x61`) missing tag byte".to_string(),
            });
        }
    };
    let content_pos = pos + 1 + tag_len;
    let content_len = next_data_value(bytes, content_pos, depth)?;
    Ok(1 + tag_len + content_len)
}

/// Read the byte at `bytes[pos]` if available; return `None` if `pos`
/// is past the end of the slice. Centralised so the walker family
/// can share a single bounds-check helper.
fn peek(bytes: &[u8], pos: usize) -> Option<u8> {
    bytes.get(pos).copied()
}

/// Return the existing malformed-element error before recursive expression
/// descent can consume enough native stack to abort the process.
fn ensure_expression_depth(pos: usize, depth: usize) -> Result<(), BytecodeDecodeError> {
    if depth > MAX_EXPRESSION_DEPTH {
        return Err(BytecodeDecodeError::MalformedElement {
            position: pos,
            message: format!("expression nesting exceeded depth limit {MAX_EXPRESSION_DEPTH}"),
        });
    }
    Ok(())
}

/// Compute the byte length of a single RealLive **token** starting at
/// `bytes[pos]`.
///
/// A token is the leaf primitive in the expression grammar (per rlvm
/// `expression.cc::NextToken`, research anchor only):
///
/// - `$ 0xff <i32:LE>` — 6-byte int-constant token.
/// - `$ <bank> [ <expression> ]` — memory reference (4 + inner
///   expression length).
/// - `$ <other>` — 2-byte alternative form (e.g. `$ 0xC8` for the
///   store register).
/// - Any leading byte other than `$` returns 0 (the walker treats
///   "not a token" as zero bytes; the caller's grammar layer decides
///   what to do with that).
fn next_token(bytes: &[u8], pos: usize, depth: usize) -> Result<usize, BytecodeDecodeError> {
    ensure_expression_depth(pos, depth)?;
    let Some(b0) = peek(bytes, pos) else {
        return Ok(0);
    };
    // Bare (non-`$`-prefixed) token forms, mirroring `kaifuu-reallive`
    // `parse_token`: an integer literal `0xFF <i32 LE>` (5 bytes) and the
    // bare store register `0xC8` (1 byte). Without these the walker
    // returns 0 for a data item that is a bare literal / store register
    // and the arg-list loop cannot make progress.
    if b0 == EXPR_INT_LITERAL {
        if pos + 5 > bytes.len() {
            return Err(BytecodeDecodeError::Truncated {
                observed_len: bytes.len(),
                position: pos,
                needed: pos + 5 - bytes.len(),
                message: "token: bare 5-byte int-constant truncated".to_string(),
            });
        }
        return Ok(5);
    }
    if b0 == EXPR_STORE_REGISTER {
        return Ok(1);
    }
    if b0 != b'$' {
        return Ok(0);
    }
    let Some(b1) = peek(bytes, pos + 1) else {
        return Err(BytecodeDecodeError::Truncated {
            observed_len: bytes.len(),
            position: pos + 1,
            needed: 1,
            message: "token: missing byte after '$' lead".to_string(),
        });
    };
    if b1 == 0xff {
        // $ ff <i32> = 6-byte int constant.
        if pos + 6 > bytes.len() {
            return Err(BytecodeDecodeError::Truncated {
                observed_len: bytes.len(),
                position: pos,
                needed: pos + 6 - bytes.len(),
                message: "token: 6-byte int-constant truncated".to_string(),
            });
        }
        return Ok(6);
    }
    // $ <bank> -- check what follows.
    let Some(b2) = peek(bytes, pos + 2) else {
        // 2-byte form at end of input (e.g. `$ c8`).
        return Ok(2);
    };
    if b2 != b'[' {
        // 2-byte alternative form (`$ <bank>` with no bracketed index).
        return Ok(2);
    }
    // $ <bank> [ <inner-expression> ]
    let inner = next_expression(bytes, pos + 3, depth + 1)?;
    let close_pos = pos + 3 + inner;
    if close_pos >= bytes.len() {
        return Err(BytecodeDecodeError::Truncated {
            observed_len: bytes.len(),
            position: close_pos,
            needed: 1,
            message: "token: memory-reference missing closing ']'".to_string(),
        });
    }
    if bytes[close_pos] != b']' {
        return Err(BytecodeDecodeError::MalformedElement {
            position: close_pos,
            message: format!(
                "token: memory-reference must close with ']' (0x5D); observed 0x{:02x}",
                bytes[close_pos],
            ),
        });
    }
    Ok(4 + inner)
}

/// Compute the byte length of a single RealLive **term** starting at
/// `bytes[pos]` (per rlvm `expression.cc::NextTerm`):
///
/// - `( <expression> )` — grouped expression (`2 + inner`).
/// - `\ <byte> <term>` — backslash-prefixed unary form (`2 + inner`)
///   covering the no-op (`\0x00`) and unary-minus (`\0x01`) cases.
/// - Otherwise fall through to [`next_token`].
fn next_term(bytes: &[u8], pos: usize, depth: usize) -> Result<usize, BytecodeDecodeError> {
    ensure_expression_depth(pos, depth)?;
    let Some(b0) = peek(bytes, pos) else {
        return Err(BytecodeDecodeError::Truncated {
            observed_len: bytes.len(),
            position: pos,
            needed: 1,
            message: "term: input exhausted".to_string(),
        });
    };
    if b0 == b'(' {
        let inner = next_expression(bytes, pos + 1, depth + 1)?;
        let close_pos = pos + 1 + inner;
        if close_pos >= bytes.len() {
            return Err(BytecodeDecodeError::Truncated {
                observed_len: bytes.len(),
                position: close_pos,
                needed: 1,
                message: "term: grouping missing closing ')'".to_string(),
            });
        }
        if bytes[close_pos] != b')' {
            return Err(BytecodeDecodeError::MalformedElement {
                position: close_pos,
                message: format!(
                    "term: grouping must close with ')' (0x29); observed 0x{:02x}",
                    bytes[close_pos],
                ),
            });
        }
        return Ok(2 + inner);
    }
    if b0 == EXPRESSION_BACKSLASH {
        if pos + 2 > bytes.len() {
            return Err(BytecodeDecodeError::Truncated {
                observed_len: bytes.len(),
                position: pos,
                needed: pos + 2 - bytes.len(),
                message: "term: backslash-prefixed term truncated".to_string(),
            });
        }
        let inner = next_term(bytes, pos + 2, depth + 1)?;
        return Ok(2 + inner);
    }
    next_token(bytes, pos, depth)
}

/// Compute the byte length of a single RealLive **arithmetic
/// expression** starting at `bytes[pos]` (per rlvm
/// `expression.cc::NextArithmatic`).
///
/// Form: `<term> ( \<op> <arith> )?` — a left-hand term optionally
/// extended by a backslash-prefixed binary op and a recursive
/// arithmetic right-hand side. The walker accepts any op byte after
/// `\` here; the documented set is `0x00..=0x09` plus a handful of
/// compound-assignment bytes that may bind tighter, but the
/// byte-length walker does not need to distinguish them.
fn next_arith(bytes: &[u8], pos: usize, depth: usize) -> Result<usize, BytecodeDecodeError> {
    ensure_expression_depth(pos, depth)?;
    let lhs = next_term(bytes, pos, depth)?;
    if peek(bytes, pos + lhs) == Some(EXPRESSION_BACKSLASH) {
        if pos + lhs + 2 > bytes.len() {
            return Err(BytecodeDecodeError::Truncated {
                observed_len: bytes.len(),
                position: pos + lhs,
                needed: pos + lhs + 2 - bytes.len(),
                message: "arithmetic: binary-op continuation truncated".to_string(),
            });
        }
        let rhs = next_arith(bytes, pos + lhs + 2, depth + 1)?;
        Ok(lhs + 2 + rhs)
    } else {
        Ok(lhs)
    }
}

/// Compute the byte length of a single RealLive **condition
/// expression** starting at `bytes[pos]` (per rlvm
/// `expression.cc::NextCondition`).
///
/// Form: `<arith> ( \<op:0x28..=0x2D> <arith> )?` — a left-hand
/// arithmetic expression optionally extended by a comparison
/// operator and a right-hand arithmetic expression.
fn next_condition(bytes: &[u8], pos: usize, depth: usize) -> Result<usize, BytecodeDecodeError> {
    ensure_expression_depth(pos, depth)?;
    let lhs = next_arith(bytes, pos, depth)?;
    if peek(bytes, pos + lhs) == Some(EXPRESSION_BACKSLASH) {
        let Some(op_byte) = peek(bytes, pos + lhs + 1) else {
            return Ok(lhs);
        };
        if (0x28..=0x2D).contains(&op_byte) {
            let rhs = next_arith(bytes, pos + lhs + 2, depth + 1)?;
            return Ok(lhs + 2 + rhs);
        }
    }
    Ok(lhs)
}

/// Compute the byte length of a single RealLive **boolean-and
/// expression** starting at `bytes[pos]` (per rlvm
/// `expression.cc::NextAnd`).
///
/// Form: `<cond> ( \< <and> )?` — left-hand condition optionally
/// extended by `\<` (`0x5C 0x3C`) and a recursive `and` right-hand
/// side.
fn next_and(bytes: &[u8], pos: usize, depth: usize) -> Result<usize, BytecodeDecodeError> {
    ensure_expression_depth(pos, depth)?;
    let lhs = next_condition(bytes, pos, depth)?;
    if peek(bytes, pos + lhs) == Some(EXPRESSION_BACKSLASH)
        && peek(bytes, pos + lhs + 1) == Some(b'<')
    {
        let rhs = next_and(bytes, pos + lhs + 2, depth + 1)?;
        Ok(lhs + 2 + rhs)
    } else {
        Ok(lhs)
    }
}

/// Compute the byte length of a single RealLive **expression**
/// (the top-level rule used for command-argument data and for the
/// source side of an assignment) starting at `bytes[pos]` (per rlvm
/// `expression.cc::NextExpression`).
///
/// Form: `<and> ( \= <expression> )?` — left-hand `and` optionally
/// extended by `\=` (`0x5C 0x3D`) for boolean-or.
fn next_expression(bytes: &[u8], pos: usize, depth: usize) -> Result<usize, BytecodeDecodeError> {
    ensure_expression_depth(pos, depth)?;
    let lhs = next_and(bytes, pos, depth)?;
    if peek(bytes, pos + lhs) == Some(EXPRESSION_BACKSLASH)
        && peek(bytes, pos + lhs + 1) == Some(b'=')
    {
        let rhs = next_expression(bytes, pos + lhs + 2, depth + 1)?;
        Ok(lhs + 2 + rhs)
    } else {
        Ok(lhs)
    }
}

/// Compute the byte length of a single RealLive **command argument**
/// (a "data" entry inside a `(...)` argument list) starting at
/// `bytes[pos]` (per rlvm `expression.cc::NextData`).
///
/// Form (left-to-right preference):
///
/// - `,` (`0x2C`) — comma separator (1 byte + recurse).
/// - `\n` (`0x0A`) — embedded MetaLine marker inside a parameter
///   (3 bytes + recurse). RealLive's compiler may emit line markers
///   in the middle of an argument list; the walker absorbs them.
/// - Shift-JIS lead bytes, printable ASCII letters / digits / spaces
///   quotes — string-shaped data (delegated to [`next_string`]).
/// - `a` or `(` — complex tag (`a<tag>(<data>...)`) — bracketed
///   compound entry with optional trailing `\<expression>`.
/// - Otherwise — fall through to [`next_expression`].
fn next_data(bytes: &[u8], pos: usize, depth: usize) -> Result<usize, BytecodeDecodeError> {
    ensure_expression_depth(pos, depth)?;
    // Leading `,` separators and embedded `\n` MetaLine markers are
    // absorbed *iteratively* (not via self-recursion) so an
    // attacker-controllable run of separator bytes — which is exactly
    // one byte (or three) per element — cannot drive one stack frame per
    // separator and overflow the process stack. A long separator run is
    // now O(1) stack and either walks through to the value or surfaces a
    // typed [`BytecodeDecodeError`].
    let value_pos = skip_data_separators(bytes, pos)?;
    let value_len = next_data_value(bytes, value_pos, depth)?;
    Ok((value_pos - pos) + value_len)
}

/// Skip a run of `,` separators and embedded `\n` MetaLine markers
/// starting at `bytes[pos]`, returning the index of the first byte that
/// is neither. Iterative (no recursion) so a long separator run stays
/// bounded-stack; a truncated MetaLine marker surfaces a typed
/// [`BytecodeDecodeError::Truncated`].
fn skip_data_separators(bytes: &[u8], pos: usize) -> Result<usize, BytecodeDecodeError> {
    let mut p = pos;
    loop {
        match peek(bytes, p) {
            Some(b',') => p += 1,
            Some(META_LINE_LEAD_BYTE) => {
                if p + 3 > bytes.len() {
                    return Err(BytecodeDecodeError::Truncated {
                        observed_len: bytes.len(),
                        position: p,
                        needed: p + 3 - bytes.len(),
                        message: "data: embedded MetaLine marker truncated (need 3 bytes)"
                            .to_string(),
                    });
                }
                p += 3;
            }
            _ => return Ok(p),
        }
    }
}

/// Length-walk a single command-argument **value** (string / complex
/// expression) starting at `bytes[pos]`. Unlike [`next_data`] this does
/// not absorb leading `,`/MetaLine separators — the caller strips those
/// via [`skip_data_separators`].
fn next_data_value(bytes: &[u8], pos: usize, depth: usize) -> Result<usize, BytecodeDecodeError> {
    ensure_expression_depth(pos, depth)?;
    let Some(b0) = peek(bytes, pos) else {
        return Err(BytecodeDecodeError::Truncated {
            observed_len: bytes.len(),
            position: pos,
            needed: 1,
            message: "data: input exhausted".to_string(),
        });
    };
    // Dispatch order mirrors `kaifuu-reallive` `parse_data` (the proven
    // reference decoder) so the two decoders compute identical widths:
    //  1. a disambiguated special parameter (`0x61 <tag> <item>`) wins
    //     over the bare-string reading of `0x61` (`'a'`);
    //  2. a `(` opens a complex parameter / grouped sub-expression;
    //  3. an arithmetic-expression token lead (`0xFF`/`0xC8`/`$`/`\`) is a
    //     full expression;
    //  4. every other lead byte is a string constant.
    if is_special_param_lead(bytes, pos) {
        return next_special_param(bytes, pos, depth + 1);
    }
    if b0 == b'(' {
        return next_complex_data(bytes, pos, depth + 1);
    }
    if is_expr_token_lead(b0) {
        return next_expression(bytes, pos, depth);
    }
    if is_data_string_lead(b0) {
        return next_string(bytes, pos, depth);
    }
    // Fall back to the expression grammar for any residual lead so a
    // genuine (non-string, non-token) data byte still surfaces a typed
    // error via the walker rather than silently stalling.
    next_expression(bytes, pos, depth)
}

/// Shape of a single decoded command-argument value, so the VM can pick
/// the right [`crate::rlop::ExprValue`] representation without
/// re-deriving the lead-byte classification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CommandArgShape {
    /// String-shaped data (Shift-JIS / ASCII / quoted). The VM maps this
    /// to `ExprValue::Bytes`.
    String,
    /// Bracketed complex tag (`(<data>...)`). The VM maps this to
    /// `ExprValue::Bytes` (raw tag bytes).
    Complex,
    /// Expression-shaped data. The VM parses + evaluates this to
    /// `ExprValue::Int`.
    Expression,
}

/// One decoded command-argument value: its shape plus the exact byte
/// span (owned so the VM can re-parse / decode it without holding the
/// element borrow).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CommandArg {
    /// Lead-byte classification used to pick the `ExprValue` variant.
    pub shape: CommandArgShape,
    /// The argument value's raw bytes (separators already stripped).
    pub bytes: Vec<u8>,
}

/// Classify a command-argument value by its lead byte, mirroring the
/// dispatch order in [`next_data_value`]: a disambiguated special
/// parameter (`0x61`) and a `(`-complex parameter are `Complex`, an
/// arithmetic-expression token lead is `Expression`, and every other lead
/// byte is a `String`.
fn command_arg_shape(bytes: &[u8], pos: usize) -> CommandArgShape {
    let lead = bytes.get(pos).copied().unwrap_or(0);
    if is_special_param_lead(bytes, pos) || lead == b'(' {
        CommandArgShape::Complex
    } else if is_expr_token_lead(lead) {
        CommandArgShape::Expression
    } else {
        CommandArgShape::String
    }
}

/// Decode the `(...)` argument list inside a `Command` element's
/// `raw_bytes` into one [`CommandArg`] per comma-separated value.
/// Returns an empty vec for a header-only command (no `(` arg list).
///
/// This is the value-extraction counterpart to [`walk_command_arg_list`]
/// (which only length-walks): the VM's integration dispatch path feeds
/// the decoded values to `RLOperation::dispatch` so argument-taking ops
/// — every control-flow op (goto / farcall / …) included — receive their
/// real targets instead of an empty slice.
pub(crate) fn decode_command_arg_values(
    raw_bytes: &[u8],
) -> Result<Vec<CommandArg>, BytecodeDecodeError> {
    if raw_bytes.len() <= COMMAND_HEADER_BYTE_LEN {
        return Ok(Vec::new());
    }
    let list_start = COMMAND_HEADER_BYTE_LEN;
    if peek(raw_bytes, list_start) != Some(b'(') {
        return Ok(Vec::new());
    }
    let mut args = Vec::new();
    let mut p = list_start + 1;
    loop {
        p = skip_data_separators(raw_bytes, p)?;
        match peek(raw_bytes, p) {
            None => {
                return Err(BytecodeDecodeError::Truncated {
                    observed_len: raw_bytes.len(),
                    position: p,
                    needed: 1,
                    message: "command argument list truncated before closing ')'".to_string(),
                });
            }
            Some(b')') => return Ok(args),
            Some(_) => {}
        }
        let value_len = next_data_value(raw_bytes, p, 0)?;
        if value_len == 0 {
            return Err(BytecodeDecodeError::MalformedElement {
                position: p,
                message: format!(
                    "command argument value walker returned 0 bytes for lead 0x{:02x}",
                    raw_bytes[p],
                ),
            });
        }
        let shape = command_arg_shape(raw_bytes, p);
        args.push(CommandArg {
            shape,
            bytes: raw_bytes[p..p + value_len].to_vec(),
        });
        p += value_len;
    }
}

/// `true` when `byte` is one of the lead bytes that introduces a
/// string-shaped argument (per rlvm `expression.cc::NextData` and
/// `NextString`): Shift-JIS lead bytes, ASCII letters / digits
/// space, `?`, `_`, and `"`.
fn is_data_string_lead(byte: u8) -> bool {
    matches!(
        byte,
        0x81..=0x9F
            | 0xE0..=0xEF
            | b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b' '
            | b'?'
            | b'_'
            | b'"'
    )
}

/// Walk a string-shaped command argument starting at `bytes[pos]`.
///
/// Mirrors rlvm `expression.cc::NextString`: tracks a `quoted` flag
/// absorbs Shift-JIS pairs atomically, recognises the literal
/// `###PRINT(<expr>)` escape (`9 + 1 + NextExpression(end)`), and
/// stops at the first non-string lead byte.
fn next_string(bytes: &[u8], pos: usize, depth: usize) -> Result<usize, BytecodeDecodeError> {
    ensure_expression_depth(pos, depth)?;
    let mut quoted = false;
    let mut end = pos;
    loop {
        if end >= bytes.len() {
            // End-of-input terminates the string-shaped argument.
            break;
        }
        if quoted {
            let unescaped = is_unescaped_quotation_mark(bytes, pos, end);
            quoted = !unescaped;
            if !quoted && end > 0 && bytes[end - 1] != b'\\' {
                end += 1; // consume the closing quote
                break;
            }
        } else {
            quoted = is_unescaped_quotation_mark(bytes, pos, end);
            if matches_print_marker(bytes, end) {
                end += 9; // "###PRINT("
                if end >= bytes.len() {
                    return Err(BytecodeDecodeError::Truncated {
                        observed_len: bytes.len(),
                        position: end,
                        needed: 1,
                        message: "string ###PRINT( expression truncated".to_string(),
                    });
                }
                let inner = next_expression(bytes, end, depth + 1)?;
                end += 1 + inner;
                continue;
            }
            let next_byte = bytes[end];
            let continues = matches!(
                next_byte,
                0x81..=0x9F
                    | 0xE0..=0xEF
                    | b'a'..=b'z'
                    | b'A'..=b'Z'
                    | b'0'..=b'9'
                    | b' '
                    | b'?'
                    | b'_'
                    | b'"'
                    | EXPRESSION_BACKSLASH
            );
            if !continues {
                break;
            }
        }
        let here = bytes[end];
        if (0x81..=0x9F).contains(&here) || (0xE0..=0xEF).contains(&here) {
            end += 2;
        } else {
            end += 1;
        }
    }
    Ok(end - pos)
}

/// `true` when `bytes[end]` is an unescaped `"` (taking the
/// preceding `bytes[end - 1]` into account when `end > pos`).
/// Centralised so [`next_string`] and the matching helpers share the
/// same definition.
fn is_unescaped_quotation_mark(bytes: &[u8], pos: usize, end: usize) -> bool {
    if end >= bytes.len() {
        return false;
    }
    if bytes[end] != b'"' {
        return false;
    }
    if end == pos {
        return true;
    }
    bytes[end - 1] != b'\\'
}

/// `true` when the bytes at `pos..pos + 9` spell out `###PRINT(`.
/// The walker mirrors rlvm `expression.cc::NextString`'s special
/// case for this escape sequence.
fn matches_print_marker(bytes: &[u8], pos: usize) -> bool {
    const MARKER: &[u8; 9] = b"###PRINT(";
    if pos + MARKER.len() > bytes.len() {
        return false;
    }
    &bytes[pos..pos + MARKER.len()] == MARKER
}

/// Walk a complex-tag argument (`a<...>(<data>...)` or
/// `(<data>...)`) starting at `bytes[pos]`. Mirrors the `a`/`(`
/// branch in rlvm `expression.cc::NextData`.
fn next_complex_data(bytes: &[u8], pos: usize, depth: usize) -> Result<usize, BytecodeDecodeError> {
    ensure_expression_depth(pos, depth)?;
    let mut end = pos;
    let Some(first) = peek(bytes, end) else {
        return Err(BytecodeDecodeError::Truncated {
            observed_len: bytes.len(),
            position: end,
            needed: 1,
            message: "complex data: input exhausted".to_string(),
        });
    };
    end += 1;
    if first == b'a' {
        // `a` tag: optional sub-tag prefix (one byte), then either
        // `(` for a nested data list or a single embedded data entry.
        if end >= bytes.len() {
            return Err(BytecodeDecodeError::Truncated {
                observed_len: bytes.len(),
                position: end,
                needed: 1,
                message: "complex data: 'a' tag missing sub-tag byte".to_string(),
            });
        }
        end += 1; // consume the sub-tag byte

        // Some scripts use `aa` as a double-tag prefix (rlvm comment
        // "Some special cases have multiple tags").
        if peek(bytes, end) == Some(b'a') {
            end += 2;
        }

        match peek(bytes, end) {
            Some(b'(') => {
                end += 1;
            }
            Some(_) => {
                let inner = next_data(bytes, end, depth)?;
                end += inner;
                return Ok(end - pos);
            }
            None => {
                return Err(BytecodeDecodeError::Truncated {
                    observed_len: bytes.len(),
                    position: end,
                    needed: 1,
                    message: "complex data: 'a' tag missing body".to_string(),
                });
            }
        }
    }
    // We are now positioned just past `(`. Walk data entries until
    // we hit `)`.
    loop {
        match peek(bytes, end) {
            Some(b')') => {
                end += 1;
                break;
            }
            None => {
                return Err(BytecodeDecodeError::Truncated {
                    observed_len: bytes.len(),
                    position: end,
                    needed: 1,
                    message: "complex data: '(...)' missing closing ')'".to_string(),
                });
            }
            Some(_) => {
                let inner = next_data(bytes, end, depth)?;
                if inner == 0 {
                    return Err(BytecodeDecodeError::MalformedElement {
                        position: end,
                        message: "complex data: inner next_data returned 0 bytes; the walker \
                                  must always make forward progress"
                            .to_string(),
                    });
                }
                end += inner;
            }
        }
    }
    // Optional trailing `\<expression>` continuation.
    if peek(bytes, end) == Some(EXPRESSION_BACKSLASH) {
        let inner = next_expression(bytes, end, depth)?;
        end += inner;
    }
    Ok(end - pos)
}

/// Decode a RealLive bytecode element stream.
///
/// Drives the lead-byte switch documented in
/// `docs/research/reallive-engine.md` §E end-to-end. Returns a
/// [`Vec<BytecodeElement>`] whose `byte_offset`/`byte_len` ranges
/// partition the input slice exactly.
///
/// # Empty input
///
/// An empty input slice is rejected with
/// [`BytecodeDecodeError::Truncated`]. Returning `Ok(vec![])` would
/// be a silent zero-state and is forbidden by the alpha-gate
/// contract.
///
/// # Partition invariant
///
/// The decoder verifies internally that
/// `sum(elements.iter().map(|e| e.byte_len())) == bytes.len()` and
/// that the offsets monotonically increase without gaps. A failure
/// returns [`BytecodeDecodeError::PartitionMismatch`].
pub fn decode_bytecode_stream(bytes: &[u8]) -> Result<Vec<BytecodeElement>, BytecodeDecodeError> {
    if bytes.is_empty() {
        return Err(BytecodeDecodeError::Truncated {
            observed_len: 0,
            position: 0,
            needed: 1,
            message: "bytecode stream is empty; the alpha-gate contract forbids returning \
                      Ok(vec![]) on empty input"
                .to_string(),
        });
    }

    let mut elements: Vec<BytecodeElement> = Vec::new();
    let mut pos: usize = 0;
    while pos < bytes.len() {
        let element = decode_one_element(bytes, pos)?;
        let element_offset = element.byte_offset();
        let element_len = element.byte_len();
        if element_offset != pos {
            return Err(BytecodeDecodeError::PartitionMismatch {
                input_len: bytes.len(),
                sum_of_element_lengths: pos,
                message: format!(
                    "element {} reports byte_offset={element_offset} but decoder was at {pos}",
                    elements.len(),
                ),
            });
        }
        if element_len == 0 {
            return Err(BytecodeDecodeError::MalformedElement {
                position: pos,
                message: format!(
                    "element {} ({}) reports byte_len=0; partition invariant requires \
                     forward progress on every iteration",
                    elements.len(),
                    element.variant_name(),
                ),
            });
        }
        pos =
            pos.checked_add(element_len)
                .ok_or_else(|| BytecodeDecodeError::MalformedElement {
                    position: pos,
                    message: "element byte_len addition overflowed usize".to_string(),
                })?;
        elements.push(element);
    }

    verify_partition(bytes.len(), &elements)?;
    Ok(elements)
}

/// Verify the per-element byte ranges partition `input_len` bytes
/// exactly. Returns [`BytecodeDecodeError::PartitionMismatch`] on any
/// gap, overlap, or sum mismatch.
fn verify_partition(
    input_len: usize,
    elements: &[BytecodeElement],
) -> Result<(), BytecodeDecodeError> {
    let mut expected = 0usize;
    let mut sum = 0usize;
    for (idx, element) in elements.iter().enumerate() {
        let offset = element.byte_offset();
        let len = element.byte_len();
        if offset != expected {
            return Err(BytecodeDecodeError::PartitionMismatch {
                input_len,
                sum_of_element_lengths: sum,
                message: format!(
                    "element {idx} ({}) expects byte_offset={expected} but reports \
                     byte_offset={offset}",
                    element.variant_name(),
                ),
            });
        }
        sum = sum
            .checked_add(len)
            .ok_or_else(|| BytecodeDecodeError::PartitionMismatch {
                input_len,
                sum_of_element_lengths: sum,
                message: format!(
                    "element {idx} byte_len addition overflowed usize during partition check",
                ),
            })?;
        expected =
            expected
                .checked_add(len)
                .ok_or_else(|| BytecodeDecodeError::PartitionMismatch {
                    input_len,
                    sum_of_element_lengths: sum,
                    message: format!(
                        "element {idx} offset progression overflowed usize during partition check",
                    ),
                })?;
    }
    if sum != input_len {
        return Err(BytecodeDecodeError::PartitionMismatch {
            input_len,
            sum_of_element_lengths: sum,
            message: format!(
                "sum of element byte_len values ({sum}) does not match input length ({input_len})",
            ),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_data_long_comma_run_surfaces_typed_error_not_stack_overflow() {
        // Regression (audit-3): `next_data` used to recurse once per `,`
        // separator (`1 + next_data(pos + 1)`), so a long run of commas
        // over attacker-controllable decompressed bytecode drove one
        // stack frame per comma and overflowed the process stack. The
        // iterative separator-skip must instead consume the whole run in
        // O(1) stack and surface a typed `Truncated` error when the input
        // exhausts mid-separator-run.
        let bytes = vec![b','; 500_000];
        match next_data(&bytes, 0, 0) {
            Err(BytecodeDecodeError::Truncated { .. }) => {}
            other => panic!("expected Truncated on an all-comma buffer, got {other:?}"),
        }
    }

    #[test]
    fn next_data_long_metaline_run_surfaces_typed_error_not_stack_overflow() {
        // Companion to the comma case: embedded `\n` MetaLine markers
        // (3 bytes each) also used to recurse per marker. A long run of
        // complete markers followed by exhaustion must surface a typed
        // error rather than overflow.
        let mut bytes = Vec::new();
        for _ in 0..200_000 {
            bytes.extend_from_slice(&[META_LINE_LEAD_BYTE, 0x00, 0x00]);
        }
        match next_data(&bytes, 0, 0) {
            Err(BytecodeDecodeError::Truncated { .. }) => {}
            other => panic!("expected Truncated on an all-metaline buffer, got {other:?}"),
        }
    }

    #[test]
    fn deeply_nested_memory_refs_return_malformed_instead_of_overflowing() {
        // Each `$bank[ ... ]` recursively re-enters the expression length
        // walker. Decode at the public stream boundary so the regression
        // proves hostile bytecode produces a typed error, never a stack abort.
        let depth = MAX_EXPRESSION_DEPTH + 50;
        let mut bytes = Vec::with_capacity(depth * 4 + 6);
        for _ in 0..depth {
            bytes.extend_from_slice(&[b'$', 0x01, b'[']);
        }
        bytes.extend_from_slice(&[b'$', 0xFF, 0, 0, 0, 0]);
        bytes.extend(std::iter::repeat_n(b']', depth));

        let err = decode_bytecode_stream(&bytes)
            .expect_err("over-deep expression bytecode must be rejected");
        assert!(matches!(err, BytecodeDecodeError::MalformedElement { .. }));
    }

    #[test]
    fn decode_command_arg_values_splits_comma_separated_int_args() {
        // `goto`-shaped header (module 0/1, opcode 0) with a 2-int arg
        // list: `( $FF<7>, $FF<9> )`. The value extractor must return
        // two Expression-shaped args carrying the literal bytes.
        let mut raw = vec![0x23, 0x00, 0x01, 0x00, 0x00, 0x02, 0x00, 0x00, b'('];
        raw.extend_from_slice(&[0x24, 0xFF]);
        raw.extend_from_slice(&7_i32.to_le_bytes());
        raw.push(b',');
        raw.extend_from_slice(&[0x24, 0xFF]);
        raw.extend_from_slice(&9_i32.to_le_bytes());
        raw.push(b')');

        let args = decode_command_arg_values(&raw).expect("arg list decodes");
        assert_eq!(args.len(), 2);
        assert!(args.iter().all(|a| a.shape == CommandArgShape::Expression));
    }

    #[test]
    fn decode_command_arg_values_empty_for_header_only_command() {
        let raw = vec![0x23, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00];
        assert!(decode_command_arg_values(&raw).expect("decodes").is_empty());
    }

    #[test]
    fn special_parameter_is_not_misread_as_a_string() {
        // Ordinary function command (module_id 3 msg, opcode 100 — NOT a
        // goto-family opcode) + `( $FF<0> 0x61 <tag=1> ( $FF<9> ) )`: the
        // `0x61` special-parameter introducer must be consumed as a special
        // parameter (tag + contained `($FF<9>)` group), NOT as a bare `'a'`
        // string — the bug that failed 65 Sweetie / 63 Kanon scenes.
        let mut raw = vec![0x23, 0x00, 0x03, 0x64, 0x00, 0x01, 0x00, 0x00, b'('];
        raw.extend_from_slice(&[0x24, 0xFF]);
        raw.extend_from_slice(&0_i32.to_le_bytes());
        // special parameter: 0x61 <tag=1> ( $FF<9> )
        raw.push(0x61);
        raw.push(0x01);
        raw.push(b'(');
        raw.extend_from_slice(&[0x24, 0xFF]);
        raw.extend_from_slice(&9_i32.to_le_bytes());
        raw.push(b')');
        raw.push(b')');
        // The whole element must length-walk cleanly (no stall on the
        // special-parameter tag byte) and consume every byte.
        let elements = decode_bytecode_stream(&raw).expect("special-param arg list must decode");
        let total: usize = elements.iter().map(BytecodeElement::byte_len).sum();
        assert_eq!(total, raw.len(), "element partition must cover every byte");
        assert!(matches!(elements[0], BytecodeElement::Command { .. }));
    }

    #[test]
    fn goto_case_captures_per_case_match_expressions_and_targets() {
        // `goto_case` (module_jmp opcode 4), argc=2:
        //   header + (disc=$FF<5>) + { ($FF<5>) @100 () @200 }
        // The decoder must record BOTH case match expressions (the second is
        // the empty default `()`) alongside their two jump targets.
        let mut raw = vec![0x23, 0x00, 0x01, 0x04, 0x00, 0x02, 0x00, 0x00];
        // discriminant (disc)
        raw.push(b'(');
        raw.extend_from_slice(&[0x24, 0xFF]);
        raw.extend_from_slice(&5_i32.to_le_bytes());
        raw.push(b')');
        // { block
        raw.push(0x7B);
        // case 0: ($FF<5>) then target 100
        raw.push(b'(');
        raw.extend_from_slice(&[0x24, 0xFF]);
        raw.extend_from_slice(&5_i32.to_le_bytes());
        raw.push(b')');
        raw.extend_from_slice(&100_u32.to_le_bytes());
        // case 1 (default): () then target 200
        raw.push(b'(');
        raw.push(b')');
        raw.extend_from_slice(&200_u32.to_le_bytes());
        // } block close
        raw.push(0x7D);

        let element = decode_one_element(&raw, 0).expect("goto_case decodes");
        match element {
            BytecodeElement::Command {
                goto_targets,
                goto_case_exprs,
                byte_len,
                ..
            } => {
                assert_eq!(byte_len, raw.len(), "goto_case must consume every byte");
                assert_eq!(goto_targets, vec![100, 200]);
                assert_eq!(goto_case_exprs.len(), 2);
                // Case 0's match expression is the `$FF<5>` literal bytes.
                let mut expected = vec![0x24u8, 0xFF];
                expected.extend_from_slice(&5_i32.to_le_bytes());
                assert_eq!(goto_case_exprs[0], expected);
                // Case 1 is the default `()` — an empty match expression.
                assert!(goto_case_exprs[1].is_empty());
            }
            other => panic!("expected Command, got {other:?}"),
        }
    }

    #[test]
    fn empty_input_is_truncated_not_zero_state() {
        match decode_bytecode_stream(&[]) {
            Err(BytecodeDecodeError::Truncated { observed_len, .. }) => {
                assert_eq!(observed_len, 0);
            }
            other => panic!("expected Truncated on empty input, got: {other:?}"),
        }
    }

    #[test]
    fn comma_lead_zero_decodes_as_single_byte_comma() {
        let bytes = [0x00u8];
        let elements = decode_bytecode_stream(&bytes).expect("comma lead 0x00 must decode");
        assert_eq!(elements.len(), 1);
        match &elements[0] {
            BytecodeElement::Comma {
                lead_byte,
                byte_offset,
                byte_len,
            } => {
                assert_eq!(*lead_byte, 0x00);
                assert_eq!(*byte_offset, 0);
                assert_eq!(*byte_len, 1);
            }
            other => panic!("expected Comma, got {other:?}"),
        }
    }

    #[test]
    fn comma_lead_2c_decodes_as_single_byte_comma() {
        let bytes = [0x2cu8];
        let elements = decode_bytecode_stream(&bytes).expect("comma lead 0x2C must decode");
        match &elements[0] {
            BytecodeElement::Comma { lead_byte, .. } => assert_eq!(*lead_byte, 0x2c),
            other => panic!("expected Comma, got {other:?}"),
        }
    }

    #[test]
    fn meta_line_decodes_with_u16_le_payload() {
        let bytes = [0x0a, 0x02, 0x00];
        let elements = decode_bytecode_stream(&bytes).expect("meta_line must decode");
        assert_eq!(elements.len(), 1);
        match &elements[0] {
            BytecodeElement::MetaLine {
                line_number,
                byte_len,
                byte_offset,
            } => {
                assert_eq!(*line_number, 2);
                assert_eq!(*byte_len, 3);
                assert_eq!(*byte_offset, 0);
            }
            other => panic!("expected MetaLine, got {other:?}"),
        }
    }

    #[test]
    fn meta_entrypoint_decodes_with_u16_le_payload() {
        let bytes = [0x21, 0x07, 0x00];
        let elements = decode_bytecode_stream(&bytes).expect("meta_entrypoint must decode");
        match &elements[0] {
            BytecodeElement::MetaEntrypoint {
                entrypoint_index, ..
            } => assert_eq!(*entrypoint_index, 7),
            other => panic!("expected MetaEntrypoint, got {other:?}"),
        }
    }

    #[test]
    fn meta_kidoku_decodes_with_u16_le_payload() {
        let bytes = [0x40, 0xff, 0x01];
        let elements = decode_bytecode_stream(&bytes).expect("meta_kidoku must decode");
        match &elements[0] {
            BytecodeElement::MetaKidoku { kidoku_id, .. } => assert_eq!(*kidoku_id, 0x01ff),
            other => panic!("expected MetaKidoku, got {other:?}"),
        }
    }

    #[test]
    fn command_with_zero_args_consumes_exactly_eight_bytes() {
        // 0x23, module_type=1, module_id=5, opcode=120 (0x78 LE), argc=0, ovl=0, reserved=0
        let bytes = [0x23, 0x01, 0x05, 0x78, 0x00, 0x00, 0x00, 0x00];
        let elements = decode_bytecode_stream(&bytes).expect("zero-arg command must decode");
        assert_eq!(elements.len(), 1);
        match &elements[0] {
            BytecodeElement::Command {
                module_type,
                module_id,
                opcode,
                arg_count,
                overload,
                raw_bytes,
                byte_len,
                ..
            } => {
                assert_eq!(*module_type, 1);
                assert_eq!(*module_id, 5);
                assert_eq!(*opcode, 120);
                assert_eq!(*arg_count, 0);
                assert_eq!(*overload, 0);
                assert_eq!(*byte_len, 8);
                assert_eq!(raw_bytes, &bytes);
            }
            other => panic!("expected Command, got {other:?}"),
        }
    }

    #[test]
    fn command_with_one_int_literal_arg_walks_paren_list() {
        // Header: 0x23 01 05 78 00 01 00 00 (argc=1)
        // Arg list: '(' '$' 0xFF 05 00 00 00 ')'
        // The `$` prefix is required: NextToken expects a `$` lead
        // before the int-constant marker 0xFF.
        let bytes = [
            0x23, 0x01, 0x05, 0x78, 0x00, 0x01, 0x00, 0x00, b'(', b'$', 0xFF, 0x05, 0x00, 0x00,
            0x00, b')',
        ];
        let elements = decode_bytecode_stream(&bytes).expect("one-arg command must decode");
        assert_eq!(elements.len(), 1);
        match &elements[0] {
            BytecodeElement::Command {
                arg_count,
                byte_len,
                raw_bytes,
                ..
            } => {
                assert_eq!(*arg_count, 1);
                assert_eq!(*byte_len, bytes.len());
                assert_eq!(raw_bytes.as_slice(), &bytes[..]);
            }
            other => panic!("expected Command, got {other:?}"),
        }
    }

    #[test]
    fn standalone_expression_decodes_with_full_raw_bytes() {
        // ExpressionElement is shaped like an assignment:
        // <dest_term> \<assign_op> <source_expression>.
        //
        // Synthetic: dest = $B[$0] (memory ref into bank 0x42 with
        // index = int-literal 0). source = $0 (int-literal 0).
        // assign_op = 0x14 (`+=`).
        //
        // Bytes:
        //   0x24 0x42 0x5b 0x24 0xff 0x00 0x00 0x00 0x00 0x5d -- $B[$0]
        //   0x5c 0x14 -- `\` `+=`
        //   0x24 0xff 0x00 0x00 0x00 0x00 -- $0
        let bytes = [
            0x24, 0x42, 0x5b, 0x24, 0xff, 0x00, 0x00, 0x00, 0x00, 0x5d, 0x5c, 0x14, 0x24, 0xff,
            0x00, 0x00, 0x00, 0x00,
        ];
        let elements = decode_bytecode_stream(&bytes).expect("expression must decode");
        assert_eq!(elements.len(), 1);
        match &elements[0] {
            BytecodeElement::Expression {
                raw_bytes,
                byte_len,
                ..
            } => {
                assert_eq!(*byte_len, bytes.len());
                assert_eq!(raw_bytes.as_slice(), &bytes[..]);
            }
            other => panic!("expected Expression, got {other:?}"),
        }
    }

    #[test]
    fn selection_option_marker_is_recognised_distinct_from_textout() {
        for marker in SELECTION_OPTION_MARKER_MIN..=SELECTION_OPTION_MARKER_MAX {
            let bytes = [marker];
            let elements =
                decode_bytecode_stream(&bytes).expect("selection-option marker must decode");
            assert_eq!(elements.len(), 1);
            match &elements[0] {
                BytecodeElement::SelectionOption {
                    marker: observed,
                    raw_bytes,
                    byte_len,
                    ..
                } => {
                    assert_eq!(*observed, marker);
                    assert_eq!(*byte_len, 1);
                    assert_eq!(raw_bytes.as_slice(), &[marker]);
                }
                other => panic!("expected SelectionOption for 0x{marker:02x}, got {other:?}"),
            }
        }
    }

    #[test]
    fn shift_jis_textout_consumes_lead_trail_pair_atomically() {
        // Shift-JIS pair: 0x82 0xA0 (`あ`). The trail byte 0xA0 is not
        // a structural opener; the run continues to absorb until
        // structural lead. Append 0x0A (MetaLine) to terminate.
        let bytes = [0x82, 0xA0, 0x0a, 0x02, 0x00];
        let elements = decode_bytecode_stream(&bytes).expect("textout + meta must decode");
        assert_eq!(elements.len(), 2);
        match &elements[0] {
            BytecodeElement::Textout {
                encoding_hint,
                raw_bytes,
                byte_len,
                ..
            } => {
                assert_eq!(*encoding_hint, TextoutEncoding::ShiftJis);
                assert_eq!(*byte_len, 2);
                assert_eq!(raw_bytes.as_slice(), &[0x82, 0xA0]);
            }
            other => panic!("expected Textout, got {other:?}"),
        }
        match &elements[1] {
            BytecodeElement::MetaLine { line_number, .. } => assert_eq!(*line_number, 2),
            other => panic!("expected MetaLine, got {other:?}"),
        }
    }

    #[test]
    fn shift_jis_lead_followed_by_kidoku_byte_does_not_split_pair() {
        // 0x82 (SJIS lead) followed by 0x40 (would-be MetaKidoku).
        // The pair must be consumed atomically, NOT split as
        // `Textout(0x82) + MetaKidoku(0x40...)`.
        let bytes = [0x82, 0x40, 0x0a, 0x05, 0x00];
        let elements = decode_bytecode_stream(&bytes).expect("must decode");
        assert_eq!(elements.len(), 2);
        match &elements[0] {
            BytecodeElement::Textout {
                raw_bytes,
                encoding_hint,
                ..
            } => {
                assert_eq!(raw_bytes.as_slice(), &[0x82, 0x40]);
                assert_eq!(*encoding_hint, TextoutEncoding::ShiftJis);
            }
            other => panic!("expected Textout, got {other:?}"),
        }
        match &elements[1] {
            BytecodeElement::MetaLine { line_number, .. } => assert_eq!(*line_number, 5),
            other => panic!("expected MetaLine, got {other:?}"),
        }
    }

    #[test]
    fn other_textout_encoding_is_emitted_for_non_sjis_lead() {
        // 0x7E ('~') is not in the SJIS-lead range and not a
        // structural opener.
        let bytes = [0x7e, 0x7e, 0x0a, 0x02, 0x00];
        let elements = decode_bytecode_stream(&bytes).expect("must decode");
        assert_eq!(elements.len(), 2);
        match &elements[0] {
            BytecodeElement::Textout { encoding_hint, .. } => {
                assert_eq!(*encoding_hint, TextoutEncoding::Other);
            }
            other => panic!("expected Textout, got {other:?}"),
        }
    }

    #[test]
    fn truncated_meta_line_returns_truncated_error() {
        let bytes = [0x0a, 0x02]; // missing high byte
        match decode_bytecode_stream(&bytes) {
            Err(BytecodeDecodeError::Truncated { .. }) => {}
            other => panic!("expected Truncated, got {other:?}"),
        }
    }

    #[test]
    fn truncated_command_header_returns_truncated_error() {
        let bytes = [0x23, 0x01, 0x05, 0x78]; // header cut at byte 4
        match decode_bytecode_stream(&bytes) {
            Err(BytecodeDecodeError::Truncated { .. }) => {}
            other => panic!("expected Truncated, got {other:?}"),
        }
    }

    #[test]
    fn truncated_expression_body_returns_truncated_error() {
        // ExpressionElement is `<term> \<assign_op> <expression>`.
        // Here the dest term ($ ff <i32>) is itself truncated.
        let bytes = [0x24, 0xff, 0x01]; // $ ff <i32> needs 4 trailing literal bytes
        match decode_bytecode_stream(&bytes) {
            Err(BytecodeDecodeError::Truncated { .. }) => {}
            other => panic!("expected Truncated, got {other:?}"),
        }
    }

    #[test]
    fn partition_mismatch_is_detected_on_forged_offsets() {
        // The decoder's own output always partitions correctly. We
        // exercise the partition checker directly with a hand-rolled
        // element whose `byte_offset` is wrong relative to the
        // accumulated total.
        let forged = vec![
            BytecodeElement::Comma {
                lead_byte: 0x00,
                byte_offset: 0,
                byte_len: 1,
            },
            BytecodeElement::Comma {
                lead_byte: 0x00,
                byte_offset: 5, // SHOULD be 1 — forged gap.
                byte_len: 1,
            },
        ];
        match verify_partition(6, &forged) {
            Err(BytecodeDecodeError::PartitionMismatch { .. }) => {}
            other => panic!("expected PartitionMismatch, got {other:?}"),
        }
    }

    #[test]
    fn partition_mismatch_is_detected_when_sum_differs_from_input() {
        let forged = vec![BytecodeElement::Comma {
            lead_byte: 0x00,
            byte_offset: 0,
            byte_len: 1,
        }];
        // Claim input was 4 bytes but elements only cover 1.
        match verify_partition(4, &forged) {
            Err(BytecodeDecodeError::PartitionMismatch {
                input_len,
                sum_of_element_lengths,
                ..
            }) => {
                assert_eq!(input_len, 4);
                assert_eq!(sum_of_element_lengths, 1);
            }
            other => panic!("expected PartitionMismatch, got {other:?}"),
        }
    }

    #[test]
    fn decode_round_trip_partitions_concatenated_synthetic_stream() {
        // Synthesise one element of each documented variant and
        // confirm they decode in order with no gaps and no overlaps.
        let mut bytes: Vec<u8> = Vec::new();
        // MetaLine(2)
        bytes.extend_from_slice(&[0x0a, 0x02, 0x00]);
        // MetaEntrypoint(0)
        bytes.extend_from_slice(&[0x21, 0x00, 0x00]);
        // MetaKidoku(7)
        bytes.extend_from_slice(&[0x40, 0x07, 0x00]);
        // Comma (0x00)
        bytes.push(0x00);
        // Comma (0x2C)
        bytes.push(0x2c);
        // Command argc=0 (no `(...)` body)
        bytes.extend_from_slice(&[0x23, 0x01, 0x05, 0x78, 0x00, 0x00, 0x00, 0x00]);
        // ExpressionElement: $B[$0] \+= $0
        //
        //   0x24 0x42 0x5b 0x24 0xff 00 00 00 00 0x5d -- dest $B[$0]
        //   0x5c 0x14 -- `\` `+=`
        //   0x24 0xff 00 00 00 00 -- source $0
        bytes.extend_from_slice(&[
            0x24, 0x42, 0x5b, 0x24, 0xff, 0x00, 0x00, 0x00, 0x00, 0x5d, 0x5c, 0x14, 0x24, 0xff,
            0x00, 0x00, 0x00, 0x00,
        ]);
        // SelectionOption 0x30
        bytes.push(0x30);
        // Textout (SJIS) 0x82 0xA0
        bytes.extend_from_slice(&[0x82, 0xA0]);
        // Trailing comma so textout absorber stops cleanly
        bytes.push(0x00);

        let elements = decode_bytecode_stream(&bytes).expect("synthetic stream must decode");
        assert_eq!(elements.len(), 10);
        assert!(matches!(elements[0], BytecodeElement::MetaLine { .. }));
        assert!(matches!(
            elements[1],
            BytecodeElement::MetaEntrypoint { .. }
        ));
        assert!(matches!(elements[2], BytecodeElement::MetaKidoku { .. }));
        assert!(matches!(elements[3], BytecodeElement::Comma { .. }));
        assert!(matches!(elements[4], BytecodeElement::Comma { .. }));
        assert!(matches!(elements[5], BytecodeElement::Command { .. }));
        assert!(matches!(elements[6], BytecodeElement::Expression { .. }));
        assert!(matches!(
            elements[7],
            BytecodeElement::SelectionOption { .. }
        ));
        assert!(matches!(elements[8], BytecodeElement::Textout { .. }));
        assert!(matches!(elements[9], BytecodeElement::Comma { .. }));

        // Partition: sum of byte_len == bytes.len().
        let sum: usize = elements.iter().map(BytecodeElement::byte_len).sum();
        assert_eq!(sum, bytes.len(), "partition invariant must hold");
    }
}
