use super::*;

/// Build a well-formed **plaintext** `TEXT.DAT` from `(index, cp932 text)`
/// records so every branch can be exercised without any real bytes.
fn build_plaintext(records: &[(u32, &[u8])]) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.push(TEXTDAT_FLAG_PLAINTEXT);
    buf.extend_from_slice(TEXTDAT_MAGIC_TAIL);
    buf.extend_from_slice(&(records.len() as u32).to_le_bytes());
    assert_eq!(buf.len(), TEXTDAT_HEADER_BYTE_LEN);
    for (index, text) in records {
        buf.extend_from_slice(&index.to_le_bytes());
        buf.extend_from_slice(text);
        buf.push(0x00);
    }
    buf
}

#[test]
fn parses_header_flag_and_count() {
    let plain = build_plaintext(&[(0, b"AB"), (1, b"CD")]);
    let h = TextDatHeader::parse(&plain).unwrap();
    assert_eq!(h.flag, EncFlag::Plaintext);
    assert_eq!(h.record_count, 2);

    // Same bytes, flipped flag byte => Encrypted.
    let mut enc = plain.clone();
    enc[0] = TEXTDAT_FLAG_ENCRYPTED;
    assert_eq!(TextDatHeader::parse(&enc).unwrap().flag, EncFlag::Encrypted);
}

#[test]
fn plaintext_records_parse_with_offsets() {
    let plain = build_plaintext(&[(7, b"hello"), (9, b"")]);
    let recs = parse_records(&plain).unwrap();
    assert_eq!(recs.len(), 2);

    assert_eq!(recs[0].index, 7);
    assert_eq!(recs[0].offset, 16);
    assert_eq!(recs[0].text_offset, 20);
    assert_eq!(recs[0].text, "hello");
    assert_eq!(recs[0].raw_text, b"hello");

    // Second record starts right after the first record's NUL:
    // 16 + 4 + 5 + 1 = 26.
    assert_eq!(recs[1].index, 9);
    assert_eq!(recs[1].offset, 26);
    assert_eq!(recs[1].text_offset, 30);
    assert_eq!(recs[1].text, "");
}

#[test]
fn cp932_text_decodes_to_utf8() {
    // "あ" (U+3042) in Shift-JIS/cp932 is 0x82 0xA0.
    let plain = build_plaintext(&[(0, &[0x82, 0xA0])]);
    let recs = parse_records(&plain).unwrap();
    assert_eq!(recs[0].text, "あ");
}

#[test]
fn decrypt_encrypt_round_trip_and_flag_flip() {
    // Enough records that the cipher's per-dword shift progression and the
    // "leave last dword untouched" bound are meaningfully exercised.
    let plain = build_plaintext(&[
        (0, b"first line of text"),
        (1, &[0x82, 0xA0, 0x82, 0xA2]),
        (2, b"third"),
        (3, b"a longer fourth record to span several dwords"),
    ]);

    // encrypt then decrypt is identity, and the flag byte flips both ways.
    let enc = encrypt(&plain).unwrap();
    assert_eq!(enc[0], TEXTDAT_FLAG_ENCRYPTED);
    assert_ne!(&enc[16..], &plain[16..], "pool must actually change");
    assert_eq!(&enc[1..16], &plain[1..16], "header tail/count untouched");

    let round = decrypt(&enc).unwrap();
    assert_eq!(round[0], TEXTDAT_FLAG_PLAINTEXT);
    assert_eq!(round, plain, "decrypt(encrypt(x)) == x byte-for-byte");

    // And decrypt is idempotent on already-plaintext input.
    assert_eq!(decrypt(&plain).unwrap(), plain);
    // encrypt is idempotent on already-encrypted input.
    assert_eq!(encrypt(&enc).unwrap(), enc);
}

#[test]
fn textdat_parse_on_encrypted_matches_plaintext_records() {
    let plain = build_plaintext(&[(0, b"one"), (1, b"two"), (2, b"three")]);
    let enc = encrypt(&plain).unwrap();

    let from_plain = TextDat::parse(&plain).unwrap();
    let from_enc = TextDat::parse(&enc).unwrap();

    assert_eq!(from_enc.header.flag, EncFlag::Encrypted);
    assert_eq!(from_plain.header.flag, EncFlag::Plaintext);
    assert_eq!(from_enc.records, from_plain.records);
    assert_eq!(
        from_enc.records.len(),
        from_enc.header.record_count as usize
    );
}

