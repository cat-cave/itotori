//! Shared test fixture builder.
//!
//! Builds a fresh synthetic vault under a `tempfile::TempDir` per test
//! invocation:
//!
//! ```text
//! <tmp>/vault/
//!   catalog.db                  (materialised from tests/fixtures/synthetic-vault/seed.sql)
//!   embedded-metadata.schema.json (copy of the contract's schema)
//!   artifacts/by-sha/<aa>/<bb>/<hash>.7z   (built in-test via sevenz-rust2)
//!   artifacts/by-name/.../...   (intentional decoy that tests verify we never read)
//! ```
//!
//! The seven fixture archives are constructed with sevenz-rust2 directly
//! from synthetic in-memory bytes; their real sha256 is computed; the
//! `catalog.db` rows for `artifacts` + `release_artifacts` are then
//! inserted with the correct hash values so the synthetic catalog and the
//! synthetic archives are always in sync.

#![allow(dead_code)]

use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use sevenz_rust2::{ArchiveEntry, ArchiveWriter};
use sha2::{Digest, Sha256};
use tempfile::TempDir;

/// Names of the seven fixtures, used by tests to reference them.
pub const FIXTURE_GOOD_PRIMARY: &str = "good_primary";
pub const FIXTURE_SUBPATH: &str = "subpath_winmac";
pub const FIXTURE_GOOD_PATCH: &str = "good_patch";
pub const FIXTURE_HASH_MISMATCH: &str = "hash_mismatch";
pub const FIXTURE_EMBEDDED_MISMATCH: &str = "embedded_id_mismatch";
pub const FIXTURE_PATH_TRAVERSAL: &str = "path_traversal";
pub const FIXTURE_MISSING_METADATA: &str = "missing_metadata";

pub struct SyntheticVault {
    pub tmp: TempDir,
    /// Vault root: `<tmp>/vault/`.
    pub vault_root: PathBuf,
    /// Scratch root: `<tmp>/scratch/`.
    pub scratch_root: PathBuf,
    /// Map fixture-id → (sha256, on-disk path).
    pub fixtures: std::collections::BTreeMap<&'static str, FixtureMeta>,
}

#[derive(Debug, Clone)]
pub struct FixtureMeta {
    pub sha256: String,
    pub size_bytes: u64,
    /// On-disk under `<vault_root>/artifacts/by-sha/...`.
    pub on_disk: PathBuf,
}

impl SyntheticVault {
    /// Build a fresh vault.
    pub fn build() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let vault_root = tmp.path().join("vault");
        let scratch_root = tmp.path().join("scratch");
        std::fs::create_dir_all(&vault_root).unwrap();
        std::fs::create_dir_all(&scratch_root).unwrap();
        std::fs::create_dir_all(vault_root.join("artifacts/by-sha")).unwrap();
        // Decoy: by-name/ tree with a wrong-hashed copy. Tests assert
        // we never read from this subtree.
        std::fs::create_dir_all(vault_root.join("artifacts/by-name/decoy")).unwrap();
        std::fs::write(
            vault_root.join("artifacts/by-name/decoy/wrong.7z"),
            b"not a real artifact",
        )
        .unwrap();

        // Copy embedded schema next to catalog.db.
        let schema_src = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/synthetic-vault/embedded-metadata.schema.json");
        std::fs::copy(
            &schema_src,
            vault_root.join("embedded-metadata.schema.json"),
        )
        .unwrap();

        // Materialise catalog.db from seed.sql.
        let seed_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/synthetic-vault/seed.sql");
        let seed_sql = std::fs::read_to_string(&seed_path).unwrap();
        let catalog_path = vault_root.join("catalog.db");
        let conn = Connection::open(&catalog_path).unwrap();
        conn.execute_batch(&seed_sql).unwrap();

        // Now build the seven synthetic archives.
        let mut fixtures = std::collections::BTreeMap::new();

        let good_primary_bytes = build_good_primary_archive();
        fixtures.insert(
            FIXTURE_GOOD_PRIMARY,
            place_artifact(&vault_root, &good_primary_bytes),
        );

        let subpath_bytes = build_subpath_archive();
        fixtures.insert(FIXTURE_SUBPATH, place_artifact(&vault_root, &subpath_bytes));

        let good_patch_bytes = build_good_patch_archive();
        fixtures.insert(
            FIXTURE_GOOD_PATCH,
            place_artifact(&vault_root, &good_patch_bytes),
        );

