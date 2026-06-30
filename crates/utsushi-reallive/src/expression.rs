//! UTSUSHI-205 — RealLive expression byte-stream parser.
//!
//! Consumes the `raw_bytes` payload of a
//! [`crate::BytecodeElement::Expression`] (UTSUSHI-204) and produces a
//! typed [`ExprNode`] AST. The byte stream is the documented RealLive
//! expression encoding (`docs/research/reallive-engine.md` §G,
//! re-derived from publicly archived RLDEV documentation and
//! `rlvm/src/libreallive/expression.cc` as a research anchor only):
//!
//! - `$ 0xFF <i32:LE>` — 6-byte int-literal token.
//! - `$ 0xC8` — store-register reference.
//! - `$ <bank_byte> [ <index_expr> ]` — memory reference.
//! - `(` <expr> `)` — grouping.
//! - `\ <op_byte> <rhs>` — binary or compound-assignment operator
//!   continuation. The op byte values are pinned in [`ExprOp`] and
//!   [`AssignOp`].
//! - `\ 0x00 <term>` / `\ 0x01 <term>` — unary forms (no-op /
//!   unary-minus).
//!
//! A standalone [`crate::BytecodeElement::Expression`] is shaped as an
//! assignment per the bytecode walker:
//! `<dest_term> \ <assign_op> <source_expression>`. The top-level
//! [`parse_expression`] entry point recognises this shape and produces
//! an [`ExprNode::Assignment`].
//!
//! # Operator byte table
//!
//! Pinned from the UTSUSHI-205 spec node:
//!
//! | Byte (after `\`) | Operator     | Variant            |
//! | ---------------- | ------------ | ------------------ |
//! | `0x02`           | `+`          | [`ExprOp::Add`]    |
//! | `0x03`           | `-`          | [`ExprOp::Sub`]    |
//! | `0x04`           | `*`          | [`ExprOp::Mul`]    |
//! | `0x05`           | `/`          | [`ExprOp::Div`]    |
//! | `0x06`           | `%`          | [`ExprOp::Mod`]    |
//! | `0x07`           | `&`          | [`ExprOp::And`]    |
//! | `0x08`           | `\|`         | [`ExprOp::Or`]     |
//! | `0x09`           | `^`          | [`ExprOp::Xor`]    |
//! | `0x28`           | `==`         | [`ExprOp::Equ`]    |
//! | `0x29`           | `!=`         | [`ExprOp::Neq`]    |
//! | `0x2A`           | `<`          | [`ExprOp::Lt`]     |
//! | `0x2B`           | `<=`         | [`ExprOp::Le`]     |
//! | `0x2C`           | `>`          | [`ExprOp::Gt`]     |
//! | `0x2D`           | `>=`         | [`ExprOp::Ge`]     |
//! | `0x3C`           | `&&`         | [`ExprOp::LogicAnd`] |
//! | `0x3D`           | `\|\|`       | [`ExprOp::LogicOr`]  |
//!
//! Assignment ops live in `0x14..=0x24` per the bytecode walker, with
//! the documented sub-range expanded below:
//!
//! | Byte (after `\`) | Operator | Variant                  |
//! | ---------------- | -------- | ------------------------ |
//! | `0x14`           | `=`      | [`AssignOp::Plain`]      |
//! | `0x15`           | `+=`     | [`AssignOp::AddAssign`]  |
//! | `0x16`           | `-=`     | [`AssignOp::SubAssign`]  |
//! | `0x17`           | `*=`     | [`AssignOp::MulAssign`]  |
//! | `0x18`           | `/=`     | [`AssignOp::DivAssign`]  |
//! | `0x19`           | `%=`     | [`AssignOp::ModAssign`]  |
//! | `0x1A`           | `&=`     | [`AssignOp::AndAssign`]  |
//! | `0x1B`           | `\|=`    | [`AssignOp::OrAssign`]   |
//! | `0x1C`           | `^=`     | [`AssignOp::XorAssign`]  |
//! | `0x1D`           | `<<=`    | [`AssignOp::ShlAssign`]  |
//! | `0x1E`           | `>>=`    | [`AssignOp::ShrAssign`]  |
//!
//! The `0x1F..=0x24` slots are accepted by the bytecode walker but
//! their semantics are not documented in RLDEV; the parser surfaces
//! them as an [`ExpressionWarning::UnknownOperator`] under the
//! partial-result rule.
//!
//! # Partial-result recovery
//!
//! Per the spec node's third acceptance criterion: an unknown operator
//! byte in the continuation slot does not abort the parse. The parser
//! emits an [`ExpressionWarning::UnknownOperator`] in the returned
//! warning vector (see [`ParsedExpression`]) and treats the byte as a
//! single-byte literal so the partial AST built so far is still
//! returned to the caller.
//!
//! # Empty input
//!
//! An empty byte slice is **not** parsed as a zero-node expression. The
//! function returns [`ExpressionParseError::Truncated`] — the alpha-gate
//! "no silent zero-state" contract forbids returning a default node on
//! empty input.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Lead byte of a memory-reference / int-literal token (`$`).
pub const EXPRESSION_TOKEN_LEAD: u8 = 0x24;
/// Backslash byte introducing a unary form or binary-op continuation.
pub const EXPRESSION_BACKSLASH: u8 = 0x5C;
/// Token byte selecting an int-literal payload (`$\xFF <i32:LE>`).
pub const EXPRESSION_INT_LITERAL_TAG: u8 = 0xFF;
/// Token byte selecting the store-register reference (`$\xC8`).
pub const EXPRESSION_STORE_REGISTER_TAG: u8 = 0xC8;
/// Bank byte for the `intB` bank (per `docs/research/reallive-engine.md`
/// §G — bank letter encoded as a single byte; zero-indexed against
/// `intA`). Pinned as a constant so the synthetic-suite fixtures and
/// the spec-node acceptance criteria can share one symbol.
pub const BANK_BYTE_INT_B: u8 = 0x01;
/// Bank byte for the `intA` bank.
pub const BANK_BYTE_INT_A: u8 = 0x00;
/// Bank byte for the `intF` bank (observed in Sweetie HD scene #0001
/// real-bytes Expression elements).
pub const BANK_BYTE_INT_F: u8 = 0x05;
/// Bank byte for the `intG` bank (observed in Sweetie HD scene #0001
/// real-bytes Expression elements).
pub const BANK_BYTE_INT_G: u8 = 0x06;

