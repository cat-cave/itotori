//! Public-boundary regressions for generic Softpal SELECT-label decoding.

use kaifuu_softpal::{
    RawCommand, SELECT_WORD_HI, SELECT_WORD_LO, ScriptScan, TEXTDAT_FLAG_PLAINTEXT,
    TEXTDAT_MAGIC_TAIL, TextDat,
};

fn op(id: u16) -> [u8; 4] {
    let mut token = [0; 4];
    token[..2].copy_from_slice(&id.to_le_bytes());
    token[2..].copy_from_slice(&1u16.to_le_bytes());
    token
}

fn word(value: u32) -> [u8; 4] {
    value.to_le_bytes()
}

fn script(tokens: &[[u8; 4]]) -> Vec<u8> {
    let mut bytes = Vec::from(&b"Sv20\0\0\0\0\0\0\0\0"[..]);
    for token in tokens {
        bytes.extend_from_slice(token);
    }
    bytes
}

fn textdat() -> Vec<u8> {
    let mut bytes = vec![TEXTDAT_FLAG_PLAINTEXT];
    bytes.extend_from_slice(TEXTDAT_MAGIC_TAIL);
    bytes.extend_from_slice(&2u32.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(b"Attack\0");
    bytes.extend_from_slice(&1u32.to_le_bytes());
    bytes.extend_from_slice(b"Defend\0");
    bytes
}

#[test]
fn follows_only_the_selects_typed_assignment_chain_to_a_plain_label() {
    const UNRELATED_SLOT: u32 = 0x4000_0002;
    const LABEL_SLOT: u32 = 0x4000_000a;
    const SELECT_SLOT: u32 = 0x4000_000c;
    const LABEL: u32 = 16;

    let tokens = [
        op(0x01),
        word(UNRELATED_SLOT),
        word(27), // Must not be selected by slot number.
        op(0x01),
        word(LABEL_SLOT),
        word(LABEL),
        op(0x01),
        word(SELECT_SLOT),
        word(LABEL_SLOT),
        op(0x1f),
        word(SELECT_SLOT),
        op(0x17),
        word((u32::from(SELECT_WORD_HI) << 16) | u32::from(SELECT_WORD_LO)),
        word(0),
    ];
    let bytes = script(&tokens);
    let scan = ScriptScan::parse(&bytes).expect("valid Sv20 script");

    let RawCommand::Select {
        decoupled_label: Some(label),
        ..
    } = &scan.commands[0]
    else {
        panic!("expected an indirect label from the select's own typed flow");
    };
    assert_eq!((label.pointer, label.field_offset), (LABEL, 32));
    assert_eq!(
        &bytes[label.field_offset..label.field_offset + 4],
        &LABEL.to_le_bytes()
    );

    let disassembly = scan.resolve(&TextDat::parse(&textdat()).expect("valid text pool"));
    assert_eq!(disassembly.choices[0].text.resolved_text(), Some("Attack"));
    assert_eq!(disassembly.choices[0].text.field_offset, label.field_offset);
}
