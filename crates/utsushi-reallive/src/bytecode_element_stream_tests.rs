use super::*;

#[test]
fn goto_case_captures_per_case_match_expressions_and_targets() {
    // `goto_case` (module_jmp opcode 4), argc=2:
    //   header + (disc=$FF<5>) + { ($FF<5>) @100 () @200 }
    // The decoder must record BOTH case match expressions (the second is
    // the empty default `()`) alongside their two jump targets.
    let mut raw = vec![0x23, 0x00, 0x01, 0x04, 0x00, 0x02, 0x00, 0x00];
    // discriminant (disc)
    raw.push(b'(');
    raw.extend_from_slice(&[0x24, 0xFF]);
    raw.extend_from_slice(&5_i32.to_le_bytes());
    raw.push(b')');
    // { block
    raw.push(0x7B);
    // case 0: ($FF<5>) then target 100
    raw.push(b'(');
    raw.extend_from_slice(&[0x24, 0xFF]);
    raw.extend_from_slice(&5_i32.to_le_bytes());
    raw.push(b')');
    raw.extend_from_slice(&100_u32.to_le_bytes());
    // case 1 (default): () then target 200
    raw.push(b'(');
    raw.push(b')');
    raw.extend_from_slice(&200_u32.to_le_bytes());
    // } block close
    raw.push(0x7D);

    let element = decode_one_element(&raw, 0).expect("goto_case decodes");
    match element {
        BytecodeElement::Command {
            goto_targets,
            goto_case_exprs,
            byte_len,
            ..
        } => {
            assert_eq!(byte_len, raw.len(), "goto_case must consume every byte");
            assert_eq!(goto_targets, vec![100, 200]);
            assert_eq!(goto_case_exprs.len(), 2);
            // Case 0's match expression is the `$FF<5>` literal bytes.
            let mut expected = vec![0x24u8, 0xFF];
            expected.extend_from_slice(&5_i32.to_le_bytes());
            assert_eq!(goto_case_exprs[0], expected);
            // Case 1 is the default `()` — an empty match expression.
            assert!(goto_case_exprs[1].is_empty());
        }
        other => panic!("expected Command, got {other:?}"),
    }
}

#[test]
fn empty_input_is_truncated_not_zero_state() {
    match decode_bytecode_stream(&[]) {
        Err(BytecodeDecodeError::Truncated { observed_len, .. }) => {
            assert_eq!(observed_len, 0);
        }
        other => panic!("expected Truncated on empty input, got: {other:?}"),
    }
}

#[test]
fn comma_lead_zero_decodes_as_single_byte_comma() {
    let bytes = [0x00u8];
    let elements = decode_bytecode_stream(&bytes).expect("comma lead 0x00 must decode");
    assert_eq!(elements.len(), 1);
    match &elements[0] {
        BytecodeElement::Comma {
            lead_byte,
            byte_offset,
            byte_len,
        } => {
            assert_eq!(*lead_byte, 0x00);
            assert_eq!(*byte_offset, 0);
            assert_eq!(*byte_len, 1);
        }
        other => panic!("expected Comma, got {other:?}"),
    }
}

#[test]
fn comma_lead_2c_decodes_as_single_byte_comma() {
    let bytes = [0x2cu8];
    let elements = decode_bytecode_stream(&bytes).expect("comma lead 0x2C must decode");
    match &elements[0] {
        BytecodeElement::Comma { lead_byte, .. } => assert_eq!(*lead_byte, 0x2c),
        other => panic!("expected Comma, got {other:?}"),
    }
}

#[test]
fn meta_line_decodes_with_u16_le_payload() {
    let bytes = [0x0a, 0x02, 0x00];
    let elements = decode_bytecode_stream(&bytes).expect("meta_line must decode");
    assert_eq!(elements.len(), 1);
    match &elements[0] {
        BytecodeElement::MetaLine {
            line_number,
            byte_len,
            byte_offset,
        } => {
            assert_eq!(*line_number, 2);
            assert_eq!(*byte_len, 3);
            assert_eq!(*byte_offset, 0);
        }
        other => panic!("expected MetaLine, got {other:?}"),
    }
}

#[test]
fn meta_entrypoint_decodes_with_u16_le_payload() {
    let bytes = [0x21, 0x07, 0x00];
    let elements = decode_bytecode_stream(&bytes).expect("meta_entrypoint must decode");
    match &elements[0] {
        BytecodeElement::MetaEntrypoint {
            entrypoint_index, ..
        } => assert_eq!(*entrypoint_index, 7),
        other => panic!("expected MetaEntrypoint, got {other:?}"),
    }
}

