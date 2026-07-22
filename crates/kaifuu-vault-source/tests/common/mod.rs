//! Shared test fixture builder.
//! Builds a fresh synthetic vault under a `tempfile::TempDir` per test
//! invocation:
//! ```text
//! <tmp>/vault/
//! catalog.db (materialised from tests/fixtures/synthetic-vault/seed.sql)
//! artifacts/by-id/<canonical_id>/<canonical_id>.7z (built in-test via sevenz-rust2)
//! artifacts/by-name/.../... (intentional decoy that tests verify we never read)
//! Each fixture archive is constructed with sevenz-rust2 directly from
//! synthetic in-memory bytes and wrapped under a top-level `<canonical_id>/`
//! directory — mirroring the real by-id repack layout, where the game tree
//! and `_vault/metadata.json` live under that wrapper. The embedded
//! `_vault/metadata.json` is the by-id *canonical* shape (top-level
//! `canonical_id`, `identifiers`, `engine`, `work`, `languages`, and the
//! remaining fields required by the sidecar schema).

// reason: shared vault integration-test helpers; not every test module uses every helper.
#![allow(dead_code)]

use std::io::Cursor;
use std::path::{Path, PathBuf};

#[path = "environment.rs"]
mod environment;
// reason: each integration-test binary includes this module but may use only one helper.
#[allow(unused_imports)]
pub use environment::{isolate_ambient_vault_env, test_manifest_dir};

use rusqlite::Connection;
use sevenz_rust2::{ArchiveEntry, ArchiveWriter};
use sha2::{Digest, Sha256};
use tempfile::TempDir;

/// Names of the fixtures, used by tests to reference them.
pub const FIXTURE_GOOD_PRIMARY: &str = "good_primary";
pub const FIXTURE_SUBPATH: &str = "subpath_winmac";
pub const FIXTURE_GOOD_PATCH: &str = "good_patch";
pub const FIXTURE_EMBEDDED_MISMATCH: &str = "embedded_id_mismatch";
pub const FIXTURE_PATH_TRAVERSAL: &str = "path_traversal";
pub const FIXTURE_MISSING_METADATA: &str = "missing_metadata";

/// Canonical (by-id) ids for each fixture. These are the by-id store keys and
/// the `<canonical_id>/` wrapper directory names.
pub const CID_GOOD_PRIMARY: &str = "hello-galaxy.v1234.primary";
pub const CID_SUBPATH: &str = "hello-galaxy.v1234.subpath";
pub const CID_GOOD_PATCH: &str = "hello-galaxy.v1234.patch";
pub const CID_EMBEDDED_MISMATCH: &str = "embedded-disjoint.v4000.primary";
pub const CID_PATH_TRAVERSAL: &str = "path-traversal.v5000.primary";
pub const CID_MISSING_METADATA: &str = "missing-metadata.v6000.primary";

pub struct SyntheticVault {
    pub tmp: TempDir,
    /// Vault root: `<tmp>/vault/`.
    pub vault_root: PathBuf,
    /// Scratch root: `<tmp>/scratch/`.
    pub scratch_root: PathBuf,
    /// Map fixture-id → metadata.
    pub fixtures: std::collections::BTreeMap<&'static str, FixtureMeta>,
}

#[derive(Debug, Clone)]
pub struct FixtureMeta {
    pub canonical_id: String,
    pub canonical_sha256: String,
    pub size_bytes: u64,
    /// On-disk under `<vault_root>/artifacts/by-id/<cid>/<cid>.7z`.
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
        std::fs::create_dir_all(vault_root.join("artifacts/by-id")).unwrap();
        // Decoy: by-name/ tree. Tests assert we never read from this subtree.
        std::fs::create_dir_all(vault_root.join("artifacts/by-name/decoy")).unwrap();
        std::fs::write(
            vault_root.join("artifacts/by-name/decoy/wrong.7z"),
            b"not a real artifact",
        )
        .unwrap();

        // Materialise catalog.db from seed.sql.
        let seed_path = test_manifest_dir().join("tests/fixtures/synthetic-vault/seed.sql");
        let seed_sql = std::fs::read_to_string(&seed_path).unwrap();
        let catalog_path = vault_root.join("catalog.db");
        let conn = Connection::open(&catalog_path).unwrap();
        conn.execute_batch(&seed_sql).unwrap();

        let mut fixtures = std::collections::BTreeMap::new();

