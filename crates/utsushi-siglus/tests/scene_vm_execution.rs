//! Black-box execution proofs for the real scene-bytecode interpreter.

use kaifuu_siglus::SiglusIncludedCommand;
use utsushi_siglus::scene_vm::{
    Moment, SceneProgram, TitleProgram, VmState, execute_scene, execute_scene_with_stage_objects,
    execute_title_scene, execute_title_scene_with_stage_snapshots_observed,
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
fn preserves_caller_string_bytes_when_an_included_function_builds_the_stage() {
    let mut caller = Vec::new();
    elm(&mut caller);
    push_int(&mut caller, 0x7e00_0000_u32 as i32);
    push_str(&mut caller, 0);
    command(&mut caller, 1, 0);
    caller.push(0x16);

    let mut callee = Vec::new();
    dec_prop(&mut callee, 20, 0);
    callee.push(0x09); // CD_ARG
    elm(&mut callee);
    push_int(&mut callee, 34); // string list slot 0
    push_int(&mut callee, -1);
    push_int(&mut callee, 0);
    elm(&mut callee);
    push_int(&mut callee, 83);
    push_int(&mut callee, 0x7d00_0000_u32 as i32);
    callee.push(0x05); // current call property
    assign(&mut callee);
    stage_path(&mut callee, 0, 0, 38); // OBJECT.CREATE
    elm(&mut callee);
    push_int(&mut callee, 34);
    push_int(&mut callee, -1);
    push_int(&mut callee, 0);
    callee.push(0x05); // string list slot 0
    push_int(&mut callee, 1); // visible
    command(&mut callee, 2, 0);
    push_str(&mut callee, 1);
    text(&mut callee);
    callee.push(0x15);
    word(&mut callee, 0);

    let title = TitleProgram::from_scenes(
        vec![
            SceneProgram::from_payload(1, &payload(&caller, &[], &["BG01A01"]))
                .expect("caller compiles"),
            SceneProgram::from_payload(
                2,
                &payload(&callee, &[], &["wrong-source-index", "boundary"]),
            )
            .expect("callee compiles"),
        ],
        &[SiglusIncludedCommand {
            scene_id: 2,
            byte_offset: 0,
        }],
    )
    .expect("included target is an instruction boundary");
    let outcome =
        execute_title_scene_with_stage_snapshots_observed(&title, 1, &mut VmState::default())
            .expect("the included function executes");
    let report = match outcome {
        utsushi_siglus::scene_vm::ExecutionOutcome::Complete(report) => report,
        utsushi_siglus::scene_vm::ExecutionOutcome::Terminal { error, .. } => {
            panic!("the included function must not stop: {error}")
        }
    };
    assert_eq!(report.stage_snapshots.len(), 1);
    assert_eq!(
        report.stage_snapshots[0].state.stage_objects[&0][&0]
            .identity
            .as_deref(),
        Some("BG01A01"),
        "deleting caller-string materialization makes the callee resolve its own string index and render the wrong asset",
    );
}

#[test]
fn farcall_resolves_its_string_target_then_returns_to_the_calling_scene() {
    let mut caller = Vec::new();
    elm(&mut caller);
    push_int(&mut caller, 5);
    push_str(&mut caller, 0);
    push_int(&mut caller, 1);
    farcall_command(&mut caller);
    push_str(&mut caller, 1);
    text(&mut caller);
    caller.push(0x16);
    let mut callee = Vec::new();
    push_str(&mut callee, 0);
    text(&mut callee);
    let callee_entry = callee.len() as i32;
    push_str(&mut callee, 1);
    text(&mut callee);
    callee.push(0x15);
    word(&mut callee, 0);
    let mut decoy = Vec::new();
    push_str(&mut decoy, 0);
    text(&mut decoy);
    decoy.push(0x16);

    let title = TitleProgram::from_scenes_with_names(
        vec![
            SceneProgram::from_payload(1, &payload(&caller, &[], &["next", "resumed"]))
                .expect("caller compiles"),
            SceneProgram::from_payload(
                2,
                &payload_with_z_labels(&callee, &[], &[0, callee_entry], &["wrong", "called"]),
            )
            .expect("callee compiles"),
            SceneProgram::from_payload(3, &payload(&decoy, &[], &["wrong"]))
                .expect("decoy compiles"),
        ],
        vec![("next".to_string(), 2), ("other".to_string(), 3)],
        &[],
    )
    .expect("named scene targets are present");
    let report = execute_title_scene(&title, 1, &mut VmState::default())
        .expect("farcall returns to its caller");

    assert_eq!(
        report.scenes_entered.into_iter().collect::<Vec<_>>(),
        vec![1, 2],
        "the execution report retains the cross-scene path that produced its moments"
    );
    assert_eq!(
        report
            .moments
            .into_iter()
            .filter_map(|moment| match moment {
                Moment::Text { text, .. } => Some(text),
                Moment::Choice { .. } => None,
            })
            .collect::<Vec<_>>(),
        vec!["called", "resumed"],
        "stubbing farcall, resolving the wrong scene, or not restoring its return frame loses this path"
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

#[test]
fn carries_call_properties_into_global_list_assignment_before_reaching_text() {
    let mut code = Vec::new();
    push_int(&mut code, 9);
    gosub_args(&mut code, 0, 1);
    code.push(0x16);
    let subroutine = code.len() as i32;
    dec_prop(&mut code, 10, 7);
    code.push(0x09);
    elm(&mut code);
    push_int(&mut code, 83);
    push_int(&mut code, 0x7d00_0000_u32 as i32);
    code.push(0x05);
    push_int(&mut code, 9);
    binary(&mut code, 0x10);
    goto_false(&mut code, 1);
    elm(&mut code);
    push_int(&mut code, 31);
    push_int(&mut code, -1);
    push_int(&mut code, 6);
    push_int(&mut code, 4);
    assign(&mut code);
    elm(&mut code);
    push_int(&mut code, 31);
    push_int(&mut code, -1);
    push_int(&mut code, 6);
    code.push(0x05);
    push_int(&mut code, 4);
    binary(&mut code, 0x10);
    goto_false(&mut code, 1);
    push_str(&mut code, 0);
    text(&mut code);
    code.push(0x15);
    word(&mut code, 0);
    let wrong = code.len() as i32;
    push_str(&mut code, 1);
    text(&mut code);
    code.push(0x15);
    word(&mut code, 0);

    let program = SceneProgram::from_payload(
        8,
        &payload(&code, &[subroutine, wrong], &["resolved", "wrong"]),
    )
    .expect("call-property payload compiles");
    let mut state = VmState::default();
    let report = execute_scene(&program, &mut state).expect("call-local path executes");

    assert_eq!(state.indexed_globals.get(&(31, 6)), Some(&4));
    assert_eq!(
        report.moments,
        vec![Moment::Text {
            scene_id: 8,
            offset: 189,
            speaker: None,
            text: "resolved".to_string(),
        }],
        "removing call-property expansion or global-list addressing takes the error branch"
    );
}

#[test]
fn preserves_structured_system_assignment_for_a_later_branch() {
    let mut code = Vec::new();
    elm(&mut code);
    push_int(&mut code, 83);
    push_int(&mut code, 0);
    push_int(&mut code, -1);
    push_int(&mut code, 10);
    push_int(&mut code, 7);
    assign(&mut code);
    elm(&mut code);
    push_int(&mut code, 83);
    push_int(&mut code, 0);
    push_int(&mut code, -1);
    push_int(&mut code, 10);
    code.push(0x05);
    push_int(&mut code, 7);
    binary(&mut code, 0x10);
    goto_false(&mut code, 0);
    push_str(&mut code, 0);
    text(&mut code);
    code.push(0x16);
    let wrong = code.len() as i32;
    push_str(&mut code, 1);
    text(&mut code);
    code.push(0x16);

    let program = SceneProgram::from_payload(9, &payload(&code, &[wrong], &["resolved", "wrong"]))
        .expect("structured-system payload compiles");
    let report = execute_scene(&program, &mut VmState::default())
        .expect("structured-system assignment keeps execution on the resolved branch");

    assert_eq!(
        report.moments,
        vec![Moment::Text {
            scene_id: 9,
            offset: 130,
            speaker: None,
            text: "resolved".to_string(),
        }],
        "stubbing the structured system store makes the later read take the wrong branch"
    );
}

#[test]
fn stage_object_commands_and_properties_populate_slot_geometry_and_order() {
    let mut code = Vec::new();
    stage_alias_path(&mut code, 38, 4, 38);
    push_str(&mut code, 0);
    push_int(&mut code, 1);
    push_int(&mut code, 640);
    push_int(&mut code, 360);
    command(&mut code, 4, 0);
    stage_assign(&mut code, 1, 4, 55, 12);
    stage_assign(&mut code, 1, 4, 2, 3);
    stage_assign(&mut code, 1, 4, 56, 1);
    stage_assign(&mut code, 1, 4, 92, 1);
    stage_path(&mut code, 1, 4, 49);
    push_int(&mut code, 1200);
    push_int(&mut code, 800);
    command(&mut code, 2, 0);
    stage_path(&mut code, 1, 4, 160);
    push_int(&mut code, 10);
    push_int(&mut code, 20);
    push_int(&mut code, 110);
    push_int(&mut code, 220);
    command(&mut code, 4, 0);
    stage_path(&mut code, 1, 5, 38);
    push_str(&mut code, 1);
    command(&mut code, 1, 0);
    stage_path(&mut code, 1, 5, 36);
    command(&mut code, 0, 0);
    code.push(0x16);

    let program = SceneProgram::from_payload(10, &payload(&code, &[], &["one", "two"]))
        .expect("stage-object payload compiles");
    let mut state = VmState::default();
    execute_scene_with_stage_objects(&program, &mut state).expect("stage-object program executes");

    let object = state
        .stage_objects
        .get(&1)
        .and_then(|slots| slots.get(&4))
        .expect("created object is retained at its real element slot");
    assert_eq!(object.identity.as_deref(), Some("one"));
    assert!(object.active);
    assert!(object.visible);
    assert_eq!((object.order, object.layer), (12, 3));
    assert_eq!((object.wipe_copy, object.wipe_erase), (1, 1));
    assert_eq!((object.geometry.x, object.geometry.y), (640, 360));
    assert_eq!(
        (object.geometry.scale_x, object.geometry.scale_y),
        (1200, 800)
    );
    assert_eq!(object.geometry.clip, Some((10, 20, 110, 220)));
    assert!(
        !state.stage_objects[&1][&5].active,
        "free must erase the lifecycle state instead of leaving a stale object",
    );
}

#[test]
fn captures_the_stage_state_that_produced_each_real_text_boundary() {
    let mut code = Vec::new();
    stage_path(&mut code, 0, 4, 38);
    push_str(&mut code, 0);
    push_int(&mut code, 1);
    command(&mut code, 2, 0);
    stage_assign(&mut code, 0, 4, 3, 1);
    push_str(&mut code, 1);
    text(&mut code);
    code.push(0x16);
    let scene = SceneProgram::from_payload(12, &payload(&code, &[], &["back", "first line"]))
        .expect("stage scene compiles");
    let title = TitleProgram::from_scenes(vec![scene], &[]).expect("title compiles");
    let outcome =
        execute_title_scene_with_stage_snapshots_observed(&title, 12, &mut VmState::default())
            .expect("snapshot execution is real bytecode execution");
    let report = match outcome {
        utsushi_siglus::scene_vm::ExecutionOutcome::Complete(report) => report,
        utsushi_siglus::scene_vm::ExecutionOutcome::Terminal { .. } => {
            panic!("test payload should reach eof")
        }
    };
    assert_eq!(report.stage_snapshots.len(), 1);
    let snapshot = &report.stage_snapshots[0];
    assert_eq!(
        snapshot.moment,
        Moment::Text {
            scene_id: 12,
            offset: 202,
            speaker: None,
            text: "first line".to_string(),
        },
        "deleting boundary capture leaves the player with no state for the emitted text",
    );
    assert_eq!(
        snapshot.state.stage_objects[&0][&4].identity.as_deref(),
        Some("back")
    );
    assert!(snapshot.state.stage_objects[&0][&4].visible);
}

fn payload(code: &[u8], labels: &[i32], strings: &[&str]) -> Vec<u8> {
    payload_with_z_labels(code, labels, &[0], strings)
}

fn payload_with_z_labels(
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
fn stage_path(out: &mut Vec<u8>, stage: i32, slot: i32, operation: i32) {
    elm(out);
    for value in [49, -1, stage, 2, -1, slot, operation] {
        push_int(out, value);
    }
}
fn stage_alias_path(out: &mut Vec<u8>, stage_alias: i32, slot: i32, operation: i32) {
    elm(out);
    for value in [stage_alias, 2, -1, slot, operation] {
        push_int(out, value);
    }
}
fn stage_assign(out: &mut Vec<u8>, stage: i32, slot: i32, operation: i32, value: i32) {
    stage_path(out, stage, slot, operation);
    push_int(out, value);
    assign(out);
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
    gosub_args(out, label, 0);
}
fn gosub_args(out: &mut Vec<u8>, label: i32, arguments: i32) {
    out.push(0x13);
    word(out, label);
    word(out, arguments);
    for _ in 0..arguments {
        word(out, 10);
    }
}
fn dec_prop(out: &mut Vec<u8>, form: i32, prop_id: i32) {
    out.push(0x07);
    word(out, form);
    word(out, prop_id);
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
fn farcall_command(out: &mut Vec<u8>) {
    out.push(0x30);
    word(out, 1);
    word(out, 2);
    word(out, 20);
    word(out, 10);
    word(out, 0);
    word(out, 10);
}
