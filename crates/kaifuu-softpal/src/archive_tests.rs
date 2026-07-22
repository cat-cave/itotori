use super::*;

// Build a minimal, well-formed PAC from (name, payload) pairs so the happy
// path and every malformed-input branch can be exercised without any real
// (copyrighted) bytes.
fn build_pac(files: &[(&str, &[u8])]) -> Vec<u8> {
    let count = files.len();
    let index_end = PAC_HEADER_BYTE_LEN + count * PAC_INDEX_ENTRY_BYTE_LEN;
    // Layout payloads back-to-back starting at index_end.
    let mut offsets = Vec::with_capacity(count);
    let mut cursor = index_end;
    for (_, payload) in files {
        offsets.push(cursor);
        cursor += payload.len();
    }
    let total = cursor;
    let mut buf = vec![0u8; total];
    buf[0..4].copy_from_slice(PAC_MAGIC);
    buf[PAC_COUNT_OFFSET..PAC_COUNT_OFFSET + 4].copy_from_slice(&(count as u32).to_le_bytes());
    for (i, (name, payload)) in files.iter().enumerate() {
        let e = PAC_HEADER_BYTE_LEN + i * PAC_INDEX_ENTRY_BYTE_LEN;
        let nb = name.as_bytes();
        buf[e..e + nb.len()].copy_from_slice(nb); // NUL padding already zeroed
        buf[e + PAC_ENTRY_NAME_BYTE_LEN..e + PAC_ENTRY_NAME_BYTE_LEN + 4]
            .copy_from_slice(&(payload.len() as u32).to_le_bytes());
        buf[e + PAC_ENTRY_NAME_BYTE_LEN + 4..e + PAC_ENTRY_NAME_BYTE_LEN + 8]
            .copy_from_slice(&(offsets[i] as u32).to_le_bytes());
        buf[offsets[i]..offsets[i] + payload.len()].copy_from_slice(payload);
    }
    buf
}

#[test]
fn parses_and_extracts_a_synthetic_pac() {
    let files: &[(&str, &[u8])] = &[
        ("SCRIPT.SRC", b"Sv-script-bytes"),
        ("TEXT.DAT", b"$TEXT_LIST__payload"),
        ("BGM_BASE.PGD", &[0xDE, 0xAD, 0xBE, 0xEF]),
    ];
    let pac = build_pac(files);
    let arc = PacArchive::parse(&pac).expect("well-formed synthetic PAC must parse");
    assert_eq!(arc.len(), 3);
    assert!(!arc.is_empty());

    let names: Vec<&str> = arc.entries().iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, ["SCRIPT.SRC", "TEXT.DAT", "BGM_BASE.PGD"]);

    for (name, payload) in files {
        let entry = arc.find(name).expect("entry present");
        assert_eq!(entry.size as usize, payload.len());
        let got = arc.extract(&pac, entry).expect("extract in-bounds entry");
        assert_eq!(got, *payload, "extracted bytes must equal the payload");
    }
}

#[test]
fn entry0_offset_equals_index_end_invariant_holds() {
    let pac = build_pac(&[("A.ANI", b"aaa"), ("B.ANI", b"bb")]);
    let arc = PacArchive::parse(&pac).unwrap();
    let index_end = PAC_HEADER_BYTE_LEN + 2 * PAC_INDEX_ENTRY_BYTE_LEN;
    assert_eq!(arc.entries()[0].offset as usize, index_end);
}

#[test]
fn truncated_header_is_typed_error() {
    let err = PacArchive::parse(&[0u8; 16]).expect_err("too short for header");
    assert!(matches!(
        err,
        PacError::TruncatedHeader { observed_len: 16 }
    ));
    assert!(err.to_string().starts_with(crate::SOFTPAL_PAC_ERROR_MARKER));
}

#[test]
fn bad_magic_is_typed_error() {
    let mut pac = build_pac(&[("A.ANI", b"aa")]);
    pac[0] = b'X';
    let err = PacArchive::parse(&pac).expect_err("bad magic");
    assert!(matches!(err, PacError::BadMagic { .. }));
}

#[test]
fn count_too_large_is_typed_error() {
    let mut pac = build_pac(&[("A.ANI", b"aa")]);
    pac[PAC_COUNT_OFFSET..PAC_COUNT_OFFSET + 4]
        .copy_from_slice(&(PAC_MAX_ENTRIES + 1).to_le_bytes());
    let err = PacArchive::parse(&pac).expect_err("count over sanity bound");
    assert!(matches!(err, PacError::CountTooLarge { .. }));
}