        // Hash-mismatch: archive bytes are valid 7z (with a marker byte
        // that distinguishes them from GOOD_PRIMARY so we don't collide on
        // the by-sha path), but we will record a *wrong* sha256 in the
        // catalog.
        let hash_mismatch_bytes = build_hash_mismatch_archive();
        let mut hash_mismatch_meta = place_artifact(&vault_root, &hash_mismatch_bytes);
        // The recorded catalog sha is intentionally wrong; the bytes
        // hash to `real_sha` so the resolver reports mismatch. We move
        // the file to the wrong-sha path so the resolver finds it first
        // (otherwise it would fail with ArtifactMissing).
        let real_sha = hash_mismatch_meta.sha256.clone();
        let wrong_sha = wrong_sha_from(&real_sha);
        let new_path = by_sha_path(&vault_root, &wrong_sha);
        std::fs::create_dir_all(new_path.parent().unwrap()).unwrap();
        std::fs::rename(&hash_mismatch_meta.on_disk, &new_path).unwrap();
        hash_mismatch_meta.on_disk = new_path;
        hash_mismatch_meta.sha256 = wrong_sha.clone();
        hash_mismatch_meta.size_bytes = hash_mismatch_bytes.len() as u64;
        fixtures.insert(FIXTURE_HASH_MISMATCH, hash_mismatch_meta);

        // Embedded-id-mismatch: archive bytes embed an id that disjoints
        // the catalog's identifiers list. Place at the by-sha addressed
        // by its own (real) sha.
        let embedded_mismatch_bytes = build_embedded_id_mismatch_archive();
        fixtures.insert(
            FIXTURE_EMBEDDED_MISMATCH,
            place_artifact(&vault_root, &embedded_mismatch_bytes),
        );

        // Path-traversal: archive containing `../escape.txt`.
        let path_traversal_bytes = build_path_traversal_archive();
        fixtures.insert(
            FIXTURE_PATH_TRAVERSAL,
            place_artifact(&vault_root, &path_traversal_bytes),
        );

        // Missing-metadata: archive without _vault/metadata.json.
        let missing_meta_bytes = build_missing_metadata_archive();
        fixtures.insert(
            FIXTURE_MISSING_METADATA,
            place_artifact(&vault_root, &missing_meta_bytes),
        );

        // Insert artifact + release_artifacts rows now that sha256 + size
        // are known.
        insert_artifacts_and_links(&conn, &fixtures);
        drop(conn);

        Self {
            tmp,
            vault_root,
            scratch_root,
            fixtures,
        }
    }
}

/// Compute `<vault-root>/artifacts/by-sha/<aa>/<bb>/<hash>.7z`.
pub fn by_sha_path(vault_root: &Path, sha: &str) -> PathBuf {
    vault_root
        .join("artifacts")
        .join("by-sha")
        .join(&sha[0..2])
        .join(&sha[2..4])
        .join(format!("{sha}.7z"))
}

