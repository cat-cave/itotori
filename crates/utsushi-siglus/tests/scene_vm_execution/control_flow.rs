use super::scene_vm_execution_fixtures::*;
use super::*;

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
