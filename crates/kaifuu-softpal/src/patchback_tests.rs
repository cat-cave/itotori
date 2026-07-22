use super::*;
use crate::{
    NO_SPEAKER_POINTER, SCRIPT_MAGIC_PREFIX, SELECT_WORD_HI, SELECT_WORD_LO, TEXT_SHOW_WORD_HI,
    TextDat,
};

/// Build a plaintext `TEXT.DAT` from `(index, cp932 text)` records and return
/// `(bytes, record_offsets)` so a test can point commands at exact records.
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

// The disassembler now derives commands from the `Sv20` arity-driven stack
// walk, so patch-back fixtures are real `Sv20` token programs (12-byte header +
// 4-byte tokens) built as the engine's push-then-`Call` TEXT-SHOW / SELECT
// idiom — the byte-locatable pointer fields the repointer rewrites.

fn opc(id: u16) -> [u8; 4] {
    let mut t = [0u8; 4];
    t[0..2].copy_from_slice(&id.to_le_bytes());
    t[2..4].copy_from_slice(&0x0001u16.to_le_bytes());
    t
}
fn word(v: u32) -> [u8; 4] {
    v.to_le_bytes()
}
fn call_target(category: u16, function: u16) -> u32 {
    (u32::from(category) << 16) | u32::from(function)
}

/// TEXT-SHOW idiom: text-ptr push, name-ptr push, filler push, then the `Call`.
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

/// SELECT idiom: immediate push then the `Call`.
fn select_tokens(immediate: u32) -> Vec<[u8; 4]> {
    vec![
        opc(0x1f),
        word(immediate),
        opc(0x17),
        word(call_target(SELECT_WORD_HI, SELECT_WORD_LO)),
        word(0x0000_0000),
    ]
}

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

/// A small but exhaustive fixture: three dialogue records + one speaker
/// record, a narration line, and a text-bearing choice.
fn fixture() -> (Vec<u8>, Vec<usize>, Vec<u8>) {
    let (textdat, recs) = build_textdat(&[
        (0, b"line one"),
        (1, b"Alice"),
        (2, b"line two is a good deal longer"),
        (3, b"a choice"),
    ]);
    let mut tokens = Vec::new();
    tokens.extend(text_show_tokens(recs[0] as u32, recs[1] as u32, 0x0002));
    tokens.extend(text_show_tokens(recs[2] as u32, NO_SPEAKER_POINTER, 0x0010));
    tokens.extend(select_tokens(recs[3] as u32));
    let script = sv_program(&tokens);
    (textdat, recs, script)
}

#[test]
fn identity_rebuild_is_byte_identical_plaintext() {
    let (textdat, _recs, script) = fixture();
    let pb = patchback(&textdat, &script, &TranslationMap::new()).unwrap();
    assert_eq!(pb.textdat, textdat, "plaintext TEXT.DAT byte-identical");
    assert_eq!(pb.script, script, "SCRIPT.SRC byte-identical");
    assert_eq!(pb.flag, EncFlag::Plaintext);
    assert_eq!(pb.translated_record_count, 0);
    // Every pool pointer (2 dialogue text + 1 speaker + 1 choice) repointed
    // to its own value; narration name pointer is skipped.
    assert_eq!(pb.repointed_field_count, 4);
}

#[test]
fn identity_rebuild_is_byte_identical_encrypted() {
    let (plain, _recs, script) = fixture();
    let enc = encrypt(&plain).unwrap();
    assert_eq!(enc[0], crate::TEXTDAT_FLAG_ENCRYPTED);
    let pb = patchback(&enc, &script, &TranslationMap::new()).unwrap();
    assert_eq!(pb.flag, EncFlag::Encrypted);
    assert_eq!(pb.textdat, enc, "encrypted TEXT.DAT byte-identical");
    assert_eq!(pb.script, script);
}

