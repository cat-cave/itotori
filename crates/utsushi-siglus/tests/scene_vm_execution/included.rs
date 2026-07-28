use super::scene_vm_execution_fixtures::*;
use super::*;

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
