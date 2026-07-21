//! Inline tests for the real-bytes XP3 round-trip module.
//!
//! These are the unit-level tests that exercise the read + repack pipeline
//! against synthetic raw AND zlib-indexed plain-XP3 fixtures without
//! requiring the separately licensed real corpus (the integration test
//! `tests/xp3_real_bytes_roundtrip.rs` covers the real-archive case via the
//! `KAIFUU_XP3_PROFILE_A_ARCHIVE` env gate). Splitting them out keeps the
//! parent module file `xp3_real_bytes_roundtrip.rs` under the 500-line cap.

use super::*;
use crate::tests::{Xp3TestEntry, plain_xp3_fixture};
use flate2::{Compression, write::ZlibEncoder};
use std::io::Write as _;

fn zlib_index_xp3_bytes(entries: &[Xp3TestEntry<'_>]) -> Vec<u8> {
    let raw = plain_xp3_fixture(entries);
    let index_offset = u64::from_le_bytes(
        raw[XP3_PLAIN_MAGIC.len()..XP3_PLAIN_MAGIC.len() + 8]
            .try_into()
            .unwrap(),
    ) as usize;
    let raw_index = &raw[index_offset + 9..];
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(raw_index).unwrap();
    let compressed = encoder.finish().unwrap();
    let mut out = raw[..index_offset].to_vec();
    out.push(XP3_INDEX_ENCODING_ZLIB);
    out.extend_from_slice(&(compressed.len() as u64).to_le_bytes());
    out.extend_from_slice(&(raw_index.len() as u64).to_le_bytes());
    out.extend_from_slice(&compressed);
    out
}

#[test]
fn read_preserves_zlib_index_encoding() {
    let raw = plain_xp3_fixture(&[Xp3TestEntry {
        path: "scenario/intro.ks",
        payload: b"profile A real-bytes identity case",
        compressed: false,
        adler32: 0x0102_0304,
    }]);
    let zlib = zlib_index_xp3_bytes(&[Xp3TestEntry {
        path: "scenario/intro.ks",
        payload: b"profile A real-bytes identity case",
        compressed: false,
        adler32: 0x0102_0304,
    }]);
    let raw_archive = read_real_bytes_xp3_archive(&raw).unwrap();
    let zlib_archive = read_real_bytes_xp3_archive(&zlib).unwrap();
    assert_eq!(raw_archive.index_encoding, XP3_INDEX_ENCODING_RAW);
    assert_eq!(zlib_archive.index_encoding, XP3_INDEX_ENCODING_ZLIB);
    assert!(zlib_archive.decoded_index_size.is_some());
    assert_eq!(raw_archive.entries, zlib_archive.entries);
}

#[test]
fn repack_is_byte_identical_for_raw_and_zlib() {
    let entries = &[
        Xp3TestEntry {
            path: "scenario/intro.ks",
            payload: b"profile A real-bytes identity case",
            compressed: false,
            adler32: 0x0102_0304,
        },
        Xp3TestEntry {
            path: "scenario/compressed.ks",
            payload: b"compressed public payload",
            compressed: true,
            adler32: 0x0a0b_0c0d,
        },
    ];
    let raw = plain_xp3_fixture(entries);
    let zlib = zlib_index_xp3_bytes(entries);
    let raw_archive = read_real_bytes_xp3_archive(&raw).unwrap();
    let zlib_archive = read_real_bytes_xp3_archive(&zlib).unwrap();
    let raw_rebuilt = repack_real_bytes_xp3_archive(&raw_archive).unwrap();
    let zlib_rebuilt = repack_real_bytes_xp3_archive(&zlib_archive).unwrap();
    assert_eq!(
        raw_rebuilt, raw,
        "raw-index source must round-trip byte-identical"
    );
    assert_eq!(
        zlib_rebuilt, zlib,
        "zlib-index source must round-trip byte-identical (encoded bytes preserved verbatim)"
    );
}

#[test]
fn repack_rejects_encrypted_marker() {
    let encrypted_marker = b"XP3\r\nXP3-CRYPT\nfixture-only encrypted archive";
    assert!(matches!(
        read_real_bytes_xp3_archive(encrypted_marker),
        Err(PlainXp3WriterError::UnsupportedEncrypted)
    ));
}

#[test]
fn adler_proof_recomputes_and_pairs_with_stored() {
    let entries = &[
        Xp3TestEntry {
            path: "scenario/intro.ks",
            payload: b"profile A real-bytes identity case",
            compressed: false,
            adler32: 0x1234_5678,
        },
        Xp3TestEntry {
            path: "image/title.png",
            payload: b"png fixture bytes",
            compressed: false,
            adler32: 0x5555_66ff,
        },
    ];
    let bytes = plain_xp3_fixture(entries);
    let archive = read_real_bytes_xp3_archive(&bytes).unwrap();
    let proofs = real_bytes_xp3_adler_proof(&archive).unwrap();
    assert_eq!(proofs.len(), entries.len());
    for ((path, proof), entry) in proofs.iter().zip(entries.iter()) {
        assert_eq!(*path, entry.path);
        assert_eq!(proof.recomputed, crate::compute_adler32(entry.payload));
        assert_eq!(proof.stored, Some(entry.adler32));
    }
}

#[test]
fn adler_proof_decompresses_compressed_segments_before_hashing() {
    let logical = b"compressed member checksum uses original bytes";
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(logical).unwrap();
    let stored = encoder.finish().unwrap();
    let archive = RealBytesXp3Archive {
        schema_version: REAL_BYTES_XP3_SCHEMA_VERSION.to_string(),
        variant: REAL_BYTES_XP3_VARIANT.to_string(),
        entries: vec![RealBytesXp3Entry {
            path: "scenario/compressed.ks".to_string(),
            original_size: logical.len() as u64,
            archive_size: stored.len() as u64,
            stored_adler32: Some(crate::compute_adler32(logical)),
            segments: vec![RealBytesXp3Segment {
                flags: 1,
                original_size: logical.len() as u64,
                archive_size: stored.len() as u64,
            }],
            payload: stored,
        }],
        index_encoding: XP3_INDEX_ENCODING_RAW,
        encoded_index: Vec::new(),
        decoded_index_size: None,
    };

    let proofs = real_bytes_xp3_adler_proof(&archive).unwrap();
    assert_eq!(proofs[0].1.recomputed, crate::compute_adler32(logical));
    assert_eq!(proofs[0].1.recomputed, proofs[0].1.stored.unwrap());
}
