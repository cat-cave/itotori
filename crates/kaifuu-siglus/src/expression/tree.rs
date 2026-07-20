//! Typed Siglus expression tree + the clean-room operator tables.
//!
//! A Siglus scene's operand stream is a stack machine: `CD_PUSH` (`0x02`) pushes
//! literals / element codes, `CD_OPERATE_1` (`0x21`) applies a unary operator to
//! the top value, and `CD_OPERATE_2` (`0x22`) folds the top two values with a
//! binary operator. Evaluating the stream (see [`super::eval`]) reconstructs a
//! [`SiglusExpr`] tree for every value the program builds.
//!
//! # Clean-room operator tables
//! The operator-byte → operator mappings below are **re-derived** from the public
//! Siglus bytecode documentation and **re-validated against real title bytes**
//! (the operator histogram in the real-bytes proof). They are encoded here as a
//! Rust datum — no reference project's source is copied, vendored, or
//! mechanically translated (see [`crate::SIGLUS_RS_RESEARCH_ANCHOR_BOUNDARY_STATEMENT`]).
//! An operator byte outside the derived tables is **not** guessed and **not**
//! skipped: it becomes a typed [`SiglusExpr::UnsupportedOperator`] diagnostic
//! carrying the raw byte, so any gap is loud and located.

/// A fully-typed Siglus operand-stack expression.
///
/// Every node is a value the stack machine can produce. Leaf literals carry
/// `int` values and `str` **table indices** (never the raw copyrighted text);
/// interior nodes carry re-derived operators; element chains and calls carry
/// their typed structure. Two diagnostic leaves —
/// [`Self::StackUnderflow`] and [`Self::UnsupportedOperator`] — keep the decode
/// total and panic-free without ever silently dropping a value.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum SiglusExpr {
    /// An `int`-form literal (`CD_PUSH` form `10`).
    Int(i32),
    /// A `str`-form literal (`CD_PUSH` form `20`); carries the string-table
    /// **index**, never the string bytes.
    Str {
        /// Index into the scene's interned string table.
        index: i32,
    },
    /// A `CD_PUSH` of some other form that carries no inline value word.
    PushForm {
        /// The raw form code.
        form: i32,
    },
    /// A unary operator applied to one operand (`CD_OPERATE_1`).
    Unary {
        /// The re-derived unary operator.
        op: SiglusUnaryOp,
        /// The single operand subtree.
        operand: Box<SiglusExpr>,
    },
    /// A binary operator applied to two operands (`CD_OPERATE_2`).
    Binary {
        /// The re-derived binary operator.
        op: SiglusBinaryOp,
        /// Left-hand operand subtree (pushed first).
        lhs: Box<SiglusExpr>,
        /// Right-hand operand subtree (pushed second).
        rhs: Box<SiglusExpr>,
    },
    /// An element / variable reference chain closed by `CD_PROPERTY` (or
    /// consumed by a command / assignment): a typed head plus zero or more
    /// member / index accessors, built from the pushed element codes.
    Element {
        /// The decoded chain head (system slot, global/local var, function, …).
        head: SiglusElementHead,
        /// The remaining pushed accessor subtrees, in stream order.
        tail: Vec<SiglusExpr>,
    },
    /// A subroutine call (`CD_GOSUB` / `CD_GOSUBSTR`).
    Gosub {
        /// Target label index.
        label: i32,
        /// Argument subtrees (already popped from the stack).
        args: Vec<SiglusExpr>,
        /// Whether this is the `str`-returning gosub variant.
        returns_str: bool,
    },
    /// A command-element invocation (`CD_COMMAND`) that yields a value.
    Command {
        /// The command's argument-list id.
        arg_list_id: i32,
        /// Argument subtrees.
        args: Vec<SiglusExpr>,
        /// The command target element chain.
        target: Box<SiglusExpr>,
        /// The command's declared return form.
        ret_form: i32,
    },
    /// A typed diagnostic: an operator / consumer needed an operand the linear
    /// evaluation did not have (its producer lives on another control-flow
    /// path). Never a panic, never a dropped value.
    StackUnderflow,
    /// A typed diagnostic: an operator byte outside the re-derived tables.
    /// Carries the raw byte and arity so the gap is loud and located.
    UnsupportedOperator {
        /// The raw operator byte.
        op: u8,
        /// `1` for a `CD_OPERATE_1` byte, `2` for `CD_OPERATE_2`.
        arity: u8,
    },
}