        fixtures.insert(
            FIXTURE_GOOD_PRIMARY,
            place_by_id(&vault_root, CID_GOOD_PRIMARY, &build_good_primary_archive()),
        );
        fixtures.insert(
            FIXTURE_SUBPATH,
            place_by_id(&vault_root, CID_SUBPATH, &build_subpath_archive()),
        );
        fixtures.insert(
            FIXTURE_GOOD_PATCH,
            place_by_id(&vault_root, CID_GOOD_PATCH, &build_good_patch_archive()),
        );
        fixtures.insert(
            FIXTURE_EMBEDDED_MISMATCH,
            place_by_id(
                &vault_root,
                CID_EMBEDDED_MISMATCH,
                &build_embedded_id_mismatch_archive(),
            ),
        );
        fixtures.insert(
            FIXTURE_PATH_TRAVERSAL,
            place_by_id(
                &vault_root,
                CID_PATH_TRAVERSAL,
                &build_path_traversal_archive(),
            ),
        );
        fixtures.insert(
            FIXTURE_MISSING_METADATA,
            place_by_id(
                &vault_root,
                CID_MISSING_METADATA,
                &build_missing_metadata_archive(),
            ),
        );

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

/// Compute `<vault-root>/artifacts/by-id/<cid>/<cid>.7z`.
pub fn by_id_path(vault_root: &Path, canonical_id: &str) -> PathBuf {
    vault_root
        .join("artifacts")
        .join("by-id")
        .join(canonical_id)
        .join(format!("{canonical_id}.7z"))
}

fn place_by_id(vault_root: &Path, canonical_id: &str, bytes: &[u8]) -> FixtureMeta {
    let path = by_id_path(vault_root, canonical_id);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, bytes).unwrap();
    FixtureMeta {
        canonical_id: canonical_id.to_string(),
        canonical_sha256: sha256_hex(bytes),
        size_bytes: bytes.len() as u64,
        on_disk: path,
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let digest = Sha256::digest(bytes);
    let mut s = String::with_capacity(64);
    for b in &digest {
        let _ = write!(s, "{b:02x}");
    }
    s
}

// Embedded by-id metadata (canonical shape)

fn synthetic_metadata(
    canonical_id: &str,
    canonical_title: &str,
    identifiers: &[(&str, &str, &str)],
) -> Vec<u8> {
    let identifiers: Vec<_> = identifiers
        .iter()
        .map(|(source, kind, value)| {
            serde_json::json!({
                "source": source,
                "kind": kind,
                "value": value,
            })
        })
        .collect();

    serde_json::to_vec_pretty(&serde_json::json!({
        "canonical_id": canonical_id,
        "identifiers": identifiers,
        "engine": "kirikiri",
        "engine_evidence": {
            "evidence": "direct_observation",
            "observed_at": "2026-01-01 00:00:00",
            "source": "synthetic_fixture",
            "value": "kirikiri"
        },
        "engine_source": "synthetic_fixture",
        "work": {
            "age_rating": "all",
            "canonical_title": canonical_title,
            "original_title": null,
            "series_id": null,
            "series_name": null,
            "work_kind": "vn"
        },
        "release": {
            "drm_model": null,
            "edition_name": null,
            "edition_year": null,
            "is_portable": null,
            "release_date": null,
            "store": null
        },
        "languages": [{
            "evidence_path": null,
            "is_mtl": false,
            "kind": "full",
            "language_code": "ja",
            "source": "synthetic_fixture"
        }],
        "install_manifest": null,
        "containers_json": [{
            "classified": "archive",
            "exit": 0,
            "magic": "sevenz",
            "note": "",
            "produced": ["synthetic-game/start.exe"],
            "stderr": "",
            "tool": "synthetic-7zz"
        }],
        "runnable_from_tree": 1,
        "original_filename": "synthetic-source.7z",
        "original_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "size_bytes": 1,
        "source_fetches": [{
            "fetched_at": "2026-01-01 00:00:00",
            "http_status": 200,
            "ok": true,
            "request_hash": "synthetic-request",
            "source": "synthetic_fixture"
        }],
        "state": "vaulted",
        "version": "v1.0",
        "version_norm": [1, 0]
    }))
    .unwrap()
}

fn embedded_metadata_good() -> Vec<u8> {
    synthetic_metadata(
        CID_GOOD_PRIMARY,
        "Hello Galaxy",
        &[("vndb", "v", "v1234"), ("dlsite", "rj", "RJ123456")],
    )
}

fn embedded_metadata_subpath() -> Vec<u8> {
    synthetic_metadata(CID_SUBPATH, "Hello Galaxy", &[("vndb", "v", "v1234")])
}

fn embedded_metadata_patch() -> Vec<u8> {
    synthetic_metadata(CID_GOOD_PATCH, "Hello Galaxy", &[("vndb", "v", "v1234")])
}

fn embedded_metadata_disjoint_ids() -> Vec<u8> {
    // canonical_id MATCHES the catalog (identity gate 1 passes), but the work
    // identifiers are disjoint from the catalog (identity gate 2 fails).
    synthetic_metadata(
        CID_EMBEDDED_MISMATCH,
        "Mistaken Identity",
        &[("vndb", "v", "v9999"), ("dlsite", "rj", "RJ999999")],
    )
}

// Archive builders — every archive wraps under `<canonical_id>/`.

fn build_archive(entries: &[(String, &[u8])]) -> Vec<u8> {
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

fn wrapped(cid: &str, rel: &str) -> String {
    format!("{cid}/{rel}")
}

fn build_good_primary_archive() -> Vec<u8> {
    let meta = embedded_metadata_good();
    let cid = CID_GOOD_PRIMARY;
    build_archive(&[
        (wrapped(cid, "_vault/metadata.json"), &meta),
        (wrapped(cid, "game/start.exe"), b"FAKEEXE"),
        (wrapped(cid, "game/data.xp3"), b"FAKEXP3"),
    ])
}

fn build_subpath_archive() -> Vec<u8> {
    let meta = embedded_metadata_subpath();
    let cid = CID_SUBPATH;
    build_archive(&[
        (wrapped(cid, "_vault/metadata.json"), &meta),
        (wrapped(cid, "Win/game.exe"), b"WINEXE"),
        (wrapped(cid, "Win/data.xp3"), b"WINXP3"),
        (wrapped(cid, "Mac/game.app"), b"MACAPP"),
    ])
}

fn build_good_patch_archive() -> Vec<u8> {
    let meta = embedded_metadata_patch();
    let cid = CID_GOOD_PATCH;
    build_archive(&[
        (wrapped(cid, "_vault/metadata.json"), &meta),
        (wrapped(cid, "patch/patch.xp3"), b"PATCH"),
    ])
}

fn build_embedded_id_mismatch_archive() -> Vec<u8> {
    let meta = embedded_metadata_disjoint_ids();
    let cid = CID_EMBEDDED_MISMATCH;
    build_archive(&[
        (wrapped(cid, "_vault/metadata.json"), &meta),
        (wrapped(cid, "game/start.exe"), b"FAKEEXE"),
    ])
}

fn build_path_traversal_archive() -> Vec<u8> {
    let meta = embedded_metadata_good();
    let cid = CID_PATH_TRAVERSAL;
    // A parent-dir segment that escapes the extraction root. The validator
    // must reject it before any byte is written.
    build_archive(&[
        (wrapped(cid, "_vault/metadata.json"), &meta),
        ("../escape.txt".to_string(), b"GOTCHA"),
    ])
}

fn build_missing_metadata_archive() -> Vec<u8> {
    // No _vault/metadata.json at all (under the wrapper).
    let cid = CID_MISSING_METADATA;
    build_archive(&[(wrapped(cid, "game/start.exe"), b"FAKEEXE")])
}

fn insert_artifacts_and_links(
    conn: &Connection,
    fixtures: &std::collections::BTreeMap<&'static str, FixtureMeta>,
) {
    // (artifact_id, fixture_name, kind, links: Vec<(release_id, role, subpath)>)
    type Plan<'a> = Vec<(i64, &'a str, &'a str, Vec<(i64, &'a str, Option<&'a str>)>)>;
    let plan: Plan<'_> = vec![
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
        (102, FIXTURE_GOOD_PATCH, "patch", vec![(10, "patch", None)]),
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

    // The synthetic releases 13..=15 need work / release rows.
    conn.execute_batch(
        "INSERT INTO works (id, canonical_title, work_kind) VALUES
            (4, 'Embedded Disjoint World', 'vn'),
            (5, 'Path Traversal World', 'vn'),
            (6, 'Missing Metadata World', 'vn');
         INSERT INTO identifiers (work_id, source, kind, value) VALUES
            (4, 'vndb', 'v', 'v4000'),
            (5, 'vndb', 'v', 'v5000'),
            (6, 'vndb', 'v', 'v6000');
         INSERT INTO releases (id, work_id, edition_name, store, drm_model) VALUES
            (13, 4, 'Standard', 'dlsite', 'drm-free'),
            (14, 5, 'Standard', 'dlsite', 'drm-free'),
            (15, 6, 'Standard', 'dlsite', 'drm-free');
         INSERT INTO release_languages (release_id, language_code) VALUES
            (13, 'ja'), (14, 'ja'), (15, 'ja');
         INSERT INTO release_platforms (release_id, platform) VALUES
            (13, 'windows'), (14, 'windows'), (15, 'windows');",
    )
    .unwrap();

    for (artifact_id, fixture_name, kind, links) in plan {
        let meta = &fixtures[fixture_name];
        let vault_path = format!("artifacts/by-id/{cid}/{cid}.7z", cid = meta.canonical_id);
        conn.execute(
            "INSERT INTO artifacts \
                 (id, canonical_id, canonical_sha256, size_bytes, artifact_kind, vault_path, state) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'vaulted')",
            rusqlite::params![
                artifact_id,
                meta.canonical_id,
                meta.canonical_sha256,
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