/// Open-paren byte (`(`).
const PAREN_OPEN: u8 = b'(';
/// Close-paren byte (`)`).
const PAREN_CLOSE: u8 = b')';
/// Open-bracket byte (`[`).
const BRACKET_OPEN: u8 = b'[';
/// Close-bracket byte (`]`).
const BRACKET_CLOSE: u8 = b']';

/// Comma byte — argument-list separator.
pub const COMMA_BYTE: u8 = b',';

/// Binary / comparison / logical operator in the RealLive expression
/// byte stream. The discriminants are the **raw operator bytes** that
/// follow the `\` (0x5C) prefix in the encoding.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[repr(u8)]
pub enum ExprOp {
    /// `+` — addition.
    Add = 0x02,
    /// `-` — subtraction.
    Sub = 0x03,
    /// `*` — multiplication.
    Mul = 0x04,
    /// `/` — division (zero divisor → [`EvaluationError::DivisionByZero`]).
    Div = 0x05,
    /// `%` — modulo (zero divisor → [`EvaluationError::DivisionByZero`]).
    Mod = 0x06,
    /// `&` — bitwise and.
    And = 0x07,
    /// `|` — bitwise or.
    Or = 0x08,
    /// `^` — bitwise xor.
    Xor = 0x09,
    /// `==` — equality.
    Equ = 0x28,
    /// `!=` — inequality.
    Neq = 0x29,
    /// `<` — less than.
    Lt = 0x2A,
    /// `<=` — less than or equal.
    Le = 0x2B,
    /// `>` — greater than.
    Gt = 0x2C,
    /// `>=` — greater than or equal.
    Ge = 0x2D,
    /// `&&` — logical and (short-circuit; integer truthy = nonzero).
    LogicAnd = 0x3C,
    /// `||` — logical or.
    LogicOr = 0x3D,
}

impl ExprOp {
    /// Map a raw operator byte (the byte that follows `\` in the
    /// encoding) to the typed [`ExprOp`] variant. Returns `None` if the
    /// byte is outside the documented operator table — the caller's
    /// recovery path (per the spec node's partial-result rule) handles
    /// the unknown byte explicitly.
    pub fn from_byte(byte: u8) -> Option<Self> {
        Some(match byte {
            0x02 => Self::Add,
            0x03 => Self::Sub,
            0x04 => Self::Mul,
            0x05 => Self::Div,
            0x06 => Self::Mod,
            0x07 => Self::And,
            0x08 => Self::Or,
            0x09 => Self::Xor,
            0x28 => Self::Equ,
            0x29 => Self::Neq,
            0x2A => Self::Lt,
            0x2B => Self::Le,
            0x2C => Self::Gt,
            0x2D => Self::Ge,
            0x3C => Self::LogicAnd,
            0x3D => Self::LogicOr,
            _ => return None,
        })
    }

    /// Raw byte value of this operator.
    pub fn as_byte(self) -> u8 {
        self as u8
    }
}

/// Unary operator in the RealLive expression byte stream.
///
/// Unary forms are spelled `\<op_byte> <term>`. `\\\x00` is documented
/// as a no-op (passes the operand through unchanged); `\\\x01` is
/// unary minus.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[repr(u8)]
pub enum UnaryOp {
    /// `\<0x00>` — no-op (identity).
    Noop = 0x00,
    /// `\<0x01>` — unary minus.
    Neg = 0x01,
}

impl UnaryOp {
    /// Map the byte immediately following a `\` prefix in the unary
    /// position to the typed [`UnaryOp`] variant. Returns `None` for
    /// any byte outside the documented `{0x00, 0x01}` pair.
    pub fn from_byte(byte: u8) -> Option<Self> {
        Some(match byte {
            0x00 => Self::Noop,
            0x01 => Self::Neg,
            _ => return None,
        })
    }
}

/// Compound-assignment operator. The op byte follows the `\` prefix in
/// the `<dest_term> \<assign_op> <source_expr>` shape of a standalone
/// expression element.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[repr(u8)]
pub enum AssignOp {
    /// `=` — plain assignment.
    Plain = 0x14,
    /// `+=`
    AddAssign = 0x15,
    /// `-=`
    SubAssign = 0x16,
    /// `*=`
    MulAssign = 0x17,
    /// `/=`
    DivAssign = 0x18,
    /// `%=`
    ModAssign = 0x19,
    /// `&=`
    AndAssign = 0x1A,
    /// `|=`
    OrAssign = 0x1B,
    /// `^=`
    XorAssign = 0x1C,
    /// `<<=` — left-shift assign (extends the spec-node table to cover
    /// the full documented assignment-op range used by Sweetie HD).
    ShlAssign = 0x1D,
    /// `>>=` — right-shift assign. Observed against Sweetie HD scene
    /// #0001 (all 20 Expression elements use `\\\x1E` as their
    /// assignment op).
    ShrAssign = 0x1E,
}

