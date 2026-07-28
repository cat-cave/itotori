/// Verify the per-element byte ranges partition `input_len` bytes
/// exactly. Returns [`BytecodeDecodeError::PartitionMismatch`] on any
/// gap, overlap, or sum mismatch.
fn verify_partition(
    input_len: usize,
    elements: &[BytecodeElement],
) -> Result<(), BytecodeDecodeError> {
    let mut expected = 0usize;
    let mut sum = 0usize;
    for (idx, element) in elements.iter().enumerate() {
        let offset = element.byte_offset();
        let len = element.byte_len();
        if offset != expected {
            return Err(BytecodeDecodeError::PartitionMismatch {
                input_len,
                sum_of_element_lengths: sum,
                message: format!(
                    "element {idx} ({}) expects byte_offset={expected} but reports \
                     byte_offset={offset}",
                    element.variant_name(),
                ),
            });
        }
        sum = sum
            .checked_add(len)
            .ok_or_else(|| BytecodeDecodeError::PartitionMismatch {
                input_len,
                sum_of_element_lengths: sum,
                message: format!(
                    "element {idx} byte_len addition overflowed usize during partition check",
                ),
            })?;
        expected =
            expected
                .checked_add(len)
                .ok_or_else(|| BytecodeDecodeError::PartitionMismatch {
                    input_len,
                    sum_of_element_lengths: sum,
                    message: format!(
                        "element {idx} offset progression overflowed usize during partition check",
                    ),
                })?;
    }
    if sum != input_len {
        return Err(BytecodeDecodeError::PartitionMismatch {
            input_len,
            sum_of_element_lengths: sum,
            message: format!(
                "sum of element byte_len values ({sum}) does not match input length ({input_len})",
            ),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_data_long_comma_run_surfaces_typed_error_not_stack_overflow() {
        // Regression (audit-3): `next_data` used to recurse once per `,`
        // separator (`1 + next_data(pos + 1)`), so a long run of commas
        // over attacker-controllable decompressed bytecode drove one
        // stack frame per comma and overflowed the process stack. The
        // iterative separator-skip must instead consume the whole run in
        // O(1) stack and surface a typed `Truncated` error when the input
        // exhausts mid-separator-run.
        let bytes = vec![b','; 500_000];
        match next_data(&bytes, 0, 0) {
            Err(BytecodeDecodeError::Truncated { .. }) => {}
            other => panic!("expected Truncated on an all-comma buffer, got {other:?}"),
        }
    }

    #[test]
    fn next_data_long_metaline_run_surfaces_typed_error_not_stack_overflow() {
        // Companion to the comma case: embedded `\n` MetaLine markers
        // (3 bytes each) also used to recurse per marker. A long run of
        // complete markers followed by exhaustion must surface a typed
        // error rather than overflow.
        let mut bytes = Vec::new();
        for _ in 0..200_000 {
            bytes.extend_from_slice(&[META_LINE_LEAD_BYTE, 0x00, 0x00]);
        }
        match next_data(&bytes, 0, 0) {
            Err(BytecodeDecodeError::Truncated { .. }) => {}
            other => panic!("expected Truncated on an all-metaline buffer, got {other:?}"),
        }
    }

    #[test]
    fn deeply_nested_memory_refs_return_malformed_instead_of_overflowing() {
        // Each `$bank[ ... ]` recursively re-enters the expression length
        // walker. Decode at the public stream boundary so the regression
        // proves hostile bytecode produces a typed error, never a stack abort.
        let depth = MAX_EXPRESSION_DEPTH + 50;
        let mut bytes = Vec::with_capacity(depth * 4 + 6);
        for _ in 0..depth {
            bytes.extend_from_slice(&[b'$', 0x01, b'[']);
        }
        bytes.extend_from_slice(&[b'$', 0xFF, 0, 0, 0, 0]);
        bytes.extend(std::iter::repeat_n(b']', depth));

        let err = decode_bytecode_stream(&bytes)
            .expect_err("over-deep expression bytecode must be rejected");
        assert!(matches!(err, BytecodeDecodeError::MalformedElement { .. }));
    }

    #[test]
    fn decode_command_arg_values_splits_comma_separated_int_args() {
        // `goto`-shaped header (module 0/1, opcode 0) with a 2-int arg
        // list: `( $FF<7>, $FF<9> )`. The value extractor must return
        // two Expression-shaped args carrying the literal bytes.
        let mut raw = vec![0x23, 0x00, 0x01, 0x00, 0x00, 0x02, 0x00, 0x00, b'('];
        raw.extend_from_slice(&[0x24, 0xFF]);
        raw.extend_from_slice(&7_i32.to_le_bytes());
        raw.push(b',');
        raw.extend_from_slice(&[0x24, 0xFF]);
        raw.extend_from_slice(&9_i32.to_le_bytes());
        raw.push(b')');

        let args = decode_command_arg_values(&raw).expect("arg list decodes");
        assert_eq!(args.len(), 2);
        assert!(args.iter().all(|a| a.shape == CommandArgShape::Expression));
    }

    #[test]
    fn decode_command_arg_values_empty_for_header_only_command() {
        let raw = vec![0x23, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00];
        assert!(decode_command_arg_values(&raw).expect("decodes").is_empty());
    }

    #[test]
    fn special_parameter_is_not_misread_as_a_string() {
        // Ordinary function command (module_id 3 msg, opcode 100 — NOT a
        // goto-family opcode) + `( $FF<0> 0x61 <tag=1> ( $FF<9> ) )`: the
        // `0x61` special-parameter introducer must be consumed as a special
        // parameter (tag + contained `($FF<9>)` group), NOT as a bare `'a'`
        // string — the bug that failed 65 observed / 63 Kanon scenes.
        let mut raw = vec![0x23, 0x00, 0x03, 0x64, 0x00, 0x01, 0x00, 0x00, b'('];
        raw.extend_from_slice(&[0x24, 0xFF]);
        raw.extend_from_slice(&0_i32.to_le_bytes());
        // special parameter: 0x61 <tag=1> ( $FF<9> )
        raw.push(0x61);
        raw.push(0x01);
        raw.push(b'(');
        raw.extend_from_slice(&[0x24, 0xFF]);
        raw.extend_from_slice(&9_i32.to_le_bytes());
        raw.push(b')');
        raw.push(b')');
        // The whole element must length-walk cleanly (no stall on the
        // special-parameter tag byte) and consume every byte.
        let elements = decode_bytecode_stream(&raw).expect("special-param arg list must decode");
        let total: usize = elements.iter().map(BytecodeElement::byte_len).sum();
        assert_eq!(total, raw.len(), "element partition must cover every byte");
        assert!(matches!(elements[0], BytecodeElement::Command { .. }));
    }
}
