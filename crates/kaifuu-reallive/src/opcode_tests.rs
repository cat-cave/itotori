use super::*;

#[test]
fn empty_input_surfaces_truncated_bytecode_not_silent_ok() {
    let err = parse_real_bytecode(&[]).expect_err("empty input must error");
    assert!(matches!(
        err,
        RealLiveParseError::TruncatedBytecode { input_len: 0 }
    ));
}

#[test]
fn decodes_documented_scene_1_prologue_into_documented_meta_run() {
    // First 16 bytes of the documented decompressed scene per
    // the bytecode-format mechanism reference §4.2.
    let bytes: &[u8] = &[
        0x0a, 0x02, 0x00, 0x0a, 0x03, 0x00, 0x21, 0x00, 0x00, 0x0a, 0x04, 0x00, 0x0a, 0x05, 0x00,
        0x0a,
    ];
    let _ = parse_real_bytecode(bytes); // 16-byte feed runs into a partial MetaLine
    // Documented: MetaLine(2), MetaLine(3), MetaEntrypoint(0),
    // MetaLine(4), MetaLine(5), then a partial MetaLine that runs
    // off the end → TruncatedMetaHeader. We pass only the 15 bytes
    // that align to a clean element boundary:
    let bytes = &bytes[..15];
    let opcodes = parse_real_bytecode(bytes).expect("decode must succeed");
    assert_eq!(opcodes.len(), 5);
    assert!(matches!(opcodes[0], RealLiveOpcode::MetaLine { line: 2 }));
    assert!(matches!(opcodes[1], RealLiveOpcode::MetaLine { line: 3 }));
    assert!(matches!(
        opcodes[2],
        RealLiveOpcode::MetaEntrypoint { entrypoint: 0 }
    ));
    assert!(matches!(opcodes[3], RealLiveOpcode::MetaLine { line: 4 }));
    assert!(matches!(opcodes[4], RealLiveOpcode::MetaLine { line: 5 }));
}

#[test]
fn truncated_meta_header_is_typed_error_not_panic() {
    let bytes = &[opener::META_LINE, 0x02]; // truncated line marker
    let err = parse_real_bytecode(bytes).expect_err("must reject truncated header");
    assert!(matches!(
        err,
        RealLiveParseError::TruncatedMetaHeader { opener: 0x0A, .. }
    ));
}

#[test]
fn non_structural_lead_byte_decodes_as_textout_not_unknown() {
    // `0x55` is not a structural opener, so it begins a Textout run
    // (the catch-all per rlvm `BytecodeElement::Read`) that ends at
    // the following MetaLine opener. No byte is dropped or marked
    // Unknown — every byte partitions into a typed element.
    let bytes = &[0x55, opener::META_LINE, 0x07, 0x00];
    let opcodes = parse_real_bytecode(bytes).expect("non-structural lead tolerated");
    assert_eq!(opcodes.len(), 2);
    match &opcodes[0] {
        RealLiveOpcode::Textout { raw_bytes, .. } => assert_eq!(raw_bytes, &vec![0x55]),
        other => panic!("expected Textout, got {other:?}"),
    }
    assert!(opcodes.iter().all(RealLiveOpcode::is_recognized));
    assert!(matches!(opcodes[1], RealLiveOpcode::MetaLine { line: 7 }));
}

#[test]
fn unrecognized_signature_names_uncatalogued_command_tuple() {
    // 8-byte CommandElement header + MetaLine terminator. module_type 1
    // (in-space) with an UNCATALOGUED (module_id 99, opcode 999) → the
    // generic `Command` blob that fails `is_recognized`.
    let bytes = &[
        opener::COMMAND,
        1,
        99,
        0xE7,
        0x03, // opcode 999 (0x03E7) little-endian
        0,
        0, // argc = 0
        0, // overload
        opener::META_LINE,
        0x05,
        0x00,
    ];
    let opcodes = parse_real_bytecode(bytes).expect("decode must succeed");
    assert!(matches!(
        opcodes[0],
        RealLiveOpcode::Command {
            module_type: 1,
            module_id: 99,
            opcode: 999,
            ..
        }
    ));
    assert!(!opcodes[0].is_recognized());
    assert_eq!(opcodes[0].unrecognized_signature(), Some((1, 99, 999)));

    let histogram = unrecognized_opcode_histogram(&opcodes);
    assert_eq!(histogram.get(&(1, 99, 999)), Some(&1));
    assert_eq!(histogram.len(), 1);
}