/// The decoded head of an element / variable reference chain.
///
/// The first pushed `int` of a chain packs a kind tag in its top byte and an
/// index in its low 24 bits (`kind = value >> 24`, `index = value & 0x00FF_FFFF`).
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum SiglusElementHead {
    /// A system / global-namespace slot (`kind == 0x00`).
    System {
        /// The slot index.
        index: i32,
    },
    /// A function reference (`kind == 0x7E`).
    Function {
        /// The function index.
        index: i32,
    },
    /// A global variable reference (`kind == 0x7F`).
    GlobalVar {
        /// The global variable index.
        index: i32,
    },
    /// A chain head that was not a plain `int` literal (e.g. an operator
    /// result). Carries the raw head subtree boxed.
    Computed(Box<SiglusExpr>),
    /// A packed `int` head whose kind tag is outside the derived set. Carries
    /// the raw packed value so nothing is silently normalised away.
    Raw {
        /// The raw packed `int`.
        value: i32,
    },
}

impl SiglusElementHead {
    /// Decode a chain head from its (already-typed) head subtree.
    pub fn from_expr(head: SiglusExpr) -> Self {
        if let SiglusExpr::Int(value) = head {
            let kind = (value >> 24) & 0xFF;
            let index = value & 0x00FF_FFFF;
            match kind {
                0x00 => SiglusElementHead::System { index },
                0x7E => SiglusElementHead::Function { index },
                0x7F => SiglusElementHead::GlobalVar { index },
                _ => SiglusElementHead::Raw { value },
            }
        } else {
            SiglusElementHead::Computed(Box::new(head))
        }
    }
}

/// A re-derived Siglus unary operator (`CD_OPERATE_1` operator byte).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SiglusUnaryOp {
    /// `0x01` — unary plus (identity).
    Plus,
    /// `0x02` — arithmetic negation.
    Negate,
    /// `0x30` — bitwise complement.
    BitNot,
}

impl SiglusUnaryOp {
    /// Map a raw `CD_OPERATE_1` operator byte to a unary operator, or `None`
    /// for a byte outside the re-derived table.
    pub fn from_byte(op: u8) -> Option<Self> {
        Some(match op {
            0x01 => SiglusUnaryOp::Plus,
            0x02 => SiglusUnaryOp::Negate,
            0x30 => SiglusUnaryOp::BitNot,
            _ => return None,
        })
    }

    /// A stable, sanitized label for the operator histogram.
    pub fn label(self) -> &'static str {
        match self {
            SiglusUnaryOp::Plus => "u.plus",
            SiglusUnaryOp::Negate => "u.negate",
            SiglusUnaryOp::BitNot => "u.bitnot",
        }
    }
}

/// A re-derived Siglus binary operator (`CD_OPERATE_2` operator byte).
///
/// The same numeric operator space serves both `int` and `str` operands; the
/// operand forms recorded on the instruction select which subset is meaningful
/// (`str` uses only [`Self::Add`] as concatenation plus the equality pair).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum SiglusBinaryOp {
    /// `0x01` — addition / string concatenation.
    Add,
    /// `0x02` — subtraction.
    Sub,
    /// `0x03` — multiplication.
    Mul,
    /// `0x04` — division.
    Div,
    /// `0x05` — remainder / modulo.
    Mod,
    /// `0x10` — equality.
    Eq,
    /// `0x11` — inequality.
    Ne,
    /// `0x12` — greater-than.
    Gt,
    /// `0x13` — greater-or-equal.
    Ge,
    /// `0x14` — less-than.
    Lt,
    /// `0x15` — less-or-equal.
    Le,
    /// `0x20` — logical AND.
    LogicalAnd,
    /// `0x21` — logical OR.
    LogicalOr,
    /// `0x31` — bitwise AND.
    BitAnd,
    /// `0x32` — bitwise OR.
    BitOr,
    /// `0x33` — bitwise XOR.
    BitXor,
    /// `0x34` — left shift.
    Shl,
    /// `0x35` — arithmetic right shift.
    Shr,
    /// `0x36` — unsigned (logical) right shift.
    UShr,
}