impl AssignOp {
    /// Map the byte after `\` in the assignment-operator slot to the
    /// typed [`AssignOp`] variant. Returns `None` for any byte outside
    /// the documented `0x14..=0x1E` range.
    pub fn from_byte(byte: u8) -> Option<Self> {
        Some(match byte {
            0x14 => Self::Plain,
            0x15 => Self::AddAssign,
            0x16 => Self::SubAssign,
            0x17 => Self::MulAssign,
            0x18 => Self::DivAssign,
            0x19 => Self::ModAssign,
            0x1A => Self::AndAssign,
            0x1B => Self::OrAssign,
            0x1C => Self::XorAssign,
            0x1D => Self::ShlAssign,
            0x1E => Self::ShrAssign,
            _ => return None,
        })
    }

    /// Raw byte value of this assignment operator.
    pub fn as_byte(self) -> u8 {
        self as u8
    }
}

/// AST node produced by [`parse_expression`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExprNode {
    /// 32-bit signed integer literal (sourced from the `$\xFF <i32:LE>`
    /// 6-byte token). Sign-extended on read; emitted unmodified.
    IntLiteral(i32),
    /// Reference to the single u32 store register (`$\xC8` in the
    /// encoding).
    StoreRegister,
    /// `$<bank>[<index_expr>]` — read or write into the documented
    /// `intA..intM` banks (bank byte indices in [`VarBanks`]).
    MemoryRef {
        /// Raw bank byte (e.g. `0x01` for `intB`).
        bank: u8,
        /// Index sub-expression (any expression — typically an int
        /// literal or another memory ref).
        index: Box<ExprNode>,
    },
    /// Binary / comparison / logical operator with two operands.
    BinaryOp {
        /// Operator variant (one of the documented [`ExprOp`] bytes).
        op: ExprOp,
        /// Left-hand operand.
        lhs: Box<ExprNode>,
        /// Right-hand operand.
        rhs: Box<ExprNode>,
    },
    /// `\<op_byte> <term>` — unary form. `\x00` is no-op; `\x01` is
    /// unary minus.
    UnaryOp {
        /// Unary operator variant.
        op: UnaryOp,
        /// Operand (a single term).
        operand: Box<ExprNode>,
    },
    /// `(<expr>)` — explicit grouping. Preserved in the AST so a
    /// round-trip serialiser (if/when one lands) can re-emit the
    /// original parens.
    Group(Box<ExprNode>),
    /// `<dest> \<assign_op> <src>` — assignment (the shape of a
    /// standalone `BytecodeElement::Expression`).
    Assignment {
        /// Destination — a [`ExprNode::MemoryRef`] or
        /// [`ExprNode::StoreRegister`] in practice.
        dest: Box<ExprNode>,
        /// Compound-assignment operator (`=`, `+=`, etc.).
        op: AssignOp,
        /// Source expression evaluated and stored into `dest`.
        src: Box<ExprNode>,
    },
}

/// Non-fatal warning surfaced by [`parse_expression`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExpressionWarning {
    /// An operator byte outside the documented [`ExprOp`] /
    /// [`AssignOp`] / [`UnaryOp`] table appeared at `offset`. The
    /// parser recovered by treating the unknown byte as a single-byte
    /// int-literal and continued. Audit code uses the typed code
    /// `utsushi.reallive.unknown_expression_operator` (see
    /// [`ExpressionWarning::AUDIT_CODE_UNKNOWN_OPERATOR`]).
    UnknownOperator {
        /// Raw operator byte that was not recognised.
        byte: u8,
        /// Byte offset (within the input slice) at which the unknown
        /// operator appeared.
        offset: usize,
    },
}

impl ExpressionWarning {
    /// Pinned typed audit code for the `UnknownOperator` warning. Pins
    /// the contract on the spec-node text rather than a string the
    /// caller has to spell verbatim.
    pub const AUDIT_CODE_UNKNOWN_OPERATOR: &'static str =
        "utsushi.reallive.unknown_expression_operator";

    /// Return the audit code string for this warning.
    pub fn audit_code(&self) -> &'static str {
        match self {
            Self::UnknownOperator { .. } => Self::AUDIT_CODE_UNKNOWN_OPERATOR,
        }
    }
}

/// Typed parse-side failure modes. Recoverable conditions surface as
/// [`ExpressionWarning`]s; only structural breaks (truncated input,
/// missing brackets / parens) become errors here.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ExpressionParseError {
    /// Input slice was empty. The "no silent zero-state" alpha-gate
    /// rule forbids returning a default `IntLiteral(0)` here — callers
    /// must check whether they have an Expression element before
    /// invoking the parser.
    #[error("expression parser: input is empty (no silent zero-state on empty buffer)")]
    Truncated {
        /// Length of the input slice that was supplied.
        observed_len: usize,
        /// Offset at which more bytes were needed.
        position: usize,
        /// Number of additional bytes the parser needed at `position`.
        needed: usize,
        /// Human-readable diagnostic (which sub-parser ran out of input).
        message: String,
    },

    /// Structurally malformed input: a known structural opener (e.g.
    /// `$` or `(`) had a follow-up byte that does not match the
    /// documented continuation.
    #[error("expression parser: malformed input at offset {position}: {message}")]
    Malformed {
        /// Offset at which the malformation was detected.
        position: usize,
        /// Human-readable diagnostic.
        message: String,
    },
}

