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
/// below are the subset needed for the observed scene 1 alpha; richer
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
    /// `module_sys.cc` second registration id observed on one corpus /
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

/// Maximum recursive ExpressionPiece nesting accepted by the bytecode
/// decoder. This matches `utsushi-reallive`'s semantic expression parser:
/// real scenes stay far below this bound, while hostile nested groups,
/// memory references, or unary forms must return a typed error before they
/// can overflow the native stack.
const MAX_EXPRESSION_DEPTH: usize = 256;

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
/// data item — across the observed and Kanon archives that item is always
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
fn parse_data(bytes: &[u8], pos: usize, depth: usize) -> Result<(Expr, usize), RealLiveParseError> {
    ensure_expression_depth(bytes, pos, depth)?;
    match bytes.get(pos) {
        None => Err(RealLiveParseError::TruncatedExpression { offset: pos as u64 }),
        Some(&EXPR_SPECIAL) if is_special_param_lead(bytes, pos) => {
            parse_special_param(bytes, pos, depth + 1)
        }
        Some(&EXPR_PAREN_OPEN) => parse_complex(bytes, pos, depth + 1),
        Some(&b) if is_expr_token_lead(b) => parse_expression_at_depth(bytes, pos, depth),
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
fn parse_complex(
    bytes: &[u8],
    pos: usize,
    depth: usize,
) -> Result<(Expr, usize), RealLiveParseError> {
    ensure_expression_depth(bytes, pos, depth)?;
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
                let (item, len) = parse_data(bytes, cursor, depth)?;
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
fn parse_special_param(
    bytes: &[u8],
    pos: usize,
    depth: usize,
) -> Result<(Expr, usize), RealLiveParseError> {
    ensure_expression_depth(bytes, pos, depth)?;
    let (tag, tag_len) = match bytes.get(pos + 1) {
        Some(&EXPR_INT_LITERAL) => (read_i32_le(bytes, pos + 2)?, 5),
        Some(&t) => (i32::from(t), 1),
        None => return Err(RealLiveParseError::TruncatedExpression { offset: pos as u64 }),
    };
    let (content, content_len) = parse_data(bytes, pos + 1 + tag_len, depth)?;
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
fn parse_token(
    bytes: &[u8],
    pos: usize,
    depth: usize,
) -> Result<(Expr, usize), RealLiveParseError> {
    ensure_expression_depth(bytes, pos, depth)?;
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
                let (index, index_len) = parse_expression_at_depth(bytes, pos + 3, depth + 1)?;
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


