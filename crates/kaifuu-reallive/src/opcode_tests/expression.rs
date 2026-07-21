use super::*;

// The byte sequences below are SYNTHETIC: they reproduce the structural
// forms the full-archive reconstruction exposed (integer/string
// bank references, store register, array index, complex / special params,
// bracket-leading quoted strings) WITHOUT embedding any copyrighted game
// text — every string operand here is an ASCII placeholder.

#[test]
fn integer_bank_reference_dollar_prefixed_with_array_index() {
    // `$ 0x02 [ 0x000C ]` — an `intC[12]` bank reference (the `0x42 'B'` /
    // `0x43 'C'` recon class is the *bareword* form; the canonical numeric
    // bank reference rlvm emits is `$ <bank> [ <index> ]`).
    let bytes = [
        EXPR_DOLLAR,
        0x02, // bank selector
        EXPR_INDEX_OPEN,
        EXPR_INT_LITERAL,
        0x0C,
        0x00,
        0x00,
        0x00,
        EXPR_INDEX_CLOSE,
    ];
    let (expr, len) = parse_expression(&bytes, 0).expect("memory ref must parse");
    assert_eq!(len, bytes.len());
    assert!(matches!(
        expr,
        Expr::MemoryRef { bank: 0x02, ref index }
            if matches!(**index, Expr::IntLiteral { value: 12 })
    ));
}

#[test]
fn dollar_prefixed_store_register_is_two_bytes() {
    // `$ 0xC8` — the `$`-typed store-register RHS idiom (`intX[i] = store`).
    // Must consume exactly 2 bytes and NOT be misread as `$ <bank=0xC8> [`.
    let (expr, len) =
        parse_expression(&[EXPR_DOLLAR, EXPR_STORE_REGISTER, 0x0A], 0).expect("$store must parse");
    assert_eq!(len, 2, "$ + 0xC8 store register is two bytes");
    assert!(matches!(expr, Expr::StoreRegister));
}

#[test]
fn deeply_nested_memory_refs_return_malformed_instead_of_overflowing() {
    // Each `$bank[ ... ]` recursively re-enters the expression decoder.
    // The full bytecode-stream boundary must surface the existing typed
    // malformed-expression error once the shared 256-level limit is
    // exceeded, not unwind into an uncatchable stack overflow.
    let depth = MAX_EXPRESSION_DEPTH + 50;
    let mut bytes = Vec::with_capacity(depth * 4 + 6);
    for _ in 0..depth {
        bytes.extend_from_slice(&[EXPR_DOLLAR, 0x01, EXPR_INDEX_OPEN]);
    }
    bytes.extend_from_slice(&[EXPR_DOLLAR, EXPR_INT_LITERAL, 0, 0, 0, 0]);
    bytes.extend(std::iter::repeat_n(EXPR_INDEX_CLOSE, depth));

    let err =
        parse_real_bytecode(&bytes).expect_err("over-deep expression bytecode must be rejected");
    assert!(matches!(
        err,
        RealLiveParseError::MalformedExpression { .. }
    ));
}

#[test]
fn bracket_leading_quoted_string_arg_is_not_misread_as_bank_reference() {
    // `("[X]")` — a quoted string whose first content byte is `[`. The
    // old "any byte followed by `[`" heuristic misread the opening `"` as
    // a memory-bank reference and failed on the next byte (the prior reconstruction
    // class). A real bank reference is always
    // `$`-prefixed, so the quoted string is consumed whole.
    let bytes = [
        EXPR_PAREN_OPEN,
        b'"',
        b'[',
        b'X',
        b']',
        b'"',
        EXPR_PAREN_CLOSE,
    ];
    let (args, consumed) = parse_arg_list(&bytes, 0).expect("quoted `[`-string must parse");
    assert_eq!(consumed, bytes.len());
    assert_eq!(args.len(), 1);
    assert_eq!(args[0].bytes, b"\"[X]\"".to_vec());
}

