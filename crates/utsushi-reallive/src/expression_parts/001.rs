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
/// Bank byte for the `intF` bank (observed in a scene #0001
/// real-bytes Expression elements).
pub const BANK_BYTE_INT_F: u8 = 0x05;
/// Bank byte for the `intG` bank (observed in a scene #0001
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
    Add = 0x00,
    /// `-` — subtraction.
    Sub = 0x01,
    /// `*` — multiplication.
    Mul = 0x02,
    /// `/` — division (zero divisor → [`EvaluationError::DivisionByZero`]).
    Div = 0x03,
    /// `%` — modulo (zero divisor → [`EvaluationError::DivisionByZero`]).
    Mod = 0x04,
    /// `&` — bitwise and.
    And = 0x05,
    /// `|` — bitwise or.
    Or = 0x06,
    /// `^` — bitwise xor.
    Xor = 0x07,
    /// `<<` — left shift.
    Shl = 0x08,
    /// `>>` — arithmetic right shift.
    Shr = 0x09,
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
            0x00 => Self::Add,
            0x01 => Self::Sub,
            0x02 => Self::Mul,
            0x03 => Self::Div,
            0x04 => Self::Mod,
            0x05 => Self::And,
            0x06 => Self::Or,
            0x07 => Self::Xor,
            0x08 => Self::Shl,
            0x09 => Self::Shr,
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
