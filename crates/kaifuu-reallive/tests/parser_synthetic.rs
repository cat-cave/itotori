//! Synthetic per-opcode tests for the KAIFUU-191 real-RealLive parser.
//!
//! Each test constructs a small byte stream in the real-RealLive
//! opener-byte shape (per `docs/research/reallive-engine.md` §D) and
//! asserts the decoder produces the documented [`RealLiveOpcode`]
//! variant. The synthetic bytes here are authored from public RLDEV
//! documentation plus the in-tree research doc, never from retail bytes.
//!
//! These tests pair with the lib-internal unit tests under
//! `src/opcode.rs` to give the parser per-opcode round-trip coverage at
//! the public-API boundary.

use kaifuu_reallive::{
    RealLiveOpcode, RealLiveParseError, is_recognized_opener, is_shift_jis_textout_lead,
    parse_real_bytecode, parse_scene,
};

// ----- positive per-opcode encode/decode round-trips -----------------------

#[test]
fn meta_line_marker_round_trips_through_parse_scene() {
    // 0x0A + u16 LE line = 3 bytes total
    let bytes = &[0x0A, 0x05, 0x00];
    let opcodes = parse_scene(bytes).expect("decode");
    assert_eq!(opcodes.len(), 1);
    assert!(matches!(opcodes[0], RealLiveOpcode::MetaLine { line: 5 }));
}

#[test]
fn meta_entrypoint_marker_round_trips_through_parse_scene() {
    let bytes = &[0x21, 0x07, 0x00];
    let opcodes = parse_scene(bytes).expect("decode");
    assert!(matches!(
        opcodes[0],
        RealLiveOpcode::MetaEntrypoint { entrypoint: 7 }
    ));
}

#[test]
fn meta_kidoku_marker_round_trips_through_parse_scene() {
    let bytes = &[0x40, 0x09, 0x00];
    let opcodes = parse_scene(bytes).expect("decode");
    assert!(matches!(opcodes[0], RealLiveOpcode::MetaKidoku { mark: 9 }));
}

#[test]
fn comma_separator_bytes_recognized_in_both_forms() {
    let bytes = &[0x00, 0x2C];
    let opcodes = parse_scene(bytes).expect("decode");
    assert_eq!(opcodes.len(), 2);
    assert!(matches!(opcodes[0], RealLiveOpcode::Comma));
    assert!(matches!(opcodes[1], RealLiveOpcode::Comma));
}

#[test]
fn expression_element_preserves_body_bytes_until_next_recognized_opener() {
    // 0x24 ExpressionElement opener doubling as the `$` of a `$ 0xFF`
    // int-literal token (`0x24 0xFF` + i32 LE). The 4 payload bytes are
    // consumed whole — including `0x01`/`0x02`/etc. — and the element
    // terminates at its true 6-byte boundary, the following `0x0A`
    // MetaLine. The body bytes (everything after the opener) are
    // preserved verbatim for downstream tooling.
    let bytes = &[0x24, 0xFF, 0x01, 0x02, 0x03, 0x04, 0x0A, 0x02, 0x00];
    let opcodes = parse_scene(bytes).expect("decode");
    match &opcodes[0] {
        RealLiveOpcode::Expression { raw_bytes } => {
            // Body is the 5 bytes of the int-literal after the opener.
            assert_eq!(raw_bytes, &vec![0xFF, 0x01, 0x02, 0x03, 0x04]);
        }
        other => panic!("expected Expression, got {other:?}"),
    }
    assert!(matches!(opcodes[1], RealLiveOpcode::MetaLine { line: 2 }));
}

#[test]
fn command_text_display_classified_from_msg_module() {
    // module_type=1 (Kepago), module_id=3 (MSG), opcode=5 ∈ 1..=200
    let bytes = &[0x23, 1, 3, 5, 0, 0, 0, 0];
    let opcodes = parse_scene(bytes).expect("decode");
    assert!(matches!(opcodes[0], RealLiveOpcode::TextDisplay { .. }));
}

#[test]
fn command_character_text_display_classified_from_msg_opcode_3() {
    let bytes = &[0x23, 1, 3, 3, 0, 0, 0, 0];
    let opcodes = parse_scene(bytes).expect("decode");
    assert!(matches!(opcodes[0], RealLiveOpcode::CharacterTextDisplay));
}

#[test]
fn command_choice_classified_from_sel_module_with_two_choices() {
    // module=1.SEL(=5), opcode=0, argc=2, then '(' choice0 ',' choice1 ')'
    let bytes = &[
        0x23, 1, 5, 0, 0, 2, 0, 0, b'(', 0x61, 0x62, b',', 0x63, 0x64, b')',
    ];
    let opcodes = parse_scene(bytes).expect("decode");
    match &opcodes[0] {
        RealLiveOpcode::Choice { choices } => {
            assert_eq!(choices.len(), 2);
            assert_eq!(choices[0], vec![0x61, 0x62]);
            assert_eq!(choices[1], vec![0x63, 0x64]);
        }
        other => panic!("expected Choice, got {other:?}"),
    }
}