#[test]
fn unrecognized_signature_is_empty_for_fully_recognized_stream() {
    // module_type 1, module_id 4 (sys), opcode 17 → `End` (catalogued),
    // then a MetaLine. Every element is a recognised family, so the
    // un-recognised histogram is empty (the 100%-decode property).
    let bytes = &[
        opener::COMMAND,
        1,
        4,
        17,
        0,
        0,
        0,
        0,
        opener::META_LINE,
        0x05,
        0x00,
    ];
    let opcodes = parse_real_bytecode(bytes).expect("decode must succeed");
    assert!(opcodes.iter().all(RealLiveOpcode::is_recognized));
    assert!(
        opcodes
            .iter()
            .all(|op| op.unrecognized_signature().is_none())
    );
    assert!(unrecognized_opcode_histogram(&opcodes).is_empty());
}

#[test]
fn command_header_truncation_is_typed_error() {
    let bytes = &[opener::COMMAND, 1, 5]; // only 3 of 8 header bytes
    let err = parse_real_bytecode(bytes).expect_err("must reject truncated command");
    assert!(matches!(
        err,
        RealLiveParseError::TruncatedCommandHeader { .. }
    ));
}

#[test]
fn command_with_recognized_module_classifies_to_named_variant() {
    // Construct a module_msg TextDisplay-shaped command: header
    // (0x23, 1, 3=MSG, 5=opcode_u16_le_lo, 0=opcode_u16_le_hi, 0=argc,
    // 0=overload, 0=reserved) with no argument list. Opcode 5 is in the
    // catalogued message allow-list.
    let bytes = &[opener::COMMAND, 1, module_id::MSG, 5, 0, 0, 0, 0];
    let opcodes = parse_real_bytecode(bytes).expect("must decode");
    assert_eq!(opcodes.len(), 1);
    // MSG opcode 3 is CharacterTextDisplay; this catalogued text opcode
    // classifies as TextDisplay.
    assert!(matches!(opcodes[0], RealLiveOpcode::TextDisplay { .. }));
}

#[test]
fn pcm_wav_loop_is_catalogued_as_recognized_audio() {
    // `module_pcm` is `(module_type=1, module_id=21)`; its opcode 2
    // is `wavLoop`. The semantic catalogue must admit the tuple so the
    // already-typed audio family does not fall back to generic Command.
    let bytes = &[opener::COMMAND, 1, 21, 2, 0, 0, 0, 0];
    let opcodes = parse_real_bytecode(bytes).expect("must decode");
    assert_eq!(opcodes.len(), 1);
    assert!(matches!(
        opcodes[0],
        RealLiveOpcode::Audio {
            module_id: 21,
            opcode: 2
        }
    ));
    assert!(opcodes[0].is_recognized());
}

#[test]
fn out_of_space_module_type_preserved_as_unknown_with_command_opener() {
    // `Unknown` is now reserved for the desync tripwire: a command
    // header whose module_type is outside RealLive's documented
    // `{0, 1, 2}` space. Such a header (module_type=14) is preserved
    // verbatim for audit rather than coalesced into a generic Command.
    let bytes = &[opener::COMMAND, 14, 99, 0xFF, 0xFF, 0, 0, 0];
    let opcodes = parse_real_bytecode(bytes).expect("must decode");
    assert_eq!(opcodes.len(), 1);
    match &opcodes[0] {
        RealLiveOpcode::Unknown { opcode, raw_bytes } => {
            assert_eq!(*opcode, opener::COMMAND);
            assert!(raw_bytes.starts_with(&[opener::COMMAND, 14, 99]));
        }
        other => panic!("expected Unknown, got {other:?}"),
    }
}

#[test]
fn in_space_uncatalogued_module_is_generic_command_and_fails_recognition() {
    // An in-space (module_type <= 2) command at a module_id no semantic
    // family covers (99) decodes to the generic typed Command — NOT
    // `Unknown` (it is structurally framed), but it is NOT recognised:
    // an un-catalogued tuple must fail the semantic-zero gate rather
    // than masquerade as decoded. (Every module_id present on the real
    // Proven test corpora land in a named family, so this never
    // fires there.)
    let bytes = &[opener::COMMAND, 1, 99, 0xFF, 0xFF, 0, 0, 0];
    let opcodes = parse_real_bytecode(bytes).expect("must decode");
    assert_eq!(opcodes.len(), 1);
    assert!(matches!(
        opcodes[0],
        RealLiveOpcode::Command {
            module_type: 1,
            module_id: 99,
            opcode: 0xFFFF,
            ..
        }
    ));
    assert!(
        !opcodes[0].is_recognized(),
        "an un-catalogued in-space tuple must FAIL recognition"
    );
}