#[test]
fn meta_kidoku_decodes_with_u16_le_payload() {
    let bytes = [0x40, 0xff, 0x01];
    let elements = decode_bytecode_stream(&bytes).expect("meta_kidoku must decode");
    match &elements[0] {
        BytecodeElement::MetaKidoku { kidoku_id, .. } => assert_eq!(*kidoku_id, 0x01ff),
        other => panic!("expected MetaKidoku, got {other:?}"),
    }
}

#[test]
fn command_with_zero_args_consumes_exactly_eight_bytes() {
    // 0x23, module_type=1, module_id=5, opcode=120 (0x78 LE), argc=0, ovl=0, reserved=0
    let bytes = [0x23, 0x01, 0x05, 0x78, 0x00, 0x00, 0x00, 0x00];
    let elements = decode_bytecode_stream(&bytes).expect("zero-arg command must decode");
    assert_eq!(elements.len(), 1);
    match &elements[0] {
        BytecodeElement::Command {
            module_type,
            module_id,
            opcode,
            arg_count,
            overload,
            raw_bytes,
            byte_len,
            ..
        } => {
            assert_eq!(*module_type, 1);
            assert_eq!(*module_id, 5);
            assert_eq!(*opcode, 120);
            assert_eq!(*arg_count, 0);
            assert_eq!(*overload, 0);
            assert_eq!(*byte_len, 8);
            assert_eq!(raw_bytes, &bytes);
        }
        other => panic!("expected Command, got {other:?}"),
    }
}

#[test]
fn command_with_one_int_literal_arg_walks_paren_list() {
    // Header: 0x23 01 05 78 00 01 00 00 (argc=1)
    // Arg list: '(' '$' 0xFF 05 00 00 00 ')'
    // The `$` prefix is required: NextToken expects a `$` lead
    // before the int-constant marker 0xFF.
    let bytes = [
        0x23, 0x01, 0x05, 0x78, 0x00, 0x01, 0x00, 0x00, b'(', b'$', 0xFF, 0x05, 0x00, 0x00, 0x00,
        b')',
    ];
    let elements = decode_bytecode_stream(&bytes).expect("one-arg command must decode");
    assert_eq!(elements.len(), 1);
    match &elements[0] {
        BytecodeElement::Command {
            arg_count,
            byte_len,
            raw_bytes,
            ..
        } => {
            assert_eq!(*arg_count, 1);
            assert_eq!(*byte_len, bytes.len());
            assert_eq!(raw_bytes.as_slice(), &bytes[..]);
        }
        other => panic!("expected Command, got {other:?}"),
    }
}

#[test]
fn standalone_expression_decodes_with_full_raw_bytes() {
    // ExpressionElement is shaped like an assignment:
    // <dest_term> \<assign_op> <source_expression>.
    //
    // Synthetic: dest = $B[$0] (memory ref into bank 0x42 with
    // index = int-literal 0). source = $0 (int-literal 0).
    // assign_op = 0x14 (`+=`).
    //
    // Bytes:
    //   0x24 0x42 0x5b 0x24 0xff 0x00 0x00 0x00 0x00 0x5d -- $B[$0]
    //   0x5c 0x14 -- `\` `+=`
    //   0x24 0xff 0x00 0x00 0x00 0x00 -- $0
    let bytes = [
        0x24, 0x42, 0x5b, 0x24, 0xff, 0x00, 0x00, 0x00, 0x00, 0x5d, 0x5c, 0x14, 0x24, 0xff, 0x00,
        0x00, 0x00, 0x00,
    ];
    let elements = decode_bytecode_stream(&bytes).expect("expression must decode");
    assert_eq!(elements.len(), 1);
    match &elements[0] {
        BytecodeElement::Expression {
            raw_bytes,
            byte_len,
            ..
        } => {
            assert_eq!(*byte_len, bytes.len());
            assert_eq!(raw_bytes.as_slice(), &bytes[..]);
        }
        other => panic!("expected Expression, got {other:?}"),
    }
}

