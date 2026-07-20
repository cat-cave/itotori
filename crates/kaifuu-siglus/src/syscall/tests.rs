use crate::{
    FM_INT, FM_STR, SEL_SYSTEM_FUNCTION_ID, SiglusCallTarget, SiglusSyscallDiagnostic,
    decode_scene_syscalls, system_function_name,
};

fn put_i32(bytes: &mut Vec<u8>, value: i32) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn command(bytes: &mut Vec<u8>, forms: &[i32], ret_form: i32, read_flag: Option<i32>) {
    bytes.push(0x30);
    put_i32(bytes, 0); // argument-list id
    put_i32(bytes, forms.len() as i32);
    for form in forms {
        put_i32(bytes, *form);
    }
    put_i32(bytes, 0); // named arguments
    put_i32(bytes, ret_form);
    if let Some(read_flag) = read_flag {
        put_i32(bytes, read_flag);
    }
}

fn system_target(bytes: &mut Vec<u8>, function_id: i32) {
    bytes.push(0x08); // ELM_POINT
    bytes.push(0x02); // PUSH int function id
    put_i32(bytes, FM_INT);
    put_i32(bytes, function_id);
}

fn push_str(bytes: &mut Vec<u8>, index: i32) {
    bytes.push(0x02);
    put_i32(bytes, FM_STR);
    put_i32(bytes, index);
}

fn push_int(bytes: &mut Vec<u8>, value: i32) {
    bytes.push(0x02);
    put_i32(bytes, FM_INT);
    put_i32(bytes, value);
}

fn payload(bytecode: &[u8], labels: &[i32], strings: &[(i32, i32)]) -> Vec<u8> {
    let header = crate::SCN_HEADER_BYTE_LEN as i32;
    let label_offset = header + bytecode.len() as i32;
    let string_index_offset = label_offset + labels.len() as i32 * 4;
    let string_data_offset = string_index_offset + strings.len() as i32 * 8;
    let mut out = Vec::new();
    put_i32(&mut out, crate::SCN_HEADER_DECLARED_SIZE);
    put_i32(&mut out, header);
    put_i32(&mut out, bytecode.len() as i32);
    put_i32(&mut out, string_index_offset);
    put_i32(&mut out, strings.len() as i32);
    put_i32(&mut out, string_data_offset);
    put_i32(&mut out, strings.len() as i32);
    put_i32(&mut out, label_offset);
    put_i32(&mut out, labels.len() as i32);
    for _ in 9..33 {
        put_i32(&mut out, 0);
    }
    out.extend_from_slice(bytecode);
    for label in labels {
        put_i32(&mut out, *label);
    }
    for (offset, length) in strings {
        put_i32(&mut out, *offset);
        put_i32(&mut out, *length);
    }
    out.resize(string_data_offset as usize + 16, 0);
    out
}

#[test]
fn decodes_sel_arguments_tail_and_string_references() {
    let mut bytecode = Vec::new();
    system_target(&mut bytecode, SEL_SYSTEM_FUNCTION_ID);
    push_str(&mut bytecode, 0);
    push_str(&mut bytecode, 1);
    command(&mut bytecode, &[FM_STR, FM_STR], FM_INT, Some(9));
    let after_command = bytecode.len() as i32;
    bytecode.push(0x03); // POP returned selection result
    put_i32(&mut bytecode, FM_INT);
    bytecode.push(0x16);

    let decode = decode_scene_syscalls(&payload(&bytecode, &[after_command], &[(0, 2), (2, 3)]))
        .expect("syscall decode");

    assert_eq!(system_function_name(SEL_SYSTEM_FUNCTION_ID), Some("sel"));
    assert!(decode.commands_fully_typed());
    assert_eq!(decode.calls.len(), 1);
    assert_eq!(decode.calls[0].read_flag, Some(9));
    assert!(matches!(
        decode.calls[0].target,
        SiglusCallTarget::System { function_id } if function_id == SEL_SYSTEM_FUNCTION_ID
    ));
    assert_eq!(decode.selections.len(), 1);
    assert_eq!(decode.selections[0].options.len(), 2);
    assert_eq!(decode.selections[0].options[0].text.index, 0);
    assert_eq!(decode.selections[0].options[1].text.index, 1);
    assert!(decode.diagnostics.is_empty());
}

#[test]
fn selection_options_link_to_the_structural_choice_arms() {
    let mut bytecode = Vec::new();
    system_target(&mut bytecode, SEL_SYSTEM_FUNCTION_ID);
    push_str(&mut bytecode, 0);
    push_str(&mut bytecode, 1);
    command(&mut bytecode, &[FM_STR, FM_STR], FM_INT, Some(0));
    let after_command = bytecode.len() as i32;
    push_int(&mut bytecode, 1);
    bytecode.push(0x11); // GOTO_TRUE label 1
    put_i32(&mut bytecode, 1);
    push_int(&mut bytecode, 2);
    bytecode.push(0x11); // GOTO_TRUE label 2
    put_i32(&mut bytecode, 2);
    let first_target = bytecode.len() as i32;
    bytecode.push(0x16);
    let second_target = bytecode.len() as i32;
    bytecode.push(0x16);

    let decode = decode_scene_syscalls(&payload(
        &bytecode,
        &[after_command, first_target, second_target],
        &[(0, 1), (1, 1)],
    ))
    .expect("syscall decode");

    let selection = &decode.selections[0];
    assert_eq!(selection.structural_choice_index, Some(0));
    assert_eq!(selection.options.len(), 2);
    assert_eq!(selection.options[0].structural_arm_index, Some(0));
    assert_eq!(selection.options[1].structural_arm_index, Some(1));
    assert_eq!(
        selection.options[0].branch_target_offset,
        Some(first_target as usize)
    );
    assert_eq!(
        selection.options[1].branch_target_offset,
        Some(second_target as usize)
    );
}

#[test]
fn reports_unknown_system_argument_shapes_by_function_id() {
    let mut bytecode = Vec::new();
    system_target(&mut bytecode, 88);
    command(&mut bytecode, &[], 0, None);
    bytecode.push(0x16);
    let decode = decode_scene_syscalls(&payload(&bytecode, &[], &[])).expect("syscall decode");

    assert!(decode.commands_fully_typed());
    assert_eq!(decode.unknown_arg_shape_counts.get(&88), Some(&1));
    assert_eq!(
        decode.diagnostics,
        vec![SiglusSyscallDiagnostic::UnknownSyscallArgShape {
            function_id: 88,
            count: 1,
        }]
    );
}

#[test]
fn reports_an_invalid_sel_string_reference_without_reading_past_payload() {
    let mut bytecode = Vec::new();
    system_target(&mut bytecode, SEL_SYSTEM_FUNCTION_ID);
    push_str(&mut bytecode, 9);
    command(&mut bytecode, &[FM_STR], 0, Some(0));
    let after_command = bytecode.len() as i32;
    bytecode.push(0x16);
    let decode =
        decode_scene_syscalls(&payload(&bytecode, &[after_command], &[])).expect("syscall decode");

    assert!(decode.commands_fully_typed());
    assert!(decode.selections[0].options.is_empty());
    assert!(
        decode
            .diagnostics
            .contains(&SiglusSyscallDiagnostic::UnresolvedSelOptionStringRef { count: 1 })
    );
}