#[test]
fn unknown_opcode_inside_known_module_is_generic_command_and_fails_recognition() {
    // RealLive command opcodes are u16; 0xffff is the synthetic stand-in
    // property is that a plausible module id no longer buckets every
    // opcode to SystemControl.
    let bytes = &[opener::COMMAND, 1, module_id::SYS2, 0xFF, 0xFF, 0, 0, 0];
    let opcodes = parse_real_bytecode(bytes).expect("must decode");
    assert_eq!(opcodes.len(), 1);
    assert!(matches!(
        opcodes[0],
        RealLiveOpcode::Command {
            module_type: 1,
            module_id: module_id::SYS2,
            opcode: 0xFFFF,
            ..
        }
    ));
    assert!(
        !opcodes[0].is_recognized(),
        "an unknown opcode inside a known module must FAIL recognition"
    );
}

#[test]
fn catalogued_modules_classify_to_named_semantic_families() {
    // Spot-check the new semantic families across the module space so a
    // real-game tuple can never silently fall back to generic Command.
    type Case = (u8, u8, u16, fn(&RealLiveOpcode) -> bool);
    let cases: &[Case] = &[
        // module 2 (Sel) non-select op -> SelectionControl.
        (0, 2, 30, |o| {
            matches!(o, RealLiveOpcode::SelectionControl { opcode: 30 })
        }),
        // module 3 (Msg) window directive (>200) -> MessageControl.
        (0, 3, 201, |o| {
            matches!(o, RealLiveOpcode::MessageControl { opcode: 201 })
        }),
        // module 4 (Sys) control tail -> SystemControl.
        (1, 4, 130, |o| {
            matches!(o, RealLiveOpcode::SystemControl { opcode: 130 })
        }),
        // module 5 (Sys2) -> SystemControl.
        (1, 5, 120, |o| {
            matches!(o, RealLiveOpcode::SystemControl { opcode: 120 })
        }),
        // module 10 (variable/flag) -> VariableOp.
        (1, 10, 100, |o| {
            matches!(o, RealLiveOpcode::VariableOp { opcode: 100 })
        }),
        // module 20/21/22 (audio channels) -> Audio.
        (1, 20, 0, |o| {
            matches!(
                o,
                RealLiveOpcode::Audio {
                    module_id: 20,
                    opcode: 0
                }
            )
        }),
        // module 30/60/62 (screen / animation / effect layer) -> ScreenControl.
        (1, 62, 10, |o| {
            matches!(
                o,
                RealLiveOpcode::ScreenControl {
                    module_id: 62,
                    opcode: 10
                }
            )
        }),
        // module 72/81/82 (display object planes) -> GraphicsObject.
        (1, 82, 1000, |o| {
            matches!(
                o,
                RealLiveOpcode::GraphicsObject {
                    module_id: 82,
                    opcode: 1000
                }
            )
        }),
        // module_type 2 range form of an object module -> GraphicsObject.
        (2, 81, 1064, |o| {
            matches!(
                o,
                RealLiveOpcode::GraphicsObject {
                    module_id: 81,
                    opcode: 1064
                }
            )
        }),
    ];
    for &(mt, mid, op, pred) in cases {
        let bytes = &[
            opener::COMMAND,
            mt,
            mid,
            (op & 0xFF) as u8,
            (op >> 8) as u8,
            0,
            0,
            0,
        ];
        let opcodes = parse_real_bytecode(bytes).expect("must decode");
        assert_eq!(opcodes.len(), 1, "{mt}:{mid}:{op}");
        assert!(
            pred(&opcodes[0]),
            "{mt}:{mid}:{op} did not classify to its semantic family: {:?}",
            opcodes[0]
        );
        assert!(
            opcodes[0].is_recognized(),
            "{mt}:{mid}:{op} semantic family must be recognised"
        );
    }
}

#[test]
fn comma_opener_is_recognized() {
    let bytes = &[opener::META_COMMA, opener::COMMA];
    let opcodes = parse_real_bytecode(bytes).expect("must decode");
    assert_eq!(opcodes.len(), 2);
    assert!(matches!(opcodes[0], RealLiveOpcode::Comma));
    assert!(matches!(opcodes[1], RealLiveOpcode::Comma));
}

#[test]
fn shift_jis_textout_run_is_recognized_and_byte_equal() {
    // Shift-JIS string for "ハ" (0x83 0x6E) followed by MetaLine.
    // The Textout run extends across one SJIS double-byte.
    let bytes = &[0x83, 0x6E, opener::META_LINE, 0x05, 0x00];
    let opcodes = parse_real_bytecode(bytes).expect("must decode");
    assert_eq!(opcodes.len(), 2);
    match &opcodes[0] {
        RealLiveOpcode::Textout { raw_bytes, .. } => {
            assert_eq!(raw_bytes, &vec![0x83, 0x6E]);
        }
        other => panic!("expected Textout, got {other:?}"),
    }
    assert!(matches!(opcodes[1], RealLiveOpcode::MetaLine { line: 5 }));
}

