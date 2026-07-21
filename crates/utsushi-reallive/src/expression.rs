//! RealLive expression byte-stream parser.
//!
//! Consumes the `raw_bytes` payload of a
//! [`crate::BytecodeElement::Expression`] () and produces a
//! typed [`ExprNode`] AST. The byte stream is the documented RealLive
//! expression encoding (`docs/research/reallive-engine.md` §G
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
//! - `\ 0x00 <term>` / `\ 0x01 <term>` — unary forms (no-op
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
//! Pinned operator byte table:
//!
//! Byte (after `\`) | Operator | Variant
//! ---------------- | ------------ | ------------------
//! `0x02` | `+` | [`ExprOp::Add`]
//! `0x03` | `-` | [`ExprOp::Sub`]
//! `0x04` | `*` | [`ExprOp::Mul`]
//! `0x05` | `/` | [`ExprOp::Div`]
//! `0x06` | `%` | [`ExprOp::Mod`]
//! `0x07` | `&` | [`ExprOp::And`]
//! `0x08` | `\|` | [`ExprOp::Or`]
//! `0x09` | `^` | [`ExprOp::Xor`]
//! `0x28` | `==` | [`ExprOp::Equ`]
//! `0x29` | `!=` | [`ExprOp::Neq`]
//! `0x2A` | `<` | [`ExprOp::Lt`]
//! `0x2B` | `<=` | [`ExprOp::Le`]
//! `0x2C` | `>` | [`ExprOp::Gt`]
//! `0x2D` | `>=` | [`ExprOp::Ge`]
//! `0x3C` | `&&` | [`ExprOp::LogicAnd`]
//! `0x3D` | `\|\|` | [`ExprOp::LogicOr`]
//!
//! Assignment ops live in `0x14..=0x24` per the bytecode walker, with
//! the documented sub-range expanded below:
//!
//! Byte (after `\`) | Operator | Variant
//! ---------------- | -------- | ------------------------
//! `0x14` | `+=` | [`AssignOp::AddAssign`]
//! `0x15` | `-=` | [`AssignOp::SubAssign`]
//! `0x16` | `*=` | [`AssignOp::MulAssign`]
//! `0x17` | `/=` | [`AssignOp::DivAssign`]
//! `0x18` | `%=` | [`AssignOp::ModAssign`]
//! `0x19` | `&=` | [`AssignOp::AndAssign`]
//! `0x1A` | `\|=` | [`AssignOp::OrAssign`]
//! `0x1B` | `^=` | [`AssignOp::XorAssign`]
//! `0x1C` | `<<=` | [`AssignOp::ShlAssign`]
//! `0x1D` | `>>=` | [`AssignOp::ShrAssign`]
//! `0x1E` | `=` | [`AssignOp::Plain`]
//!
//! (This matches rlvm's `libreallive/expression.cc`: op `30`/`0x1E` is the
//! special-cased plain `=`, `0x14..=0x1D` are the compound forms.)
//!
//! The `0x1F..=0x24` slots are accepted by the bytecode walker but
//! their semantics are not documented in RLDEV; the two public entry
//! points handle them differently (see below).
//!
//! # Dual path: decompile (fail-closed) vs emulator (fail-soft)
//!
//! - [`parse_expression`] is the **decompile / strict** path. An
//!   unknown operator byte is a typed
//!   [`ExpressionParseError::UnknownOperator`] — no fabricated
//!   `+ 0` / partial AST. Static tools and re-decompile acceptance
//!   must not silently paper over coverage gaps.
//! - [`parse_expression_with_warnings`] is the **emulator / replay**
//!   path. An unknown operator emits
//!   [`ExpressionWarning::UnknownOperator`] and recovers with a
//!   partial result (treat the slot as terminating the arithmetic
//!   chain / a zero operand) so the VM can keep making progress.
//!   Callers that care about coverage assert the warning vector is
//!   empty on real bytes.
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
/// the acceptance criteria share one symbol.
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
    /// partial-result recovery path handles the unknown byte explicitly.
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
    /// `+=`
    AddAssign = 0x14,
    /// `-=`
    SubAssign = 0x15,
    /// `*=`
    MulAssign = 0x16,
    /// `/=`
    DivAssign = 0x17,
    /// `%=`
    ModAssign = 0x18,
    /// `&=`
    AndAssign = 0x19,
    /// `|=`
    OrAssign = 0x1A,
    /// `^=`
    XorAssign = 0x1B,
    /// `<<=` — left-shift assign.
    ShlAssign = 0x1C,
    /// `>>=` — right-shift assign.
    ShrAssign = 0x1D,
    /// `=` — plain assignment. RealLive encodes plain `=` as operator
    /// `30` (`0x1E`), the SPECIAL-CASED assignment op — NOT `0x14`, which
    /// is `+=` (see rlvm `libreallive/expression.cc`: op `30` prints `=`
    /// with no trailing `=`, while ops `0x14..=0x1D` are the compound
    /// forms). A prior revision mis-pinned `0x14` as plain `=` and slid
    /// every compound op up one slot, so real assignments like
    /// `intX[Y] = store` (op `0x1E`) were mis-decoded as `>>=`
    /// (`intX[Y] = intX[Y] >> store` = `0 >> store` = `0`) — which broke
    /// real select→branch driving (the chosen index never reached the
    /// `goto_case` / `goto_on` discriminant). Corrected to rlvm's table.
    Plain = 0x1E,
}