fn place_artifact(vault_root: &Path, bytes: &[u8]) -> FixtureMeta {
    let sha = sha256_hex(bytes);
    let path = by_sha_path(vault_root, &sha);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, bytes).unwrap();
    FixtureMeta {
        sha256: sha,
        size_bytes: bytes.len() as u64,
        on_disk: path,
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut s = String::with_capacity(64);
    for b in digest.iter() {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn wrong_sha_from(real: &str) -> String {
    // Flip the last hex char. Keeps it a valid 64-hex sha-shaped string.
    let mut chars: Vec<char> = real.chars().collect();
    let last = chars.last().copied().unwrap();
    chars.pop();
    chars.push(if last == 'f' { '0' } else { 'f' });
    chars.into_iter().collect()
}

// ====================================================================
// Archive builders
// ====================================================================

fn embedded_metadata_good() -> Vec<u8> {
    serde_json::to_vec_pretty(&serde_json::json!({
        "schema_version": "1.0",
        "embedded_by": "synthetic-fixture",
        "embedded_at": "2024-01-15T00:00:00Z",
        "vault_artifact": {
            "artifact_kind": "portable_tree_packed",
            "observed_at": "2024-01-15T00:00:00Z",
            "original_sha256": null
        },
        "releases": [
            {
                "languages": ["ja"],
                "platforms": ["windows"],
                "role": "primary",
                "work": {
                    "canonical_title": "Hello Galaxy",
                    "work_kind": "vn",
                    "identifiers": [
                        { "source": "vndb", "kind": "v", "value": "v1234" },
                        { "source": "dlsite", "kind": "rj", "value": "RJ123456" }
                    ]
                }
            }
        ]
    }))
    .unwrap()
}

fn embedded_metadata_subpath_winmac() -> Vec<u8> {
    serde_json::to_vec_pretty(&serde_json::json!({
        "schema_version": "1.0",
        "embedded_by": "synthetic-fixture",
        "embedded_at": "2024-02-20T00:00:00Z",
        "vault_artifact": {
            "artifact_kind": "dlsite_zip",
            "observed_at": "2024-02-20T00:00:00Z"
        },
        "releases": [
            {
                "languages": ["ja"],
                "platforms": ["windows", "macos"],
                "role": "primary",
                "subpath": "Win",
                "work": {
                    "canonical_title": "Hello Galaxy",
                    "work_kind": "vn",
                    "identifiers": [
                        { "source": "vndb", "kind": "v", "value": "v1234" }
                    ]
                }
            }
        ]
    }))
    .unwrap()
}

fn embedded_metadata_patch() -> Vec<u8> {
    serde_json::to_vec_pretty(&serde_json::json!({
        "schema_version": "1.0",
        "embedded_by": "synthetic-fixture",
        "embedded_at": "2024-01-15T00:00:00Z",
        "vault_artifact": {
            "artifact_kind": "patch",
            "observed_at": "2024-01-15T00:00:00Z"
        },
        "releases": [
            {
                "languages": ["ja"],
                "platforms": ["windows"],
                "role": "patch",
                "work": {
                    "canonical_title": "Hello Galaxy",
                    "work_kind": "vn",
                    "identifiers": [
                        { "source": "vndb", "kind": "v", "value": "v1234" }
                    ]
                }
            }
        ]
    }))
    .unwrap()
}

fn embedded_metadata_disjoint_ids() -> Vec<u8> {
    serde_json::to_vec_pretty(&serde_json::json!({
        "schema_version": "1.0",
        "embedded_by": "synthetic-fixture",
        "embedded_at": "2024-01-15T00:00:00Z",
        "vault_artifact": {
            "artifact_kind": "portable_tree_packed",
            "observed_at": "2024-01-15T00:00:00Z"
        },
        "releases": [
            {
                "languages": ["ja"],
                "platforms": ["windows"],
                "role": "primary",
                "work": {
                    "canonical_title": "Mistaken Identity",
                    "work_kind": "vn",
                    "identifiers": [
                        { "source": "vndb", "kind": "v", "value": "v9999" },
                        { "source": "dlsite", "kind": "rj", "value": "RJ999999" }
                    ]
                }
            }
        ]
    }))
    .unwrap()
}

fn build_archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let buf = Cursor::new(Vec::<u8>::new());
    let mut writer = ArchiveWriter::new(buf).unwrap();
    for (name, data) in entries {
        let entry = ArchiveEntry::new_file(name);
        writer
            .push_archive_entry::<&[u8]>(entry, Some(*data))
            .unwrap();
    }
    let cursor = writer.finish().unwrap();
    cursor.into_inner()
}

fn build_good_primary_archive() -> Vec<u8> {
    let meta = embedded_metadata_good();
    build_archive(&[
        ("_vault/metadata.json", &meta),
        ("game/start.exe", b"FAKEEXE"),
        ("game/data.xp3", b"FAKEXP3"),
    ])
}

fn build_subpath_archive() -> Vec<u8> {
    let meta = embedded_metadata_subpath_winmac();
    build_archive(&[
        ("_vault/metadata.json", &meta),
        ("Win/game.exe", b"WINEXE"),
        ("Win/data.xp3", b"WINXP3"),
        ("Mac/game.app", b"MACAPP"),
    ])
}

fn build_good_patch_archive() -> Vec<u8> {
    let meta = embedded_metadata_patch();
    build_archive(&[
        ("_vault/metadata.json", &meta),
        ("patch/patch.xp3", b"PATCH"),
    ])
}

fn build_hash_mismatch_archive() -> Vec<u8> {
    let meta = embedded_metadata_good();
    build_archive(&[
        ("_vault/metadata.json", &meta),
        ("game/start.exe", b"FAKEEXE"),
        ("game/marker.txt", b"HASH-MISMATCH-MARKER"),
    ])
}

fn build_embedded_id_mismatch_archive() -> Vec<u8> {
    let meta = embedded_metadata_disjoint_ids();
    build_archive(&[
        ("_vault/metadata.json", &meta),
        ("game/start.exe", b"FAKEEXE"),
    ])
}

fn build_path_traversal_archive() -> Vec<u8> {
    let meta = embedded_metadata_good();
    // Notice the parent-dir segment. The validator should reject.
    build_archive(&[
        ("_vault/metadata.json", &meta),
        ("../escape.txt", b"GOTCHA"),
    ])
}

fn build_missing_metadata_archive() -> Vec<u8> {
    // No _vault/metadata.json at all.
    build_archive(&[("game/start.exe", b"FAKEEXE")])
}

fn insert_artifacts_and_links(
    conn: &Connection,
    fixtures: &std::collections::BTreeMap<&'static str, FixtureMeta>,
) {
    // Map each fixture to a synthetic catalog tuple:
    //   (id, sha256, size, kind, release_links: Vec<(release_id, role, subpath)>)
    let plan: Vec<(i64, &str, &str, Vec<(i64, &str, Option<&str>)>)> = vec![
        (
            100,
            FIXTURE_GOOD_PRIMARY,
            "portable_tree_packed",
            vec![(10, "primary", None)],
        ),
        (
            101,
            FIXTURE_SUBPATH,
            "dlsite_zip",
            vec![(11, "primary", Some("Win"))],
        ),
        (
            102,
            FIXTURE_GOOD_PATCH,
            "patch",
            vec![(10, "patch", None)],
        ),
        (
            103,
            FIXTURE_HASH_MISMATCH,
            "portable_tree_packed",
            // We bind it to a synthetic release 12 to keep its existence
            // independent from the good-fixtures.
            vec![(12, "primary", None)],
        ),
        (
            104,
            FIXTURE_EMBEDDED_MISMATCH,
            "portable_tree_packed",
            vec![(13, "primary", None)],
        ),
        (
            105,
            FIXTURE_PATH_TRAVERSAL,
            "portable_tree_packed",
            vec![(14, "primary", None)],
        ),
        (
            106,
            FIXTURE_MISSING_METADATA,
            "portable_tree_packed",
            vec![(15, "primary", None)],
        ),
    ];

    // The synthetic releases 12..=15 need work / release rows.
    conn.execute_batch(
        "INSERT INTO works (id, canonical_title, work_kind) VALUES
            (3, 'Hash Mismatch World', 'vn'),
            (4, 'Embedded Disjoint World', 'vn'),
            (5, 'Path Traversal World', 'vn'),
            (6, 'Missing Metadata World', 'vn');
         INSERT INTO identifiers (work_id, source, kind, value) VALUES
            (3, 'vndb', 'v', 'v3000'),
            (4, 'vndb', 'v', 'v4000'),
            (5, 'vndb', 'v', 'v5000'),
            (6, 'vndb', 'v', 'v6000');
         INSERT INTO releases (id, work_id, edition_name, store, drm_model) VALUES
            (12, 3, 'Standard', 'dlsite', 'drm-free'),
            (13, 4, 'Standard', 'dlsite', 'drm-free'),
            (14, 5, 'Standard', 'dlsite', 'drm-free'),
            (15, 6, 'Standard', 'dlsite', 'drm-free');
         INSERT INTO release_languages (release_id, language_code) VALUES
            (12, 'ja'), (13, 'ja'), (14, 'ja'), (15, 'ja');
         INSERT INTO release_platforms (release_id, platform) VALUES
            (12, 'windows'), (13, 'windows'), (14, 'windows'), (15, 'windows');",
    )
    .unwrap();

    for (artifact_id, fixture_name, kind, links) in plan {
        let meta = &fixtures[fixture_name];
        let vault_path = format!(
            "artifacts/by-sha/{}/{}/{}.7z",
            &meta.sha256[0..2],
            &meta.sha256[2..4],
            &meta.sha256
        );
        conn.execute(
            "INSERT INTO artifacts (id, sha256, size_bytes, artifact_kind, vault_path)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                artifact_id,
                meta.sha256,
                meta.size_bytes as i64,
                kind,
                vault_path,
            ],
        )
        .unwrap();
        for (release_id, role, subpath) in links {
            conn.execute(
                "INSERT INTO release_artifacts (release_id, artifact_id, role, subpath)
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![release_id, artifact_id, role, subpath],
            )
            .unwrap();
        }
    }
}

/// Compute a recursive snapshot of (path, mtime) for every entry under
/// `root`. Used by tests that assert "no byte was written under
/// <vault-root>".
pub fn snapshot_tree(root: &Path) -> Vec<(PathBuf, std::time::SystemTime)> {
    let mut out = Vec::new();
    walk(root, &mut out);
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn walk(p: &Path, out: &mut Vec<(PathBuf, std::time::SystemTime)>) {
    let Ok(meta) = std::fs::symlink_metadata(p) else {
        return;
    };
    out.push((
        p.to_path_buf(),
        meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH),
    ));
    if meta.is_dir() {
        let Ok(entries) = std::fs::read_dir(p) else {
            return;
        };
        for e in entries.flatten() {
            walk(&e.path(), out);
        }
    }
}

// Quiet the unused-import warnings if any test file doesn't use a thing.
#[allow(unused)]
fn _silence_unused() {
    let _: &dyn Read = &Cursor::new(Vec::<u8>::new());
    let _: &dyn Write = &Cursor::new(Vec::<u8>::new());
}