#[test]
fn truncated_index_is_typed_error() {
    // Claim more entries than the buffer can hold an index for.
    let mut pac = build_pac(&[("A.ANI", b"aa")]);
    pac[PAC_COUNT_OFFSET..PAC_COUNT_OFFSET + 4].copy_from_slice(&9999u32.to_le_bytes());
    let err = PacArchive::parse(&pac).expect_err("index runs past EOF");
    assert!(matches!(err, PacError::TruncatedIndex { count: 9999, .. }));
}

#[test]
fn index_end_mismatch_is_typed_error() {
    // Corrupt entry-0's offset so it no longer equals the count-derived
    // index_end.
    let mut pac = build_pac(&[("A.ANI", b"aaa"), ("B.ANI", b"bb")]);
    let entry0_off_field = PAC_HEADER_BYTE_LEN + PAC_ENTRY_NAME_BYTE_LEN + 4;
    let index_end = (PAC_HEADER_BYTE_LEN + 2 * PAC_INDEX_ENTRY_BYTE_LEN) as u32;
    pac[entry0_off_field..entry0_off_field + 4].copy_from_slice(&(index_end + 1).to_le_bytes());
    let err = PacArchive::parse(&pac).expect_err("entry-0 offset != index_end");
    assert!(matches!(err, PacError::IndexEndMismatch { .. }));
}

#[test]
fn entry_out_of_bounds_is_typed_error() {
    // Blow up entry-1's size so its payload runs past EOF.
    let mut pac = build_pac(&[("A.ANI", b"aaa"), ("B.ANI", b"bb")]);
    let e1_size_field = PAC_HEADER_BYTE_LEN + PAC_INDEX_ENTRY_BYTE_LEN + PAC_ENTRY_NAME_BYTE_LEN;
    pac[e1_size_field..e1_size_field + 4].copy_from_slice(&0xFFFF_FFFFu32.to_le_bytes());
    let err = PacArchive::parse(&pac).expect_err("payload past EOF");
    assert!(matches!(err, PacError::EntryOutOfBounds { index: 1, .. }));
}

#[test]
fn entry_overlapping_index_is_typed_error() {
    // Point entry-1 at an offset inside the header+index region.
    let mut pac = build_pac(&[("A.ANI", b"aaa"), ("B.ANI", b"bb")]);
    let e1_off_field = PAC_HEADER_BYTE_LEN + PAC_INDEX_ENTRY_BYTE_LEN + PAC_ENTRY_NAME_BYTE_LEN + 4;
    pac[e1_off_field..e1_off_field + 4].copy_from_slice(&0x100u32.to_le_bytes());
    let err = PacArchive::parse(&pac).expect_err("offset inside index region");
    assert!(matches!(err, PacError::EntryOverlapsIndex { index: 1, .. }));
}

#[test]
fn empty_entry_name_is_typed_error() {
    // Zero out entry-0's whole name field.
    let mut pac = build_pac(&[("A.ANI", b"aaa")]);
    for b in &mut pac[PAC_HEADER_BYTE_LEN..PAC_HEADER_BYTE_LEN + PAC_ENTRY_NAME_BYTE_LEN] {
        *b = 0;
    }
    let err = PacArchive::parse(&pac).expect_err("empty name");
    assert!(matches!(
        err,
        PacError::InvalidEntryName {
            index: 0,
            reason: "empty name"
        }
    ));
}

#[test]
fn non_ascii_entry_name_is_typed_error() {
    let mut pac = build_pac(&[("A.ANI", b"aaa")]);
    pac[PAC_HEADER_BYTE_LEN] = 0x80; // first name byte non-printable
    let err = PacArchive::parse(&pac).expect_err("non-ascii name");
    assert!(matches!(err, PacError::InvalidEntryName { index: 0, .. }));
}

#[test]
fn extract_rejects_mismatched_buffer() {
    let pac = build_pac(&[("A.ANI", b"aaa")]);
    let arc = PacArchive::parse(&pac).unwrap();
    let entry = arc.entries()[0].clone();
    let mut other = pac.clone();
    other.push(0); // length now differs
    let err = arc
        .extract(&other, &entry)
        .expect_err("buffer length mismatch");
    assert!(matches!(err, PacError::ArchiveLenMismatch { .. }));
}

#[test]
fn zero_entry_archive_parses_empty() {
    // count=0: index_end == header len, entry-0 invariant vacuous.
    let mut buf = vec![0u8; PAC_HEADER_BYTE_LEN];
    buf[0..4].copy_from_slice(PAC_MAGIC);
    // count field already zero
    let arc = PacArchive::parse(&buf).expect("zero-entry PAC is well-formed");
    assert!(arc.is_empty());
    assert_eq!(arc.len(), 0);
}
