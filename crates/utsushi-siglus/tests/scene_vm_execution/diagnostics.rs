use super::*;

#[test]
fn rejects_a_program_that_runs_off_the_end_without_a_terminator() {
    let mut code = Vec::new();
    push_str(&mut code, 0);
    text(&mut code);
    let program = SceneProgram::from_payload(99, &payload(&code, &[], &["truncated"]))
        .expect("the bytecode is otherwise valid");

    let error = execute_scene(&program, &mut VmState::default())
        .expect_err("a program missing CD_RETURN and CD_EOF must not complete");

    assert_eq!(
        error,
        VmError::UnexpectedEnd {
            scene_id: 99,
            offset: code.len(),
        },
        "removing the end-of-vector diagnostic turns truncated bytecode into a completed halt"
    );
}

#[test]
fn rejects_a_declared_string_table_entry_outside_the_payload() {
    let code = [0x16];
    let mut malformed = payload(&code, &[], &["declared"]);
    let index_offset = i32::from_le_bytes(malformed[12..16].try_into().expect("index offset"));
    let entry = index_offset as usize;
    malformed[entry..entry + 4].copy_from_slice(&i32::MAX.to_le_bytes());

    let error = SceneProgram::from_payload(100, &malformed)
        .expect_err("a declared string entry outside the payload must be rejected");

    assert!(matches!(
        error,
        SceneProgramError::InvalidStringTable {
            entry: 0,
            reason: "string data lies outside payload",
        }
    ));
}
