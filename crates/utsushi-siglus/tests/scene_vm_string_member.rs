//! Regression proof for the current-call string-member path found in real Scene.pck bytes.

use utsushi_siglus::scene_vm::{Moment, SceneProgram, VmState, execute_scene};

#[test]
fn executes_current_call_string_search_after_string_assignment() {
    let mut code = Vec::new();
    push_str(&mut code, 0);
    gosub_string_arg(&mut code, 0);
    code.push(0x16);

    let subroutine = code.len() as i32;
    dec_prop(&mut code, 20, 0);
    code.push(0x09); // CD_ARG
    current_call_property(&mut code, None);
    push_str(&mut code, 1);
    assign(&mut code);
    current_call_property(&mut code, Some(10)); // STR.SEARCH
    push_str(&mut code, 2);
    command(&mut code, 1, 10);
    push_int(&mut code, 2);
    binary(&mut code, 0x10);
    goto_false(&mut code, 1);
    push_str(&mut code, 3);
    text(&mut code);
    ret(&mut code);
    let wrong = code.len() as i32;
    push_str(&mut code, 4);
    text(&mut code);
    ret(&mut code);

    let program = SceneProgram::from_payload(
        20,
        &payload(
            &code,
            &[subroutine, wrong],
            &["unused", "Renewed", "new", "resolved", "wrong"],
        ),
    )
    .expect("current-call string-member payload compiles");
    let report = execute_scene(&program, &mut VmState::default())
        .expect("the assigned current-call string must execute STR.SEARCH");

    assert_eq!(
        report.moments,
        vec![Moment::Text {
            scene_id: 20,
            offset: 165,
            speaker: None,
            text: "resolved".to_string(),
        }],
        "removing string-member dispatch or string assignment makes this real path stop or take the wrong branch",
    );
}

fn payload(code: &[u8], labels: &[i32], strings: &[&str]) -> Vec<u8> {
    const HEADER: usize = 0x84;
    let labels_at = HEADER + code.len();
    let z_labels_at = labels_at + labels.len() * 4;
    let index_at = z_labels_at + 4;
    let list_at = index_at + strings.len() * 8;
    let mut out = Vec::new();
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
        1,
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
    word(&mut out, 0);
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

fn word(out: &mut Vec<u8>, value: i32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn push_int(out: &mut Vec<u8>, value: i32) {
    out.push(0x02);
    word(out, 10);
    word(out, value);
}

fn push_str(out: &mut Vec<u8>, value: i32) {
    out.push(0x02);
    word(out, 20);
    word(out, value);
}

fn elm(out: &mut Vec<u8>) {
    out.push(0x08);
}

fn current_call_property(out: &mut Vec<u8>, operation: Option<i32>) {
    elm(out);
    push_int(out, 83);
    push_int(out, 0x7d00_0000_u32 as i32);
    if let Some(operation) = operation {
        push_int(out, operation);
    }
}

fn gosub_string_arg(out: &mut Vec<u8>, label: i32) {
    out.push(0x13);
    word(out, label);
    word(out, 1);
    word(out, 20);
}

fn dec_prop(out: &mut Vec<u8>, form: i32, property: i32) {
    out.push(0x07);
    word(out, form);
    word(out, property);
}

fn assign(out: &mut Vec<u8>) {
    out.push(0x20);
    word(out, 20);
    word(out, 20);
    word(out, 0);
}

fn command(out: &mut Vec<u8>, arguments: i32, return_form: i32) {
    out.push(0x30);
    word(out, 1);
    word(out, arguments);
    for _ in 0..arguments {
        word(out, 20);
    }
    word(out, 0);
    word(out, return_form);
}

fn binary(out: &mut Vec<u8>, operation: u8) {
    out.push(0x22);
    word(out, 10);
    word(out, 10);
    out.push(operation);
}

fn goto_false(out: &mut Vec<u8>, label: i32) {
    out.push(0x12);
    word(out, label);
}

fn text(out: &mut Vec<u8>) {
    out.push(0x31);
    word(out, 0);
}

fn ret(out: &mut Vec<u8>) {
    out.push(0x15);
    word(out, 0);
}