/// Top-level entry point.
///
/// Parses a single RealLive expression byte stream and returns the
/// produced [`ExprNode`] plus the number of bytes consumed. The
/// caller can step over a multi-expression buffer by feeding the
/// remainder back to `parse_expression`.
///
/// On `Ok`, the returned node may be any [`ExprNode`] variant; in
/// particular, when the input is shaped as a standalone
/// [`crate::BytecodeElement::Expression`] (i.e.
/// `<dest_term> \<assign_op> <source>`), the returned node is an
/// [`ExprNode::Assignment`].
///
/// Non-fatal warnings surfaced during the parse (e.g. unknown operator
/// bytes) are absorbed into the partial result; use
/// [`parse_expression_with_warnings`] when callers want the warnings.
///
/// # Errors
///
/// - [`ExpressionParseError::Truncated`] on empty input or when a
///   sub-parser ran out of bytes.
/// - [`ExpressionParseError::Malformed`] when a documented structural
///   opener was not followed by a documented continuation (e.g. a
///   memory reference missing its `]`).
pub fn parse_expression(bytes: &[u8]) -> Result<(ExprNode, usize), ExpressionParseError> {
    let parsed = parse_expression_with_warnings(bytes)?;
    Ok((parsed.node, parsed.consumed))
}

/// Wrapper carrying the parse result + the non-fatal warning vector.
/// The synthetic test suite asserts on the warning vector; the
/// real-bytes integration test asserts on the count.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedExpression {
    /// The produced AST node.
    pub node: ExprNode,
    /// Number of bytes consumed from the input.
    pub consumed: usize,
    /// Non-fatal warnings emitted during the parse (unknown operator
    /// bytes etc.).
    pub warnings: Vec<ExpressionWarning>,
}

/// As [`parse_expression`], but surfaces the warning vector.
pub fn parse_expression_with_warnings(
    bytes: &[u8],
) -> Result<ParsedExpression, ExpressionParseError> {
    if bytes.is_empty() {
        return Err(ExpressionParseError::Truncated {
            observed_len: 0,
            position: 0,
            needed: 1,
            message: "expression parser: empty input slice".to_string(),
        });
    }

    let mut state = ParserState::new(bytes);

    // Try assignment shape first. The assignment shape is unique to a
    // standalone ExpressionElement and is the form callers feed in
    // most often. The detection rule is "after the destination term
    // (which must be parseable as a `term`), the next two bytes are
    // `\` + an assignment-op byte in 0x14..=0x1C". When the lookahead
    // succeeds the term is wrapped into an Assignment; when it fails
    // the parse falls back to a top-level expression.
    if let Some(parsed) = try_parse_assignment(&mut state)? {
        return Ok(ParsedExpression {
            node: parsed.0,
            consumed: state.pos,
            warnings: state.into_warnings(),
        });
    }

    // No assignment-shape match; parse as a top-level expression.
    let node = parse_expr(&mut state)?;
    let consumed = state.pos;
    Ok(ParsedExpression {
        node,
        consumed,
        warnings: state.into_warnings(),
    })
}

/// Maximum grouping / unary nesting depth the parser will descend before
/// surfacing a typed [`ExpressionParseError::Malformed`]. `parse_term`
/// (the single re-entry point for every `(`-grouping and `\<op>` unary
/// recursion) is guarded by this bound so a malformed / hostile
/// expression with deeply nested `(` cannot stack-overflow the process —
/// it returns the typed error the module otherwise guarantees. Real
/// RealLive expressions nest only a handful of levels; this cap is loose.
const MAX_EXPRESSION_DEPTH: usize = 256;

/// Recursive-descent state shared across the helper functions.
struct ParserState<'a> {
    bytes: &'a [u8],
    pos: usize,
    warnings: Vec<ExpressionWarning>,
    /// Current grouping / unary nesting depth (see [`MAX_EXPRESSION_DEPTH`]).
    depth: usize,
}

impl<'a> ParserState<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self {
            bytes,
            pos: 0,
            warnings: Vec::new(),
            depth: 0,
        }
    }

    fn peek(&self, offset: usize) -> Option<u8> {
        self.bytes.get(self.pos + offset).copied()
    }

    fn current(&self) -> Option<u8> {
        self.peek(0)
    }

    fn advance(&mut self, by: usize) {
        self.pos += by;
    }

    fn remaining(&self) -> usize {
        self.bytes.len().saturating_sub(self.pos)
    }

    fn truncated(&self, needed: usize, where_msg: impl Into<String>) -> ExpressionParseError {
        ExpressionParseError::Truncated {
            observed_len: self.bytes.len(),
            position: self.pos,
            needed,
            message: where_msg.into(),
        }
    }

    fn malformed(&self, position: usize, message: impl Into<String>) -> ExpressionParseError {
        ExpressionParseError::Malformed {
            position,
            message: message.into(),
        }
    }

    fn into_warnings(self) -> Vec<ExpressionWarning> {
        self.warnings
    }
}

