use serde::{Deserialize, Serialize};
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
