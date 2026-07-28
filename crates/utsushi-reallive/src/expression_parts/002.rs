

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
    let lhs = arithmetic::parse_arith(state)?;
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
        let rhs = arithmetic::parse_arith(state)?;
        return Ok(ExprNode::BinaryOp {
            op,
            lhs: Box::new(lhs),
            rhs: Box::new(rhs),
        });
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