#[test]
fn bareword_string_then_int_then_special_param_in_arg_list() {
    // `("BG" $0 0x61 0x01 ("FG" $0))` — the `0x42 'B'` reconstruction
    // class: a bareword asset-id string, an int literal, and a special
    // parameter (tag 0x01) wrapping a complex group with its own bareword.
    // Every byte must partition with zero residual.
    let bytes = [
        EXPR_PAREN_OPEN, // (
        b'B',
        b'G', // bareword "BG"
        EXPR_DOLLAR,
        EXPR_INT_LITERAL,
        0,
        0,
        0,
        0, // $0
        EXPR_SPECIAL,
        0x01,            // special param, tag 0x01
        EXPR_PAREN_OPEN, // (  complex
        b'F',
        b'G', // bareword "FG"
        EXPR_DOLLAR,
        EXPR_INT_LITERAL,
        0,
        0,
        0,
        0,                // $0
        EXPR_PAREN_CLOSE, // )  complex
        EXPR_PAREN_CLOSE, // )
    ];
    let (args, consumed) = parse_arg_list(&bytes, 0).expect("special-param arg must parse");
    assert_eq!(consumed, bytes.len(), "whole arg list consumed");
    // One un-split slot (no top-level comma): bareword + int + special.
    assert_eq!(args.len(), 1);
    assert_eq!(args[0].bytes, bytes[1..bytes.len() - 1].to_vec());
}

#[test]
fn special_param_with_memory_ref_content_no_complex_wrapper() {
    // `0x61 0x00 $0x06[7]` — a special parameter (tag 0x00) whose content
    // is a `$`-memory reference directly (no `` wrapper). The observed
    // `objBgMulti`-class `0x61 0x00 $…` form: it must be recognised as a
    // special parameter, not a bare string ending at the `0x00` delimiter.
    let bytes = [
        EXPR_SPECIAL,
        0x00, // tag
        EXPR_DOLLAR,
        0x06,
        EXPR_INDEX_OPEN,
        EXPR_INT_LITERAL,
        0x07,
        0x00,
        0x00,
        0x00,
        EXPR_INDEX_CLOSE,
    ];
    let (expr, len) = parse_data(&bytes, 0, 0).expect("special-with-memref must parse");
    assert_eq!(len, bytes.len());
    match expr {
        Expr::SpecialParam { tag: 0, content } => {
            assert!(matches!(
                *content,
                Expr::MemoryRef { bank: 0x06, ref index }
                    if matches!(**index, Expr::IntLiteral { value: 7 })
            ));
        }
        other => panic!("expected SpecialParam{{tag:0}}, got {other:?}"),
    }
}

#[test]
fn leading_0x61_string_is_not_misread_as_special_param() {
    // A bare string that merely begins with `0x61` (`'a'`) — e.g. a
    // `select` option "ab" — is NOT a special parameter: the byte after
    // the would-be tag is a string byte / delimiter, never a complex /
    // expression lead. The synthetic Choice pin depends on this.
    assert!(!is_special_param_lead(&[EXPR_SPECIAL, b'b', b','], 0));
    assert!(is_special_param_lead(
        &[EXPR_SPECIAL, 0x01, EXPR_PAREN_OPEN],
        0
    ));
}

#[test]
fn complex_param_is_a_sequence_of_data_items_not_a_single_expression() {
    // `($0 $0 $1 $0x02[0])` — a complex parameter is a back-to-back
    // sequence of data items (rlvm `ComplexExpressionPiece`), NOT a single
    // operator-chained expression. The old parenthesised-expression path
    // stopped at the second item and failed on the `$` (the `0x24`
    // recon class).
    let bytes = [
        EXPR_PAREN_OPEN,
        EXPR_DOLLAR,
        EXPR_INT_LITERAL,
        0,
        0,
        0,
        0, // $0
        EXPR_DOLLAR,
        EXPR_INT_LITERAL,
        0,
        0,
        0,
        0, // $0
        EXPR_DOLLAR,
        EXPR_INT_LITERAL,
        1,
        0,
        0,
        0, // $1
        EXPR_DOLLAR,
        0x02,
        EXPR_INDEX_OPEN,
        EXPR_INT_LITERAL,
        0,
        0,
        0,
        0,
        EXPR_INDEX_CLOSE, // $intC[0]
        EXPR_PAREN_CLOSE,
    ];
    let (expr, len) = parse_data(&bytes, 0, 0).expect("complex param must parse");
    assert_eq!(len, bytes.len());
    match expr {
        Expr::Complex { items } => assert_eq!(items.len(), 4, "four data items"),
        other => panic!("expected Complex, got {other:?}"),
    }
}

#[test]
fn bare_token_without_dollar_prefix_is_malformed_not_a_bank_reference() {
    // A bank reference is ONLY `$`-prefixed. A bare `0x02 [ … ]` (no `$`)
    // is not a valid arithmetic token — the evaluator must surface a typed
    // MalformedExpression rather than silently inventing a reference.
    let err = parse_token(&[0x02, EXPR_INDEX_OPEN, EXPR_INT_LITERAL, 0, 0, 0, 0], 0, 0)
        .expect_err("bare bank byte must be malformed");
    assert!(matches!(
        err,
        RealLiveParseError::MalformedExpression { byte: 0x02, .. }
    ));
}