#[test]
fn command_goto_classified_from_jmp_module() {
    let bytes = &[0x23, 1, 1, 0, 0, 0, 0, 0];
    let opcodes = parse_scene(bytes).expect("decode");
    assert!(matches!(opcodes[0], RealLiveOpcode::Goto));
}

#[test]
fn command_branch_classified_from_jmp_module_goto_if_opcode() {
    let bytes = &[0x23, 1, 1, 2, 0, 0, 0, 0];
    let opcodes = parse_scene(bytes).expect("decode");
    assert!(matches!(opcodes[0], RealLiveOpcode::Branch));
}

#[test]
fn command_call_classified_from_jmp_module_gosub_opcode() {
    let bytes = &[0x23, 1, 1, 10, 0, 0, 0, 0];
    let opcodes = parse_scene(bytes).expect("decode");
    assert!(matches!(opcodes[0], RealLiveOpcode::Call));
}

#[test]
fn command_return_classified_from_jmp_module_ret_opcode() {
    let bytes = &[0x23, 1, 1, 20, 0, 0, 0, 0];
    let opcodes = parse_scene(bytes).expect("decode");
    assert!(matches!(opcodes[0], RealLiveOpcode::Return));
}

#[test]
fn command_jump_classified_from_jmp_module_jump_opcode() {
    let bytes = &[0x23, 1, 1, 30, 0, 0, 0, 0];
    let opcodes = parse_scene(bytes).expect("decode");
    assert!(matches!(opcodes[0], RealLiveOpcode::Jump));
}

#[test]
fn command_end_classified_from_sys_module_end_opcode() {
    let bytes = &[0x23, 1, 4, 17, 0, 0, 0, 0];
    let opcodes = parse_scene(bytes).expect("decode");
    assert!(matches!(opcodes[0], RealLiveOpcode::End));
}

#[test]
fn command_wait_classified_from_sys_module_wait_opcode() {
    let bytes = &[0x23, 1, 4, 100, 0, 0, 0, 0];
    let opcodes = parse_scene(bytes).expect("decode");
    assert!(matches!(opcodes[0], RealLiveOpcode::Wait { .. }));
}

#[test]
fn command_set_variable_classified_from_mem_module() {
    let bytes = &[0x23, 1, 11, 0, 0, 0, 0, 0];
    let opcodes = parse_scene(bytes).expect("decode");
    assert!(matches!(opcodes[0], RealLiveOpcode::SetVariable));
}

#[test]
fn command_background_classified_from_grp_module() {
    let bytes = &[0x23, 1, 33, 0, 0, 0, 0, 0];
    let opcodes = parse_scene(bytes).expect("decode");
    assert!(matches!(opcodes[0], RealLiveOpcode::Background { .. }));
}

#[test]
fn command_bgm_play_classified_from_bgm_module_opcode_zero() {
    let bytes = &[0x23, 1, 19, 0, 0, 0, 0, 0];
    let opcodes = parse_scene(bytes).expect("decode");
    assert!(matches!(opcodes[0], RealLiveOpcode::BgmPlay));
}

#[test]
fn command_bgm_stop_classified_from_bgm_module_high_opcode() {
    let bytes = &[0x23, 1, 19, 100, 0, 0, 0, 0];
    let opcodes = parse_scene(bytes).expect("decode");
    assert!(matches!(opcodes[0], RealLiveOpcode::BgmStop));
}

#[test]
fn command_voice_play_classified_from_koe_module() {
    let bytes = &[0x23, 1, 23, 0, 0, 0, 0, 0];
    let opcodes = parse_scene(bytes).expect("decode");
    assert!(matches!(opcodes[0], RealLiveOpcode::VoicePlay { .. }));
}

#[test]
fn shift_jis_textout_run_preserved_byte_equal_until_next_opener() {
    // SJIS double byte "ハ" (0x83 0x6E) + SJIS double byte "ロ" (0x83 0x8D)
    // + MetaLine.
    let bytes = &[0x83, 0x6E, 0x83, 0x8D, 0x0A, 0x05, 0x00];
    let opcodes = parse_scene(bytes).expect("decode");
    match &opcodes[0] {
        RealLiveOpcode::Textout { raw_bytes, .. } => {
            assert_eq!(raw_bytes, &vec![0x83, 0x6E, 0x83, 0x8D]);
        }
        other => panic!("expected Textout, got {other:?}"),
    }
    assert!(matches!(opcodes[1], RealLiveOpcode::MetaLine { line: 5 }));
}

