use super::*;
use crate::{TEXTDAT_FLAG_PLAINTEXT, TEXTDAT_MAGIC_TAIL};

// Every fixture is a real `Sv20` program (12-byte program header + 4-byte
// arity-aligned tokens) so the arity-driven walk the disassembler now consumes
// types it exactly as the real bytecode. TEXT-SHOW / SELECT are built as the
// engine's push-then-`Call` idiom, matching the real layout the walk recovers:
// the text pointer is pushed to `m-20`, the speaker name to `m-12`, and the
// SELECT immediate to `m-4`, where `m` is the `Call` operator offset.

/// Read a little-endian `u32` at `off` (test-only helper).
fn read_u32_le(bytes: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]])
}

/// Build a plaintext `TEXT.DAT` from `(index, cp932 text)` records and return
/// `(bytes, record_offsets)` so tests can point commands at exact records.
fn build_textdat(records: &[(u32, &[u8])]) -> (Vec<u8>, Vec<usize>) {
    let mut buf = Vec::new();
    buf.push(TEXTDAT_FLAG_PLAINTEXT);
    buf.extend_from_slice(TEXTDAT_MAGIC_TAIL);
    buf.extend_from_slice(&(records.len() as u32).to_le_bytes());
    let mut offsets = Vec::with_capacity(records.len());
    for (index, text) in records {
        offsets.push(buf.len());
        buf.extend_from_slice(&index.to_le_bytes());
        buf.extend_from_slice(text);
        buf.push(0x00);
    }
    (buf, offsets)
}

/// One operator token `(id, 0x0001)`.
fn opc(id: u16) -> [u8; 4] {
    let mut t = [0u8; 4];
    t[0..2].copy_from_slice(&id.to_le_bytes());
    t[2..4].copy_from_slice(&0x0001u16.to_le_bytes());
    t
}
/// One raw operand/word token.
fn word(v: u32) -> [u8; 4] {
    v.to_le_bytes()
}
/// A `Call` first-operand (dispatch target) word from `(category, function)`.
fn call_target(category: u16, function: u16) -> u32 {
    (u32::from(category) << 16) | u32::from(function)
}

/// The push-then-`Call` **TEXT-SHOW** idiom: three arity-1 pushes (text ptr,
/// speaker name ptr, a filler window/message value) then `Call 0x17` to the
/// text category with the given text-type function. Lands text at `m-20`,
/// speaker name at `m-12` (`m` = the `Call` operator offset).
fn text_show_tokens(text_ptr: u32, name_ptr: u32, text_type: u16) -> Vec<[u8; 4]> {
    vec![
        opc(0x1f),
        word(text_ptr),
        opc(0x1f),
        word(name_ptr),
        opc(0x1f),
        word(0x0000_0000),
        opc(0x17),
        word(call_target(TEXT_SHOW_WORD_HI, text_type)),
        word(0x0000_0000),
    ]
}

/// The push-then-`Call` **SELECT** idiom: one arity-1 push of the immediate,
/// then `Call 0x17` to the select target. Lands the immediate at `m-4`.
fn select_tokens(immediate: u32) -> Vec<[u8; 4]> {
    vec![
        opc(0x1f),
        word(immediate),
        opc(0x17),
        word(call_target(SELECT_WORD_HI, SELECT_WORD_LO)),
        word(0x0000_0000),
    ]
}

/// A generic typed `Move` assignment.
fn move_tokens(destination: u32, source: u32) -> Vec<[u8; 4]> {
    vec![opc(0x01), word(destination), word(source)]
}

/// A 12-byte `Sv20` program header (`"Sv20"` + two header dwords) + tokens.
fn sv_program(tokens: &[[u8; 4]]) -> Vec<u8> {
    let mut s = Vec::new();
    s.extend_from_slice(SCRIPT_MAGIC_PREFIX);
    s.extend_from_slice(b"20");
    s.extend_from_slice(&0u32.to_le_bytes());
    s.extend_from_slice(&0u32.to_le_bytes());
    for t in tokens {
        s.extend_from_slice(t);
    }
    s
}

#[test]
fn header_parses_version_and_rejects_bad_magic() {
    let s = sv_program(&[]);
    assert_eq!(ScriptHeader::parse(&s).unwrap().version, *b"20");
    assert_eq!(ScriptHeader::parse(&s).unwrap().version_str(), "20");

    let bad = b"XX20".to_vec();
    assert!(matches!(
        ScriptHeader::parse(&bad),
        Err(ScriptError::BadMagic { .. })
    ));
    assert!(matches!(
        ScriptHeader::parse(&[0x53]),
        Err(ScriptError::TruncatedHeader { observed_len: 1 })
    ));
}

