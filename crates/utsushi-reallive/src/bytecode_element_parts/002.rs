

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
/// which desynced on real observed scene 2 (an expression element whose
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
/// contained data item — across the observed and Kanon archives that
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
