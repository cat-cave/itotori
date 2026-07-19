//! KAIFUU-205 plain-XP3 real-bytes round-trip smoke.
//!
//! Proves `repack(read(fixture)) == fixture` BYTE-FOR-BYTE for the
//! metadata-only `kaifuu-xp3-plain-profile-a` fixture (KAIFUU-204) when the
//! separately licensed source archive is staged via the
//! `KAIFUU_XP3_PROFILE_A_ARCHIVE` environment variable. The committed
//! fixture itself records metadata only — no copyrighted archive bytes are
//! redistributed — so the heavy case is SKIPPED (not panicked) when the env
//! var is absent. The orchestrator runs the real-corpus validation with the
//! env var populated.
//!
//! The fixture is referenced by path (under `fixtures/public/`); no node-id
//! token is consulted. Per-entry adler32 recomputed from the rebuilt payload
//! is checked against the value stored in the source archive's `adlr`
//! chunks. The byte-exact repack path lives in
//! [`kaifuu_core::xp3_real_bytes_roundtrip`]: it preserves BOTH raw and
//! zlib source index encodings verbatim, so the round-trip is faithful for
//! the licensed English KiriKiri archive shape (zlib index) as well as the
//! synthetic raw-index fixtures.

use std::fs;
use std::path::PathBuf;

use kaifuu_core::{
    REAL_BYTES_XP3_VARIANT, XP3_INDEX_ENCODING_RAW, XP3_INDEX_ENCODING_ZLIB,
    read_real_bytes_xp3_archive, real_bytes_xp3_adler_proof, repack_real_bytes_xp3_archive,
};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Env var that names the separately licensed source archive on disk. The
/// committed fixture is metadata-only; this variable is the ONLY way the
/// real archive bytes enter the test process.
const SOURCE_ARCHIVE_ENV: &str = "KAIFUU_XP3_PROFILE_A_ARCHIVE";

/// The fixture referenced BY PATH (no node-id token): a metadata-only
/// manifest under `fixtures/public/`. The path is anchored at the
/// `kaifuu-core` crate so the lookup is stable from both `cargo test` and
/// out-of-tree invocations.
const FIXTURE_RELATIVE_PATH: &str = "fixtures/public/kaifuu-xp3-plain-profile-a.manifest.json";

/// The fixture id recorded inside the manifest. Used to fail loudly if the
/// fixture at [`FIXTURE_RELATIVE_PATH`] is somehow swapped for an unrelated
/// one — keeps the real-bytes proof honest.
const EXPECTED_FIXTURE_ID: &str = "kaifuu-xp3-plain-profile-a";

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn fixture_path() -> PathBuf {
    crate_dir().join("../../").join(FIXTURE_RELATIVE_PATH)
}