#[test]
fn derives_text_show_and_select_with_correct_offsets_and_speaker() {
    // Two records so a text pointer and a name pointer both resolve. ASCII
    // text keeps the fixture cp932-clean (the codec decodes Shift-JIS).
    let (textdat_bytes, recs) = build_textdat(&[(0, b"Hello there"), (1, b"Alice")]);
    let text_ptr = recs[0] as u32;
    let name_ptr = recs[1] as u32;

    // Stream: a text-show WITH speaker, a narration text-show (no speaker),
    // then a select — in that play order.
    let mut tokens = Vec::new();
    tokens.extend(text_show_tokens(text_ptr, name_ptr, 0x0002));
    tokens.extend(text_show_tokens(text_ptr, NO_SPEAKER_POINTER, 0x0010));
    tokens.extend(select_tokens(text_ptr));
    let script = sv_program(&tokens);

    let scan = ScriptScan::parse(&script).unwrap();
    assert_eq!(scan.text_show_count(), 2);
    assert_eq!(scan.text_show_with_speaker_count(), 1);
    assert_eq!(scan.select_count(), 1);

    // Command offset is the `Call` operator offset minus its in-command offset
    // (24 for text-show, 8 for select). A text-show idiom is 9 tokens (36
    // bytes) with its `Call` at token 6 (+24); a select idiom is 5 tokens (20
    // bytes) with its `Call` at token 2 (+8). Tokens begin after the 12-byte
    // program header.
    let base = crate::SV_PROGRAM_HEADER_BYTE_LEN;
    let first_call = base + 24; // TS0 idiom @ base, Call at +24
    assert_eq!(scan.commands[0].command_offset(), first_call - 24);
    let second_call = base + 36 + 24; // TS1 idiom @ base+36
    assert_eq!(scan.commands[1].command_offset(), second_call - 24);
    let third_call = base + 72 + 8; // SELECT idiom @ base+72, Call at +8
    assert_eq!(scan.commands[2].command_offset(), third_call - 8);

    let textdat = TextDat::parse(&textdat_bytes).unwrap();
    let dis = scan.resolve(&textdat);
    assert_eq!(dis.dialogue.len(), 2);
    assert_eq!(dis.choices.len(), 1);
    assert!(dis.is_fully_resolved());

    // Unit 0: resolved dialogue + resolved speaker, byte-locatable fields.
    let d0 = &dis.dialogue[0];
    assert_eq!(d0.text.pointer, text_ptr);
    assert_eq!(d0.text.field_offset, first_call - 20);
    assert_eq!(read_u32_le(&script, d0.text.field_offset), text_ptr);
    assert_eq!(d0.text.resolved_text(), Some("Hello there"));
    let sp = d0.speaker.as_ref().expect("has speaker");
    assert_eq!(sp.pointer, name_ptr);
    assert_eq!(sp.field_offset, first_call - 12);
    assert_eq!(sp.resolved_text(), Some("Alice"));

    // Unit 1: narration => 0x0FFFFFFF => speaker None.
    assert!(dis.dialogue[1].speaker.is_none());

    // Choice resolves to the same record text (text-bearing choice).
    assert_eq!(dis.choices[0].text.resolved_text(), Some("Hello there"));
    assert_eq!(dis.text_bearing_choice_count(), 1);
    assert_eq!(dis.nontext_select_count(), 0);
    assert_eq!(dis.dangling_pointer_count(), 0);
}

#[test]
fn text_show_type_function_02_is_not_misread_as_select() {
    // A text-show with function 0x0002 dispatches to the TEXT category
    // (0x0002), NOT the SELECT category (0x0006). Guards the discriminator.
    let (textdat_bytes, recs) = build_textdat(&[(0, b"x")]);
    let tokens = text_show_tokens(recs[0] as u32, NO_SPEAKER_POINTER, 0x0002);
    let script = sv_program(&tokens);
    let scan = ScriptScan::parse(&script).unwrap();
    assert_eq!(scan.text_show_count(), 1);
    assert_eq!(scan.select_count(), 0);
    let _ = TextDat::parse(&textdat_bytes).unwrap();
}

