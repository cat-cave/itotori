pub(super) fn payload(code: &[u8], labels: &[i32], strings: &[&str]) -> Vec<u8> {
    payload_with_z_labels(code, labels, &[0], strings)
}

pub(super) fn payload_with_z_labels(
    code: &[u8],
    labels: &[i32],
    z_labels: &[i32],
    strings: &[&str],
) -> Vec<u8> {
    const HEADER: usize = 0x84;
    let labels_at = HEADER + code.len();
    let z_labels_at = labels_at + labels.len() * 4;
    let index_at = z_labels_at + z_labels.len() * 4;
    let list_at = index_at + strings.len() * 8;
    let mut out = Vec::with_capacity(list_at + strings.iter().map(|s| s.len() * 2).sum::<usize>());
    for value in [
        0x84_i32,
        HEADER as i32,
        code.len() as i32,
        index_at as i32,
        strings.len() as i32,
        list_at as i32,
        0,
        labels_at as i32,
        labels.len() as i32,
        z_labels_at as i32,
        z_labels.len() as i32,
    ] {
        word(&mut out, value);
    }
    for _ in 11..33 {
        word(&mut out, 0);
    }
    out.extend_from_slice(code);
    for label in labels {
        word(&mut out, *label);
    }
    for label in z_labels {
        word(&mut out, *label);
    }
    let mut char_offset = 0_i32;
    for text in strings {
        word(&mut out, char_offset);
        word(&mut out, text.encode_utf16().count() as i32);
        char_offset += text.encode_utf16().count() as i32;
    }
    for (index, text) in strings.iter().enumerate() {
        let key = 28807_u16.wrapping_mul(index as u16);
        for unit in text.encode_utf16() {
            out.extend_from_slice(&(unit ^ key).to_le_bytes());
        }
    }
    out
}

pub(super) fn word(out: &mut Vec<u8>, value: i32) {
    out.extend_from_slice(&value.to_le_bytes());
}
pub(super) fn push_int(out: &mut Vec<u8>, value: i32) {
    out.push(0x02);
    word(out, 10);
    word(out, value);
}
pub(super) fn push_str(out: &mut Vec<u8>, value: i32) {
    out.push(0x02);
    word(out, 20);
    word(out, value);
}
pub(super) fn elm(out: &mut Vec<u8>) {
    out.push(0x08);
}
pub(super) fn text(out: &mut Vec<u8>) {
    out.push(0x31);
    word(out, 0);
}
pub(super) fn binary(out: &mut Vec<u8>, op: u8) {
    out.push(0x22);
    word(out, 10);
    word(out, 10);
    out.push(op);
}
pub(super) fn assign(out: &mut Vec<u8>) {
    out.push(0x20);
    word(out, 10);
    word(out, 10);
    word(out, 0);
}
pub(super) fn stage_path(out: &mut Vec<u8>, stage: i32, slot: i32, operation: i32) {
    elm(out);
    for value in [49, -1, stage, 2, -1, slot, operation] {
        push_int(out, value);
    }
}
pub(super) fn pcmch_path(out: &mut Vec<u8>, channel: i32, operation: i32) {
    elm(out);
    for value in [44, -1, channel, operation] {
        push_int(out, value);
    }
}
pub(super) fn stage_alias_path(out: &mut Vec<u8>, stage_alias: i32, slot: i32, operation: i32) {
    elm(out);
    for value in [stage_alias, 2, -1, slot, operation] {
        push_int(out, value);
    }
}
pub(super) fn stage_assign(out: &mut Vec<u8>, stage: i32, slot: i32, operation: i32, value: i32) {
    stage_path(out, stage, slot, operation);
    push_int(out, value);
    assign(out);
}
pub(super) fn stage_alias_child_assign(
    out: &mut Vec<u8>,
    stage_alias: i32,
    slot: i32,
    child: i32,
    operation: i32,
    value: i32,
) {
    elm(out);
    for value in [stage_alias, 2, -1, slot, 93, -1, child, operation] {
        push_int(out, value);
    }
    push_int(out, value);
    assign(out);
}
pub(super) fn goto(out: &mut Vec<u8>, label: i32) {
    out.push(0x10);
    word(out, label);
}
pub(super) fn goto_false(out: &mut Vec<u8>, label: i32) {
    out.push(0x12);
    word(out, label);
}
pub(super) fn gosub(out: &mut Vec<u8>, label: i32) {
    gosub_args(out, label, 0);
}
pub(super) fn gosub_args(out: &mut Vec<u8>, label: i32, arguments: i32) {
    out.push(0x13);
    word(out, label);
    word(out, arguments);
    for _ in 0..arguments {
        word(out, 10);
    }
}
pub(super) fn dec_prop(out: &mut Vec<u8>, form: i32, prop_id: i32) {
    out.push(0x07);
    word(out, form);
    word(out, prop_id);
}
pub(super) fn command(out: &mut Vec<u8>, arguments: i32, return_form: i32) {
    out.push(0x30);
    word(out, 0);
    word(out, arguments);
    for _ in 0..arguments {
        word(out, 20);
    }
    word(out, 0);
    word(out, return_form);
}
pub(super) fn farcall_command(out: &mut Vec<u8>) {
    out.push(0x30);
    word(out, 1);
    word(out, 2);
    word(out, 20);
    word(out, 10);
    word(out, 0);
    word(out, 10);
}