#[test]
fn bad_magic_is_typed_error() {
    let mut plain = build_plaintext(&[(0, b"x")]);
    plain[5] = b'!'; // corrupt the magic tail
    assert!(matches!(
        TextDatHeader::parse(&plain),
        Err(TextDatError::BadMagic { .. })
    ));
}

#[test]
fn invalid_flag_is_typed_error() {
    let mut plain = build_plaintext(&[(0, b"x")]);
    plain[0] = b'?';
    assert!(matches!(
        TextDatHeader::parse(&plain),
        Err(TextDatError::InvalidFlag { found: b'?', .. })
    ));
}

#[test]
fn truncated_header_is_typed_error() {
    assert!(matches!(
        TextDatHeader::parse(&[0x24, 0x54, 0x45]),
        Err(TextDatError::TruncatedHeader { observed_len: 3 })
    ));
}

#[test]
fn unterminated_record_is_typed_error() {
    // Header claims 1 record, but the text has no NUL terminator.
    let mut buf = Vec::new();
    buf.push(TEXTDAT_FLAG_PLAINTEXT);
    buf.extend_from_slice(TEXTDAT_MAGIC_TAIL);
    buf.extend_from_slice(&1u32.to_le_bytes());
    buf.extend_from_slice(&0u32.to_le_bytes()); // index
    buf.extend_from_slice(b"no terminator here");
    assert!(matches!(
        parse_records(&buf),
        Err(TextDatError::UnterminatedRecord { record: 0, .. })
    ));
}

#[test]
fn truncated_record_index_is_typed_error() {
    // One full record, then 2 stray trailing bytes — too few for another
    // record's 4-byte index. (Header count is irrelevant here: the pool
    // itself is malformed before the count check.)
    let mut buf = Vec::new();
    buf.push(TEXTDAT_FLAG_PLAINTEXT);
    buf.extend_from_slice(TEXTDAT_MAGIC_TAIL);
    buf.extend_from_slice(&1u32.to_le_bytes());
    buf.extend_from_slice(&0u32.to_le_bytes());
    buf.extend_from_slice(b"a");
    buf.push(0x00);
    buf.extend_from_slice(&[0xAA, 0xBB]); // 2 bytes < 4-byte index
    assert!(matches!(
        parse_records(&buf),
        Err(TextDatError::TruncatedRecordIndex { record: 1, .. })
    ));
}

#[test]
fn record_count_mismatch_is_typed_error() {
    // The pool holds exactly two clean records, but the header declares
    // five: a whole-pool count mismatch (distinct from a truncated record).
    let mut buf = Vec::new();
    buf.push(TEXTDAT_FLAG_PLAINTEXT);
    buf.extend_from_slice(TEXTDAT_MAGIC_TAIL);
    buf.extend_from_slice(&5u32.to_le_bytes()); // claim 5 ...
    for (i, t) in [(0u32, b"one".as_slice()), (1u32, b"two".as_slice())] {
        buf.extend_from_slice(&i.to_le_bytes());
        buf.extend_from_slice(t);
        buf.push(0x00);
    }
    // ... but only 2 records are present, ending exactly at the pool end.
    assert!(matches!(
        parse_records(&buf),
        Err(TextDatError::RecordCountMismatch {
            header_count: 5,
            parsed_count: 2
        })
    ));
}

#[test]
fn undercount_header_is_count_mismatch() {
    // Three real records but the header claims two: the pool over-runs the
    // declared count, also a RecordCountMismatch.
    let mut buf = Vec::new();
    buf.push(TEXTDAT_FLAG_PLAINTEXT);
    buf.extend_from_slice(TEXTDAT_MAGIC_TAIL);
    buf.extend_from_slice(&2u32.to_le_bytes()); // claim 2 ...
    for (i, t) in [
        (0u32, b"a".as_slice()),
        (1u32, b"b".as_slice()),
        (2u32, b"c".as_slice()),
    ] {
        buf.extend_from_slice(&i.to_le_bytes());
        buf.extend_from_slice(t);
        buf.push(0x00);
    }
    assert!(matches!(
        parse_records(&buf),
        Err(TextDatError::RecordCountMismatch {
            header_count: 2,
            parsed_count: 3
        })
    ));
}