#[test]
fn selection_option_marker_is_recognised_distinct_from_textout() {
    for marker in SELECTION_OPTION_MARKER_MIN..=SELECTION_OPTION_MARKER_MAX {
        let bytes = [marker];
        let elements = decode_bytecode_stream(&bytes).expect("selection-option marker must decode");
        assert_eq!(elements.len(), 1);
        match &elements[0] {
            BytecodeElement::SelectionOption {
                marker: observed,
                raw_bytes,
                byte_len,
                ..
            } => {
                assert_eq!(*observed, marker);
                assert_eq!(*byte_len, 1);
                assert_eq!(raw_bytes.as_slice(), &[marker]);
            }
            other => panic!("expected SelectionOption for 0x{marker:02x}, got {other:?}"),
        }
    }
}

#[test]
fn shift_jis_textout_consumes_lead_trail_pair_atomically() {
    // Shift-JIS pair: 0x82 0xA0 (`あ`). The trail byte 0xA0 is not
    // a structural opener; the run continues to absorb until
    // structural lead. Append 0x0A (MetaLine) to terminate.
    let bytes = [0x82, 0xA0, 0x0a, 0x02, 0x00];
    let elements = decode_bytecode_stream(&bytes).expect("textout + meta must decode");
    assert_eq!(elements.len(), 2);
    match &elements[0] {
        BytecodeElement::Textout {
            encoding_hint,
            raw_bytes,
            byte_len,
            ..
        } => {
            assert_eq!(*encoding_hint, TextoutEncoding::ShiftJis);
            assert_eq!(*byte_len, 2);
            assert_eq!(raw_bytes.as_slice(), &[0x82, 0xA0]);
        }
        other => panic!("expected Textout, got {other:?}"),
    }
    match &elements[1] {
        BytecodeElement::MetaLine { line_number, .. } => assert_eq!(*line_number, 2),
        other => panic!("expected MetaLine, got {other:?}"),
    }
}

#[test]
fn shift_jis_lead_followed_by_kidoku_byte_does_not_split_pair() {
    // 0x82 (SJIS lead) followed by 0x40 (would-be MetaKidoku).
    // The pair must be consumed atomically, NOT split as
    // `Textout(0x82) + MetaKidoku(0x40...)`.
    let bytes = [0x82, 0x40, 0x0a, 0x05, 0x00];
    let elements = decode_bytecode_stream(&bytes).expect("must decode");
    assert_eq!(elements.len(), 2);
    match &elements[0] {
        BytecodeElement::Textout {
            raw_bytes,
            encoding_hint,
            ..
        } => {
            assert_eq!(raw_bytes.as_slice(), &[0x82, 0x40]);
            assert_eq!(*encoding_hint, TextoutEncoding::ShiftJis);
        }
        other => panic!("expected Textout, got {other:?}"),
    }
    match &elements[1] {
        BytecodeElement::MetaLine { line_number, .. } => assert_eq!(*line_number, 5),
        other => panic!("expected MetaLine, got {other:?}"),
    }
}

#[test]
fn other_textout_encoding_is_emitted_for_non_sjis_lead() {
    // 0x7E ('~') is not in the SJIS-lead range and not a
    // structural opener.
    let bytes = [0x7e, 0x7e, 0x0a, 0x02, 0x00];
    let elements = decode_bytecode_stream(&bytes).expect("must decode");
    assert_eq!(elements.len(), 2);
    match &elements[0] {
        BytecodeElement::Textout { encoding_hint, .. } => {
            assert_eq!(*encoding_hint, TextoutEncoding::Other);
        }
        other => panic!("expected Textout, got {other:?}"),
    }
}

#[test]
fn truncated_meta_line_returns_truncated_error() {
    let bytes = [0x0a, 0x02]; // missing high byte
    match decode_bytecode_stream(&bytes) {
        Err(BytecodeDecodeError::Truncated { .. }) => {}
        other => panic!("expected Truncated, got {other:?}"),
    }
}

#[test]
fn truncated_command_header_returns_truncated_error() {
    let bytes = [0x23, 0x01, 0x05, 0x78]; // header cut at byte 4
    match decode_bytecode_stream(&bytes) {
        Err(BytecodeDecodeError::Truncated { .. }) => {}
        other => panic!("expected Truncated, got {other:?}"),
    }
}

#[test]
fn truncated_expression_body_returns_truncated_error() {
    // ExpressionElement is `<term> \<assign_op> <expression>`.
    // Here the dest term ($ ff <i32>) is itself truncated.
    let bytes = [0x24, 0xff, 0x01]; // $ ff <i32> needs 4 trailing literal bytes
    match decode_bytecode_stream(&bytes) {
        Err(BytecodeDecodeError::Truncated { .. }) => {}
        other => panic!("expected Truncated, got {other:?}"),
    }
}