#[test]
fn command_arglist_int_literal_payload_with_delimiter_bytes_does_not_misterminate() {
    // Bug: the arglist scanner split on raw 0x28 '(' / 0x29 ')' /
    // 0x2C ',' without honoring the 0xFF int-literal introducer.
    // Here a single argument is a 0xFF int literal whose 4 LE payload
    // bytes are exactly [0x29 ')', 0x2C ',', 0x28 '(', 0x00] — every
    // delimiter value. The literal must be consumed whole so the
    // arglist closes at the REAL trailing ')', and the following
    // MetaLine decodes aligned with zero unknown opcodes.
    // module_sys (id=4) opcode 100 == Wait, argc=1; first_arg_as_i32
    // decodes the int literal, so asserting duration_ms proves all 4
    // payload bytes (incl. the delimiter-valued ones) landed in the
    // argument rather than splitting it.
    let bytes = &[
        opener::COMMAND,
        1,
        module_id::SYS,
        100,
        0, // opcode_u16 = 100 (Wait)
        1, // argc
        0, // overload
        0, // reserved
        b'(',
        0xFF,
        0x29,
        0x2C,
        0x28,
        0x00, // i32 LE literal = 0x00282C29
        b')',
        opener::META_LINE,
        0x07,
        0x00,
    ];
    let opcodes = parse_real_bytecode(bytes).expect("must decode");
    assert!(
        opcodes.iter().all(RealLiveOpcode::is_recognized),
        "no element may misalign into Unknown: {opcodes:?}"
    );
    assert_eq!(
        opcodes.len(),
        2,
        "arglist must close at the real ')': {opcodes:?}"
    );
    // The full i32 literal 0x00282C29 is surfaced verbatim (no u16
    // truncation) — proves the full 5-byte literal (incl.
    // 0x29/0x2C/0x28) was captured as one arg.
    assert!(
        matches!(
            opcodes[0],
            RealLiveOpcode::Wait {
                duration_ms: Some(0x0028_2C29)
            }
        ),
        "expected Wait with full-range literal-derived duration, got {:?}",
        opcodes[0]
    );
    assert!(
        matches!(opcodes[1], RealLiveOpcode::MetaLine { line: 7 }),
        "stream must stay aligned after the arglist: {:?}",
        opcodes[1]
    );
}

#[test]
fn wait_and_id_operands_preserve_full_magnitude_and_sign_no_unsigned_abs() {
    // 007 regression: operand literals were narrowed via
    // `unsigned_abs as u16/u32`, silently truncating any value above
    // u16::MAX and flipping the sign of negative literals. The decoded
    // surface must now carry the literal's real range.

    // Wait with a 100000 ms duration (> u16::MAX = 65535). Old code
    // truncated to (100000 & 0xFFFF) = 34464; the i32 surface keeps it.
    let mut wait = vec![opener::COMMAND, 1, module_id::SYS, 100, 0, 1, 0, 0];
    wait.extend_from_slice(&[b'(', EXPR_INT_LITERAL]);
    wait.extend_from_slice(&100_000i32.to_le_bytes());
    wait.push(b')');
    let opcodes = parse_real_bytecode(&wait).expect("wait decodes");
    assert!(
        matches!(
            opcodes[0],
            RealLiveOpcode::Wait {
                duration_ms: Some(100_000)
            }
        ),
        "duration must survive above u16::MAX, got {:?}",
        opcodes[0]
    );

    // Background (module_grp) sprite id carrying a negative literal
    // -5 (= 0xFFFF_FFFB). Old code's unsigned_abs flipped it to 5; the
    // bit-reinterpreting `as u32` preserves the literal's bit pattern.
    let mut bg = vec![opener::COMMAND, 1, module_id::GRP, 0x49, 0, 1, 0, 0];
    bg.extend_from_slice(&[b'(', EXPR_INT_LITERAL]);
    bg.extend_from_slice(&(-5i32).to_le_bytes());
    bg.push(b')');
    let opcodes = parse_real_bytecode(&bg).expect("background decodes");
    assert!(
        matches!(
            opcodes[0],
            RealLiveOpcode::Background {
                sprite_id: Some(0xFFFF_FFFB)
            }
        ),
        "negative id literal must keep its bit pattern (no unsigned_abs flip), got {:?}",
        opcodes[0]
    );
}

#[path = "opcode_tests/scalar_and_flow.rs"]
mod scalar_and_flow;

#[path = "opcode_tests/expression.rs"]
mod expression;
