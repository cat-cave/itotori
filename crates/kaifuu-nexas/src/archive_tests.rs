use super::*;

// No real (copyrighted) bytes: every fixture is assembled here so the happy
// path, both index layouts, and every pack_type variant are exercised
// deterministically.

/// MSB-first bit writer matching `huffman`'s reader, plus a complete
/// depth-8 Huffman tree encoder (every byte -> its 8-bit path). Verbose on
/// the wire but a valid NeXAS Huffman stream the decoder accepts.
struct BitWriter {
    bytes: Vec<u8>,
    bit_pos: usize,
}
impl BitWriter {
    fn new() -> Self {
        Self {
            bytes: Vec::new(),
            bit_pos: 0,
        }
    }
    fn put_bit(&mut self, bit: u32) {
        if self.bit_pos.is_multiple_of(8) {
            self.bytes.push(0);
        }
        if bit & 1 != 0 {
            let byte = self.bytes.len() - 1;
            let shift = 7 - (self.bit_pos & 7);
            self.bytes[byte] |= 1 << shift;
        }
        self.bit_pos += 1;
    }
    fn put_bits(&mut self, value: u32, count: u32) {
        for i in (0..count).rev() {
            self.put_bit((value >> i) & 1);
        }
    }
}

// Emit a balanced Huffman tree over only the DISTINCT symbols present, in
// GARbro pre-order (1=internal then left,right; 0=leaf then 8-bit symbol),
// recording each symbol's code path. Keeps the packed index comfortably
// under GARbro's `index_size <= unpacked*2` sanity bound (a full 256-leaf
// tree would blow it for small indices).
fn huff_emit(
    w: &mut BitWriter,
    symbols: &[u8],
    code: u32,
    len: u32,
    codes: &mut std::collections::HashMap<u8, (u32, u32)>,
) {
    if symbols.len() == 1 {
        w.put_bit(0);
        w.put_bits(symbols[0] as u32, 8);
        codes.insert(symbols[0], (code, len));
        return;
    }
    w.put_bit(1);
    let mid = symbols.len() / 2;
    huff_emit(w, &symbols[..mid], code << 1, len + 1, codes);
    huff_emit(w, &symbols[mid..], (code << 1) | 1, len + 1, codes);
}

fn huffman_encode(data: &[u8]) -> Vec<u8> {
    let mut distinct: Vec<u8> = data.to_vec();
    distinct.sort_unstable();
    distinct.dedup();
    if distinct.is_empty() {
        distinct.push(0);
    }
    let mut w = BitWriter::new();
    let mut codes = std::collections::HashMap::new();
    huff_emit(&mut w, &distinct, 0, 0, &mut codes);
    for &b in data {
        let (code, len) = codes[&b];
        w.put_bits(code, len);
    }
    w.bytes
}

/// LZSS encode as all-literals (control bytes all-ones for full chunks).
fn lzss_encode_all_literals(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    for chunk in data.chunks(8) {
        let ctl = if chunk.len() == 8 {
            0xFF
        } else {
            (1u16 << chunk.len()) as u8 - 1
        };
        out.push(ctl);
        out.extend_from_slice(chunk);
    }
    out
}

/// zlib stream wrapping a single stored deflate block (RFC 1950/1951).
fn zlib_stored(payload: &[u8]) -> Vec<u8> {
    fn adler32(data: &[u8]) -> u32 {
        const MOD: u32 = 65521;
        let (mut a, mut b) = (1u32, 0u32);
        for &byte in data {
            a = (a + byte as u32) % MOD;
            b = (b + a) % MOD;
        }
        (b << 16) | a
    }
    let mut out = vec![0x78, 0x01, 0x01];
    let len = payload.len() as u16;
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(&(!len).to_le_bytes());
    out.extend_from_slice(payload);
    out.extend_from_slice(&adler32(payload).to_be_bytes());
    out
}

/// Encode a single entry payload under `pack_type`, returning the on-disk
/// (possibly compressed) bytes.
fn encode_payload(pack_type: Compression, payload: &[u8]) -> Vec<u8> {
    match pack_type {
        Compression::None => payload.to_vec(),
        Compression::Lzss => lzss_encode_all_literals(payload),
        Compression::Huffman => huffman_encode(payload),
        Compression::Deflate | Compression::DeflateOrNone | Compression::Other(_) => {
            zlib_stored(payload)
        }
    }
}

