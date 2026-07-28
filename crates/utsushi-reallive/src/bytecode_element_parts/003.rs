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