#[test]
fn translation_shifts_downstream_and_repoints_all_pointers() {
    let (textdat, recs, script) = fixture();
    // Translate the FIRST dialogue record to something LONGER so every later
    // record's offset shifts, forcing real repointing.
    let translations =
        TranslationMap::new().with(recs[0] as u32, "line one but now much much longer");
    let pb = patchback(&textdat, &script, &translations).unwrap();
    assert_eq!(pb.translated_record_count, 1);
    assert_ne!(pb.textdat, textdat, "pool changed");
    assert_ne!(pb.script, script, "downstream pointers moved");

    // Re-decode the patched files and check integrity + content.
    let new_textdat = TextDat::parse(&pb.textdat).unwrap();
    let scan = ScriptScan::parse(&pb.script).unwrap();
    let dis = scan.resolve(&new_textdat);

    // 100% pointer resolution preserved.
    assert!(dis.is_fully_resolved(), "all pointers resolve post-patch");
    assert_eq!(dis.dangling_pointer_count(), 0);

    // Translated dialogue shows the new text; out-of-scope units unchanged.
    assert_eq!(
        dis.dialogue[0].text.resolved_text(),
        Some("line one but now much much longer")
    );
    assert_eq!(
        dis.dialogue[0].speaker.as_ref().unwrap().resolved_text(),
        Some("Alice"),
        "speaker untranslated + still resolves"
    );
    assert_eq!(
        dis.dialogue[1].text.resolved_text(),
        Some("line two is a good deal longer"),
        "downstream dialogue unchanged, repointed"
    );
    assert!(dis.dialogue[1].speaker.is_none(), "narration preserved");
    assert_eq!(dis.choices[0].text.resolved_text(), Some("a choice"));

    // Record count preserved; header count matches.
    assert_eq!(new_textdat.header.record_count as usize, 4);
}

#[test]
fn shorter_translation_shifts_backward_and_stays_resolved() {
    let (textdat, recs, script) = fixture();
    // Shrink record 0.
    let translations = TranslationMap::new().with(recs[0] as u32, "hi");
    let pb = patchback(&textdat, &script, &translations).unwrap();
    let td = TextDat::parse(&pb.textdat).unwrap();
    let dis = ScriptScan::parse(&pb.script).unwrap().resolve(&td);
    assert!(dis.is_fully_resolved());
    assert_eq!(dis.dialogue[0].text.resolved_text(), Some("hi"));
    assert_eq!(
        dis.dialogue[1].text.resolved_text(),
        Some("line two is a good deal longer")
    );
}

#[test]
fn translate_choice_and_speaker_records() {
    let (textdat, recs, script) = fixture();
    let translations = TranslationMap::new()
        .with(recs[1] as u32, "Bob") // speaker
        .with(recs[3] as u32, "a much longer choice label"); // choice
    let pb = patchback(&textdat, &script, &translations).unwrap();
    assert_eq!(pb.translated_record_count, 2);
    let td = TextDat::parse(&pb.textdat).unwrap();
    let dis = ScriptScan::parse(&pb.script).unwrap().resolve(&td);
    assert!(dis.is_fully_resolved());
    assert_eq!(
        dis.dialogue[0].speaker.as_ref().unwrap().resolved_text(),
        Some("Bob")
    );
    assert_eq!(
        dis.choices[0].text.resolved_text(),
        Some("a much longer choice label")
    );
}

#[test]
fn cp932_roundtrip_for_japanese_translation() {
    let (textdat, recs, script) = fixture();
    // "こんにちは" — pure cp932-encodable.
    let translations = TranslationMap::new().with(recs[0] as u32, "こんにちは");
    let pb = patchback(&textdat, &script, &translations).unwrap();
    let td = TextDat::parse(&pb.textdat).unwrap();
    let dis = ScriptScan::parse(&pb.script).unwrap().resolve(&td);
    assert!(dis.is_fully_resolved());
    assert_eq!(dis.dialogue[0].text.resolved_text(), Some("こんにちは"));
}

