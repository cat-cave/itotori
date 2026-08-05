fn synthetic_program(tokens: &[[u8; 4]]) -> Vec<u8> {
    let mut bytes = Vec::from(&b"Sv20"[..]);
    for token in tokens {
        bytes.extend_from_slice(token);
    }
    bytes
}

fn operator(id: u16) -> [u8; 4] {
    let mut token = [0; 4];
    token[..2].copy_from_slice(&id.to_le_bytes());
    token[2..].copy_from_slice(&1_u16.to_le_bytes());
    token
}

#[test]
fn script_only_slice_reports_a_real_message_syscall_when_one_is_reachable() {
    // This is the mutation guard for `script_only_cfg`: a hollow implementation
    // that returns the corpus-shaped empty result would make this test fail.
    // The message target is original script syntax, not a synthetic dialogue
    // result: no text or pointer is resolved or emitted by this feasibility
    // slice.
    let script = synthetic_program(&[
        operator(0x1f),
        0_u32.to_le_bytes(),
        operator(0x1f),
        0x0fff_ffff_u32.to_le_bytes(),
        operator(0x1f),
        0_u32.to_le_bytes(),
        operator(0x17),
        0x0002_0002_u32.to_le_bytes(),
        0_u32.to_le_bytes(),
        operator(0x15),
    ]);

    let result = script_only_cfg(&script, &[]);
    assert!(result.states > 0, "the synthetic CFG must visit its root state");
    assert!(result.edges > 0, "the synthetic CFG must retain successor edges");
    assert_eq!(result.max_return_depth, 0);
    assert_eq!(result.reachable_messages, vec![28]);
    assert!(result.reachable_selects.is_empty());
    assert_eq!(result.root_returns_after_attachment, 0);
    assert_eq!(result.ends_after_attachment, 0);
    assert_eq!(result.terminals_without_attachment, 1);
}