#[test]
fn operator_looking_operand_is_not_misread_as_command() {
    // THE consolidation guarantee: an operand whose little-endian bytes are
    // exactly the `Call` operator dword `17 00 01 00` (raw value 0x0001_0017),
    // immediately followed by an operand whose bytes are `02 00 02 00` (a
    // TEXT-SHOW discriminator), is consumed by the arity walk as two operands
    // of a binary Expr op — NOT re-read as a phantom TEXT-SHOW `Call`. The old
    // `17 00 01 00` marker scan WOULD have emitted a phantom command here.
    let (textdat_bytes, recs) = build_textdat(&[(0, b"real choice")]);

    // Some nullary filler so the trap operands are deep enough that the old
    // marker scan would compute a valid (non-underflowing) command offset.
    let mut tokens = vec![opc(0x18), opc(0x18), opc(0x18)];
    // A binary op whose two operands are the operator-looking trap bytes.
    tokens.push(opc(0x01));
    tokens.push(word(0x0001_0017)); // bytes: 17 00 01 00 (the Call dword)
    tokens.push(word(call_target(TEXT_SHOW_WORD_HI, 0x0002))); // bytes: 02 00 02 00
    // One genuine SELECT so there is a real command to count against.
    tokens.extend(select_tokens(recs[0] as u32));
    let script = sv_program(&tokens);

    // The trap operand really carries the Call dword bytes (offset 28: after
    // the 12-byte header, 3 nullary operators and 1 binary operator token).
    let trap_field = crate::SV_PROGRAM_HEADER_BYTE_LEN + 4 * 4;
    assert_eq!(&script[trap_field..trap_field + 4], SCRIPT_COMMAND_MARKER);

    let scan = ScriptScan::parse(&script).unwrap();
    // No phantom TEXT-SHOW from the trap operand; exactly the genuine SELECT.
    assert_eq!(
        scan.text_show_count(),
        0,
        "trap operand not a phantom command"
    );
    assert_eq!(scan.select_count(), 1);

    let dis = scan.resolve(&TextDat::parse(&textdat_bytes).unwrap());
    assert_eq!(dis.dialogue.len(), 0);
    assert_eq!(dis.choices[0].text.resolved_text(), Some("real choice"));
    assert!(dis.is_fully_resolved());
}

#[test]
fn dangling_pointer_is_recorded_not_panicked() {
    // A record with a long enough text that pointer+1 is still inside the
    // pool (so name_ptr lands mid-record => Dangling, not OutOfPool).
    let (textdat_bytes, recs) = build_textdat(&[(0, b"a real dialogue line")]);
    let bogus = recs[0] as u32 + 1; // inside the pool, off a boundary
    let tokens = text_show_tokens(recs[0] as u32, bogus, 0x0002);
    let script = sv_program(&tokens);
    let scan = ScriptScan::parse(&script).unwrap();
    let dis = scan.resolve(&TextDat::parse(&textdat_bytes).unwrap());
    assert_eq!(dis.unresolved_dialogue_text_count(), 0);
    assert_eq!(dis.unresolved_speaker_count(), 1);
    assert_eq!(dis.dangling_pointer_count(), 1);
    assert!(!dis.is_fully_resolved());
    // The unit still exists, speaker present but dangling.
    let sp = dis.dialogue[0].speaker.as_ref().unwrap();
    assert_eq!(sp.pointer, bogus);
    assert!(sp.is_dangling());
    assert!(!sp.is_resolved());
}

#[test]
fn out_of_pool_select_immediate_is_not_dangling() {
    // A SELECT whose typed immediate lies far past the pool is a system/branch
    // select: OutOfPool, not a dangling failure.
    let (textdat_bytes, _recs) = build_textdat(&[(0, b"only record")]);
    let tokens = select_tokens(0x4000_0000);
    let script = sv_program(&tokens);
    let scan = ScriptScan::parse(&script).unwrap();
    let dis = scan.resolve(&TextDat::parse(&textdat_bytes).unwrap());
    assert_eq!(dis.choices.len(), 1);
    assert!(dis.choices[0].text.is_out_of_pool());
    assert_eq!(dis.nontext_select_count(), 1);
    assert_eq!(dis.text_bearing_choice_count(), 0);
    assert_eq!(dis.dangling_pointer_count(), 0);
    // No dialogue/speaker failures + zero dangling => fully resolved holds.
    assert!(dis.is_fully_resolved());
}

#[test]
fn truncated_command_is_typed_error() {
    // A `Call` classified TEXT-SHOW at the very first token offset (12): its
    // text pointer field would sit at 12-20 (underflow) — the pushes that
    // carry it are not in the stream => TruncatedCommand, not a silent drop.
    let tokens = [
        opc(0x17),
        word(call_target(TEXT_SHOW_WORD_HI, 0x0002)),
        word(0x0000_0000),
    ];
    let s = sv_program(&tokens);
    let err = ScriptScan::parse(&s).expect_err("truncated text-show command");
    assert!(matches!(
        err,
        ScriptError::TruncatedCommand {
            marker_offset: 12,
            needed_before: 24,
            kind: "text-show"
        }
    ));
    assert!(
        err.to_string()
            .starts_with(crate::SOFTPAL_SCRIPT_ERROR_MARKER)
    );
}