// ----- negative path tests -------------------------------------------------

#[test]
fn empty_input_surfaces_truncated_bytecode_not_silent_ok() {
    let err = parse_real_bytecode(&[]).expect_err("must error");
    assert!(matches!(
        err,
        RealLiveParseError::TruncatedBytecode { input_len: 0 }
    ));
}

#[test]
fn truncated_meta_line_header_is_typed_error() {
    let err = parse_real_bytecode(&[0x0A, 0x05]).expect_err("truncated meta");
    assert!(matches!(
        err,
        RealLiveParseError::TruncatedMetaHeader { opener: 0x0A, .. }
    ));
}

#[test]
fn truncated_meta_entrypoint_header_is_typed_error() {
    let err = parse_real_bytecode(&[0x21, 0x07]).expect_err("truncated entrypoint");
    assert!(matches!(
        err,
        RealLiveParseError::TruncatedMetaHeader { opener: 0x21, .. }
    ));
}

#[test]
fn truncated_command_header_is_typed_error() {
    let err = parse_real_bytecode(&[0x23, 1, 5]).expect_err("truncated command");
    assert!(matches!(
        err,
        RealLiveParseError::TruncatedCommandHeader { .. }
    ));
}

#[test]
fn truncated_command_arg_list_without_closing_paren_is_typed_error() {
    // Command declares argc=2 with bracketed args but never closes the
    // `(` group. Should surface TruncatedCommandArgs, not panic.
    let bytes = &[0x23, 1, 5, 0, 0, 2, 0, 0, b'(', 0x61, b',', 0x62];
    let err = parse_real_bytecode(bytes).expect_err("truncated args");
    assert!(matches!(
        err,
        RealLiveParseError::TruncatedCommandArgs { .. }
    ));
}

#[test]
fn non_structural_lead_byte_is_preserved_as_textout_not_dropped() {
    // `0x55` is not one of the seven structural openers, so it begins a
    // Textout run (the catch-all per rlvm `BytecodeElement::Read`) that
    // ends at the following MetaLine. No byte is dropped or marked
    // Unknown — a well-formed stream partitions entirely into typed
    // elements.
    let bytes = &[0x55, 0x0A, 0x03, 0x00];
    let opcodes = parse_scene(bytes).expect("must decode despite non-structural lead");
    assert_eq!(opcodes.len(), 2);
    match &opcodes[0] {
        RealLiveOpcode::Textout { raw_bytes, .. } => {
            assert_eq!(raw_bytes, &vec![0x55]);
        }
        other => panic!("expected Textout for 0x55, got {other:?}"),
    }
    assert!(opcodes[0].is_recognized());
    assert!(matches!(opcodes[1], RealLiveOpcode::MetaLine { line: 3 }));
}

#[test]
fn command_with_unrecognized_module_id_preserved_with_command_opener() {
    // module_id 99 is not in the documented {SYS,MSG,SEL,JMP,MEM,STR,GRP,BGM,KOE} set.
    let bytes = &[0x23, 1, 99, 0, 0, 0, 0, 0];
    let opcodes = parse_scene(bytes).expect("decode");
    match &opcodes[0] {
        RealLiveOpcode::Unknown { opcode, raw_bytes } => {
            assert_eq!(*opcode, 0x23);
            assert!(raw_bytes.starts_with(&[0x23, 1, 99]));
        }
        other => panic!("expected Unknown for unrecognized module, got {other:?}"),
    }
}

// ----- partition / coverage helpers ----------------------------------------

#[test]
fn recognized_opener_table_matches_documented_research_doc_set() {
    // docs/research/reallive-engine.md §D opener table: 0x00, 0x0A,
    // 0x21, 0x23, 0x24, 0x2C, 0x40 + Shift-JIS leads.
    for byte in [0x00, 0x0A, 0x21, 0x23, 0x24, 0x2C, 0x40] {
        assert!(is_recognized_opener(byte), "byte {byte:#04x}");
    }
    assert!(is_shift_jis_textout_lead(0x81));
    assert!(is_shift_jis_textout_lead(0x9F));
    assert!(is_shift_jis_textout_lead(0xE0));
    assert!(is_shift_jis_textout_lead(0xFC));
    // Sanity: a few non-opener bytes should not be flagged.
    for byte in [0x01, 0x55, 0xA0, 0xDF, 0xFE] {
        assert!(!is_recognized_opener(byte), "byte {byte:#04x}");
    }
}

#[test]
fn recognition_predicate_matches_unknown_variant_inverse() {
    let recognized = RealLiveOpcode::MetaLine { line: 1 };
    assert!(recognized.is_recognized());
    let unknown = RealLiveOpcode::Unknown {
        opcode: 0x55,
        raw_bytes: vec![0x55],
    };
    assert!(!unknown.is_recognized());
}