impl SiglusBinaryOp {
    /// Map a raw `CD_OPERATE_2` operator byte to a binary operator, or `None`
    /// for a byte outside the re-derived table.
    pub fn from_byte(op: u8) -> Option<Self> {
        Some(match op {
            0x01 => SiglusBinaryOp::Add,
            0x02 => SiglusBinaryOp::Sub,
            0x03 => SiglusBinaryOp::Mul,
            0x04 => SiglusBinaryOp::Div,
            0x05 => SiglusBinaryOp::Mod,
            0x10 => SiglusBinaryOp::Eq,
            0x11 => SiglusBinaryOp::Ne,
            0x12 => SiglusBinaryOp::Gt,
            0x13 => SiglusBinaryOp::Ge,
            0x14 => SiglusBinaryOp::Lt,
            0x15 => SiglusBinaryOp::Le,
            0x20 => SiglusBinaryOp::LogicalAnd,
            0x21 => SiglusBinaryOp::LogicalOr,
            0x31 => SiglusBinaryOp::BitAnd,
            0x32 => SiglusBinaryOp::BitOr,
            0x33 => SiglusBinaryOp::BitXor,
            0x34 => SiglusBinaryOp::Shl,
            0x35 => SiglusBinaryOp::Shr,
            0x36 => SiglusBinaryOp::UShr,
            _ => return None,
        })
    }

    /// A stable, sanitized label for the operator histogram.
    pub fn label(self) -> &'static str {
        match self {
            SiglusBinaryOp::Add => "b.add",
            SiglusBinaryOp::Sub => "b.sub",
            SiglusBinaryOp::Mul => "b.mul",
            SiglusBinaryOp::Div => "b.div",
            SiglusBinaryOp::Mod => "b.mod",
            SiglusBinaryOp::Eq => "b.eq",
            SiglusBinaryOp::Ne => "b.ne",
            SiglusBinaryOp::Gt => "b.gt",
            SiglusBinaryOp::Ge => "b.ge",
            SiglusBinaryOp::Lt => "b.lt",
            SiglusBinaryOp::Le => "b.le",
            SiglusBinaryOp::LogicalAnd => "b.and",
            SiglusBinaryOp::LogicalOr => "b.or",
            SiglusBinaryOp::BitAnd => "b.bitand",
            SiglusBinaryOp::BitOr => "b.bitor",
            SiglusBinaryOp::BitXor => "b.bitxor",
            SiglusBinaryOp::Shl => "b.shl",
            SiglusBinaryOp::Shr => "b.shr",
            SiglusBinaryOp::UShr => "b.ushr",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unary_table_is_total_over_known_bytes_and_typed_elsewhere() {
        assert_eq!(SiglusUnaryOp::from_byte(0x01), Some(SiglusUnaryOp::Plus));
        assert_eq!(SiglusUnaryOp::from_byte(0x02), Some(SiglusUnaryOp::Negate));
        assert_eq!(SiglusUnaryOp::from_byte(0x30), Some(SiglusUnaryOp::BitNot));
        assert_eq!(SiglusUnaryOp::from_byte(0x99), None);
    }

    #[test]
    fn binary_table_covers_the_full_derived_range() {
        for byte in [
            0x01u8, 0x02, 0x03, 0x04, 0x05, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x20, 0x21, 0x31,
            0x32, 0x33, 0x34, 0x35, 0x36,
        ] {
            assert!(
                SiglusBinaryOp::from_byte(byte).is_some(),
                "byte {byte:#04x} must map"
            );
        }
        // A byte between the arithmetic and comparison clusters is unmapped.
        assert_eq!(SiglusBinaryOp::from_byte(0x06), None);
        assert_eq!(SiglusBinaryOp::from_byte(0x16), None);
    }

    #[test]
    fn element_head_decodes_kind_tag_in_top_byte() {
        assert_eq!(
            SiglusElementHead::from_expr(SiglusExpr::Int(0x0000_0053)),
            SiglusElementHead::System { index: 0x53 }
        );
        assert_eq!(
            SiglusElementHead::from_expr(SiglusExpr::Int(0x7F00_0004u32 as i32)),
            SiglusElementHead::GlobalVar { index: 4 }
        );
        assert_eq!(
            SiglusElementHead::from_expr(SiglusExpr::Int(0x7E00_0009u32 as i32)),
            SiglusElementHead::Function { index: 9 }
        );
        // A non-int head is preserved verbatim as a computed head.
        assert!(matches!(
            SiglusElementHead::from_expr(SiglusExpr::StackUnderflow),
            SiglusElementHead::Computed(_)
        ));
    }
}