impl AssignOp {
    /// Map the byte after `\` in the assignment-operator slot to the
    /// typed [`AssignOp`] variant. Returns `None` for any byte outside
    /// the documented `0x14..=0x1E` range. The mapping matches rlvm's
    /// operator table: `0x14..=0x1D` are the compound assignments
    /// (`+=` … `>>=`) and `0x1E` (`30`) is the plain `=`.
    pub fn from_byte(byte: u8) -> Option<Self> {
        Some(match byte {
            0x14 => Self::AddAssign,
            0x15 => Self::SubAssign,
            0x16 => Self::MulAssign,
            0x17 => Self::DivAssign,
            0x18 => Self::ModAssign,
            0x19 => Self::AndAssign,
            0x1A => Self::OrAssign,
            0x1B => Self::XorAssign,
            0x1C => Self::ShlAssign,
            0x1D => Self::ShrAssign,
            0x1E => Self::Plain,
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

/// Non-fatal warning surfaced by [`parse_expression_with_warnings`]
/// (emulator / recover path). The decompile path
/// ([`parse_expression`]) promotes the same condition to
/// [`ExpressionParseError::UnknownOperator`] instead.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExpressionWarning {
    /// An operator byte outside the documented [`ExprOp`] /
    /// [`AssignOp`] / [`UnaryOp`] table appeared at `offset`. The
    /// recover-path parser treated the unknown byte as a terminating
    /// partial result (or a zero operand) and continued. Audit code
    /// uses the typed code `utsushi.reallive.unknown_expression_operator`
    /// (see [`ExpressionWarning::AUDIT_CODE_UNKNOWN_OPERATOR`]).
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

/// Typed parse-side failure modes.
///
/// On the **decompile / strict** path ([`parse_expression`]), unknown
/// operator bytes are also errors ([`Self::UnknownOperator`]). On the
/// **emulator / recover** path ([`parse_expression_with_warnings`]),
/// those same bytes surface as [`ExpressionWarning`]s instead; only
/// structural breaks (truncated input, missing brackets / parens)
/// become errors there.
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

    /// An operator byte outside the documented [`ExprOp`] /
    /// [`AssignOp`] / [`UnaryOp`] tables appeared at `position`.
    /// Returned only by the decompile / strict path
    /// ([`parse_expression`]); the emulator path recovers with
    /// [`ExpressionWarning::UnknownOperator`] instead.
    #[error(
        "expression parser: unknown operator byte 0x{byte:02x} at offset {position} \
         (utsushi.reallive.unknown_expression_operator)"
    )]
    UnknownOperator {
        /// Raw operator byte that was not recognised.
        byte: u8,
        /// Byte offset (within the input slice) at which the unknown
        /// operator appeared.
        position: usize,
    },
}

/// Decompile / strict entry point.
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
/// This path is **fail-closed** on unknown operator bytes: they
/// surface as [`ExpressionParseError::UnknownOperator`] rather than a
/// fabricated partial AST. Emulator / replay callers that need
/// fail-soft recovery must use
/// [`parse_expression_with_warnings`] instead.
///
/// # Errors
///
/// - [`ExpressionParseError::Truncated`] on empty input or when a
///   sub-parser ran out of bytes.
/// - [`ExpressionParseError::Malformed`] when a documented structural
///   opener was not followed by a documented continuation (e.g. a
///   memory reference missing its `]`).
/// - [`ExpressionParseError::UnknownOperator`] when an op byte outside
///   the documented tables appears in a continuation / unary / term
///   slot.
pub fn parse_expression(bytes: &[u8]) -> Result<(ExprNode, usize), ExpressionParseError> {
    let parsed = parse_expression_inner(bytes, /*recover_unknown_operators=*/ false)?;
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
    /// bytes etc.). Empty when no recovery was needed.
    pub warnings: Vec<ExpressionWarning>,
}

/// Emulator / replay entry point: fail-soft on unknown operators.
///
/// Same productions as [`parse_expression`], but an unknown operator
/// byte emits [`ExpressionWarning::UnknownOperator`] and recovers
/// with a partial AST instead of returning
/// [`ExpressionParseError::UnknownOperator`]. Structural failures
/// (truncated / malformed) remain hard errors.
pub fn parse_expression_with_warnings(
    bytes: &[u8],
) -> Result<ParsedExpression, ExpressionParseError> {
    parse_expression_inner(bytes, /*recover_unknown_operators=*/ true)
}

fn parse_expression_inner(
    bytes: &[u8],
    recover_unknown_operators: bool,
) -> Result<ParsedExpression, ExpressionParseError> {
    if bytes.is_empty() {
        return Err(ExpressionParseError::Truncated {
            observed_len: 0,
            position: 0,
            needed: 1,
            message: "expression parser: empty input slice".to_string(),
        });
    }

    let mut state = ParserState::new(bytes, recover_unknown_operators);

    // Try assignment shape first. The assignment shape is unique to a
    // standalone ExpressionElement and is the form callers feed in
    // most often. The detection rule is "after the destination term
    // (which must be parseable as a `term`), the next two bytes are
    // `\` + any byte accepted by `AssignOp::from_byte` (0x14..=0x1E)".
    // When the lookahead succeeds the term is wrapped into an
    // Assignment; when it fails the parse falls back to a top-level
    // expression.
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
    /// When `true` (emulator path), unknown operator bytes emit
    /// [`ExpressionWarning::UnknownOperator`] and recover. When `false`
    /// (decompile path), they return
    /// [`ExpressionParseError::UnknownOperator`].
    recover_unknown_operators: bool,
}

impl<'a> ParserState<'a> {
    fn new(bytes: &'a [u8], recover_unknown_operators: bool) -> Self {
        Self {
            bytes,
            pos: 0,
            warnings: Vec::new(),
            depth: 0,
            recover_unknown_operators,
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

    fn malformed(position: usize, message: impl Into<String>) -> ExpressionParseError {
        ExpressionParseError::Malformed {
            position,
            message: message.into(),
        }
    }

    /// Emulator: push [`ExpressionWarning::UnknownOperator`] and return
    /// `Ok(())`. Decompile: return
    /// [`ExpressionParseError::UnknownOperator`].
    fn on_unknown_operator(&mut self, byte: u8, offset: usize) -> Result<(), ExpressionParseError> {
        if self.recover_unknown_operators {
            self.warnings
                .push(ExpressionWarning::UnknownOperator { byte, offset });
            Ok(())
        } else {
            Err(ExpressionParseError::UnknownOperator {
                byte,
                position: offset,
            })
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
        // Unknown-operator slot: `\` + a byte outside every documented
        // binary / comparison / logical / assignment / unary table.
        // Emulator path: warn + yield the partial result so far (as if
        // the unknown byte were a terminating `+ 0`). Decompile path:
        // typed error (no fabricated AST).
        //
        // `position` / warning `offset` identify the unknown *operator
        // byte* (peek(1)), not the backslash cursor — matching
        // [`ExpressionParseError::UnknownOperator`] / [`ExpressionWarning`].
        if peek_unknown_binary_op_slot(state) {
            let unknown_byte = state.peek(1).unwrap_or(0);
            let op_position = state.pos + 1;
            state.on_unknown_operator(unknown_byte, op_position)?;
            // Consume the `\` + unknown byte and terminate the
            // arithmetic continuation chain with the partial LHS.
            state.advance(2);
            break;
        }
        break;
    }
    Ok(lhs)
}

/// Detect a `\<op>` slot whose op byte is not in any documented
/// continuation table. Returns true only when the bytes after the
/// backslash are clearly meant as an op continuation but the byte is
/// outside the union of [`ExprOp`] / [`AssignOp`] / [`UnaryOp`] tables
/// — covering the unknown-operator-byte case.
fn peek_unknown_binary_op_slot(state: &ParserState<'_>) -> bool {
    if state.current() != Some(EXPRESSION_BACKSLASH) {
        return false;
    }
    let Some(op_byte) = state.peek(1) else {
        return false;
    };
    // Exclude every documented table, including [`UnaryOp`]. A unary
    // byte (`0x00`/`0x01`) after a term is invalid grammar (unary forms
    // only open a term), but it is still a *known* op byte — not
    // [`ExpressionParseError::UnknownOperator`]. Leaving the `\` unconsumed
    // lets the arithmetic loop terminate without a false "unknown" label.
    ExprOp::from_byte(op_byte).is_none()
        && AssignOp::from_byte(op_byte).is_none()
        && UnaryOp::from_byte(op_byte).is_none()
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
        return Err(ParserState::malformed(
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
            Some(other) => Err(ParserState::malformed(
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
            // Unknown unary byte. Emulator: warn, consume `\` + byte,
            // return a 0 literal so the outer chain still has an
            // operand. Decompile: typed error. Position is the unknown
            // operator byte (not the backslash).
            let op_position = state.pos + 1;
            state.on_unknown_operator(op_byte, op_position)?;
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
        // Out-of-spec byte where a term was expected. Emulator: warn,
        // consume one byte, return it as a single-byte int-literal so
        // the chain can continue. Decompile: typed error.
        let offset = state.pos;
        state.on_unknown_operator(b0, offset)?;
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
        if let Some(BRACKET_OPEN) = state.peek(1) {
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
                Some(other) => Err(ParserState::malformed(
                    state.pos,
                    format!(
                        "token: memory-reference must close with ']' (0x5D); observed \
                         0x{other:02x}",
                    ),
                )),
                None => Err(state.truncated(1, "token: memory-reference missing closing ']'")),
            }
        } else {
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
#[path = "expression_tests.rs"]
mod tests;