/// Build a NeXAS PAC with the tail Huffman ("new") index layout.
fn build_pac_tail(pack_type: Compression, files: &[(&str, &[u8])]) -> Vec<u8> {
    let count = files.len();
    // Entry payloads begin right after the 12-byte header.
    let mut buf = Vec::new();
    buf.extend_from_slice(NEXAS_PAC_MAGIC);
    buf.extend_from_slice(&(count as u32).to_le_bytes());
    buf.extend_from_slice(&pack_type.as_u32().to_le_bytes());

    let mut records = Vec::new();
    for (name, payload) in files {
        let on_disk = encode_payload(pack_type, payload);
        let offset = buf.len() as u32;
        let size = on_disk.len() as u32;
        let unpacked = payload.len() as u32;
        buf.extend_from_slice(&on_disk);

        let mut name_field = vec![0u8; NEXAS_NEW_INDEX_NAME_BYTE_LEN];
        let nb = name.as_bytes();
        name_field[..nb.len()].copy_from_slice(nb);
        records.extend_from_slice(&name_field);
        records.extend_from_slice(&offset.to_le_bytes());
        records.extend_from_slice(&unpacked.to_le_bytes());
        records.extend_from_slice(&size.to_le_bytes());
    }
    // Tail index: huffman-encode the records, invert every byte, then append
    // the 4-byte packed size.
    let packed = huffman_encode(&records);
    let inverted: Vec<u8> = packed.iter().map(|&b| !b).collect();
    buf.extend_from_slice(&inverted);
    buf.extend_from_slice(&(inverted.len() as u32).to_le_bytes());
    buf
}

/// Build a NeXAS PAC with the inline ("old") index at `0x0C`.
fn build_pac_inline(
    pack_type: Compression,
    name_length: usize,
    files: &[(&str, &[u8])],
) -> Vec<u8> {
    let count = files.len();
    let record_len = name_length + 12;
    let index_end = NEXAS_HEADER_BYTE_LEN + count * record_len;

    let mut payload_region = Vec::new();
    let mut records = Vec::new();
    for (name, payload) in files {
        let on_disk = encode_payload(pack_type, payload);
        let offset = (index_end + payload_region.len()) as u32;
        let size = on_disk.len() as u32;
        let unpacked = payload.len() as u32;
        payload_region.extend_from_slice(&on_disk);

        let mut name_field = vec![0u8; name_length];
        let nb = name.as_bytes();
        name_field[..nb.len()].copy_from_slice(nb);
        records.extend_from_slice(&name_field);
        records.extend_from_slice(&offset.to_le_bytes());
        records.extend_from_slice(&unpacked.to_le_bytes());
        records.extend_from_slice(&size.to_le_bytes());
    }

    let mut buf = Vec::new();
    buf.extend_from_slice(NEXAS_PAC_MAGIC);
    buf.extend_from_slice(&(count as u32).to_le_bytes());
    buf.extend_from_slice(&pack_type.as_u32().to_le_bytes());
    buf.extend_from_slice(&records);
    buf.extend_from_slice(&payload_region);
    buf
}

const SAMPLE: &[(&str, &[u8])] = &[
    ("system.dat", b"NeXAS system payload bytes"),
    (
        "script0001.bin",
        b"another entry, longer payload for coverage 0123456789",
    ),
    (
        "face_a.grp",
        &[0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x11, 0x22, 0x33],
    ),
];

fn assert_round_trip(pac: &[u8], files: &[(&str, &[u8])], layout: IndexLayout) {
    let arc = PacArchive::parse(pac).expect("well-formed synthetic PAC must parse");
    assert_eq!(arc.len(), files.len());
    assert_eq!(arc.index_layout(), layout);
    let names: Vec<&str> = arc.entries().iter().map(|e| e.name.as_str()).collect();
    let want: Vec<&str> = files.iter().map(|(n, _)| *n).collect();
    assert_eq!(names, want);
    for (name, payload) in files {
        let entry = arc.find(name).expect("entry present");
        assert_eq!(entry.unpacked_size as usize, payload.len());
        let got = arc.extract(pac, entry).expect("extract + decompress");
        assert_eq!(&got, payload, "round-trip bytes for {name}");
    }
}

#[test]
fn tail_index_stored_round_trips() {
    let pac = build_pac_tail(Compression::None, SAMPLE);
    assert_round_trip(&pac, SAMPLE, IndexLayout::TailHuffman);
}

#[test]
fn tail_index_lzss_round_trips() {
    let pac = build_pac_tail(Compression::Lzss, SAMPLE);
    assert_round_trip(&pac, SAMPLE, IndexLayout::TailHuffman);
}

#[test]
fn tail_index_huffman_round_trips() {
    let pac = build_pac_tail(Compression::Huffman, SAMPLE);
    assert_round_trip(&pac, SAMPLE, IndexLayout::TailHuffman);
}

#[test]
fn tail_index_deflate_round_trips() {
    // Mirrors the observed profile: pack_type=3, tail Huffman index, zlib entries.
    let pac = build_pac_tail(Compression::Deflate, SAMPLE);
    assert_round_trip(&pac, SAMPLE, IndexLayout::TailHuffman);
}