#[test]
fn non_text_call_targets_are_ignored() {
    // A `Call` to an unrelated engine built-in (graphics category 0x0011) is
    // neither TEXT-SHOW nor SELECT — it produces no command in this module.
    let tokens = [
        opc(0x1f),
        word(0x0000_0001),
        opc(0x17),
        word(call_target(0x0011, 0x0008)),
        word(0x0000_0005),
    ];
    let s = sv_program(&tokens);
    let scan = ScriptScan::parse(&s).unwrap();
    assert_eq!(scan.commands.len(), 0);
}

#[test]
fn empty_and_headerless_inputs_are_typed_errors() {
    assert!(matches!(
        ScriptScan::parse(&[]),
        Err(ScriptError::TruncatedHeader { observed_len: 0 })
    ));
    // A valid 4-byte header but no `Sv20` token stream => no commands (the walk
    // needs the 12-byte program header before it yields anything).
    let scan = ScriptScan::parse(b"Sv20").unwrap();
    assert_eq!(scan.commands.len(), 0);
    assert_eq!(scan.header.version, *b"20");
}

#[test]
fn genuine_system_select_without_label_stays_out_of_pool() {
    // A SELECT with a typed immediate and no assignment chain is a system/menu
    // select that must remain OutOfPool (never force-resolved).
    let (td_bytes, _recs) = build_textdat(&[(0, b"only record")]);
    let mut tokens = vec![opc(0x18)]; // nullary control filler (no operands)
    tokens.extend(select_tokens(0x4000_0000));
    let s = sv_program(&tokens);
    let scan = ScriptScan::parse(&s).unwrap();
    assert_eq!(scan.select_count(), 1);
    match &scan.commands[0] {
        RawCommand::Select {
            decoupled_label, ..
        } => assert!(decoupled_label.is_none(), "no typed label flow"),
        other @ RawCommand::TextShow { .. } => panic!("expected Select, got {other:?}"),
    }
    let dis = scan.resolve(&TextDat::parse(&td_bytes).unwrap());
    assert!(dis.choices[0].text.is_out_of_pool());
    assert_eq!(dis.text_bearing_choice_count(), 0);
    assert_eq!(dis.nontext_select_count(), 1);
    assert_eq!(dis.dangling_pointer_count(), 0);
}

#[test]
fn decoupled_scan_is_bounded_by_intervening_text_show() {
    // A full indirect chain, then a TEXT-SHOW, then its SELECT: the backwards
    // dataflow must stop at the TEXT-SHOW boundary, so it cannot borrow the
    // far label.
    let (td_bytes, recs) = build_textdat(&[(0, b"FarLabel"), (1, b"a line")]);
    let far_label = recs[0] as u32;
    let mut tokens = Vec::new();
    let label_slot = 0x4000_000a;
    let select_slot = 0x4000_000c;
    tokens.extend(move_tokens(label_slot, far_label));
    tokens.extend(move_tokens(select_slot, label_slot));
    tokens.extend(text_show_tokens(recs[1] as u32, NO_SPEAKER_POINTER, 0x0002));
    tokens.extend(select_tokens(select_slot));
    let s = sv_program(&tokens);
    let scan = ScriptScan::parse(&s).unwrap();
    let sel = scan
        .commands
        .iter()
        .find(|c| matches!(c, RawCommand::Select { .. }))
        .expect("a select");
    match sel {
        RawCommand::Select {
            decoupled_label, ..
        } => assert!(
            decoupled_label.is_none(),
            "label beyond the text-show boundary must not be followed"
        ),
        RawCommand::TextShow { .. } => unreachable!(),
    }
    // And it stays OutOfPool on resolve.
    let dis = scan.resolve(&TextDat::parse(&td_bytes).unwrap());
    let choice = dis.choices.first().expect("a choice");
    assert!(choice.text.is_out_of_pool());
}

#[test]
fn direct_immediate_label_wins_when_an_indirect_chain_is_present() {
    // Guards both encodings coexisting: a resolving immediate always wins over
    // an indirect chain in the same menu block.
    let (td_bytes, recs) = build_textdat(&[(0, b"ImmChoice"), (1, b"SlotChoice")]);
    let immediate = recs[0] as u32;
    let slot_label = recs[1] as u32;
    let mut tokens = Vec::new();
    // An indirect chain would resolve, but so does the direct immediate.
    tokens.extend(move_tokens(0x4000_000a, slot_label));
    tokens.extend(move_tokens(0x4000_000c, 0x4000_000a));
    tokens.extend(select_tokens(immediate));
    let s = sv_program(&tokens);
    let scan = ScriptScan::parse(&s).unwrap();
    let dis = scan.resolve(&TextDat::parse(&td_bytes).unwrap());
    assert_eq!(dis.choices.len(), 1);
    // The immediate label wins.
    assert_eq!(dis.choices[0].text.resolved_text(), Some("ImmChoice"));
    assert_eq!(dis.text_bearing_choice_count(), 1);
}
