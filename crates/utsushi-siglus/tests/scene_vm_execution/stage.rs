use super::scene_vm_execution_fixtures::*;
use super::*;

#[test]
fn retains_form_44_pcmch_stop_state_before_reaching_authored_text() {
    let mut code = Vec::new();
    pcmch_path(&mut code, 0, 5); // PCMCH[0].STOP
    push_int(&mut code, 240);
    command(&mut code, 1, 0);
    push_str(&mut code, 0);
    text(&mut code);
    code.push(0x16);

    let program = SceneProgram::from_payload(44, &payload(&code, &[], &["after stop"]))
        .expect("form-44 PCMCH payload compiles");
    let mut state = VmState::default();
    let report = execute_scene_with_stage_objects(&program, &mut state)
        .expect("the implemented PCMCH stop command reaches the authored boundary");

    assert_eq!(
        state.pcm_channels.get(&0),
        Some(&utsushi_siglus::scene_vm::PcmChannelState {
            stopped: true,
            stop_fade: Some(240),
        }),
        "deleting PCMCH stop state mutation must make this test fail rather than accepting a no-op"
    );
    assert_eq!(
        report.moments,
        vec![Moment::Text {
            scene_id: 44,
            offset: 76,
            speaker: None,
            text: "after stop".to_string(),
        }]
    );
}

#[test]
fn non_stage_execution_keeps_form_44_as_a_terminal_diagnostic() {
    let mut code = Vec::new();
    pcmch_path(&mut code, 0, 5);
    push_int(&mut code, 240);
    command(&mut code, 1, 0);
    push_str(&mut code, 0);
    text(&mut code);
    code.push(0x16);

    let program = SceneProgram::from_payload(44, &payload(&code, &[], &["must not advance"]))
        .expect("form-44 PCMCH payload compiles");
    let error = execute_scene(&program, &mut VmState::default())
        .expect_err("the non-stage scanner must stop rather than silently advancing PCMCH");
    assert!(
        matches!(error, VmError::UnsupportedElementPath { .. }),
        "unexpected non-stage form-44 diagnostic: {error}"
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