/// Try to parse the input as `<dest_term> \<assign_op> <src_expr>`. On
/// success returns `Some(node)` and the state's cursor is at the end
/// of the input (or wherever `parse_expr` left it). On a non-match
/// returns `Ok(None)` and the cursor is restored to where it was at
/// entry.
fn try_parse_assignment(
    state: &mut ParserState<'_>,
) -> Result<Option<(ExprNode, ())>, ExpressionParseError> {
    let entry_pos = state.pos;
    // Detection: the assignment-shape destination is always a term that
    // begins with `$` (the bytecode_element decoder enforces this for
    // standalone Expression elements). If the input does not start
    // with `$`, this is not an assignment shape.
    if state.current() != Some(EXPRESSION_TOKEN_LEAD) {
        return Ok(None);
    }
    // Parse a single term as a destination candidate, then peek at the
    // two following bytes.
    let dest_candidate = match parse_term(state) {
        Ok(node) => node,
        Err(err) => {
            // Roll back so the fallback parse can try the same bytes
            // through a different production.
            state.pos = entry_pos;
            return Err(err);
        }
    };
    // Need `\` + assign-op byte.
    let backslash = state.current();
    let op_byte = state.peek(1);
    let (Some(EXPRESSION_BACKSLASH), Some(raw_op)) = (backslash, op_byte) else {
        // Not an assignment shape. Rewind.
        state.pos = entry_pos;
        return Ok(None);
    };
    let Some(op) = AssignOp::from_byte(raw_op) else {
        // The slot has the backslash but the op byte is outside the
        // assignment range — not an assignment shape (likely a binary
        // op continuation that parse_expr will pick up).
        state.pos = entry_pos;
        return Ok(None);
    };
    // Commit to the assignment shape.
    state.advance(2);
    let src = parse_expr(state)?;
    Ok(Some((
        ExprNode::Assignment {
            dest: Box::new(dest_candidate),
            op,
            src: Box::new(src),
        },
        (),
    )))
}

/// Parse a top-level expression (mirrors `next_expression` in the
/// bytecode walker but builds an AST). Form:
/// `<and> ( \<LogicOr> <expr> )?`.
fn parse_expr(state: &mut ParserState<'_>) -> Result<ExprNode, ExpressionParseError> {
    let mut lhs = parse_and(state)?;
    while let Some(op) = peek_binary_op(state, &[ExprOp::LogicOr]) {
        state.advance(2);
        let rhs = parse_and(state)?;
        lhs = ExprNode::BinaryOp {
            op,
            lhs: Box::new(lhs),
            rhs: Box::new(rhs),
        };
    }
    Ok(lhs)
}

/// `<cond> ( \<LogicAnd> <and> )?`.
fn parse_and(state: &mut ParserState<'_>) -> Result<ExprNode, ExpressionParseError> {
    let mut lhs = parse_cond(state)?;
    while let Some(op) = peek_binary_op(state, &[ExprOp::LogicAnd]) {
        state.advance(2);
        let rhs = parse_cond(state)?;
        lhs = ExprNode::BinaryOp {
            op,
            lhs: Box::new(lhs),
            rhs: Box::new(rhs),
        };
    }
    Ok(lhs)
}

/// `<arith> ( \<comparison> <arith> )?` — one comparison level (no
/// chaining; comparisons are not associative in RealLive scripts).
fn parse_cond(state: &mut ParserState<'_>) -> Result<ExprNode, ExpressionParseError> {
    let lhs = parse_arith(state)?;
    let comparison_ops = [
        ExprOp::Equ,
        ExprOp::Neq,
        ExprOp::Lt,
        ExprOp::Le,
        ExprOp::Gt,
        ExprOp::Ge,
    ];
    if let Some(op) = peek_binary_op(state, &comparison_ops) {
        state.advance(2);
        let rhs = parse_arith(state)?;
        return Ok(ExprNode::BinaryOp {
            op,
            lhs: Box::new(lhs),
            rhs: Box::new(rhs),
        });
    }
    Ok(lhs)
}

/// `<term> ( \<arith_op> <arith> )*` — arithmetic / bitwise operators
/// left-associative.
fn parse_arith(state: &mut ParserState<'_>) -> Result<ExprNode, ExpressionParseError> {
    let mut lhs = parse_term(state)?;
    let arithmetic_ops = [
        ExprOp::Add,
        ExprOp::Sub,
        ExprOp::Mul,
        ExprOp::Div,
        ExprOp::Mod,
        ExprOp::And,
        ExprOp::Or,
        ExprOp::Xor,
    ];
    loop {
        if let Some(op) = peek_binary_op(state, &arithmetic_ops) {
            state.advance(2);
            let rhs = parse_term(state)?;
            lhs = ExprNode::BinaryOp {
                op,
                lhs: Box::new(lhs),
                rhs: Box::new(rhs),
            };
            continue;
        }
        // Partial-result recovery: if the slot is a `\` followed by a
        // byte that is NOT a documented binary / comparison / logical
        // op AND NOT an assignment op AND NOT a unary-position byte
        // (we are past the term so `\x00` / `\x01` would be unary
        // continuation which is structurally invalid here), emit a
        // warning and treat the unknown byte as an int-literal. This
        // is the partial-result rule from the spec node's third
        // acceptance criterion.
        if peek_unknown_binary_op_slot(state) {
            let offset = state.pos;
            let unknown_byte = state.peek(1).unwrap_or(0);
            state.warnings.push(ExpressionWarning::UnknownOperator {
                byte: unknown_byte,
                offset,
            });
            // Consume the `\` + unknown byte and continue parsing as
            // if the unknown byte were a binary `+` with literal 0 on
            // the right — i.e. yield the partial result so far.
            state.advance(2);
            // Do NOT continue the loop; partial result terminates the
            // arithmetic continuation chain.
            break;
        }
        break;
    }
    Ok(lhs)
}