#[test]
fn deflate_or_none_stores_equal_size_entries() {
    // pack_type=4: an entry whose size == unpacked is stored verbatim.
    let files: &[(&str, &[u8])] = &[("verbatim.bin", b"stored under mode 4")];
    // Build tail index but force the payload stored (size == unpacked).
    let count = files.len();
    let mut buf = Vec::new();
    buf.extend_from_slice(NEXAS_PAC_MAGIC);
    buf.extend_from_slice(&(count as u32).to_le_bytes());
    buf.extend_from_slice(&Compression::DeflateOrNone.as_u32().to_le_bytes());
    let payload = files[0].1;
    let offset = buf.len() as u32;
    buf.extend_from_slice(payload);
    let mut records = vec![0u8; NEXAS_NEW_INDEX_NAME_BYTE_LEN];
    records[..files[0].0.len()].copy_from_slice(files[0].0.as_bytes());
    records.extend_from_slice(&offset.to_le_bytes());
    records.extend_from_slice(&(payload.len() as u32).to_le_bytes()); // unpacked
    records.extend_from_slice(&(payload.len() as u32).to_le_bytes()); // size == unpacked
    let packed = huffman_encode(&records);
    let inverted: Vec<u8> = packed.iter().map(|&b| !b).collect();
    buf.extend_from_slice(&inverted);
    buf.extend_from_slice(&(inverted.len() as u32).to_le_bytes());

    let arc = PacArchive::parse(&buf).expect("parse");
    let entry = &arc.entries()[0];
    assert!(!entry.is_packed, "mode 4 with size==unpacked is stored");
    let got = arc.extract(&buf, entry).expect("extract");
    assert_eq!(got, payload);
}

#[test]
fn inline_index_name20_round_trips() {
    let pac = build_pac_inline(Compression::None, 0x20, SAMPLE);
    assert_round_trip(&pac, SAMPLE, IndexLayout::Inline);
}

#[test]
fn inline_index_name40_deflate_round_trips() {
    // Force the 0x20 attempt to fail (a name longer than 0x20) so the parser
    // falls through to the 0x40 name-length attempt.
    let files: &[(&str, &[u8])] = &[(
        "a_rather_long_entry_name_over_thirty_two_bytes.bin",
        b"payload",
    )];
    let pac = build_pac_inline(Compression::Deflate, 0x40, files);
    assert_round_trip(&pac, files, IndexLayout::Inline);
}

#[test]
fn rejects_softpal_pac_space_magic() {
    // Softpal magic is "PAC " (0x20 at byte 3). It must NOT parse as NeXAS.
    let mut pac = build_pac_tail(Compression::Deflate, SAMPLE);
    pac[3] = 0x20; // "PAC " instead of "PAC\0"
    let err = PacArchive::parse(&pac).expect_err("Softpal magic must be rejected");
    assert!(matches!(err, PacError::BadMagic { .. }));
}

#[test]
fn nexas_magic_byte3_is_nul_not_space() {
    // Positive discrimination anchor: the NeXAS magic's 4th byte is 0x00.
    assert_eq!(NEXAS_PAC_MAGIC, b"PAC\0");
    assert_eq!(NEXAS_PAC_MAGIC[3], 0x00);
    assert_ne!(NEXAS_PAC_MAGIC[3], b' '); // 0x20 is Softpal
}

#[test]
fn truncated_header_is_typed_error() {
    let err = PacArchive::parse(&[0x50, 0x41, 0x43]).expect_err("too short");
    assert!(matches!(err, PacError::TruncatedHeader { observed_len: 3 }));
    assert!(err.to_string().starts_with(crate::NEXAS_PAC_ERROR_MARKER));
}

#[test]
fn bad_magic_is_typed_error() {
    let mut pac = build_pac_tail(Compression::None, SAMPLE);
    pac[0] = b'X';
    let err = PacArchive::parse(&pac).expect_err("bad magic");
    assert!(matches!(err, PacError::BadMagic { .. }));
}

#[test]
fn zero_count_is_insane() {
    let mut pac = build_pac_tail(Compression::None, SAMPLE);
    pac[NEXAS_COUNT_OFFSET..NEXAS_COUNT_OFFSET + 4].copy_from_slice(&0u32.to_le_bytes());
    let err = PacArchive::parse(&pac).expect_err("zero count");
    assert!(matches!(err, PacError::InsaneCount { count: 0 }));
}

#[test]
fn huge_count_is_insane() {
    let mut pac = build_pac_tail(Compression::None, SAMPLE);
    pac[NEXAS_COUNT_OFFSET..NEXAS_COUNT_OFFSET + 4]
        .copy_from_slice(&(NEXAS_PAC_MAX_ENTRIES + 1).to_le_bytes());
    let err = PacArchive::parse(&pac).expect_err("huge count");
    assert!(matches!(err, PacError::InsaneCount { .. }));
}

#[test]
fn corrupt_index_is_unreadable() {
    let mut pac = build_pac_tail(Compression::None, SAMPLE);
    // Corrupt the tail index-size dword so neither layout can parse.
    let n = pac.len();
    pac[n - 4..].copy_from_slice(&0x7FFF_FFFFu32.to_le_bytes());
    let err = PacArchive::parse(&pac).expect_err("corrupt index");
    assert!(matches!(err, PacError::IndexUnreadable { .. }));
}

#[test]
fn extract_rejects_mismatched_buffer() {
    let pac = build_pac_tail(Compression::None, SAMPLE);
    let arc = PacArchive::parse(&pac).unwrap();
    let entry = arc.entries()[0].clone();
    let mut other = pac.clone();
    other.push(0);
    let err = arc.extract(&other, &entry).expect_err("length mismatch");
    assert!(matches!(err, PacError::ArchiveLenMismatch { .. }));
}
