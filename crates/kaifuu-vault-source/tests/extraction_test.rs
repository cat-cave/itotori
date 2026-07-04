//! Extraction integration tests.

// reason: test names embed UPPER_SNAKE schema/env identifiers verbatim for grep-ability.
#![allow(non_snake_case)]

mod common;

use std::io::Cursor;

use kaifuu_vault_source::{
    ClaimQuery, LocalCorpusSource, MaterializeOptions, ScratchConfig, VaultConfig, VaultSource,
    VaultSourceError, extraction,
};
use sevenz_rust2::{ArchiveEntry, ArchiveWriter};

fn open_source(v: &common::SyntheticVault) -> VaultSource {
    common::isolate_ambient_vault_env();
    VaultSource::open(
        &VaultConfig {
            vault_root_override: Some(v.vault_root.clone()),
        },
        &ScratchConfig {
            scratch_root_override: Some(v.scratch_root.clone()),
        },
    )
    .unwrap()
}

#[test]
fn materialize_raises_ExtractionUnsafePath_for_path_traversal_fixture() {
    let v = common::SyntheticVault::build();
    let source = open_source(&v);
    let candidate = source
        .discover(&ClaimQuery::ByReleaseId { release_id: 14 })
        .unwrap()
        .pop()
        .unwrap();
    let err = source
        .materialize(&candidate, MaterializeOptions::default())
        .unwrap_err();
    assert!(
        matches!(
            err,
            VaultSourceError::ExtractionUnsafePath {
                reason: "parent-dir",
                ..
            }
        ),
        "expected ExtractionUnsafePath{{parent-dir}}, got {err:?}"
    );
}

/// Regression guard for the KAIFUU-236 guard-ordering law: the
/// path-traversal check must fire on the archive HEADER (the declared entry
/// paths) BEFORE — and independent of — the 7z content decoder.
///
/// Here the traversal entry `../escape.txt` carries a deliberately-corrupted
/// (undecodable) content stream: `sevenz_rust2::Archive::open` still parses
/// the header and reports the entry name, but any attempt to decompress its
/// content errors out. If the guard ever regressed to classifying entries
/// only inside the decode callback (the pre-2026-07 ordering), the decoder
/// would error first and the failure would surface as a bare
/// `ExtractionFailed{7z decoder error}` — a DISABLED security assertion —
/// instead of the typed `ExtractionUnsafePath{parent-dir}` the security
/// contract mandates. This exercises the real production `extract_archive`
/// so the ordering is proven, not assumed.
#[test]
fn extract_rejects_path_traversal_even_when_entry_content_is_undecodable() {
    // Build a valid 7z whose header declares a parent-dir traversal entry
    // (plus one innocuous entry), then corrupt the packed-content region so
    // the entry bytes are undecodable while the header stays intact.
    let mut bytes = {
        let buf = Cursor::new(Vec::<u8>::new());
        let mut w = ArchiveWriter::new(buf).unwrap();
        for (name, data) in [
            ("safe/ok.txt", &b"HELLO"[..]),
            // Long-enough payload to guarantee a non-empty packed region to
            // corrupt below.
            (
                "../escape.txt",
                &b"GOTCHA-padding-to-ensure-packed-bytes"[..],
            ),
        ] {
            w.push_archive_entry::<&[u8]>(ArchiveEntry::new_file(name), Some(data))
                .unwrap();
        }
        w.finish().unwrap().into_inner()
    };
    // 7z signature-header layout: bytes 12..20 = NextHeaderOffset (u64 LE),
    // measured from the end of the 32-byte signature header. The packed
    // content therefore occupies `[32, 32 + NextHeaderOffset)`; corrupting a
    // byte strictly inside that window damages the decode stream without ever
    // touching the NextHeader metadata (its CRC is validated by `open`).
    let next_header_offset = u64::from_le_bytes(bytes[12..20].try_into().unwrap()) as usize;
    assert!(
        next_header_offset >= 2,
        "expected a non-trivial packed-content region to corrupt"
    );
    bytes[32 + next_header_offset / 2] ^= 0xFF;
    bytes[33] ^= 0xFF;

    let dir = tempfile::tempdir().unwrap();
    let archive_path = dir.path().join("undecodable-traversal.7z");
    std::fs::write(&archive_path, &bytes).unwrap();

    // Sanity: the content really is undecodable (guards the guard — if this
    // ever decodes cleanly, the test no longer proves the ordering).
    assert!(
        sevenz_rust2::decompress_file(&archive_path, dir.path().join("decode-probe")).is_err(),
        "fixture content must be undecodable for this regression guard to be meaningful"
    );

    let scratch = dir.path().join("scratch");
    let paths = extraction::ScratchPaths::compose(&scratch, "v9999", "run-0");

    let err = extraction::extract_archive(&archive_path, &paths).unwrap_err();
    assert!(
        matches!(
            err,
            VaultSourceError::ExtractionUnsafePath {
                reason: "parent-dir",
                ..
            }
        ),
        "traversal entry with undecodable content must still be rejected as \
         ExtractionUnsafePath{{parent-dir}} (header pre-scan is authoritative over \
         the decoder), got {err:?}"
    );
    // And nothing may have been written to the extraction root.
    assert!(
        !paths.extracted_root.exists(),
        "no bytes may be written when a traversal entry is rejected"
    );
}

#[test]
fn removes_per_run_extraction_directory_on_extraction_failure() {
    let v = common::SyntheticVault::build();
    let source = open_source(&v);
    let candidate = source
        .discover(&ClaimQuery::ByReleaseId { release_id: 14 })
        .unwrap()
        .pop()
        .unwrap();
    let _err = source
        .materialize(&candidate, MaterializeOptions::default())
        .unwrap_err();
    // After failure, scratch must not contain a leftover run dir for this game.
    let game_root = v.scratch_root.join("v5000");
    if game_root.exists() {
        // Allow the game-root dir itself to exist; assert no run-id
        // subdir survives.
        for e in std::fs::read_dir(&game_root).unwrap() {
            let e = e.unwrap();
            let name = e.file_name().into_string().unwrap();
            // Marker file (.last-canonical-id) is fine; run dirs are not.
            assert!(
                name.starts_with('.'),
                "leftover run dir survived failure: {name}"
            );
        }
    }
}

#[test]
fn does_not_write_any_file_under_vault_root_during_a_materialize_call() {
    let v = common::SyntheticVault::build();
    let before = common::snapshot_tree(&v.vault_root);
    let source = open_source(&v);
    let candidate = source
        .discover(&ClaimQuery::ByReleaseId { release_id: 10 })
        .unwrap()
        .pop()
        .unwrap();
    let _ = source
        .materialize(&candidate, MaterializeOptions::default())
        .unwrap();
    let after = common::snapshot_tree(&v.vault_root);
    // The vault root tree must be entirely unchanged: same paths, same
    // mtimes.
    assert_eq!(before.len(), after.len());
    for (b, a) in before.iter().zip(after.iter()) {
        assert_eq!(b.0, a.0, "path drift: before={:?} after={:?}", b.0, a.0);
        assert_eq!(b.1, a.1, "mtime drift on {:?}", b.0);
    }
}