/// Detect a `\<op>` slot whose op byte is not in any documented
/// continuation table. Returns true only when the bytes after the
/// backslash are clearly meant as an op continuation but the byte is
/// outside the union of [`ExprOp`] / [`AssignOp`] tables — covering
/// the "unknown operator byte" case from the spec node.
fn peek_unknown_binary_op_slot(state: &ParserState<'_>) -> bool {
    if state.current() != Some(EXPRESSION_BACKSLASH) {
        return false;
    }
    let Some(op_byte) = state.peek(1) else {
        return false;
    };
    // Skip unary-position bytes (they only appear at the start of a
    // term, not in an arithmetic continuation slot).
    ExprOp::from_byte(op_byte).is_none() && AssignOp::from_byte(op_byte).is_none()
}

/// Peek for a `\<op>` slot whose op byte is in `allowed`. Returns the
/// matched [`ExprOp`] without advancing the cursor. The cursor is
/// advanced by the caller (`state.advance(2)`) when the match is
/// committed.
fn peek_binary_op(state: &ParserState<'_>, allowed: &[ExprOp]) -> Option<ExprOp> {
    if state.current() != Some(EXPRESSION_BACKSLASH) {
        return None;
    }
    let op_byte = state.peek(1)?;
    let op = ExprOp::from_byte(op_byte)?;
    if allowed.contains(&op) {
        Some(op)
    } else {
        None
    }
}

/// Parse a single term — grouping, unary form, or token.
///
/// `parse_term` is the single re-entry point of the mutually-recursive
/// descent: every `(`-grouping recurses through `parse_expr` back into
/// `parse_term`, and every `\<op>` unary form recurses into `parse_term`
/// directly. Guarding it with a depth counter therefore bounds the whole
/// recursion: a hostile expression with deeply nested groupings surfaces
/// a typed [`ExpressionParseError::Malformed`] past
/// [`MAX_EXPRESSION_DEPTH`] instead of overflowing the stack.
fn parse_term(state: &mut ParserState<'_>) -> Result<ExprNode, ExpressionParseError> {
    state.depth += 1;
    if state.depth > MAX_EXPRESSION_DEPTH {
        let pos = state.pos;
        state.depth -= 1;
        return Err(state.malformed(
            pos,
            format!("term: expression nesting exceeded depth limit {MAX_EXPRESSION_DEPTH}"),
        ));
    }
    let result = parse_term_body(state);
    state.depth -= 1;
    result
}

/// Body of [`parse_term`]; see that function for the depth-bound rationale.
fn parse_term_body(state: &mut ParserState<'_>) -> Result<ExprNode, ExpressionParseError> {
    let Some(b0) = state.current() else {
        return Err(state.truncated(1, "term: input exhausted"));
    };
    if b0 == PAREN_OPEN {
        state.advance(1);
        let inner = parse_expr(state)?;
        match state.current() {
            Some(PAREN_CLOSE) => {
                state.advance(1);
                Ok(ExprNode::Group(Box::new(inner)))
            }
            Some(other) => Err(state.malformed(
                state.pos,
                format!("term: expected ')' (0x29) to close grouping, got 0x{other:02x}"),
            )),
            None => Err(state.truncated(1, "term: grouping missing closing ')'")),
        }
    } else if b0 == EXPRESSION_BACKSLASH {
        // Unary form: \<op> <term>.
        let Some(op_byte) = state.peek(1) else {
            return Err(state.truncated(1, "term: backslash-prefixed unary form truncated"));
        };
        let Some(unary_op) = UnaryOp::from_byte(op_byte) else {
            // Unknown unary byte — partial-result recovery: emit a
            // warning, consume `\` + byte, return a 0 literal so the
            // outer arithmetic chain still has an operand.
            state.warnings.push(ExpressionWarning::UnknownOperator {
                byte: op_byte,
                offset: state.pos,
            });
            state.advance(2);
            return Ok(ExprNode::IntLiteral(0));
        };
        state.advance(2);
        let operand = parse_term(state)?;
        Ok(ExprNode::UnaryOp {
            op: unary_op,
            operand: Box::new(operand),
        })
    } else if b0 == EXPRESSION_TOKEN_LEAD {
        parse_token(state)
    } else {
        // Recovery: out-of-spec byte where a term was expected. Emit
        // an UnknownOperator warning, consume one byte, and return it
        // as a single-byte int-literal so the chain can continue. This
        // is the third acceptance criterion's partial-result rule.
        state.warnings.push(ExpressionWarning::UnknownOperator {
            byte: b0,
            offset: state.pos,
        });
        state.advance(1);
        Ok(ExprNode::IntLiteral(i32::from(b0)))
    }
}

