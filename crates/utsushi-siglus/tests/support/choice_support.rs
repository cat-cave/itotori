//! Minimal decoded Siglus choice scene shared by the launch observation test.

use kaifuu_siglus::{FM_INT, FM_STR, GLOBAL_SELBTN_SYSTEM_FUNCTION_ID, SCN_HEADER_BYTE_LEN};

pub(super) fn synthetic_choice_scene_payload() -> Vec<u8> {
    let strings = ["Option one", "Option two"];
    let mut bytecode = Vec::new();
    bytecode.push(0x08); // CD_ELM_POINT
    push_int(&mut bytecode, GLOBAL_SELBTN_SYSTEM_FUNCTION_ID);
    push_str(&mut bytecode, 0);
    push_str(&mut bytecode, 1);
    bytecode.push(0x30); // CD_COMMAND
    for word in [0, 2, FM_STR, FM_STR, 0, FM_INT, 0] {
        bytecode.extend_from_slice(&word.to_le_bytes());
    }
    let after_command = bytecode.len() as i32;
    push_int(&mut bytecode, 1);
    goto_true(&mut bytecode, 1);
    push_int(&mut bytecode, 2);
    goto_true(&mut bytecode, 2);
    let first_target = bytecode.len() as i32;
    bytecode.push(0x16);
    let second_target = bytecode.len() as i32;
    bytecode.push(0x16);

    let str_index_ofs = SCN_HEADER_BYTE_LEN + bytecode.len() + 3 * 4;
    let str_list_ofs = str_index_ofs + strings.len() * 8;
    let mut payload = vec![0_u8; SCN_HEADER_BYTE_LEN];
    for (field, value) in [
        (0, SCN_HEADER_BYTE_LEN as u32),
        (1, SCN_HEADER_BYTE_LEN as u32),
        (2, bytecode.len() as u32),
        (3, str_index_ofs as u32),
        (4, strings.len() as u32),
        (5, str_list_ofs as u32),
        (6, strings.len() as u32),
        (7, (SCN_HEADER_BYTE_LEN + bytecode.len()) as u32),
        (8, 3),
    ] {
        payload[field * 4..field * 4 + 4].copy_from_slice(&value.to_le_bytes());
    }
    payload.extend_from_slice(&bytecode);
    for label in [after_command, first_target, second_target] {
        payload.extend_from_slice(&label.to_le_bytes());
    }
    let encoded: Vec<_> = strings
        .iter()
        .enumerate()
        .map(|(index, string)| xor_utf16(string, index as u16))
        .collect();
    let mut char_offset = 0_u32;
    for string in &encoded {
        payload.extend_from_slice(&char_offset.to_le_bytes());
        payload.extend_from_slice(&((string.len() / 2) as u32).to_le_bytes());
        char_offset += (string.len() / 2) as u32;
    }
    for string in encoded {
        payload.extend_from_slice(&string);
    }
    payload
}

fn push_int(bytes: &mut Vec<u8>, value: i32) {
    bytes.push(0x02);
    bytes.extend_from_slice(&FM_INT.to_le_bytes());
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn push_str(bytes: &mut Vec<u8>, index: i32) {
    bytes.push(0x02);
    bytes.extend_from_slice(&FM_STR.to_le_bytes());
    bytes.extend_from_slice(&index.to_le_bytes());
}

fn goto_true(bytes: &mut Vec<u8>, label: i32) {
    bytes.push(0x11);
    bytes.extend_from_slice(&label.to_le_bytes());
}

fn xor_utf16(text: &str, index: u16) -> Vec<u8> {
    let key = 28807_u16.wrapping_mul(index);
    text.encode_utf16()
        .chain(std::iter::once(0))
        .flat_map(|unit| (unit ^ key).to_le_bytes())
        .collect()
}
