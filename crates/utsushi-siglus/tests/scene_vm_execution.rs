//! Black-box execution proofs for the real scene-bytecode interpreter.

use kaifuu_siglus::SiglusIncludedCommand;
use utsushi_siglus::scene_vm::{
    Moment, SceneProgram, TitleProgram, VmState, execute_scene, execute_title_scene,
};

#[test]
fn dispatches_pack_included_script_function_into_its_target_scene() {
    let mut caller = Vec::new();
    elm(&mut caller);
    push_int(&mut caller, 0x7e00_0000_u32 as i32);
    command(&mut caller, 0, 0);
    caller.push(0x16);
    let mut callee = Vec::new();
    push_str(&mut callee, 0);
    text(&mut callee);
    callee.push(0x15);
    word(&mut callee, 0);

    let title = TitleProgram::from_scenes(
        vec![
            SceneProgram::from_payload(1, &payload(&caller, &[], &[])).expect("caller compiles"),
            SceneProgram::from_payload(2, &payload(&callee, &[], &["dispatched"]))
                .expect("callee compiles"),
        ],
        &[SiglusIncludedCommand {
            scene_id: 2,
            byte_offset: 0,
        }],
    )
    .expect("included target is an instruction boundary");
    let report = execute_title_scene(&title, 1, &mut VmState::default())
        .expect("included function returns to its caller");

    assert_eq!(report.instructions_executed, 7);
    assert_eq!(
        report.moments,
        vec![Moment::Text {
            scene_id: 2,
            offset: 9,
            speaker: None,
            text: "dispatched".to_string(),
        }],
        "removing archive-level dispatch leaves no reachable text"
    );
}

#[test]
fn executes_assignment_expression_branch_call_and_choice_in_program_order() {
    let mut code = Vec::new();
    gosub(&mut code, 0);
    elm(&mut code);
    push_int(&mut code, 0x7f00_0001_u32 as i32);
    code.push(0x05);
    push_int(&mut code, 3);
    binary(&mut code, 0x10);
    goto_false(&mut code, 1);
    push_str(&mut code, 0);
    text(&mut code);
    goto(&mut code, 2);
    let chosen = code.len() as i32;
    push_str(&mut code, 1);
    text(&mut code);
    let after_branch = code.len() as i32;
    elm(&mut code);
    push_int(&mut code, 76);
    push_str(&mut code, 2);
    push_str(&mut code, 3);
    command(&mut code, 2, 10);
    code.extend([0x03]);
    word(&mut code, 10);
    code.push(0x16);
    let subroutine = code.len() as i32;
    elm(&mut code);
    push_int(&mut code, 0x7f00_0001_u32 as i32);
    push_int(&mut code, 3);
    assign(&mut code);
    code.push(0x15);
    word(&mut code, 0);

    let program = SceneProgram::from_payload(
        7,
        &payload(
            &code,
            &[subroutine, chosen, after_branch],
            &["wrong", "right", "one", "two"],
        ),
    )
    .expect("synthetic real-opcode payload compiles");
    let mut state = VmState::default();
    let report = execute_scene(&program, &mut state).expect("execution reaches eof");

    assert_eq!(state.globals.get(&1), Some(&3));
    assert_eq!(report.instructions_executed, 22);
    assert_eq!(
        report.moments,
        vec![
            Moment::Text {
                scene_id: 7,
                offset: 53,
                speaker: None,
                text: "wrong".to_string(),
            },
            Moment::Choice {
                scene_id: 7,
                offset: 105,
                options: vec!["one".to_string(), "two".to_string()],
                chosen: 0,
            },
        ],
        "the expression result must take the true branch; a constant evaluator changes this observable path",
    );
}

fn payload(code: &[u8], labels: &[i32], strings: &[&str]) -> Vec<u8> {
    const HEADER: usize = 0x84;
    let labels_at = HEADER + code.len();
    let index_at = labels_at + labels.len() * 4;
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
    ] {
        word(&mut out, value);
    }
    for _ in 9..33 {
        word(&mut out, 0);
    }
    out.extend_from_slice(code);
    for label in labels {
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
fn text(out: &mut Vec<u8>) {
    out.push(0x31);
    word(out, 0);
}
fn binary(out: &mut Vec<u8>, op: u8) {
    out.push(0x22);
    word(out, 10);
    word(out, 10);
    out.push(op);
}
fn assign(out: &mut Vec<u8>) {
    out.push(0x20);
    word(out, 10);
    word(out, 10);
    word(out, 0);
}
fn goto(out: &mut Vec<u8>, label: i32) {
    out.push(0x10);
    word(out, label);
}
fn goto_false(out: &mut Vec<u8>, label: i32) {
    out.push(0x12);
    word(out, label);
}
fn gosub(out: &mut Vec<u8>, label: i32) {
    out.push(0x13);
    word(out, label);
    word(out, 0);
}
fn command(out: &mut Vec<u8>, arguments: i32, return_form: i32) {
    out.push(0x30);
    word(out, 0);
    word(out, arguments);
    for _ in 0..arguments {
        word(out, 20);
    }
    word(out, 0);
    word(out, return_form);
}