/// Parse a token (`$\xFF <i32:LE>`, `$\xC8`, or `$<bank>[<idx>]`).
fn parse_token(state: &mut ParserState<'_>) -> Result<ExprNode, ExpressionParseError> {
    // Caller guarantees state.current() == Some(EXPRESSION_TOKEN_LEAD).
    state.advance(1);
    let Some(b1) = state.current() else {
        return Err(state.truncated(1, "token: missing byte after '$' lead"));
    };
    if b1 == EXPRESSION_INT_LITERAL_TAG {
        // $ FF <i32 LE> — 6 bytes total (we already consumed the `$`).
        if state.remaining() < 5 {
            return Err(state.truncated(
                5 - state.remaining(),
                "token: 6-byte int-constant truncated",
            ));
        }
        state.advance(1); // skip the 0xFF tag
        let literal = read_i32_le(state)?;
        Ok(ExprNode::IntLiteral(literal))
    } else if b1 == EXPRESSION_STORE_REGISTER_TAG {
        // $ C8 — store register reference.
        state.advance(1);
        Ok(ExprNode::StoreRegister)
    } else {
        // $ <bank> — either 2-byte alt form or `$<bank>[<idx>]`.
        let bank = b1;
        // Look at what follows the bank byte.
        match state.peek(1) {
            Some(BRACKET_OPEN) => {
                // $ <bank> [ <idx_expr> ]
                state.advance(2); // consume bank + `[`
                let index_node = parse_expr(state)?;
                match state.current() {
                    Some(BRACKET_CLOSE) => {
                        state.advance(1);
                        Ok(ExprNode::MemoryRef {
                            bank,
                            index: Box::new(index_node),
                        })
                    }
                    Some(other) => Err(state.malformed(
                        state.pos,
                        format!(
                            "token: memory-reference must close with ']' (0x5D); observed \
                             0x{other:02x}",
                        ),
                    )),
                    None => Err(state.truncated(1, "token: memory-reference missing closing ']'")),
                }
            }
            _ => {
                // 2-byte alt form: bank byte with no bracketed index.
                // Encode as `MemoryRef { bank, index: IntLiteral(0) }`
                // — the bank reference resolves to the bank's first
                // slot per the rlvm convention.
                state.advance(1);
                Ok(ExprNode::MemoryRef {
                    bank,
                    index: Box::new(ExprNode::IntLiteral(0)),
                })
            }
        }
    }
}