#[test]
fn partition_mismatch_is_detected_on_forged_offsets() {
    // The decoder's own output always partitions correctly. We
    // exercise the partition checker directly with a hand-rolled
    // element whose `byte_offset` is wrong relative to the
    // accumulated total.
    let forged = vec![
        BytecodeElement::Comma {
            lead_byte: 0x00,
            byte_offset: 0,
            byte_len: 1,
        },
        BytecodeElement::Comma {
            lead_byte: 0x00,
            byte_offset: 5, // SHOULD be 1 — forged gap.
            byte_len: 1,
        },
    ];
    match verify_partition(6, &forged) {
        Err(BytecodeDecodeError::PartitionMismatch { .. }) => {}
        other => panic!("expected PartitionMismatch, got {other:?}"),
    }
}

#[test]
fn partition_mismatch_is_detected_when_sum_differs_from_input() {
    let forged = vec![BytecodeElement::Comma {
        lead_byte: 0x00,
        byte_offset: 0,
        byte_len: 1,
    }];
    // Claim input was 4 bytes but elements only cover 1.
    match verify_partition(4, &forged) {
        Err(BytecodeDecodeError::PartitionMismatch {
            input_len,
            sum_of_element_lengths,
            ..
        }) => {
            assert_eq!(input_len, 4);
            assert_eq!(sum_of_element_lengths, 1);
        }
        other => panic!("expected PartitionMismatch, got {other:?}"),
    }
}

#[test]
fn decode_round_trip_partitions_concatenated_synthetic_stream() {
    // Synthesise one element of each documented variant and
    // confirm they decode in order with no gaps and no overlaps.
    let mut bytes: Vec<u8> = Vec::new();
    // MetaLine(2)
    bytes.extend_from_slice(&[0x0a, 0x02, 0x00]);
    // MetaEntrypoint(0)
    bytes.extend_from_slice(&[0x21, 0x00, 0x00]);
    // MetaKidoku(7)
    bytes.extend_from_slice(&[0x40, 0x07, 0x00]);
    // Comma (0x00)
    bytes.push(0x00);
    // Comma (0x2C)
    bytes.push(0x2c);
    // Command argc=0 (no `(...)` body)
    bytes.extend_from_slice(&[0x23, 0x01, 0x05, 0x78, 0x00, 0x00, 0x00, 0x00]);
    // ExpressionElement: $B[$0] \+= $0
    //
    //   0x24 0x42 0x5b 0x24 0xff 00 00 00 00 0x5d -- dest $B[$0]
    //   0x5c 0x14 -- `\` `+=`
    //   0x24 0xff 00 00 00 00 -- source $0
    bytes.extend_from_slice(&[
        0x24, 0x42, 0x5b, 0x24, 0xff, 0x00, 0x00, 0x00, 0x00, 0x5d, 0x5c, 0x14, 0x24, 0xff, 0x00,
        0x00, 0x00, 0x00,
    ]);
    // SelectionOption 0x30
    bytes.push(0x30);
    // Textout (SJIS) 0x82 0xA0
    bytes.extend_from_slice(&[0x82, 0xA0]);
    // Trailing comma so textout absorber stops cleanly
    bytes.push(0x00);

    let elements = decode_bytecode_stream(&bytes).expect("synthetic stream must decode");
    assert_eq!(elements.len(), 10);
    assert!(matches!(elements[0], BytecodeElement::MetaLine { .. }));
    assert!(matches!(
        elements[1],
        BytecodeElement::MetaEntrypoint { .. }
    ));
    assert!(matches!(elements[2], BytecodeElement::MetaKidoku { .. }));
    assert!(matches!(elements[3], BytecodeElement::Comma { .. }));
    assert!(matches!(elements[4], BytecodeElement::Comma { .. }));
    assert!(matches!(elements[5], BytecodeElement::Command { .. }));
    assert!(matches!(elements[6], BytecodeElement::Expression { .. }));
    assert!(matches!(
        elements[7],
        BytecodeElement::SelectionOption { .. }
    ));
    assert!(matches!(elements[8], BytecodeElement::Textout { .. }));
    assert!(matches!(elements[9], BytecodeElement::Comma { .. }));

    // Partition: sum of byte_len == bytes.len().
    let sum: usize = elements.iter().map(BytecodeElement::byte_len).sum();
    assert_eq!(sum, bytes.len(), "partition invariant must hold");
}
