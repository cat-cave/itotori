use std::fmt;

use kaifuu_core::RedactedContentSummary;
use serde::{Deserialize, Serialize};

use super::{RealLiveParseError, is_shift_jis_textout_lead, opener};

/// ExpressionPiece operator-introducer byte (`\`, `0x5C`).
/// Per `docs/research/reallive-engine.md` §G and rlvm
/// `libreallive/expression.cc`, every unary and binary operator in a
/// compiled RealLive expression is introduced by `0x5C` followed by a
/// single op-code byte (arithmetic `0x00..=0x09`, compound-assignment
/// `0x14..=0x26`, comparison `0x28..=0x2D`, logical `0x3C`/`0x3D`).
pub(super) const EXPR_OP_PREFIX: u8 = 0x5C;
/// ExpressionPiece integer-literal introducer (`0xFF`); followed by 4
/// bytes of `i32` little-endian. Integer literals also appear in the
/// `$`-prefixed form (`0x24 0xFF` + 4 bytes) emitted by the compiler.
pub(super) const EXPR_INT_LITERAL: u8 = 0xFF;
/// ExpressionPiece store-register reference (`0xC8`).
pub(super) const EXPR_STORE_REGISTER: u8 = 0xC8;
/// Memory-reference index open / close brackets (`[` `]`).
pub(super) const EXPR_INDEX_OPEN: u8 = 0x5B;
pub(super) const EXPR_INDEX_CLOSE: u8 = 0x5D;
/// Sub-expression grouping parentheses (`(` `)`).
pub(super) const EXPR_PAREN_OPEN: u8 = 0x28;
pub(super) const EXPR_PAREN_CLOSE: u8 = 0x29;
/// Memory-/`$`-reference prefix (`$`, `0x24`). Shares its value with the
/// [`opener::EXPRESSION`] element opener — at the start of an Expression
/// element the `0x24` opener doubles as the `$` of the first token.
pub(super) const EXPR_DOLLAR: u8 = 0x24;
/// Special-parameter introducer (`a`, `0x61`) — rlvm
/// `libreallive/expression.cc` `SpecialExpressionPiece`. A special
/// parameter is `0x61 <tag> <data-item>`, where `<tag>` is a single byte
/// (or `0xFF`+`i32` when wide) and `<data-item>` is the contained value
/// (in practice a complex `(…)` group). Used by the variadic
/// object/graphics multi-commands (`objBgMulti`, selection-button tables)
/// to attach a discriminant tag to each grouped parameter set.
pub(super) const EXPR_SPECIAL: u8 = 0x61;

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
pub(super) fn is_special_param_lead(bytes: &[u8], pos: usize) -> bool {
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
pub(super) fn parse_data(bytes: &[u8], pos: usize) -> Result<(Expr, usize), RealLiveParseError> {
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
pub(super) fn parse_token(bytes: &[u8], pos: usize) -> Result<(Expr, usize), RealLiveParseError> {
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