/// Read a little-endian signed 32-bit integer starting at the cursor;
/// advance the cursor 4 bytes.
fn read_i32_le(state: &mut ParserState<'_>) -> Result<i32, ExpressionParseError> {
    if state.remaining() < 4 {
        return Err(state.truncated(
            4 - state.remaining(),
            "i32-LE: not enough bytes for a 32-bit literal",
        ));
    }
    let bytes = [
        state.bytes[state.pos],
        state.bytes[state.pos + 1],
        state.bytes[state.pos + 2],
        state.bytes[state.pos + 3],
    ];
    state.advance(4);
    Ok(i32::from_le_bytes(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input_is_truncated_not_zero_state() {
        match parse_expression(&[]) {
            Err(ExpressionParseError::Truncated { observed_len, .. }) => {
                assert_eq!(observed_len, 0);
            }
            other => panic!("expected Truncated on empty input, got {other:?}"),
        }
    }

    #[test]
    fn deeply_nested_groupings_surface_typed_error_not_stack_overflow() {
        // Regression (audit-3): `parse_term` recursed into `parse_expr`
        // on every `(` with no depth limit, so a hostile expression of
        // deeply nested `(` overflowed the process stack. Past
        // `MAX_EXPRESSION_DEPTH` the parser must instead return the typed
        // `Malformed` error the module guarantees.
        let bytes = vec![PAREN_OPEN; MAX_EXPRESSION_DEPTH + 50];
        match parse_expression(&bytes) {
            Err(ExpressionParseError::Malformed { .. }) => {}
            other => panic!("expected Malformed on over-deep nesting, got {other:?}"),
        }
    }

    #[test]
    fn moderately_nested_groupings_still_parse() {
        // A legitimately nested integer literal `((($FF 5)))` must still
        // parse — the depth bound only trips on pathological nesting.
        let mut bytes = vec![PAREN_OPEN; 3];
        bytes.extend_from_slice(&[EXPRESSION_TOKEN_LEAD, EXPRESSION_INT_LITERAL_TAG]);
        bytes.extend_from_slice(&5_i32.to_le_bytes());
        bytes.extend(std::iter::repeat_n(PAREN_CLOSE, 3));
        parse_expression(&bytes).expect("3-deep grouping must parse");
    }

    #[test]
    fn int_literal_round_trip_positive() {
        // $ FF 2A 00 00 00 → 42
        let bytes = [0x24, 0xFF, 0x2A, 0x00, 0x00, 0x00];
        let (node, consumed) = parse_expression(&bytes).expect("parse");
        assert_eq!(consumed, 6);
        assert_eq!(node, ExprNode::IntLiteral(42));
    }

    #[test]
    fn int_literal_round_trip_negative_sign_extends() {
        // $ FF FF FF FF FF → -1
        let bytes = [0x24, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF];
        let (node, _) = parse_expression(&bytes).expect("parse");
        assert_eq!(node, ExprNode::IntLiteral(-1));
    }

    #[test]
    fn store_register_token() {
        // $ C8
        let bytes = [0x24, 0xC8];
        let (node, consumed) = parse_expression(&bytes).expect("parse");
        assert_eq!(consumed, 2);
        assert_eq!(node, ExprNode::StoreRegister);
    }

    #[test]
    fn memory_ref_bank_b_index_zero() {
        // $ 01 [ $ FF 00 00 00 00 ]  — intB[0]
        let bytes = [0x24, 0x01, 0x5B, 0x24, 0xFF, 0x00, 0x00, 0x00, 0x00, 0x5D];
        let (node, consumed) = parse_expression(&bytes).expect("parse");
        assert_eq!(consumed, bytes.len());
        match node {
            ExprNode::MemoryRef { bank, index } => {
                assert_eq!(bank, 0x01);
                assert_eq!(*index, ExprNode::IntLiteral(0));
            }
            other => panic!("expected MemoryRef, got {other:?}"),
        }
    }

    #[test]
    fn add_one_plus_two_builds_binary_op_add() {
        // $ FF 01 00 00 00 \ 02 $ FF 02 00 00 00
        let bytes = [
            0x24, 0xFF, 0x01, 0x00, 0x00, 0x00, 0x5C, 0x02, 0x24, 0xFF, 0x02, 0x00, 0x00, 0x00,
        ];
        let (node, consumed) = parse_expression(&bytes).expect("parse");
        assert_eq!(consumed, bytes.len());
        match node {
            ExprNode::BinaryOp { op, lhs, rhs } => {
                assert_eq!(op, ExprOp::Add);
                assert_eq!(*lhs, ExprNode::IntLiteral(1));
                assert_eq!(*rhs, ExprNode::IntLiteral(2));
            }
            other => panic!("expected BinaryOp(Add), got {other:?}"),
        }
    }

    #[test]
    fn assignment_shape_yields_assignment_node() {
        // $ 01 [ $ FF 00 00 00 00 ] \ 14 $ FF 07 00 00 00  — intB[0] = 7
        let bytes = [
            0x24, 0x01, 0x5B, 0x24, 0xFF, 0x00, 0x00, 0x00, 0x00, 0x5D, 0x5C, 0x14, 0x24, 0xFF,
            0x07, 0x00, 0x00, 0x00,
        ];
        let (node, consumed) = parse_expression(&bytes).expect("parse");
        assert_eq!(consumed, bytes.len());
        match node {
            ExprNode::Assignment { dest, op, src } => {
                assert_eq!(op, AssignOp::Plain);
                match *dest {
                    ExprNode::MemoryRef { bank, .. } => assert_eq!(bank, 0x01),
                    other => panic!("expected MemoryRef dest, got {other:?}"),
                }
                assert_eq!(*src, ExprNode::IntLiteral(7));
            }
            other => panic!("expected Assignment, got {other:?}"),
        }
    }

    #[test]
    fn unknown_operator_byte_in_continuation_emits_warning_and_recovers() {
        // $ FF 01 00 00 00 \ 99 — \x99 is not a documented op byte.
        let bytes = [0x24, 0xFF, 0x01, 0x00, 0x00, 0x00, 0x5C, 0x99];
        let parsed = parse_expression_with_warnings(&bytes).expect("parse with recovery");
        assert!(matches!(parsed.node, ExprNode::IntLiteral(1)));
        assert_eq!(parsed.warnings.len(), 1);
        match &parsed.warnings[0] {
            ExpressionWarning::UnknownOperator { byte, .. } => assert_eq!(*byte, 0x99),
        }
    }

    #[test]
    fn op_byte_table_pins_each_variant() {
        assert_eq!(ExprOp::Add.as_byte(), 0x02);
        assert_eq!(ExprOp::Sub.as_byte(), 0x03);
        assert_eq!(ExprOp::Mul.as_byte(), 0x04);
        assert_eq!(ExprOp::Div.as_byte(), 0x05);
        assert_eq!(ExprOp::Mod.as_byte(), 0x06);
        assert_eq!(ExprOp::And.as_byte(), 0x07);
        assert_eq!(ExprOp::Or.as_byte(), 0x08);
        assert_eq!(ExprOp::Xor.as_byte(), 0x09);
        assert_eq!(ExprOp::Equ.as_byte(), 0x28);
        assert_eq!(ExprOp::Neq.as_byte(), 0x29);
        assert_eq!(ExprOp::Lt.as_byte(), 0x2A);
        assert_eq!(ExprOp::Le.as_byte(), 0x2B);
        assert_eq!(ExprOp::Gt.as_byte(), 0x2C);
        assert_eq!(ExprOp::Ge.as_byte(), 0x2D);
        assert_eq!(ExprOp::LogicAnd.as_byte(), 0x3C);
        assert_eq!(ExprOp::LogicOr.as_byte(), 0x3D);
    }

    #[test]
    fn assign_op_byte_table_pins_each_variant() {
        assert_eq!(AssignOp::Plain.as_byte(), 0x14);
        assert_eq!(AssignOp::AddAssign.as_byte(), 0x15);
        assert_eq!(AssignOp::SubAssign.as_byte(), 0x16);
        assert_eq!(AssignOp::MulAssign.as_byte(), 0x17);
        assert_eq!(AssignOp::DivAssign.as_byte(), 0x18);
        assert_eq!(AssignOp::ModAssign.as_byte(), 0x19);
        assert_eq!(AssignOp::AndAssign.as_byte(), 0x1A);
        assert_eq!(AssignOp::OrAssign.as_byte(), 0x1B);
        assert_eq!(AssignOp::XorAssign.as_byte(), 0x1C);
    }
}