#[test]
fn out_of_pool_select_and_narration_left_untouched() {
    // A narration text-show (no speaker) + a system SELECT (0x40000000).
    let (textdat, recs) = build_textdat(&[(0, b"only dialogue")]);
    let mut tokens = Vec::new();
    tokens.extend(text_show_tokens(recs[0] as u32, NO_SPEAKER_POINTER, 0x0002));
    tokens.extend(select_tokens(0x4000_0000));
    let script = sv_program(&tokens);

    // The absolute field offset of the system SELECT immediate, from the scan.
    let orig = ScriptScan::parse(&script).unwrap();
    let sel_field = orig
        .commands
        .iter()
        .find_map(|c| match c {
            RawCommand::Select {
                text_ptr_field_offset,
                ..
            } => Some(*text_ptr_field_offset),
            RawCommand::TextShow { .. } => None,
        })
        .expect("a select");

    let translations = TranslationMap::new().with(recs[0] as u32, "translated");
    let pb = patchback(&textdat, &script, &translations).unwrap();

    // The system SELECT immediate (0x40000000) must be byte-identical.
    assert_eq!(
        &pb.script[sel_field..sel_field + 4],
        &0x4000_0000u32.to_le_bytes()
    );
    // Exactly one pointer field (the dialogue text) repointed.
    assert_eq!(pb.repointed_field_count, 1);

    let td = TextDat::parse(&pb.textdat).unwrap();
    let dis = ScriptScan::parse(&pb.script).unwrap().resolve(&td);
    assert!(dis.dialogue[0].speaker.is_none());
    assert!(dis.choices[0].text.is_out_of_pool());
    assert!(dis.is_fully_resolved());
}

#[test]
fn unencodable_translation_is_typed_error() {
    let (textdat, recs, script) = fixture();
    // U+1F600 (emoji) has no cp932 encoding.
    let translations = TranslationMap::new().with(recs[0] as u32, "grin 😀");
    let err = patchback(&textdat, &script, &translations).unwrap_err();
    assert!(matches!(err, PatchbackError::Unencodable { .. }));
    assert!(err.to_string().starts_with(SOFTPAL_PATCHBACK_ERROR_MARKER));
}

#[test]
fn malformed_textdat_is_typed_error() {
    let (_t, _r, script) = fixture();
    let bad = b"not a textdat at all".to_vec();
    let err = patchback(&bad, &script, &TranslationMap::new()).unwrap_err();
    assert!(matches!(err, PatchbackError::TextDat(_)));
}

#[test]
fn malformed_script_is_typed_error() {
    let (textdat, _r, _s) = fixture();
    let bad_script = b"XX20 not a script".to_vec();
    let err = patchback(&textdat, &bad_script, &TranslationMap::new()).unwrap_err();
    assert!(matches!(err, PatchbackError::Script(_)));
}

#[test]
fn loose_file_drop_writes_both_files() {
    let (textdat, _recs, script) = fixture();
    let pb = patchback(&textdat, &script, &TranslationMap::new()).unwrap();
    let dir = std::env::temp_dir().join(format!(
        "kaifuu-softpal-patchback-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let (td_path, sc_path) = pb.write_loose_files(&dir).unwrap();
    assert_eq!(std::fs::read(&td_path).unwrap(), pb.textdat);
    assert_eq!(std::fs::read(&sc_path).unwrap(), pb.script);
    assert_eq!(td_path.file_name().unwrap(), PATCHBACK_TEXTDAT_NAME);
    assert_eq!(sc_path.file_name().unwrap(), PATCHBACK_SCRIPT_NAME);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn offset_map_records_every_record() {
    let (textdat, recs, script) = fixture();
    let pb = patchback(&textdat, &script, &TranslationMap::new()).unwrap();
    assert_eq!(pb.offset_map.len(), recs.len());
    // Identity map when nothing translated.
    for r in &recs {
        assert_eq!(pb.offset_map.get(*r as u32), Some(*r as u32));
    }
}