fn fixture_manifest() -> Value {
    let path = fixture_path();
    let bytes = fs::read(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    serde_json::from_slice(&bytes)
        .unwrap_or_else(|error| panic!("parse {} as JSON: {error}", path.display()))
}

/// Resolve the source archive path. Falls back to `None` (SKIP) when the env
/// var is unset OR points at a missing file. A present-but-unreadable file
/// is a hard error (the operator explicitly named a path that cannot be
/// honoured).
fn source_archive_path() -> Option<PathBuf> {
    let raw = std::env::var_os(SOURCE_ARCHIVE_ENV)?;
    let path = PathBuf::from(raw);
    if !path.exists() {
        eprintln!(
            "SKIP: {SOURCE_ARCHIVE_ENV}={} does not exist; real-bytes round-trip is skipped",
            path.display()
        );
        return None;
    }
    Some(path)
}

#[test]
fn fixture_metadata_records_profile_a_id_and_zlib_index_encoding() {
    // Always-on guard: the committed fixture referenced BY PATH is the
    // metadata-only profile-A manifest. This catches a stale swap (e.g. the
    // fixture path being silently repointed at an unrelated manifest)
    // before the real-corpus case is even attempted.
    let manifest = fixture_manifest();
    assert_eq!(
        manifest["fixture"]["id"].as_str(),
        Some(EXPECTED_FIXTURE_ID),
        "fixture at {FIXTURE_RELATIVE_PATH} must be the profile-A manifest"
    );
    assert_eq!(
        manifest["archive"]["indexEncoding"].as_str(),
        Some("zlib"),
        "profile-A fixture declares a zlib-compressed index encoding"
    );
    assert_eq!(
        manifest["archive"]["inventoryReader"].as_str(),
        Some("read_plain_xp3_inventory"),
        "the manifest records the KAIFUU-204 reader as its inventory source"
    );
}

#[test]
fn repack_of_profile_a_source_archive_is_byte_for_byte_identical() {
    let Some(source_path) = source_archive_path() else {
        return;
    };

    let manifest = fixture_manifest();
    let expected_sha = manifest["archive"]["sha256"]
        .as_str()
        .expect("profile-A manifest records the source archive sha256");
    let expected_bytes = manifest["archive"]["bytes"]
        .as_u64()
        .expect("profile-A manifest records the source archive byte count");
    let expected_entries = manifest["archive"]["inventoryEntryCount"]
        .as_u64()
        .expect("profile-A manifest records the inventory entry count");

    let source = fs::read(&source_path)
        .unwrap_or_else(|error| panic!("read {}: {error}", source_path.display()));
    assert_eq!(
        source.len() as u64,
        expected_bytes,
        "source archive byte count must match the recorded fixture metadata"
    );
    let observed_sha = format!("{:x}", Sha256::digest(&source));
    assert_eq!(
        observed_sha, expected_sha,
        "source archive sha256 must match the recorded fixture metadata"
    );

    let archive = read_real_bytes_xp3_archive(&source).unwrap_or_else(|error| {
        panic!(
            "read_real_bytes_xp3_archive failed on {}: {error}",
            source_path.display()
        )
    });
    assert_eq!(
        archive.variant, REAL_BYTES_XP3_VARIANT,
        "archive variant is plain"
    );
    assert_eq!(
        archive.index_encoding, XP3_INDEX_ENCODING_ZLIB,
        "profile-A source carries a zlib-compressed index (encoding byte 1)"
    );
    assert!(
        archive.index_encoding == XP3_INDEX_ENCODING_RAW
            || archive.index_encoding == XP3_INDEX_ENCODING_ZLIB,
        "only raw (0) and zlib (1) index encodings are supported"
    );
    assert_eq!(
        archive.entries.len() as u64,
        expected_entries,
        "real-bytes reader must surface every recorded inventory entry"
    );

    let rebuilt = repack_real_bytes_xp3_archive(&archive)
        .unwrap_or_else(|error| panic!("repack_real_bytes_xp3_archive failed: {error}"));
    assert_eq!(
        rebuilt.len(),
        source.len(),
        "rebuilt archive byte count must equal the source"
    );
    assert_eq!(
        Sha256::digest(&rebuilt),
        Sha256::digest(&source),
        "rebuilt archive sha256 must equal the source (byte-for-byte round-trip)"
    );
    assert_eq!(
        rebuilt, source,
        "repack(read(fixture)) == fixture BYTE-FOR-BYTE for the KAIFUU-204 profile-A archive"
    );

    // Per-entry adler32: the recomputed value over the rebuilt payload
    // equals the value the source stored in each File chunk's adlr.
    let proofs = real_bytes_xp3_adler_proof(&archive).expect("adler proof over rebuilt archive");
    assert_eq!(
        proofs.len(),
        archive.entries.len(),
        "every entry has a recomputed-vs-stored adler32 proof"
    );
    for (path, proof) in &proofs {
        assert!(
            proof.stored.is_some(),
            "entry {path}: source archive must carry an adlr chunk"
        );
        let stored = proof
            .stored
            .expect("adler32 stored value is present for every entry");
        assert_eq!(
            proof.recomputed, stored,
            "entry {path}: recomputed adler32 must equal the source-stored value"
        );
    }
}

#[test]
fn repack_round_trip_is_idempotent_for_profile_a_source() {
    // Repacking twice yields the same bytes — the rebuild is deterministic,
    // not a one-shot fluke. The existing raw-index writer already proved
    // this on synthetic fixtures; this case extends the proof to the real
    // zlib-indexed licensed archive.
    let Some(source_path) = source_archive_path() else {
        return;
    };
    let source = fs::read(&source_path)
        .unwrap_or_else(|error| panic!("read {}: {error}", source_path.display()));
    let archive =
        read_real_bytes_xp3_archive(&source).unwrap_or_else(|error| panic!("read failed: {error}"));
    let first = repack_real_bytes_xp3_archive(&archive).expect("first repack");
    let second = repack_real_bytes_xp3_archive(&archive).expect("second repack");
    assert_eq!(first, source, "first repack equals source");
    assert_eq!(second, source, "second repack equals source");
    assert_eq!(first, second, "repack is deterministic across invocations");
}
